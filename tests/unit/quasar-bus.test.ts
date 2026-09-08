/**
 * Redis pub/sub as the cache bus.
 *
 * A two-layer store without one is wrong the moment a second instance exists:
 * each process keeps serving its own L1 copy of a key another has already
 * deleted, and nothing tells it. The generated config asked for
 * `drivers.redisBus(...)` and the package had none, so the very first thing an
 * application did after installing echo left it with a config that would not
 * load.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BusMessage } from "../../src/drivers/TieredDriver.js";

const SPECIFIER = "@c9up/quasar/services/main";

function pubsub() {
	const published: Array<[string, string]> = [];
	const handlers = new Map<string, (raw: string) => void>();
	/** Every `unsubscribe`, so a test can see WHAT was taken off. */
	const removed: Array<[string, ((raw: string) => void) | undefined]> = [];
	return {
		published,
		handlers,
		removed,
		publish: vi.fn(async (channel: string, message: string) => {
			published.push([channel, message]);
		}),
		subscribe: vi.fn(
			async (channel: string, handler: (raw: string) => void) => {
				handlers.set(channel, handler);
			},
		),
		unsubscribe: vi.fn(
			async (channel: string, handler?: (raw: string) => void) => {
				removed.push([channel, handler]);
				handlers.delete(channel);
			},
		),
	};
}

/**
 * Every export the bridge reads has to be present: vitest's module mock THROWS
 * on an absent one, where a real namespace answers `undefined`.
 */
const mockQuasar = (shape: {
	connection?: unknown;
	publish?: unknown;
	subscribe?: unknown;
	unsubscribe?: unknown;
	default?: unknown;
}) => {
	vi.doMock(SPECIFIER, () => ({
		connection: shape.connection,
		publish: shape.publish,
		subscribe: shape.subscribe,
		unsubscribe: shape.unsubscribe,
		default: shape.default,
	}));
};

const load = async () => (await import("../../src/quasar.js")).quasarBus;

afterEach(() => {
	vi.doUnmock(SPECIFIER);
	vi.resetModules();
});

const message: BusMessage = { type: "delete", keys: ["a"], senderId: "one" };

