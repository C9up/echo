/**
 * Redis cache driver — production-grade cache with TTL and tags.
 *
 * Requires a Redis client instance implementing the minimal interface below.
 * Compatible with ioredis and redis (node-redis) clients.
 *
 * @implements MISS-10
 */

import type { CacheDriver } from "../CacheManager.js";

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

export class RedisDriver implements CacheDriver {
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
	 * Reverse-index for per-key tag membership. Lets `setWithTags()` clean
	 * stale memberships when a key is retagged, and `delete()` drop the key
	 * from every tag-set it belongs to. Without this, a re-tag like
	 * `setWithTags('article:42', v, ['homepage'])` (was `['news']`) leaves
	 * `tag:news` pointing at `article:42`, and a later `flushTags(['news'])`
	 * silently deletes the value.
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
		const raw = await this.#client.get(this.#key(key));
		if (raw === null) return null;
		return JSON.parse(raw) as T;
	}

	async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
		const serialized = JSON.stringify(value);
		if (ttlSeconds && ttlSeconds > 0) {
			await this.#client.set(this.#key(key), serialized, "EX", ttlSeconds);
		} else {
			await this.#client.set(this.#key(key), serialized);
		}
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
		const exists = await this.#client.exists(this.#key(key));
		return exists > 0;
	}

	/**
	 * Set a value with tag memberships for group invalidation.
	 *
	 * Re-tagging an existing key (e.g. `['news']` → `['homepage']`) cleans
	 * the stale memberships via the per-key reverse-index — without this,
	 * a later `flushTags(['news'])` would silently wipe the still-current
	 * value because the abandoned `tag:news` set kept pointing at it.
	 */
	async setWithTags(
		key: string,
		value: unknown,
		tags: string[],
		ttlSeconds?: number,
	): Promise<void> {
		await this.set(key, value, ttlSeconds);
		const fullKey = this.#key(key);
		const metaKey = this.#metaKey(key);
		const oldTags = await this.#client.smembers(metaKey);
		const newTagSet = new Set(tags);
		const oldTagSet = new Set(oldTags);
		const removedTags = oldTags.filter((t) => !newTagSet.has(t));
		const addedTags = tags.filter((t) => !oldTagSet.has(t));

		// Drop the key from tag-sets it no longer belongs to.
		for (const tag of removedTags) {
			const tagKey = `${this.#prefix}tag:${tag}`;
			await this.#client.srem(tagKey, fullKey);
		}

		// Add to new tag-sets; re-touch TTLs on every declared tag so existing
		// memberships extend correctly on re-set.
		for (const tag of tags) {
			const tagKey = `${this.#prefix}tag:${tag}`;
			if (addedTags.includes(tag)) {
				await this.#client.sadd(tagKey, fullKey);
			}
			if (ttlSeconds && ttlSeconds > 0) {
				const currentTtl = await this.#client.ttl(tagKey);
				if (currentTtl < 0 || ttlSeconds > currentTtl) {
					await this.#client.expire(tagKey, ttlSeconds);
				}
			}
		}

		// Refresh the reverse-index to match the new tag set. Drop+re-add is
		// simpler than diff-mutating the set and matches `tags` exactly even
		// in the empty-array case.
		if (oldTags.length > 0) {
			await this.#client.del(metaKey);
		}
		if (tags.length > 0) {
			await this.#client.sadd(metaKey, ...tags);
			if (ttlSeconds && ttlSeconds > 0) {
				await this.#client.expire(metaKey, ttlSeconds);
			}
		}
	}

	/**
	 * Flush all entries tagged with any of the given tags. Cleans up the
	 * per-key reverse-index AND cross-tag memberships so a multi-tag key
	 * (e.g. `['news', 'homepage']`) flushed via `news` is also removed from
	 * the `homepage` tag-set — otherwise the `homepage` set ends up with a
	 * dangling reference to a now-deleted value.
	 */
	async flushTags(tags: string[]): Promise<void> {
		for (const tag of tags) {
			const tagKey = `${this.#prefix}tag:${tag}`;
			const members = await this.#client.smembers(tagKey);
			for (const fullKey of members) {
				// Read every OTHER tag this key claims (via the reverse-index)
				// and SREM the key from each. The reverse-index key derives
				// from the unprefixed user key — recover it by stripping the
				// prefix.
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
}
