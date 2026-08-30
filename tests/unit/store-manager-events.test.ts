/**
 * The multi-store manager's event surface and lifecycle.
 *
 * A listener registered on the manager has to reach a store built AFTER it was
 * registered — otherwise an app that subscribes at boot hears nothing from the
 * stores it resolves later, which looks exactly like a cache that never emits.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { RedisDriver } from "../../src/drivers/RedisDriver.js";
import { CacheStoreManager, drivers } from "../../src/StoreManager.js";

const managers: CacheStoreManager[] = [];
const make = () => {
	const manager = new CacheStoreManager({
		default: "primary",
		stores: {
			primary: { driver: drivers.memory() },
			secondary: { driver: drivers.memory(), prefix: "second" },
		},
	});
	managers.push(manager);
	return manager;
};

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.disconnectAll();
});

describe("echo > resolving a store", () => {
	it("refuses a default that is not among the stores", () => {
		// Otherwise the failure lands on the first cache call, in a request.
		expect(
			() =>
				new CacheStoreManager({
					default: "missing",
					stores: { primary: { driver: drivers.memory() } },
				}),
		).toThrow(/default store "missing" is not defined/);
	});

	it("refuses a store nobody declared", () => {
		expect(() => make().use("typo")).toThrow(/unknown cache store "typo"/);
	});

	it("builds each store once", () => {
		const manager = make();

		expect(manager.use("primary")).toBe(manager.use("primary"));
		expect(manager.use("primary")).not.toBe(manager.use("secondary"));
	});

	it("resolves the declared default with no name", () => {
		const manager = make();

		expect(manager.use()).toBe(manager.use("primary"));
	});
});

describe("echo > events across the stores", () => {
	it("reaches a store built after the listener was registered", async () => {
		const manager = make();
		const heard: unknown[] = [];
		manager.on("cache:written", (payload) => heard.push(payload));

		// Registered at boot, the store resolved later in a request.
		await manager.use("secondary").set("k", "v");

		expect(heard).toHaveLength(1);
	});

	it("reaches a store built before it, too", async () => {
		const manager = make();
		const store = manager.use("primary");
		const heard: unknown[] = [];
		manager.on("cache:written", (payload) => heard.push(payload));

		await store.set("k", "v");

		expect(heard).toHaveLength(1);
	});

	it("once fires a single time and then unhooks itself", async () => {
		const manager = make();
		const listener = vi.fn();
		manager.once("cache:written", listener);
		const store = manager.use("primary");

		await store.set("a", 1);
		await store.set("b", 2);

		expect(listener).toHaveBeenCalledOnce();
	});

	it("off drops one listener, or every listener for the event", async () => {
		const manager = make();
		const first = vi.fn();
		const second = vi.fn();
		manager.on("cache:written", first);
		manager.on("cache:written", second);
		const store = manager.use("primary");

		manager.off("cache:written", first);
		await store.set("a", 1);
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledOnce();

		manager.off("cache:written");
		await store.set("b", 2);
		expect(second).toHaveBeenCalledOnce();
	});
});

describe("echo > operations across every built store", () => {
	it("clears only the stores that were actually built", async () => {
		const manager = make();
		await manager.use("primary").set("k", "v");

		await manager.clearAll();

		expect(await manager.use("primary").get("k")).toBeNull();
	});

	it("prunes and disconnects without complaint", async () => {
		const manager = make();
		manager.use("primary");

		await expect(manager.prune()).resolves.toBeUndefined();
	});
});

describe("echo > the redis store factory", () => {
	it("takes a client that is already in hand", () => {
		const client = { get: () => {} } as unknown as Parameters<
			typeof drivers.redis
		>[0] extends { client: infer C }
			? C
			: never;

		expect(drivers.redis({ client })()).toBeInstanceOf(RedisDriver);
	});

	it("resolves a quasar connection lazily, by name", () => {
		// Building the driver must resolve nothing: a config may name a
		// connection absent from an environment that never selects this store.
		expect(drivers.redis({ connection: "sessions" })()).toBeInstanceOf(
			RedisDriver,
		);
	});
});
