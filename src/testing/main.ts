/**
 * `@c9up/echo/testing` — helpers for testing code that depends on the cache.
 *
 *   import { createTestCache } from "@c9up/echo/testing"
 *
 *   const { cache, events, dispose } = createTestCache()
 *   await cache.set({ key: "k", value: 1 })
 *   expect(events).toContainEqual({ event: "cache:written", payload: { key: "k", value: 1, store: "test" } })
 *   dispose()
 */

import { CacheManager } from "../CacheManager.js";
import { MemoryDriver } from "../drivers/MemoryDriver.js";
import type { Duration } from "../duration.js";
import type { CacheEmitter } from "../types.js";

/** A single recorded cache event. */
export interface RecordedEvent {
	event: string;
	payload: unknown;
}

export interface CreateTestCacheOptions {
	prefix?: string;
	/** Default TTL in seconds. */
	ttl?: number;
	grace?: Duration;
	name?: string;
}

export interface TestCache {
	/** A ready-to-use in-memory cache. */
	cache: CacheManager;
	/** The underlying driver (for direct assertions / setup). */
	driver: MemoryDriver;
	/** Every event emitted by the cache, in order. */
	events: RecordedEvent[];
	/** Stop the driver's sweep timer. Call in `afterEach`. */
	dispose(): void;
}

/**
 * Build an isolated in-memory {@link CacheManager} with a recording emitter, for
 * unit tests. Each call is fully isolated (fresh driver + event log).
 */
export function createTestCache(options?: CreateTestCacheOptions): TestCache {
	const driver = new MemoryDriver();
	const events: RecordedEvent[] = [];
	const emitter: CacheEmitter = {
		emit(event, payload) {
			events.push({ event, payload });
		},
	};
	const cache = new CacheManager(driver, {
		prefix: options?.prefix,
		ttl: options?.ttl,
		grace: options?.grace,
		name: options?.name ?? "test",
		emitter,
	});
	return {
		cache,
		driver,
		events,
		dispose() {
			driver.destroy();
		},
	};
}
