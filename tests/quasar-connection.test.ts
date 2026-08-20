import { describe, expect, it, vi } from "vitest";
import { RedisDriver } from "../src/drivers/RedisDriver.js";

/** A client carrying exactly the commands the driver issues. */
function fakeClient() {
	const store = new Map<string, string>();
	return {
		opened: 0,
		get: vi.fn(async (key: string) => store.get(key) ?? null),
		set: vi.fn(async (key: string, value: string) => {
			store.set(key, value);
			return "OK";
		}),
		del: vi.fn(async () => 1),
		exists: vi.fn(async () => 0),
		keys: vi.fn(async () => []),
		sadd: vi.fn(async () => 1),
		srem: vi.fn(async () => 1),
		smembers: vi.fn(async () => []),
		expire: vi.fn(async () => 1),
		ttl: vi.fn(async () => -1),
	};
}

describe("RedisDriver with a resolver", () => {
	it("does not resolve the client until a command needs it", async () => {
		let resolved = 0;
		const client = fakeClient();
		const driver = new RedisDriver(() => {
			resolved += 1;
			return client;
		});

		// Building the store must not open anything: a memory-only app that
		// merely declares a redis store should never dial.
		expect(resolved).toBe(0);

		await driver.set("k", "v", 30);
		expect(resolved).toBe(1);
	});

	it("resolves once, even when commands race on a cold store", async () => {
		let resolved = 0;
		const client = fakeClient();
		const driver = new RedisDriver(async () => {
			resolved += 1;
			await new Promise((r) => setTimeout(r, 20));
			return client;
		});

		await Promise.all([driver.get("a"), driver.get("b"), driver.get("c")]);
		expect(resolved).toBe(1);
	});

	it("still accepts a client directly", async () => {
		const client = fakeClient();
		const driver = new RedisDriver(client);
		await driver.set("k", "v", 30);
		expect(client.set).toHaveBeenCalled();
	});

	it("surfaces a resolver failure instead of swallowing it", async () => {
		const driver = new RedisDriver(() => {
			throw new Error("@c9up/quasar is not installed");
		});
		await expect(driver.get("k")).rejects.toThrow(/quasar is not installed/);
	});
});
