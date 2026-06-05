/**
 * Default `CacheManager` singleton — mirror of Adonis's
 * `import cache from '@adonisjs/cache/services/main'` shape.
 *
 * Populated by `EchoProvider.boot()` or by the app directly through
 * `_setCache(myManager)` when the cache wiring needs custom config.
 *
 *   import cache from '@c9up/echo/services/main'
 *
 *   await cache.set('user:42', user, 60)
 *   const cached = await cache.get<User>('user:42')
 */

import type { CacheManager } from "../CacheManager.js";

let _instance: CacheManager | undefined;

/** @internal Bind the singleton (called by EchoProvider or by the app). */
export function _setCache(instance: CacheManager): void {
	_instance = instance;
}

/** @internal Read the singleton (or `undefined` pre-boot). */
export function _getCache(): CacheManager | undefined {
	return _instance;
}

const cache: CacheManager = new Proxy({} as CacheManager, {
	get(_target, prop) {
		if (!_instance) {
			throw new Error(
				"[echo] CacheManager singleton accessed before EchoProvider.boot() ran " +
					"or `_setCache(myCache)` was called. Wire one of them first.",
			);
		}
		const value = Reflect.get(_instance, prop, _instance);
		return typeof value === "function" ? value.bind(_instance) : value;
	},
});

export default cache;
