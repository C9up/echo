/**
 * `cache:prune` — drop the entries a store knows to be expired. Only useful
 * for stores that do not expire on their own; Redis does.
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

export function cachePruneCommand(): EchoCommandClass {
	return class CachePrune {
		static commandName = "cache:prune";
		static description =
			"Remove expired cache entries from the selected store. This command is only useful for stores without native TTL support.";
		static options = { startApp: true };
		static args = [
			argument("store", {
				description: "Define a custom cache store to prune",
				required: false,
			}),
		];

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
					"You are in production environment. Want to continue pruning expired cache entries?",
				))
			) {
				return;
			}
			await cache.prune();
			this.logger.success(
				`Pruned expired entries from "${cache.name}" cache successfully`,
			);
		}
	};
}
