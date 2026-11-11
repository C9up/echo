import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../src/CacheManager.js";
import { MemoryDriver } from "../../src/drivers/MemoryDriver.js";

describe("cache > MemoryDriver", () => {
	let cache: CacheManager;

	beforeEach(() => {
		cache = new CacheManager(new MemoryDriver());
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("stores and retrieves a value", async () => {
		await cache.set("key", "value");
		expect(await cache.get("key")).toBe("value");
	});

	it("returns null on cache miss", async () => {
		expect(await cache.get("absent")).toBeUndefined();
	});

	it("respects TTL", async () => {
		// The clock is the test's: expiry is decided by Date.now(), and a real
		// sleep raced it.
		vi.useFakeTimers();
		await cache.set("expiring", "x", 0.05); // 50 ms
		vi.advanceTimersByTime(50);
		expect(await cache.get("expiring")).toBe("x");
		vi.advanceTimersByTime(1);
		expect(await cache.get("expiring")).toBeUndefined();
	});

	it("delete returns true if entry existed", async () => {
		await cache.set("k", 1);
		expect(await cache.delete("k")).toBe(true);
		expect(await cache.delete("k")).toBe(false);
	});

	it("flush clears everything", async () => {
		await cache.set("a", 1);
		await cache.set("b", 2);
		await cache.clear();
		expect(await cache.get("a")).toBeUndefined();
		expect(await cache.get("b")).toBeUndefined();
	});

	it("has() reflects presence", async () => {
		await cache.set("k", 1);
		expect(await cache.has("k")).toBe(true);
		expect(await cache.has("absent")).toBe(false);
	});

	it("applies prefix to keys", async () => {
		const prefixed = new CacheManager(new MemoryDriver(), { prefix: "app" });
		await prefixed.set("k", "v");
		// The same underlying driver, but the prefix scopes the key.
		expect(await prefixed.get("k")).toBe("v");
	});

	it("remember(): returns cached value if present, computes otherwise", async () => {
		let calls = 0;
		const factory = async () => {
			calls++;
			return "computed";
		};
		expect(await cache.getOrSet("memo", 60, factory)).toBe("computed");
		expect(await cache.getOrSet("memo", 60, factory)).toBe("computed");
		expect(calls).toBe(1);
	});

	it("remember(): single-flight on concurrent misses", async () => {
		let calls = 0;
		const slow = async () => {
			calls++;
			await new Promise((r) => setTimeout(r, 20));
			return calls;
		};
		const [a, b, c] = await Promise.all([
			cache.getOrSet("flight", 60, slow),
			cache.getOrSet("flight", 60, slow),
			cache.getOrSet("flight", 60, slow),
		]);
		expect(calls).toBe(1);
		expect(a).toBe(1);
		expect(b).toBe(1);
		expect(c).toBe(1);
	});

	it("flushTags removes only tagged entries", async () => {
		const driver = new MemoryDriver();
		const mgr = new CacheManager(driver);
		await driver.setWithTags("a", 1, ["users"]);
		await driver.setWithTags("b", 2, ["users", "posts"]);
		await driver.setWithTags("c", 3, ["posts"]);
		await mgr.flushTags(["users"]);
		expect(await driver.get("a")).toBeNull();
		expect(await driver.get("b")).toBeNull();
		expect(await driver.get("c")).toBe(3);
	});

	// Audit 2026-06-13: a plain set() over a tagged key left stale tag-index refs,
	// so a later flushTags wrongly purged the fresh (untagged) value.
	it("plain set() over a tagged key reconciles the tag index (no wrong-purge)", async () => {
		const driver = new MemoryDriver();
		await driver.setWithTags("k", 1, ["news"]);
		await driver.set("k", 2); // overwrite, now untagged
		await driver.flushTags(["news"]);
		expect(await driver.get("k")).toBe(2);
	});

	// Audit 2026-06-13: TTL expiry deleted from #store but left the entry's tag
	// refs in #tagIndex; a later set() reusing the key then got wrong-purged by
	// flushTags on the dead tag.
	it("TTL expiry scrubs the tag index (no wrong-purge after key reuse)", async () => {
		vi.useFakeTimers();
		const driver = new MemoryDriver();
		await driver.setWithTags("k", 1, ["news"], 0.05); // 50ms TTL
		vi.advanceTimersByTime(51); // let it expire
		expect(await driver.get("k")).toBeNull(); // lazy expiry must scrub the tag ref
		await driver.set("k", 2); // reuse the key, untagged
		await driver.flushTags(["news"]);
		expect(await driver.get("k")).toBe(2);
		driver.destroy();
	});
});
