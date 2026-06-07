/**
 * Default `CacheManager` singleton — mirror of Adonis's
 * `import cache from '@adonisjs/cache/services/main'` shape.
 *
 * Populated by `EchoProvider.boot()` or by the app directly through
 * `setCache(myManager)` when the cache wiring needs custom config.
 *
 *   import cache from '@c9up/echo/services/main'
 *
 *   await cache.set('user:42', user, 60)
 *   const cached = await cache.get<User>('user:42')
 */

import type { CacheManager } from "../CacheManager.js";

let instance: CacheManager | undefined;

/** @internal Bind the singleton (called by EchoProvider or by the app). */
export function setCache(value: CacheManager): void {
	instance = value;
}

/** @internal Read the singleton (or `undefined` pre-boot). */
export function getCache(): CacheManager | undefined {
	return instance;
}

const cache: CacheManager = new Proxy({} as CacheManager, {
	get(_target, prop) {
		if (!instance) {
			throw new Error(
				"[echo] CacheManager singleton accessed before EchoProvider.boot() ran " +
					"or `setCache(myCache)` was called. Wire one of them first.",
			);
		}
		const value = Reflect.get(instance, prop, instance);
		return typeof value === "function" ? value.bind(instance) : value;
	},
});

export default cache;
