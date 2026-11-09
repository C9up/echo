/**
 * `RedisDriver` and `CacheManager` on a RAW ioredis client against a live
 * Redis — the client `drivers.redis({ client })` advertises as compatible.
 *
 * Quasar pre-binds every command, which hid a driver that called a detached
 * method; the unit fakes never read `this`. This file talks to ioredis
 * directly (reached through quasar's `ioConnection`, since echo does not
 * depend on ioredis) so what passes here is what an application gets.
 *
 * Gated on `REDIS_TEST_URL`; skipped when no server answers.
 */
import { QuasarManager } from "@c9up/quasar";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CacheManager } from "../../src/CacheManager.js";
import { MemoryDriver } from "../../src/drivers/MemoryDriver.js";
import {
	type RedisClient,
	RedisDriver,
} from "../../src/drivers/RedisDriver.js";
import { TieredDriver } from "../../src/drivers/TieredDriver.js";

const url = process.env.REDIS_TEST_URL ?? "";

async function serverAnswers(): Promise<boolean> {
	const probe = new QuasarManager({
		connection: "probe" as const,
		connections: {
			probe: { url, lazyConnect: true, maxRetriesPerRequest: 1 },
		},
	});
	try {
		await probe.connection().ping();
		return true;
	} catch {
		return false;
	} finally {
		await probe.disconnect("probe");
	}
}

const live = url ? await serverAnswers() : false;
const describeRedis = live ? describe : describe.skip;

