/**
 * Every failure echo raises carries a code an application can match on
 * (bug 331): upstream's identifiers verbatim where upstream has one,
 * `E_ECHO_*` for the rest.
 */
import { afterEach, describe, expect, it } from "vitest";
import { type CacheDriver, CacheManager } from "../../src/CacheManager.js";
import { MemoryDriver } from "../../src/drivers/MemoryDriver.js";
import {
	type RedisClient,
	RedisDriver,
} from "../../src/drivers/RedisDriver.js";
import { TieredDriver } from "../../src/drivers/TieredDriver.js";
import {
	EchoError,
	errors,
	FactoryError,
	L2CacheError,
	TimeoutError,
	UndefinedValueError,
} from "../../src/errors.js";
import { CacheStoreManager, drivers, store } from "../../src/StoreManager.js";

const created: MemoryDriver[] = [];
function memory(): MemoryDriver {
	const driver = new MemoryDriver();
	created.push(driver);
	return driver;
}

afterEach(() => {
	for (const driver of created.splice(0)) driver.destroy();
});

const code = (value: string) => expect.objectContaining({ code: value });

/** A driver with the five core methods and no tags. */
function plain(): CacheDriver {
	const map = new Map<string, unknown>();
	return {
		async get() {
			return null;
		},
		async set(key, value) {
			map.set(key, value);
		},
		async delete(key) {
			return map.delete(key);
		},
		async flush() {
			map.clear();
		},
		async has(key) {
			return map.has(key);
		},
	};
}

describe("echo > upstream error codes", () => {
	it("a hard timeout is E_FACTORY_HARD_TIMEOUT", async () => {
		const cache = new CacheManager(memory());
		const failure = await cache
			.getOrSet({
				key: "k",
				factory: () => new Promise((resolve) => setTimeout(resolve, 200)),
				hardTimeout: "10ms",
			})
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(TimeoutError);
		expect(failure).toBeInstanceOf(EchoError);
		expect(failure).toMatchObject({ code: "E_FACTORY_HARD_TIMEOUT" });
	});

	it("a factory failure is E_FACTORY_ERROR", async () => {
		const cache = new CacheManager(memory());
		const seen: FactoryError[] = [];
		await cache
			.getOrSet({
				key: "k",
				factory: () => {
					throw new Error("db down");
				},
				onFactoryError: (error) => seen.push(error),
			})
			.catch(() => {});

		expect(seen[0]).toMatchObject({ code: "E_FACTORY_ERROR", key: "k" });
	});

	it("caching null is E_UNDEFINED_VALUE, still a TypeError", async () => {
		const cache = new CacheManager(memory());
		const failure = await cache
			.set({ key: "k", value: null })
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(UndefinedValueError);
		expect(failure).toBeInstanceOf(TypeError);
		expect(failure).toMatchObject({ code: "E_UNDEFINED_VALUE" });
		await expect(memory().set("k", undefined)).rejects.toThrow(
			code("E_UNDEFINED_VALUE"),
		);
	});

	it("exports the map upstream exports", () => {
		expect(errors.E_FACTORY_ERROR).toBe(FactoryError);
		expect(errors.E_FACTORY_HARD_TIMEOUT).toBe(TimeoutError);
		expect(errors.E_UNDEFINED_VALUE).toBe(UndefinedValueError);
		expect(errors.E_L2_CACHE_ERROR).toBe(L2CacheError);
	});
});

describe("echo > echo's own error codes", () => {
	it("an unknown store is E_ECHO_UNKNOWN_STORE", () => {
		const manager = new CacheStoreManager({
			default: "a",
			stores: { a: { driver: drivers.memory() } },
		});
		expect(() => manager.use("nope")).toThrow(code("E_ECHO_UNKNOWN_STORE"));
		expect(
			() => new CacheStoreManager({ default: "missing", stores: {} }),
		).toThrow(code("E_ECHO_UNKNOWN_STORE"));
		expect(() => new CacheManager(memory()).use("other")).toThrow(
			code("E_ECHO_UNKNOWN_STORE"),
		);
	});

	it("a store name only resolves to an own declared store, never to Object.prototype (bug 526)", () => {
		const manager = new CacheStoreManager({
			default: "a",
			stores: { a: { driver: drivers.memory() } },
		});
		for (const name of [
			"toString",
			"constructor",
			"__proto__",
			"hasOwnProperty",
			"valueOf",
		]) {
			expect(() => manager.use(name)).toThrow(code("E_ECHO_UNKNOWN_STORE"));
			expect(
				() =>
					new CacheStoreManager({
						default: name,
						stores: { a: { driver: drivers.memory() } },
					}),
			).toThrow(code("E_ECHO_UNKNOWN_STORE"));
		}
	});

	it("tags on a driver without them is E_ECHO_NOT_TAGGABLE", async () => {
		const cache = new CacheManager(plain());
		await expect(cache.deleteByTag(["t"])).rejects.toThrow(
			code("E_ECHO_NOT_TAGGABLE"),
		);
		await expect(
			cache.set({ key: "k", value: 1, tags: ["t"] }),
		).rejects.toThrow(code("E_ECHO_NOT_TAGGABLE"));
		await expect(
			new TieredDriver({ l1: plain(), l2: memory() }).deleteByTag(["t"]),
		).rejects.toThrow(code("E_ECHO_NOT_TAGGABLE"));
	});

	it("getOrSet without a factory is E_ECHO_INVALID_ARGUMENT", async () => {
		const cache = new CacheManager(memory());
		await expect(
			Reflect.apply(cache.getOrSet, cache, ["k", 60]),
		).rejects.toThrow(code("E_ECHO_INVALID_ARGUMENT"));
	});

	it("a store description that cannot work is E_ECHO_INVALID_CONFIG", () => {
		expect(() => store().entry()).toThrow(code("E_ECHO_INVALID_CONFIG"));
		expect(() =>
			store()
				.useL1Layer(drivers.memory())
				.useBus({ publish: () => {}, subscribe: () => {} })
				.entry(),
		).toThrow(code("E_ECHO_INVALID_CONFIG"));
	});

	it("a value JSON cannot carry is E_ECHO_UNSERIALIZABLE_VALUE", async () => {
		await expect(memory().set("k", () => 1)).rejects.toThrow(
			code("E_ECHO_UNSERIALIZABLE_VALUE"),
		);
	});

	it("clearing Redis without SCAN is E_ECHO_SCAN_UNSUPPORTED", async () => {
		const client: RedisClient = {
			get: async () => null,
			set: async () => "OK",
			del: async () => 0,
			exists: async () => 0,
			keys: async () => [],
			sadd: async () => 0,
			srem: async () => 0,
			smembers: async () => [],
			expire: async () => 1,
			ttl: async () => -1,
		};
		await expect(new RedisDriver(client).flush()).rejects.toThrow(
			code("E_ECHO_SCAN_UNSUPPORTED"),
		);
	});
});
