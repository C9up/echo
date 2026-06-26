/**
 * @c9up/echo — Cache layer for the Ream framework.
 *
 * Provides get/set/delete/clear/getOrSet/namespace/tags with pluggable drivers
 * (Memory, Redis).
 *
 * @implements MISS-10
 */

export type { CacheConfig, CacheDriver } from "./CacheManager.js";
export { CacheManager } from "./CacheManager.js";
export { MemoryDriver } from "./drivers/MemoryDriver.js";
export type { RedisClient } from "./drivers/RedisDriver.js";
export { RedisDriver } from "./drivers/RedisDriver.js";
export type { EchoProviderConfig } from "./EchoProvider.js";

import type { EchoProviderConfig } from "./EchoProvider.js";

/**
 * Author-time config helper for `config/cache.ts` — AdonisJS cache `defineConfig`
 * parity. Identity at runtime; the generic preserves literal types for inference.
 */
export function defineConfig<T extends EchoProviderConfig>(config: T): T {
	return config;
}
