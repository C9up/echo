/**
 * Resolving a Redis connection out of quasar.
 *
 * quasar is an optional peer, so this module never imports it — it builds the
 * specifier at runtime. Every failure along that path (absent package, wrong
 * shape, a connection missing a command) had no test, which means each one
 * first surfaces at a customer's, on the first cache write, far from its cause.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { quasarConnection } from "../../src/quasar.js";

const SPECIFIER = "@c9up/quasar/services/main";

/** Every command the redis driver actually issues. */
const commands = [
	"get",
	"set",
	"del",
	"sadd",
	"srem",
	"smembers",
	"expire",
	"ttl",
];

const client = (omit?: string) =>
	Object.fromEntries(
		commands.filter((c) => c !== omit).map((c) => [c, () => {}]),
	);

/**
 * A mocked namespace throws on any export the factory did not declare, unlike
 * a real one — so both shapes the bridge probes are always declared.
 */
const mockQuasar = (shape: { connection?: unknown; default?: unknown }) => {
	vi.doMock(SPECIFIER, () => ({
		connection: shape.connection,
		default: shape.default,
	}));
};

const load = async () => (await import("../../src/quasar.js")).quasarConnection;

afterEach(() => {
	vi.doUnmock(SPECIFIER);
	vi.resetModules();
});

describe("echo > the quasar bridge", () => {
	it("resolves nothing until the store is actually used", () => {
		// A config may name a connection that does not exist in an environment
		// that never selects this store.
		expect(typeof quasarConnection("main")).toBe("function");
	});

	it("hands back the named connection", async () => {
		const connection = client();
		const manager = { connection: vi.fn(() => connection) };
		mockQuasar({ default: manager });

		expect(await (await load())("sessions")()).toBe(connection);
		expect(manager.connection).toHaveBeenCalledWith("sessions");
	});

	it("takes the manager on the namespace as well as on the default export", async () => {
		const connection = client();
		mockQuasar({ connection: () => connection });

		expect(await (await load())()()).toBe(connection);
	});

	it("says the package is missing, and how to add it", async () => {
		// The bare module-not-found reads as an echo bug rather than as a
		// missing optional peer.
		vi.doMock(SPECIFIER, () => {
			throw new Error("Cannot find module");
		});

		await expect((await load())("main")()).rejects.toThrow(
			/@c9up\/quasar is not installed[\s\S]*pnpm add @c9up\/quasar/,
		);
	});

	it("names the store that asked for it", async () => {
		vi.doMock(SPECIFIER, () => {
			throw new Error("Cannot find module");
		});
		const resolve = await load();

		await expect(resolve("sessions")()).rejects.toThrow(
			/quasar connection "sessions"/,
		);
		await expect(resolve()()).rejects.toThrow(/quasar connection "default"/);
	});

	it("refuses a module that is not a connection manager", async () => {
		mockQuasar({ default: { somethingElse: () => {} } });

		await expect((await load())()()).rejects.toThrow(
			/did not expose a connection\(\) manager/,
		);
	});

	it("refuses a connection missing a command it will need", async () => {
		// Accepting it would fail on the first write, with a message naming
		// neither the connection nor the missing command.
		for (const missing of commands) {
			vi.resetModules();
			mockQuasar({ default: { connection: () => client(missing) } });

			await expect((await load())("main")(), missing).rejects.toThrow(
				new RegExp(`connection 'main' is missing ${missing}`),
			);
		}
	});

	it("accepts a connection that omits keys and exists", async () => {
		// `flush()` walks a SCAN cursor rather than calling KEYS, so demanding
		// KEYS would reject a client on grounds this driver agrees with.
		mockQuasar({ default: { connection: () => client() } });

		await expect((await load())("main")()).resolves.toBeDefined();
	});
});
