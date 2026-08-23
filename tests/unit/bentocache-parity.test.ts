/**
 * The bentocache surface a migrated app calls beyond get/set: event listeners
 * for metrics, `prune` for stores that do not evict on their own, and the
 * disconnect pair a shutdown hook needs.
 */
import { describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../src/CacheManager.js";
import { MemoryDriver } from "../../src/drivers/MemoryDriver.js";
import { CacheStoreManager, drivers } from "../../src/StoreManager.js";

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
		expect(await m.use("memory").get({ key: "k" })).toBeNull();
		expect(await m.use("other").get({ key: "k" })).toBeNull();
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
		expect(await c.get({ key: "k" })).toBeNull();
		vi.useRealTimers();
	});
});
