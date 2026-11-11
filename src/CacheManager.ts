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

import { claimed, hasUnref } from "./claim.js";
import { type Duration, parseDuration, resolveTtlSeconds } from "./duration.js";
import {
	EchoError,
	FactoryError,
	InvalidArgumentError,
	InvalidDurationError,
	LockTimeoutError,
	TimeoutError,
	UndefinedValueError,
} from "./errors.js";
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

function notTaggable(): EchoError {
	return new EchoError(
		"E_ECHO_NOT_TAGGABLE",
		"Echo: the configured driver does not support tag-based invalidation",
	);
}

/** The longest delay `setTimeout` honours; past it Node fires after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Resolve an optional timeout {@link Duration} to milliseconds; `undefined`
 * when unset or `Infinity` (no timeout).
 *
 * Checked, because `setTimeout` reads NaN, Infinity and anything past
 * 2^31-1 ms as 1 ms: "never time out" became "time out at once", and every
 * getOrSet rejected. A longer one is clamped to the longest timer there is
 * (24.8 days); NaN and negatives mean nothing and are refused.
 */
function resolveMs(duration: Duration | undefined): number | undefined {
	if (duration === undefined || duration === null) return undefined;
	const seconds =
		typeof duration === "number" ? duration : parseDuration(duration);
	if (seconds === Number.POSITIVE_INFINITY) return undefined;
	if (Number.isNaN(seconds) || seconds < 0) {
		throw new InvalidDurationError(
			`Echo: a timeout must be a non-negative duration, or null for none — got ${String(duration)}`,
		);
	}
	return Math.min(seconds * 1000, MAX_TIMER_MS);
}

const TIMEOUT: unique symbol = Symbol("echo.timeout");

function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
): Promise<T | typeof TIMEOUT> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => resolve(TIMEOUT), ms);
		// A soft timeout is for the request in flight, not a reason for the
		// process to stay up. Checked rather than asserted: the browser's
		// `setTimeout` answers a number, which has no `unref`.
		if (hasUnref(timer)) timer.unref();
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
	/**
	 * How long an entry stays fresh: a number of SECONDS, or a
	 * {@link Duration} — `'30s'`, `'10m'` — like every other timing option
	 * here. It was the one locked to `number`, so a config copied from the
	 * documentation failed to typecheck on the line most likely to be copied.
	 */
	ttl?: Duration;
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
	/** Optional event emitter (`cache:hit` / `miss` / `written` / `deleted` / `cleared` / `expire`). */
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

