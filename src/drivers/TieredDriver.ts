/**
 * TieredDriver — two-tier cache composing an L1 (in-process, e.g.
 * {@link MemoryDriver}) and an L2 (distributed, e.g. {@link RedisDriver}).
 *
 * Reads go L1 → L2 → miss, promoting an L2 hit back into L1. Writes are
 * write-through to both tiers. An optional {@link CacheBus} broadcasts
 * invalidations so peer instances drop their (now stale) L1 copies — the L2 is
 * shared, so only L1 needs cross-instance invalidation.
 */

import type {
	CacheDriver,
	CacheEntry,
	DriverSetOptions,
	TaggableDriver,
} from "../types.js";

/** A cross-instance invalidation message. */
export interface BusMessage {
	type: "delete" | "clear";
	keys: string[];
	/**
	 * The tier that published it.
	 *
	 * A pub/sub bus delivers to every subscriber INCLUDING the publisher —
	 * Redis does, and Redis pub/sub is what this is for. Without a sender to
	 * recognise, every `set` published a delete, received it back, and dropped
	 * the L1 copy it had just written: L1 held nothing after any write, and
	 * every read went to L2. Upstream draws the same line one layer down, where
	 * each bus transport stamps its own id and skips what it sent
	 * (`@boringnode/bus`, `transports/memory.js`: `if (busId === this.#id)
	 * continue`).
	 *
	 * Optional, and a message without one is acted on: a bus that predates this
	 * field keeps working, at worst doing the redundant local invalidation it
	 * already did.
	 */
	senderId?: string;
}

/** Duck-typed pub/sub bus for cross-instance L1 invalidation (e.g. Redis pub/sub). */
export interface CacheBus {
	publish(message: BusMessage): void | Promise<void>;
	subscribe(handler: (message: BusMessage) => void): void;
	/**
	 * Stop listening — the HANDLER names which subscription, because a bus is
	 * shared: quasar keeps a `Set` per channel, so "drop everything here" would
	 * silence whatever else the application listens to on the connection the
	 * cache borrows.
	 *
	 * There was no way to stop at all, so every hot reload and every test left
	 * another handler on the bus: each holding an L1 nobody would read again,
	 * and each acting on invalidations meant for a driver that no longer
	 * exists. Optional, so a bus written against the old contract still works —
	 * it just leaks, and now that is the bus's omission rather than a gap in
	 * the contract.
	 */
	unsubscribe?(handler: (message: BusMessage) => void): void | Promise<void>;
}

export interface TieredDriverOptions {
	l1: CacheDriver;
	l2: CacheDriver;
	bus?: CacheBus;
}

function isTaggable(driver: CacheDriver): driver is TaggableDriver {
	const candidate: Partial<TaggableDriver> = driver;
	return (
		typeof candidate.setWithTags === "function" &&
		(typeof candidate.deleteByTag === "function" ||
			typeof candidate.flushTags === "function")
	);
}

async function readEntry<T>(
	driver: CacheDriver,
	key: string,
): Promise<CacheEntry<T> | null> {
	if (driver.getEntry) return driver.getEntry<T>(key);
	const value = await driver.get<T>(key);
	return value === null ? null : { value, stale: false };
}

async function writeEntry(
	driver: CacheDriver,
	key: string,
	value: unknown,
	options: DriverSetOptions,
): Promise<void> {
	if (driver.setEntry) {
		await driver.setEntry(key, value, options);
		return;
	}
	if (options.tags && options.tags.length > 0 && isTaggable(driver)) {
		await driver.setWithTags(key, value, options.tags, options.ttlSeconds);
		return;
	}
	await driver.set(key, value, options.ttlSeconds);
}

/**
 * Run one tier's operation, capturing a rejection instead of letting it escape.
 *
 * The two tiers are attempted independently on purpose: awaiting L1 first meant
 * a local driver that threw — a Redis L1 whose socket just dropped, one
 * mid-shutdown — aborted the call before the SHARED tier was touched, so a
 * `delete` left the copy every other instance reads. Upstream reaches the same
 * end by never awaiting L1 at all (`this.l1?.set(...)` with no await, then
 * `await this.l2?.set(...)`). The failure is still reported, after both tiers
 * have had their turn.
 */
