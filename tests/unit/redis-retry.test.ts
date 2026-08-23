/**
 * The lazily-resolved Redis client cached its in-flight promise but cleared it
 * only on success. A transient failure at startup therefore left the REJECTED
 * promise cached forever: every later call replayed the same failure, with no
 * new error to explain why the process never recovered.
 */
import { describe, expect, it, vi } from "vitest";
import { RedisDriver } from "../../src/drivers/RedisDriver.js";

const fakeClient = () =>
	({
		get: async () => null,
		set: async () => "OK",
		del: async () => 1,
		exists: async () => 0,
		keys: async () => [],
		flushdb: async () => "OK",
	}) as never;

describe("echo > redis client resolution", () => {
	it("retries after a transient failure instead of failing forever", async () => {
		let attempt = 0;
		const resolver = vi.fn(async () => {
			attempt++;
			if (attempt === 1) throw new Error("ECONNREFUSED");
			return fakeClient();
		});
		const driver = new RedisDriver(resolver);

		await expect(driver.get("k")).rejects.toThrow("ECONNREFUSED");
		// The outage is over; the next call must try again.
		await expect(driver.get("k")).resolves.toBeNull();
		expect(resolver).toHaveBeenCalledTimes(2);
	});

	it("still resolves the client once when it succeeds", async () => {
		const resolver = vi.fn(async () => fakeClient());
		const driver = new RedisDriver(resolver);
		await Promise.all([driver.get("a"), driver.get("b"), driver.get("c")]);
		expect(resolver).toHaveBeenCalledTimes(1);
	});
});
