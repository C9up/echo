import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../src/CacheManager.js";
import { MemoryDriver } from "../../src/drivers/MemoryDriver.js";
import { TieredDriver } from "../../src/drivers/TieredDriver.js";
import { TimeoutError } from "../../src/index.js";

/**
 * Failure-path coverage for the parity surface (grace / timeout / stampede /
 * tags / events). These exercise the branches happy-path tests skip — the exact
 * gap that let silent bugs through elsewhere in the sweep.
 */

describe("echo failure paths > grace / stale-while-revalidate", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("serves the stale value when the refresh factory throws (grace)", async () => {
		const cache = new CacheManager(new MemoryDriver());
		await cache.set({ key: "k", value: "v1", ttl: 1, grace: 60 });
		await vi.advanceTimersByTimeAsync(2000); // past ttl (stale) but within the grace window
		const out = await cache.getOrSet({
			key: "k",
			ttl: 1,
			grace: 60,
			factory: async () => {
				throw new Error("upstream down");
			},
		});
		expect(out).toBe("v1"); // stale is served, the error is NOT propagated
	});

	// Without a backoff the entry stayed stale after a failed refresh, so every
	// request for the whole grace window ran the factory against a backend
	// that was down.
	describe("graceBackoff", () => {
		const failing = () => {
			const counter = { calls: 0 };
			const factory = async (): Promise<string> => {
				counter.calls += 1;
				throw new Error("upstream down");
			};
			return { counter, factory };
		};

		async function staleCache(
			config: ConstructorParameters<typeof CacheManager>[1] = {},
		): Promise<CacheManager> {
			const cache = new CacheManager(new MemoryDriver(), config);
			await cache.set({ key: "k", value: "v1", ttl: 1, grace: 3600 });
			await vi.advanceTimersByTimeAsync(2000);
			return cache;
		}

		it("does not run a failing factory again before the backoff (default 10s)", async () => {
			const cache = await staleCache();
			const { counter, factory } = failing();
			for (let i = 0; i < 5; i++) {
				expect(
					await cache.getOrSet({ key: "k", ttl: 1, grace: 3600, factory }),
				).toBe("v1");
				// Let the background refresh settle before the next request.
				await vi.advanceTimersByTimeAsync(0);
			}
			expect(counter.calls).toBe(1);

			await vi.advanceTimersByTimeAsync(10_001);
			await cache.getOrSet({ key: "k", ttl: 1, grace: 3600, factory });
			await vi.advanceTimersByTimeAsync(0);
			expect(counter.calls).toBe(2);
		});

		it("takes the backoff from the store config and from the call", async () => {
			const cache = await staleCache({ graceBackoff: "1m" });
			const { counter, factory } = failing();
			await cache.getOrSet({ key: "k", ttl: 1, grace: 3600, factory });
			await vi.advanceTimersByTimeAsync(30_000);
			await cache.getOrSet({ key: "k", ttl: 1, grace: 3600, factory });
			await vi.advanceTimersByTimeAsync(0);
			expect(counter.calls).toBe(1);

			const perCall = await staleCache({ graceBackoff: "1m" });
			const second = failing();
			for (let i = 0; i < 3; i++) {
				await perCall.getOrSet({
					key: "k",
					ttl: 1,
					grace: 3600,
					graceBackoff: 0,
					factory: second.factory,
				});
				await vi.advanceTimersByTimeAsync(0);
			}
			expect(second.counter.calls).toBe(3);
		});

		it("does not bring back a value invalidated while the factory ran", async () => {
			const cache = await staleCache();
			let release: (reason: Error) => void = () => {};
			const factory = (): Promise<string> =>
				new Promise<string>((_resolve, reject) => {
					release = reject;
				});
			const served = cache.getOrSet({ key: "k", ttl: 1, grace: 3600, factory });
			// The soft timeout (0) is a timer: let it fire so the stale value is
			// served while the factory is still running.
			await vi.advanceTimersByTimeAsync(0);
			expect(await served).toBe("v1");
			await cache.delete("k");
			release(new Error("upstream down"));
			await vi.advanceTimersByTimeAsync(0);

			expect(await cache.get({ key: "k", grace: 3600 })).toBeUndefined();
		});

		it("refuses a negative backoff", async () => {
			const cache = await staleCache();
			await expect(
				cache.getOrSet({
					key: "k",
					graceBackoff: -1,
					factory: () => "v",
				}),
			).rejects.toMatchObject({ code: "E_ECHO_INVALID_DURATION" });
		});
	});
});