describeRedis("echo on a raw ioredis client", () => {
	const manager = new QuasarManager({
		connection: "main" as const,
		connections: { main: { url } },
	});
	const raw = manager.connection().ioConnection;
	// The raw client, typed through the driver's own contract: ioredis
	// satisfies it structurally, which is the claim under test.
	const client: RedisClient = raw;
	const base = `echo-raw:${process.pid}:`;

	// Scoped to this run's prefix, never FLUSHDB: the URL may point at a
	// server other things use.
	async function cleanup(): Promise<void> {
		const keys = await raw.keys(`${base}*`);
		if (keys.length > 0) await raw.del(...keys);
	}

	beforeEach(cleanup);

	afterAll(async () => {
		await cleanup();
		await manager.quit("main");
	});

	describe("clear() (bug 296)", () => {
		it("empties the store on a raw client instead of throwing", async () => {
			const cache = new CacheManager(new RedisDriver(client, base));
			await cache.set({ key: "x", value: 1 });
			await cache.set({ key: "y", value: 2 });

			await cache.clear();

			expect(await raw.keys(`${base}*`)).toEqual([]);
		});

		it("clears only the namespace that asked", async () => {
			const root = new CacheManager(new RedisDriver(client, base));
			await root.namespace("a").set({ key: "k", value: "a" });
			await root.namespace("b").set({ key: "k", value: "b" });

			await root.namespace("a").clear();

			expect(await root.namespace("a").get({ key: "k" })).toBeUndefined();
			expect(await root.namespace("b").get({ key: "k" })).toBe("b");
		});
	});

	describe("bookkeeping keys a cache key cannot reach (bug 314)", () => {
		// Tag sets and reverse indexes lived in the data keyspace: a cache key
		// `tag:<t>` overwrote a tag SET with a string, and every invalidation
		// of the entries it indexed failed with WRONGTYPE.
		it("a key named like a tag set does not block deleteByTag", async () => {
			const cache = new CacheManager(new RedisDriver(client, base));
			await cache.set({ key: "perm:7", value: "admin", tags: ["user:7"] });
			await cache.set({ key: "tag:user:7", value: "x" });

			await cache.deleteByTag({ tags: ["user:7"] });

			expect(await cache.get({ key: "perm:7" })).toBeUndefined();
			expect(await cache.get({ key: "tag:user:7" })).toBe("x");
		});

		it("a key named like a reverse index does not block delete()", async () => {
			const root = new CacheManager(new RedisDriver(client, base));
			const acl = root.namespace("acl");
			await acl.set({ key: "role:9", value: "admin", tags: ["user:9"] });
			await root.set({ key: "meta:tags:acl:role:9", value: "x" });

			await acl.delete({ key: "role:9" });

			expect(await acl.get({ key: "role:9" })).toBeUndefined();
		});

		it("a key named like a reverse index does not block set()", async () => {
			const root = new CacheManager(new RedisDriver(client, base));
			await root.set({ key: "meta:tags:k", value: "x" });

			await root.set({ key: "k", value: "v", tags: ["t"] });
			await root.set({ key: "k", value: "v2" });

			expect(await root.get({ key: "k" })).toBe("v2");
			expect(await root.get({ key: "meta:tags:k" })).toBe("x");
		});

		it("a namespace clear leaves none of that namespace's bookkeeping behind", async () => {
			const root = new CacheManager(new RedisDriver(client, base));
			await root
				.namespace("tenantA")
				.set({ key: "doc", value: 1, tags: ["t"] });
			await root
				.namespace("tenantB")
				.set({ key: "doc2", value: 2, ttl: null, tags: ["t"] });

			await root.namespace("tenantB").clear();

			const left = await raw.keys(`${base}*`);
			expect(left.some((key) => key.includes("tenantB"))).toBe(false);
			expect(await root.namespace("tenantA").get({ key: "doc" })).toBe(1);
			// tenantA's entry is still reachable by its tag.
			await root.namespace("tenantA").deleteByTag({ tags: ["t"] });
			expect(await root.namespace("tenantA").get({ key: "doc" })).toBe(
				undefined,
			);
		});
	});

	describe("tags scoped to their namespace (bug 306)", () => {
		it("deleteByTag in one namespace leaves another namespace's entries", async () => {
			const root = new CacheManager(new RedisDriver(client, base));
			const a = root.namespace("tenantA");
			const b = root.namespace("tenantB");
			await a.set({ key: "doc", value: "A", tags: ["user:1"] });
			await b.set({ key: "doc", value: "B", tags: ["user:1"] });

			await a.deleteByTag({ tags: ["user:1"] });

			expect(await a.get({ key: "doc" })).toBeUndefined();
			expect(await b.get({ key: "doc" })).toBe("B");
		});
	});

	describe("tiered promotion from a Redis L2 keeps tags (bug 311)", () => {
		it("deleteByTag on the promoting instance drops its own L1 copy", async () => {
			const l1A = new MemoryDriver();
			const l1B = new MemoryDriver();
			const a = new CacheManager(
				new TieredDriver({ l1: l1A, l2: new RedisDriver(client, base) }),
			);
			const b = new CacheManager(
				new TieredDriver({ l1: l1B, l2: new RedisDriver(client, base) }),
			);
			try {
				await a.set({ key: "perm:42", value: "can-delete", tags: ["user:42"] });
				expect(await b.get({ key: "perm:42" })).toBe("can-delete");

				await b.deleteByTag({ tags: ["user:42"] });

				expect(await b.get({ key: "perm:42" })).toBeUndefined();
			} finally {
				l1A.destroy();
				l1B.destroy();
			}
		});
	});

	describe("namespace clear() with glob characters (bug 303)", () => {
		// SCAN MATCH is a glob: an unescaped `tenant-*` matched every tenant.
		const cases: Array<{ cleared: string; siblings: string[] }> = [
			{ cleared: "tenant-*", siblings: ["tenant-abc", "tenant-xyz"] },
			{ cleared: "a?c", siblings: ["abc", "axc"] },
			{ cleared: "[ab]", siblings: ["a", "b"] },
			{ cleared: "a\\", siblings: ["a", "a\\b"] },
			{ cleared: "x[", siblings: ["x", "x[y"] },
		];

		for (const { cleared, siblings } of cases) {
			it(`clearing "${cleared}" leaves ${siblings.join(", ")} intact`, async () => {
				const root = new CacheManager(new RedisDriver(client, base));
				for (const ns of siblings) {
					await root.namespace(ns).set({ key: "doc", value: ns });
				}
				await root.namespace(cleared).set({ key: "doc", value: "mine" });

				await root.namespace(cleared).clear();

				expect(await root.namespace(cleared).get({ key: "doc" })).toBe(
					undefined,
				);
				for (const ns of siblings) {
					expect(await root.namespace(ns).get({ key: "doc" })).toBe(ns);
				}
			});
		}

		it("escapes a driver prefix carrying glob characters", async () => {
			const mine = new CacheManager(new RedisDriver(client, `${base}app*:`));
			const other = new CacheManager(new RedisDriver(client, `${base}app1:`));
			await mine.set({ key: "k", value: "mine" });
			await other.set({ key: "k", value: "other" });

			await mine.clear();

			expect(await mine.get({ key: "k" })).toBeUndefined();
			expect(await other.get({ key: "k" })).toBe("other");
		});
	});
});
