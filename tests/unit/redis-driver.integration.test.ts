/**
 * `RedisDriver` against a REAL Redis, wired through `quasarConnection()` — the
 * path an app uses.
 *
 * The unit suite drives a hand-written fake. What it cannot prove is what this
 * file targets: that the server honours the TTL we compute (a cache entry that
 * outlives its TTL serves stale data; one that dies early destroys the hit
 * rate), that tag invalidation reaches every key across real SET operations,
 * and that `flush` actually walks a live SCAN cursor.
 *
 * Gated on `REDIS_TEST_URL`; skipped when no server answers.
 */
import { QuasarManager } from "@c9up/quasar";
import { clearQuasar, setQuasar } from "@c9up/quasar/services/main";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { RedisDriver } from "../../src/drivers/RedisDriver.js";
import { quasarConnection } from "../../src/quasar.js";

const url = process.env.REDIS_TEST_URL ?? "";

/**
 * Skipped, not failed, when no server answers: a URL can be set and point at
 * nothing. Probed through quasar (a devDependency here) rather than ioredis,
 * which echo deliberately does not depend on.
 */
async function serverAnswers(): Promise<boolean> {
	const probe = new QuasarManager({
		connection: "probe" as const,
		// Fail fast instead of letting ioredis retry a dead port forever.
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

describeRedis("echo RedisDriver against a live Redis", () => {
	const prefix = `echo-test:${process.pid}:`;
	const manager = new QuasarManager({
		connection: "main" as const,
		connections: { main: { url } },
	});

	function driver(): RedisDriver {
		return new RedisDriver(quasarConnection(), prefix);
	}

	beforeEach(async () => {
		setQuasar(manager);
		const client = manager.connection();
		const keys = await client.keys(`${prefix}*`);
		if (keys.length > 0) await client.del(...keys);
	});

	afterAll(async () => {
		await manager.quit("main");
		clearQuasar(manager);
	});

	it("round-trips a value through a real server", async () => {
		const d = driver();
		await d.set("user:1", { name: "Ada" });

		expect(await d.get("user:1")).toEqual({ name: "Ada" });
		expect(await d.has("user:1")).toBe(true);
	});

	it("sets a TTL the server agrees with", async () => {
		const d = driver();
		await d.set("short", "value", 60);

		// Read back from the server, not from our own arithmetic.
		const ttl = await manager.connection().ttl(`${prefix}short`);
		expect(ttl).toBeGreaterThan(50);
		expect(ttl).toBeLessThanOrEqual(60);
	});

	it("stops serving a value once the server really expires it", async () => {
		const d = driver();
		await d.set("blink", "value", 1);
		expect(await d.get("blink")).toBe("value");

		await expect
			.poll(() => d.get("blink"), { timeout: 5_000, interval: 200 })
			.toBeNull();
	});

	it("keeps a value with no TTL indefinitely", async () => {
		const d = driver();
		await d.set("forever", "value");

		// -1 is Redis for "no expiry" — a cache entry meant to persist must not
		// silently acquire one.
		expect(await manager.connection().ttl(`${prefix}forever`)).toBe(-1);
	});

	it("invalidates every key carrying a tag", async () => {
		const d = driver();
		await d.setEntry("post:1", "one", { tags: ["posts"] });
		await d.setEntry("post:2", "two", { tags: ["posts"] });
		await d.setEntry("user:1", "ada", { tags: ["users"] });

		await d.deleteByTag(["posts"]);

		// `null`, not `undefined`: this is the DRIVER boundary, where "no entry"
		// is null. The manager is what translates that into the `undefined` a
		// caller sees — the sibling expiry test above asserts the same way.
		expect(await d.get("post:1")).toBeNull();
		expect(await d.get("post:2")).toBeNull();
		// A different tag is untouched.
		expect(await d.get("user:1")).toBe("ada");
	});

	it("leaves no tag bookkeeping behind after deleting a tagged key", async () => {
		const d = driver();
		await d.setEntry("post:1", "one", { tags: ["posts", "featured"] });

		await d.delete("post:1");

		// The key is gone from BOTH tag sets, so a later deleteByTag cannot
		// resurrect work on a dead key.
		const client = manager.connection();
		expect(await client.smembers(`${prefix}tag:posts`)).toEqual([]);
		expect(await client.smembers(`${prefix}tag:featured`)).toEqual([]);
	});

	it("flushes every prefixed key by walking a real SCAN cursor", async () => {
		const d = driver();
		// More keys than one SCAN page (COUNT 100), so the cursor must loop.
		for (let i = 0; i < 250; i++) await d.set(`bulk:${i}`, i);
		expect(await d.get("bulk:249")).toBe(249);

		await d.flush();

		expect(await manager.connection().keys(`${prefix}*`)).toEqual([]);
	});
});
