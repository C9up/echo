/**
 * The bentocache surface a migrated app calls beyond get/set: event listeners
 * for metrics, `prune` for stores that do not evict on their own, and the
 * disconnect pair a shutdown hook needs.
 */
import { describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../src/CacheManager.js";
import { MemoryDriver } from "../../src/drivers/MemoryDriver.js";
import { CacheStoreManager, drivers, store } from "../../src/StoreManager.js";

const cache = (): CacheManager => new CacheManager(new MemoryDriver());

describe("echo > cache events", () => {
	it("reports a miss then a write then a hit", async () => {
		const seen: string[] = [];
		const c = cache();
		c.on("cache:miss", () => seen.push("miss"));
		c.on("cache:written", () => seen.push("written"));
		c.on("cache:hit", () => seen.push("hit"));

		await c.get({ key: "k" });
		await c.set({ key: "k", value: 1 });
		await c.get({ key: "k" });
		expect(seen).toEqual(["miss", "written", "hit"]);
	});

	// getOrSet reported a write and nothing else, so a hit rate computed from
	// these events left out the main read path.
	it("getOrSet reports a miss once its factory has run, then a hit", async () => {
		const seen: string[] = [];
		const c = cache();
		c.on("cache:miss", () => seen.push("miss"));
		c.on("cache:written", () => seen.push("written"));
		c.on("cache:hit", () => seen.push("hit"));

		await c.getOrSet({ key: "k", factory: () => 1 });
		await c.getOrSet({ key: "k", factory: () => 2 });
		expect(seen).toEqual(["written", "miss", "hit"]);
	});

	it("getOrSet reports one miss for a collapsed stampede, from the caller that ran the factory", async () => {
		const misses: string[] = [];
		const c = cache();
		c.on("cache:miss", ({ key }) => misses.push(key));
		let calls = 0;
		const factory = async (): Promise<number> => {
			calls += 1;
			return 1;
		};

		await Promise.all([
			c.getOrSet({ key: "k", factory }),
			c.getOrSet({ key: "k", factory }),
			c.getOrSet({ key: "k", factory }),
		]);
		expect(calls).toBe(1);
		expect(misses).toEqual(["k"]);
	});

	it("getOrSet reports a graced hit, not a miss, when a failing factory falls back to stale", async () => {
		vi.useFakeTimers();
		try {
			const seen: Array<{ event: string; graced?: boolean }> = [];
			const c = cache();
			await c.set({ key: "k", value: "old", ttl: 1, grace: 60 });
			await vi.advanceTimersByTimeAsync(2000);
			c.on("cache:miss", () => seen.push({ event: "miss" }));
			c.on("cache:hit", ({ graced }) => seen.push({ event: "hit", graced }));

			const value = await c.getOrSet({
				key: "k",
				ttl: 1,
				grace: 60,
				// Long enough that the failure, not the timeout, decides.
				timeout: 10,
				factory: async () => {
					throw new Error("down");
				},
			});
			expect(value).toBe("old");
			expect(seen).toEqual([{ event: "hit", graced: true }]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("carries the key and the store name to the listener", async () => {
		const c = new CacheManager(new MemoryDriver(), { name: "redis" });
		const payloads: Array<{ key: string; store: string }> = [];
		c.on("cache:miss", (p) => payloads.push(p));
		await c.get({ key: "absent" });
		expect(payloads).toEqual([{ key: "absent", store: "redis" }]);
	});

	it("once fires a single time", async () => {
		const listener = vi.fn();
		const c = cache();
		c.once("cache:miss", listener);
		await c.get({ key: "a" });
		await c.get({ key: "b" });
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("off removes one listener, or all of them", async () => {
		const kept = vi.fn();
		const dropped = vi.fn();
		const c = cache();
		c.on("cache:miss", kept).on("cache:miss", dropped);
		c.off("cache:miss", dropped);
		await c.get({ key: "a" });
		expect(kept).toHaveBeenCalledTimes(1);
		expect(dropped).not.toHaveBeenCalled();

		c.off("cache:miss");
		await c.get({ key: "b" });
		expect(kept).toHaveBeenCalledTimes(1);
	});

	it("a listener that throws does not fail the cache call", async () => {
		const c = cache();
		c.on("cache:written", () => {
			throw new Error("metrics backend down");
		});
		await expect(c.set({ key: "k", value: 1 })).resolves.toBeUndefined();
		expect(await c.get({ key: "k" })).toBe(1);
	});
});

describe("echo > store manager", () => {
	const manager = (): CacheStoreManager =>
		new CacheStoreManager({
			default: "memory",
			stores: {
				memory: { driver: drivers.memory() },
				other: { driver: drivers.memory() },
			},
		});

	it("reaches stores built after the listener was registered", async () => {
		const seen: string[] = [];
		const m = manager();
		m.on("cache:miss", ({ store }) => seen.push(store));
		await m.use("memory").get({ key: "a" });
		await m.use("other").get({ key: "a" });
		expect(seen).toEqual(["memory", "other"]);
	});

	it("clears every built store", async () => {
		const m = manager();
		await m.use("memory").set({ key: "k", value: 1 });
		await m.use("other").set({ key: "k", value: 2 });
		await m.clearAll();
		expect(await m.use("memory").get({ key: "k" })).toBeUndefined();
		expect(await m.use("other").get({ key: "k" })).toBeUndefined();
	});

	// A store this process had not touched yet was skipped: a maintenance
	// script's clearAll left another process's keys in place.
	it("clears and prunes every configured store, built or not", async () => {
		vi.useFakeTimers();
		try {
			// One backing store shared by two managers, as two processes share
			// a Redis.
			const shared = new MemoryDriver();
			const config = () => ({
				default: "memory",
				stores: {
					memory: { driver: drivers.memory() },
					shared: { driver: () => shared },
				},
			});
			const writer = new CacheStoreManager(config());
			await writer.use("shared").set({ key: "k", value: 1 });
			await writer
				.use("shared")
				.set({ key: "short", value: 1, ttl: 1, tags: ["t"] });

			const maintenance = new CacheStoreManager(config());
			vi.advanceTimersByTime(2_000);
			await maintenance.prune();
			// Read through the tag index, which only a prune (not a lazy read
			// of the key) empties.
			expect(shared.tagCount()).toBe(0);
			expect(await shared.get("k")).toBe(1);

			await new CacheStoreManager(config()).clearAll();
			expect(await shared.get("k")).toBeNull();
			shared.destroy();
		} finally {
			vi.useRealTimers();
		}
	});

	it("disconnects every built store without throwing", async () => {
		const m = manager();
		m.use("memory");
		await expect(m.disconnectAll()).resolves.toBeUndefined();
	});
});

describe("echo > prune", () => {
	it("drops an expired entry without waiting for the sweep", async () => {
		vi.useFakeTimers();
		const driver = new MemoryDriver();
		const c = new CacheManager(driver, { ttl: 1 });
		await c.set({ key: "k", value: 1 });
		vi.advanceTimersByTime(5_000);
		await c.prune();
		expect(await c.get({ key: "k" })).toBeUndefined();
		vi.useRealTimers();
	});
});

describe("echo > the config shapes upstream documents", () => {
	it("takes a duration string for a store's ttl", async () => {
		// Every other timing option read a `Duration`; `ttl` was the one locked
		// to `number`, so a config copied from the documentation failed to
		// typecheck on the line most likely to be copied.
		const manager = new CacheStoreManager({
			default: "memory",
			stores: { memory: store({ ttl: "30s" }).useL1Layer(drivers.memory()) },
		});

		await manager.use().set({ key: "k", value: 1 });

		expect(await manager.use().get({ key: "k" })).toBe(1);
	});

	it("lets every store inherit a ttl declared once", async () => {
		const manager = new CacheStoreManager({
			default: "memory",
			ttl: "1ms",
			stores: { memory: store().useL1Layer(drivers.memory()) },
		});

		vi.useFakeTimers();
		try {
			await manager.use().set({ key: "k", value: 1 });
			vi.advanceTimersByTime(1);
			expect(await manager.use().get({ key: "k" })).toBe(1);
			vi.advanceTimersByTime(1);
			expect(await manager.use().get({ key: "k" })).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});
