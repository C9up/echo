/**
 * The two-tier driver.
 *
 * It shipped essentially unexercised, and it is the one driver whose bugs are
 * silent: a promotion that loses the remaining TTL leaves an immortal L1 copy
 * still serving a value the shared L2 has already expired, and every process
 * keeps its own copy of that mistake. So the promotion rules, the grace
 * fall-through and the peer-invalidation bus are each pinned here.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryDriver } from "../../src/drivers/MemoryDriver.js";
import type { BusMessage, CacheBus } from "../../src/drivers/TieredDriver.js";
import { TieredDriver } from "../../src/drivers/TieredDriver.js";
import type {
	CacheDriver,
	CacheEntry,
	DriverSetOptions,
} from "../../src/types.js";

/** A driver that answers exactly what a test tells it to. */
class StubDriver implements CacheDriver {
	entries = new Map<string, CacheEntry>();
	writes: Array<{ key: string; value: unknown; options: DriverSetOptions }> =
		[];
	flushed = 0;
	deleted: string[] = [];

	async getEntry<T>(key: string): Promise<CacheEntry<T> | null> {
		return (this.entries.get(key) as CacheEntry<T>) ?? null;
	}
	async setEntry(
		key: string,
		value: unknown,
		options: DriverSetOptions,
	): Promise<void> {
		this.writes.push({ key, value, options });
		this.entries.set(key, { value, stale: false });
	}
	async get<T>(key: string): Promise<T | null> {
		const entry = await this.getEntry<T>(key);
		return entry === null || entry.stale ? null : entry.value;
	}
	async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
		await this.setEntry(key, value, { ttlSeconds });
	}
	async delete(key: string): Promise<boolean> {
		this.deleted.push(key);
		return this.entries.delete(key);
	}
	async flush(): Promise<void> {
		this.flushed++;
		this.entries.clear();
	}
	async has(key: string): Promise<boolean> {
		return (await this.get(key)) !== null;
	}
}

/** A driver with no `getEntry`/`setEntry` — the plain half of the contract. */
class PlainDriver implements CacheDriver {
	store = new Map<string, unknown>();
	ttls: Array<number | undefined> = [];
	async get<T>(key: string): Promise<T | null> {
		return (this.store.get(key) as T) ?? null;
	}
	async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
		this.ttls.push(ttlSeconds);
		this.store.set(key, value);
	}
	async delete(key: string): Promise<boolean> {
		return this.store.delete(key);
	}
	async flush(): Promise<void> {
		this.store.clear();
	}
	async has(key: string): Promise<boolean> {
		return this.store.has(key);
	}
}

const bus = () => {
	const handlers: Array<(m: BusMessage) => void> = [];
	const published: BusMessage[] = [];
	const it: CacheBus = {
		publish: (message) => {
			published.push(message);
		},
		subscribe: (handler) => {
			handlers.push(handler);
		},
	};
	return {
		bus: it,
		published,
		emit: (m: BusMessage) => {
			for (const handler of handlers) handler(m);
		},
	};
};

