/**
 * The AdonisJS shape, end to end: a store names a connection, quasar owns the
 * socket. Driven against a real server, because what is being proved is that
 * a QuasarConnection actually carries the commands this driver issues —
 * a fake would only prove the resolver calls something.
 *
 * Skipped, not failed, when no server answers.
 */

import { QuasarManager } from "@c9up/quasar";
import { setQuasar } from "@c9up/quasar/services/main";
import { afterAll, describe, expect, it } from "vitest";
import { drivers } from "../src/StoreManager.js";

const url = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6379";

const manager = new QuasarManager({
	connection: "main",
	connections: { main: { url, db: 15 } },
});

async function serverAnswers(): Promise<boolean> {
	try {
		await manager.connection().ping();
		return true;
	} catch {
		return false;
	}
}

const live = await serverAnswers();
setQuasar(manager);

afterAll(async () => {
	await manager.quit();
});

describe.skipIf(!live)("drivers.redis({ connection }) against a live server", () => {
	it("caches through the connection quasar owns", async () => {
		const driver = drivers.redis({ connection: "main", prefix: `echo-test:${process.pid}:` })();
		const key = "user:42";

		await driver.set(key, { name: "Hugo" }, 30);
		expect(await driver.get(key)).toEqual({ name: "Hugo" });

		await driver.delete(key);
		expect(await driver.get(key)).toBeNull();
	});

	it("uses the same socket as the rest of the app, not a second one", async () => {
		const driver = drivers.redis({ connection: "main", prefix: `echo-test:${process.pid}:shared:` })();
		await driver.set("k", "v", 30);

		// Written through the cache, read through the connection directly.
		const raw = await manager.connection().get(`echo-test:${process.pid}:shared:k`);
		expect(raw).not.toBeNull();

		await driver.delete("k");
	});
})
