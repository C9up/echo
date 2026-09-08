/**
 * Resolving a Redis connection by name, from `@c9up/quasar`.
 *
 * Echo does not depend on quasar: it is an optional peer, and neither this
 * module nor the vendored loader it calls imports it statically. The specifier
 * is built at runtime so the TypeScript build stays free of it too.
 *
 * The loading, the shape check and the messages are the same in every package
 * that offers a Redis-backed option, so they are vendored rather than written
 * again: `src/vendor/quasarConnection.ts`, generated from one source. The bus
 * below is echo's alone and stays here.
 */

import type { RedisClient } from "./drivers/RedisDriver.js";
import type { BusMessage, CacheBus } from "./drivers/TieredDriver.js";
import { quasarConnection as loadQuasarConnection } from "./vendor/quasarConnection.js";

/**
 * The commands this driver actually issues.
 *
 * `keys` and `exists` are deliberately absent: `RedisClient` declares them, but
 * nothing here calls them — `flush()` walks a SCAN cursor because it considers
 * KEYS unsafe in production, so demanding `keys` would reject a client that
 * omits it on exactly the grounds this driver agrees with. `scan` is optional
 * on the interface, and `flush()` reports its absence with a message of its
 * own.
 */
const REQUIRED = [
	"get",
	"set",
	"del",
	"sadd",
	"srem",
	"smembers",
	"expire",
	"ttl",
] as const;

/**
 * A resolver for `drivers.redis({ connection })` — quasar is loaded on the
 * first cache command, not at config time.
 */
export function quasarConnection(name?: string): () => Promise<RedisClient> {
	return async () =>
		loadQuasarConnection<RedisClient>({
			pkg: "echo",
			name,
			required: REQUIRED,
			what: "the cache store",
			raise: (_reason, message, cause) => new Error(message, { cause }),
		});
}

/** The slice of quasar's manager this needs: a connection, by name. */
interface ConnectionSource {
	connection(name?: string): unknown;
}

function isConnectionSource(value: unknown): value is ConnectionSource {
	return (
		typeof value === "object" &&
		value !== null &&
		"connection" in value &&
		typeof Reflect.get(value, "connection") === "function"
	);
}

/** The slice of quasar's manager a pub/sub bus needs. */
interface PubSubSource {
	publish(channel: string, message: string): unknown;
	subscribe(channel: string, handler: (message: string) => void): unknown;
	/**
	 * Optional, and NAMED when it is there: quasar stacks handlers per channel,
	 * so dropping them all would silence whatever else the application listens
	 * to on the connection echo borrows.
	 */
	unsubscribe?(channel: string, handler?: (message: string) => void): unknown;
}

function isPubSubSource(value: unknown): value is PubSubSource {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "publish") === "function" &&
		typeof Reflect.get(value, "subscribe") === "function"
	);
}

/**
 * Resolve quasar's manager, loading it on first use.
 *
 * Shared by the connection resolver and the bus: echo declares quasar an
 * optional peer and never imports it statically, so an application that caches
 * in memory neither installs it nor pays for it.
 */
async function loadQuasar(context: string): Promise<unknown> {
	const specifier = "@c9up/quasar/services/main";
	try {
		const loaded = await import(/* @vite-ignore */ specifier);
		return isConnectionSource(loaded) || isPubSubSource(loaded)
			? loaded
			: Reflect.get(Object(loaded), "default");
	} catch (cause) {
		throw new Error(
			`Echo: ${context}, but @c9up/quasar is not installed.\n  pnpm add @c9up/quasar`,
			{ cause },
		);
	}
}

/**
 * Redis pub/sub as a cache bus, for keeping each instance's L1 in step.
 *
 * A two-layer store without one is wrong the moment a second instance exists:
 * each process keeps serving its own L1 copy of a key another process has
 * already deleted, and nothing ever tells it. That is what the bus is for, and
 * it is why `useBus` sits next to `useL2Layer` in the generated config.
 *
 * Quasar opens the subscriber socket lazily and on its own connection — Redis
 * puts a subscribed client into a mode where it accepts nothing else, so a
 * connection that both publishes and listens needs two.
 */
export function quasarBus(options?: {
	connection?: string;
	channel?: string;
}): CacheBus {
	const channel = options?.channel ?? "echo::invalidate";
	let ready: Promise<PubSubSource> | undefined;
	/** Per subscriber, the wrapper actually registered — once it has been. */
	const opened = new Map<
		(message: BusMessage) => void,
		Promise<(raw: string) => void>
	>();

	const manager = (): Promise<PubSubSource> => {
		ready ??= loadQuasar(
			`the cache bus asks for the "${options?.connection ?? "default"}" quasar connection`,
		).then((loaded) => {
			const source = isConnectionSource(loaded)
				? loaded.connection(options?.connection)
				: loaded;
			if (!isPubSubSource(source)) {
				throw new Error(
					"Echo: the quasar connection does not expose publish()/subscribe()",
				);
			}
			return source;
		});
		return ready;
	};

	return {
		async publish(message: BusMessage): Promise<void> {
			const source = await manager();
			await source.publish(channel, JSON.stringify(message));
		},
		subscribe(handler: (message: BusMessage) => void): void {
			const wrapper = (raw: string): void => {
				try {
					handler(JSON.parse(raw) as BusMessage);
				} catch {
					/* a malformed frame is not a reason to stop listening */
				}
			};
			// Not awaited: `subscribe` is synchronous in the bus contract, and the
			// socket opens on quasar's own schedule. A failure to reach Redis must
			// not take down the store — a bus that is down costs staleness, and
			// throwing here would cost every cache read.
			opened.set(
				handler,
				manager()
					.then((source) => source.subscribe(channel, wrapper))
					.catch(() => {
						/* reported by the first publish, which surfaces its error */
					})
					.then(() => wrapper),
			);
		},
		async unsubscribe(handler: (message: BusMessage) => void): Promise<void> {
			// The subscribe may still be opening the socket. Removing ahead of it
			// takes nothing off and leaves the handler to land afterwards, on a
			// bus nobody is tracking any more.
			const pending = opened.get(handler);
			if (pending === undefined) return;
			opened.delete(handler);
			const wrapper = await pending;
			const source = await manager();
			// NAMED. Quasar keeps a `Set` of handlers per channel, so an unnamed
			// unsubscribe drops every listener on a connection the application
			// shares with the cache.
			await source.unsubscribe?.(channel, wrapper);
		},
	};
}
