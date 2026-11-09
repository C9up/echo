/**
 * The cache commands echo ships (bug 332): `cache:clear`, `cache:delete`,
 * `cache:prune`, run the way the kernel runs them — properties assigned on an
 * instance, then `run()`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CacheManager } from "../../src/CacheManager.js";
import { getCommand, getMetaData } from "../../src/console/index.js";
import { CacheStoreManager, drivers } from "../../src/StoreManager.js";
import { clearCache, setCache } from "../../src/services/main.js";

const managers: CacheStoreManager[] = [];
function wire(): { cache: CacheManager; manager: CacheStoreManager } {
	const manager = new CacheStoreManager({
		default: "memory",
		stores: {
			memory: { driver: drivers.memory() },
			other: { driver: drivers.memory() },
		},
	});
	managers.push(manager);
	const cache = manager.use();
	setCache(cache);
	return { cache, manager };
}

afterEach(async () => {
	clearCache();
	for (const manager of managers.splice(0)) await manager.disconnectAll();
});

interface Harness {
	logs: Array<[string, string]>;
	asked: string[];
	exitCode: () => unknown;
}

/** Build the named command, hand it what the kernel would, and run it. */
async function run(
	name: string,
	input: Record<string, unknown>,
	options: { production?: boolean; answer?: boolean | Error } = {},
): Promise<Harness> {
	const metadata = (await getMetaData()).find((m) => m.commandName === name);
	if (metadata === undefined) throw new Error(`no ${name}`);
	const Command = await getCommand(metadata);
	if (Command === null) throw new Error(`no class for ${name}`);
	const logs: Array<[string, string]> = [];
	const asked: string[] = [];
	const instance = new Command();
	Object.assign(instance, input, {
		logger: {
			success: (m: string) => logs.push(["success", m]),
			warning: (m: string) => logs.push(["warning", m]),
			error: (m: string) => logs.push(["error", m]),
		},
		prompt: {
			async confirm(question: string) {
				asked.push(question);
				if (options.answer instanceof Error) throw options.answer;
				return options.answer ?? false;
			},
		},
		app: { inProduction: options.production ?? false },
	});
	await instance.run();
	return { logs, asked, exitCode: () => Reflect.get(instance, "exitCode") };
}

describe("echo > the commands the package ships", () => {
	it("publishes the three under names the kernel can read", async () => {
		const metadata = await getMetaData();
		expect(metadata.map((m) => m.commandName).sort()).toEqual([
			"cache:clear",
			"cache:delete",
			"cache:prune",
		]);
		for (const entry of metadata) {
			expect(entry.namespace).toBe("cache");
			expect(entry.options).toMatchObject({ startApp: true });
		}
		const clear = metadata.find((m) => m.commandName === "cache:clear");
		expect(clear?.flags).toHaveLength(3);
	});
});

