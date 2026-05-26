import { beforeEach, describe, expect, it } from "vitest";
import { CacheManager } from "../../src/CacheManager.js";
import { MemoryDriver } from "../../src/drivers/MemoryDriver.js";

describe("cache > MemoryDriver", () => {
	let cache: CacheManager;

	beforeEach(() => {
		cache = new CacheManager(new MemoryDriver());
	});

	it("stores and retrieves a value", async () => {
		await cache.set("key", "value");
		expect(await cache.get("key")).toBe("value");
	});

	it("returns null on cache miss", async () => {
		expect(await cache.get("absent")).toBeNull();
	});

	it("respects TTL", async () => {
		await cache.set("expiring", "x", 0.05); // 50 ms
		expect(await cache.get("expiring")).toBe("x");
		await new Promise((r) => setTimeout(r, 80));
		expect(await cache.get("expiring")).toBeNull();
	});

	it("delete returns true if entry existed", async () => {
		await cache.set("k", 1);
		expect(await cache.delete("k")).toBe(true);
		expect(await cache.delete("k")).toBe(false);
	});

	it("flush clears everything", async () => {
		await cache.set("a", 1);
		await cache.set("b", 2);
		await cache.flush();
		expect(await cache.get("a")).toBeNull();
		expect(await cache.get("b")).toBeNull();
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
		expect(await cache.remember("memo", 60, factory)).toBe("computed");
		expect(await cache.remember("memo", 60, factory)).toBe("computed");
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
			cache.remember("flight", 60, slow),
			cache.remember("flight", 60, slow),
			cache.remember("flight", 60, slow),
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
});