describe("echo failure paths > factory error without grace", () => {
	it("rethrows when the factory fails and there is no stale value", async () => {
		const cache = new CacheManager(new MemoryDriver());
		await expect(
			cache.getOrSet({
				key: "k",
				ttl: 60,
				factory: async () => {
					throw new Error("boom");
				},
			}),
		).rejects.toThrow("boom");
	});

	it("runs the factory again after it threw synchronously", async () => {
		const cache = new CacheManager(new MemoryDriver());
		let calls = 0;
		// Not async: the throw happens inside the call itself, before any
		// promise exists, as a guard or a JSON.parse at the top of a factory does.
		const factory = (): number => {
			calls += 1;
			if (calls === 1) throw new Error("sync boom");
			return 42;
		};
		await expect(cache.getOrSet({ key: "k", factory })).rejects.toThrow(
			"sync boom",
		);
		expect(await cache.getOrSet({ key: "k", factory })).toBe(42);
		expect(await cache.getOrSet({ key: "k", factory })).toBe(42);
		expect(calls).toBe(2);
	});

	it("refuses an object-form call whose factory is not a function", async () => {
		const cache = new CacheManager(new MemoryDriver());
		const call = (): Promise<unknown> =>
			Reflect.apply(cache.getOrSet, cache, [{ key: "k", factory: 42 }]);
		await expect(call()).rejects.toMatchObject({
			code: "E_ECHO_INVALID_ARGUMENT",
		});
		// And the refusal leaves nothing behind for the key.
		expect(await cache.getOrSet({ key: "k", factory: () => "v" })).toBe("v");
	});
});

describe("echo failure paths > single-flight (stampede)", () => {
	it("runs the factory once under concurrent getOrSet", async () => {
		const cache = new CacheManager(new MemoryDriver());
		let calls = 0;
		const factory = async (): Promise<string> => {
			calls += 1;
			await new Promise((r) => setTimeout(r, 5));
			return "v";
		};
		const results = await Promise.all([
			cache.getOrSet({ key: "k", ttl: 60, factory }),
			cache.getOrSet({ key: "k", ttl: 60, factory }),
			cache.getOrSet({ key: "k", ttl: 60, factory }),
		]);
		expect(results).toEqual(["v", "v", "v"]);
		expect(calls).toBe(1);
	});
});

describe("echo failure paths > hard timeout", () => {
	it("throws TimeoutError when the factory exceeds the hard timeout", async () => {
		const cache = new CacheManager(new MemoryDriver());
		await expect(
			cache.getOrSet({
				key: "k",
				ttl: 60,
				hardTimeout: 0.05, // Duration is in seconds → 50ms
				factory: () => new Promise<string>(() => {}), // never resolves
			}),
		).rejects.toBeInstanceOf(TimeoutError);
	});
});

describe("echo failure paths > deleteByTag", () => {
	it("removes only entries carrying the tag", async () => {
		const cache = new CacheManager(new MemoryDriver());
		await cache.set({ key: "a", value: 1, ttl: 60, tags: ["users"] });
		await cache.set({ key: "b", value: 2, ttl: 60, tags: ["users"] });
		await cache.set({ key: "c", value: 3, ttl: 60, tags: ["posts"] });
		await cache.deleteByTag(["users"]);
		expect(await cache.get("a")).toBeUndefined();
		expect(await cache.get("b")).toBeUndefined();
		expect(await cache.get("c")).toBe(3);
	});
});

