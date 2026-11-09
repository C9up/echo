import { describe, expect, it } from "vitest";
import { CacheManager } from "../../src/CacheManager.js";
import {
	type RedisClient,
	RedisDriver,
} from "../../src/drivers/RedisDriver.js";
import { drivers } from "../../src/StoreManager.js";

/**
 * Redis' MATCH glob, as the server reads it: `*`, `?`, `[...]`, and `\`
 * escaping the next character.
 */
function globToRegExp(glob: string): RegExp {
	let source = "";
	for (let i = 0; i < glob.length; i++) {
		const char = glob.charAt(i);
		if (char === "\\" && i + 1 < glob.length) {
			i++;
			source += glob.charAt(i).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		} else if (char === "*") source += ".*";
		else if (char === "?") source += ".";
		else if (char === "[") {
			const end = glob.indexOf("]", i + 1);
			if (end === -1) source += "\\[";
			else {
				source += `[${glob.slice(i + 1, end)}]`;
				i = end;
			}
		} else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`, "s");
}

interface ScanState {
	cursor: number;
	step: number;
}

interface FakeRedisOpts {
	withScan?: boolean;
	scanPages?: number;
}

function createFakeRedis(opts: FakeRedisOpts = {}): {
	client: RedisClient;
	store: Map<string, string>;
	sets: Map<string, Set<string>>;
	calls: Array<{ op: string; args: unknown[] }>;
} {
	const store = new Map<string, string>();
	const sets = new Map<string, Set<string>>();
	const ttls = new Map<string, number>();
	const calls: Array<{ op: string; args: unknown[] }> = [];

	const scanStep: ScanState = { cursor: 0, step: 0 };
	const totalPages = opts.scanPages ?? 1;

	const client: RedisClient = {
		async get(key) {
			calls.push({ op: "get", args: [key] });
			return store.has(key) ? (store.get(key) ?? null) : null;
		},
		async set(key, value, ...args) {
			calls.push({ op: "set", args: [key, value, ...args] });
			store.set(key, value);
			return "OK";
		},
		async del(...keys) {
			calls.push({ op: "del", args: keys });
			let count = 0;
			for (const k of keys) {
				if (store.delete(k)) count++;
				if (sets.delete(k)) count++;
			}
			return count;
		},
		async exists(key) {
			calls.push({ op: "exists", args: [key] });
			return store.has(key) ? 1 : 0;
		},
		async keys(pattern) {
			calls.push({ op: "keys", args: [pattern] });
			const prefix = pattern.replace(/\*$/, "");
			return [...store.keys()].filter((k) => k.startsWith(prefix));
		},
		async sadd(key, ...members) {
			calls.push({ op: "sadd", args: [key, ...members] });
			const set = sets.get(key) ?? new Set<string>();
			for (const m of members) set.add(m);
			sets.set(key, set);
			return members.length;
		},
		async srem(key, ...members) {
			calls.push({ op: "srem", args: [key, ...members] });
			const set = sets.get(key);
			if (!set) return 0;
			let removed = 0;
			for (const m of members) {
				if (set.delete(m)) removed++;
			}
			if (set.size === 0) sets.delete(key);
			return removed;
		},
		async smembers(key) {
			calls.push({ op: "smembers", args: [key] });
			return [...(sets.get(key) ?? new Set<string>())];
		},
		async expire(key, seconds) {
			calls.push({ op: "expire", args: [key, seconds] });
			ttls.set(key, seconds);
			return 1;
		},
		async ttl(key) {
			calls.push({ op: "ttl", args: [key] });
			return ttls.get(key) ?? -1;
		},
	};

	if (opts.withScan) {
		// Capture the keyset at scan start so multi-page iteration is stable
		// even if the driver deletes keys between SCAN calls.
		let snapshot: string[] | null = null;
		client.scan = async (cursor, _match, pattern) => {
			calls.push({ op: "scan", args: [cursor, pattern] });
			if (snapshot === null) {
				const matcher = globToRegExp(pattern);
				snapshot = [...store.keys(), ...sets.keys()].filter((k) =>
					matcher.test(k),
				);
			}
			scanStep.step++;
			if (totalPages <= 1) {
				const all = snapshot;
				snapshot = null;
				scanStep.step = 0;
				return ["0", all];
			}
			const perPage = Math.ceil(snapshot.length / totalPages);
			const slice = snapshot.slice(
				(scanStep.step - 1) * perPage,
				scanStep.step * perPage,
			);
			const isLast = scanStep.step >= totalPages;
			if (isLast) {
				snapshot = null;
				scanStep.step = 0;
			}
			return [isLast ? "0" : String(scanStep.step), slice];
		};
	}

	return { client, store, sets, calls };
}

describe("echo > RedisDriver > get/set/has/delete", () => {
	it("set serializes the value to JSON; get parses it back", async () => {
		const fake = createFakeRedis();
		const driver = new RedisDriver(fake.client);
		await driver.set("user:1", { name: "Alice" });
		// Stored as a grace-aware envelope { v: value, e: staleUntil } so a stale
		// value can be served while a background refresh runs.
		const raw = fake.store.get("cache:v:user:1");
		expect(raw && JSON.parse(raw).v).toEqual({ name: "Alice" });
		expect(await driver.get<{ name: string }>("user:1")).toEqual({
			name: "Alice",
		});
	});

	it("set with TTL passes PX <milliseconds> to the client", async () => {
		const fake = createFakeRedis();
		const driver = new RedisDriver(fake.client);
		await driver.set("k", { v: 1 }, 60);
		const setCall = fake.calls.find((c) => c.op === "set");
		expect(setCall?.args.slice(2)).toEqual(["PX", 60_000]);
	});

	it("writes a fractional TTL as whole milliseconds, and whole seconds on indexes", async () => {
		const fake = createFakeRedis();
		const driver = new RedisDriver(fake.client);
		await driver.setWithTags("k", 1, ["t"], 1.0004);
		const setCall = fake.calls.find((c) => c.op === "set");
		expect(setCall?.args.slice(2)).toEqual(["PX", 1001]);
		const expires = fake.calls.filter((c) => c.op === "expire");
		expect(expires.map((c) => c.args[1])).toEqual([2, 2]);
	});

	it("set without TTL omits EX argument", async () => {
		const fake = createFakeRedis();
		const driver = new RedisDriver(fake.client);
		await driver.set("k", "x");
		const setCall = fake.calls.find((c) => c.op === "set");
		expect(setCall?.args).toHaveLength(2);
	});

	it("get returns null when the key is missing", async () => {
		const fake = createFakeRedis();
		const driver = new RedisDriver(fake.client);
		expect(await driver.get("missing")).toBe(null);
	});

	it("delete returns true when something was removed, false otherwise", async () => {
		const fake = createFakeRedis();
		const driver = new RedisDriver(fake.client);
		await driver.set("k", "v");
		expect(await driver.delete("k")).toBe(true);
		expect(await driver.delete("k")).toBe(false);
	});

	it("has returns true/false based on EXISTS", async () => {
		const fake = createFakeRedis();
		const driver = new RedisDriver(fake.client);
		expect(await driver.has("nope")).toBe(false);
		await driver.set("present", 1);
		expect(await driver.has("present")).toBe(true);
	});
});

describe("echo > RedisDriver > flush", () => {
	it("scans and deletes all keys with the configured prefix", async () => {
		const fake = createFakeRedis({ withScan: true });
		const driver = new RedisDriver(fake.client);
		await driver.set("a", 1);
		await driver.set("b", 2);
		await driver.flush();
		expect(fake.store.size).toBe(0);
	});

	it("loops across multiple SCAN pages until cursor returns to '0'", async () => {
		const fake = createFakeRedis({ withScan: true, scanPages: 3 });
		const driver = new RedisDriver(fake.client);
		for (let i = 0; i < 9; i++) await driver.set(`k${i}`, i);
		await driver.flush();
		expect(fake.store.size).toBe(0);
	});

	// A real ioredis client reads `this` inside scan(); calling a detached
	// reference threw and left every key in place.
	it("calls scan() as a method, so a client that reads `this` works", async () => {
		const fake = createFakeRedis({ withScan: true });
		const inner = fake.client;
		class ThisBoundClient implements RedisClient {
			readonly #inner = inner;
			get = (key: string) => this.#inner.get(key);
			set = (key: string, value: string, ...args: unknown[]) =>
				this.#inner.set(key, value, ...args);
			del = (...keys: string[]) => this.#inner.del(...keys);
			exists = (key: string) => this.#inner.exists(key);
			keys = (pattern: string) => this.#inner.keys(pattern);
			sadd = (key: string, ...members: string[]) =>
				this.#inner.sadd(key, ...members);
			srem = (key: string, ...members: string[]) =>
				this.#inner.srem(key, ...members);
			smembers = (key: string) => this.#inner.smembers(key);
			expire = (key: string, seconds: number) =>
				this.#inner.expire(key, seconds);
			ttl = (key: string) => this.#inner.ttl(key);
			scan(
				cursor: string,
				matchOption: "MATCH",
				pattern: string,
				countOption: "COUNT",
				count: number,
			): Promise<[string, string[]]> {
				const scan = this.#inner.scan;
				if (scan === undefined) throw new Error("fake without scan");
				return scan(cursor, matchOption, pattern, countOption, count);
			}
		}
		const driver = new RedisDriver(new ThisBoundClient());
		await driver.set("a", 1);
		await driver.set("b", 2);
		await driver.flush();
		expect(fake.store.size).toBe(0);
	});

	it("throws when the client does not implement scan() (KEYS is unsafe)", async () => {
		const fake = createFakeRedis(); // no scan
		const driver = new RedisDriver(fake.client);
		await expect(driver.flush()).rejects.toThrow(/scan\(\) support/);
	});
});

describe("echo > RedisDriver > tagging", () => {
	it("setWithTags records keys under tag-set keys via SADD", async () => {
		const fake = createFakeRedis();
		const driver = new RedisDriver(fake.client);
		await driver.setWithTags("article:42", { title: "x" }, ["news", "fr"]);
		expect(fake.sets.get("cache:t:news")?.has("article:42")).toBe(true);
		expect(fake.sets.get("cache:t:fr")?.has("article:42")).toBe(true);
	});

	it("setWithTags + TTL extends the tag-set TTL when shorter", async () => {
		const fake = createFakeRedis();
		const driver = new RedisDriver(fake.client);
		await driver.setWithTags("k", "v", ["t1"], 60);
		const expireCalls = fake.calls.filter((c) => c.op === "expire");
		expect(expireCalls.length).toBeGreaterThan(0);
	});

	it("flushTags deletes all tagged members and the tag set itself", async () => {
		const fake = createFakeRedis();
		const driver = new RedisDriver(fake.client);
		await driver.setWithTags("a", 1, ["news"]);
		await driver.setWithTags("b", 2, ["news"]);
		await driver.flushTags(["news"]);

		expect(fake.store.size).toBe(0);
		expect(fake.sets.has("cache:t:news")).toBe(false);
	});

	// Audit 2026-06-13: a plain set() over a tagged key never touched the tag/meta
	// keys, so a later flushTags wrongly purged the fresh (untagged) value.
	it("plain set() over a tagged key drops it from old tag sets (no wrong-purge)", async () => {
		const fake = createFakeRedis();
		const driver = new RedisDriver(fake.client);
		await driver.setWithTags("k", "v1", ["news"]);
		await driver.set("k", "v2"); // overwrite, now untagged
		await driver.flushTags(["news"]);
		expect(await driver.get("k")).toBe("v2");
	});

	it("flushTags is a no-op when the tag has no members", async () => {
		const fake = createFakeRedis();
		const driver = new RedisDriver(fake.client);
		// Pre-populate an unrelated key to assert the no-op leaves the store
		// untouched (not just "promise resolves"). Per DNR `feedback_no_filler_tests`.
		fake.store.set("cache:other", '"unrelated"');
		await driver.flushTags(["unknown"]);
		expect(fake.store.size).toBe(1);
		expect(fake.store.has("cache:other")).toBe(true);
		expect(fake.sets.size).toBe(0);
	});

	it("retagging a key cleans stale membership in the OLD tag-set (no silent re-invalidation)", async () => {
		const fake = createFakeRedis();
		const driver = new RedisDriver(fake.client);
		await driver.setWithTags("article:42", { v: 1 }, ["news"]);
		expect(fake.sets.get("cache:t:news")?.has("article:42")).toBe(true);
		// Re-tag the same key under a different group.
		await driver.setWithTags("article:42", { v: 2 }, ["homepage"]);
		// Old tag-set must no longer reference the key.
		expect(fake.sets.get("cache:t:news")?.has("article:42") ?? false).toBe(
			false,
		);
		expect(fake.sets.get("cache:t:homepage")?.has("article:42")).toBe(true);
		// Crucial assertion: flushing the OLD tag must NOT wipe the current value.
		await driver.flushTags(["news"]);
		expect(await driver.get("article:42")).toEqual({ v: 2 });
	});

	it("delete(key) removes the key from every tag-set it belonged to", async () => {
		const fake = createFakeRedis();
		const driver = new RedisDriver(fake.client);
		await driver.setWithTags("article:42", { v: 1 }, ["news", "fr"]);
		expect(await driver.delete("article:42")).toBe(true);
		// Both tag-sets must be cleaned — otherwise a later flushTags(['news'])
		// would no-op-delete a non-existent key (or, worse, delete a future
		// key reusing the slot).
		expect(fake.sets.get("cache:t:news")?.has("article:42") ?? false).toBe(
			false,
		);
		expect(fake.sets.get("cache:t:fr")?.has("article:42") ?? false).toBe(false);
		// Reverse-index gone too.
		expect(fake.sets.has("cache:m:article:42")).toBe(false);
	});

	it("flushTags on ONE tag of a multi-tagged key cleans the key out of the OTHER tag-set too", async () => {
		const fake = createFakeRedis();
		const driver = new RedisDriver(fake.client);
		await driver.setWithTags("article:42", { v: 1 }, ["news", "homepage"]);
		await driver.flushTags(["news"]);
		// Value gone, both tag-sets cleaned (no dangling reference in homepage).
		expect(await driver.get("article:42")).toBe(null);
		expect(fake.sets.has("cache:t:news")).toBe(false);
		expect(fake.sets.get("cache:t:homepage")?.has("article:42") ?? false).toBe(
			false,
		);
	});
});

describe("echo > RedisDriver > empty prefix (bug 300)", () => {
	// An empty prefix made clear() scan `MATCH *` and delete every key in the
	// database: sessions, queue jobs, other applications.
	it("falls back to the default prefix, so clear() cannot wipe the database", async () => {
		const fake = createFakeRedis({ withScan: true });
		fake.store.set("session:abc", "x");
		fake.store.set("bull:queue:1", "job");
		const driver = new RedisDriver(fake.client, "");
		await driver.set("k", 1);

		await driver.flush();

		expect([...fake.store.keys()].sort()).toEqual([
			"bull:queue:1",
			"session:abc",
		]);
	});

	it("writes under the default prefix", async () => {
		const fake = createFakeRedis();
		const driver = new RedisDriver(fake.client, "");
		await driver.set("k", 1);
		expect([...fake.store.keys()]).toEqual(["cache:v:k"]);
	});

	it("drivers.redis({ prefix: '' }) resolves to the default prefix", async () => {
		const fake = createFakeRedis();
		const driver = drivers.redis({ client: fake.client, prefix: "" })();
		await driver.set("k", 1);
		expect([...fake.store.keys()]).toEqual(["cache:v:k"]);
	});
});

describe("echo > RedisDriver > a value it did not write (bug 328)", () => {
	// A non-JSON value under the prefix — another app, a manual SET, a torn
	// write — made every read of the key throw, and getOrSet could never
	// repair it because it reads before computing.
	it("reads a non-JSON value as a miss", async () => {
		const fake = createFakeRedis();
		fake.store.set("cache:v:legacy", "plain text");
		const driver = new RedisDriver(fake.client);

		expect(await driver.get("legacy")).toBeNull();
		expect(await driver.getEntry("legacy")).toBeNull();
	});

	it("lets getOrSet compute and replace it", async () => {
		const fake = createFakeRedis();
		fake.store.set("cache:v:legacy", "plain text");
		const cache = new CacheManager(new RedisDriver(fake.client));

		expect(
			await cache.getOrSet({ key: "legacy", factory: () => "fresh" }),
		).toBe("fresh");
		expect(await cache.get({ key: "legacy" })).toBe("fresh");
	});
});

describe("echo > RedisDriver > custom prefix", () => {
	it("respects a custom prefix on read/write operations", async () => {
		const fake = createFakeRedis();
		const driver = new RedisDriver(fake.client, "myapp:");
		await driver.set("session:1", { uid: 1 });
		expect(fake.store.has("myapp:v:session:1")).toBe(true);
		expect(await driver.get("session:1")).toEqual({ uid: 1 });
	});
});
