/**
 * The memory driver is bounded by default, evicts the least recently USED
 * entry, and can be bounded in bytes.
 *
 * It had no ceiling unless one was asked for — a cache keyed by user input
 * grew until the process ran out of memory — and when it had one, reads
 * never refreshed recency, so the hottest key was the first to go.
 */
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDriver } from "../../src/drivers/MemoryDriver.js";
import { drivers } from "../../src/StoreManager.js";

const created: MemoryDriver[] = [];
function track(driver: MemoryDriver): MemoryDriver {
	created.push(driver);
	return driver;
}

afterEach(() => {
	for (const driver of created.splice(0)) driver.destroy();
});

async function fill(driver: MemoryDriver, count: number): Promise<void> {
	for (let i = 0; i < count; i++) await driver.set(`k${i}`, i);
}

describe("echo > memory driver default ceiling (bug 322)", () => {
	it("new MemoryDriver() holds 1000 entries, as upstream's default", async () => {
		const driver = track(new MemoryDriver());
		await fill(driver, 1001);

		expect(await driver.get("k0")).toBeNull();
		expect(await driver.get("k1")).toBe(1);
		expect(await driver.get("k1000")).toBe(1000);
	});

	it("drivers.memory() holds 1000 entries", async () => {
		const driver = drivers.memory()();
		try {
			for (let i = 0; i < 1001; i++) await driver.set(`k${i}`, i);
			expect(await driver.get("k0")).toBeNull();
			expect(await driver.get("k1000")).toBe(1000);
		} finally {
			await driver.disconnect?.();
		}
	});

	it("explicit 0 and Infinity opt out of the ceiling", async () => {
		for (const maxItems of [0, Number.POSITIVE_INFINITY]) {
			const driver = track(new MemoryDriver({ maxItems }));
			await fill(driver, 1500);
			expect(await driver.get("k0")).toBe(0);
		}
	});
});

describe("echo > memory driver evicts least recently USED (bug 322)", () => {
	it("a read entry survives eviction over an older unread one", async () => {
		const driver = track(new MemoryDriver({ maxItems: 2 }));
		await driver.set("hot", "hot");
		await driver.set("cold", "cold");
		await driver.get("hot");

		await driver.set("new", "new");

		expect(await driver.get("hot")).toBe("hot");
		expect(await driver.get("cold")).toBeNull();
		expect(await driver.get("new")).toBe("new");
	});
});

describe("echo > memory driver byte bounds (bug 322)", () => {
	it("maxEntrySize does not store an oversized value, and drops the old one", async () => {
		const driver = track(new MemoryDriver({ maxEntrySize: 16 }));
		await driver.set("k", "small");

		await driver.set("k", "x".repeat(64));

		expect(await driver.get("k")).toBeNull();
	});

	it("maxSize evicts the least recently used until the total fits", async () => {
		// Each value is a 10-character string: 12 bytes of JSON.
		const driver = track(new MemoryDriver({ maxSize: 30 }));
		await driver.set("a", "aaaaaaaaaa");
		await driver.set("b", "bbbbbbbbbb");
		await driver.get("a");

		await driver.set("c", "cccccccccc");

		expect(await driver.get("a")).toBe("aaaaaaaaaa");
		expect(await driver.get("b")).toBeNull();
		expect(await driver.get("c")).toBe("cccccccccc");
	});

	it("reads human byte sizes", async () => {
		const driver = track(new MemoryDriver({ maxEntrySize: "1kb" }));
		await driver.set("fits", "x".repeat(1000));
		await driver.set("too-big", "x".repeat(1100));

		expect(await driver.get("fits")).toBe("x".repeat(1000));
		expect(await driver.get("too-big")).toBeNull();
	});

	it("refuses a byte bound on references it cannot measure", () => {
		expect(() => new MemoryDriver({ serialize: false, maxSize: 100 })).toThrow(
			expect.objectContaining({ code: "E_ECHO_INVALID_CONFIG" }),
		);
		expect(
			() => new MemoryDriver({ serialize: false, maxEntrySize: "1mb" }),
		).toThrow(expect.objectContaining({ code: "E_ECHO_INVALID_CONFIG" }));
	});

	it("refuses a byte size it cannot read", () => {
		expect(() => new MemoryDriver({ maxSize: "lots" })).toThrow(
			expect.objectContaining({ code: "E_ECHO_INVALID_CONFIG" }),
		);
	});
});
