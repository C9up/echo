/**
 * CacheManager — a single cache store with a unified, bentocache/@adonisjs/cache
 * parity API over a pluggable {@link CacheDriver}.
 *
 * Every read/write method accepts EITHER the Adonis/bento object form
 * (`get({ key })`, `set({ key, value, ttl, tags })`, `getOrSet({ key, factory,
 * … })`) OR echo's original positional form (`get(key)`, `set(key, value,
 * ttlSeconds)`, `getOrSet(key, ttlSeconds, factory)`). The object form is the
 * canonical one; the positional form is kept for back-compat.
 */

import { type Duration, parseDuration, resolveTtlSeconds } from "./duration.js";
import { FactoryError, TimeoutError } from "./errors.js";
import type {
	CacheEmitter,
	CacheEntry,
	CacheEventMap,
	DeleteByTagOptions,
	DeleteManyOptions,
	DeleteOptions,
	ExpireOptions,
	Factory,
	GetOptions,
	GetOrSetForeverOptions,
	GetOrSetOptions,
	HasOptions,
	SetOptions,
	TaggableDriver,
} from "./types.js";

// Re-exported for back-compat (echo <=0.1.5 exported these from CacheManager).
export type { CacheDriver } from "./types.js";

import type { CacheDriver } from "./types.js";

function isTaggableDriver(driver: CacheDriver): driver is TaggableDriver {
	const candidate: Partial<TaggableDriver> = driver;
	return (
		typeof candidate.setWithTags === "function" &&
		(typeof candidate.deleteByTag === "function" ||
			typeof candidate.flushTags === "function")
	);
}

/** Resolve an optional {@link Duration} to milliseconds; `undefined` when unset. */
function resolveMs(duration: Duration | undefined): number | undefined {
	if (duration === undefined || duration === null) return undefined;
	const seconds =
		typeof duration === "number" ? duration : parseDuration(duration);
	return Math.max(0, seconds) * 1000;
}

const TIMEOUT: unique symbol = Symbol("echo.timeout");

function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
): Promise<T | typeof TIMEOUT> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => resolve(TIMEOUT), ms);
		if (typeof timer === "object" && "unref" in timer) {
			(timer as { unref(): void }).unref();
		}
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

export interface CacheConfig {
	driver?: string;
	prefix?: string;
	/** Default TTL in **seconds** (echo-native unit; see `duration.ts`). */
	ttl?: number;
	/** Default grace period (stale-while-revalidate) as a {@link Duration}. */
	grace?: Duration;
	/** Default soft timeout for `getOrSet` (return stale if the factory is slower). */
	timeout?: Duration;
	/** Default hard timeout for `getOrSet`. */
	hardTimeout?: Duration;
	/** Default single-flight lock wait before falling back to stale. */
	lockTimeout?: Duration;
	/** Store name reported in events (default `"default"`). */
	name?: string;
	/** Optional event emitter (`cache:hit` / `miss` / `written` / `deleted` / `cleared`). */
	emitter?: CacheEmitter;
}

/** Shared single-flight state — one map per store, threaded through namespaces. */
interface SharedState {
	inflight: Map<string, { promise: Promise<unknown> }>;
}

interface NormalizedGetOrSet<T> {
	key: string;
	factory: Factory<T>;
	ttlSeconds: number;
	graceSeconds: number;
	timeoutMs: number | undefined;
	hardTimeoutMs: number | undefined;
	lockTimeoutMs: number | undefined;
	tags: string[];
	onFactoryError?: (error: FactoryError) => void;
}

export class CacheManager {
	#driver: CacheDriver;
	#prefix: string;
	#defaultTtl: number;
	#defaultGrace: Duration | undefined;
	#defaultTimeout: Duration | undefined;
	#defaultHardTimeout: Duration | undefined;
	#defaultLockTimeout: Duration | undefined;
	#name: string;
	#emitter: CacheEmitter | undefined;
	#shared: SharedState;

	constructor(driver: CacheDriver, config?: CacheConfig, shared?: SharedState) {
		this.#driver = driver;
		this.#prefix = config?.prefix ?? "";
		this.#defaultTtl = config?.ttl ?? 3600;
		this.#defaultGrace = config?.grace;
		this.#defaultTimeout = config?.timeout;
		this.#defaultHardTimeout = config?.hardTimeout;
		this.#defaultLockTimeout = config?.lockTimeout;
		this.#name = config?.name ?? "default";
		this.#emitter = config?.emitter;
		this.#shared = shared ?? { inflight: new Map() };
	}

