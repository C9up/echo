import { describe, expect, it } from "vitest";
import { CacheManager } from "../../src/CacheManager.js";
import { MemoryDriver } from "../../src/drivers/MemoryDriver.js";
import {
	type BusMessage,
	TieredDriver,
} from "../../src/drivers/TieredDriver.js";
import type { CacheDriver } from "../../src/types.js";

/**
 * A bus that delivers to every subscriber, publisher included.
 *
 * That is what Redis pub/sub does, and Redis pub/sub is what the tiered
 * driver's bus is for — so it is what the tests have to model.
 */
function echoingBus(): {
	bus: {
		publish(m: BusMessage): void;
		subscribe(h: (m: BusMessage) => void): void;
	};
	seen: BusMessage[];
} {
	const handlers: Array<(m: BusMessage) => void> = [];
	const seen: BusMessage[] = [];
	return {
		bus: {
			publish(message: BusMessage) {
				seen.push(message);
				for (const handler of handlers) handler(message);
			},
			subscribe(handler: (m: BusMessage) => void) {
				handlers.push(handler);
			},
		},
		seen,
	};
}

/** Let the fire-and-forget L1 invalidation run. */
const settled = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 5));

/** A driver that refuses one operation and delegates the rest. */
function refusing(inner: CacheDriver, op: "delete" | "flush"): CacheDriver {
	return {
		get: (key) => inner.get(key),
		set: (key, value, ttl) => inner.set(key, value, ttl),
		has: (key) => inner.has(key),
		delete:
			op === "delete"
				? () => {
						throw new Error("L1 socket dropped");
					}
				: (key) => inner.delete(key),
		flush:
			op === "flush"
				? () => {
						throw new Error("L1 socket dropped");
					}
				: () => inner.flush(),
	};
}

describe("echo > a tiered driver on a bus that hears itself", () => {
	it("keeps the L1 copy it just wrote", async () => {
		const l1 = new MemoryDriver();
		const l2 = new MemoryDriver();
		const { bus } = echoingBus();
		const tiered = new TieredDriver({ l1, l2, bus });
		await tiered.connect();

		await tiered.set("k", "v", 60);
		await settled();

		// Without a sender to recognise, the instance received its own
		// invalidation and dropped the copy it had just made: L1 held nothing
		// after any write, and every read went to L2.
		expect(await l1.get("k")).toBe("v");
		expect(await l2.get("k")).toBe("v");
	});

	it("still drops the L1 copy when the message came from somewhere else", async () => {
		const l1 = new MemoryDriver();
		const l2 = new MemoryDriver();
		const { bus } = echoingBus();
		const tiered = new TieredDriver({ l1, l2, bus });
		await tiered.connect();
		await tiered.set("k", "v", 60);
		await settled();

		bus.publish({ type: "delete", keys: ["k"], senderId: "another-instance" });
		await settled();
		expect(await l1.get("k")).toBeNull();

		// A bus written before the field carries no sender at all; that message
		// is acted on, so an older implementation keeps working.
		await tiered.set("k", "v", 60);
		await settled();
		bus.publish({ type: "delete", keys: ["k"] });
		await settled();
		expect(await l1.get("k")).toBeNull();
	});

	it("clears its own L1 only once on a flush", async () => {
		const l1 = new MemoryDriver();
		const l2 = new MemoryDriver();
		const { bus, seen } = echoingBus();
		const tiered = new TieredDriver({ l1, l2, bus });
		await tiered.connect();
		await tiered.set("k", "v", 60);

		await tiered.flush();
		await settled();

		expect(await l1.get("k")).toBeNull();
		expect(seen.filter((m) => m.type === "clear")).toHaveLength(1);
	});
});

describe("echo > a tier that refuses", () => {
	it("empties the shared tier even when the local one throws", async () => {
		const inner = new MemoryDriver();
		const l2 = new MemoryDriver();
		await inner.set("k", "v", 60);
		await l2.set("k", "v", 60);
		const tiered = new TieredDriver({ l1: refusing(inner, "delete"), l2 });

		// The failure is still reported — but not before the shared tier, which
		// every other instance reads, has been emptied.
		await expect(tiered.delete("k")).rejects.toThrow(/L1 socket dropped/);
		expect(await l2.get("k")).toBeNull();
	});

	it("flushes the shared tier even when the local one throws", async () => {
		const inner = new MemoryDriver();
		const l2 = new MemoryDriver();
		await l2.set("k", "v", 60);
		const tiered = new TieredDriver({ l1: refusing(inner, "flush"), l2 });

		await expect(tiered.flush()).rejects.toThrow(/L1 socket dropped/);
		expect(await l2.get("k")).toBeNull();
	});

	it("tells no peer to drop a value the shared tier never took", async () => {
		const l1 = new MemoryDriver();
		const l2 = new MemoryDriver();
		const failing: CacheDriver = {
			get: (key) => l2.get(key),
			has: (key) => l2.has(key),
			delete: (key) => l2.delete(key),
			flush: () => l2.flush(),
			set: () => {
				throw new Error("L2 write refused");
			},
		};
		const { bus, seen } = echoingBus();
		const tiered = new TieredDriver({ l1, l2: failing, bus });
		await tiered.connect();

		await expect(tiered.set("k", "v", 60)).rejects.toThrow(/L2 write refused/);

		// Telling peers to drop their L1 for a value that never reached the
		// shared tier sends every one of them to a tier that does not have it.
		expect(seen).toHaveLength(0);
	});
});

