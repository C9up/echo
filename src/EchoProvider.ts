import "./augmentations.js";
import { type CacheConfig, CacheManager } from "./CacheManager.js";
import { MemoryDriver } from "./drivers/MemoryDriver.js";
import { CacheStoreManager, type MultiStoreConfig } from "./StoreManager.js";
import { clearCache, getCache, setCache } from "./services/main.js";
import type { CacheEmitter } from "./types.js";

/**
 * Duck-typed host context — echo stays publishable without importing
 * `@c9up/ream`. Any framework that exposes a Container + a config
 * store satisfies the contract.
 */
interface EchoContainer {
	singleton(token: unknown, factory: () => unknown): void;
	resolve<T = unknown>(token: unknown): Promise<T>;
}
interface EchoConfigStore {
	get<T = unknown>(key: string): T | undefined;
}
export interface EchoAppContext {
	container: EchoContainer;
	config: EchoConfigStore;
}

export interface EchoProviderConfig extends CacheConfig {
	/**
	 * Driver to bind by default. Only `"memory"` is created
	 * automatically — other drivers (Redis etc.) need custom client
	 * wiring, so apps build the `CacheManager` themselves and call
	 * `setCache(...)` from `@c9up/echo/services/main`, or use the
	 * multi-store `{ default, stores }` config with `drivers.*`.
	 *
	 * Default `"memory"`.
	 */
	driver?: "memory";
}

function isEmitter(value: unknown): value is CacheEmitter {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "emit") === "function"
	);
}

function isMultiStoreConfig(value: unknown): value is MultiStoreConfig {
	return (
		typeof value === "object" &&
		value !== null &&
		"stores" in value &&
		"default" in value
	);
}

/**
 * EchoProvider — registers a `CacheManager` (single-store default, or the
 * default store of a `{ default, stores }` config) so apps can
 * `import cache from '@c9up/echo/services/main'` and use it straight away. If
 * the host container exposes an `emitter`, cache events (`cache:hit` / `miss` /
 * `written` / `deleted` / `cleared`) are wired through it.
 *
 *   // reamrc.ts
 *   providers: [() => import('@c9up/echo/provider')]
 *
 *   // config/cache.ts  (single store)
 *   export default { driver: 'memory', prefix: 'myapp', ttl: 300 }
 *
 *   // config/cache.ts  (multi-store)
 *   export default defineConfig({
 *     default: 'memory',
 *     stores: { memory: { driver: drivers.memory() } },
 *   })
 */
export default class EchoProvider {
	constructor(protected app: EchoAppContext) {}

	async #resolveEmitter(): Promise<CacheEmitter | undefined> {
		try {
			const candidate = await this.app.container.resolve<unknown>("emitter");
			if (isEmitter(candidate)) return candidate;
		} catch {
			// No emitter bound — events are simply not emitted.
		}
		return undefined;
	}

	register(): void {
		this.app.container.singleton(CacheManager, async () => {
			const emitter = await this.#resolveEmitter();
			const raw = this.app.config.get<unknown>("cache");

			if (isMultiStoreConfig(raw)) {
				const manager = new CacheStoreManager({ ...raw, emitter });
				return manager.use();
			}

			const config = (raw ?? {}) as EchoProviderConfig;
			const driver = config.driver ?? "memory";
			if (driver !== "memory") {
				throw new Error(
					`[echo] Unsupported driver '${driver}' for default provider — ` +
						"wire CacheManager yourself for non-memory drivers, or use the " +
						"multi-store `{ default, stores }` config.",
				);
			}
			return new CacheManager(new MemoryDriver(), { ...config, emitter });
		});
		// Namespaced by the package that owns it, the way upstream namespaces
		// `lucid.db`, `auth.manager` and `drive.manager` by theirs. The bare
		// token stays bound beside it: it is what every existing
		// `container.make(...)` asks for, and a token is not worth breaking an
		// application over.
		const cache = (): Promise<CacheManager> =>
			this.app.container.resolve<CacheManager>(CacheManager);
		this.app.container.singleton("echo.cache", cache);
		this.app.container.singleton("cache", cache);
	}

	/** The cache THIS provider opened — not whatever the module singleton holds. */
	#cache: CacheManager | undefined;

	/**
	 * Build the cache and publish it on `services/main` — in `ready`, not `boot`.
	 *
	 * Constructing it is not free: a tiered store SUBSCRIBES to its bus the
	 * moment it exists, which opens a Redis connection. `register`, `boot` and
	 * `start` all run during an inspection — a route listing, a codegen pass —
	 * and `shutdown` does not, so a cache built there was a subscriber and a
	 * connection left behind by a command that only meant to look.
	 *
	 * `ready` is the phase upstream reserves for exactly that, and the one an
	 * inspection never reaches. `services/main` resolves lazily through a
	 * proxy, so anything that USES the cache while serving still finds it; only
	 * code that reaches for it during a preload's own module evaluation would
	 * now be too early, and the accessor says so by name.
	 */
	async ready(): Promise<void> {
		this.#cache = await this.app.container.resolve<CacheManager>(CacheManager);
		setCache(this.#cache);
	}

	/**
	 * Release the cache the app opened.
	 *
	 * The memory driver runs a sweep on a timer and the redis driver holds a
	 * connection. Neither is released on its own, so across a dev reload or a
	 * test run each cycle leaves another one behind.
	 */
	async shutdown(): Promise<void> {
		if (!this.#cache) return;
		await this.#cache.disconnect();
		// Two applications can share a process — parallel tests, a hot reload.
		// The module singleton holds whichever booted last, so it is only ours
		// to clear while it still points at the cache this provider booted.
		if (getCache() === this.#cache) clearCache();
		this.#cache = undefined;
	}
}
