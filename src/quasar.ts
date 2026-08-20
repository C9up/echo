/**
 * Resolving a Redis connection by name, from `@c9up/quasar`.
 *
 * Echo does not depend on quasar: it is an optional peer, and this module
 * never imports it statically. The specifier is built at runtime so the
 * TypeScript build stays free of it too — a hard type import would make echo
 * unbuildable for anyone who caches in memory.
 *
 * The shape is checked before use rather than asserted, the same way echo
 * duck-types its host framework.
 */

import type { RedisClient } from "./drivers/RedisDriver.js";

/** The slice of quasar's manager this needs: a connection, by name. */
interface ConnectionSource {
	connection(name?: string): unknown;
}

function isConnectionSource(value: unknown): value is ConnectionSource {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "connection") === "function"
	);
}

function isRedisClient(value: unknown): value is RedisClient {
	if (typeof value !== "object" || value === null) return false;
	// The commands this driver actually issues. A connection missing one of
	// them would fail on the first cache write, far from the cause.
	const required = ["get", "set", "del", "exists", "keys", "sadd", "srem", "smembers", "expire", "ttl"];
	return required.every((name) => typeof Reflect.get(value, name) === "function");
}

/**
 * A resolver for `drivers.redis({ connection })` — quasar is loaded on the
 * first cache command, not at config time.
 */
export function quasarConnection(name?: string): () => Promise<RedisClient> {
	return async () => {
		const specifier = "@c9up/quasar/services/main";
		let loaded: unknown;
		try {
			loaded = await import(/* @vite-ignore */ specifier);
		} catch (cause) {
			throw new Error(
				`Echo: the "${name ?? "default"}" cache store asks for a quasar connection, but @c9up/quasar is not installed.\n` +
					"  pnpm add @c9up/quasar",
				{ cause },
			);
		}

		const manager = isConnectionSource(loaded)
			? loaded
			: Reflect.get(Object(loaded), "default");
		if (!isConnectionSource(manager)) {
			throw new Error("Echo: @c9up/quasar/services/main did not expose a connection() manager");
		}

		const connection = manager.connection(name);
		if (!isRedisClient(connection)) {
			throw new Error(
				`Echo: quasar connection "${name ?? "default"}" does not carry the commands this cache needs`,
			);
		}
		return connection;
	};
}
