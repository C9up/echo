/**
 * Redis cache driver — production-grade cache with TTL, grace
 * (stale-while-revalidate) and tags. Suitable as the L2 tier of
 * {@link TieredDriver}.
 *
 * Requires a Redis client instance implementing the minimal interface below.
 * Compatible with ioredis and redis (node-redis) clients.
 *
 * STORAGE FORMAT (breaking vs echo <=0.1.5): values are stored as a JSON
 * envelope `{ "v": <value>, "e": <logicalExpiryEpochMs> }`. The physical Redis
 * TTL (`EX`) covers `ttl + grace` so a logically-expired value survives for the
 * grace window; `e` records the logical expiry so reads can flag it stale.
 */

import type { CacheEntry, DriverSetOptions, TaggableDriver } from "../types.js";

/** Minimal Redis client interface — compatible with ioredis and node-redis. */
export interface RedisClient {
	get(key: string): Promise<string | null>;
	set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
	del(key: string | string[]): Promise<number>;
	exists(key: string): Promise<number>;
	keys(pattern: string): Promise<string[]>;
	sadd(key: string, ...members: string[]): Promise<number>;
	srem(key: string, ...members: string[]): Promise<number>;
	smembers(key: string): Promise<string[]>;
	expire(key: string, seconds: number): Promise<number>;
	ttl(key: string): Promise<number>;
	scan?(
		cursor: string,
		matchOption: "MATCH",
		pattern: string,
		countOption: "COUNT",
		count: number,
	): Promise<[string, string[]]>;
}

interface Envelope {
	v: unknown;
	e: number;
}

function isEnvelope(x: unknown): x is Envelope {
	return (
		typeof x === "object" &&
		x !== null &&
		"v" in x &&
		"e" in x &&
		typeof Reflect.get(x, "e") === "number"
	);
}

export class RedisDriver implements TaggableDriver {
	#client: RedisClient;
	#prefix: string;

	constructor(client: RedisClient, prefix = "cache:") {
		this.#client = client;
		this.#prefix = prefix;
	}

