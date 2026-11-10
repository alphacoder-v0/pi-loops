import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { panelEnabled, readUiPrefs, writeUiPref } from "../src/ui-prefs.ts";
import { installLauncher } from "../src/cli.ts";


/** The bytes the browser front end writes, so a test starts from a file it really produced. */
const asWebWritesIt = (dir: string, doc: unknown): void => {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "ui.json"), `${JSON.stringify(doc, null, 2)}\n`);
};

test("turning the panel off keeps the model and thinking level the browser remembered", () => {
	const dir = tmp("pi-loops-ui-prefs-");
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
	const missing = tmp("pi-loops-ui-prefs-");
	fs.rmSync(missing, { recursive: true }); // not even the loops directory exists yet
	assert.doesNotThrow(() => writeUiPref(missing, "panel", false));
	assert.equal(panelEnabled(readUiPrefs(missing)), false, "a first write creates the file");

	const corrupt = tmp("pi-loops-ui-prefs-");
	fs.writeFileSync(path.join(corrupt, "ui.json"), '{"model": "anthropic/cl'); // a torn write, or an edit
	assert.deepEqual(readUiPrefs(corrupt), {}, "nothing readable is nothing remembered");
	assert.equal(panelEnabled(readUiPrefs(corrupt)), true, "so the panel is on, as on a fresh install");
	assert.doesNotThrow(() => writeUiPref(corrupt, "model", "openai/gpt-5"));
	assert.equal(readUiPrefs(corrupt).model, "openai/gpt-5", "and the key being written is there afterwards");
});

test("a launcher declined once is not asked about again, until one is written", async () => {
	const dir = tmp("pi-loops-ui-prefs-");
	asWebWritesIt(dir, { model: "openai/gpt-5" });

	// The first pi session after `pi install` puts `pi-loops` on the PATH. A removal has to outlive
	// the session, or the next window writes it back.
	writeUiPref(dir, "launcher", "declined");
	assert.equal(readUiPrefs(dir).launcher, "declined");
	assert.equal(readUiPrefs(dir).model, "openai/gpt-5", "and the rest of the file is still there");

	// It was "not now", not "never": `/pi-loops install-launcher` writes one and takes the mark off,
	// so a launcher deleted later by hand is written again at the next session.
	const bin = tmp("pi-loops-bin-");
	const saved = process.env.PI_LOOPS_DIR;
	process.env.PI_LOOPS_DIR = dir;
	try {
		assert.equal(await installLauncher(bin, () => {}), 0);
	} finally {
		if (saved === undefined) delete process.env.PI_LOOPS_DIR;
		else process.env.PI_LOOPS_DIR = saved;
	}
	assert.equal(readUiPrefs(dir).launcher, undefined, "the mark is gone");
	assert.equal(readUiPrefs(dir).model, "openai/gpt-5", "and clearing it kept everything else");
});

test("a key this project has never heard of survives a write", () => {
	const dir = tmp("pi-loops-ui-prefs-");
	// The front end is a separate writer and may remember something before this module knows of it;
	// merging by key rather than rebuilding the document is what makes that safe in either order.
	asWebWritesIt(dir, { model: "openai/gpt-5", someLaterPreference: { kept: true } });
	writeUiPref(dir, "panel", false);
	const doc = JSON.parse(fs.readFileSync(path.join(dir, "ui.json"), "utf8"));
	assert.deepEqual(doc, { model: "openai/gpt-5", someLaterPreference: { kept: true }, panel: false });
});
