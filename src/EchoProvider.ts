import { type CacheConfig, CacheManager } from "./CacheManager.js";
import { MemoryDriver } from "./drivers/MemoryDriver.js";
import { CacheStoreManager, type MultiStoreConfig } from "./StoreManager.js";
import { setCache } from "./services/main.js";
import type { CacheEmitter } from "./types.js";

/**
 * Duck-typed host context — echo stays publishable without importing
 * `@c9up/ream`. Any framework that exposes a Container + a config
 * store satisfies the contract.
 */
interface EchoContainer {
	singleton(token: unknown, factory: () => unknown): void;
	resolve<T = unknown>(token: unknown): T;
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

	#resolveEmitter(): CacheEmitter | undefined {
		try {
			const candidate = this.app.container.resolve<unknown>("emitter");
			if (isEmitter(candidate)) return candidate;
		} catch {
			// No emitter bound — events are simply not emitted.
		}
		return undefined;
	}

	register(): void {
		this.app.container.singleton(CacheManager, () => {
			const emitter = this.#resolveEmitter();
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
		this.app.container.singleton("cache", () =>
			this.app.container.resolve<CacheManager>(CacheManager),
		);
	}

	async boot(): Promise<void> {
		setCache(this.app.container.resolve<CacheManager>(CacheManager));
	}

	async shutdown(): Promise<void> {}
}
