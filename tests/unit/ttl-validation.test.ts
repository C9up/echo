/**
 * A TTL in the past means expired — never "cache it forever".
 *
 * A TTL computed from data (`(token.expiresAt - Date.now()) / 1000` for a
 * token that already expired, a parse that yields NaN) used to become an
 * immortal entry, because every non-positive value mapped to the drivers'
 * "never expires" `0`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../src/CacheManager.js";
import { MemoryDriver } from "../../src/drivers/MemoryDriver.js";
import {
	type RedisClient,
	RedisDriver,
} from "../../src/drivers/RedisDriver.js";

const drivers: MemoryDriver[] = [];
function memory(): MemoryDriver {
	const driver = new MemoryDriver();
	drivers.push(driver);
	return driver;
}

afterEach(() => {
	for (const driver of drivers.splice(0)) driver.destroy();
});

const invalid = expect.objectContaining({ code: "E_ECHO_INVALID_DURATION" });

describe("echo > a negative TTL (bug 318)", () => {
	for (const ttl of [-1, "-5m", Number.NEGATIVE_INFINITY]) {
		it(`set({ ttl: ${String(ttl)} }) stores nothing`, async () => {
			const driver = memory();
			const cache = new CacheManager(driver);
			await cache.set({ key: "k", value: 1, ttl });

			expect(await driver.getEntry("k")).toBeNull();
			expect(await cache.get({ key: "k" })).toBeUndefined();
		});
	}

	it("drops the value it replaces instead of leaving the old one served", async () => {
		const driver = memory();
		const cache = new CacheManager(driver);
		await cache.set({ key: "token", value: "old", ttl: 60 });

		await cache.set({ key: "token", value: "new", ttl: -1 });

		expect(await cache.get({ key: "token" })).toBeUndefined();
	});

	it("positional set(key, value, -1) agrees", async () => {
		const driver = memory();
		const cache = new CacheManager(driver);
		await cache.set("k", 1, -1);
		await cache.setWithTags("t", 1, ["g"], -1);

		expect(await driver.getEntry("k")).toBeNull();
		expect(await driver.getEntry("t")).toBeNull();
	});

	it("getOrSet returns the factory value without caching it", async () => {
		const cache = new CacheManager(memory());
		const factory = vi.fn(() => "computed");

		expect(await cache.getOrSet({ key: "k", ttl: -1, factory })).toBe(
			"computed",
		);
		expect(await cache.getOrSet({ key: "k", ttl: -1, factory })).toBe(
			"computed",
		);
		expect(factory).toHaveBeenCalledTimes(2);
	});

	it("keeps an already-stale copy for the grace window when grace is set", async () => {
		const driver = memory();
		const cache = new CacheManager(driver);
		await cache.set({ key: "k", value: "v", ttl: -1, grace: "1m" });

		const entry = await driver.getEntry("k");
		expect(entry?.stale).toBe(true);
		expect(entry?.expiresAt).not.toBe(0);
		expect(await cache.get({ key: "k", grace: "1m" })).toBe("v");
		expect(await cache.get({ key: "k" })).toBeUndefined();
	});

	it("null and 0 still mean never expires", async () => {
		const driver = memory();
		const cache = new CacheManager(driver);
		await cache.set({ key: "a", value: 1, ttl: null });
		await cache.set({ key: "b", value: 1, ttl: 0 });

		expect((await driver.getEntry("a"))?.expiresAt).toBe(0);
		expect((await driver.getEntry("b"))?.expiresAt).toBe(0);
	});
});

describe("echo > a NaN TTL (bug 318)", () => {
	it("is refused on every write path", async () => {
		const cache = new CacheManager(memory());
		await expect(
			cache.set({ key: "k", value: 1, ttl: Number.NaN }),
		).rejects.toThrow(invalid);
		await expect(cache.set("k", 1, Number.NaN)).rejects.toThrow(invalid);
		await expect(cache.setWithTags("k", 1, ["t"], Number.NaN)).rejects.toThrow(
			invalid,
		);
		await expect(
			cache.getOrSet({ key: "k", ttl: Number.NaN, factory: () => 1 }),
		).rejects.toThrow(invalid);
		await expect(cache.getOrSet("k", Number.NaN, () => 1)).rejects.toThrow(
			invalid,
		);
		await expect(
			cache.set({ key: "k", value: 1, grace: Number.NaN }),
		).rejects.toThrow(invalid);
	});

	it("is refused by the drivers called directly", async () => {
		const driver = memory();
		await expect(driver.set("k", 1, Number.NaN)).rejects.toThrow(invalid);
		await expect(
			driver.setEntry("k", 1, { ttlSeconds: Number.NaN }),
		).rejects.toThrow(invalid);
	});
});

describe("echo > RedisDriver with a TTL in the past (bug 318)", () => {
	function fakeClient(): { client: RedisClient; store: Map<string, string> } {
		const store = new Map<string, string>();
		const client: RedisClient = {
			async get(key) {
				return store.get(key) ?? null;
			},
			async set(key, value) {
				store.set(key, value);
				return "OK";
			},
			async del(...keys) {
				let count = 0;
				for (const key of keys) if (store.delete(key)) count++;
				return count;
			},
			async exists(key) {
				return store.has(key) ? 1 : 0;
			},
			async keys() {
				return [...store.keys()];
			},
			async sadd() {
				return 0;
			},
			async srem() {
				return 0;
			},
			async smembers() {
				return [];
			},
			async expire() {
				return 1;
			},
			async persist() {
				return 0;
			},
			async ttl() {
				return -1;
			},
		};
		return { client, store };
	}

	it("deletes rather than writing an entry with no expiry", async () => {
		const { client, store } = fakeClient();
		const driver = new RedisDriver(client);
		await driver.set("k", "old", 60);

		await driver.set("k", "new", -1);
		await driver.setEntry("e", "v", { ttlSeconds: -1 });

		expect(store.size).toBe(0);
	});

	it("refuses NaN", async () => {
		const driver = new RedisDriver(fakeClient().client);
		await expect(driver.set("k", 1, Number.NaN)).rejects.toThrow(invalid);
	});
});
