/**
 * The memory driver hands out copies, not the object it holds.
 *
 * It kept the caller's object and returned that same reference, so a request
 * that mutated what it read — or what it passed to set(), or what a factory
 * returned — rewrote the cached value for every later reader. A cached
 * permission set is exactly that kind of object.
 */
import { afterEach, describe, expect, it } from "vitest";
import { CacheManager } from "../../src/CacheManager.js";
import { MemoryDriver } from "../../src/drivers/MemoryDriver.js";
import { drivers } from "../../src/StoreManager.js";

const created: MemoryDriver[] = [];
function track(driver: MemoryDriver): MemoryDriver {
	created.push(driver);
	return driver;
}

afterEach(() => {
	for (const driver of created.splice(0)) driver.destroy();
});

interface User {
	name: string;
	roles: string[];
}

describe("echo > memory driver isolation (bug 320)", () => {
	it("mutating a read value does not change the next read", async () => {
		const cache = new CacheManager(track(new MemoryDriver()));
		await cache.set({ key: "u", value: { name: "alice", roles: ["user"] } });

		const first = await cache.get<User>({ key: "u" });
		first?.roles.push("admin");

		expect((await cache.get<User>({ key: "u" }))?.roles).toEqual(["user"]);
	});

	it("mutating the object passed to set() does not change the cache", async () => {
		const cache = new CacheManager(track(new MemoryDriver()));
		const user: User = { name: "alice", roles: ["user"] };
		await cache.set({ key: "u", value: user });

		user.roles.push("admin");

		expect((await cache.get<User>({ key: "u" }))?.roles).toEqual(["user"]);
	});

	it("mutating a factory result does not change the cache", async () => {
		const cache = new CacheManager(track(new MemoryDriver()));
		const computed = await cache.getOrSet<User>({
			key: "u",
			factory: () => ({ name: "alice", roles: ["user"] }),
		});

		computed.roles.push("admin");

		expect((await cache.get<User>({ key: "u" }))?.roles).toEqual(["user"]);
	});

	it("reads back what Redis would: JSON, so dev and production agree", async () => {
		const cache = new CacheManager(track(new MemoryDriver()));
		const at = new Date("2026-01-01T00:00:00.000Z");
		await cache.set({ key: "d", value: { at } });

		expect(await cache.get({ key: "d" })).toEqual({
			at: "2026-01-01T00:00:00.000Z",
		});
	});

	it("drivers.memory() isolates too", async () => {
		const driver = drivers.memory()();
		const cache = new CacheManager(driver);
		try {
			await cache.set({ key: "u", value: { roles: ["user"] } });
			const read = await cache.get<{ roles: string[] }>({ key: "u" });
			read?.roles.push("admin");
			expect(
				(await cache.get<{ roles: string[] }>({ key: "u" }))?.roles,
			).toEqual(["user"]);
		} finally {
			await driver.disconnect?.();
		}
	});

	it("refuses a value JSON cannot carry and keeps the previous one", async () => {
		const driver = track(new MemoryDriver());
		await driver.setWithTags("k", "old", ["t"]);

		await expect(driver.set("k", () => "fn")).rejects.toThrow(/no JSON form/);

		expect(await driver.get("k")).toBe("old");
		await driver.deleteByTag(["t"]);
		expect(await driver.get("k")).toBeNull();
	});

	it("serialize: false shares references, as the opt-out says", async () => {
		const driver = track(new MemoryDriver({ serialize: false }));
		const cache = new CacheManager(driver);
		const value = { roles: ["user"] };
		await cache.set({ key: "u", value });

		expect(await cache.get({ key: "u" })).toBe(value);
	});
});