	#key(k: string): string {
		return `${this.#prefix}${k}`;
	}

	/**
	 * Reverse-index for per-key tag membership. Lets tag writes clean stale
	 * memberships on retag, and `delete()` drop the key from every tag-set it
	 * belongs to.
	 */
	#metaKey(k: string): string {
		return `${this.#prefix}meta:tags:${k}`;
	}

	async delete(key: string): Promise<boolean> {
		const fullKey = this.#key(key);
		const metaKey = this.#metaKey(key);
		const tags = await this.#client.smembers(metaKey);
		for (const tag of tags) {
			const tagKey = `${this.#prefix}tag:${tag}`;
			await this.#client.srem(tagKey, fullKey);
		}
		if (tags.length > 0) {
			await this.#client.del(metaKey);
		}
		const count = await this.#client.del(fullKey);
		return count > 0;
	}

	async get<T = unknown>(key: string): Promise<T | null> {
		const entry = await this.getEntry<T>(key);
		if (entry === null || entry.stale) return null;
		return entry.value;
	}

	async getEntry<T = unknown>(key: string): Promise<CacheEntry<T> | null> {
		const raw = await this.#client.get(this.#key(key));
		if (raw === null) return null;
		const parsed: unknown = JSON.parse(raw);
		if (!isEnvelope(parsed)) return null;
		const stale = parsed.e > 0 && parsed.e < Date.now();
		// Deserialize boundary: the on-the-wire value is genuinely `unknown`; the
		// caller's generic `T` is the assertion. This is the single unavoidable
		// cast site (mirrors echo <=0.1.5 `JSON.parse(raw) as T`).
		const value = parsed.v as T;
		return { value, stale };
	}

	/** Write the value envelope with a physical (grace-inclusive) TTL in seconds. */
	async #writeEnvelope(
		fullKey: string,
		value: unknown,
		logicalTtlSeconds: number,
		physicalTtlSeconds: number,
	): Promise<void> {
		const expiresAt =
			logicalTtlSeconds > 0 ? Date.now() + logicalTtlSeconds * 1000 : 0;
		const envelope: Envelope = { v: value, e: expiresAt };
		const serialized = JSON.stringify(envelope);
		if (physicalTtlSeconds > 0) {
			await this.#client.set(fullKey, serialized, "EX", physicalTtlSeconds);
		} else {
			await this.#client.set(fullKey, serialized);
		}
	}

	/** Drop a key from its previous tag memberships (reconcile before re-tagging). */
	async #dropTags(fullKey: string, metaKey: string): Promise<string[]> {
		const prevTags = await this.#client.smembers(metaKey);
		for (const tag of prevTags) {
			await this.#client.srem(`${this.#prefix}tag:${tag}`, fullKey);
		}
		if (prevTags.length > 0) await this.#client.del(metaKey);
		return prevTags;
	}

	async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
		const fullKey = this.#key(key);
		await this.#dropTags(fullKey, this.#metaKey(key));
		const ttl = ttlSeconds && ttlSeconds > 0 ? ttlSeconds : 0;
		await this.#writeEnvelope(fullKey, value, ttl, ttl);
	}

	async setEntry(
		key: string,
		value: unknown,
		options: DriverSetOptions,
	): Promise<void> {
		const fullKey = this.#key(key);
		const metaKey = this.#metaKey(key);
		const ttl =
			options.ttlSeconds && options.ttlSeconds > 0 ? options.ttlSeconds : 0;
		const grace =
			options.graceSeconds && options.graceSeconds > 0
				? options.graceSeconds
				: 0;
		const physical = ttl > 0 ? ttl + grace : 0;
		const tags = options.tags ?? [];
		if (tags.length === 0) {
			await this.#dropTags(fullKey, metaKey);
			await this.#writeEnvelope(fullKey, value, ttl, physical);
			return;
		}
		await this.#writeEnvelope(fullKey, value, ttl, physical);
		await this.#applyTags(key, tags, physical);
	}

	async flush(): Promise<void> {
		const scan = this.#client.scan;
		if (typeof scan === "function") {
			let cursor = "0";
			do {
				const [nextCursor, keys] = await scan(
					cursor,
					"MATCH",
					`${this.#prefix}*`,
					"COUNT",
					100,
				);
				cursor = nextCursor;
				if (keys.length > 0) {
					await this.#client.del(keys);
				}
			} while (cursor !== "0");
		} else {
			throw new Error(
				"Echo: RedisDriver.flush() requires a client with scan() support. KEYS is not safe for production use.",
			);
		}
	}

	async has(key: string): Promise<boolean> {
		return (await this.get(key)) !== null;
	}

	/**
	 * Reconcile the tag reverse-index for `key` to exactly `tags`, and extend
	 * tag-set / meta TTLs to the physical (grace-inclusive) retention.
	 */
	async #applyTags(
		key: string,
		tags: string[],
		physicalTtlSeconds: number,
	): Promise<void> {
		const fullKey = this.#key(key);
		const metaKey = this.#metaKey(key);
		const oldTags = await this.#client.smembers(metaKey);
		const newTagSet = new Set(tags);
		const oldTagSet = new Set(oldTags);
		const removedTags = oldTags.filter((t) => !newTagSet.has(t));
		const addedTags = tags.filter((t) => !oldTagSet.has(t));

		for (const tag of removedTags) {
			await this.#client.srem(`${this.#prefix}tag:${tag}`, fullKey);
		}

		for (const tag of tags) {
			const tagKey = `${this.#prefix}tag:${tag}`;
			if (addedTags.includes(tag)) {
				await this.#client.sadd(tagKey, fullKey);
			}
			if (physicalTtlSeconds > 0) {
				const currentTtl = await this.#client.ttl(tagKey);
				if (currentTtl < 0 || physicalTtlSeconds > currentTtl) {
					await this.#client.expire(tagKey, physicalTtlSeconds);
				}
			}
		}

		if (oldTags.length > 0) {
			await this.#client.del(metaKey);
		}
		if (tags.length > 0) {
			await this.#client.sadd(metaKey, ...tags);
			if (physicalTtlSeconds > 0) {
				await this.#client.expire(metaKey, physicalTtlSeconds);
			}
		}
	}

	/** Set a value with tag memberships for group invalidation (no grace). */
	async setWithTags(
		key: string,
		value: unknown,
		tags: string[],
		ttlSeconds?: number,
	): Promise<void> {
		const ttl = ttlSeconds && ttlSeconds > 0 ? ttlSeconds : 0;
		await this.#writeEnvelope(this.#key(key), value, ttl, ttl);
		await this.#applyTags(key, tags, ttl);
	}

	/**
	 * Invalidate all entries tagged with any of the given tags. Cleans the
	 * per-key reverse-index AND cross-tag memberships so a multi-tag key flushed
	 * via one tag is also removed from the others.
	 */
	async deleteByTag(tags: string[]): Promise<void> {
		for (const tag of tags) {
			const tagKey = `${this.#prefix}tag:${tag}`;
			const members = await this.#client.smembers(tagKey);
			for (const fullKey of members) {
				const userKey = fullKey.startsWith(this.#prefix)
					? fullKey.slice(this.#prefix.length)
					: fullKey;
				const metaKey = this.#metaKey(userKey);
				const allTags = await this.#client.smembers(metaKey);
				for (const otherTag of allTags) {
					if (otherTag === tag) continue;
					const otherTagKey = `${this.#prefix}tag:${otherTag}`;
					await this.#client.srem(otherTagKey, fullKey);
				}
				if (allTags.length > 0) {
					await this.#client.del(metaKey);
				}
			}
			if (members.length > 0) {
				await this.#client.del(members);
			}
			await this.#client.del(tagKey);
		}
	}

	/** @deprecated alias of {@link deleteByTag}. */
	async flushTags(tags: string[]): Promise<void> {
		return this.deleteByTag(tags);
	}
}
