import { describe, expect, it, vi } from "vitest";
import { type CacheDriver, CacheManager } from "../../src/CacheManager.js";
import { MemoryDriver } from "../../src/drivers/MemoryDriver.js";

function plainDriver(): CacheDriver {
	const store = new Map<string, unknown>();
	return {
		async get<T>(k: string) {
			return (store.get(k) ?? null) as T | null;
		},
		async set(k, v) {
			store.set(k, v);
		},
		async delete(k) {
			return store.delete(k);
		},
		async flush() {
			store.clear();
		},
		async has(k) {
			return store.has(k);
		},
	};
}

describe("echo > CacheManager > prefix and TTL routing", () => {
	it("prepends the configured prefix on get/set/has/delete", async () => {
		const driver = plainDriver();
		const spy = vi.spyOn(driver, "set");
		const cache = new CacheManager(driver, { prefix: "users", ttl: 60 });

		await cache.set("1", { id: 1 });
		expect(spy).toHaveBeenCalledWith("users:1", { id: 1 }, 60);
	});

	it("falls back to defaultTtl when set() is called without ttl", async () => {
		const driver = plainDriver();
		const spy = vi.spyOn(driver, "set");
		const cache = new CacheManager(driver, { ttl: 120 });

		await cache.set("k", "v");
		expect(spy).toHaveBeenLastCalledWith("k", "v", 120);
	});

	it("respects an explicit per-call ttl over defaultTtl", async () => {
		const driver = plainDriver();
		const spy = vi.spyOn(driver, "set");
		const cache = new CacheManager(driver, { ttl: 120 });

		await cache.set("k", "v", 5);
		expect(spy).toHaveBeenLastCalledWith("k", "v", 5);
	});

	it("set() throws TypeError on null/undefined values (caching nothing is a bug)", async () => {
		const cache = new CacheManager(plainDriver());
		await expect(cache.set("k", null)).rejects.toBeInstanceOf(TypeError);
		await expect(cache.set("k", undefined)).rejects.toBeInstanceOf(TypeError);
	});
});

describe("echo > CacheManager > tagging support detection", () => {
	it("setWithTags throws when the driver lacks setWithTags/flushTags", async () => {
		const cache = new CacheManager(plainDriver());
		await expect(cache.setWithTags("k", 1, ["t"])).rejects.toThrow(
			/does not support tag-based invalidation/,
		);
	});

	it("flushTags throws when the driver lacks tagging support", async () => {
		const cache = new CacheManager(plainDriver());
		await expect(cache.flushTags(["t"])).rejects.toThrow(
			/does not support tag-based invalidation/,
		);
	});

	it("setWithTags rejects null/undefined values via the same TypeError as set", async () => {
		const driver = new MemoryDriver();
		try {
			const cache = new CacheManager(driver);
			await expect(cache.setWithTags("k", null, ["t"])).rejects.toBeInstanceOf(
				TypeError,
			);
		} finally {
			driver.destroy();
		}
	});

	it("setWithTags + flushTags round-trips on a taggable driver (MemoryDriver)", async () => {
		const driver = new MemoryDriver();
		try {
			const cache = new CacheManager(driver, { prefix: "p" });
			await cache.setWithTags("a", 1, ["news"]);
			await cache.setWithTags("b", 2, ["news", "fr"]);
			await cache.setWithTags("c", 3, ["fr"]);

			expect(await cache.get("a")).toBe(1);
			expect(await cache.get("b")).toBe(2);

			await cache.flushTags(["news"]);
			expect(await cache.get("a")).toBeNull();
			expect(await cache.get("b")).toBeNull();
			expect(await cache.get("c")).toBe(3); // tagged 'fr' only — preserved
		} finally {
			driver.destroy();
		}
	});

	it("flushTags scrubs multi-tagged keys from EVERY tag set, not just the flushed ones (audit 2026-05-22)", async () => {
		const driver = new MemoryDriver();
		try {
			// Cross-tagged entry: belongs to both `news` AND `fr`.
			await driver.setWithTags("p:b", 2, ["news", "fr"]);
			await driver.setWithTags("p:c", 3, ["fr"]);

			await driver.flushTags(["news"]);

			// Old bug: `p:b` was deleted from #store but #tagIndex["fr"]
			// still held a dangling reference. A subsequent `setWithTags`
			// reusing the same key with different tags would later get
			// wrongly purged when `fr` was flushed. Re-add `p:b` with a
			// DIFFERENT tag set to expose the leak:
			await driver.setWithTags("p:b", 99, ["en"]);

			// Now flush `fr` — `p:b` must NOT be touched (it's no longer
			// tagged with `fr`). With the unpatched code, `p:b` would be
			// wrongly purged because of the dangling ref in #tagIndex["fr"].
			await driver.flushTags(["fr"]);

			expect(await driver.get("p:b")).toBe(99);
			expect(await driver.get("p:c")).toBeNull(); // legitimately flushed
		} finally {
			driver.destroy();
		}
	});

	it("set() and setWithTags() agree on negative TTL — both treat <=0 as 'no expiration' (audit 2026-05-22)", async () => {
		const driver = new MemoryDriver();
		try {
			// Before the fix, `set(k, v, -5)` produced an immortal entry but
			// `setWithTags(k, v, [tag], -5)` produced an already-expired
			// entry (because the truthy check let -5 through into
			// `Date.now() + -5000`). This asymmetry made cache semantics
			// depend on whether the caller used tags or not.
			await driver.set("plain", "P", -5);
			await driver.setWithTags("tagged", "T", ["g"], -5);
			expect(await driver.get("plain")).toBe("P");
			expect(await driver.get("tagged")).toBe("T");
		} finally {
			driver.destroy();
		}
	});
});