describe("echo > reading through the tiers", () => {
	it("answers from L1 without touching L2", async () => {
		const l1 = new StubDriver();
		const l2 = new StubDriver();
		l1.entries.set("k", { value: "from-l1", stale: false });
		l2.entries.set("k", { value: "from-l2", stale: false });
		const spy = vi.spyOn(l2, "getEntry");

		expect(await new TieredDriver({ l1, l2 }).get("k")).toBe("from-l1");
		expect(spy).not.toHaveBeenCalled();
	});

	it("falls through to L2 and promotes the hit into L1", async () => {
		const l1 = new StubDriver();
		const l2 = new StubDriver();
		l2.entries.set("k", {
			value: "from-l2",
			stale: false,
			expiresAt: Date.now() + 60_000,
		});

		expect(await new TieredDriver({ l1, l2 }).get("k")).toBe("from-l2");
		expect(l1.writes).toHaveLength(1);
		// The promotion carries the REMAINING life, not a fresh one.
		expect(l1.writes[0]?.options.ttlSeconds).toBeGreaterThan(0);
		expect(l1.writes[0]?.options.ttlSeconds).toBeLessThanOrEqual(60);
	});

	it("promotes an entry that genuinely never expires with no TTL", async () => {
		const l1 = new StubDriver();
		const l2 = new StubDriver();
		l2.entries.set("k", { value: "forever", stale: false, expiresAt: 0 });

		await new TieredDriver({ l1, l2 }).get("k");

		expect(l1.writes[0]?.options.ttlSeconds).toBeUndefined();
	});

	it("refuses to promote when L2 cannot say when the entry dies", async () => {
		const l1 = new StubDriver();
		const l2 = new StubDriver();
		// No `expiresAt`: promoting would mint an immortal L1 copy of a value
		// the L2 will expire on its own schedule.
		l2.entries.set("k", { value: "from-l2", stale: false });

		expect(await new TieredDriver({ l1, l2 }).get("k")).toBe("from-l2");
		expect(l1.writes).toHaveLength(0);
	});

	it("refuses to promote a value that expired while it was being read", async () => {
		const l1 = new StubDriver();
		const l2 = new StubDriver();
		l2.entries.set("k", {
			value: "just-died",
			stale: false,
			expiresAt: Date.now() - 1,
		});

		expect(await new TieredDriver({ l1, l2 }).get("k")).toBe("just-died");
		expect(l1.writes).toHaveLength(0);
	});

	it("serves a stale L2 entry over a stale L1 one", async () => {
		const l1 = new StubDriver();
		const l2 = new StubDriver();
		l1.entries.set("k", { value: "stale-l1", stale: true });
		l2.entries.set("k", { value: "stale-l2", stale: true });

		// L2 is shared, so its stale copy is the more recent of the two.
		expect(await new TieredDriver({ l1, l2 }).getEntry("k")).toMatchObject({
			value: "stale-l2",
			stale: true,
		});
	});

	it("falls back to a stale L1 entry when L2 has nothing", async () => {
		const l1 = new StubDriver();
		const l2 = new StubDriver();
		l1.entries.set("k", { value: "stale-l1", stale: true });

		expect(await new TieredDriver({ l1, l2 }).getEntry("k")).toMatchObject({
			value: "stale-l1",
			stale: true,
		});
	});

	it("answers null through get() for a stale entry, and the entry through getEntry()", async () => {
		const l1 = new StubDriver();
		const l2 = new StubDriver();
		l1.entries.set("k", { value: "stale", stale: true });
		const tiered = new TieredDriver({ l1, l2 });

		expect(await tiered.get("k")).toBeNull();
		expect(await tiered.getEntry("k")).not.toBeNull();
	});

	it("answers null when neither tier has it", async () => {
		const tiered = new TieredDriver({
			l1: new StubDriver(),
			l2: new StubDriver(),
		});

		expect(await tiered.getEntry("missing")).toBeNull();
		expect(await tiered.get("missing")).toBeNull();
		expect(await tiered.has("missing")).toBe(false);
	});

	it("reads a tier that only implements the plain contract", async () => {
		const l1 = new PlainDriver();
		const l2 = new PlainDriver();
		await l2.set("k", "value");

		expect(await new TieredDriver({ l1, l2 }).get("k")).toBe("value");
	});
});

describe("echo > writing through the tiers", () => {
	it("writes both tiers and tells the peers", async () => {
		const l1 = new StubDriver();
		const l2 = new StubDriver();
		const { bus: b, published } = bus();

		await new TieredDriver({ l1, l2, bus: b }).set("k", "v", 30);

		expect(l1.writes[0]).toMatchObject({ key: "k", value: "v" });
		expect(l2.writes[0]).toMatchObject({ key: "k", value: "v" });
		expect(published).toEqual([{ type: "delete", keys: ["k"] }]);
	});

	it("writes a plain tier through set(), carrying the TTL", async () => {
		const l1 = new PlainDriver();
		const l2 = new PlainDriver();

		await new TieredDriver({ l1, l2 }).set("k", "v", 30);

		expect(l1.ttls).toEqual([30]);
		expect(l2.ttls).toEqual([30]);
	});

	it("deletes from both tiers, and reports whether either held it", async () => {
		const l1 = new StubDriver();
		const l2 = new StubDriver();
		l2.entries.set("k", { value: "v", stale: false });
		const { bus: b, published } = bus();
		const tiered = new TieredDriver({ l1, l2, bus: b });

		expect(await tiered.delete("k")).toBe(true);
		expect(l1.deleted).toEqual(["k"]);
		expect(l2.deleted).toEqual(["k"]);
		expect(published).toEqual([{ type: "delete", keys: ["k"] }]);

		expect(await tiered.delete("missing")).toBe(false);
	});

	it("flushes both tiers and tells the peers to clear", async () => {
		const l1 = new StubDriver();
		const l2 = new StubDriver();
		const { bus: b, published } = bus();

		await new TieredDriver({ l1, l2, bus: b }).flush();

		expect(l1.flushed).toBe(1);
		expect(l2.flushed).toBe(1);
		expect(published).toEqual([{ type: "clear", keys: [] }]);
	});
});

