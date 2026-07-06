import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../src/CacheManager.js";
import { MemoryDriver } from "../../src/drivers/MemoryDriver.js";
import { TieredDriver } from "../../src/drivers/TieredDriver.js";
import { TimeoutError } from "../../src/index.js";

/**
 * Failure-path coverage for the parity surface (grace / timeout / stampede /
 * tags / events). These exercise the branches happy-path tests skip — the exact
 * gap that let silent bugs through elsewhere in the sweep.
 */

describe("echo failure paths > grace / stale-while-revalidate", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("serves the stale value when the refresh factory throws (grace)", async () => {
		const cache = new CacheManager(new MemoryDriver());
		await cache.set({ key: "k", value: "v1", ttl: 1, grace: 60 });
		await vi.advanceTimersByTimeAsync(2000); // past ttl (stale) but within the grace window
		const out = await cache.getOrSet({
			key: "k",
			ttl: 1,
			grace: 60,
			factory: async () => {
				throw new Error("upstream down");
			},
		});
		expect(out).toBe("v1"); // stale is served, the error is NOT propagated
	});
});

describe("echo failure paths > factory error without grace", () => {
	it("rethrows when the factory fails and there is no stale value", async () => {
		const cache = new CacheManager(new MemoryDriver());
		await expect(
			cache.getOrSet({
				key: "k",
				ttl: 60,
				factory: async () => {
					throw new Error("boom");
				},
			}),
		).rejects.toThrow("boom");
	});
});

describe("echo failure paths > single-flight (stampede)", () => {
	it("runs the factory once under concurrent getOrSet", async () => {
		const cache = new CacheManager(new MemoryDriver());
		let calls = 0;
		const factory = async (): Promise<string> => {
			calls += 1;
			await new Promise((r) => setTimeout(r, 5));
			return "v";
		};
		const results = await Promise.all([
			cache.getOrSet({ key: "k", ttl: 60, factory }),
			cache.getOrSet({ key: "k", ttl: 60, factory }),
			cache.getOrSet({ key: "k", ttl: 60, factory }),
		]);
		expect(results).toEqual(["v", "v", "v"]);
		expect(calls).toBe(1);
	});
});

describe("echo failure paths > hard timeout", () => {
	it("throws TimeoutError when the factory exceeds the hard timeout", async () => {
		const cache = new CacheManager(new MemoryDriver());
		await expect(
			cache.getOrSet({
				key: "k",
				ttl: 60,
				hardTimeout: 0.05, // Duration is in seconds → 50ms
				factory: () => new Promise<string>(() => {}), // never resolves
			}),
		).rejects.toBeInstanceOf(TimeoutError);
	});
});

describe("echo failure paths > deleteByTag", () => {
	it("removes only entries carrying the tag", async () => {
		const cache = new CacheManager(new MemoryDriver());
		await cache.set({ key: "a", value: 1, ttl: 60, tags: ["users"] });
		await cache.set({ key: "b", value: 2, ttl: 60, tags: ["users"] });
		await cache.set({ key: "c", value: 3, ttl: 60, tags: ["posts"] });
		await cache.deleteByTag(["users"]);
		expect(await cache.get("a")).toBeNull();
		expect(await cache.get("b")).toBeNull();
		expect(await cache.get("c")).toBe(3);
	});
});

describe("echo failure paths > events", () => {
	it("emits miss / written / hit / deleted", async () => {
		const events: string[] = [];
		const cache = new CacheManager(new MemoryDriver(), {
			emitter: { emit: (event) => events.push(event) },
		});
		await cache.get("k"); // miss
		await cache.getOrSet({ key: "k", ttl: 60, factory: async () => "v" }); // written
		await cache.get("k"); // hit
		await cache.delete("k"); // deleted
		expect(events).toContain("cache:miss");
		expect(events).toContain("cache:written");
		expect(events).toContain("cache:hit");
		expect(events).toContain("cache:deleted");
	});
});

describe("echo failure paths > TieredDriver L1/L2", () => {
	it("promotes an L2 hit into L1 on read-through", async () => {
		const l1 = new MemoryDriver();
		const l2 = new MemoryDriver();
		await l2.set("k", "fromL2", 60);
		const tiered = new TieredDriver({ l1, l2 });
		expect(await tiered.get("k")).toBe("fromL2");
		// Promotion: the value now lives in L1 too.
		expect(await l1.get("k")).toBe("fromL2");
	});

	it("returns null when both tiers miss", async () => {
		const tiered = new TieredDriver({
			l1: new MemoryDriver(),
			l2: new MemoryDriver(),
		});
		expect(await tiered.get("absent")).toBeNull();
	});
});
