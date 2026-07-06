/**
 * TieredDriver — two-tier cache composing an L1 (in-process, e.g.
 * {@link MemoryDriver}) and an L2 (distributed, e.g. {@link RedisDriver}).
 *
 * Reads go L1 → L2 → miss, promoting an L2 hit back into L1. Writes are
 * write-through to both tiers. An optional {@link CacheBus} broadcasts
 * invalidations so peer instances drop their (now stale) L1 copies — the L2 is
 * shared, so only L1 needs cross-instance invalidation.
 */

import type {
	CacheDriver,
	CacheEntry,
	DriverSetOptions,
	TaggableDriver,
} from "../types.js";

/** A cross-instance invalidation message. */
export interface BusMessage {
	type: "delete" | "clear";
	keys: string[];
}

/** Duck-typed pub/sub bus for cross-instance L1 invalidation (e.g. Redis pub/sub). */
export interface CacheBus {
	publish(message: BusMessage): void | Promise<void>;
	subscribe(handler: (message: BusMessage) => void): void;
}

export interface TieredDriverOptions {
	l1: CacheDriver;
	l2: CacheDriver;
	bus?: CacheBus;
}

function isTaggable(driver: CacheDriver): driver is TaggableDriver {
	const candidate: Partial<TaggableDriver> = driver;
	return (
		typeof candidate.setWithTags === "function" &&
		(typeof candidate.deleteByTag === "function" ||
			typeof candidate.flushTags === "function")
	);
}

async function readEntry<T>(
	driver: CacheDriver,
	key: string,
): Promise<CacheEntry<T> | null> {
	if (driver.getEntry) return driver.getEntry<T>(key);
	const value = await driver.get<T>(key);
	return value === null ? null : { value, stale: false };
}

async function writeEntry(
	driver: CacheDriver,
	key: string,
	value: unknown,
	options: DriverSetOptions,
): Promise<void> {
	if (driver.setEntry) {
		await driver.setEntry(key, value, options);
		return;
	}
	if (options.tags && options.tags.length > 0 && isTaggable(driver)) {
		await driver.setWithTags(key, value, options.tags, options.ttlSeconds);
		return;
	}
	await driver.set(key, value, options.ttlSeconds);
}

export class TieredDriver implements TaggableDriver {
	#l1: CacheDriver;
	#l2: CacheDriver;
	#bus: CacheBus | undefined;

	constructor(options: TieredDriverOptions) {
		this.#l1 = options.l1;
		this.#l2 = options.l2;
		this.#bus = options.bus;
		this.#bus?.subscribe((message) => {
			// Peer invalidation: only the local L1 needs clearing (L2 is shared).
			if (message.type === "clear") {
				void this.#l1.flush();
				return;
			}
			for (const key of message.keys) void this.#l1.delete(key);
		});
	}

	async getEntry<T = unknown>(key: string): Promise<CacheEntry<T> | null> {
		const l1 = await readEntry<T>(this.#l1, key);
		if (l1 && !l1.stale) return l1;

		const l2 = await readEntry<T>(this.#l2, key);
		if (l2 && !l2.stale) {
			// Promote fresh L2 hit into L1.
			await writeEntry(this.#l1, key, l2.value, {});
			return l2;
		}
		if (l2) return l2; // stale L2 (grace)
		if (l1) return l1; // stale L1 (grace)
		return null;
	}

	async get<T = unknown>(key: string): Promise<T | null> {
		const entry = await this.getEntry<T>(key);
		if (entry === null || entry.stale) return null;
		return entry.value;
	}

	async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
		await this.setEntry(key, value, { ttlSeconds });
	}

	async setEntry(
		key: string,
		value: unknown,
		options: DriverSetOptions,
	): Promise<void> {
		await writeEntry(this.#l1, key, value, options);
		await writeEntry(this.#l2, key, value, options);
		await this.#bus?.publish({ type: "delete", keys: [key] });
	}

	async delete(key: string): Promise<boolean> {
		const l1 = await this.#l1.delete(key);
		const l2 = await this.#l2.delete(key);
		await this.#bus?.publish({ type: "delete", keys: [key] });
		return l1 || l2;
	}

	async flush(): Promise<void> {
		await this.#l1.flush();
		await this.#l2.flush();
		await this.#bus?.publish({ type: "clear", keys: [] });
	}

	async has(key: string): Promise<boolean> {
		return (await this.get(key)) !== null;
	}

	async setWithTags(
		key: string,
		value: unknown,
		tags: string[],
		ttlSeconds?: number,
	): Promise<void> {
		await this.setEntry(key, value, { ttlSeconds, tags });
	}

	async deleteByTag(tags: string[]): Promise<void> {
		const l1 = this.#l1;
		const l2 = this.#l2;
		if (!isTaggable(l1) || !isTaggable(l2)) {
			throw new Error(
				"Echo: TieredDriver.deleteByTag requires both tiers to be taggable",
			);
		}
		await l1.deleteByTag(tags);
		await l2.deleteByTag(tags);
		// Peers can't map tags → keys locally; broadcast a clear so their L1 drops
		// any tagged copies (conservative but correct).
		await this.#bus?.publish({ type: "clear", keys: [] });
	}

	/** @deprecated alias of {@link deleteByTag}. */
	async flushTags(tags: string[]): Promise<void> {
		return this.deleteByTag(tags);
	}
}
