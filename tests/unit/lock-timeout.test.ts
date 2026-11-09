/**
 * `lockTimeout` bounds how long a caller waits on another caller's factory —
 * with or without a stale value to fall back on.
 *
 * It was only read on the stale-while-revalidate path, so on a cold key every
 * joiner waited for as long as the first factory took: forever, behind one
 * that hung.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../src/CacheManager.js";
import { MemoryDriver } from "../../src/drivers/MemoryDriver.js";

const created: MemoryDriver[] = [];
function cache(): CacheManager {
	const driver = new MemoryDriver();
	created.push(driver);
	return new CacheManager(driver);
}

afterEach(() => {
	for (const driver of created.splice(0)) driver.destroy();
});

const never = (): Promise<never> => new Promise<never>(() => {});

describe("echo > lockTimeout without a stale value (bug 324)", () => {
	it("a joiner rejects with a coded error once the lock timeout passes", async () => {
		const c = cache();
		void c.getOrSet({ key: "lk", factory: never }).catch(() => {});
		const started = Date.now();

		await expect(
			c.getOrSet({ key: "lk", factory: async () => 2, lockTimeout: 0.05 }),
		).rejects.toThrow(expect.objectContaining({ code: "E_ECHO_LOCK_TIMEOUT" }));
		const waited = Date.now() - started;
		expect(waited).toBeGreaterThanOrEqual(40);
		expect(waited).toBeLessThan(1000);
	});

	it("a joiner still gets the leader's value when it lands in time", async () => {
		const c = cache();
		const leader = c.getOrSet({
			key: "lk",
			factory: () => new Promise((resolve) => setTimeout(() => resolve(1), 10)),
		});
		const factory = vi.fn(async () => 2);

		const joined = await c.getOrSet({ key: "lk", factory, lockTimeout: 1 });

		expect(joined).toBe(1);
		expect(await leader).toBe(1);
		expect(factory).not.toHaveBeenCalled();
	});

	it("the leader is not bound by it", async () => {
		const c = cache();
		const value = await c.getOrSet({
			key: "lk",
			factory: () => new Promise((resolve) => setTimeout(() => resolve(1), 60)),
			lockTimeout: 0.01,
		});
		expect(value).toBe(1);
	});

	it("a store-wide lockTimeout applies to the joiner too", async () => {
		const driver = new MemoryDriver();
		created.push(driver);
		const c = new CacheManager(driver, { lockTimeout: "50ms" });
		void c.getOrSet({ key: "lk", factory: never }).catch(() => {});

		await expect(
			c.getOrSet({ key: "lk", factory: async () => 2 }),
		).rejects.toThrow(expect.objectContaining({ code: "E_ECHO_LOCK_TIMEOUT" }));
	});

	it("a shorter hardTimeout still wins for a joiner", async () => {
		const c = cache();
		void c.getOrSet({ key: "lk", factory: never }).catch(() => {});

		await expect(
			c.getOrSet({
				key: "lk",
				factory: async () => 2,
				lockTimeout: 5,
				hardTimeout: 0.03,
			}),
		).rejects.toThrow(expect.objectContaining({ name: "TimeoutError" }));
	});
});

describe("echo > lockTimeout with a stale value", () => {
	it("a joiner returns the stale value once the lock timeout passes", async () => {
		const c = cache();
		await c.set({ key: "lk", value: "stale", ttl: 0.01, grace: "1m" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		void c
			.getOrSet({ key: "lk", factory: never, grace: "1m", timeout: 10 })
			.catch(() => {});

		const value = await c.getOrSet({
			key: "lk",
			factory: async () => "fresh",
			grace: "1m",
			timeout: 10,
			lockTimeout: 0.03,
		});

		expect(value).toBe("stale");
	});
});
