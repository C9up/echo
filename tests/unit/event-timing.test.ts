/**
 * What a profiler reads off the cache events, beyond upstream's fields.
 *
 * Upstream's payloads say what happened to which key in which store, and
 * nothing of how long it took or how long a written entry lives — the two
 * figures a debug toolbar shows first. Every event now carries `duration`,
 * timed from the call, and a write its `ttl`.
 */

import { describe, expect, it } from "vitest";
import { CacheManager } from "../../src/CacheManager.js";
import { MemoryDriver } from "../../src/drivers/MemoryDriver.js";
import type { CacheEventMap } from "../../src/types.js";

type Seen = { name: keyof CacheEventMap; payload: Record<string, unknown> };

const NAMES: Array<keyof CacheEventMap> = [
	"cache:hit",
	"cache:miss",
	"cache:written",
	"cache:deleted",
	"cache:cleared",
	"cache:expire",
];

function recorded(cache: CacheManager): Seen[] {
	const seen: Seen[] = [];
	for (const name of NAMES) {
		cache.on(name, (payload) => seen.push({ name, payload: { ...payload } }));
	}
	return seen;
}

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("echo > the time and lifetime the events carry", () => {
	it("times every operation, whichever event reports it", async () => {
		const cache = new CacheManager(new MemoryDriver());
		const seen = recorded(cache);

		await cache.get("a");
		await cache.set("a", 1);
		await cache.get("a");
		await cache.getOrSet({ key: "b", factory: () => 2 });
		await cache.delete("a");
		await cache.deleteMany(["b"]);
		await cache.set("c", 3);
		await cache.expire("c");
		await cache.clear();

		expect(seen.map((event) => event.name)).toEqual([
			"cache:miss",
			"cache:written",
			"cache:hit",
			"cache:written",
			"cache:miss",
			"cache:deleted",
			"cache:deleted",
			"cache:written",
			"cache:expire",
			"cache:cleared",
		]);
		for (const { name, payload } of seen) {
			expect({ name, duration: payload.duration }).toEqual({
				name,
				duration: expect.any(Number),
			});
			expect(payload.duration).toBeGreaterThanOrEqual(0);
		}
	});

	it("counts a getOrSet's factory in its miss only, not in its write nor the hit after it", async () => {
		const cache = new CacheManager(new MemoryDriver());
		const seen = recorded(cache);

		const compute = async () => {
			await sleep(30);
			return 42;
		};
		await cache.getOrSet({ key: "slow", factory: compute });
		await cache.getOrSet({ key: "slow", factory: compute });

		const miss = seen.find((event) => event.name === "cache:miss");
		const write = seen.find((event) => event.name === "cache:written");
		const hit = seen.find((event) => event.name === "cache:hit");
		expect(Number(miss?.payload.duration)).toBeGreaterThanOrEqual(25);
		// Summed, the two would count the factory twice.
		expect(Number(write?.payload.duration)).toBeLessThan(25);
		expect(Number(hit?.payload.duration)).toBeLessThan(25);
	});

	it("reports how long a written entry lives, and null for one that never expires", async () => {
		const cache = new CacheManager(new MemoryDriver(), { ttl: 60 });
		const seen = recorded(cache);

		await cache.set({ key: "explicit", value: 1, ttl: "5m" });
		await cache.set("default", 1);
		await cache.setForever({ key: "forever", value: 1 });
		await cache.getOrSet({ key: "computed", ttl: 90, factory: () => 1 });
		await cache.getOrSetForever({ key: "computed-forever", factory: () => 1 });

		const ttls = seen
			.filter((event) => event.name === "cache:written")
			.map((event) => [event.payload.key, event.payload.ttl]);
		expect(ttls).toEqual([
			["explicit", 300],
			["default", 60],
			["forever", null],
			["computed", 90],
			["computed-forever", null],
		]);
	});
});