async function settle<T>(
	run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
	try {
		return { ok: true, value: await run() };
	} catch (error) {
		return { ok: false, error };
	}
}

export class TieredDriver implements TaggableDriver {
	#l1: CacheDriver;
	#l2: CacheDriver;
	#bus: CacheBus | undefined;
	/** The listener on the bus, kept so `disconnect` can name it again. */
	#busHandler: ((message: BusMessage) => void) | undefined;
	/** This tier, as a bus sender. */
	readonly #id = crypto.randomUUID();

	constructor(options: TieredDriverOptions) {
		this.#l1 = options.l1;
		this.#l2 = options.l2;
		this.#bus = options.bus;
		const onPeerMessage = (message: BusMessage): void => {
			// Our own invalidation, come back round the bus. Acting on it would
			// undo the write that sent it.
			if (message.senderId === this.#id) return;
			// Peer invalidation: only the local L1 needs clearing (L2 is shared).
			if (message.type === "clear") {
				this.#invalidate("flush", () => this.#l1.flush());
				return;
			}
			for (const key of message.keys) {
				this.#invalidate(key, () => this.#l1.delete(key));
			}
		};
		if (this.#bus) {
			this.#busHandler = onPeerMessage;
			this.#bus.subscribe(onPeerMessage);
		}
	}

	/**
	 * Apply one peer invalidation to L1, reporting rather than escaping.
	 *
	 * This runs inside a bus callback, so nobody awaits it: an L1 that rejects
	 * — a Redis L1 whose socket just dropped, a driver mid-shutdown — was an
	 * unhandled rejection, which on a default Node ends the process. A cache
	 * layer failing to forget a key must not do that.
	 *
	 * It is reported and not retried: the entry keeps its own TTL, so the worst
	 * case is one stale read window on this instance, and a retry loop against
	 * a driver that is already failing buys nothing.
	 */
	#invalidate(what: string, run: () => Promise<unknown>): void {
		void (async () => run())().catch((error: unknown) => {
			process.stderr.write(
				`[echo] tiered L1 invalidation of '${what}' failed; the local copy may be stale until it expires: ${
					error instanceof Error ? error.message : String(error)
				}\n`,
			);
		});
	}

