/**
 * The lazily-resolved Redis client cached its in-flight promise but cleared it
 * only on success. A transient failure at startup therefore left the REJECTED
 * promise cached forever: every later call replayed the same failure, with no
 * new error to explain why the process never recovered.
 */
import { describe, expect, it, vi } from "vitest";
import {
	type RedisClient,
	RedisDriver,
} from "../../src/drivers/RedisDriver.js";

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

/**
 * Quasar retires a connection whose retry strategy gave up (about three
 * seconds of outage with the generated config) and hands out a fresh one. A
 * driver that kept the first one turned a Redis blip into a permanent cache
 * outage: "Connection is closed." on every call until restart.
 */
describe("echo > a Redis connection that ended for good", () => {
	function liveClient(status: string) {
		return {
			status,
			get: vi.fn(async (): Promise<string | null> => null),
			set: vi.fn(async (): Promise<unknown> => "OK"),
			del: vi.fn(async () => 1),
			exists: vi.fn(async () => 0),
			keys: vi.fn(async (): Promise<string[]> => []),
			sadd: vi.fn(async () => 1),
			srem: vi.fn(async () => 1),
			smembers: vi.fn(async (): Promise<string[]> => []),
			expire: vi.fn(async () => 1),
			persist: vi.fn(async () => 1),
			ttl: vi.fn(async () => -1),
		};
	}

	it("is resolved again on the next call", async () => {
		const first = liveClient("ready");
		const second = liveClient("ready");
		const resolver = vi
			.fn<() => RedisClient>()
			.mockReturnValueOnce(first)
			.mockReturnValueOnce(second);
		const driver = new RedisDriver(resolver);

		await driver.get("k");
		first.status = "end";
		await driver.get("k");
		await driver.get("k");

		expect(resolver).toHaveBeenCalledTimes(2);
		expect(first.get).toHaveBeenCalledOnce();
		expect(second.get).toHaveBeenCalledTimes(2);
	});

	it("keeps a client that closed but reconnects, and one handed in directly", async () => {
		const resolved = liveClient("ready");
		const resolver = vi.fn(() => resolved);
		const driver = new RedisDriver(resolver);
		await driver.get("k");
		resolved.status = "close";
		await driver.get("k");
		expect(resolver).toHaveBeenCalledOnce();

		const direct = liveClient("end");
		await new RedisDriver(direct).get("k");
		expect(direct.get).toHaveBeenCalledOnce();
	});
});
