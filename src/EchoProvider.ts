import { type CacheConfig, CacheManager } from "./CacheManager.js";
import { MemoryDriver } from "./drivers/MemoryDriver.js";
import { _setCache } from "./services/main.js";

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
	 * `_setCache(...)` from `@c9up/echo/services/main`.
	 *
	 * Default `"memory"`.
	 */
	driver?: "memory";
}

/**
 * EchoProvider — registers a default in-memory `CacheManager` so apps
 * that don't need Redis can `import cache from '@c9up/echo/services/main'`
 * and `await cache.get(...)` straight away.
 *
 *   // reamrc.ts
 *   providers: [() => import('@c9up/echo/provider')]
 *
 *   // config/cache.ts
 *   export default { driver: 'memory', prefix: 'myapp', ttl: 300 }
 *
 *   // anywhere
 *   import cache from '@c9up/echo/services/main'
 *   await cache.set('k', v, 60)
 */
export default class EchoProvider {
	constructor(protected app: EchoAppContext) {}

	register(): void {
		this.app.container.singleton(CacheManager, () => {
			const config = this.app.config.get<EchoProviderConfig>("cache");
			const driver = config?.driver ?? "memory";
			if (driver !== "memory") {
				throw new Error(
					`[echo] Unsupported driver '${driver}' for default provider — ` +
						"wire CacheManager yourself for non-memory drivers.",
				);
			}
			return new CacheManager(new MemoryDriver(), config);
		});
		this.app.container.singleton("cache", () =>
			this.app.container.resolve<CacheManager>(CacheManager),
		);
	}

	async boot(): Promise<void> {
		_setCache(this.app.container.resolve<CacheManager>(CacheManager));
	}

	async shutdown(): Promise<void> {}
}
