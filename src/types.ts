/**
 * Shared cache contracts — driver interface, stored-entry shape, method option
 * objects (bentocache/@adonisjs/cache parity) and the event emitter contract.
 */

import type { Duration } from "./duration.js";
import type { FactoryError } from "./errors.js";

/**
 * A driver-level entry. `stale` is `true` when the value is past its logical
 * TTL but still retained under the grace period (stale-while-revalidate).
 */
export interface CacheEntry<T = unknown> {
	value: T;
	stale: boolean;
}

/** Options for the grace-aware {@link CacheDriver.setEntry}. */
export interface DriverSetOptions {
	/** Logical TTL in seconds; `0`/omitted means never expires. */
	ttlSeconds?: number;
	/** Extra retention beyond the logical TTL, in seconds (grace period). */
	graceSeconds?: number;
	/** Tags for grouped invalidation (only honoured by taggable drivers). */
	tags?: string[];
}

/**
 * Cache driver contract.
 *
 * The five core methods (`get`/`set`/`delete`/`flush`/`has`) are the minimal
 * surface — any KV store satisfies them. `getEntry`/`setEntry` are the optional
 * grace-aware extensions; {@link CacheManager} falls back to `get`/`set` when a
 * driver doesn't implement them, so grace simply degrades to "no stale window"
 * on minimal drivers (agnostic-friendly).
 */
export interface CacheDriver {
	get<T = unknown>(key: string): Promise<T | null>;
	set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
	delete(key: string): Promise<boolean>;
	flush(): Promise<void>;
	has(key: string): Promise<boolean>;
	/** Grace-aware read: returns the entry even if stale, or `null` if physically gone. */
	getEntry?<T = unknown>(key: string): Promise<CacheEntry<T> | null>;
	/** Grace-aware write. */
	setEntry?(
		key: string,
		value: unknown,
		options: DriverSetOptions,
	): Promise<void>;
}

/** A driver that supports tag-based grouped invalidation. */
export interface TaggableDriver extends CacheDriver {
	setWithTags(
		key: string,
		value: unknown,
		tags: string[],
		ttlSeconds?: number,
	): Promise<void>;
	/** Invalidate every entry carrying any of the given tags (bento `deleteByTag`). */
	deleteByTag(tags: string[]): Promise<void>;
	/** @deprecated alias of {@link deleteByTag} (echo pre-0.2 name). */
	flushTags(tags: string[]): Promise<void>;
}

/** A `getOrSet` factory. */
export type Factory<T> = () => T | Promise<T>;

/** A lazily-resolved default value for `get`. */
export type DefaultValue<T> = T | (() => T);

export interface GetOptions<T = unknown> {
	key: string;
	defaultValue?: DefaultValue<T>;
	grace?: Duration;
}

export interface SetOptions {
	key: string;
	value: unknown;
	ttl?: Duration;
	grace?: Duration;
	tags?: string[];
}

export interface GetOrSetOptions<T> {
	key: string;
	factory: Factory<T>;
	ttl?: Duration;
	grace?: Duration;
	/** Soft timeout: on a stale hit, return the stale value if the factory is slower, then refresh in the background. */
	timeout?: Duration;
	/** Hard timeout: reject with {@link TimeoutError} if the factory exceeds it (even without a stale fallback). */
	hardTimeout?: Duration;
	/** Max time to wait on another caller's in-flight factory before falling back to stale (single-flight lock). */
	lockTimeout?: Duration;
	tags?: string[];
	/** Observe factory failures (foreground and background). */
	onFactoryError?: (error: FactoryError) => void;
}

export type GetOrSetForeverOptions<T> = Omit<GetOrSetOptions<T>, "ttl">;

export interface DeleteOptions {
	key: string;
}
export interface DeleteManyOptions {
	keys: string[];
}
export interface DeleteByTagOptions {
	tags: string[];
}
export interface HasOptions {
	key: string;
}
export interface ExpireOptions {
	key: string;
}

/** Payloads for each emitted cache event (bento event-name parity). */
export interface CacheEventMap {
	"cache:hit": {
		key: string;
		value: unknown;
		store: string;
		graced: boolean;
	};
	"cache:miss": { key: string; store: string };
	"cache:written": { key: string; value: unknown; store: string };
	"cache:deleted": { key: string; store: string };
	"cache:cleared": { store: string };
}

/**
 * Duck-typed event emitter — any object exposing `emit(event, payload)` works
 * (ream's emitter, Node's EventEmitter, mitt, …). echo never imports one.
 */
export interface CacheEmitter {
	emit(event: string, payload: unknown): void;
}