describe("echo > cache:clear", () => {
	it("clears the default store", async () => {
		const { cache } = wire();
		await cache.set({ key: "k", value: 1 });

		const { logs } = await run("cache:clear", {});

		expect(await cache.get({ key: "k" })).toBeUndefined();
		expect(logs).toEqual([["success", 'Cleared "memory" cache successfully']]);
	});

	it("clears a named store only", async () => {
		const { cache, manager } = wire();
		await cache.set({ key: "k", value: 1 });
		await manager.use("other").set({ key: "k", value: 2 });

		await run("cache:clear", { store: "other" });

		expect(await cache.get({ key: "k" })).toBe(1);
		expect(await manager.use("other").get({ key: "k" })).toBeUndefined();
	});

	it("clears one namespace", async () => {
		const { cache } = wire();
		await cache.namespace("users").set({ key: "1", value: "u" });
		await cache.namespace("posts").set({ key: "1", value: "p" });

		await run("cache:clear", { namespace: "users" });

		expect(await cache.namespace("users").get({ key: "1" })).toBeUndefined();
		expect(await cache.namespace("posts").get({ key: "1" })).toBe("p");
	});

	it("invalidates tags", async () => {
		const { cache } = wire();
		await cache.set({ key: "a", value: 1, tags: ["products"] });
		await cache.set({ key: "b", value: 2 });

		await run("cache:clear", { tags: ["products"] });

		expect(await cache.get({ key: "a" })).toBeUndefined();
		expect(await cache.get({ key: "b" })).toBe(2);
	});

	it("refuses --namespace with --tags", async () => {
		const { cache } = wire();
		await cache.set({ key: "a", value: 1 });

		const result = await run("cache:clear", {
			namespace: "users",
			tags: ["t"],
		});

		expect(result.exitCode()).toBe(1);
		expect(await cache.get({ key: "a" })).toBe(1);
	});

	it("refuses an unknown store", async () => {
		wire();
		const result = await run("cache:clear", { store: "nope" });

		expect(result.exitCode()).toBe(1);
		expect(result.logs[0]?.[1]).toMatch(/"nope" is not a valid cache store/);
	});

	it("asks in production, and a no leaves the cache alone", async () => {
		const { cache } = wire();
		await cache.set({ key: "k", value: 1 });

		const result = await run("cache:clear", {}, { production: true });

		expect(result.asked).toHaveLength(1);
		expect(await cache.get({ key: "k" })).toBe(1);
	});

	it("a prompt that cannot be answered is a no", async () => {
		const { cache } = wire();
		await cache.set({ key: "k", value: 1 });

		await run(
			"cache:clear",
			{},
			{ production: true, answer: new Error("tty") },
		);

		expect(await cache.get({ key: "k" })).toBe(1);
	});

	it("--force skips the question in production", async () => {
		const { cache } = wire();
		await cache.set({ key: "k", value: 1 });

		const result = await run(
			"cache:clear",
			{ force: true },
			{ production: true },
		);

		expect(result.asked).toEqual([]);
		expect(await cache.get({ key: "k" })).toBeUndefined();
	});

	it("says so when no cache is configured", async () => {
		const result = await run("cache:clear", {});

		expect(result.exitCode()).toBe(1);
		expect(result.logs[0]?.[1]).toMatch(/No cache is configured/);
	});
});

describe("echo > cache:delete", () => {
	it("deletes a key and reports a missing one", async () => {
		const { cache } = wire();
		await cache.set({ key: "user:42", value: 1 });

		const first = await run("cache:delete", { key: "user:42" });
		const second = await run("cache:delete", { key: "user:42" });

		expect(await cache.get({ key: "user:42" })).toBeUndefined();
		expect(first.logs[0]?.[0]).toBe("success");
		expect(second.logs[0]?.[0]).toBe("warning");
	});

	it("asks in production, even without a --force to skip it", async () => {
		const { cache } = wire();
		await cache.set({ key: "k", value: 1 });

		const no = await run("cache:delete", { key: "k" }, { production: true });
		expect(no.asked).toHaveLength(1);
		expect(await cache.get({ key: "k" })).toBe(1);

		await run("cache:delete", { key: "k" }, { production: true, answer: true });
		expect(await cache.get({ key: "k" })).toBeUndefined();
	});
});

describe("echo > cache:prune", () => {
	it("prunes the named store", async () => {
		const { manager } = wire();
		const other = manager.use("other");
		const prune = vi.spyOn(other, "prune");

		const { logs } = await run("cache:prune", { store: "other" });

		expect(prune).toHaveBeenCalledOnce();
		expect(logs[0]).toEqual([
			"success",
			'Pruned expired entries from "other" cache successfully',
		]);
	});

	it("asks in production", async () => {
		const { cache } = wire();
		const prune = vi.spyOn(cache, "prune");

		const result = await run("cache:prune", {}, { production: true });

		expect(result.asked).toHaveLength(1);
		expect(prune).not.toHaveBeenCalled();
	});
});
