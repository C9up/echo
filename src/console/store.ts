/**
 * What the three cache commands share: reaching the store they were given,
 * and asking before they touch a production cache.
 */

import type { CacheManager } from "../CacheManager.js";
import { getCache } from "../services/main.js";
import type { CommandLogger, CommandPrompt } from "./contract.js";

/**
 * The store a command names, or the default one — `undefined` after reporting
 * why there is none, so the command can stop with a non-zero exit.
 */
export function resolveStore(
	name: string | undefined,
	logger: CommandLogger,
): CacheManager | undefined {
	const cache = getCache();
	if (cache === undefined) {
		// Naming the wiring beats a stack trace out of the service proxy: the
		// usual cause is a project that never added the provider.
		logger.error(
			"No cache is configured. Add `() => import('@c9up/echo/provider')` to the providers in reamrc.ts.",
		);
		return undefined;
	}
	try {
		return cache.use(name);
	} catch {
		logger.error(
			`"${name ?? "default"}" is not a valid cache store. Double check config/cache.ts file`,
		);
		return undefined;
	}
}

/** A yes from the operator; a prompt that cannot be answered is a no. */
export async function consent(
	prompt: CommandPrompt,
	question: string,
): Promise<boolean> {
	try {
		return await prompt.confirm(question);
	} catch {
		return false;
	}
}
