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

const DURATION_RE = /^\s*(-?\d+(?:\.\d+)?)\s*([a-z]+)?\s*$/i;

/**
 * Parse a human duration string (`'5m'`, `'300s'`, `'500ms'`) into seconds.
 * A unit-less numeric string is interpreted as seconds.
 */
export function parseDuration(value: string): number {
	const match = DURATION_RE.exec(value);
	if (!match) {
		throw new TypeError(`Echo: invalid duration string "${value}"`);
	}
	const amount = Number(match[1]);
	const unit = match[2]?.toLowerCase();
	if (unit === undefined) return amount;
	const factor = UNIT_SECONDS[unit];
	if (factor === undefined) {
		throw new TypeError(`Echo: unknown duration unit "${unit}" in "${value}"`);
	}
	return amount * factor;
}

/**
 * Resolve a {@link Duration} to a TTL in **seconds**.
 *
 * @returns the TTL in seconds; `0` means "never expires" (either an explicit
 *   `null`, or a non-positive value, matching echo's driver convention where
 *   `ttlSeconds <= 0` is treated as immortal).
 */
export function resolveTtlSeconds(
	ttl: Duration | undefined,
	defaultSeconds: number,
): number {
	if (ttl === null) return 0;
	if (ttl === undefined) return defaultSeconds;
	const seconds = typeof ttl === "number" ? ttl : parseDuration(ttl);
	return seconds > 0 ? seconds : 0;
}
