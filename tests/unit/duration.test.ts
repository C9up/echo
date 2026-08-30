/**
 * Duration parsing and the factory error.
 *
 * Every TTL in the package goes through `resolveTtlSeconds`, and the one value
 * that matters most is the one that means "never": a `0` produced by accident
 * makes an entry immortal, and nothing downstream can tell that apart from a
 * deliberate one.
 */
import { describe, expect, it } from "vitest";
import { parseDuration, resolveTtlSeconds } from "../../src/duration.js";
import { FactoryError } from "../../src/errors.js";

describe("echo > parsing a duration", () => {
	it("reads each unit, under every spelling it accepts", () => {
		for (const [written, seconds] of [
			["500ms", 0.5],
			["500 msec", 0.5],
			["500msecs", 0.5],
			["500 milliseconds", 0.5],
			["30s", 30],
			["30 sec", 30],
			["30secs", 30],
			["30 seconds", 30],
			["5m", 300],
			["5 min", 300],
			["5mins", 300],
			["5 minutes", 300],
			["2h", 7200],
			["2 hr", 7200],
		] as Array<[string, number]>) {
			expect(parseDuration(written), written).toBeCloseTo(seconds, 6);
		}
	});

	it("reads a bare number as seconds", () => {
		expect(parseDuration("30")).toBe(30);
		expect(parseDuration("  30  ")).toBe(30);
	});

	it("reads a fractional and a negative amount", () => {
		expect(parseDuration("1.5m")).toBe(90);
		expect(parseDuration("-30s")).toBe(-30);
	});

	it("ignores the case of the unit", () => {
		expect(parseDuration("5M")).toBe(300);
		expect(parseDuration("2H")).toBe(7200);
	});

	it("names the unit it does not know instead of guessing", () => {
		// Guessing would silently cache for the wrong length of time.
		expect(() => parseDuration("5 fortnights")).toThrow(
			/unknown duration unit "fortnights"/,
		);
	});

	it("refuses a string that is not a duration", () => {
		for (const bad of ["", "soon", "5m5s", "m"]) {
			expect(() => parseDuration(bad), bad).toThrow(/invalid duration string/);
		}
	});
});

describe("echo > resolving a TTL", () => {
	it("takes a number as seconds and a string through the parser", () => {
		expect(resolveTtlSeconds(30, 60)).toBe(30);
		expect(resolveTtlSeconds("5m", 60)).toBe(300);
	});

	it("falls back to the default only when nothing was said", () => {
		expect(resolveTtlSeconds(undefined, 60)).toBe(60);
	});

	it("reads an explicit null as never expiring", () => {
		expect(resolveTtlSeconds(null, 60)).toBe(0);
	});

	it("reads a non-positive TTL as never expiring too", () => {
		// The drivers treat `0` as immortal, so a zero or a negative has to
		// arrive as that one value rather than as a TTL already in the past.
		expect(resolveTtlSeconds(0, 60)).toBe(0);
		expect(resolveTtlSeconds(-5, 60)).toBe(0);
		expect(resolveTtlSeconds("-5s", 60)).toBe(0);
	});
});

describe("echo > the factory error", () => {
	it("names the key and carries the original failure", () => {
		const cause = new Error("upstream down");
		const error = new FactoryError("users:7", cause, false);

		expect(error.message).toBe(
			'Echo: factory for "users:7" failed: upstream down',
		);
		expect(error.name).toBe("FactoryError");
		expect(error.key).toBe("users:7");
		expect(error.cause).toBe(cause);
		expect(error.isBackground).toBe(false);
	});

	it("reads a thrown non-error too", () => {
		const error = new FactoryError("k", "just a string", true);

		expect(error.message).toContain("just a string");
		expect(error.cause).toBe("just a string");
		// A background refresh failing is not the same event as a foreground
		// miss failing, and the handler has to be able to tell them apart.
		expect(error.isBackground).toBe(true);
	});
});
