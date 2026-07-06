/**
 * Echo cache errors — bentocache parity (`errors.ts`).
 */

/** Raised when a factory exceeds its configured `hardTimeout`. */
export class TimeoutError extends Error {
	constructor(key: string, timeoutMs: number) {
		super(`Echo: factory for "${key}" timed out after ${timeoutMs}ms`);
		this.name = "TimeoutError";
	}
}

/**
 * Wraps an error thrown by a `getOrSet` factory. Passed to `onFactoryError`
 * so callers can observe both foreground and background factory failures.
 */
export class FactoryError extends Error {
	/** The cache key the factory was computing. */
	readonly key: string;
	/** The original error thrown by the factory. */
	override readonly cause: unknown;
	/** `true` when the factory was running in the background (soft timeout / refresh). */
	readonly isBackground: boolean;

	constructor(key: string, cause: unknown, isBackground: boolean) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		super(`Echo: factory for "${key}" failed: ${reason}`);
		this.name = "FactoryError";
		this.key = key;
		this.cause = cause;
		this.isBackground = isBackground;
	}
}
