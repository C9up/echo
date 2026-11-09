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

describe("echo > tags are scoped to their namespace (bug 306)", () => {
	it("deleteByTag in one namespace leaves another namespace's entries", async () => {
		const cache = root();
		const a = cache.namespace("tenantA");
		const b = cache.namespace("tenantB");
		await a.set({ key: "profile", value: "A", tags: ["user:1"] });
		await b.set({ key: "profile", value: "B", tags: ["user:1"] });

		await a.deleteByTag({ tags: ["user:1"] });

		expect(await a.get({ key: "profile" })).toBeUndefined();
		expect(await b.get({ key: "profile" })).toBe("B");
	});

	it("a root deleteByTag does not reach into a namespace", async () => {
		const cache = root();
		await cache.set({ key: "profile", value: "root", tags: ["user:1"] });
		await cache
			.namespace("tenantA")
			.set({ key: "profile", value: "A", tags: ["user:1"] });

		await cache.deleteByTag({ tags: ["user:1"] });

		expect(await cache.get({ key: "profile" })).toBeUndefined();
		expect(await cache.namespace("tenantA").get({ key: "profile" })).toBe("A");
	});

	it("setWithTags and getOrSet tag inside the namespace too", async () => {
		const cache = root();
		const a = cache.namespace("tenantA");
		const b = cache.namespace("tenantB");
		await a.setWithTags("doc", "A", ["t"]);
		await b.getOrSet({ key: "doc", factory: () => "B", tags: ["t"] });

		await b.deleteByTag(["t"]);

		expect(await a.get({ key: "doc" })).toBe("A");
		expect(await b.get({ key: "doc" })).toBeUndefined();
	});
});
