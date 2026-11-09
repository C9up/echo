/**
 * Echo cache errors — bentocache parity (`errors.ts`).
 *
 * Every error carries a `code`. Upstream's are kept verbatim
 * (`E_FACTORY_ERROR`, `E_FACTORY_HARD_TIMEOUT`, `E_UNDEFINED_VALUE`,
 * `E_L2_CACHE_ERROR`): code written against a cache module already catches on
 * them. Failures echo invents carry the `E_ECHO_` namespace.
 */

/**
 * Base class for the errors echo raises with a code of its own, so a caller
 * can match on `error.code`.
 */
export class EchoError extends Error {
	readonly code: string;

	constructor(code: string, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
		this.code = code;
	}
}

/**
 * Raised for a duration that cannot mean anything: NaN, or a string the
 * parser does not read. A `TypeError`, as the parser's refusals always were.
 */
export class InvalidDurationError extends TypeError {
	readonly code = "E_ECHO_INVALID_DURATION";

	constructor(message: string) {
		super(message);
		this.name = "InvalidDurationError";
	}
}

/**
 * Raised when a caller waited `lockTimeout` on another caller's factory for
 * the same key, had no stale value to fall back on, and gave up.
 */
export class LockTimeoutError extends EchoError {
	/** The cache key whose lock was not obtained. */
	readonly key: string;

	constructor(key: string, timeoutMs: number) {
		super(
			"E_ECHO_LOCK_TIMEOUT",
			`Echo: waited ${timeoutMs}ms for another caller's factory for "${key}" and gave up`,
		);
		this.key = key;
	}
}

/**
 * Raised when a tiered store's L2 fails and the failure is not suppressed
 * (upstream `E_L2_CACHE_ERROR`, kept verbatim). `cause` is the L2's error.
 */
export class L2CacheError extends EchoError {
	constructor(operation: string, cause: unknown) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		super(
			"E_L2_CACHE_ERROR",
			`Echo: the L2 cache failed during ${operation}: ${reason}`,
			{ cause },
		);
	}
}

/** Raised when a factory exceeds its configured `hardTimeout`. */
export class TimeoutError extends EchoError {
	constructor(key: string, timeoutMs: number) {
		super(
			"E_FACTORY_HARD_TIMEOUT",
			`Echo: factory for "${key}" timed out after ${timeoutMs}ms`,
		);
	}
}

/**
 * Wraps an error thrown by a `getOrSet` factory. Passed to `onFactoryError`
 * so callers can observe both foreground and background factory failures.
 */
export class FactoryError extends EchoError {
	/** The cache key the factory was computing. */
	readonly key: string;
	/** The original error thrown by the factory. */
	override readonly cause: unknown;
	/** `true` when the factory was running in the background (soft timeout / refresh). */
	readonly isBackground: boolean;

	constructor(key: string, cause: unknown, isBackground: boolean) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		super("E_FACTORY_ERROR", `Echo: factory for "${key}" failed: ${reason}`);
		this.key = key;
		this.cause = cause;
		this.isBackground = isBackground;
	}
}

/**
 * Raised for a `null` or `undefined` value — upstream's `E_UNDEFINED_VALUE`.
 * A `TypeError`, as this refusal always was. Echo refuses `null` as well: a
 * null cache write is almost always a bug.
 */
export class UndefinedValueError extends TypeError {
	readonly code = "E_UNDEFINED_VALUE";

	constructor() {
		super("Echo: caching null/undefined values is not supported");
		this.name = "UndefinedValueError";
	}
}

/** Raised for an argument a method cannot work with. A `TypeError`. */
export class InvalidArgumentError extends TypeError {
	readonly code = "E_ECHO_INVALID_ARGUMENT";

	constructor(message: string) {
		super(message);
		this.name = "InvalidArgumentError";
	}
}

/** Upstream's `errors` map, by code. */
export const errors = {
	E_FACTORY_ERROR: FactoryError,
	E_FACTORY_HARD_TIMEOUT: TimeoutError,
	E_UNDEFINED_VALUE: UndefinedValueError,
	E_L2_CACHE_ERROR: L2CacheError,
};
