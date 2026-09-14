import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PI_MIN_VERSION, piTooOld } from "../src/pi-floor.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

test("a pi below the floor is refused with both versions in the sentence; at or above it is not", () => {
	const refusal = piTooOld("0.80.8", "0.84.3");
	assert.ok(refusal?.includes("0.84.3") && refusal.includes("0.80.8"), refusal);
	assert.equal(piTooOld("0.84.3", "0.84.3"), undefined);
	assert.equal(piTooOld("0.85.1", "0.84.3"), undefined);
	assert.equal(piTooOld("1.0.0", "0.84.3"), undefined);
	assert.equal(piTooOld("v0.84.3", "0.84.3"), undefined, "pi may spell it with a v");
	assert.ok(piTooOld("0.84.2", "0.84.3"), "one patch short is short");
	assert.ok(piTooOld("0.9.9", "0.84.3"), "numeric, not lexical: 9 < 84");
});

test("no version at all is an old pi, not an unknown one", () => {
	assert.ok(piTooOld(undefined, "0.84.3")?.includes("no version"));
	assert.ok(piTooOld("dev", "0.84.3")?.includes('"dev"'));
});

test("the floor is one number: the code, the manifest entry and both READMEs agree on it", () => {
	const manifest = JSON.parse(read("package.json"));
	assert.deepEqual(manifest.pi.extensions, ["./src/extension-entry.ts"], "pi must load the entry that checks, not the extension it guards");
	for (const doc of ["README.md", "README.zh-CN.md"]) {
		assert.ok(read(doc).includes(`pi ≥ ${PI_MIN_VERSION}`), `${doc} does not state the floor as \`pi ≥ ${PI_MIN_VERSION}\``);
	}
});

test("the entry imports nothing that would fail to link on the pi it is about to refuse", () => {
	// A static import of src/pi-loops.ts (or anything under it) puts the link error back in front
	// of the check; only the version module and pi's own package may be imported before it runs.
	const statics = [...read("src/extension-entry.ts").matchAll(/^import\b[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
	assert.deepEqual([...new Set(statics)].sort(), ["./pi-floor.ts", "@earendil-works/pi-coding-agent"]);
	assert.match(read("src/extension-entry.ts"), /await import\("\.\/pi-loops\.ts"\)/, "the extension is loaded after the check, dynamically");
	const floorImports = [...read("src/pi-floor.ts").matchAll(/^import\b/gm)];
	assert.equal(floorImports.length, 0, "src/pi-floor.ts must not import anything");
});
