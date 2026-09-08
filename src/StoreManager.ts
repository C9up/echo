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
import { quasarBus, quasarConnection } from "./quasar.js";
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
	/**
	 * The stores this application can use, by name. Each is a {@link store}
	 * builder — the shape a cache config takes — or the plain
	 * `{ driver, …options }` form kept for configs written against it.
	 */
	stores: Record<string, StoreConfig | Store>;
	/** Shared emitter for all stores' events. */
	emitter?: CacheEmitter;
}

/**
 * A store, described the way a cache config describes one: a layer at a time.
 *
 *   stores: {
 *     memoryOnly: store().useL1Layer(drivers.memory()),
 *     default: store({ ttl: 60 })
 *       .useL1Layer(drivers.memory())
 *       .useL2Layer(drivers.redis({ connection: "main" })),
 *   }
 *
 * One layer is that driver; two are a tiered driver over both, which is what
 * the layering means — reads hit L1, misses fall to L2, and writes go to both.
 */
export class Store {
	readonly #options: Omit<StoreConfig, "driver">;
	#l1: DriverFactory | undefined;
	#l2: DriverFactory | undefined;
	#bus: CacheBus | undefined;

	constructor(options: Omit<StoreConfig, "driver"> = {}) {
		this.#options = options;
	}

	/** The fast layer, usually memory. */
	useL1Layer(driver: DriverFactory): this {
		this.#l1 = driver;
		return this;
	}

	/** The shared layer, usually Redis — what makes the cache survive a restart. */
	useL2Layer(driver: DriverFactory): this {
		this.#l2 = driver;
		return this;
	}

	/** The bus that keeps every instance's L1 in step after a write. */
	useBus(bus: CacheBus): this {
		this.#bus = bus;
		return this;
	}

	/** The `{ driver, …options }` the manager consumes. */
	entry(): StoreConfig {
		const l1 = this.#l1;
		const l2 = this.#l2;
		if (!l1 && !l2) {
			throw new Error(
				"Echo: a store needs a layer — call useL1Layer() or useL2Layer() on it.",
			);
		}
		if (l1 && l2) {
			return {
				...this.#options,
				driver: drivers.tiered({ l1, l2, bus: this.#bus }),
			};
		}
		const only = (l1 ?? l2) as DriverFactory;
		if (this.#bus) {
			throw new Error(
				"Echo: a bus only means something with two layers — it keeps each instance's L1 in step. Add useL2Layer(), or drop useBus().",
			);
		}
		return { ...this.#options, driver: only };
	}
}

/** Start describing a store — AdonisJS's `store()`. */
export function store(options?: Omit<StoreConfig, "driver">): Store {
	return new Store(options);
}

/** Normalise either accepted form to the one the manager reads. */
function entryOf(config: StoreConfig | Store): StoreConfig {
	return config instanceof Store ? config.entry() : config;
}

/** Driver factory helpers (bento `drivers.memory` / `drivers.redis`). */
export const drivers = {
	/**
	 * `maxItems` bounds the store by COUNT, which a TTL cannot: a cache keyed by
	 * a user id or a search term grows until the process runs out of memory,
	 * however short each entry's life. Omit it for no ceiling.
	 */
	memory(options?: {
		sweepIntervalMs?: number;
		maxItems?: number;
	}): DriverFactory {
		return () => new MemoryDriver(options?.sweepIntervalMs, options?.maxItems);
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
	/**
	 * Redis pub/sub as the bus that keeps each instance's L1 in step.
	 *
	 * Named alongside `redis` and taking the same `connection`, because it is
	 * the same deployment decision: a two-layer store without a bus is wrong as
	 * soon as a second instance exists, each process serving its own L1 copy of
	 * a key another has already deleted.
	 */
	redisBus(options?: { connection?: string; channel?: string }): CacheBus {
		return quasarBus(options);
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
	/**
	 * Whether the application has been readied.
	 *
	 * Stores are created on first use, so one first touched by a request is
	 * created AFTER `ready()` has run — and nothing would have connected it.
	 */
	#connected = false;
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

		const declared = this.#config.stores[store];
		if (!declared) {
			throw new Error(`Echo: unknown cache store "${store}"`);
		}
		const cfg = entryOf(declared);
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
		// So `cache.use('other')` works on whichever store the provider
		// published — upstream's manager is one object that both operates on
		// the default store and reaches the named ones.
		manager.belongsTo(this);
		this.#built.set(store, manager);
		// Built after the application was readied: connect it now rather than
		// leave it the only store on no bus. `use()` is synchronous — upstream's
		// is too, and the README chains off it — so the manager's own
		// operations wait for this, and its failure costs staleness rather than
		// every read.
		if (this.#connected) manager.connect().catch(() => {});
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
	/**
	 * Open what every BUILT store needs outside the process.
	 *
	 * Stores are created on first use, so this reaches the ones the
	 * application has actually asked for — naming a Redis store in an
	 * environment that runs on memory still opens nothing.
	 */
	async connectAll(): Promise<void> {
		// Set FIRST, so a store built while this is in flight connects itself
		// rather than being missed by a walk that had already listed the built
		// ones.
		this.#connected = true;
		await Promise.all([...this.#built.values()].map((m) => m.connect()));
	}

	async disconnectAll(): Promise<void> {
		this.#connected = false;
		await Promise.all([...this.#built.values()].map((m) => m.disconnect()));
	}
}
