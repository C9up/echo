/**
 * No type assertion in shipped source (bug 333): no `as T`, no `<T>x`, no
 * `x!`. `as const` is a literal, not an assertion, and stays allowed.
 *
 * Read with the TypeScript parser rather than a grep, so `as` in a comment or
 * a message is not mistaken for one. `src/vendor` is generated from a file
 * outside this package and is checked where it is generated.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..", "src");

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			return name === "vendor" ? [] : sources(path);
		}
		return path.endsWith(".ts") ? [path] : [];
	});
}

function assertions(path: string): string[] {
	const file = ts.createSourceFile(
		path,
		readFileSync(path, "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
	const found: string[] = [];
	const visit = (node: ts.Node): void => {
		const isConst =
			ts.isAsExpression(node) &&
			ts.isTypeReferenceNode(node.type) &&
			node.type.typeName.getText(file) === "const";
		if (
			(ts.isAsExpression(node) && !isConst) ||
			ts.isTypeAssertionExpression(node) ||
			ts.isNonNullExpression(node)
		) {
			const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
			found.push(`${relative(root, path)}:${line + 1} ${node.getText(file)}`);
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}

describe("echo > shipped source", () => {
	it("holds no type assertion", () => {
		expect(sources(root).flatMap(assertions)).toEqual([]);
	});
});
