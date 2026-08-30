/**
 * The provider, the service accessor and the test helper.
 *
 * These are the three things a consuming app touches before it writes a single
 * cache call, and none of them was exercised: a provider that binds the wrong
 * token, or an accessor that crashes at import time, breaks the app at boot
 * rather than at the first `cache.get()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../src/CacheManager.js";
import EchoProvider from "../../src/EchoProvider.js";
import { drivers } from "../../src/StoreManager.js";
import { getCache, setCache } from "../../src/services/main.js";
import { createTestCache } from "../../src/testing/main.js";

/** The slice of an app container the provider actually uses. */
const app = (config: unknown, emitter?: unknown) => {
	const bindings = new Map<unknown, () => unknown>();
	const cached = new Map<unknown, unknown>();
	return {
		config: {
			get: <T>(): T | undefined => config as T | undefined,
		},
		container: {
			singleton(token: unknown, factory: () => unknown) {
				bindings.set(token, factory);
			},
			async resolve<T>(token: unknown): Promise<T> {
				if (token === "emitter") {
					if (emitter === undefined) throw new Error("not bound");
					return emitter as T;
				}
				if (!cached.has(token)) {
					const factory = bindings.get(token);
					if (!factory) throw new Error(`unbound: ${String(token)}`);
					cached.set(token, await factory());
				}
				return cached.get(token) as T;
			},
		},
		bindings,
	};
};

afterEach(() => {
	// The accessor is process-wide; leaving one behind leaks into the next test.
	setCache(undefined as unknown as CacheManager);
});

describe("echo > the provider", () => {
	it("binds the manager under both the class and the string token", async () => {
		const context = app({});
		new EchoProvider(context).register();

		expect([...context.bindings.keys()]).toEqual([CacheManager, "cache"]);
		expect(await context.container.resolve("cache")).toBeInstanceOf(
			CacheManager,
		);
	});

	it("defaults to the memory driver with no config at all", async () => {
		const context = app(undefined);
		new EchoProvider(context).register();

		expect(await context.container.resolve(CacheManager)).toBeInstanceOf(
			CacheManager,
		);
	});

	it("builds the default store out of a multi-store config", async () => {
		const context = app({
			default: "memory",
			stores: { memory: { driver: drivers.memory() } },
		});
		new EchoProvider(context).register();

		expect(await context.container.resolve(CacheManager)).toBeInstanceOf(
			CacheManager,
		);
	});

	it("refuses a driver the default wiring cannot build", async () => {
		// Silently falling back to memory would give a production app a cache
		// that empties on every deploy without saying so.
		const context = app({ driver: "redis" });
		new EchoProvider(context).register();

		await expect(context.container.resolve(CacheManager)).rejects.toThrow(
			/Unsupported driver 'redis'/,
		);
	});

	it("wires an emitter when the container has one", async () => {
		const emitter = { emit: vi.fn() };
		const context = app({}, emitter);
		new EchoProvider(context).register();
		await context.container.resolve(CacheManager);

		const cache = (await context.container.resolve(
			CacheManager,
		)) as CacheManager;
		await cache.set("k", "v");

		expect(emitter.emit).toHaveBeenCalled();
	});

	it("carries on without one, rather than failing to boot", async () => {
		const context = app({}, { notAnEmitter: true });
		new EchoProvider(context).register();

		await expect(
			context.container.resolve(CacheManager),
		).resolves.toBeInstanceOf(CacheManager);
	});

	it("releases the cache at shutdown", async () => {
		const context = app({});
		const provider = new EchoProvider(context);
		provider.register();
		await provider.boot();
		const cache = getCache();
		if (!cache) throw new Error("boot should have published a cache");
		const released = vi.spyOn(cache, "disconnect");

		await provider.shutdown();

		// The memory driver sweeps on a timer and the redis driver holds a
		// connection; neither is released on its own, so every dev reload
		// leaves another one behind.
		expect(released).toHaveBeenCalledOnce();
	});

	it("releases the cache IT booted, not whatever the singleton holds", async () => {
		// Two applications can share a process. Disconnecting the other one's
		// cache is a live app whose driver was closed underneath it.
		const first = new EchoProvider(app({}));
		first.register();
		await first.boot();
		const mine = getCache();

		const second = new EchoProvider(app({}));
		second.register();
		await second.boot();
		const theirs = getCache();
		expect(theirs).not.toBe(mine);
		const released = vi.spyOn(theirs as CacheManager, "disconnect");

		await first.shutdown();

		expect(released).not.toHaveBeenCalled();
		expect(getCache()).toBe(theirs);

		await second.shutdown();
		expect(getCache()).toBeUndefined();
	});

	it("publishes the singleton at boot", async () => {
		const context = app({});
		const provider = new EchoProvider(context);
		provider.register();

		await provider.boot();

		expect(getCache()).toBeInstanceOf(CacheManager);
		await expect(provider.shutdown()).resolves.toBeUndefined();
	});
});

describe("echo > the service accessor", () => {
	it("answers undefined to a loader's probes instead of throwing", async () => {
		const { default: cache } = await import("../../src/services/main.js");

		// A module loader reads `then` to decide whether the namespace is
		// thenable, and symbols for interop. Throwing there turns a plain
		// import into a crash far from any real use.
		expect((cache as unknown as { then?: unknown }).then).toBeUndefined();
		expect(Reflect.get(cache, Symbol.toPrimitive)).toBeUndefined();
	});

	it("says what to wire when it is read before boot", async () => {
		const { default: cache } = await import("../../src/services/main.js");

		expect(() => cache.get).toThrow(/accessed before EchoProvider.boot\(\)/);
	});

	it("forwards to the bound manager, bound to it", async () => {
		const { cache: real, dispose } = createTestCache();
		setCache(real);
		const { default: cache } = await import("../../src/services/main.js");

		// Unbound, the forwarded method would lose its private state.
		const { set, get } = cache;
		await set("k", "v");
		expect(await get("k")).toBe("v");
		dispose();
	});
});

describe("echo > the test helper", () => {
	let made: ReturnType<typeof createTestCache>[] = [];

	beforeEach(() => {
		made = [];
	});

	afterEach(() => {
		for (const one of made) one.dispose();
	});

	const make = (options?: Parameters<typeof createTestCache>[0]) => {
		const one = createTestCache(options);
		made.push(one);
		return one;
	};

	it("records the events the manager emitted", async () => {
		const { cache, events } = make();

		await cache.set("k", "v");
		await cache.get("k");

		expect(events.length).toBeGreaterThan(0);
		expect(events.every((e) => typeof e.event === "string")).toBe(true);
	});

	it("isolates each cache it builds", async () => {
		const first = make();
		const second = make();

		await first.cache.set("k", "one");

		// A shared driver between two tests is a test that passes because of
		// the one before it.
		expect(await second.cache.get("k")).toBeNull();
	});

	it("takes the prefix, ttl, grace and name it was given", async () => {
		const { cache, driver } = make({ prefix: "app", ttl: 60, name: "orders" });

		await cache.set("k", "v");

		expect(await driver.get("app:k")).toBe("v");
	});

	it("stops the driver's sweep on dispose", () => {
		const one = createTestCache();

		// An undisposed interval keeps the test process alive.
		expect(() => one.dispose()).not.toThrow();
	});
});
