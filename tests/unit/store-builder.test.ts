import { describe, expect, it } from "vitest";
import {
	CacheStoreManager,
	drivers,
	MemoryDriver,
	store,
} from "../../src/index.js";

/**
 * `store()` — a store described a layer at a time, the shape a cache config
 * takes. Echo only accepted `{ driver }`, which said nothing about which layer
 * a driver was, and made a tiered store a driver call rather than a layering.
 */
describe("echo > store builder", () => {
	it("one layer is that driver", () => {
		const entry = store().useL1Layer(drivers.memory()).entry();
		expect(entry.driver()).toBeInstanceOf(MemoryDriver);
	});

	it("carries the common options through", () => {
		const entry = store({ ttl: 60, prefix: "app" })
			.useL1Layer(drivers.memory())
			.entry();

		expect(entry.ttl).toBe(60);
		expect(entry.prefix).toBe("app");
	});

	it("two layers are a tiered driver over both", async () => {
		const entry = store()
			.useL1Layer(drivers.memory())
			.useL2Layer(drivers.memory())
			.entry();

		// The layering is the point: a read hits L1, a miss falls to L2, and a
		// write reaches both.
		const driver = entry.driver();
		await driver.set("k", { v: 1, e: Date.now() + 60_000 }, 60);
		expect(await driver.get("k")).toBeDefined();
	});

	it("refuses a store with no layer", () => {
		expect(() => store().entry()).toThrow(/needs a layer/);
	});

	it("refuses a bus with a single layer", () => {
		// A bus keeps each instance's L1 in step after a write; with one layer
		// there is nothing to keep in step, and silently ignoring it would hide a
		// cache that never invalidates across instances.
		expect(() =>
			store()
				.useL1Layer(drivers.memory())
				.useBus({ publish: async () => {}, subscribe: () => {} })
				.entry(),
		).toThrow(/two layers/);
	});

	it("is accepted by the manager beside the plain form", async () => {
		const cache = new CacheStoreManager({
			default: "built",
			stores: {
				built: store({ prefix: "b" }).useL1Layer(drivers.memory()),
				plain: { driver: drivers.memory(), prefix: "p" },
			},
		});

		await cache.use().set({ key: "k", value: 1 });
		expect(await cache.use().get({ key: "k" })).toBe(1);
		await cache.use("plain").set({ key: "k", value: 2 });
		expect(await cache.use("plain").get({ key: "k" })).toBe(2);
	});
});
