/**
 * Duration parsing — bentocache `Duration` parity, adapted to echo's
 * seconds-native driver layer.
 *
 * DIVERGENCE (named): bentocache treats a bare `number` as **milliseconds**.
 * Echo's drivers, positional API (`set(key, value, ttlSeconds)`) and the
 * kitchen-sink app are all **seconds-native**, so a bare `number` here means
 * **seconds**. Keeping one unit across the positional and object forms avoids
 * a dual-unit footgun (cf. DNR `helpers_no_magic_layer`). String durations use
 * the same human syntax as bento (`'5m'`, `'300s'`, `'2h'`, `'500ms'`).
 */

/**
 * A cache duration:
 * - `number` — seconds (echo-native; see divergence note above)
 * - `string` — human duration (`'5m'`, `'2h'`, `'1d'`, `'500ms'`, …)
 * - `null`   — never expires
 */
export type Duration = number | string | null;

const UNIT_SECONDS: Record<string, number> = {
	ms: 1 / 1000,
	msec: 1 / 1000,
	msecs: 1 / 1000,
	millisecond: 1 / 1000,
	milliseconds: 1 / 1000,
	s: 1,
	sec: 1,
	secs: 1,
	second: 1,
	seconds: 1,
	m: 60,
	min: 60,
	mins: 60,
	minute: 60,
	minutes: 60,
	h: 3600,
	hr: 3600,
	hrs: 3600,
	hour: 3600,
	hours: 3600,
	d: 86_400,
	day: 86_400,
	days: 86_400,
	w: 604_800,
	week: 604_800,
	weeks: 604_800,
};

import { InvalidDurationError } from "./errors.js";

const DURATION_RE = /^\s*(-?\d+(?:\.\d+)?)\s*([a-z]+)?\s*$/i;

/**
 * Parse a human duration string (`'5m'`, `'300s'`, `'500ms'`) into seconds.
 * A unit-less numeric string is interpreted as seconds.
 */
export function parseDuration(value: string): number {
	const match = DURATION_RE.exec(value);
	if (!match) {
		throw new InvalidDurationError(`Echo: invalid duration string "${value}"`);
	}
	const amount = Number(match[1]);
	const unit = match[2]?.toLowerCase();
	if (unit === undefined) return amount;
	const factor = UNIT_SECONDS[unit];
	if (factor === undefined) {
		throw new InvalidDurationError(
			`Echo: unknown duration unit "${unit}" in "${value}"`,
		);
	}
	return amount * factor;
}

/**
 * Resolve a {@link Duration} to a TTL in **seconds**.
 *
 * @returns the TTL in seconds. `0` means "never expires" — an explicit
 *   `null`, a `0` or `Infinity`. A NEGATIVE result is kept negative: a TTL in
 *   the past means already expired, and the writers drop the entry rather
 *   than store it. It used to map to `0`, so a TTL computed from data — a
 *   token that had already expired — cached its value forever.
 * @throws {InvalidDurationError} for NaN, which means nothing at all.
 */
export function resolveTtlSeconds(
	ttl: Duration | undefined,
	defaultSeconds: number,
): number {
	if (ttl === null) return 0;
	if (ttl === undefined) return defaultSeconds;
	return checkTtlSeconds(typeof ttl === "number" ? ttl : parseDuration(ttl));
}

/**
 * The driver-level reading of a TTL in seconds: `undefined`, `0` and
 * `Infinity` never expire, a negative one has already expired, NaN is
 * refused. Shared by the manager and the drivers, so a driver called directly
 * cannot turn a NaN into an entry that never expires either.
 */
export function checkTtlSeconds(seconds: number): number {
	if (Number.isNaN(seconds)) {
		throw new InvalidDurationError(
			"Echo: a TTL of NaN is not a duration — pass a number of seconds, a string like '5m', or null for no expiry",
		);
	}
	return seconds === Number.POSITIVE_INFINITY ? 0 : seconds;
}