/** The slice of `CacheStoreManager` a store it built needs to reach back into. */
export interface StoreFacade {
	use(name?: string): CacheManager;
	connectAll(): Promise<void>;
	disconnectAll(): Promise<void>;
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
	// One set per event, each typed to ITS payload — a single flat set would
	// need a cast at every call, which is the lie to avoid here. Listed rather
	// than built, so adding an event to CacheEventMap fails the typecheck until
	// it is wired here too.
	readonly #listeners: {
		[E in keyof CacheEventMap]: Set<(payload: CacheEventMap[E]) => void>;
	} = {
		"cache:hit": new Set(),
		"cache:miss": new Set(),
		"cache:written": new Set(),
		"cache:deleted": new Set(),
		"cache:cleared": new Set(),
		"cache:expire": new Set(),
	};
	#shared: SharedState;
	/**
	 * The store manager this one came from, when it did.
	 *
	 * What makes `cache.use('other')` work on the object the provider
	 * publishes. Upstream's manager is ONE object that both operates on the
	 * default store and reaches the named ones; binding the default store
	 * alone made the first example in the README throw on its second line.
	 */
	#stores: StoreFacade | undefined;
	/** A connect in flight, so two callers do not open two. */
	#connecting: Promise<void> | undefined;
	/** Whether the driver's external work is open. Reset by `disconnect()`. */
	#connected = false;

	constructor(driver: CacheDriver, config?: CacheConfig, shared?: SharedState) {
		this.#driver = driver;
		this.#prefix = config?.prefix ?? "";
		this.#defaultTtl = resolveTtlSeconds(config?.ttl, 3600);
		this.#defaultGrace = config?.grace;
		this.#defaultTimeout = config?.timeout;
		this.#defaultHardTimeout = config?.hardTimeout;
		this.#defaultLockTimeout = config?.lockTimeout;
		this.#name = config?.name ?? "default";
		this.#emitter = config?.emitter;
		this.#shared = shared ?? { inflight: new Map() };
	}

	/** The store's name, as events report it (upstream `cache.name`). */
	get name(): string {
		return this.#name;
	}

	#prefixKey(key: string): string {
		return this.#prefix ? `${this.#prefix}:${key}` : key;
	}

	/**
	 * Tags live inside the namespace, exactly as keys do. They reached the
	 * driver bare, into one store-wide index, so `tenantA.deleteByTag(['user:1'])`
	 * also dropped tenantB's entries tagged `user:1`. Upstream scopes them the
	 * same way: its tag invalidations are entries of the namespaced stack.
	 */
	#prefixTags(tags: string[]): string[] {
		return tags.map((tag) => this.#prefixKey(tag));
	}

	#emit<E extends keyof CacheEventMap>(
		event: E,
		payload: CacheEventMap[E],
	): void {
		// Not just called: an Adonis emitter's `emit` is `async` and REJECTS when
		// a listener throws and the application registered no error handler
		// (`@adonisjs/events`: `if (this.#errorHandler) … else throw error`).
		// Nobody awaits a cache event, so that rejection had nowhere to go and
		// ended the process over a metrics listener. The interface said `void`,
		// which is why nothing looked wrong — TypeScript accepts a
		// promise-returning function for a `void` return.
		void (async () => this.#emitter?.emit(event, payload))().catch(
			(error: unknown) => {
				process.stderr.write(
					`[echo] '${String(event)}' listener failed: ${
						error instanceof Error ? error.message : String(error)
					}\n`,
				);
			},
		);
		for (const listener of this.#listeners[event]) {
			try {
				listener(payload);
			} catch {
				// A metrics listener that throws must not fail the cache call it
				// was observing — the read already succeeded.
			}
		}
	}

	/**
	 * Listen for a cache event (bentocache `on`).
	 *
	 *   cache.on('cache:miss', ({ key }) => metrics.increment('cache.miss', { key }))
	 *
	 * Listeners are additive to any injected emitter, and one that throws is
	 * swallowed: it observes the operation, it does not get to fail it.
	 */
	on<E extends keyof CacheEventMap>(
		event: E,
		listener: (payload: CacheEventMap[E]) => void,
	): this {
		this.#listeners[event].add(listener);
		return this;
	}

	/** Listen for the next occurrence only (bentocache `once`). */
	once<E extends keyof CacheEventMap>(
		event: E,
		listener: (payload: CacheEventMap[E]) => void,
	): this {
		const wrapper = (payload: CacheEventMap[E]): void => {
			this.off(event, wrapper);
			listener(payload);
		};
		return this.on(event, wrapper);
	}

	/** Stop listening (bentocache `off`). Omitting `listener` drops them all. */
	off<E extends keyof CacheEventMap>(
		event: E,
		listener?: (payload: CacheEventMap[E]) => void,
	): this {
		if (listener === undefined) {
			this.#listeners[event].clear();
			return this;
		}
		this.#listeners[event].delete(listener);
		return this;
	}

	/**
	 * Drop entries the driver knows to be expired (bentocache `prune`).
	 *
	 * Only meaningful where expiry is not enforced by the store itself — a file
	 * or SQL driver accumulates dead rows, whereas Redis evicts on its own.
	 * A driver without the hook reports nothing pruned rather than failing.
	 */
	async prune(): Promise<void> {
		await this.#whenConnected();
		await this.#driver.prune?.();
	}

	/**
	 * Release whatever the driver holds open (bentocache `disconnect`).
	 *
	 * A driver built on an INJECTED client does not close it: echo did not open
	 * the connection and other consumers may still be using it. Only a driver
	 * that owns its resource implements the hook.
	 */
	/**
	 * Reach a named store — or this one, when it is the only one.
	 *
	 * @throws when a name is given and this manager owns a single store: the
	 *   configuration says which stores exist, and answering with the default
	 *   would cache under a name nobody declared.
	 */
	use(name?: string): CacheManager {
		if (this.#stores) return this.#stores.use(name);
		if (name === undefined) return this;
		throw new EchoError(
			"E_ECHO_UNKNOWN_STORE",
			`Echo: cannot use the "${name}" store — this cache is configured with a single store. ` +
				"Declare `{ default, stores }` in config/cache.ts to name several.",
		);
	}

	/** @internal Called by `CacheStoreManager` on the store it builds. */
	belongsTo(stores: StoreFacade): void {
		this.#stores = stores;
	}

	/**
	 * Open what the driver needs outside the process (a bus subscription).
	 *
	 * Awaited by whoever readies the application, and its failure is theirs to
	 * refuse — a tiered store that never subscribed serves stale L1 copies to
	 * everyone until their TTL.
	 */
	async connect(): Promise<void> {
		if (this.#connected) return;
		// Once. Two callers — the provider readying, and the first operation on
		// a store built after that — must not open two subscriptions.
		this.#connecting ??= (async () => {
			await this.#driver.connect?.();
			this.#connected = true;
		})();
		try {
			await this.#connecting;
		} finally {
			// Forgotten either way. On failure so a later call gets to try again
			// rather than replaying the same rejection for the life of the
			// process; on success because `#connected` is what says so, and a
			// memo kept past a `disconnect()` made the next `connect()` a no-op
			// on a connection that had since been closed.
			this.#connecting = undefined;
		}
	}

	/**
	 * Wait for a connect ALREADY under way, and let its failure pass.
	 *
	 * A store built after the application was ready connects on its way out of
	 * `use()`, and its first operation must not race that. The failure is not
	 * this caller's to raise: the provider refuses the boot when the bus cannot
	 * be reached, and after that an unreachable bus costs staleness — refusing
	 * every read would cost far more.
	 */
	async #whenConnected(): Promise<void> {
		if (this.#connected) return;
		// STARTED here, not merely awaited. A store built after the application
		// was ready connects on its way out of `use()`, and a connect that
		// failed leaves nothing in flight — so an operation that only waited
		// went on to read and write off the bus, for good. Attempting it means
		// a transient failure is retried by the next operation instead.
		//
		// The failure is not raised: the provider refuses the boot when the bus
		// cannot be reached, and after that an unreachable bus costs staleness.
		// Refusing every read would cost far more.
		await this.connect().catch(() => {});
	}

	/**
	 * Open every store this cache can reach, the named ones included.
	 *
	 * `connect()` alone reaches the DEFAULT store, which is what the provider
	 * publishes — so a named tiered store declared beside it never subscribed,
	 * and its L1 kept serving copies of keys other instances had deleted.
	 */
	async connectAll(): Promise<void> {
		if (this.#stores) return this.#stores.connectAll();
		await this.connect();
	}

	/** Release every store this cache can reach (bentocache `disconnectAll`). */
	async disconnectAll(): Promise<void> {
		if (this.#stores) return this.#stores.disconnectAll();
		await this.disconnect();
	}

	async disconnect(): Promise<void> {
		// A connect still in flight finishes FIRST, so its subscription is one
		// this teardown can see. Tearing down ahead of it left the handler to
		// land afterwards, on a store nobody was tracking any more.
		if (this.#connecting) await this.#connecting.catch(() => {});
		try {
			await this.#driver.disconnect?.();
		} finally {
			// Reset either way: a store that refused to close is not one that
			// should silently skip its next `connect()`.
			this.#connected = false;
			this.#connecting = undefined;
		}
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
			throw new UndefinedValueError();
		}
		if (ttlSeconds < 0) {
			// A TTL in the past: the value has already expired. Kept only as
			// a stale copy for its grace window, otherwise dropped — and the
			// key's previous value with it, which a skipped write would have
			// left being served. Upstream deletes the same way when the TTL
			// is not positive and grace is off.
			if (graceSeconds > 0 && this.#driver.setEntry) {
				await this.#driver.setEntry(prefixed, value, {
					expiresAt: Date.now() - 1,
					graceSeconds,
					tags: this.#prefixTags(tags),
				});
				return;
			}
			await this.#driver.delete(prefixed);
			return;
		}
		if (this.#driver.setEntry) {
			await this.#driver.setEntry(prefixed, value, {
				ttlSeconds,
				graceSeconds,
				tags: this.#prefixTags(tags),
			});
			return;
		}
		if (tags.length > 0) {
			if (!isTaggableDriver(this.#driver)) {
				throw notTaggable();
			}
			await this.#driver.setWithTags(
				prefixed,
				value,
				this.#prefixTags(tags),
				ttlSeconds,
			);
			return;
		}
		await this.#driver.set(prefixed, value, ttlSeconds);
	}

	// ---- get -------------------------------------------------------------

	get<T = unknown>(key: string): Promise<T | undefined>;
	get<T = unknown>(options: GetOptions<T>): Promise<T | undefined>;
	async get<T = unknown>(
		keyOrOptions: string | GetOptions<T>,
	): Promise<T | undefined> {
		await this.#whenConnected();
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
		// UNDEFINED, as upstream answers. It returned `null`, so code written
		// against the documented shape — `if (value === undefined)` — never
		// matched a miss, silently. The driver boundary still speaks `null`,
		// which is where the translation happens: a driver reports "no entry",
		// and this reports "nothing cached".
		return undefined;
	}

	// ---- set -------------------------------------------------------------

	set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
	set(options: SetOptions): Promise<void>;
	async set(
		keyOrOptions: string | SetOptions,
		value?: unknown,
		ttlSeconds?: number,
	): Promise<void> {
		await this.#whenConnected();
		let key: string;
		let val: unknown;
		let ttl: number;
		let graceSeconds: number;
		let tags: string[];
		if (typeof keyOrOptions === "string") {
			key = keyOrOptions;
			val = value;
			ttl = resolveTtlSeconds(ttlSeconds, this.#defaultTtl);
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
		await this.#whenConnected();
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
		await this.#whenConnected();
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
		await this.#whenConnected();
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
	async pull<T = unknown>(key: string): Promise<T | undefined> {
		await this.#whenConnected();
		const value = await this.get<T>(key);
		if (value !== undefined) await this.delete(key);
		return value;
	}

	/**
	 * Expire a key: mark it stale immediately while retaining it for the grace
	 * window (bento `expire`). Without grace this is equivalent to a delete.
	 */
	async expire(keyOrOptions: string | ExpireOptions): Promise<boolean> {
		await this.#whenConnected();
		const key =
			typeof keyOrOptions === "string" ? keyOrOptions : keyOrOptions.key;
		const prefixed = this.#prefixKey(key);
		const graceSeconds = resolveTtlSeconds(this.#defaultGrace, 0);
		const entry = await this.#readEntry<unknown>(prefixed);
		if (entry === null) return false;
		let expired: boolean;
		if (graceSeconds > 0 && this.#driver.setEntry) {
			// Mark the entry stale RIGHT NOW (logical expiry one ms in the past) while
			// keeping it physically for the grace window. A positive `ttlSeconds`
			// would leave a brief fresh window during which the value is still served
			// and the factory never runs.
			//
			// With its tags, as the driver read them (already scoped to this
			// namespace): rewritten without them, the stale copy was served for
			// the whole grace window while deleteByTag no longer reached it.
			await this.#driver.setEntry(prefixed, entry.value, {
				expiresAt: Date.now() - 1,
				graceSeconds,
				tags: entry.tags ?? [],
			});
			expired = true;
		} else {
			expired = await this.#driver.delete(prefixed);
		}
		if (expired) this.#emit("cache:expire", { key, store: this.#name });
		return expired;
	}

	/**
	 * Clear this cache — the whole store, or only this namespace's subtree.
	 *
	 * A namespaced view shares the driver, so this used to flush everything:
	 * one tenant clearing its own cache emptied every other tenant's, from an
	 * operation they are allowed to run. Upstream scopes it the same way, by
	 * handing the driver the prefix.
	 */
	async clear(): Promise<void> {
		await this.#whenConnected();
		// The separator is part of it: `tenant-a` must not take `tenant-abc`
		// with it, and every key under this view is written `<prefix>:<key>`.
		await this.#driver.flush(this.#prefix ? `${this.#prefix}:` : undefined);
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
		await this.#whenConnected();
		await this.#writeValue(
			this.#prefixKey(key),
			value,
			resolveTtlSeconds(ttlSeconds, this.#defaultTtl),
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
		await this.#whenConnected();
		const tags = Array.isArray(tagsOrOptions)
			? tagsOrOptions
			: tagsOrOptions.tags;
		if (!isTaggableDriver(this.#driver)) {
			throw notTaggable();
		}
		const scoped = this.#prefixTags(tags);
		if (typeof this.#driver.deleteByTag === "function") {
			return this.#driver.deleteByTag(scoped);
		}
		return this.#driver.flushTags(scoped);
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
				throw new InvalidArgumentError(
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
		// Checked in this form too: a config value or a JSON body reaching here
		// untyped made the call fail with a bare TypeError from deep inside the
		// single-flight bookkeeping, instead of a refusal naming the argument.
		if (typeof a.factory !== "function") {
			throw new InvalidArgumentError(
				"Echo: getOrSet({ key, factory }) requires a factory function",
			);
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
	 * Run the single-flight factory for `prefixed` and register it as the
	 * key's in-flight record. Resolves to the fresh value on success; on
	 * failure it calls `onFactoryError` and either resolves to `staleValue`
	 * (when a stale fallback exists) or rejects. The record is removed once it
	 * settles, whichever way.
	 */
	#invokeFactory<T>(
		prefixed: string,
		o: NormalizedGetOrSet<T>,
		hasStale: boolean,
		staleValue: T | undefined,
	): Promise<T> {
		const run = async (): Promise<T> => {
			try {
				// Called a microtask later, never inline. A factory that throws
				// before returning a promise ran this `finally` synchronously,
				// BEFORE the record below was stored: the rejected promise then
				// stayed in the map for good, and every later call for the key
				// joined it instead of running the factory again.
				const value = await Promise.resolve().then(() => o.factory());
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
				// Only this run's own record: a later leader's must survive it.
				if (this.#shared.inflight.get(prefixed)?.promise === promise) {
					this.#shared.inflight.delete(prefixed);
				}
			}
		};
		const promise = run();
		this.#shared.inflight.set(prefixed, { promise });
		return promise;
	}

	getOrSet<T>(key: string, ttlSeconds: number, factory: Factory<T>): Promise<T>;
	getOrSet<T>(options: GetOrSetOptions<T>): Promise<T>;
	async getOrSet<T>(
		a: string | GetOrSetOptions<T>,
		b?: number,
		c?: Factory<T>,
	): Promise<T> {
		await this.#whenConnected();
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

		const record = this.#shared.inflight.get(prefixed);
		// Joining another caller's factory, rather than running our own.
		const joined = record !== undefined;
		let factoryPromise: Promise<T>;
		if (record === undefined) {
			factoryPromise = this.#invokeFactory<T>(
				prefixed,
				o,
				hasStale,
				staleValue,
			);
		} else {
			// The map holds every key's factory, whatever its type; what the
			// leader computes for this key is what this caller reads.
			factoryPromise = record.promise.then((value) => claimed<T>(value));
		}

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

		// A joiner waits at most `lockTimeout` for the leader, stale value or
		// not, as upstream bounds its lock acquisition either way. It was read
		// on the stale path only, so behind a factory that hung every caller
		// for the key waited forever. The leader is not bound by it: it holds
		// the lock, and `hardTimeout` is what bounds its factory.
		const lockMs = joined ? o.lockTimeoutMs : undefined;
		const hardMs = o.hardTimeoutMs;
		if (lockMs !== undefined && (hardMs === undefined || lockMs < hardMs)) {
			const result = await withTimeout(factoryPromise, lockMs);
			if (result === TIMEOUT) throw new LockTimeoutError(o.key, lockMs);
			return result;
		}
		if (hardMs !== undefined) {
			const result = await withTimeout(factoryPromise, hardMs);
			if (result === TIMEOUT) {
				throw new TimeoutError(o.key, hardMs);
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
