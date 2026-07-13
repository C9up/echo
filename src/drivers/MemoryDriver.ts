/**
 * Memory cache driver — in-process Map with TTL, grace (stale-while-revalidate)
 * and tag support. Suitable for development and single-process deployments, and
 * as the L1 tier of {@link TieredDriver}.
 */

import type { CacheEntry, DriverSetOptions, TaggableDriver } from "../types.js";

interface StoredEntry {
	value: unknown;
	/** Logical expiry (epoch ms); `0` means never. Past this the entry is stale. */
	expiresAt: number;
	/** Physical eviction (epoch ms); `0` means never. Grace window ends here. */
	staleUntil: number;
	tags: string[];
}

export class MemoryDriver implements TaggableDriver {
	#store: Map<string, StoredEntry> = new Map();
	#tagIndex: Map<string, Set<string>> = new Map();
	#sweepInterval: ReturnType<typeof setInterval>;

	constructor(sweepIntervalMs = 60_000) {
		this.#sweepInterval = setInterval(() => {
			const now = Date.now();
			for (const [key, entry] of this.#store) {
				if (entry.staleUntil > 0 && entry.staleUntil < now) {
					this.#evict(key, entry);
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
		const stale = entry.expiresAt > 0 && entry.expiresAt < now;
		return { value: entry.value as T, stale, expiresAt: entry.expiresAt };
	}

	/**
	 * Delete an entry AND scrub its tag-index refs. TTL/grace expiry (sweep +
	 * lazy get) must go through this — a bare `#store.delete` left dangling refs
	 * in `#tagIndex`, which a later `set(key, vNew)` reusing the key would turn
	 * into a wrong-purge under deleteByTag (audit 2026-06-13).
	 */
	#evict(key: string, entry: StoredEntry): void {
		for (const tag of entry.tags) this.#tagIndex.get(tag)?.delete(key);
		this.#store.delete(key);
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
			throw new TypeError(
				"Echo: caching null/undefined values is not supported",
			);
		}
		const now = Date.now();
		const hasTtl = ttlSeconds != null && ttlSeconds > 0;
		// An absolute `expiresAtOverride` (e.g. `expire()` marking stale-now) wins
		// over the ttl-derived expiry; a past value makes the entry immediately stale.
		const expiresAt =
			expiresAtOverride !== undefined
				? expiresAtOverride
				: hasTtl
					? now + ttlSeconds * 1000
					: 0;
		const graceMs = graceSeconds > 0 ? graceSeconds * 1000 : 0;
		// A never-expiring entry never goes stale either; otherwise grace extends
		// physical retention past the logical expiry. Measure grace from the LATER
		// of the expiry and now, so an already-past expiry still survives its grace.
		const staleUntil = expiresAt > 0 ? Math.max(expiresAt, now) + graceMs : 0;
		// Reconcile the tag index: overwriting a previously-tagged key must drop
		// its old tag-index refs, or a later deleteByTag could purge this fresh
		// value (audit 2026-05-22 F3).
		const prev = this.#store.get(key);
		if (prev !== undefined) {
			for (const t of prev.tags) this.#tagIndex.get(t)?.delete(key);
		}
		this.#store.set(key, { value, expiresAt, staleUntil, tags });
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
		for (const key of toDelete) {
			const entry = this.#store.get(key);
			if (entry) {
				for (const t of entry.tags) {
					this.#tagIndex.get(t)?.delete(key);
				}
			}
			this.#store.delete(key);
		}
		for (const tag of tags) this.#tagIndex.delete(tag);
	}

	/** @deprecated alias of {@link deleteByTag}. */
	async flushTags(tags: string[]): Promise<void> {
		return this.deleteByTag(tags);
	}
}
