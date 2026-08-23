/**
 * Multi-store cache manager — `{ default, stores }` config + `cache.use(name)`
 * (bentocache `BentoCache` / @adonisjs/cache parity), plus the `drivers.*`
 * factory helpers.
 *
 *   const cache = new CacheStoreManager(defineConfig({
 *     default: "memory",
 *     stores: {
 *       memory: { driver: drivers.memory() },
 *       redis:  { driver: drivers.redis({ client }) },
 *     },
 *   }))
 *
 *   await cache.use().set({ key: "k", value: 1 })      // default store
 *   await cache.use("redis").get({ key: "k" })         // named store
 */

import { CacheManager } from "./CacheManager.js";
import { MemoryDriver } from "./drivers/MemoryDriver.js";
import { type RedisClient, RedisDriver } from "./drivers/RedisDriver.js";
import { type CacheBus, TieredDriver } from "./drivers/TieredDriver.js";
import type { Duration } from "./duration.js";
import { quasarConnection } from "./quasar.js";
import type { CacheDriver, CacheEmitter, CacheEventMap } from "./types.js";

/** A lazily-instantiated driver (built once per store, on first `use`). */
export type DriverFactory = () => CacheDriver;

export interface StoreConfig {
	driver: DriverFactory;
	prefix?: string;
	/** Default TTL in seconds. */
	ttl?: number;
	grace?: Duration;
	timeout?: Duration;
	hardTimeout?: Duration;
	lockTimeout?: Duration;
}

export interface MultiStoreConfig {
	default: string;
	stores: Record<string, StoreConfig>;
	/** Shared emitter for all stores' events. */
	emitter?: CacheEmitter;
}

/** Driver factory helpers (bento `drivers.memory` / `drivers.redis`). */
export const drivers = {
	memory(options?: { sweepIntervalMs?: number }): DriverFactory {
		return () => new MemoryDriver(options?.sweepIntervalMs);
	},
	/**
	 * Either hand it a client, or name a quasar connection — the AdonisJS shape,
	 * where a store says `connection: "cache"` and the Redis module owns the
	 * socket. Naming a connection loads @c9up/quasar on the first command, so a
	 * memory-only app never pays for it.
	 */
	redis(
		options:
			| { client: RedisClient; prefix?: string }
			| { connection?: string; prefix?: string },
	): DriverFactory {
		if ("client" in options) {
			return () => new RedisDriver(options.client, options.prefix);
		}
		return () =>
			new RedisDriver(quasarConnection(options.connection), options.prefix);
	},
	tiered(options: {
		l1: DriverFactory;
		l2: DriverFactory;
		bus?: CacheBus;
	}): DriverFactory {
		return () =>
			new TieredDriver({
				l1: options.l1(),
				l2: options.l2(),
				bus: options.bus,
			});
	},
};

export class CacheStoreManager {
	#config: MultiStoreConfig;
	#built: Map<string, CacheManager> = new Map();
	// Held here as well as on each store, so a listener registered before a
	// store is first used still reaches it.
	readonly #listeners: {
		[E in keyof CacheEventMap]: Set<(payload: CacheEventMap[E]) => void>;
	} = {
		"cache:hit": new Set(),
		"cache:miss": new Set(),
		"cache:written": new Set(),
		"cache:deleted": new Set(),
		"cache:cleared": new Set(),
	};

	constructor(config: MultiStoreConfig) {
		this.#config = config;
		if (!config.stores[config.default]) {
			throw new Error(
				`Echo: default store "${config.default}" is not defined in stores`,
			);
		}
	}

	/** Resolve a store by name (or the default). Instances are built once and cached. */
	use(name?: string): CacheManager {
		const store = name ?? this.#config.default;
		const existing = this.#built.get(store);
		if (existing) return existing;

		const cfg = this.#config.stores[store];
		if (!cfg) {
			throw new Error(`Echo: unknown cache store "${store}"`);
		}
		const manager = new CacheManager(cfg.driver(), {
			prefix: cfg.prefix,
			ttl: cfg.ttl,
			grace: cfg.grace,
			timeout: cfg.timeout,
			hardTimeout: cfg.hardTimeout,
			lockTimeout: cfg.lockTimeout,
			name: store,
			emitter: this.#config.emitter,
		});
		// A listener registered before this store was built still has to hear
		// from it — stores are created lazily, on first use. Replayed one event
		// at a time so each listener keeps the payload type it was written for.
		const replay = <E extends keyof CacheEventMap>(event: E): void => {
			for (const listener of this.#listeners[event]) {
				manager.on(event, listener);
			}
		};
		replay("cache:hit");
		replay("cache:miss");
		replay("cache:written");
		replay("cache:deleted");
		replay("cache:cleared");
		this.#built.set(store, manager);
		return manager;
	}

	/**
	 * Listen across every store (bentocache `on`), including ones not yet built.
	 *
	 *   cache.on('cache:miss', ({ key, store }) => metrics.miss(store, key))
	 */
	on<E extends keyof CacheEventMap>(
		event: E,
		listener: (payload: CacheEventMap[E]) => void,
	): this {
		this.#listeners[event].add(listener);
		for (const manager of this.#built.values()) manager.on(event, listener);
		return this;
	}

	/** Listen for the next occurrence across any store (bentocache `once`). */
	once<E extends keyof CacheEventMap>(
		event: E,
		listener: (payload: CacheEventMap[E]) => void,
	): this {
		const wrapper = (payload: CacheEventMap[E]): void => {
			this.off(event, wrapper);
			listener(payload);
		};
		return this.on(event, wrapper);
	}

	/** Stop listening (bentocache `off`). Omitting `listener` drops them all. */
	off<E extends keyof CacheEventMap>(
		event: E,
		listener?: (payload: CacheEventMap[E]) => void,
	): this {
		if (listener === undefined) this.#listeners[event].clear();
		else this.#listeners[event].delete(listener);
		for (const manager of this.#built.values()) manager.off(event, listener);
		return this;
	}

	/** Clear every store that has been built (bentocache `clearAll`). */
	async clearAll(): Promise<void> {
		await Promise.all([...this.#built.values()].map((m) => m.clear()));
	}

	/** Prune expired entries in every built store (bentocache `prune`). */
	async prune(): Promise<void> {
		await Promise.all([...this.#built.values()].map((m) => m.prune()));
	}

	/**
	 * Release what every built store owns (bentocache `disconnectAll`).
	 *
	 * Call it from a shutdown hook. A store on an INJECTED client leaves that
	 * client alone — echo did not open it.
	 */
	async disconnectAll(): Promise<void> {
		await Promise.all([...this.#built.values()].map((m) => m.disconnect()));
	}
}