describe("echo > CacheManager > remember (single-flight)", () => {
	it("returns the cached value on a hit without invoking the factory", async () => {
		const driver = new MemoryDriver();
		try {
			const cache = new CacheManager(driver);
			await cache.set("k", "cached");
			const factory = vi.fn(async () => "fresh");
			const value = await cache.remember("k", 60, factory);
			expect(value).toBe("cached");
			expect(factory).not.toHaveBeenCalled();
		} finally {
			driver.destroy();
		}
	});

	it("computes and stores when missing, then reads from cache on the next call", async () => {
		const driver = new MemoryDriver();
		try {
			const cache = new CacheManager(driver);
			let calls = 0;
			const factory = async () => {
				calls++;
				return `computed-${calls}`;
			};
			expect(await cache.remember("k", 60, factory)).toBe("computed-1");
			expect(await cache.remember("k", 60, factory)).toBe("computed-1");
			expect(calls).toBe(1);
		} finally {
			driver.destroy();
		}
	});

	it("collapses concurrent misses onto a single factory invocation", async () => {
		const driver = new MemoryDriver();
		try {
			const cache = new CacheManager(driver);
			let calls = 0;
			let resolveFactory: (v: string) => void = () => {};
			const factoryPromise = new Promise<string>((resolve) => {
				resolveFactory = resolve;
			});
			const factory = async () => {
				calls++;
				return factoryPromise;
			};

			const a = cache.remember("k", 60, factory);
			const b = cache.remember("k", 60, factory);
			const c = cache.remember("k", 60, factory);

			// Yield to allow the inner `await this.get(key)` to resolve so the
			// second/third callers are guaranteed to see the inflight entry.
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			resolveFactory("once");

			expect(await a).toBe("once");
			expect(await b).toBe("once");
			expect(await c).toBe("once");
			expect(calls).toBe(1);
		} finally {
			driver.destroy();
		}
	});

	it("releases the inflight slot when the factory rejects (no permanent stuck entry)", async () => {
		const driver = new MemoryDriver();
		try {
			const cache = new CacheManager(driver);
			let attempts = 0;
			const factory = async () => {
				attempts++;
				if (attempts === 1) throw new Error("transient");
				return "recovered";
			};

			await expect(cache.remember("k", 60, factory)).rejects.toThrow(
				"transient",
			);
			// Second attempt should re-invoke the factory (slot was cleaned up).
			expect(await cache.remember("k", 60, factory)).toBe("recovered");
			expect(attempts).toBe(2);
		} finally {
			driver.destroy();
		}
	});
});
