/**
 * Redis cache driver — production-grade cache with TTL, grace
 * (stale-while-revalidate) and tags. Suitable as the L2 tier of
 * {@link TieredDriver}.
 *
 * Requires a Redis client implementing the minimal interface below, which a
 * raw ioredis client satisfies.
 *
 * STORAGE FORMAT: values live at `<prefix>v:<key>` as a JSON envelope
 * `{ "v": <value>, "e": <logicalExpiryEpochMs> }`; tag sets at `<prefix>t:<tag>`
 * and per-key reverse indexes at `<prefix>m:<key>`. The physical Redis TTL
 * covers `ttl + grace` so a logically-expired value survives for the grace
 * window; `e` records the logical expiry so reads can flag it stale.
 */

import type { CacheEntry, DriverSetOptions, TaggableDriver } from "../types.js";

/**
 * Minimal Redis client interface, in ioredis' shape — a raw ioredis client
 * satisfies it as is.
 */
export interface RedisClient {
	get(key: string): Promise<string | null>;
	set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
	/** Variadic, as ioredis declares it: a raw client then typechecks. */
	del(...keys: string[]): Promise<number>;
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

/** Escape Redis MATCH glob metacharacters so the pattern matches literally. */
function escapeGlob(literal: string): string {
	return literal.replace(/[*?[\]\\]/g, "\\$&");
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

/**
 * Where the client comes from. A resolver is what lets a store name its
 * connection (`drivers.redis({ connection: "cache" })`) instead of being handed
 * a client: the store is built synchronously, but the first command that needs
 * the client is not.
 */
export type RedisClientSource =
	| RedisClient
	| (() => RedisClient | Promise<RedisClient>);

export class RedisDriver implements TaggableDriver {
	#source: RedisClientSource;
	#resolved: RedisClient | undefined;
	#pending: Promise<RedisClient> | undefined;
	#prefix: string;

	constructor(source: RedisClientSource, prefix?: string) {
		this.#source = source;
		// `||`, not a default parameter: an empty prefix made clear() scan
		// `MATCH *` and delete every key in the database. Upstream falls back
		// the same way (`config.prefix || "bentocache"`).
		this.#prefix = prefix || "cache:";
	}

	/**
	 * The client, resolved once. Two commands racing on a cold store must not
	 * each open their own connection, so the in-flight promise is shared.
	 */
	async #client(): Promise<RedisClient> {
		if (this.#resolved) return this.#resolved;
		if (typeof this.#source !== "function") {
			this.#resolved = this.#source;
			return this.#resolved;
		}
		if (!this.#pending) {
			const resolver = this.#source;
			this.#pending = Promise.resolve(resolver())
				.then((client) => {
					this.#resolved = client;
					return client;
				})
				// Cleared on failure too. Clearing only on success left the
				// REJECTED promise cached forever, so one transient outage at
				// startup broke every later call for the life of the process —
				// a permanent failure with no error of its own to explain it.
				.finally(() => {
					this.#pending = undefined;
				});
		}
		return this.#pending;
	}

	/*
	 * Three disjoint sub-spaces under the store prefix: values (`v:`), tag
	 * sets (`t:`) and per-key reverse indexes (`m:`). They shared one keyspace
	 * before, so a cache key `tag:<t>` overwrote a tag SET with a string and a
	 * root key `meta:tags:<k>` sat in another entry's index slot: every
	 * invalidation through them then failed with WRONGTYPE, and the entry it
	 * was meant to drop kept being served. Any user key lands under `v:`, so
	 * none can reach the bookkeeping.
	 */

	#valueKey(key: string): string {
		return `${this.#prefix}v:${key}`;
	}

	#tagKey(tag: string): string {
		return `${this.#prefix}t:${tag}`;
	}

