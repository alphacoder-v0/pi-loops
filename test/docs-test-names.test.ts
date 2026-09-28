/**
 * Every `test/<file>`: *<name>* a document names is a test that exists.
 *
 * docs/web-ui-parity.md is the release gate for the browser front end, and it states its own rule:
 * "Where a line is enforced by a test, the test is named." Nothing read those names, so when e64be37
 * renamed a test the line kept pointing at the old one — *a job this machine no longer owns is
 * listed, not hidden*, which had become *what the machine has that this project does not is counted,
 * apart*. A reader checking the gate for that test found nothing, and could not tell whether the
 * line was still enforced or had been dropped. This reads the names.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A document writes a reference as `` `test/file.ts`: *name* ``. Markdown wraps the emphasised name
 * across lines and the test declares it on one, so both sides are whitespace-normalised; and a
 * document may quote the first clause of a longer name, which is why a declared name that starts
 * with the quoted one counts.
 */
function assertNamed(doc: string, file: string, name: string): void {
	const full = path.join(root, file);
	assert.ok(fs.existsSync(full), `${doc} names ${file}, which is not there`);
	const declared = [...fs.readFileSync(full, "utf8").matchAll(/^test\(\s*"((?:[^"\\]|\\.)*)"/gm)].map((m) => m[1]);
	assert.ok(declared.some((d) => d === name || d.startsWith(name)), `${doc} names "${name}", which ${file} does not have`);
}

test("every test a document names exists in the file it names", () => {
	const docs = fs.readdirSync(path.join(root, "docs")).filter((f) => f.endsWith(".md")).sort();
	let seen = 0;
	for (const doc of docs) {
		const text = fs.readFileSync(path.join(root, "docs", doc), "utf8");
		// A reference can name several tests of one file: `test/f.ts`: *one*, *two*; *three*.
		for (const m of text.matchAll(/`(test\/[^`]+)`:((?:\s*[,;]?\s*\*[^*]+\*)+)/g)) {
			for (const name of m[2].matchAll(/\*([^*]+)\*/g)) {
				assertNamed(doc, m[1], name[1].replace(/\s+/g, " ").trim());
				seen++;
			}
		}
	}
	// A regex that quietly stopped matching would let this whole file pass on nothing.
	assert.ok(seen >= 40, `the documents name their tests; found ${seen}`);
});
