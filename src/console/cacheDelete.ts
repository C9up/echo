/**
 * `cache:delete` — remove one key from a store.
 *
 *     ream cache:delete user:42
 *     ream cache:delete user:42 redis
 *
 * In production it asks first.
 */

import {
	argument,
	type CommandApp,
	type CommandLogger,
	type CommandPrompt,
	type EchoCommandClass,
} from "./contract.js";
import { consent, resolveStore } from "./store.js";

export function cacheDeleteCommand(): EchoCommandClass {
	return class CacheDelete {
		static commandName = "cache:delete";
		static description = "Delete a specific cache entry by key";
		static options = { startApp: true };
		static args = [
			argument("key", { description: "The cache key to delete" }),
			argument("store", {
				description: "Define a custom cache store to delete from",
				required: false,
			}),
		];

		declare key: string;
		declare store?: string;
		declare logger: CommandLogger;
		declare prompt: CommandPrompt;
		declare app: CommandApp;
		declare exitCode?: number;

		async run(): Promise<void> {
			const cache = resolveStore(this.store, this.logger);
			if (cache === undefined) {
				this.exitCode = 1;
				return;
			}
			if (
				this.app.inProduction &&
				!(await consent(
					this.prompt,
					`You are in production environment. Want to continue deleting cache key "${this.key}"?`,
				))
			) {
				return;
			}
			if (await cache.delete({ key: this.key })) {
				this.logger.success(
					`Deleted cache key "${this.key}" from "${cache.name}" cache successfully`,
				);
			} else {
				this.logger.warning(
					`Cache key "${this.key}" not found in "${cache.name}" cache`,
				);
			}
		}
	};
}