	/**
	 * Reverse index of the tags `key` carries. Lets a retag clean stale
	 * memberships, and `delete()` drop the key from every tag set it is in.
	 */
	#metaKey(key: string): string {
		return `${this.#prefix}m:${key}`;
	}

	async delete(key: string): Promise<boolean> {
		const client = await this.#client();
		await this.#dropTags(key);
		const count = await client.del(this.#valueKey(key));
		return count > 0;
	}

	async get<T = unknown>(key: string): Promise<T | null> {
		const entry = await this.getEntry<T>(key);
		if (entry === null || entry.stale) return null;
		return entry.value;
	}

	async getEntry<T = unknown>(key: string): Promise<CacheEntry<T> | null> {
		const client = await this.#client();
		const raw = await client.get(this.#valueKey(key));
		if (raw === null) return null;
		const parsed: unknown = JSON.parse(raw);
		if (!isEnvelope(parsed)) return null;
		const stale = parsed.e > 0 && parsed.e < Date.now();
		// Deserialize boundary: the on-the-wire value is genuinely `unknown`; the
		// caller's generic `T` is the assertion. This is the single unavoidable
		// cast site (mirrors echo <=0.1.5 `JSON.parse(raw) as T`).
		const value = parsed.v as T;
		return { value, stale, expiresAt: parsed.e };
	}

	/** Write the value envelope with a physical (grace-inclusive) TTL in seconds. */
	async #writeEnvelope(
		key: string,
		value: unknown,
		logicalTtlSeconds: number,
		physicalTtlSeconds: number,
		logicalExpiresAtOverride?: number,
	): Promise<void> {
		const client = await this.#client();
		// An absolute override (e.g. `expire()` marking stale-now) wins over the
		// ttl-derived logical expiry; a past value flags the entry stale on read.
		const expiresAt =
			logicalExpiresAtOverride !== undefined
				? logicalExpiresAtOverride
				: logicalTtlSeconds > 0
					? Date.now() + logicalTtlSeconds * 1000
					: 0;
		const envelope: Envelope = { v: value, e: expiresAt };
		const serialized = JSON.stringify(envelope);
		if (physicalTtlSeconds > 0) {
			await client.set(
				this.#valueKey(key),
				serialized,
				"EX",
				physicalTtlSeconds,
			);
		} else {
			await client.set(this.#valueKey(key), serialized);
		}
	}

	/** Drop a key from every tag set it is in, and its reverse index. */
	async #dropTags(key: string): Promise<void> {
		const client = await this.#client();
		const metaKey = this.#metaKey(key);
		const prevTags = await client.smembers(metaKey);
		for (const tag of prevTags) {
			await client.srem(this.#tagKey(tag), key);
		}
		if (prevTags.length > 0) await client.del(metaKey);
	}

	async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
		await this.#dropTags(key);
		const ttl = ttlSeconds && ttlSeconds > 0 ? ttlSeconds : 0;
		await this.#writeEnvelope(key, value, ttl, ttl);
	}

	async setEntry(
		key: string,
		value: unknown,
		options: DriverSetOptions,
	): Promise<void> {
		const ttl =
			options.ttlSeconds && options.ttlSeconds > 0 ? options.ttlSeconds : 0;
		const grace =
			options.graceSeconds && options.graceSeconds > 0
				? options.graceSeconds
				: 0;
		// With an absolute logical expiry (e.g. `expire()` marking stale-now), the
		// ttl no longer drives physical retention — keep the value for the grace
		// window measured from now so a stale-but-graced read still finds it.
		const override = options.expiresAt;
		const physical = override !== undefined ? grace : ttl > 0 ? ttl + grace : 0;
		const tags = options.tags ?? [];
		if (tags.length === 0) {
			await this.#dropTags(key);
			await this.#writeEnvelope(key, value, ttl, physical, override);
			return;
		}
		await this.#writeEnvelope(key, value, ttl, physical, override);
		await this.#applyTags(key, tags, physical);
	}

	async flush(prefix?: string): Promise<void> {
		if (prefix === undefined) {
			// The whole store: everything under its prefix, bookkeeping included.
			await this.#deleteUnder(this.#prefix);
			return;
		}
		// A namespace: its keys leave the tag sets they are in first — those
		// sets are shared with whatever else carries the same tag — then its
		// values and reverse indexes go. Scanning values alone left the
		// indexes behind, immortal when the entries were.
		const client = await this.#client();
		const metaPrefix = this.#metaKey(prefix);
		await this.#scan(metaPrefix, async (metaKeys) => {
			for (const metaKey of metaKeys) {
				const key = metaKey.slice(this.#metaKey("").length);
				for (const tag of await client.smembers(metaKey)) {
					await client.srem(this.#tagKey(tag), key);
				}
			}
			await client.del(...metaKeys);
		});
		await this.#deleteUnder(this.#valueKey(prefix));
	}

	/**
	 * Delete every key that starts with `literal`, walking a SCAN cursor.
	 *
	 * The prefix is escaped before it becomes a MATCH pattern: MATCH is a glob,
	 * so a namespace like `tenant-*` matched every tenant and a clear of it
	 * wiped them all. Each returned key is checked against the literal prefix
	 * as well, so a pattern the server reads differently still deletes nothing
	 * outside it. Upstream interpolates the prefix unescaped; this is stricter
	 * on purpose.
	 */
	async #deleteUnder(literal: string): Promise<void> {
		const client = await this.#client();
		await this.#scan(literal, async (keys) => {
			await client.del(...keys);
		});
	}

	/** Walk a SCAN cursor over the keys starting with `literal`, a page at a time. */
	async #scan(
		literal: string,
		onPage: (keys: string[]) => Promise<void>,
	): Promise<void> {
		const client = await this.#client();
		if (typeof client.scan !== "function") {
			throw new Error(
				"Echo: RedisDriver.flush() requires a client with scan() support. KEYS is not safe for production use.",
			);
		}
		const pattern = `${escapeGlob(literal)}*`;
		let cursor = "0";
		do {
			// Called ON the client: ioredis reads `this` inside scan(), so a
			// detached reference threw and left every key in place.
			const [nextCursor, keys] = await client.scan(
				cursor,
				"MATCH",
				pattern,
				"COUNT",
				100,
			);
			cursor = nextCursor;
			const owned = keys.filter((key) => key.startsWith(literal));
			if (owned.length > 0) await onPage(owned);
		} while (cursor !== "0");
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
		const client = await this.#client();
		const metaKey = this.#metaKey(key);
		const oldTags = await client.smembers(metaKey);
		const newTagSet = new Set(tags);
		const oldTagSet = new Set(oldTags);
		const removedTags = oldTags.filter((t) => !newTagSet.has(t));
		const addedTags = tags.filter((t) => !oldTagSet.has(t));

		for (const tag of removedTags) {
			await client.srem(this.#tagKey(tag), key);
		}

		for (const tag of tags) {
			const tagKey = this.#tagKey(tag);
			if (addedTags.includes(tag)) {
				await client.sadd(tagKey, key);
			}
			if (physicalTtlSeconds > 0) {
				const currentTtl = await client.ttl(tagKey);
				if (currentTtl < 0 || physicalTtlSeconds > currentTtl) {
					await client.expire(tagKey, physicalTtlSeconds);
				}
			}
		}

		if (oldTags.length > 0) {
			await client.del(metaKey);
		}
		if (tags.length > 0) {
			await client.sadd(metaKey, ...tags);
			if (physicalTtlSeconds > 0) {
				await client.expire(metaKey, physicalTtlSeconds);
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
		await this.#writeEnvelope(key, value, ttl, ttl);
		await this.#applyTags(key, tags, ttl);
	}

	/**
	 * Invalidate all entries tagged with any of the given tags. Cleans the
	 * per-key reverse-index AND cross-tag memberships so a multi-tag key flushed
	 * via one tag is also removed from the others.
	 */
	async deleteByTag(tags: string[]): Promise<void> {
		const client = await this.#client();
		for (const tag of tags) {
			const tagKey = this.#tagKey(tag);
			const members = await client.smembers(tagKey);
			for (const key of members) {
				const metaKey = this.#metaKey(key);
				for (const otherTag of await client.smembers(metaKey)) {
					if (otherTag === tag) continue;
					await client.srem(this.#tagKey(otherTag), key);
				}
				await client.del(metaKey, this.#valueKey(key));
			}
			await client.del(tagKey);
		}
	}

	/** @deprecated alias of {@link deleteByTag}. */
	async flushTags(tags: string[]): Promise<void> {
		return this.deleteByTag(tags);
	}
}
