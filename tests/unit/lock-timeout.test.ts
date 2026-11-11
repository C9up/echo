/**
 * `lockTimeout` bounds how long a caller waits on another caller's factory —
 * with or without a stale value to fall back on.
 *
 * It was only read on the stale-while-revalidate path, so on a cold key every
 * joiner waited for as long as the first factory took: forever, behind one
 * that hung.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../src/CacheManager.js";
import { MemoryDriver } from "../../src/drivers/MemoryDriver.js";

const created: MemoryDriver[] = [];
function cache(
	config?: ConstructorParameters<typeof CacheManager>[1],
): CacheManager {
	const driver = new MemoryDriver();
	created.push(driver);
	return new CacheManager(driver, config);
}

// The waits below are the behaviour under test, so the clock is the test's: a
// real one made "at least 40 ms for a 50 ms timeout" one scheduler hiccup wide.
beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	for (const driver of created.splice(0)) driver.destroy();
	vi.useRealTimers();
});

const never = (): Promise<never> => new Promise<never>(() => {});

/** Where a promise stands, readable at any point without awaiting it. */
function track<T>(
	promise: Promise<T>,
): () => { state: string; value?: unknown } {
	let outcome: { state: string; value?: unknown } = { state: "pending" };
	promise.then(
		(value) => {
			outcome = { state: "resolved", value };
		},
		(error: unknown) => {
			outcome = { state: "rejected", value: error };
		},
	);
	return () => outcome;
}

/** Advance the fake clock by `ms`, letting every promise it unblocks settle. */
async function elapse(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
	await vi.advanceTimersByTimeAsync(ms);
}

describe("echo > lockTimeout without a stale value (bug 324)", () => {
	it("a joiner rejects with a coded error once the lock timeout passes", async () => {
		const c = cache();
		void c.getOrSet({ key: "lk", factory: never }).catch(() => {});
		const joiner = track(
			c.getOrSet({ key: "lk", factory: async () => 2, lockTimeout: 0.05 }),
		);

		await elapse(49);
		expect(joiner().state).toBe("pending");
		await elapse(1);
		expect(joiner()).toMatchObject({
			state: "rejected",
			value: { code: "E_ECHO_LOCK_TIMEOUT" },
		});
	});

	it("a joiner still gets the leader's value when it lands in time", async () => {
		const c = cache();
		const leader = track(
			c.getOrSet({
				key: "lk",
				factory: () =>
					new Promise((resolve) => setTimeout(() => resolve(1), 10)),
			}),
		);
		const factory = vi.fn(async () => 2);
		const joined = track(c.getOrSet({ key: "lk", factory, lockTimeout: 1 }));

		await elapse(10);

		expect(joined()).toEqual({ state: "resolved", value: 1 });
		expect(leader()).toEqual({ state: "resolved", value: 1 });
		expect(factory).not.toHaveBeenCalled();
	});

	it("the leader is not bound by it", async () => {
		const c = cache();
		const leader = track(
			c.getOrSet({
				key: "lk",
				factory: () =>
					new Promise((resolve) => setTimeout(() => resolve(1), 60)),
				lockTimeout: 0.01,
			}),
		);

		await elapse(59);
		expect(leader().state).toBe("pending");
		await elapse(1);
		expect(leader()).toEqual({ state: "resolved", value: 1 });
	});

	it("a store-wide lockTimeout applies to the joiner too", async () => {
		const c = cache({ lockTimeout: "50ms" });
		void c.getOrSet({ key: "lk", factory: never }).catch(() => {});
		const joiner = track(c.getOrSet({ key: "lk", factory: async () => 2 }));

		await elapse(49);
		expect(joiner().state).toBe("pending");
		await elapse(1);
		expect(joiner()).toMatchObject({
			state: "rejected",
			value: { code: "E_ECHO_LOCK_TIMEOUT" },
		});
	});

	it("a shorter hardTimeout still wins for a joiner", async () => {
		const c = cache();
		void c.getOrSet({ key: "lk", factory: never }).catch(() => {});
		const joiner = track(
			c.getOrSet({
				key: "lk",
				factory: async () => 2,
				lockTimeout: 5,
				hardTimeout: 0.03,
			}),
		);

		await elapse(30);
		expect(joiner()).toMatchObject({
			state: "rejected",
			value: { name: "TimeoutError" },
		});
	});
});

describe("echo > lockTimeout with a stale value", () => {
	it("a joiner returns the stale value once the lock timeout passes", async () => {
		const c = cache();
		await c.set({ key: "lk", value: "stale", ttl: 0.01, grace: "1m" });
		vi.advanceTimersByTime(20);
		void c
			.getOrSet({ key: "lk", factory: never, grace: "1m", timeout: 10 })
			.catch(() => {});
		const joiner = track(
			c.getOrSet({
				key: "lk",
				factory: async () => "fresh",
				grace: "1m",
				timeout: 10,
				lockTimeout: 0.03,
			}),
		);

		await elapse(29);
		expect(joiner().state).toBe("pending");
		await elapse(1);
		expect(joiner()).toEqual({ state: "resolved", value: "stale" });
	});
});