/**
 * A bus that can be told to drop one listener, and reports how many it holds.
 *
 * `subscribe` returning nothing was the problem: the tiered driver had no way
 * to let go, so every hot reload and every test left another handler on the
 * bus, each holding an L1 nobody would ever read again and each acting on
 * invalidations meant for a driver that no longer exists.
 */
function releasableBus(): {
	bus: {
		publish(m: BusMessage): void;
		subscribe(h: (m: BusMessage) => void): void;
		unsubscribe(h: (m: BusMessage) => void): void;
	};
	listeners: () => number;
	subscribes: () => number;
} {
	const handlers = new Set<(m: BusMessage) => void>();
	// Counted per CALL, not per distinct handler: a real bus registers a fresh
	// wrapper each time it is asked, so a `Set` of the caller's handler would
	// hide a second subscription behind the first.
	let subscribes = 0;
	return {
		bus: {
			publish(message: BusMessage) {
				for (const handler of handlers) handler(message);
			},
			subscribe(handler: (m: BusMessage) => void) {
				subscribes += 1;
				handlers.add(handler);
			},
			unsubscribe(handler: (m: BusMessage) => void) {
				handlers.delete(handler);
			},
		},
		listeners: () => handlers.size,
		subscribes: () => subscribes,
	};
}

describe("echo > a tiered driver lets go of the bus", () => {
	it("unsubscribes on disconnect", async () => {
		const { bus, listeners } = releasableBus();
		const tiered = new TieredDriver({
			l1: new MemoryDriver(),
			l2: new MemoryDriver(),
			bus,
		});
		// Building one opens nothing — the provider connects in `ready()`.
		expect(listeners()).toBe(0);
		await tiered.connect();
		expect(listeners()).toBe(1);

		await tiered.disconnect();

		expect(listeners()).toBe(0);
	});

	it("does not accumulate listeners across reloads", async () => {
		// One process, several application lifetimes: a dev reload, a test file.
		const { bus, listeners } = releasableBus();
		for (let cycle = 0; cycle < 3; cycle += 1) {
			const tiered = new TieredDriver({
				l1: new MemoryDriver(),
				l2: new MemoryDriver(),
				bus,
			});
			await tiered.connect();
			await tiered.disconnect();
		}

		expect(listeners()).toBe(0);
	});

	it("still releases both layers when the bus refuses", async () => {
		let released = 0;
		const layer = (): CacheDriver => {
			const inner = new MemoryDriver();
			return {
				get: (key) => inner.get(key),
				set: (key, value, ttl) => inner.set(key, value, ttl),
				delete: (key) => inner.delete(key),
				flush: () => inner.flush(),
				has: (key) => inner.has(key),
				disconnect: async () => {
					released += 1;
				},
			};
		};
		const tiered = new TieredDriver({
			l1: layer(),
			l2: layer(),
			bus: {
				publish() {},
				subscribe() {},
				unsubscribe() {
					throw new Error("the bus is already gone");
				},
			},
		});

		await tiered.connect();

		await expect(tiered.disconnect()).rejects.toThrow("already gone");

		expect(released).toBe(2);
	});

	it("still serves reads when the bus cannot be reached", async () => {
		// Connecting says the bus is down — that is the provider's to refuse —
		// but a store whose peers are unreachable still answers. Staleness is
		// the cost; refusing every read would be a far worse one.
		const l1 = new MemoryDriver();
		const tiered = new TieredDriver({
			l1,
			l2: new MemoryDriver(),
			bus: {
				publish() {},
				async subscribe() {
					throw new Error("no route to the bus");
				},
			},
		});

		await expect(tiered.connect()).rejects.toThrow("no route to the bus");

		await tiered.set("k", "v", 30);
		expect(await tiered.get("k")).toBe("v");
	});

	it("subscribes once for two concurrent connects", async () => {
		// `connect()` says it is idempotent, and both callers saw an empty
		// handler before the first await resolved — so two subscriptions went
		// on, and only one came off.
		const { bus, listeners, subscribes } = releasableBus();
		const tiered = new TieredDriver({
			l1: new MemoryDriver(),
			l2: new MemoryDriver(),
			bus,
		});

		await Promise.all([tiered.connect(), tiered.connect()]);

		expect(subscribes()).toBe(1);
		expect(listeners()).toBe(1);
		await tiered.disconnect();
		expect(listeners()).toBe(0);
	});

	it("keeps a subscription the bus refused to remove", async () => {
		// The handler was forgotten before the bus was asked. A rejecting
		// unsubscribe then left a live listener nothing could name again — not
		// to retry it, not to remove it at a second shutdown.
		const handlers = new Set<(m: BusMessage) => void>();
		let refuse = true;
		const tiered = new TieredDriver({
			l1: new MemoryDriver(),
			l2: new MemoryDriver(),
			bus: {
				publish() {},
				subscribe(handler: (m: BusMessage) => void) {
					handlers.add(handler);
				},
				unsubscribe(handler: (m: BusMessage) => void) {
					if (refuse) throw new Error("the bus is busy");
					handlers.delete(handler);
				},
			},
		});
		await tiered.connect();

		await expect(tiered.disconnect()).rejects.toThrow("busy");

		refuse = false;
		await tiered.disconnect();
		expect(handlers.size).toBe(0);
	});

	it("connects again after a disconnect", async () => {
		// A store stopped and started in one process — a hot reload, a test —
		// has to come back on the bus rather than on nothing.
		const { bus, listeners } = releasableBus();
		const l1 = new MemoryDriver();
		const cache = new CacheManager(
			new TieredDriver({ l1, l2: new MemoryDriver(), bus }),
		);

		await cache.connect();
		await cache.disconnect();
		await cache.connect();

		expect(listeners()).toBe(1);
		await cache.disconnect();
		expect(listeners()).toBe(0);
	});

	it("does not leave a subscription behind when a shutdown overtakes a connect", async () => {
		// `disconnect()` read the handler while `connect()` was still awaiting
		// the bus, saw none, and did nothing — then the subscribe landed and
		// installed a listener nothing was tracking.
		const handlers = new Set<(m: BusMessage) => void>();
		let release: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tiered = new TieredDriver({
			l1: new MemoryDriver(),
			l2: new MemoryDriver(),
			bus: {
				publish() {},
				async subscribe(handler: (m: BusMessage) => void) {
					await held;
					handlers.add(handler);
				},
				unsubscribe(handler: (m: BusMessage) => void) {
					handlers.delete(handler);
				},
			},
		});

		const connecting = tiered.connect();
		const stopping = tiered.disconnect();
		release?.();
		await connecting;
		await stopping;

		expect(handlers.size).toBe(0);
	});

	it("makes NO operation touch the driver before the connection settles", async () => {
		// The wait was added to four methods by hand, and `getOrSet`,
		// `deleteMany`, `expire`, `clear`, `setWithTags`, `deleteByTag` and
		// `prune` went without — so a store built after `ready()` read and
		// wrote before it had joined the bus, and any invalidation sent in that
		// window was missed for good.
		//
		// Driven off the public surface rather than a list, so a method added
		// later is covered without anyone remembering to come back here.
		const touched: string[] = [];
		let release: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const watching: CacheDriver = {
			get: async (key) => {
				touched.push(`get:${key}`);
				return null;
			},
			set: async (key) => {
				touched.push(`set:${key}`);
			},
			delete: async (key) => {
				touched.push(`delete:${key}`);
				return false;
			},
			flush: async () => {
				touched.push("flush");
			},
			has: async (key) => {
				touched.push(`has:${key}`);
				return false;
			},
			prune: async () => {
				touched.push("prune");
			},
			connect: async () => {
				await held;
			},
		};

		const calls: Array<[string, () => Promise<unknown>]> = [
			["get", () => cache.get("k")],
			["set", () => cache.set("k", 1)],
			["delete", () => cache.delete("k")],
			["deleteMany", () => cache.deleteMany(["k"])],
			["has", () => cache.has("k")],
			["missing", () => cache.missing("k")],
			["pull", () => cache.pull("k")],
			["expire", () => cache.expire("k")],
			["clear", () => cache.clear()],
			["prune", () => cache.prune()],
			["getOrSet", () => cache.getOrSet("k", 60, async () => 1)],
			["setWithTags", () => cache.setWithTags("k", 1, ["t"])],
			["deleteByTag", () => cache.deleteByTag(["t"])],
			["flushTags", () => cache.flushTags(["t"])],
		];
		const cache = new CacheManager(watching);
		void cache.connect();
		const inFlight = calls.map(([, run]) => run().catch(() => {}));
		await Promise.resolve();
		await Promise.resolve();

		expect(touched).toEqual([]);

		release?.();
		await Promise.all(inFlight);
		expect(touched.length).toBeGreaterThan(0);
	});

	it("opens the connection an operation finds closed, and retries a failure", async () => {
		// A store built after `ready()` connects on its way out of `use()`, and
		// that connect can fail. An operation that only WAITED then went on to
		// read and write off the bus, for good — nothing would ever try again.
		let attempts = 0;
		const cache = new CacheManager({
			get: async () => null,
			set: async () => {},
			delete: async () => false,
			flush: async () => {},
			has: async () => false,
			connect: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("the bus is down");
			},
		});

		// The read still answers — an unreachable bus costs staleness, not
		// every read — but it has tried.
		expect(await cache.get("k")).toBeNull();
		expect(attempts).toBe(1);

		expect(await cache.get("k")).toBeNull();
		expect(attempts).toBe(2);

		// And once it succeeds, it stops trying.
		expect(await cache.get("k")).toBeNull();
		expect(attempts).toBe(2);
	});
});
