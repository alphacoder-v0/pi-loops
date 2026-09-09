import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * pi drops an extension command that shares a name with one of its own built-ins ("conflicts with
 * built-in interactive command. Skipping in autocomplete."), and the built-in wins at the prompt —
 * so the command silently does nothing in the terminal while still working in modes that have no
 * built-ins, which is exactly how `/share` shipped and was verified. The list is not exported from
 * the package, so this reads it out of the installed build.
 */
function builtinCommandNames(): string[] {
	const root = execSync("npm root -g", { encoding: "utf8" }).trim();
	const file = path.join(root, "@earendil-works", "pi-coding-agent", "dist", "core", "slash-commands.js");
	const source = fs.readFileSync(file, "utf8");
	return [...source.matchAll(/name:\s*"([a-z][a-z0-9:-]*)"/g)].map((m) => m[1]);
}

function ourCommandNames(): string[] {
	const source = fs.readFileSync(path.join(process.cwd(), "src", "pi-loops.ts"), "utf8");
	return [...source.matchAll(/registerCommand\("([a-z][a-z0-9-]*)"/g)].map((m) => m[1]);
}

test("no command of ours has the name of one of pi's own", () => {
	const builtins = new Set(builtinCommandNames());
	assert.ok(builtins.size > 10, `read ${builtins.size} built-in names — the parser has probably gone stale`);
	const ours = ourCommandNames();
	assert.ok(ours.length > 5, `read ${ours.length} of our commands — the parser has probably gone stale`);
	const clashes = ours.filter((name) => builtins.has(name));
	assert.deepEqual(clashes, [], `these are shadowed by pi's own commands and will not run in the terminal: ${clashes.join(", ")}`);
});
