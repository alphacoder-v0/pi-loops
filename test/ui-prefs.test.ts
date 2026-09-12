import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { panelEnabled, readUiPrefs, writeUiPref } from "../src/ui-prefs.ts";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-ui-prefs-"));

/** The bytes the browser front end writes, so a test starts from a file it really produced. */
const asWebWritesIt = (dir: string, doc: unknown): void => {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "ui.json"), `${JSON.stringify(doc, null, 2)}\n`);
};

test("turning the panel off keeps the model and thinking level the browser remembered", () => {
	const dir = tmp();
	asWebWritesIt(dir, { model: "anthropic/claude-opus-5", thinking: "high" });

	writeUiPref(dir, "panel", false);
	assert.deepEqual(readUiPrefs(dir), { panel: false, model: "anthropic/claude-opus-5", thinking: "high" });

	// The whole point of the file: what the next session starts with survives the toggle. Writing
	// the panel key on its own used to leave `{"panel":false}` and send that session to pi's default.
	writeUiPref(dir, "panel", true);
	const back = readUiPrefs(dir);
	assert.equal(panelEnabled(back), true, "and the panel key round-trips both ways");
	assert.equal(back.model, "anthropic/claude-opus-5");
	assert.equal(back.thinking, "high");
});

test("a ui.json that is missing or corrupt is not lost from, and still takes the key being written", () => {
	const missing = tmp();
	fs.rmSync(missing, { recursive: true }); // not even the loops directory exists yet
	assert.doesNotThrow(() => writeUiPref(missing, "panel", false));
	assert.equal(panelEnabled(readUiPrefs(missing)), false, "a first write creates the file");

	const corrupt = tmp();
	fs.writeFileSync(path.join(corrupt, "ui.json"), '{"model": "anthropic/cl'); // a torn write, or an edit
	assert.deepEqual(readUiPrefs(corrupt), {}, "nothing readable is nothing remembered");
	assert.equal(panelEnabled(readUiPrefs(corrupt)), true, "so the panel is on, as on a fresh install");
	assert.doesNotThrow(() => writeUiPref(corrupt, "model", "openai/gpt-5"));
	assert.equal(readUiPrefs(corrupt).model, "openai/gpt-5", "and the key being written is there afterwards");
});

test("a key this project has never heard of survives a write", () => {
	const dir = tmp();
	// The front end is a separate writer and may remember something before this module knows of it;
	// merging by key rather than rebuilding the document is what makes that safe in either order.
	asWebWritesIt(dir, { model: "openai/gpt-5", someLaterPreference: { kept: true } });
	writeUiPref(dir, "panel", false);
	const doc = JSON.parse(fs.readFileSync(path.join(dir, "ui.json"), "utf8"));
	assert.deepEqual(doc, { model: "openai/gpt-5", someLaterPreference: { kept: true }, panel: false });
});

test("what this module writes is byte for byte what the browser front end writes", () => {
	// `src/web.mjs` is plain JS: it cannot import this module, so it keeps its own copy of the
	// read-merge-write and the format is the contract between them. If one of them starts writing
	// compact JSON the file still parses, and the disagreement only shows up as a diff nobody
	// expected in a file people open — which is the kind of thing that goes unnoticed for months.
	const dir = tmp();
	const doc = { model: "openai/gpt-5", thinking: "high", panel: false };
	writeUiPref(dir, "panel", false);
	writeUiPref(dir, "model", "openai/gpt-5");
	writeUiPref(dir, "thinking", "high");
	assert.equal(fs.readFileSync(path.join(dir, "ui.json"), "utf8"), `${JSON.stringify({ panel: false, model: "openai/gpt-5", thinking: "high" }, null, 2)}\n`);

	const web = fs.readFileSync(path.join(process.cwd(), "src", "web.mjs"), "utf8");
	const remember = web.slice(web.indexOf("function rememberPref("));
	const write = remember.slice(0, remember.indexOf("\n}")).match(/writeFileSync\(file, (.*)\);/)?.[1];
	assert.ok(write, "rememberPref no longer writes ui.json the way this test reads it");
	// Evaluated rather than string-compared, so a rewrite that means the same thing still passes.
	const theirBytes = new Function("doc", `return ${write};`)(doc);
	assert.equal(theirBytes, `${JSON.stringify(doc, null, 2)}\n`, "the front end's spelling and this module's still agree");
});
