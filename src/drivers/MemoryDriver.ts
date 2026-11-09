/**
 * Memory cache driver — in-process Map with TTL, grace (stale-while-revalidate)
 * and tag support. Suitable for development and single-process deployments, and
 * as the L1 tier of {@link TieredDriver}.
 */

import { parseBytes } from "../bytes.js";
import { checkTtlSeconds } from "../duration.js";
import { EchoError, UndefinedValueError } from "../errors.js";
import type { CacheEntry, DriverSetOptions, TaggableDriver } from "../types.js";

export interface MemoryDriverOptions {
	/** How often expired entries are swept, in milliseconds (default 60 000). */
	sweepIntervalMs?: number;
	/**
	 * How many entries the store holds before it evicts the least recently
	 * used. Default 1000, as upstream; `0` or `Infinity` for no ceiling.
	 */
	maxItems?: number;
	/**
	 * Total size of the stored values, in bytes or as `'10mb'`; past it the
	 * least recently used entries go. Needs `serialize`, since it measures
	 * the JSON.
	 */
	maxSize?: number | string;
	/**
	 * Largest single value, in bytes or as `'1mb'`. A bigger one is not
	 * stored, and the key's previous value goes with it. Defaults to
	 * `maxSize` when that is set. Needs `serialize`.
	 */
	maxEntrySize?: number | string;
	/**
	 * Store values as JSON and hand out a fresh copy on every read (default).
	 *
	 * `false` keeps the caller's object and returns that same reference, which
	 * is faster and keeps class instances, Dates and Maps intact — but any
	 * reader that mutates what it got rewrites the value for every later one.
	 */
	serialize?: boolean;
}

interface StoredEntry {
	/** The JSON text when the driver serializes, the value itself when it does not. */
	value: unknown;
	/** Logical expiry (epoch ms); `0` means never. Past this the entry is stale. */
	expiresAt: number;
	/** Physical eviction (epoch ms); `0` means never. Grace window ends here. */
	staleUntil: number;
	tags: string[];
	/** Bytes of JSON; `0` when the driver keeps references. */
	size: number;
}

/** The JSON a value is stored as; refused when JSON cannot carry it. */
function toJson(value: unknown): string {
	const json = JSON.stringify(value);
	if (json === undefined) {
		throw new EchoError(
			"E_ECHO_UNSERIALIZABLE_VALUE",
			"Echo: the memory driver stores values as JSON, and this one has no JSON form — pass `serialize: false` to keep it as is",
		);
	}
	return json;
}

export class MemoryDriver implements TaggableDriver {
	#store: Map<string, StoredEntry> = new Map();
	#tagIndex: Map<string, Set<string>> = new Map();
	#sweepInterval: ReturnType<typeof setInterval>;
	/**
	 * How many entries this driver holds before it evicts.
	 *
	 * 1000 unless told otherwise, as upstream's LRU. It had no ceiling by
	 * default, so a cache keyed by anything a user controls — an id, a search
	 * term — grew until the process ran out of memory. `0` is an explicit "no
	 * ceiling".
	 */
	readonly #maxItems: number;
	/** Byte bound on all values together; `0` for none. */
	readonly #maxSize: number;
	/** Byte bound on one value; `0` for none. */
	readonly #maxEntrySize: number;
	/** Bytes held, kept in step with every write and removal. */
	#size = 0;
	/**
	 * Whether values go in as JSON and come out as a copy.
	 *
	 * On by default, as upstream serializes its L1 by default: the driver kept
	 * the caller's object and returned that same reference, so a request that
	 * mutated what it read — a cached permission set, say — changed it for
	 * every later reader. JSON is also what the Redis driver stores, so a
	 * value reads back the same in development and in production.
	 */
	readonly #serialize: boolean;

	/**
	 * @param options the options, or the sweep interval in milliseconds (the
	 *   original positional form, kept with `maxItems` beside it).
	 */
	constructor(options: MemoryDriverOptions | number = {}, maxItems?: number) {
		const config: MemoryDriverOptions =
			typeof options === "number"
				? { sweepIntervalMs: options, maxItems }
				: options;
		const ceiling = config.maxItems ?? 1000;
		if (Number.isNaN(ceiling) || ceiling < 0) {
			throw new EchoError(
				"E_ECHO_INVALID_CONFIG",
				`Echo: maxItems must be a count, 0 or Infinity for no ceiling — got ${String(ceiling)}`,
			);
		}
		this.#maxItems = Number.isFinite(ceiling) ? ceiling : 0;
		this.#serialize = config.serialize ?? true;
		if (
			!this.#serialize &&
			(config.maxSize !== undefined || config.maxEntrySize !== undefined)
		) {
			// What it would measure is the JSON, and a driver keeping
			// references has none. Upstream refuses the same combination.
			throw new EchoError(
				"E_ECHO_INVALID_CONFIG",
				"Echo: maxSize and maxEntrySize measure the stored JSON, so they need `serialize` — drop `serialize: false` or the byte bound",
			);
		}
		this.#maxSize =
			config.maxSize === undefined ? 0 : parseBytes(config.maxSize, "maxSize");
		this.#maxEntrySize =
			config.maxEntrySize === undefined
				? this.#maxSize
				: parseBytes(config.maxEntrySize, "maxEntrySize");
		this.#sweepInterval = setInterval(
			() => this.#sweep(),
			config.sweepIntervalMs ?? 60_000,
		);
		if (
			typeof this.#sweepInterval === "object" &&
			"unref" in this.#sweepInterval
		) {
			(this.#sweepInterval as { unref(): void }).unref();
		}
	}

