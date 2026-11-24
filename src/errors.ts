/**
 * Echo cache errors, one per code.
 *
 * Upstream's codes, shapes and messages are kept verbatim (`E_FACTORY_ERROR`,
 * `E_FACTORY_SOFT_TIMEOUT`, `E_FACTORY_HARD_TIMEOUT`, `E_UNDEFINED_VALUE`,
 * `E_L2_CACHE_ERROR`): code
 * written against a cache module already catches on them, and
 * `errors.E_FACTORY_ERROR` reads as it does upstream. Failures echo invents
 * carry the `E_ECHO_` namespace.
 */
import { createError, Exception } from "@c9up/flare";

/**
 * Wraps an error thrown by a `getOrSet` factory. Passed to `onFactoryError`
 * so callers can observe both foreground and background factory failures.
 * The factory's own error is `cause`.
 */
export class E_FACTORY_ERROR extends Exception {
	static override code = "E_FACTORY_ERROR";
	static override message = "Factory has thrown an error";

	/** The cache key the factory was computing. */
	readonly key: string;
	/** `true` when the factory was running in the background (soft timeout / refresh). */
	readonly isBackgroundFactory: boolean;

	constructor(key: string, cause: unknown, isBackground = false) {
		super(E_FACTORY_ERROR.message, { cause });
		this.key = key;
		this.isBackgroundFactory = isBackground;
	}
}

/**
 * A factory outran the soft timeout while a stale value was there to serve.
 *
 * Upstream throws it from its factory runner and catches it in the same
 * `getOrSet` to serve the stale value, so it never reaches the caller. Echo's
 * soft timeout serves the stale value directly and does not raise it; the
 * class is here so code that tests `instanceof errors.E_FACTORY_SOFT_TIMEOUT`
 * keeps compiling.
 */
export class E_FACTORY_SOFT_TIMEOUT extends Exception {
	static override code = "E_FACTORY_SOFT_TIMEOUT";
	static override message =
		"Factory has timed out after waiting for soft timeout";

	/** The cache key the factory was computing. */
	readonly key: string;

	constructor(key: string) {
		super(E_FACTORY_SOFT_TIMEOUT.message);
		this.key = key;
	}
}

/** A factory exceeded its configured `hardTimeout`. */
export class E_FACTORY_HARD_TIMEOUT extends Exception {
	static override code = "E_FACTORY_HARD_TIMEOUT";
	static override message =
		"Factory has timed out after waiting for hard timeout";

	/** The cache key the factory was computing. */
	readonly key: string;

	constructor(key: string) {
		super(E_FACTORY_HARD_TIMEOUT.message);
		this.key = key;
	}
}

/**
 * An `undefined` value was given to the cache.
 *
 * Deliberate deviation: echo refuses `null` as well, under the same code and
 * message — a null cache write is almost always a bug, and reading it back is
 * indistinguishable from a miss.
 */
export class E_UNDEFINED_VALUE extends Exception {
	static override code = "E_UNDEFINED_VALUE";

	constructor(key: string) {
		super(`Cannot set undefined value in the cache, key: ${key}`);
	}
}

/**
 * A tiered store's L2 failed and the failure is not suppressed. `cause` is
 * the L2's error; the operation that failed is on `operation`.
 */
export class E_L2_CACHE_ERROR extends Exception {
	static override code = "E_L2_CACHE_ERROR";
	static override message =
		"An error occurred while interacting with the L2 cache";

	/** The L2 operation that failed: `get`, `set`, `delete`, ... */
	readonly operation: string | undefined;

	constructor(cause: unknown, options?: { operation?: string }) {
		super(E_L2_CACHE_ERROR.message, { cause });
		this.operation = options?.operation;
	}
}

/**
 * A caller waited `lockTimeout` on another caller's factory for the same key,
 * had no stale value to fall back on, and gave up.
 */
export class E_ECHO_LOCK_TIMEOUT extends Exception {
	static override code = "E_ECHO_LOCK_TIMEOUT";

	/** The cache key whose lock was not obtained. */
	readonly key: string;

	constructor(key: string, timeoutMs: number) {
		super(
			`Echo: waited ${timeoutMs}ms for another caller's factory for "${key}" and gave up`,
		);
		this.key = key;
	}
}

/** A duration that cannot mean anything: NaN, or a string the parser does not read. */
export const E_ECHO_INVALID_DURATION = createError<[string]>(
	"Echo: %s",
	"E_ECHO_INVALID_DURATION",
);

/** A method received an argument it cannot work with. */
export const E_ECHO_INVALID_ARGUMENT = createError<[string]>(
	"Echo: %s",
	"E_ECHO_INVALID_ARGUMENT",
);

/** A cache or store config that cannot be used as given. */
export const E_ECHO_INVALID_CONFIG = createError<[string]>(
	"%s",
	"E_ECHO_INVALID_CONFIG",
);

/** A store name that the config does not declare. */
export const E_ECHO_UNKNOWN_STORE = createError<[string]>(
	"Echo: %s",
	"E_ECHO_UNKNOWN_STORE",
);

/** The default provider was configured with a driver it cannot build. */
export const E_ECHO_UNSUPPORTED_DRIVER = createError<[string]>(
	"[echo] Unsupported driver '%s' for default provider — wire CacheManager " +
		"yourself for non-memory drivers, or use the multi-store " +
		"`{ default, stores }` config.",
	"E_ECHO_UNSUPPORTED_DRIVER",
);

/** Tag-based invalidation on a driver that does not support it. */
export const E_ECHO_NOT_TAGGABLE = createError<[string]>(
	"Echo: %s",
	"E_ECHO_NOT_TAGGABLE",
);

/** The memory driver was given a value with no JSON form while serializing. */
export const E_ECHO_UNSERIALIZABLE_VALUE = createError(
	"Echo: the memory driver stores values as JSON, and this one has no JSON " +
		"form — pass `serialize: false` to keep it as is",
	"E_ECHO_UNSERIALIZABLE_VALUE",
);

/** `RedisDriver.flush()` on a client without `scan()`. */
export const E_ECHO_SCAN_UNSUPPORTED = createError(
	"Echo: RedisDriver.flush() requires a client with scan() support. KEYS is " +
		"not safe for production use.",
	"E_ECHO_SCAN_UNSUPPORTED",
);

/** A Redis store or bus needs `@c9up/quasar`, and it is not installed. */
export const E_ECHO_QUASAR_MISSING = createError<[string]>(
	"%s",
	"E_ECHO_QUASAR_MISSING",
);

/** The quasar connection lacks a command the store or the bus needs. */
export const E_ECHO_INCOMPLETE_CONNECTION = createError<[string]>(
	"%s",
	"E_ECHO_INCOMPLETE_CONNECTION",
);

/** The quasar cache bus reported a subscribe failure that is not an `Error`. */
export const E_ECHO_BUS_SUBSCRIBE_FAILED = createError<[string]>(
	"Echo: subscribing to the cache bus failed: %s",
	"E_ECHO_BUS_SUBSCRIBE_FAILED",
);

/** The `CacheManager` singleton was used before it was wired. */
export const E_ECHO_NOT_BOOTED = createError(
	"[echo] CacheManager singleton accessed before EchoProvider.boot() ran or " +
		"`setCache(myCache)` was called. Wire one of them first.",
	"E_ECHO_NOT_BOOTED",
);
