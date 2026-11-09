/**
 * `ream configure @c9up/echo` — wire the cache in one command.
 *
 * The provider alone is not enough: it reads `config/cache.ts`, and a package
 * registered without one falls back to a default that is rarely the one an
 * application wants. Writing both together is what makes `ream add` mean
 * installed AND working.
 */

import { stubsRoot } from "./stubs.js";

interface Codemods {
	addProvider(importPath: string): Promise<void>;
	registerCommand(importPath: string): Promise<void>;
	addEnvVars(vars: Record<string, string>): Promise<void>;
	writeFile(
		filePath: string,
		content: string,
		options?: { force?: boolean },
	): Promise<void>;
	makeUsingStub(
		stubsRoot: string,
		stubPath: string,
		state?: Record<string, string | number | boolean>,
		options?: { force?: boolean },
	): Promise<{ path: string; contents: string }>;
}

export async function configure(codemods: Codemods): Promise<void> {
	// The config below reads these, so they are declared here. Writing the file
	// without them leaves an application whose config asks the environment for
	// something nothing ever put there.
	await codemods.addEnvVars({
		CACHE_STORE: "memory",
	});

	await codemods.addProvider("@c9up/echo/provider");
	// `cache:clear`, `cache:delete` and `cache:prune` are the package's, not the
	// binary's: a project reaches them by listing the module.
	await codemods.registerCommand("@c9up/echo/commands");
	await codemods.makeUsingStub(stubsRoot, "config/cache.stub");
}
