import { describe, expect, it } from "vitest";
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

		await expect(tiered.set("k", "v", 60)).rejects.toThrow(/L2 write refused/);

		// Telling peers to drop their L1 for a value that never reached the
		// shared tier sends every one of them to a tier that does not have it.
		expect(seen).toHaveLength(0);
	});
});