	async getEntry<T = unknown>(key: string): Promise<CacheEntry<T> | null> {
		const l1 = await readEntry<T>(this.#l1, key);
		if (l1 && !l1.stale) return l1;

		const l2 = await readEntry<T>(this.#l2, key);
		if (l2 && !l2.stale) {
			// Promote a fresh L2 hit into L1 — preserving the remaining logical TTL
			// so L1 cannot outlive L2 (a promotion with no TTL left an immortal L1
			// entry that kept serving a value the L2 had already expired).
			if (l2.expiresAt === undefined) {
				// Driver doesn't expose expiry — promoting with no TTL risks an
				// immortal L1 copy; skip promotion rather than cache it forever.
				return l2;
			}
			const opts: DriverSetOptions = {};
			if (l2.expiresAt > 0) {
				const remainingSeconds = (l2.expiresAt - Date.now()) / 1000;
				// Raced past expiry between the stale check and now — don't promote
				// a value that is already dead.
				if (remainingSeconds <= 0) return l2;
				opts.ttlSeconds = remainingSeconds;
			}
			// expiresAt === 0 → the L2 entry genuinely never expires → promote as-is.
			await writeEntry(this.#l1, key, l2.value, opts);
			return l2;
		}
		if (l2) return l2; // stale L2 (grace)
		if (l1) return l1; // stale L1 (grace)
		return null;
	}

	async get<T = unknown>(key: string): Promise<T | null> {
		const entry = await this.getEntry<T>(key);
		if (entry === null || entry.stale) return null;
		return entry.value;
	}

	async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
		await this.setEntry(key, value, { ttlSeconds });
	}

	async setEntry(
		key: string,
		value: unknown,
		options: DriverSetOptions,
	): Promise<void> {
		const l1 = await settle(() => writeEntry(this.#l1, key, value, options));
		const l2 = await settle(() => writeEntry(this.#l2, key, value, options));
		// Peers are told only when the shared write landed. Telling them to drop
		// their L1 for a value that never reached L2 sends every one of them to a
		// tier that does not have it. Upstream gates the same publish on the same
		// thing (`if (this.l2 && l2Success || !this.l2)`).
		if (l2.ok) {
			await this.#bus?.publish({
				type: "delete",
				keys: [key],
				senderId: this.#id,
			});
		}
		if (!l1.ok) throw l1.error;
		if (!l2.ok) throw l2.error;
	}

	async delete(key: string): Promise<boolean> {
		const l1 = await settle(() => this.#l1.delete(key));
		const l2 = await settle(() => this.#l2.delete(key));
		if (l2.ok) {
			await this.#bus?.publish({
				type: "delete",
				keys: [key],
				senderId: this.#id,
			});
		}
		if (!l1.ok) throw l1.error;
		if (!l2.ok) throw l2.error;
		return l1.value || l2.value;
	}

	async flush(): Promise<void> {
		const l1 = await settle(() => this.#l1.flush());
		const l2 = await settle(() => this.#l2.flush());
		if (l2.ok) {
			await this.#bus?.publish({ type: "clear", keys: [], senderId: this.#id });
		}
		if (!l1.ok) throw l1.error;
		if (!l2.ok) throw l2.error;
	}

	async has(key: string): Promise<boolean> {
		return (await this.get(key)) !== null;
	}

	async setWithTags(
		key: string,
		value: unknown,
		tags: string[],
		ttlSeconds?: number,
	): Promise<void> {
		await this.setEntry(key, value, { ttlSeconds, tags });
	}

	async deleteByTag(tags: string[]): Promise<void> {
		const l1 = this.#l1;
		const l2 = this.#l2;
		if (!isTaggable(l1) || !isTaggable(l2)) {
			throw new Error(
				"Echo: TieredDriver.deleteByTag requires both tiers to be taggable",
			);
		}
		const local = await settle(() => l1.deleteByTag(tags));
		const shared = await settle(() => l2.deleteByTag(tags));
		// Peers can't map tags → keys locally; broadcast a clear so their L1 drops
		// any tagged copies (conservative but correct).
		if (shared.ok) {
			await this.#bus?.publish({ type: "clear", keys: [], senderId: this.#id });
		}
		if (!local.ok) throw local.error;
		if (!shared.ok) throw shared.error;
	}

	/** @deprecated alias of {@link deleteByTag}. */
	async flushTags(tags: string[]): Promise<void> {
		return this.deleteByTag(tags);
	}
	/** Prune both layers (bentocache `prune`). */
	async prune(): Promise<void> {
		const l1 = await settle(async () => this.#l1.prune?.());
		const l2 = await settle(async () => this.#l2.prune?.());
		if (!l1.ok) throw l1.error;
		if (!l2.ok) throw l2.error;
	}

	/** Release the bus and both layers (bentocache `disconnect`). */
	async disconnect(): Promise<void> {
		// All three are released even when one refuses: a tier left connected
		// because its neighbour threw is a socket nobody closes, and a listener
		// left on the bus is an L1 nobody will read acting on invalidations for
		// a driver that no longer exists.
		const handler = this.#busHandler;
		this.#busHandler = undefined;
		const bus = await settle(async () =>
			handler ? this.#bus?.unsubscribe?.(handler) : undefined,
		);
		const l1 = await settle(async () => this.#l1.disconnect?.());
		const l2 = await settle(async () => this.#l2.disconnect?.());
		if (!l1.ok) throw l1.error;
		if (!l2.ok) throw l2.error;
		if (!bus.ok) throw bus.error;
	}
}
