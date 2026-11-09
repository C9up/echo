/**
 * `RedisDriver` and `CacheManager` on a RAW ioredis client against a live
 * Redis — the client `drivers.redis({ client })` advertises as compatible.
 *
 * Quasar pre-binds every command, which hid a driver that called a detached
 * method; the unit fakes never read `this`. This file talks to ioredis
 * directly (reached through quasar's `ioConnection`, since echo does not
 * depend on ioredis) so what passes here is what an application gets.
 *
 * Gated on `REDIS_TEST_URL`; skipped when no server answers.
 */
import { QuasarManager } from "@c9up/quasar";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CacheManager } from "../../src/CacheManager.js";
import {
	type RedisClient,
	RedisDriver,
} from "../../src/drivers/RedisDriver.js";

const url = process.env.REDIS_TEST_URL ?? "";

async function serverAnswers(): Promise<boolean> {
	const probe = new QuasarManager({
		connection: "probe" as const,
		connections: {
			probe: { url, lazyConnect: true, maxRetriesPerRequest: 1 },
		},
	});
	try {
		await probe.connection().ping();
		return true;
	} catch {
		return false;
	} finally {
		await probe.disconnect("probe");
	}
}

const live = url ? await serverAnswers() : false;
const describeRedis = live ? describe : describe.skip;

describeRedis("echo on a raw ioredis client", () => {
	const manager = new QuasarManager({
		connection: "main" as const,
		connections: { main: { url } },
	});
	const raw = manager.connection().ioConnection;
	// The raw client, typed through the driver's own contract: ioredis
	// satisfies it structurally, which is the claim under test.
	const client: RedisClient = raw;
	const base = `echo-raw:${process.pid}:`;

	// Scoped to this run's prefix, never FLUSHDB: the URL may point at a
	// server other things use.
	async function cleanup(): Promise<void> {
		const keys = await raw.keys(`${base}*`);
		if (keys.length > 0) await raw.del(...keys);
	}

	beforeEach(cleanup);

	afterAll(async () => {
		await cleanup();
		await manager.quit("main");
	});

	describe("clear() (bug 296)", () => {
		it("empties the store on a raw client instead of throwing", async () => {
			const cache = new CacheManager(new RedisDriver(client, base));
			await cache.set({ key: "x", value: 1 });
			await cache.set({ key: "y", value: 2 });

			await cache.clear();

			expect(await raw.keys(`${base}*`)).toEqual([]);
		});

		it("clears only the namespace that asked", async () => {
			const root = new CacheManager(new RedisDriver(client, base));
			await root.namespace("a").set({ key: "k", value: "a" });
			await root.namespace("b").set({ key: "k", value: "b" });

			await root.namespace("a").clear();

			expect(await root.namespace("a").get({ key: "k" })).toBeUndefined();
			expect(await root.namespace("b").get({ key: "k" })).toBe("b");
		});
	});
});