	#fits(): boolean {
		return (
			(this.#maxItems === 0 || this.#store.size <= this.#maxItems) &&
			(this.#maxSize === 0 || this.#size <= this.#maxSize)
		);
	}

	/**
	 * Drop entries until the store fits under its ceilings.
	 *
	 * Expired ones go first — evicting a live entry while a dead one sits in
	 * the map would throw away a value someone still wants. Only if that is not
	 * enough does it take the least recently used: the Map's order, since a
	 * read moves its key to the end as a write does.
	 */
	#enforceCeiling(): void {
		if (this.#fits()) return;
		const now = Date.now();
		for (const [key, entry] of this.#store) {
			if (this.#fits()) return;
			if (entry.staleUntil > 0 && entry.staleUntil < now) {
				this.#evict(key, entry);
			}
		}
		for (const [key, entry] of this.#store) {
			if (this.#fits()) return;
			this.#evict(key, entry);
		}
	}

	/** Evict every entry past its grace window. */
	#sweep(): void {
		const now = Date.now();
		for (const [key, entry] of this.#store) {
			if (entry.staleUntil > 0 && entry.staleUntil < now) {
				this.#evict(key, entry);
			}
		}
	}

	/**
	 * Drop expired entries now, without waiting for the sweep (bentocache
	 * `prune`). Useful before measuring size, or in a test that must not depend
	 * on a timer.
	 */
	async prune(): Promise<void> {
		this.#sweep();
	}

	/**
	 * Stop the sweep timer this driver owns (bentocache `disconnect`). The
	 * entries stay readable; only the background work stops.
	 */
	async disconnect(): Promise<void> {
		this.destroy();
	}

	destroy(): void {
		clearInterval(this.#sweepInterval);
	}

	async get<T = unknown>(key: string): Promise<T | null> {
		const entry = this.getEntrySync<T>(key);
		if (entry === null || entry.stale) return null;
		return entry.value;
	}

	async getEntry<T = unknown>(key: string): Promise<CacheEntry<T> | null> {
		return this.getEntrySync<T>(key);
	}

	/** Synchronous read used by both `get` and `getEntry` (and by TieredDriver's L1 fast path). */
	getEntrySync<T = unknown>(key: string): CacheEntry<T> | null {
		const entry = this.#store.get(key);
		if (!entry) return null;
		const now = Date.now();
		if (entry.staleUntil > 0 && entry.staleUntil < now) {
			this.#evict(key, entry);
			return null;
		}
		// Least recently USED, not written: a read moves the key to the end of
		// the eviction order. Without it the hottest key was the first to go.
		this.#store.delete(key);
		this.#store.set(key, entry);
		const stale = entry.expiresAt > 0 && entry.expiresAt < now;
		const value =
			this.#serialize && typeof entry.value === "string"
				? JSON.parse(entry.value)
				: entry.value;
		return {
			value: value as T,
			stale,
			expiresAt: entry.expiresAt,
			tags: [...entry.tags],
		};
	}

	/**
	 * Delete an entry AND scrub its tag-index refs. TTL/grace expiry (sweep +
	 * lazy get) must go through this — a bare `#store.delete` left dangling refs
	 * in `#tagIndex`, which a later `set(key, vNew)` reusing the key would turn
	 * into a wrong-purge under deleteByTag (audit 2026-06-13).
	 */
	#evict(key: string, entry: StoredEntry): void {
		this.#untag(key, entry.tags);
		this.#store.delete(key);
		this.#size -= entry.size;
	}

	/**
	 * Take `key` out of each tag's set, and drop a set it leaves empty.
	 *
	 * Emptied sets were kept, so per-user or per-id tags grew the index by one
	 * set per entry ever written: a store capped at ten entries held hundreds
	 * of megabytes of empty sets.
	 */
	#untag(key: string, tags: string[]): void {
		for (const tag of tags) {
			const keys = this.#tagIndex.get(tag);
			if (keys === undefined) continue;
			keys.delete(key);
			if (keys.size === 0) this.#tagIndex.delete(tag);
		}
	}

	/** How many tags the index holds — what bounds its memory, for diagnostics. */
	tagCount(): number {
		return this.#tagIndex.size;
	}

	#write(
		key: string,
		value: unknown,
		ttlSeconds: number | undefined,
		graceSeconds: number,
		tags: string[],
		expiresAtOverride?: number,
	): void {
		if (value === null || value === undefined) {
			throw new UndefinedValueError();
		}
		// Before anything is touched: a value JSON cannot carry must leave the
		// previous entry and its tags exactly as they were.
		const stored = this.#serialize ? toJson(value) : value;
		const size = typeof stored === "string" ? Buffer.byteLength(stored) : 0;
		if (this.#maxEntrySize > 0 && size > this.#maxEntrySize) {
			// Too big to keep. The previous value goes too, as upstream's LRU
			// does: a skipped write must not leave an older value served.
			this.#deleteEntry(key);
			return;
		}
		const now = Date.now();
		const ttl = ttlSeconds === undefined ? 0 : checkTtlSeconds(ttlSeconds);
		const graceMs = graceSeconds > 0 ? graceSeconds * 1000 : 0;
		if (expiresAtOverride === undefined && ttl < 0 && graceMs === 0) {
			// Already expired, and no grace to keep a stale copy for: nothing
			// to store, and the previous value must not survive it.
			this.#deleteEntry(key);
			return;
		}
		// An absolute `expiresAtOverride` (e.g. `expire()` marking stale-now) wins
		// over the ttl-derived expiry; a past value makes the entry immediately
		// stale. So does a negative TTL — it never reads as "no expiry".
		const expiresAt =
			expiresAtOverride !== undefined
				? expiresAtOverride
				: ttl < 0
					? now - 1
					: ttl > 0
						? now + ttl * 1000
						: 0;
		// A never-expiring entry never goes stale either; otherwise grace extends
		// physical retention past the logical expiry. Measure grace from the LATER
		// of the expiry and now, so an already-past expiry still survives its grace.
		const staleUntil = expiresAt > 0 ? Math.max(expiresAt, now) + graceMs : 0;
		// Reconcile the tag index: overwriting a previously-tagged key must drop
		// its old tag-index refs, or a later deleteByTag could purge this fresh
		// value (audit 2026-05-22 F3).
		const prev = this.#store.get(key);
		if (prev !== undefined) this.#evict(key, prev);
		// Inserted last, so it is the most recently used.
		this.#store.set(key, {
			value: stored,
			expiresAt,
			staleUntil,
			tags,
			size,
		});
		this.#size += size;
		this.#enforceCeiling();
		for (const tag of tags) {
			let set = this.#tagIndex.get(tag);
			if (!set) {
				set = new Set();
				this.#tagIndex.set(tag, set);
			}
			set.add(key);
		}
	}

	async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
		this.#write(key, value, ttlSeconds, 0, []);
	}

	async setEntry(
		key: string,
		value: unknown,
		options: DriverSetOptions,
	): Promise<void> {
		this.#write(
			key,
			value,
			options.ttlSeconds,
			options.graceSeconds ?? 0,
			options.tags ?? [],
			options.expiresAt,
		);
	}

	async delete(key: string): Promise<boolean> {
		return this.#deleteEntry(key);
	}

	#deleteEntry(key: string): boolean {
		const entry = this.#store.get(key);
		if (entry === undefined) return false;
		this.#evict(key, entry);
		return true;
	}

	async flush(prefix?: string): Promise<void> {
		if (prefix === undefined) {
			this.#store.clear();
			this.#tagIndex.clear();
			this.#size = 0;
			return;
		}
		for (const [key, entry] of [...this.#store]) {
			if (key.startsWith(prefix)) this.#evict(key, entry);
		}
	}

	async has(key: string): Promise<boolean> {
		return (await this.get(key)) !== null;
	}

	/** Set with tags for group invalidation (bento parity; no grace). */
	async setWithTags(
		key: string,
		value: unknown,
		tags: string[],
		ttlSeconds?: number,
	): Promise<void> {
		this.#write(key, value, ttlSeconds, 0, tags);
	}

	/** Invalidate all entries tagged with any of the given tags. */
	async deleteByTag(tags: string[]): Promise<void> {
		// Audit 2026-05-22 F3: scrub each key from EVERY tag set it belongs to
		// (including tags not being flushed this round), else a multi-tagged key
		// leaves a dangling ref that later wrong-purges a reused key.
		const toDelete = new Set<string>();
		for (const tag of tags) {
			const keys = this.#tagIndex.get(tag);
			if (keys) {
				for (const key of keys) toDelete.add(key);
			}
		}
		for (const key of toDelete) this.#deleteEntry(key);
		for (const tag of tags) this.#tagIndex.delete(tag);
	}

	/** @deprecated alias of {@link deleteByTag}. */
	async flushTags(tags: string[]): Promise<void> {
		return this.deleteByTag(tags);
	}
}
