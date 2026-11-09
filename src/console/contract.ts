/**
 * The console command contract, declared locally.
 *
 * Echo stays framework-agnostic: it must not import `@c9up/ream`, so it
 * describes the shape Ream's console kernel dispatches against rather than
 * importing it. The kernel assigns `logger`, `prompt` and — for a command that
 * starts the app — `app` before it calls `run()`.
 */

export interface CommandOptions {
	/** Boot the application before `run()`. */
	startApp?: boolean;
}

export interface ArgumentMetaData {
	type: "string" | "spread";
	propertyName: string;
	argumentName: string;
	description?: string;
	required: boolean;
	default?: string | string[];
}

export interface FlagMetaData {
	type: "string" | "boolean" | "number" | "array";
	propertyName: string;
	flagName: string;
	description?: string;
	alias: string[];
	default?: string | string[] | number | boolean;
	required: boolean;
}

/** The slice of the kernel's logger these commands write to. */
export interface CommandLogger {
	success(message: string): void;
	warning(message: string): void;
	error(message: string): void;
}

/** The slice of the kernel's prompt these commands ask through. */
export interface CommandPrompt {
	confirm(message: string): Promise<boolean>;
}

/** The slice of the booted application these commands read. */
export interface CommandApp {
	readonly inProduction: boolean;
}

/** The static side the kernel reads. */
export interface EchoCommandClass {
	new (): { run(): Promise<void> | void };
	commandName: string;
	description: string;
	options?: CommandOptions;
	args?: readonly ArgumentMetaData[];
	flags?: readonly FlagMetaData[];
	help?: string | string[];
}

/** `startServer` → `start-server`, matching the framework's decorators. */
function dashCase(value: string): string {
	return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

export function flag(
	propertyName: string,
	type: FlagMetaData["type"],
	options: { description?: string; alias?: string[] } = {},
): FlagMetaData {
	return {
		type,
		propertyName,
		flagName: dashCase(propertyName),
		description: options.description,
		alias: options.alias ?? [],
		required: false,
	};
}

export function argument(
	propertyName: string,
	options: { description?: string; required?: boolean } = {},
): ArgumentMetaData {
	return {
		type: "string",
		propertyName,
		argumentName: dashCase(propertyName),
		description: options.description,
		required: options.required ?? true,
	};
}