describe("echo > tags across the tiers", () => {
	it("writes the tags through to a taggable tier", async () => {
		const l1 = new MemoryDriver();
		const l2 = new MemoryDriver();
		const tiered = new TieredDriver({ l1, l2 });

		await tiered.setWithTags("k", "v", ["invoices"]);
		expect(await tiered.get("k")).toBe("v");

		await tiered.deleteByTag(["invoices"]);
		expect(await tiered.get("k")).toBeNull();
	});

	it("broadcasts a clear on a tag delete, since peers cannot map tags to keys", async () => {
		const { bus: b, published } = bus();
		const tiered = new TieredDriver({
			l1: new MemoryDriver(),
			l2: new MemoryDriver(),
			bus: b,
		});

		await tiered.deleteByTag(["invoices"]);

		expect(published.at(-1)).toEqual({ type: "clear", keys: [] });
	});

	it("flushTags is the same operation under its old name", async () => {
		const l1 = new MemoryDriver();
		const l2 = new MemoryDriver();
		const tiered = new TieredDriver({ l1, l2 });
		await tiered.setWithTags("k", "v", ["invoices"]);

		await tiered.flushTags(["invoices"]);

		expect(await tiered.get("k")).toBeNull();
	});

	it("says so rather than dropping a tag delete on an untaggable tier", async () => {
		// Silently succeeding would leave the tagged values in place while the
		// caller believes they are gone.
		const tiered = new TieredDriver({
			l1: new MemoryDriver(),
			l2: new StubDriver(),
		});

		await expect(tiered.deleteByTag(["invoices"])).rejects.toThrow(
			/requires both tiers to be taggable/,
		);
	});
});

describe("echo > peer invalidation over the bus", () => {
	it("drops the named keys from the local L1 only", async () => {
		const l1 = new StubDriver();
		const l2 = new StubDriver();
		l1.entries.set("k", { value: "stale-copy", stale: false });
		l2.entries.set("k", { value: "shared", stale: false });
		const { bus: b, emit } = bus();
		new TieredDriver({ l1, l2, bus: b });

		emit({ type: "delete", keys: ["k"] });
		await Promise.resolve();

		// L2 is shared — the peer that published already wrote it.
		expect(l1.deleted).toEqual(["k"]);
		expect(l2.deleted).toEqual([]);
	});

	it("flushes the local L1 only on a clear", async () => {
		const l1 = new StubDriver();
		const l2 = new StubDriver();
		const { bus: b, emit } = bus();
		new TieredDriver({ l1, l2, bus: b });

		emit({ type: "clear", keys: [] });
		await Promise.resolve();

		expect(l1.flushed).toBe(1);
		expect(l2.flushed).toBe(0);
	});
});

describe("echo > lifecycle passed down to both tiers", () => {
	it("prunes and disconnects each tier that supports it", async () => {
		const l1 = new MemoryDriver();
		const l2 = new MemoryDriver();
		const pruned = [vi.spyOn(l1, "prune"), vi.spyOn(l2, "prune")];
		const closed = [vi.spyOn(l1, "disconnect"), vi.spyOn(l2, "disconnect")];
		const tiered = new TieredDriver({ l1, l2 });

		await tiered.prune();
		await tiered.disconnect();

		for (const spy of [...pruned, ...closed])
			expect(spy).toHaveBeenCalledOnce();
	});

	it("takes a tier that supports neither without complaining", async () => {
		const tiered = new TieredDriver({
			l1: new StubDriver(),
			l2: new PlainDriver(),
		});

		await expect(tiered.prune()).resolves.toBeUndefined();
		await expect(tiered.disconnect()).resolves.toBeUndefined();
	});
});

describe("TieredDriver > an L1 that fails a peer invalidation", () => {
	it("reports instead of raising an unhandled rejection", async () => {
		const written: string[] = [];
		const originalWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = (chunk: string | Uint8Array): boolean => {
			written.push(String(chunk));
			return true;
		};
		const rejections: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const l1 = new MemoryDriver();
			// A Redis L1 whose socket just dropped, or a driver mid-shutdown.
			l1.delete = async () => {
				throw new Error("L1 is gone");
			};
			l1.flush = async () => {
				throw new Error("L1 is gone");
			};
			const { bus: b, emit } = bus();
			new TieredDriver({ l1, l2: new MemoryDriver(), bus: b });

			// Nobody awaits a bus callback, so these rejections had nowhere to
			// go — and on a default Node that ends the process over a cache
			// failing to forget a key.
			emit({ type: "delete", keys: ["a", "b"] });
			emit({ type: "clear", keys: [] });
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(rejections).toEqual([]);
			expect(written.join("")).toContain("tiered L1 invalidation");
		} finally {
			process.stderr.write = originalWrite;
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
