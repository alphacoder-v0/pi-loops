/**
 * docs/downstream.md names things a program may depend on, and each name must be one the source
 * really has: a `PI_RUN_*` variable a hook can read, a `recipe.toml` key the manifest parser reads,
 * a field the inbox JSON carries. The test reads the page and looks each name up in `src/`. It runs
 * one way only — a name in the source that the page does not mention is not a failure, because
 * the interface is what the page lists and nothing else; keeping the page short is an editorial
 * decision, not something a test should push against.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

/** The `## N.` sections of the page, by number, so each vocabulary is looked up where it belongs. */
function section(doc: string, n: number): string {
	const parts = doc.split(/^## /m);
	const found = parts.find((p) => p.startsWith(`${n}. `));
	assert.ok(found, `docs/downstream.md has a section ${n}`);
	return found;
}

test("every name docs/downstream.md gives a program exists in src/", () => {
	const doc = read("docs/downstream.md");
	const hooks = read("src/hooks.ts");
	const recipe = read("src/recipe.ts");
	const cli = read("src/cli.ts");

	// $PI_RUN_* variables: `src/hooks.ts` builds them from a map keyed `RUN_OK`, `RUN_FINDINGS`, …
	const vars = [...new Set(doc.match(/\bPI_RUN_[A-Z_]+/g))];
	assert.ok(vars.length >= 2, "the page names the run variables");
	for (const v of vars) assert.match(hooks, new RegExp(`\\b${v.slice(3)}:`), `${v} is a variable src/hooks.ts sets`);

	// The two events, and the payload's other `run_*` fields, in the same section.
	const fields = [...new Set(section(doc, 2).match(/\brun_[a-z_]+/g))];
	for (const f of fields) {
		if (f === "run_start" || f === "run_end") assert.match(hooks, new RegExp(`"${f}"`), `${f} is a hook event`);
		else assert.match(hooks, new RegExp(`\\b${f}\\??:`), `${f} is a field of the hook payload`);
	}

	// recipe.toml keys: what the page lists in backticks in section 1, read by parseManifest as
	// `"key"` (a helper's argument) or `doc.key`.
	const keys = [...new Set(section(doc, 1).match(/`([a-z_]+)`/g)!.map((k) => k.slice(1, -1)))].filter((k) => k !== "recipe");
	assert.ok(keys.includes("name") && keys.includes("schedule"), "the page names the manifest keys");
	for (const k of keys) assert.match(recipe, new RegExp(`["'.]${k}\\b`), `${k} is a key src/recipe.ts reads`);

	// The finding's JSON fields: the keys of the example object, as `findingJson` writes them.
	const example = /```json\n([\s\S]*?)```/.exec(section(doc, 3));
	assert.ok(example, "section 3 shows a finding as JSON");
	const shown = Object.keys(JSON.parse(example![1]));
	const written = [...cli.matchAll(/^\t\t([a-z_]+): /gm)].map((m) => m[1]);
	for (const k of shown) assert.ok(written.includes(k), `${k} is a field findingJson writes`);
});
