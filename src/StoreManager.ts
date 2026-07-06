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
import type { CacheDriver, CacheEmitter } from "./types.js";

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
	redis(options: { client: RedisClient; prefix?: string }): DriverFactory {
		return () => new RedisDriver(options.client, options.prefix);
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
		this.#built.set(store, manager);
		return manager;
	}
}
