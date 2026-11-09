/**
 * What one namespace can reach of another, on the memory driver — the same
 * matrix the Redis integration suite runs, so both drivers agree.
 *
 * A namespace per tenant is the documented use, so every operation a tenant
 * can run on its own view must stay inside it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { CacheManager } from "../../src/CacheManager.js";
import { MemoryDriver } from "../../src/drivers/MemoryDriver.js";

const drivers: MemoryDriver[] = [];
function root(): CacheManager {
	const driver = new MemoryDriver();
	drivers.push(driver);
	return new CacheManager(driver);
}

afterEach(() => {
	for (const driver of drivers.splice(0)) driver.destroy();
});

describe("echo > namespace clear() with glob characters (bug 303)", () => {
	const cases: Array<{ cleared: string; siblings: string[] }> = [
		{ cleared: "tenant-*", siblings: ["tenant-abc", "tenant-xyz"] },
		{ cleared: "a?c", siblings: ["abc", "axc"] },
		{ cleared: "[ab]", siblings: ["a", "b"] },
		{ cleared: "a\\", siblings: ["a", "a\\b"] },
	];

	for (const { cleared, siblings } of cases) {
		it(`clearing "${cleared}" leaves ${siblings.join(", ")} intact`, async () => {
			const cache = root();
			for (const ns of siblings) {
				await cache.namespace(ns).set({ key: "doc", value: ns });
			}
			await cache.namespace(cleared).set({ key: "doc", value: "mine" });

			await cache.namespace(cleared).clear();

			expect(await cache.namespace(cleared).get({ key: "doc" })).toBe(
				undefined,
			);
			for (const ns of siblings) {
				expect(await cache.namespace(ns).get({ key: "doc" })).toBe(ns);
			}
		});
	}
});
