/**
 * Byte sizes for the memory driver's bounds — upstream takes a number of bytes
 * or a human string (`'10mb'`), in powers of 1024.
 */

import { EchoError } from "./errors.js";

const UNIT_BYTES: Record<string, number> = {
	b: 1,
	kb: 1024,
	mb: 1024 ** 2,
	gb: 1024 ** 3,
	tb: 1024 ** 4,
	pb: 1024 ** 5,
};

const BYTES_RE = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)?\s*$/i;

/**
 * A size in bytes, from a number of bytes or a string like `'512kb'`.
 *
 * @throws {EchoError} `E_ECHO_INVALID_CONFIG` for anything that is not a
 *   finite, non-negative size: a bound that cannot be read would otherwise
 *   leave the store silently unbounded.
 */
export function parseBytes(value: number | string, option: string): number {
	if (typeof value === "number") {
		if (Number.isFinite(value) && value >= 0) return value;
	} else {
		const match = BYTES_RE.exec(value);
		const factor = UNIT_BYTES[(match?.[2] ?? "b").toLowerCase()];
		if (match && factor !== undefined) return Number(match[1]) * factor;
	}
	throw new EchoError(
		"E_ECHO_INVALID_CONFIG",
		`Echo: ${option} must be a number of bytes or a size like '10mb' — got ${String(value)}`,
	);
}
