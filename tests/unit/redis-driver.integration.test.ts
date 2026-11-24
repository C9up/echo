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
 * Gated on `REDIS_TEST_URL`; skipped only locally without one;
 * failed when it is set and nothing answers, or missing on CI.
 */
import { QuasarManager } from "@c9up/quasar";
import { clearQuasar, setQuasar } from "@c9up/quasar/services/main";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CacheManager } from "../../src/CacheManager.js";
import { RedisDriver } from "../../src/drivers/RedisDriver.js";
import { quasarConnection } from "../../src/quasar.js";

const url = process.env.REDIS_TEST_URL ?? "";

/**
 * Whether the server answers: a URL can be set and point at nothing, which
 * fails the file below rather than skipping it. Probed through quasar (a devDependency here) rather than ioredis,
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
// Set means meant, and CI always sets it: a URL that answers nothing, or no
// URL at all on CI, fails the file instead of quietly skipping the suite.
if ((url !== "" || process.env.CI === "true") && !live) {
	throw new Error(
		url === ""
			? "REDIS_TEST_URL is not set on CI: refusing to skip the live-Redis suite."
			: `REDIS_TEST_URL is set (${url}) but no server answers: refusing to skip the live-Redis suite.`,
	);
}
const describeRedis = live ? describe : describe.skip;

/**
 * The suite runs twice: on a bare connection, and on one that sets
 * `keyPrefix`, the documented way two applications share one database. The
 * client prefixes the key of every command but not a SCAN pattern, and SCAN
 * answers full names: only the prefixed run sees a flush that misses them.
 */
const KEY_PREFIXES = ["", "echo-app:"] as const;

for (const keyPrefix of KEY_PREFIXES)
	describeRedis(
		keyPrefix === ""
			? "echo RedisDriver against a live Redis"
			: `echo RedisDriver against a live Redis (connection keyPrefix '${keyPrefix}')`,
		() => {
			const prefix = `echo-test:${process.pid}:`;
			const manager = new QuasarManager({
				connection: "main" as const,
				connections: { main: { url, keyPrefix }, plain: { url } },
			});

			function driver(): RedisDriver {
				return new RedisDriver(quasarConnection(), prefix);
			}

			/** The keys this suite wrote, as the server names them. */
			function serverKeys(): Promise<string[]> {
				return manager.connection("plain").keys(`${keyPrefix}${prefix}*`);
			}

			beforeEach(async () => {
				setQuasar(manager);
				const plain = manager.connection("plain");
				const keys = await serverKeys();
				if (keys.length > 0) await plain.del(...keys);
			});

			afterAll(async () => {
				await manager.quitAll();
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
				const ttl = await manager.connection().ttl(`${prefix}v:short`);
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
				expect(await manager.connection().ttl(`${prefix}v:forever`)).toBe(-1);
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
				expect(await client.smembers(`${prefix}t:posts`)).toEqual([]);
				expect(await client.smembers(`${prefix}t:featured`)).toEqual([]);
			});

			it("flushes every prefixed key by walking a real SCAN cursor", async () => {
				const d = driver();
				// More keys than one SCAN page (COUNT 100), so the cursor must loop.
				for (let i = 0; i < 250; i++) await d.set(`bulk:${i}`, i);
				expect(await d.get("bulk:249")).toBe(249);

				await d.flush();

				expect(await serverKeys()).toEqual([]);
			});

			it("flushes one namespace with its bookkeeping, and nothing else", async () => {
				const d = driver();
				await d.setEntry("tenant-a:roles:7", ["owner"], { tags: ["user:7"] });
				await d.setEntry("tenant-a:plan", "pro", {});
				await d.setEntry("tenant-b:roles:9", ["admin"], { tags: ["user:7"] });

				await d.flush("tenant-a:");

				expect(await d.get("tenant-a:roles:7")).toBeNull();
				expect(await d.get("tenant-a:plan")).toBeNull();
				expect(await d.get("tenant-b:roles:9")).toEqual(["admin"]);
				// The shared tag set keeps the other tenant's key only, and the
				// flushed key's reverse index is gone.
				const client = manager.connection();
				expect(await client.smembers(`${prefix}t:user:7`)).toEqual([
					"tenant-b:roles:9",
				]);
				expect(await client.exists(`${prefix}m:tenant-a:roles:7`)).toBe(0);
			});

			it("clear() through the manager drops every entry, namespaced ones too", async () => {
				const cache = new CacheManager(driver());
				await cache.set("permissions:42", { admin: true }, 300);
				await cache.namespace("tenant-a").set({
					key: "roles:7",
					value: ["owner"],
					ttl: 300,
					tags: ["user:7"],
				});

				await cache.clear();

				expect(await cache.get("permissions:42")).toBeUndefined();
				expect(
					await cache.namespace("tenant-a").get("roles:7"),
				).toBeUndefined();
				expect(await serverKeys()).toEqual([]);
			});

			it("namespace().clear() drops that namespace only", async () => {
				const cache = new CacheManager(driver());
				const tenantA = cache.namespace("tenant-a");
				const tenantB = cache.namespace("tenant-b");
				await cache.set("feature-flags", { beta: true }, 300);
				await tenantA.set({
					key: "roles:7",
					value: ["owner"],
					ttl: 300,
					tags: ["user:7"],
				});
				await tenantB.set({ key: "roles:9", value: ["admin"], ttl: 300 });

				await tenantA.clear();

				expect(await tenantA.get("roles:7")).toBeUndefined();
				expect(await tenantB.get("roles:9")).toEqual(["admin"]);
				expect(await cache.get("feature-flags")).toEqual({ beta: true });
			});

			if (keyPrefix !== "") {
				it("clears its own entries and leaves a neighbour without keyPrefix alone", async () => {
					const neighbour = new CacheManager(
						new RedisDriver(manager.connection("plain"), prefix),
					);
					const cache = new CacheManager(driver());
					await neighbour.set("settings", "theirs", 300);
					await cache.set("settings", "ours", 300);
					await cache.set("permissions:42", { admin: true }, 300);

					await cache.clear();

					expect(await cache.get("permissions:42")).toBeUndefined();
					expect(await cache.get("settings")).toBeUndefined();
					expect(await neighbour.get("settings")).toBe("theirs");
					await neighbour.clear();
				});
			}
		},
	);
