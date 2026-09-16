/**
 * The downstream contract is written once, in `CONTRACT.md` §2.2: the keys a `recipe.toml` may
 * carry, the two hook events and the `run_*` fields of their payload, the ten fields of a finding.
 * `docs/downstream.md` is that rule in use — prose and examples for a program that will never open
 * the contract. This test reads both documents, and each one differently.
 *
 * From `CONTRACT.md` §2.2: every name it fixes must be one the source really has — a key
 * `src/recipe.ts` reads, a field `src/hooks.ts` puts in a payload, a field `FINDING_FIELDS` in
 * `src/inbox.ts` names. It runs one way only: a name in the source the contract does not fix is
 * not a failure, because the interface is what the contract lists and nothing else.
 *
 * From `docs/downstream.md`: the examples have to be the real thing — every `PI_RUN_*` variable it
 * shows exists, and the keys of its finding object are the fields a finding carries, in order. And
 * the page must not state the rule a second time: a list restated here is the one that goes stale,
 * so the prose (everything outside a fenced block) may not name the fields §2.2 already names.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

/** A `### N.N` subsection of CONTRACT.md, up to the next one. */
function subsection(doc: string, n: string): string {
	const parts = doc.split(/^### /m);
	const found = parts.find((p) => p.startsWith(`${n} `));
	assert.ok(found, `CONTRACT.md has a section ${n}`);
	return found;
}

/** One `- **Label**:` bullet of it, with the parentheses dropped: those hold values, not names. */
function bullet(text: string, label: string): string {
	const found = text.split(/^- /m).find((b) => b.startsWith(`**${label}**`));
	assert.ok(found, `CONTRACT.md §2.2 has a ${label} bullet`);
	return found.replace(/\([^)]*\)/g, "");
}

/** The names a bullet gives in backticks — `name`, `run_id`, never `recipe.toml` or `[[job]]`. */
const names = (text: string) => [...new Set(text.match(/`[a-z_]+`/g) ?? [])].map((n) => n.slice(1, -1));

/** A document with its fenced blocks cut out: what is left is the prose. */
const prose = (doc: string) => doc.replace(/^```[\s\S]*?^```/gm, "");

/** The fields a finding carries, in order: the one list src/inbox.ts keeps. */
function findingFields(): string[] {
	const list = /FINDING_FIELDS = \[([^\]]*)\]/.exec(read("src/inbox.ts"));
	assert.ok(list, "src/inbox.ts names the fields a finding carries");
	return [...list![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

test("every name CONTRACT.md §2.2 fixes exists in src/", () => {
	const unitFormats = subsection(read("CONTRACT.md"), "2.2");
	const hooks = read("src/hooks.ts");
	const recipe = read("src/recipe.ts");

	// recipe.toml keys, required and optional, read by parseManifest as `"key"` (a helper's
	// argument) or `doc.key`.
	const keys = names(bullet(unitFormats, "Recipe"));
	assert.ok(keys.includes("name") && keys.includes("schedule"), "the contract names the manifest keys");
	for (const k of keys) assert.match(recipe, new RegExp(`["'.]${k}\\b`), `${k} is a key src/recipe.ts reads`);

	// The two events, and the payload's other `run_*` fields: `src/hooks.ts` builds both.
	const fields = [...new Set(bullet(unitFormats, "Event").match(/\brun_[a-z_]+/g))];
	assert.ok(fields.length >= 2, "the contract names the run events");
	for (const f of fields) {
		if (f === "run_start" || f === "run_end") assert.match(hooks, new RegExp(`"${f}"`), `${f} is a hook event`);
		else assert.match(hooks, new RegExp(`\\b${f}\\??:`), `${f} is a field of the hook payload`);
	}

	// The finding's fields, as `FINDING_FIELDS` names them — the list `findingJson` in src/cli.ts
	// picks off an entry.
	const written = findingFields();
	const fixed = names(bullet(unitFormats, "Finding"));
	assert.ok(fixed.includes("id") && fixed.includes("dismiss_reason"), "the contract names the fields of a finding");
	for (const f of fixed) assert.ok(written.includes(f), `${f} is a field a finding carries`);
});

test("docs/downstream.md shows the contract in use and does not restate it", () => {
	const doc = read("docs/downstream.md");
	const hooks = read("src/hooks.ts");

	// $PI_RUN_* variables: `src/hooks.ts` builds them from a map keyed `RUN_OK`, `RUN_FINDINGS`, …
	const vars = [...new Set(doc.match(/\bPI_RUN_[A-Z_]+/g))];
	assert.ok(vars.length >= 2, "the page's hook example reads the run variables");
	for (const v of vars) assert.match(hooks, new RegExp(`\\b${v.slice(3)}:`), `${v} is a variable src/hooks.ts sets`);

	// The finding it shows is the example of §2.2, not a second statement of it: every field, in
	// the order a finding carries them.
	const example = /```json\n([\s\S]*?)```/.exec(doc);
	assert.ok(example, "the page shows a finding as JSON");
	assert.deepEqual(Object.keys(JSON.parse(example![1])), findingFields(), "the example is every field of a finding, in order");

	// One name out of each of the three lists, as a tripwire: in the prose it means the page has
	// started keeping its own copy of §2.2. In an example it is fine — that is what the page is for.
	for (const name of ["needs_propose", "run_cost_usd", "dismiss_reason"])
		assert.ok(!prose(doc).includes(name), `docs/downstream.md leaves ${name} to CONTRACT.md §2.2, outside its examples`);
});
