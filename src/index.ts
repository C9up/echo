/**
 * @c9up/echo — Cache layer for the Ream framework.
 *
 * bentocache / @adonisjs/cache parity: object-argument API, grace
 * (stale-while-revalidate), soft/hard timeouts, tags, multi-tier (L1+L2) and
 * multi-store (`{ default, stores }` + `use(name)`) — over pluggable drivers
 * (Memory, Redis, Tiered).
 *
 * @implements MISS-10
 */

export type { CacheConfig, CacheDriver } from "./CacheManager.js";
export { CacheManager } from "./CacheManager.js";
export { MemoryDriver } from "./drivers/MemoryDriver.js";
export type { RedisClient } from "./drivers/RedisDriver.js";
export { RedisDriver } from "./drivers/RedisDriver.js";
export type {
	BusMessage,
	CacheBus,
	TieredDriverOptions,
} from "./drivers/TieredDriver.js";
export { TieredDriver } from "./drivers/TieredDriver.js";
export type { Duration } from "./duration.js";
export { parseDuration, resolveTtlSeconds } from "./duration.js";
export type { EchoProviderConfig } from "./EchoProvider.js";
export { FactoryError, TimeoutError } from "./errors.js";
export {
	CacheStoreManager,
	type DriverFactory,
	drivers,
	type MultiStoreConfig,
	type StoreConfig,
} from "./StoreManager.js";
export type {
	CacheEmitter,
	CacheEntry,
	CacheEventMap,
	DefaultValue,
	DeleteByTagOptions,
	DeleteManyOptions,
	DeleteOptions,
	ExpireOptions,
	Factory,
	GetOptions,
	GetOrSetForeverOptions,
	GetOrSetOptions,
	HasOptions,
	SetOptions,
	TaggableDriver,
} from "./types.js";

import type { EchoProviderConfig } from "./EchoProvider.js";
import type { MultiStoreConfig } from "./StoreManager.js";

/**
 * Author-time config helper for `config/cache.ts` — AdonisJS cache `defineConfig`
 * parity. Identity at runtime; the generic preserves literal types for inference.
 * Accepts both the single-store {@link EchoProviderConfig} and the multi-store
 * {@link MultiStoreConfig} (`{ default, stores }`) shapes.
 */
export function defineConfig<T extends EchoProviderConfig | MultiStoreConfig>(
	config: T,
): T {
	return config;
}
