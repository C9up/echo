/**
 * A timeout either works or is refused — "never" must not mean "now".
 *
 * `setTimeout` clamps NaN, Infinity and anything above 2^31-1 ms to 1 ms, and
 * the durations reached it unchecked: `hardTimeout: Infinity` rejected every
 * getOrSet after a millisecond.
 */
import { afterEach, describe, expect, it } from "vitest";
import { CacheManager } from "../../src/CacheManager.js";
import { MemoryDriver } from "../../src/drivers/MemoryDriver.js";
import type { Duration } from "../../src/duration.js";

const created: MemoryDriver[] = [];
function cache(): CacheManager {
	const driver = new MemoryDriver();
	created.push(driver);
	return new CacheManager(driver);
}

afterEach(() => {
	for (const driver of created.splice(0)) driver.destroy();
});

const slow = (): Promise<string> =>
	new Promise((resolve) => setTimeout(() => resolve("done"), 50));

const invalid = expect.objectContaining({ code: "E_ECHO_INVALID_DURATION" });

type TimeoutOption = "hardTimeout" | "timeout" | "lockTimeout";
const options: TimeoutOption[] = ["hardTimeout", "timeout", "lockTimeout"];

describe("echo > timeouts out of setTimeout's range (bug 327)", () => {
	for (const option of options) {
		for (const value of [Number.POSITIVE_INFINITY, "25d", 2_147_484]) {
			it(`${option}: ${String(value)} lets a slow factory finish`, async () => {
				const c = cache();
				const settings: Partial<Record<TimeoutOption, Duration>> = {
					[option]: value,
				};
				await expect(
					c.getOrSet({ key: "k", factory: slow, ...settings }),
				).resolves.toBe("done");
			});
		}

		for (const value of [Number.NaN, -1, "-5s"]) {
			it(`${option}: ${String(value)} is refused`, async () => {
				const c = cache();
				const settings: Partial<Record<TimeoutOption, Duration>> = {
					[option]: value,
				};
				await expect(
					c.getOrSet({ key: "k", factory: slow, ...settings }),
				).rejects.toThrow(invalid);
			});
		}
	}

	it("a joiner with lockTimeout: Infinity waits for the leader", async () => {
		const c = cache();
		const leader = c.getOrSet({ key: "k", factory: slow });

		await expect(
			c.getOrSet({
				key: "k",
				factory: async () => "other",
				lockTimeout: Number.POSITIVE_INFINITY,
			}),
		).resolves.toBe("done");
		await leader;
	});

	it("a store default of Infinity behaves the same", async () => {
		const driver = new MemoryDriver();
		created.push(driver);
		const c = new CacheManager(driver, {
			hardTimeout: Number.POSITIVE_INFINITY,
		});
		await expect(c.getOrSet({ key: "k", factory: slow })).resolves.toBe("done");
	});
});