describe("echo > the quasar cache bus", () => {
	it("loads nothing until a message actually moves", async () => {
		// A config may name a bus in an environment that never uses that store.
		mockQuasar({ default: { connection: () => pubsub() } });
		const bus = (await load())({ connection: "main" });
		expect(typeof bus.publish).toBe("function");
	});

	it("publishes on the named connection's channel", async () => {
		const socket = pubsub();
		const manager = { connection: vi.fn(() => socket) };
		mockQuasar({ default: manager });

		await (await load())({ connection: "cache" }).publish(message);

		expect(manager.connection).toHaveBeenCalledWith("cache");
		expect(socket.published).toEqual([
			["echo::invalidate", JSON.stringify(message)],
		]);
	});

	it("honours a channel the application named", async () => {
		const socket = pubsub();
		mockQuasar({ default: { connection: () => socket } });

		await (await load())({ channel: "app::cache" }).publish(message);
		expect(socket.published[0]?.[0]).toBe("app::cache");
	});

	it("hands a received frame back as the message it was", async () => {
		const socket = pubsub();
		mockQuasar({ default: { connection: () => socket } });
		const seen: BusMessage[] = [];

		const bus = (await load())();
		bus.subscribe((m) => seen.push(m));
		// `subscribe` is synchronous in the bus contract; the socket opens on
		// quasar's own schedule.
		await vi.waitFor(() => expect(socket.handlers.size).toBe(1));

		socket.handlers.get("echo::invalidate")?.(JSON.stringify(message));
		expect(seen).toEqual([message]);
	});

	it("turns a reported subscribe failure into a rejection", async () => {
		// Quasar catches the Redis error, calls `onError` and RESOLVES — so
		// awaiting the call proved nothing. The tier believed it was subscribed
		// while no handler was installed, and every instance served its own
		// stale L1 until the TTL, with nothing to say the bus was down.
		const socket = pubsub();
		socket.subscribe = vi.fn(
			async (
				_channel: string,
				_handler: (raw: string) => void,
				options?: { onError?: (error: unknown) => void },
			) => {
				options?.onError?.(new Error("no route to the bus"));
			},
		);
		mockQuasar({ default: { connection: () => socket } });

		const bus = (await load())();

		await expect(bus.subscribe(() => {})).rejects.toThrow(
			"no route to the bus",
		);
	});

	it("lets a retry through after a failed subscribe", async () => {
		let attempts = 0;
		const socket = pubsub();
		const succeed = socket.subscribe;
		socket.subscribe = vi.fn(
			async (
				channel: string,
				handler: (raw: string) => void,
				options?: { onError?: (error: unknown) => void },
			) => {
				attempts += 1;
				if (attempts === 1) {
					options?.onError?.(new Error("no route to the bus"));
					return;
				}
				await succeed(channel, handler);
			},
		);
		mockQuasar({ default: { connection: () => socket } });

		const bus = (await load())();
		const handler = (): void => {};
		await expect(bus.subscribe(handler)).rejects.toThrow();

		await expect(bus.subscribe(handler)).resolves.toBeUndefined();
		expect(socket.handlers.size).toBe(1);
	});

	it("keeps a listener the client refused to remove", async () => {
		// The record was dropped before the client was asked, so a refusal left
		// a live listener nothing could name again — neither to retry nor to
		// remove at a second shutdown.
		const socket = pubsub();
		let refuse = true;
		const accepting = socket.unsubscribe;
		socket.unsubscribe = vi.fn(
			async (channel: string, handler?: (raw: string) => void) => {
				if (refuse) throw new Error("the connection is busy");
				await accepting(channel, handler);
			},
		);
		mockQuasar({ default: { connection: () => socket } });

		const bus = (await load())();
		const handler = (): void => {};
		await bus.subscribe(handler);

		await expect(bus.unsubscribe?.(handler)).rejects.toThrow("busy");

		refuse = false;
		await bus.unsubscribe?.(handler);
		expect(socket.handlers.size).toBe(0);
	});

	it("removes its own listener, by name", async () => {
		// Quasar keeps a `Set` of handlers per channel. An unnamed unsubscribe
		// drops every listener on a connection the application shares with the
		// cache — the sessions and the queues go with it.
		const socket = pubsub();
		mockQuasar({ default: { connection: () => socket } });

		const bus = (await load())();
		const handler = (): void => {};
		bus.subscribe(handler);
		await vi.waitFor(() => expect(socket.handlers.size).toBe(1));
		const registered = socket.handlers.get("echo::invalidate");

		await bus.unsubscribe?.(handler);

		expect(socket.removed).toEqual([["echo::invalidate", registered]]);
	});

	it("waits for a subscribe still opening before removing it", async () => {
		// The socket opens on quasar's own schedule. Removing ahead of it takes
		// nothing off and leaves the handler to land afterwards, on a bus
		// nobody is tracking any more.
		const socket = pubsub();
		mockQuasar({ default: { connection: () => socket } });

		const bus = (await load())();
		const handler = (): void => {};
		bus.subscribe(handler);
		await bus.unsubscribe?.(handler);

		expect(socket.handlers.size).toBe(0);
		expect(socket.removed).toHaveLength(1);
	});

	it("keeps listening after a malformed frame", async () => {
		const socket = pubsub();
		mockQuasar({ default: { connection: () => socket } });
		const seen: BusMessage[] = [];

		const bus = (await load())();
		bus.subscribe((m) => seen.push(m));
		await vi.waitFor(() => expect(socket.handlers.size).toBe(1));

		const handler = socket.handlers.get("echo::invalidate");
		handler?.("not json");
		handler?.(JSON.stringify(message));
		expect(seen).toEqual([message]);
	});

	it("takes the manager on the namespace as well as the default export", async () => {
		const socket = pubsub();
		mockQuasar({ connection: () => socket });

		await (await load())().publish(message);
		expect(socket.published).toHaveLength(1);
	});

	it("takes a source that is itself the pub/sub surface", async () => {
		const socket = pubsub();
		mockQuasar({ publish: socket.publish, subscribe: socket.subscribe });

		await (await load())().publish(message);
		expect(socket.publish).toHaveBeenCalled();
	});

	it("names the missing package rather than failing on the first write", async () => {
		vi.doMock(SPECIFIER, () => {
			throw new Error("Cannot find module");
		});
		await expect((await load())().publish(message)).rejects.toThrow(
			/@c9up\/quasar is not installed/,
		);
	});

	it("says so when the connection cannot publish", async () => {
		mockQuasar({ default: { connection: () => ({ get: () => undefined }) } });
		await expect((await load())().publish(message)).rejects.toThrow(
			/does not expose publish\(\)\/subscribe\(\)/,
		);
	});

	it("reports a bus it cannot reach instead of pretending to listen", async () => {
		// This used to be fire-and-forget on the grounds that a bus which is
		// down costs staleness while throwing would cost every cache read. Both
		// halves still hold — they just belong to different callers now. The
		// subscribe is a `connect()` the provider awaits in `ready()`, so it
		// SAYS so; the reads are the store's, and they keep working (pinned in
		// tiered-coherence.test.ts).
		vi.doMock(SPECIFIER, () => {
			throw new Error("Cannot find module");
		});
		const bus = (await load())();

		await expect(bus.subscribe(() => {})).rejects.toThrow(
			/@c9up\/quasar is not installed/,
		);
	});
});
