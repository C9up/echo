/**
 * The rest of the manager's public surface.
 *
 * `getOrSet` and `get`/`set` were covered; the convenience methods around them
 * were not — and each of them is one an app reaches for on its first day:
 * `pull`, `missing`, `expire`, `namespace`, the bulk delete, the tag delete.
 * A `namespace()` that forgets to carry the prefix silently mixes two tenants'
 * caches together, and nothing downstream can tell.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../src/CacheManager.js";
import { MemoryDriver } from "../../src/drivers/MemoryDriver.js";
import { TimeoutError } from "../../src/errors.js";

const drivers: MemoryDriver[] = [];
const make = (options: ConstructorParameters<typeof CacheManager>[1] = {}) => {
	const driver = new MemoryDriver();
	drivers.push(driver);
	return { cache: new CacheManager(driver, options), driver };
};

afterEach(() => {
	for (const driver of drivers.splice(0)) driver.destroy();
	vi.useRealTimers();
});

describe("echo > reading a key", () => {
	it("hands back a default when the key is absent", async () => {
		const { cache } = make();

		expect(await cache.get({ key: "missing", defaultValue: "fallback" })).toBe(
			"fallback",
		);
	});

	it("calls a default that is a function", async () => {
		const { cache } = make();

		expect(
			await cache.get({ key: "missing", defaultValue: () => "computed" }),
		).toBe("computed");
	});

	it("answers null with no default", async () => {
		const { cache } = make();

		expect(await cache.get("missing")).toBeUndefined();
	});

	it("emits a miss, then a hit", async () => {
		const events: string[] = [];
		const { cache } = make({
			emitter: { emit: (event: string) => events.push(event) },
		});

		await cache.get("k");
		await cache.set("k", "v");
		await cache.get("k");

		expect(events).toContain("cache:miss");
		expect(events).toContain("cache:hit");
	});

	it("serves a stale value under grace, and says it was graced", async () => {
		vi.useFakeTimers();
		const hits: Array<{ graced?: boolean }> = [];
		const { cache } = make({
			grace: 60,
			emitter: {
				emit: (event: string, payload: { graced?: boolean }) => {
					if (event === "cache:hit") hits.push(payload);
				},
			},
		});
		await cache.set({ key: "k", value: "v", ttl: 1 });

		vi.advanceTimersByTime(2000);

		// Past its TTL but inside the grace window: the value is still served,
		// and the caller is told it is stale.
		expect(await cache.get("k")).toBe("v");
		expect(hits.at(-1)?.graced).toBe(true);
	});
});

describe("echo > the convenience writes", () => {
	it("setForever stores a value with no expiry", async () => {
		vi.useFakeTimers();
		const { cache } = make({ ttl: 1 });

		await cache.setForever({ key: "k", value: "v" });
		vi.advanceTimersByTime(60_000);

		expect(await cache.get("k")).toBe("v");
	});

	it("getOrSetForever computes once and keeps it", async () => {
		vi.useFakeTimers();
		const { cache } = make({ ttl: 1 });
		const factory = vi.fn(async () => "computed");

		expect(await cache.getOrSetForever({ key: "k", factory })).toBe("computed");
		vi.advanceTimersByTime(60_000);
		expect(await cache.getOrSetForever({ key: "k", factory })).toBe("computed");
		expect(factory).toHaveBeenCalledOnce();
	});
});

describe("echo > the convenience reads and deletes", () => {
	it("pull reads and removes in one step", async () => {
		const { cache } = make();
		await cache.set("k", "v");

		expect(await cache.pull("k")).toBe("v");
		expect(await cache.get("k")).toBeUndefined();
	});

	it("pull on a miss deletes nothing", async () => {
		const { cache } = make();
		const spy = vi.spyOn(cache, "delete");

		expect(await cache.pull("missing")).toBeUndefined();
		expect(spy).not.toHaveBeenCalled();
	});

	it("missing is the inverse of has, in both call shapes", async () => {
		const { cache } = make();
		await cache.set("k", "v");

		expect(await cache.has("k")).toBe(true);
		expect(await cache.missing("k")).toBe(false);
		expect(await cache.has({ key: "gone" })).toBe(false);
		expect(await cache.missing({ key: "gone" })).toBe(true);
	});

	it("deleteMany takes a bare array as well as an options object", async () => {
		const { cache } = make();
		await cache.set("a", 1);
		await cache.set("b", 2);

		expect(await cache.deleteMany(["a", "b"])).toBe(true);
		expect(await cache.get("a")).toBeUndefined();

		await cache.set("c", 3);
		expect(await cache.deleteMany({ keys: ["c"] })).toBe(true);
	});

	it("deleteMany reports false when one key was not there", async () => {
		const { cache } = make();
		await cache.set("a", 1);

		expect(await cache.deleteMany(["a", "never"])).toBe(false);
	});

	it("delete takes the options shape too", async () => {
		const { cache } = make();
		await cache.set("k", "v");

		expect(await cache.delete({ key: "k" })).toBe(true);
		expect(await cache.delete({ key: "k" })).toBe(false);
	});
});

describe("echo > expiring without deleting", () => {
	it("makes the value stale but keeps it for the grace window", async () => {
		const { cache, driver } = make({ grace: 60 });
		await cache.set({ key: "k", value: "v" });

		expect(await cache.expire("k")).toBe(true);

		// The point of expire over delete: the entry is still there, marked
		// stale, so a reader under grace gets a value while the factory
		// refreshes instead of a cold miss.
		expect(await driver.getEntry("k")).toMatchObject({
			value: "v",
			stale: true,
		});
		expect(await cache.get("k")).toBe("v");
	});

	it("deletes outright when there is no grace to keep it for", async () => {
		const { cache, driver } = make();
		await cache.set("k", "v");

		expect(await cache.expire("k")).toBe(true);
		expect(await driver.get("k")).toBeNull();
	});

	it("reports false for a key that was not there", async () => {
		const { cache } = make();

		expect(await cache.expire("missing")).toBe(false);
	});

	it("takes the options shape", async () => {
		const { cache } = make();
		await cache.set("k", "v");

		expect(await cache.expire({ key: "k" })).toBe(true);
	});
});

describe("echo > namespaces", () => {
	it("prefixes every key, so two namespaces cannot collide", async () => {
		const { cache, driver } = make();
		const tenantA = cache.namespace("tenant-a");
		const tenantB = cache.namespace("tenant-b");

		await tenantA.set("k", "a");
		await tenantB.set("k", "b");

		expect(await tenantA.get("k")).toBe("a");
		expect(await tenantB.get("k")).toBe("b");
		expect(await driver.get("tenant-a:k")).toBe("a");
	});

	it("nests under an existing prefix rather than replacing it", async () => {
		const { cache, driver } = make({ prefix: "app" });

		await cache.namespace("users").set("k", "v");

		expect(await driver.get("app:users:k")).toBe("v");
	});

	it("clears ONLY its own subtree", async () => {
		// A namespace per tenant is the documented use, so a `clear()` that
		// flushes the whole store hands one tenant the power to empty every
		// other tenant's cache — from an operation they are allowed to run.
		const { cache } = make();
		await cache.set("outside", "keep");
		const tenantA = cache.namespace("tenant-a");
		const tenantB = cache.namespace("tenant-b");
		await tenantA.set("inside", "drop");
		await tenantB.set("inside", "keep too");

		await tenantA.clear();

		expect(await tenantA.get("inside")).toBeUndefined();
		expect(await cache.get("outside")).toBe("keep");
		expect(await tenantB.get("inside")).toBe("keep too");
	});

	it("does not clear a sibling whose name starts the same way", async () => {
		// Prefix matching is on the SEPARATOR, not the string: `tenant-a` must
		// not take `tenant-abc` with it.
		const { cache } = make();
		await cache.namespace("tenant-a").set("k", "a");
		await cache.namespace("tenant-abc").set("k", "abc");

		await cache.namespace("tenant-a").clear();

		expect(await cache.namespace("tenant-abc").get("k")).toBe("abc");
	});

	it("shares the driver, so a clear reaches both", async () => {
		const { cache } = make();
		const scoped = cache.namespace("users");
		await scoped.set("k", "v");

		await cache.clear();

		expect(await scoped.get("k")).toBeUndefined();
	});
});

describe("echo > tags", () => {
	it("deletes by tag, in both call shapes", async () => {
		const { cache } = make();
		await cache.set({ key: "a", value: 1, tags: ["invoices"] });
		await cache.set({ key: "b", value: 2, tags: ["invoices"] });

		await cache.deleteByTag(["invoices"]);
		expect(await cache.get("a")).toBeUndefined();

		await cache.set({ key: "c", value: 3, tags: ["invoices"] });
		await cache.deleteByTag({ tags: ["invoices"] });
		expect(await cache.get("c")).toBeUndefined();
	});

	it("flushTags is the same operation under its old name", async () => {
		const { cache } = make();
		await cache.set({ key: "a", value: 1, tags: ["invoices"] });

		await cache.flushTags(["invoices"]);

		expect(await cache.get("a")).toBeUndefined();
	});
});

describe("echo > getOrSet timeouts", () => {
	it("refuses a call shape with no factory", async () => {
		const { cache } = make();

		await expect(
			(
				cache.getOrSet as (a: string, b: number, c: unknown) => Promise<unknown>
			)("k", 60, "not a function"),
		).rejects.toThrow(/requires a factory function/);
	});

	it("gives up on a slow factory rather than holding the request open", async () => {
		const { cache } = make();

		await expect(
			cache.getOrSet({
				key: "k",
				factory: () =>
					new Promise((resolve) => setTimeout(() => resolve("late"), 200)),
				hardTimeout: "10ms",
			}),
		).rejects.toBeInstanceOf(TimeoutError);
	});

	it("serves the stale value when the refresh outruns the soft timeout", async () => {
		const { cache } = make({ grace: 60 });
		await cache.set({ key: "k", value: "old", ttl: 0.05 });
		await new Promise((resolve) => setTimeout(resolve, 100));

		const value = await cache.getOrSet({
			key: "k",
			factory: () =>
				new Promise((resolve) => setTimeout(() => resolve("fresh"), 300)),
			timeout: "10ms",
		});

		// The reader gets the stale value now; the refresh carries on behind it.
		expect(value).toBe("old");
	});

	it("waits for a fast refresh instead of serving stale", async () => {
		const { cache } = make({ grace: 60 });
		await cache.set({ key: "k", value: "old", ttl: 0.05 });
		await new Promise((resolve) => setTimeout(resolve, 100));

		const value = await cache.getOrSet({
			key: "k",
			factory: async () => "fresh",
			timeout: "200ms",
		});

		expect(value).toBe("fresh");
	});
});
