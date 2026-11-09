/**
 * The one place a cached value becomes the caller's `T`.
 *
 * A cache hands back what was written under a key. The type parameter of
 * `get<T>()` is the caller's statement of what that was — nothing the cache
 * can check, and upstream's `get<T>()` makes the same claim. It lives in this
 * one named function rather than as an assertion at every read site, so the
 * boundary is visible and there is exactly one of it.
 */
export function claimed<T>(value: unknown): T;
export function claimed(value: unknown): unknown {
	return value;
}

/** A timer handle that can be unreferenced — Node's, not the browser's. */
export function hasUnref(timer: unknown): timer is { unref(): void } {
	return (
		typeof timer === "object" &&
		timer !== null &&
		typeof Reflect.get(timer, "unref") === "function"
	);
}
