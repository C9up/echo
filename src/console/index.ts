/**
 * `@c9up/echo/commands` — the commands echo ships.
 *
 *   // reamrc.ts, written by `configure()`
 *   commands: [() => import('@c9up/echo/commands')]
 *
 * A module answering `getMetaData()` / `getCommand()`, which is how a package
 * adds commands: by shipping them, never by a change to the `ream` binary.
 */

import { cacheClearCommand } from "./cacheClear.js";
import { cacheDeleteCommand } from "./cacheDelete.js";
import { cachePruneCommand } from "./cachePrune.js";
import type { EchoCommandClass } from "./contract.js";

const COMMANDS: readonly EchoCommandClass[] = [
	cacheClearCommand(),
	cacheDeleteCommand(),
	cachePruneCommand(),
];

/** What the kernel reads to list a command without importing it. */
interface CommandMetaData {
	commandName: string;
	namespace: string | null;
	description: string;
	help?: string | string[];
	aliases: string[];
	options: Record<string, unknown>;
	args: readonly unknown[];
	flags: readonly unknown[];
}

function serialize(command: EchoCommandClass): CommandMetaData {
	const colon = command.commandName.indexOf(":");
	return {
		commandName: command.commandName,
		namespace: colon === -1 ? null : command.commandName.slice(0, colon),
		description: command.description,
		help: command.help,
		aliases: [],
		options: { ...command.options },
		args: command.args ?? [],
		flags: command.flags ?? [],
	};
}

export async function getMetaData(): Promise<CommandMetaData[]> {
	return COMMANDS.map(serialize);
}

export async function getCommand(
	metadata: CommandMetaData,
): Promise<EchoCommandClass | null> {
	return (
		COMMANDS.find((command) => command.commandName === metadata.commandName) ??
		null
	);
}

export type { EchoCommandClass } from "./contract.js";