	#prefixKey(key: string): string {
		return this.#prefix ? `${this.#prefix}:${key}` : key;
	}

	#emit<E extends keyof CacheEventMap>(
		event: E,
		payload: CacheEventMap[E],
	): void {
		this.#emitter?.emit(event, payload);
	}

	async #readEntry<T>(prefixed: string): Promise<CacheEntry<T> | null> {
		if (this.#driver.getEntry) return this.#driver.getEntry<T>(prefixed);
		const value = await this.#driver.get<T>(prefixed);
		return value === null ? null : { value, stale: false };
	}

	async #writeValue(
		prefixed: string,
		value: unknown,
		ttlSeconds: number,
		graceSeconds: number,
		tags: string[],
	): Promise<void> {
		if (value === null || value === undefined) {
			// Named divergence (fail-loud): unlike bento (which no-ops), echo throws
			// on caching null/undefined — a null cache write is almost always a bug.
			throw new TypeError(
				"Echo: caching null/undefined values is not supported",
			);
		}
		if (this.#driver.setEntry) {
			await this.#driver.setEntry(prefixed, value, {
				ttlSeconds,
				graceSeconds,
				tags,
			});
			return;
		}
		if (tags.length > 0) {
			if (!isTaggableDriver(this.#driver)) {
				throw new Error(
					"Echo: the configured driver does not support tag-based invalidation",
				);
			}
			await this.#driver.setWithTags(prefixed, value, tags, ttlSeconds);
			return;
		}
		await this.#driver.set(prefixed, value, ttlSeconds);
	}

	// ---- get -------------------------------------------------------------

	get<T = unknown>(key: string): Promise<T | null>;
	get<T = unknown>(options: GetOptions<T>): Promise<T | null>;
	async get<T = unknown>(
		keyOrOptions: string | GetOptions<T>,
	): Promise<T | null> {
		const key =
			typeof keyOrOptions === "string" ? keyOrOptions : keyOrOptions.key;
		const graceSeconds =
			typeof keyOrOptions === "string"
				? resolveTtlSeconds(this.#defaultGrace, 0)
				: resolveTtlSeconds(keyOrOptions.grace ?? this.#defaultGrace, 0);
		const defaultValue =
			typeof keyOrOptions === "string" ? undefined : keyOrOptions.defaultValue;

		const entry = await this.#readEntry<T>(this.#prefixKey(key));
		if (entry && !entry.stale) {
			this.#emit("cache:hit", {
				key,
				value: entry.value,
				store: this.#name,
				graced: false,
			});
			return entry.value;
		}
		if (entry?.stale && graceSeconds > 0) {
			this.#emit("cache:hit", {
				key,
				value: entry.value,
				store: this.#name,
				graced: true,
			});
			return entry.value;
		}

		this.#emit("cache:miss", { key, store: this.#name });
		if (defaultValue !== undefined) {
			return defaultValue instanceof Function ? defaultValue() : defaultValue;
		}
		return null;
	}

	// ---- set -------------------------------------------------------------

	set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
	set(options: SetOptions): Promise<void>;
	async set(
		keyOrOptions: string | SetOptions,
		value?: unknown,
		ttlSeconds?: number,
	): Promise<void> {
		let key: string;
		let val: unknown;
		let ttl: number;
		let graceSeconds: number;
		let tags: string[];
		if (typeof keyOrOptions === "string") {
			key = keyOrOptions;
			val = value;
			ttl = ttlSeconds ?? this.#defaultTtl;
			graceSeconds = 0;
			tags = [];
		} else {
			key = keyOrOptions.key;
			val = keyOrOptions.value;
			ttl = resolveTtlSeconds(keyOrOptions.ttl, this.#defaultTtl);
			graceSeconds = resolveTtlSeconds(
				keyOrOptions.grace ?? this.#defaultGrace,
				0,
			);
			tags = keyOrOptions.tags ?? [];
		}
		await this.#writeValue(this.#prefixKey(key), val, ttl, graceSeconds, tags);
		this.#emit("cache:written", { key, value: val, store: this.#name });
	}

	/** Set a value that never expires (bento `setForever`). */
	setForever(options: Omit<SetOptions, "ttl">): Promise<void> {
		return this.set({ ...options, ttl: null });
	}

	// ---- delete / has / clear -------------------------------------------

	delete(key: string): Promise<boolean>;
	delete(options: DeleteOptions): Promise<boolean>;
	async delete(keyOrOptions: string | DeleteOptions): Promise<boolean> {
		const key =
			typeof keyOrOptions === "string" ? keyOrOptions : keyOrOptions.key;
		const deleted = await this.#driver.delete(this.#prefixKey(key));
		this.#emit("cache:deleted", { key, store: this.#name });
		return deleted;
	}

	/** Delete multiple keys (bento `deleteMany`). */
	async deleteMany(
		keysOrOptions: string[] | DeleteManyOptions,
	): Promise<boolean> {
		const keys = Array.isArray(keysOrOptions)
			? keysOrOptions
			: keysOrOptions.keys;
		let all = true;
		for (const key of keys) {
			const ok = await this.#driver.delete(this.#prefixKey(key));
			this.#emit("cache:deleted", { key, store: this.#name });
			if (!ok) all = false;
		}
		return all;
	}

	has(key: string): Promise<boolean>;
	has(options: HasOptions): Promise<boolean>;
	async has(keyOrOptions: string | HasOptions): Promise<boolean> {
		const key =
			typeof keyOrOptions === "string" ? keyOrOptions : keyOrOptions.key;
		return this.#driver.has(this.#prefixKey(key));
	}

	/** Inverse of {@link has} (bento `missing`). */
	async missing(keyOrOptions: string | HasOptions): Promise<boolean> {
		const key =
			typeof keyOrOptions === "string" ? keyOrOptions : keyOrOptions.key;
		return !(await this.has(key));
	}

	/** Read a key and delete it in one step (bento `pull`). Returns `null` on miss. */
	async pull<T = unknown>(key: string): Promise<T | null> {
		const value = await this.get<T>(key);
		if (value !== null) await this.delete(key);
		return value;
	}

	/**
	 * Expire a key: mark it stale immediately while retaining it for the grace
	 * window (bento `expire`). Without grace this is equivalent to a delete.
	 */
	async expire(keyOrOptions: string | ExpireOptions): Promise<boolean> {
		const key =
			typeof keyOrOptions === "string" ? keyOrOptions : keyOrOptions.key;
		const prefixed = this.#prefixKey(key);
		const graceSeconds = resolveTtlSeconds(this.#defaultGrace, 0);
		const entry = await this.#readEntry<unknown>(prefixed);
		if (entry === null) return false;
		if (graceSeconds > 0 && this.#driver.setEntry) {
			// Mark the entry stale RIGHT NOW (logical expiry one ms in the past) while
			// keeping it physically for the grace window. A positive `ttlSeconds`
			// would leave a brief fresh window during which the value is still served
			// and the factory never runs.
			await this.#driver.setEntry(prefixed, entry.value, {
				expiresAt: Date.now() - 1,
				graceSeconds,
			});
			return true;
		}
		return this.#driver.delete(prefixed);
	}

	/** Clear the whole store (bento/Adonis `clear`). */
	async clear(): Promise<void> {
		await this.#driver.flush();
		this.#emit("cache:cleared", { store: this.#name });
	}

	// ---- tags ------------------------------------------------------------

	/** Set a value with tags for grouped invalidation (bento parity). */
	async setWithTags(
		key: string,
		value: unknown,
		tags: string[],
		ttlSeconds?: number,
	): Promise<void> {
		await this.#writeValue(
			this.#prefixKey(key),
			value,
			ttlSeconds ?? this.#defaultTtl,
			0,
			tags,
		);
		this.#emit("cache:written", { key, value, store: this.#name });
	}

	/** Invalidate all entries carrying any of the given tags (bento `deleteByTag`). */
	deleteByTag(tags: string[]): Promise<void>;
	deleteByTag(options: DeleteByTagOptions): Promise<void>;
	async deleteByTag(
		tagsOrOptions: string[] | DeleteByTagOptions,
	): Promise<void> {
		const tags = Array.isArray(tagsOrOptions)
			? tagsOrOptions
			: tagsOrOptions.tags;
		if (!isTaggableDriver(this.#driver)) {
			throw new Error(
				"Echo: the configured driver does not support tag-based invalidation",
			);
		}
		if (typeof this.#driver.deleteByTag === "function") {
			return this.#driver.deleteByTag(tags);
		}
		return this.#driver.flushTags(tags);
	}

	/** @deprecated alias of {@link deleteByTag}. */
	async flushTags(tags: string[]): Promise<void> {
		return this.deleteByTag(tags);
	}

	// ---- namespace -------------------------------------------------------

	/**
	 * A cache view scoped under an extra key prefix (Adonis `cache.namespace()`).
	 * Shares the SAME driver, defaults, emitter AND single-flight state, so a
	 * `getOrSet` stampede is collapsed across namespace views of the same key.
	 */
	namespace(ns: string): CacheManager {
		return new CacheManager(
			this.#driver,
			{
				prefix: this.#prefix ? `${this.#prefix}:${ns}` : ns,
				ttl: this.#defaultTtl,
				grace: this.#defaultGrace,
				timeout: this.#defaultTimeout,
				hardTimeout: this.#defaultHardTimeout,
				lockTimeout: this.#defaultLockTimeout,
				name: this.#name,
				emitter: this.#emitter,
			},
			this.#shared,
		);
	}

	// ---- getOrSet --------------------------------------------------------

	#normalizeGetOrSet<T>(
		a: string | GetOrSetOptions<T>,
		b: number | undefined,
		c: Factory<T> | undefined,
	): NormalizedGetOrSet<T> {
		if (typeof a === "string") {
			if (typeof c !== "function") {
				throw new TypeError(
					"Echo: getOrSet(key, ttl, factory) requires a factory function",
				);
			}
			return {
				key: a,
				factory: c,
				ttlSeconds: resolveTtlSeconds(b, this.#defaultTtl),
				graceSeconds: resolveTtlSeconds(this.#defaultGrace, 0),
				timeoutMs: resolveMs(this.#defaultTimeout),
				hardTimeoutMs: resolveMs(this.#defaultHardTimeout),
				lockTimeoutMs: resolveMs(this.#defaultLockTimeout),
				tags: [],
			};
		}
		return {
			key: a.key,
			factory: a.factory,
			ttlSeconds: resolveTtlSeconds(a.ttl, this.#defaultTtl),
			graceSeconds: resolveTtlSeconds(a.grace ?? this.#defaultGrace, 0),
			timeoutMs: resolveMs(a.timeout ?? this.#defaultTimeout),
			hardTimeoutMs: resolveMs(a.hardTimeout ?? this.#defaultHardTimeout),
			lockTimeoutMs: resolveMs(a.lockTimeout ?? this.#defaultLockTimeout),
			tags: a.tags ?? [],
			onFactoryError: a.onFactoryError,
		};
	}

	/**
	 * Run (or join) the single-flight factory for `prefixed`. Resolves to the
	 * fresh value on success; on failure it calls `onFactoryError` and either
	 * resolves to `staleValue` (when a stale fallback exists) or rejects.
	 */
	#invokeFactory<T>(
		prefixed: string,
		o: NormalizedGetOrSet<T>,
		hasStale: boolean,
		staleValue: T | undefined,
	): Promise<T> {
		const run = async (): Promise<T> => {
			try {
				const value = await o.factory();
				await this.#writeValue(
					prefixed,
					value,
					o.ttlSeconds,
					o.graceSeconds,
					o.tags,
				);
				this.#emit("cache:written", {
					key: o.key,
					value,
					store: this.#name,
				});
				return value;
			} catch (error) {
				o.onFactoryError?.(new FactoryError(o.key, error, hasStale));
				if (hasStale && staleValue !== undefined) return staleValue;
				throw error;
			} finally {
				this.#shared.inflight.delete(prefixed);
			}
		};
		return run();
	}

	getOrSet<T>(key: string, ttlSeconds: number, factory: Factory<T>): Promise<T>;
	getOrSet<T>(options: GetOrSetOptions<T>): Promise<T>;
	async getOrSet<T>(
		a: string | GetOrSetOptions<T>,
		b?: number,
		c?: Factory<T>,
	): Promise<T> {
		const o = this.#normalizeGetOrSet<T>(a, b, c);
		const prefixed = this.#prefixKey(o.key);

		const entry = await this.#readEntry<T>(prefixed);
		if (entry && !entry.stale) {
			this.#emit("cache:hit", {
				key: o.key,
				value: entry.value,
				store: this.#name,
				graced: false,
			});
			return entry.value;
		}

		const hasStale = entry?.stale === true && o.graceSeconds > 0;
		const staleValue = hasStale ? entry.value : undefined;

		let record = this.#shared.inflight.get(prefixed);
		if (!record) {
			record = {
				promise: this.#invokeFactory<T>(prefixed, o, hasStale, staleValue),
			};
			this.#shared.inflight.set(prefixed, record);
		}
		// Single-flight join point: the shared map is heterogeneous (many T), so
		// this generic re-assertion is unavoidable (mirrors echo <=0.1.5).
		const factoryPromise = record.promise as Promise<T>;

		if (hasStale && staleValue !== undefined) {
			// Stale-while-revalidate: serve stale up to the soft timeout (default 0
			// = serve immediately), let the factory refresh in the background.
			const softMs = o.timeoutMs ?? 0;
			const waitMs =
				o.lockTimeoutMs !== undefined
					? Math.min(softMs, o.lockTimeoutMs)
					: softMs;
			const result = await withTimeout(factoryPromise, waitMs);
			if (result === TIMEOUT) {
				this.#emit("cache:hit", {
					key: o.key,
					value: staleValue,
					store: this.#name,
					graced: true,
				});
				return staleValue;
			}
			return result;
		}

		if (o.hardTimeoutMs !== undefined) {
			const result = await withTimeout(factoryPromise, o.hardTimeoutMs);
			if (result === TIMEOUT) {
				throw new TimeoutError(o.key, o.hardTimeoutMs);
			}
			return result;
		}

		return factoryPromise;
	}

	/** Like {@link getOrSet} but the stored value never expires (bento `getOrSetForever`). */
	getOrSetForever<T>(options: GetOrSetForeverOptions<T>): Promise<T> {
		return this.getOrSet<T>({ ...options, ttl: null });
	}
}