describe("echo failure paths > events", () => {
	it("emits miss / written / hit / deleted", async () => {
		const events: string[] = [];
		const cache = new CacheManager(new MemoryDriver(), {
			emitter: { emit: (event) => events.push(event) },
		});
		await cache.get("k"); // miss
		await cache.getOrSet({ key: "k", ttl: 60, factory: async () => "v" }); // written
		await cache.get("k"); // hit
		await cache.delete("k"); // deleted
		expect(events).toContain("cache:miss");
		expect(events).toContain("cache:written");
		expect(events).toContain("cache:hit");
		expect(events).toContain("cache:deleted");
	});
});

describe("echo failure paths > TieredDriver L1/L2", () => {
	it("promotes an L2 hit into L1 on read-through", async () => {
		const l1 = new MemoryDriver();
		const l2 = new MemoryDriver();
		await l2.set("k", "fromL2", 60);
		const tiered = new TieredDriver({ l1, l2 });
		expect(await tiered.get("k")).toBe("fromL2");
		// Promotion: the value now lives in L1 too.
		expect(await l1.get("k")).toBe("fromL2");
	});

	it("returns null when both tiers miss", async () => {
		const tiered = new TieredDriver({
			l1: new MemoryDriver(),
			l2: new MemoryDriver(),
		});
		expect(await tiered.get("absent")).toBeNull();
	});

	it("preserves the L2 TTL on promotion — no immortal L1 copy", async () => {
		vi.useFakeTimers();
		try {
			const l1 = new MemoryDriver();
			const l2 = new MemoryDriver();
			await l2.set("k", "v", 0.05); // 50ms TTL
			const tiered = new TieredDriver({ l1, l2 });
			expect(await tiered.get("k")).toBe("v"); // promotes into L1

			// L1 must carry a finite expiry — before the fix it was 0 (immortal).
			const promoted = await l1.getEntry("k");
			expect(promoted?.expiresAt).toBeGreaterThan(0);

			// Past the TTL, neither tier serves it (before: L1 served it forever).
			await vi.advanceTimersByTimeAsync(60);
			expect(await tiered.get("k")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("echo failure paths > expire() immediate staleness", () => {
	it("marks the key stale at once (no brief fresh window)", async () => {
		const driver = new MemoryDriver();
		const cache = new CacheManager(driver, { grace: 60 });
		await cache.set({ key: "k", value: "old", ttl: 60 });
		expect(await cache.expire("k")).toBe(true);
		// Retained under grace, but a fresh read is a miss IMMEDIATELY — before the
		// fix the ttl:0.001 rewrite kept it fresh for ~1ms (getOrSet served "old"
		// and never ran the factory).
		const entry = await driver.getEntry("k");
		expect(entry?.stale).toBe(true);
		expect(await driver.get("k")).toBeNull();
	});
});

describe("echo failure paths > an Adonis-shaped emitter", () => {
	it("reports a rejecting listener instead of ending the process", async () => {
		// `@adonisjs/events`' emit is `async` and rethrows when a listener throws
		// and the application registered no error handler. Nobody awaits a cache
		// event, so that rejection had nowhere to go — the interface said `void`,
		// which accepts a promise-returning function, so nothing looked wrong.
		const written: string[] = [];
		const originalWrite = process.stderr.write.bind(process.stderr);
		const rejections: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			rejections.push(reason);
		};
		process.stderr.write = (chunk: string | Uint8Array): boolean => {
			written.push(String(chunk));
			return true;
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const cache = new CacheManager(new MemoryDriver(), {
				emitter: {
					emit: async () => {
						throw new Error("listener failed");
					},
				},
			});

			// The cache call itself must still succeed: a metrics listener is an
			// observer, not a participant.
			await cache.set("k", "v", 60);
			expect(await cache.get("k")).toBe("v");
			await new Promise((resolve) => setTimeout(resolve, 15));

			expect(rejections).toEqual([]);
			expect(written.join("")).toContain("listener failed");
		} finally {
			process.stderr.write = originalWrite;
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
