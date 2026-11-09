/**
 * `cache:clear` — empty a store, one of its namespaces, or its entries under
 * some tags.
 *
 *     ream cache:clear
 *     ream cache:clear redis --namespace=users
 *     ream cache:clear --tags=products --tags=shop
 *
 * In production it asks first, unless `--force`.
 */

import {
	argument,
	type CommandApp,
	type CommandLogger,
	type CommandPrompt,
	type EchoCommandClass,
	flag,
} from "./contract.js";
import { consent, resolveStore } from "./store.js";

export function cacheClearCommand(): EchoCommandClass {
	return class CacheClear {
		static commandName = "cache:clear";
		static description = "Clear the application cache";
		static options = { startApp: true };
		static args = [
			argument("store", {
				description: "Define a custom cache store to clear",
				required: false,
			}),
		];
		static flags = [
			flag("namespace", "string", {
				description: "Select a cache namespace to clear",
				alias: ["n"],
			}),
			flag("tags", "array", {
				description: "Specify tags to invalidate",
				alias: ["t"],
			}),
			flag("force", "boolean", {
				description: "Explicitly force to clear cache in production",
			}),
		];

		declare store?: string;
		declare namespace?: string;
		declare tags?: string[];
		declare force?: boolean;
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
			const tags = this.tags ?? [];
			if (this.namespace && tags.length > 0) {
				this.logger.error(
					"Cannot use --namespace and --tags options together. Please choose one or the other.",
				);
				this.exitCode = 1;
				return;
			}
			if (
				this.app.inProduction &&
				!this.force &&
				!(await consent(
					this.prompt,
					"You are in production environment. Want to continue clearing the cache?",
				))
			) {
				return;
			}
			if (tags.length > 0) {
				await cache.deleteByTag({ tags });
				this.logger.success(
					`Invalidated tags [${tags.join(", ")}] for "${cache.name}" cache successfully`,
				);
			} else if (this.namespace) {
				await cache.namespace(this.namespace).clear();
				this.logger.success(
					`Cleared namespace "${this.namespace}" for "${cache.name}" cache successfully`,
				);
			} else {
				await cache.clear();
				this.logger.success(`Cleared "${cache.name}" cache successfully`);
			}
		}
	};
}
