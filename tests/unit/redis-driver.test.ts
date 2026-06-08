import { describe, expect, it } from "vitest";
import {
	type RedisClient,
	RedisDriver,
} from "../../src/drivers/RedisDriver.js";

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
		async del(key) {
			calls.push({ op: "del", args: [key] });
			const keys = Array.isArray(key) ? key : [key];
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
		client.scan = async (cursor) => {
			calls.push({ op: "scan", args: [cursor] });
			if (snapshot === null) {
				snapshot = [...store.keys()].filter((k) => k.startsWith("cache:"));
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
		expect(fake.store.get("cache:user:1")).toBe('{"name":"Alice"}');
		expect(await driver.get<{ name: string }>("user:1")).toEqual({
			name: "Alice",
		});
	});

	it("set with TTL passes EX <seconds> to the client", async () => {
		const fake = createFakeRedis();
		const driver = new RedisDriver(fake.client);
		await driver.set("k", { v: 1 }, 60);
		const setCall = fake.calls.find((c) => c.op === "set");
		expect(setCall?.args.slice(2)).toEqual(["EX", 60]);
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
		expect(fake.sets.get("cache:tag:news")?.has("cache:article:42")).toBe(true);
		expect(fake.sets.get("cache:tag:fr")?.has("cache:article:42")).toBe(true);
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
		expect(fake.sets.has("cache:tag:news")).toBe(false);
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
		expect(fake.sets.get("cache:tag:news")?.has("cache:article:42")).toBe(true);
		// Re-tag the same key under a different group.
		await driver.setWithTags("article:42", { v: 2 }, ["homepage"]);
		// Old tag-set must no longer reference the key.
		expect(
			fake.sets.get("cache:tag:news")?.has("cache:article:42") ?? false,
		).toBe(false);
		expect(fake.sets.get("cache:tag:homepage")?.has("cache:article:42")).toBe(
			true,
		);
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
		expect(
			fake.sets.get("cache:tag:news")?.has("cache:article:42") ?? false,
		).toBe(false);
		expect(
			fake.sets.get("cache:tag:fr")?.has("cache:article:42") ?? false,
		).toBe(false);
		// Reverse-index gone too.
		expect(fake.sets.has("cache:meta:tags:article:42")).toBe(false);
	});

	it("flushTags on ONE tag of a multi-tagged key cleans the key out of the OTHER tag-set too", async () => {
		const fake = createFakeRedis();
		const driver = new RedisDriver(fake.client);
		await driver.setWithTags("article:42", { v: 1 }, ["news", "homepage"]);
		await driver.flushTags(["news"]);
		// Value gone, both tag-sets cleaned (no dangling reference in homepage).
		expect(await driver.get("article:42")).toBe(null);
		expect(fake.sets.has("cache:tag:news")).toBe(false);
		expect(
			fake.sets.get("cache:tag:homepage")?.has("cache:article:42") ?? false,
		).toBe(false);
	});
});

describe("echo > RedisDriver > custom prefix", () => {
	it("respects a custom prefix on read/write operations", async () => {
		const fake = createFakeRedis();
		const driver = new RedisDriver(fake.client, "myapp:");
		await driver.set("session:1", { uid: 1 });
		expect(fake.store.has("myapp:session:1")).toBe(true);
		expect(await driver.get("session:1")).toEqual({ uid: 1 });
	});
});
