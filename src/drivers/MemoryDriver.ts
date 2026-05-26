/**
 * Memory cache driver — in-process Map with TTL support.
 * Suitable for development and single-process deployments.
 */

import type { CacheDriver } from "../CacheManager.js";

interface CacheEntry {
	value: unknown;
	expiresAt: number;
	tags: string[];
}

export class MemoryDriver implements CacheDriver {
	#store: Map<string, CacheEntry> = new Map();
	#tagIndex: Map<string, Set<string>> = new Map();
	#sweepInterval: ReturnType<typeof setInterval>;

	constructor(sweepIntervalMs = 60_000) {
		this.#sweepInterval = setInterval(() => {
			const now = Date.now();
			for (const [key, entry] of this.#store) {
				if (entry.expiresAt > 0 && entry.expiresAt < now) {
					this.#store.delete(key);
				}
			}
		}, sweepIntervalMs);
		if (
			typeof this.#sweepInterval === "object" &&
			"unref" in this.#sweepInterval
		) {
			(this.#sweepInterval as { unref(): void }).unref();
		}
	}

	destroy(): void {
		clearInterval(this.#sweepInterval);
	}

	async get<T = unknown>(key: string): Promise<T | null> {
		const entry = this.#store.get(key);
		if (!entry) return null;
		if (entry.expiresAt > 0 && entry.expiresAt < Date.now()) {
			this.#store.delete(key);
			return null;
		}
		return entry.value as T;
	}

	async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
		if (value === null || value === undefined) {
			throw new TypeError(
				"Echo: caching null/undefined values is not supported",
			);
		}
		const expiresAt =
			ttlSeconds != null && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0;
		this.#store.set(key, { value, expiresAt, tags: [] });
	}

	async delete(key: string): Promise<boolean> {
		const entry = this.#store.get(key);
		if (entry) {
			for (const tag of entry.tags) {
				this.#tagIndex.get(tag)?.delete(key);
			}
		}
		return this.#store.delete(key);
	}

	async flush(): Promise<void> {
		this.#store.clear();
		this.#tagIndex.clear();
	}

	async has(key: string): Promise<boolean> {
		const val = await this.get(key);
		return val !== null;
	}

	/** Set with tags for group invalidation. */
	async setWithTags(
		key: string,
		value: unknown,
		tags: string[],
		ttlSeconds?: number,
	): Promise<void> {
		// Audit 2026-05-22 F4: align with `set()` — both paths now treat any
		// `ttlSeconds <= 0` (and undefined) as "no expiration". Previously
		// `setWithTags` used a truthy check (`ttlSeconds ?`), which let a
		// negative value through and produced `Date.now() + (-N * 1000)` —
		// an already-past timestamp — so the entry was born already-expired.
		// `set()` correctly returned the immortal-entry branch on the same
		// input. The divergence made cache semantics depend on whether the
		// caller used tags or not, which is the worst kind of "very hard to
		// diagnose in prod" bug.
		const expiresAt =
			ttlSeconds != null && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0;
		// Audit 2026-05-22 F3 (overwrite leg): if `key` already exists with
		// a different tag set, the old #tagIndex entries become dangling
		// refs to the (now overwritten) key. Clean them up before re-tagging
		// so subsequent flushTags doesn't iterate stale references.
		const prev = this.#store.get(key);
		if (prev !== undefined) {
			for (const t of prev.tags) this.#tagIndex.get(t)?.delete(key);
		}
		this.#store.set(key, { value, expiresAt, tags });
		for (const tag of tags) {
			let set = this.#tagIndex.get(tag);
			if (!set) {
				set = new Set();
				this.#tagIndex.set(tag, set);
			}
			set.add(key);
		}
	}

	/** Flush all entries tagged with any of the given tags. */
	async flushTags(tags: string[]): Promise<void> {
		// Audit 2026-05-22 F3: when a key is multi-tagged (e.g. `[news, fr]`)
		// and we flush by `news`, the old code deleted the key from #store
		// and dropped the `news` Set, but `fr`'s Set kept a dangling
		// reference. A later flushTags(`fr`) would iterate over the
		// stale entry, attempt `#store.delete(key)` (no-op), and the entry
		// would silently linger in #tagIndex forever. Worse — if a new
		// entry was later written under the same key with different tags,
		// flushTags(`fr`) would WRONGLY purge it because of the residue.
		// Collect keys first, then scrub each one from EVERY tag set it
		// belonged to (including the tags we're not flushing this round).
		const toDelete = new Set<string>();
		for (const tag of tags) {
			const keys = this.#tagIndex.get(tag);
			if (keys) {
				for (const key of keys) toDelete.add(key);
			}
		}
		for (const key of toDelete) {
			const entry = this.#store.get(key);
			if (entry) {
				for (const t of entry.tags) {
					this.#tagIndex.get(t)?.delete(key);
				}
			}
			this.#store.delete(key);
		}
		// Now drop the flushed tag sets themselves (any other keys still
		// referenced by them have been processed in the toDelete loop and
		// already removed via the inner scrub).
		for (const tag of tags) this.#tagIndex.delete(tag);
	}
}
