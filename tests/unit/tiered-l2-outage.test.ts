/**
 * A tiered store keeps serving through an L2 outage.
 *
 * Every L1 miss used to become an exception while Redis was unreachable: the
 * L2 read was awaited unguarded, so getOrSet never reached its factory, and
 * every write rethrew. Upstream suppresses L2 errors when an L1 exists and
 * can open a circuit breaker; so does this now — for reads and writes.
 * Invalidations still report a failed L2: see the last block.
 */
import { afterEach, describe, expect, it } from "vitest";
import { CacheManager } from "../../src/CacheManager.js";
import { MemoryDriver } from "../../src/drivers/MemoryDriver.js";
import {
	type BusMessage,
	TieredDriver,
} from "../../src/drivers/TieredDriver.js";
import { store } from "../../src/StoreManager.js";
import type { CacheDriver, TaggableDriver } from "../../src/types.js";

const created: MemoryDriver[] = [];
function memory(): MemoryDriver {
	const driver = new MemoryDriver();
	created.push(driver);
	return driver;
}

afterEach(() => {
	for (const driver of created.splice(0)) driver.destroy();
});

/** An L2 whose every command fails, counting the attempts. */
function downL2(): { driver: CacheDriver; calls: () => number } {
	let calls = 0;
	const fail = async (): Promise<never> => {
		calls++;
		throw new Error("Stream isn't writeable");
	};
	return {
		driver: {
			get: fail,
			set: fail,
			delete: fail,
			flush: fail,
			has: fail,
			getEntry: fail,
			setEntry: fail,
		},
		calls: () => calls,
	};
}

const l2Error = expect.objectContaining({ code: "E_L2_CACHE_ERROR" });

describe("echo > tiered store with its L2 down (bug 325)", () => {
	it("serves reads, writes and getOrSet from L1 and the factory", async () => {
		const l1 = memory();
		const cache = new CacheManager(
			new TieredDriver({ l1, l2: downL2().driver }),
		);

		await cache.set({ key: "k", value: 1 });
		expect(await cache.get({ key: "k" })).toBe(1);
		expect(await cache.get({ key: "miss" })).toBeUndefined();
		expect(await cache.getOrSet({ key: "g", factory: () => "computed" })).toBe(
			"computed",
		);
		expect(await l1.get("g")).toBe("computed");
	});

	it("publishes nothing for a write the L2 never took", async () => {
		const seen: BusMessage[] = [];
		const tiered = new TieredDriver({
			l1: memory(),
			l2: downL2().driver,
			bus: {
				publish: (message) => {
					seen.push(message);
				},
				subscribe: () => {},
			},
		});
		await tiered.connect();

		await tiered.set("k", 1, 60);

		expect(seen).toEqual([]);
	});

	it("surfaces a coded error carrying the cause with suppressL2Errors: false", async () => {
		const cache = new CacheManager(
			new TieredDriver({
				l1: memory(),
				l2: downL2().driver,
				suppressL2Errors: false,
			}),
		);

		await expect(cache.get({ key: "miss" })).rejects.toThrow(l2Error);
		await expect(cache.set({ key: "k", value: 1 })).rejects.toThrow(l2Error);
		const failure = await cache.get({ key: "miss" }).catch((e: unknown) => e);
		expect(failure).toBeInstanceOf(Error);
		expect(failure instanceof Error ? failure.cause : undefined).toEqual(
			new Error("Stream isn't writeable"),
		);
	});

	it("a circuit breaker skips the L2 for its duration", async () => {
		const l2 = downL2();
		const cache = new CacheManager(
			new TieredDriver({
				l1: memory(),
				l2: l2.driver,
				l2CircuitBreakerDuration: "1m",
			}),
		);

		await cache.get({ key: "a" });
		const afterFirst = l2.calls();
		await cache.get({ key: "b" });
		await cache.set({ key: "c", value: 1 });
		await cache.getOrSet({ key: "d", factory: () => 1 });

		expect(afterFirst).toBe(1);
		expect(l2.calls()).toBe(1);
	});

	it("the breaker closes again once its duration has passed", async () => {
		const l2 = downL2();
		const cache = new CacheManager(
			new TieredDriver({
				l1: memory(),
				l2: l2.driver,
				l2CircuitBreakerDuration: "20ms",
			}),
		);

		await cache.get({ key: "a" });
		await new Promise((resolve) => setTimeout(resolve, 40));
		await cache.get({ key: "b" });

		expect(l2.calls()).toBe(2);
	});
});

describe("echo > tiered invalidations with the L2 down (bug 325)", () => {
	// NAMED DEVIATION (safer than upstream): a delete that did not reach the
	// shared tier left the value there for every other instance, and the
	// caller revoking it must be told. Its own L1 copy is still dropped.
	it("delete reports the failed L2 and still drops the local copy", async () => {
		const l1 = memory();
		await l1.set("k", "v");
		const tiered = new TieredDriver({ l1, l2: downL2().driver });

		await expect(tiered.delete("k")).rejects.toThrow(l2Error);

		expect(await l1.get("k")).toBeNull();
	});

	it("flush and deleteByTag report it too, even with the breaker open", async () => {
		const l1 = memory();
		const down = downL2();
		const l2: TaggableDriver = {
			...down.driver,
			setWithTags: () => Promise.reject(new Error("down")),
			deleteByTag: () => Promise.reject(new Error("down")),
			flushTags: () => Promise.reject(new Error("down")),
		};
		const tiered = new TieredDriver({
			l1,
			l2,
			l2CircuitBreakerDuration: "1m",
		});
		await tiered.get("open-the-breaker");

		await expect(tiered.flush()).rejects.toThrow(l2Error);
		await expect(tiered.deleteByTag(["t"])).rejects.toThrow(l2Error);
	});
});

describe("echo > L2 options through the store builder (bug 325)", () => {
	it("store({ suppressL2Errors: false }) reaches the tiered driver", async () => {
		const down = downL2();
		const entry = store({ suppressL2Errors: false })
			.useL1Layer(() => memory())
			.useL2Layer(() => down.driver)
			.entry();
		const cache = new CacheManager(entry.driver());

		await expect(cache.get({ key: "k" })).rejects.toThrow(l2Error);
	});

	it("store({ l2CircuitBreakerDuration }) reaches the tiered driver", async () => {
		const down = downL2();
		const entry = store({ l2CircuitBreakerDuration: "1m" })
			.useL1Layer(() => memory())
			.useL2Layer(() => down.driver)
			.entry();
		const cache = new CacheManager(entry.driver());

		await cache.get({ key: "a" });
		await cache.get({ key: "b" });

		expect(down.calls()).toBe(1);
	});
});
