/**
 * The config `ream configure @c9up/echo` writes must be usable.
 *
 * It called `drivers.redisBus({ connection: 'main' })`, which the package did
 * not export: the very first thing a user did after installing echo left them
 * with an application that would not boot. A generated file is only correct if
 * every name it reaches for is one this package actually has — so the names are
 * read out of the generated source and looked up, rather than trusted.
 */
import { describe, expect, it, vi } from "vitest";
import { configure } from "../../src/configure.js";
import { drivers, store } from "../../src/index.js";

/** Capture what `configure` writes, without touching a disk. */
async function generatedConfig(): Promise<string> {
	let written = "";
	await configure({
		addEnvVars: vi.fn(async () => {}),
		addProvider: vi.fn(async () => {}),
		writeFile: vi.fn(async (_path: string, contents: string) => {
			written = contents;
		}),
	} as never);
	return written;
}

describe("echo > the config `ream configure` generates", () => {
	it("only calls drivers this package exports", async () => {
		const source = await generatedConfig();
		const called = [...source.matchAll(/drivers\.(\w+)\(/g)].map((m) => m[1]);

		expect(called.length).toBeGreaterThan(0);
		for (const name of called) {
			expect(
				Object.hasOwn(drivers, name as string),
				`the generated config calls drivers.${name}(), which @c9up/echo does not export`,
			).toBe(true);
		}
	});

	it("only calls builder methods a store has", async () => {
		const source = await generatedConfig();
		const called = [...source.matchAll(/\.(use\w+)\(/g)].map((m) => m[1]);
		const builder = store() as unknown as Record<string, unknown>;

		expect(called.length).toBeGreaterThan(0);
		for (const name of called) {
			expect(
				typeof builder[name as string],
				`the generated config calls .${name}(), which a store does not have`,
			).toBe("function");
		}
	});

	it("builds the tiered store the config describes", () => {
		// The shape the generated file writes, run for real: two layers plus the
		// bus that keeps each instance's L1 in step.
		const entry = store()
			.useL1Layer(drivers.memory({ maxItems: 1000 }))
			.useL2Layer(drivers.redis({ connection: "main" }))
			.useBus(drivers.redisBus({ connection: "main" }))
			.entry();

		expect(entry).toBeTruthy();
	});
});

describe("echo > the memory driver's ceiling", () => {
	it("bounds the store by count, which a TTL cannot", async () => {
		// A cache keyed by a user id or a search term grows until the process
		// runs out of memory, however short each entry's life.
		const driver = drivers.memory({ maxItems: 3 })();
		for (const key of ["a", "b", "c", "d"]) await driver.set(key, key);

		expect(await driver.get("a")).toBeNull();
		expect(await driver.get("d")).toBe("d");
	});

	it("drops an expired entry before a live one", async () => {
		// Evicting a live entry while a dead one sits in the map would throw
		// away a value someone still wants.
		const driver = drivers.memory({ maxItems: 2 })();
		await driver.set("dead", "dead", 0.001);
		await driver.set("live", "live");
		await new Promise((resolve) => setTimeout(resolve, 20));
		await driver.set("fresh", "fresh");

		expect(await driver.get("live")).toBe("live");
		expect(await driver.get("fresh")).toBe("fresh");
	});

	it("keeps no ceiling when none was asked for", async () => {
		const driver = drivers.memory()();
		for (let i = 0; i < 50; i++) await driver.set(`k${i}`, i);
		expect(await driver.get("k0")).toBe(0);
	});

	it("re-writing a key does not spend a slot", async () => {
		const driver = drivers.memory({ maxItems: 2 })();
		await driver.set("a", 1);
		await driver.set("a", 2);
		await driver.set("b", 1);

		expect(await driver.get("a")).toBe(2);
		expect(await driver.get("b")).toBe(1);
	});
});
