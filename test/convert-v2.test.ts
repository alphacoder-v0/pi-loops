import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { RETIRED_FILES, convertStores } from "../src/convert-v2.ts";
import { JobStore } from "../src/store.ts";
import { RequestStore } from "../src/requests.ts";

/** A loops directory as an older version left it: the retired files, and files that stay. */
function seeded(): { dir: string; kept: Record<string, string> } {
	const dir = tmp("pi-loops-convert-");
	fs.writeFileSync(path.join(dir, "next-runs.json"), '{"at":"then","next":{}}\n');
	fs.writeFileSync(path.join(dir, "scheduler.json"), '{"pid":1,"kind":"service"}\n');
	fs.mkdirSync(path.join(dir, "presence"));
	fs.writeFileSync(path.join(dir, "presence", "box-41-w22.json"), '{"pid":41}\n');
	// Names that only look like a retired one stay, with the stores.
	const kept: Record<string, string> = {
		"jobs.json": '{"version":2,"jobs":[]}\n',
		"inbox.jsonl": '{"id":"f-1"}\n',
		"host-service.json": '{"v":1,"pid":7}\n',
		"scheduler.json.bak": "a copy somebody made\n",
		"presence.json": "{}\n",
		"next-runs.json.txt": "notes\n",
	};
	for (const [name, text] of Object.entries(kept)) fs.writeFileSync(path.join(dir, name), text);
	fs.mkdirSync(path.join(dir, "state", "cron-a"), { recursive: true });
	fs.writeFileSync(path.join(dir, "state", "cron-a", "presence"), "a loop's own note\n");
	return { dir, kept };
}

test("The files that older versions left are next-runs.json, scheduler.json and presence.", () => {
	assert.deepEqual([...RETIRED_FILES].sort(), ["next-runs.json", "presence", "scheduler.json"]);
});

test("convertStores removes every retired file and says which ones it removed.", () => {
	const { dir } = seeded();
	assert.deepEqual(convertStores(dir).sort(), ["next-runs.json", "presence", "scheduler.json"]);
	for (const name of RETIRED_FILES) assert.equal(fs.existsSync(path.join(dir, name)), false, `${name} is gone`);
});

test("convertStores removes nothing that is not in its list.", () => {
	const { dir, kept } = seeded();
	convertStores(dir);
	for (const [name, text] of Object.entries(kept)) assert.equal(fs.readFileSync(path.join(dir, name), "utf8"), text, `${name} is as it was`);
	assert.equal(fs.readFileSync(path.join(dir, "state", "cron-a", "presence"), "utf8"), "a loop's own note\n", "a file of that name deeper in the directory is not a retired file");
	assert.deepEqual(fs.readdirSync(dir).sort(), [...Object.keys(kept), "state"].sort());
});

test("convertStores does nothing the second time, and nothing in a directory that is not there.", () => {
	const { dir } = seeded();
	convertStores(dir);
	assert.deepEqual(convertStores(dir), []);
	assert.deepEqual(convertStores(path.join(dir, "no-such-directory")), []);
});

test("convertStores does not throw when the loops directory is a file.", () => {
	const dir = tmp("pi-loops-convert-");
	const notADirectory = path.join(dir, "loops");
	fs.writeFileSync(notADirectory, "not a directory\n");
	assert.deepEqual(convertStores(notADirectory, () => {}), []);
	assert.equal(fs.readFileSync(notADirectory, "utf8"), "not a directory\n");
});

test("convertStores does not throw when the loops directory cannot be read: it reports each name and returns.", { skip: process.getuid?.() === 0 ? "root reads anything" : false }, () => {
	const dir = tmp("pi-loops-convert-");
	fs.writeFileSync(path.join(dir, "scheduler.json"), "{}\n");
	fs.chmodSync(dir, 0o000);
	const said: string[] = [];
	try {
		assert.deepEqual(convertStores(dir, (line) => void said.push(line)), []);
	} finally {
		fs.chmodSync(dir, 0o700);
	}
	assert.equal(said.length, 3);
	assert.equal(fs.existsSync(path.join(dir, "scheduler.json")), true);
});

test("the host and window open stores through openStores, which runs conversion first.", () => {
	const here = path.dirname(new URL(import.meta.url).pathname);
	const stores = fs.readFileSync(path.join(here, "..", "src", "stores.ts"), "utf8");
	assert.match(stores, /export function openStores[\s\S]*?convertStores\(dir, log\)/);
	const host = fs.readFileSync(path.join(here, "..", "src", "host-runtime.ts"), "utf8");
	assert.match(host, /const stores = deps\.stores \?\? openStores\(dir, log\)/);
	const background = fs.readFileSync(path.join(here, "..", "src", "host.ts"), "utf8");
	assert.match(background, /const stores = openStores\(dir, log\)/);
	const window = fs.readFileSync(path.join(here, "..", "src", "pi-loops.ts"), "utf8");
	assert.match(window, /const stores = openStores\(dir,/);
});

test("M4b.3 step 2 turns an owed loop marker into one conversion row before clearing its markers.", async () => {
	const dir = tmp("pi-loops-convert-");
	const jobs = new JobStore(dir);
	const slot = new Date(Date.now() - 60_000).toISOString();
	await jobs.add({ id: "cron-convert", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "work", cwd: dir, enabled: true, catchUp: true, createdAt: slot, runCount: 0, skippedOverlap: 0, lastDueAt: slot, owedSlot: slot, interruptions: 2, running: { runId: "old-run", pid: 2_000_000_000, startedAt: slot } });
	convertStores(dir);
	const row = new RequestStore(dir).list("@cron-convert")[0];
	assert.equal(row?.created_by.instance, "convert");
	assert.equal(row?.attempts, 2);
	assert.equal(row?.payload?.slot, slot);
	const saved = jobs.load()[0];
	assert.equal(saved.running, undefined);
	assert.equal(saved.owedSlot, undefined);
	convertStores(dir);
	assert.equal(new RequestStore(dir).list("@cron-convert").length, 1);
});

test("convertStores removes a retired name that is a link, and leaves what the link points to.", () => {
	const dir = tmp("pi-loops-convert-");
	const elsewhere = tmp("pi-loops-elsewhere-");
	fs.writeFileSync(path.join(elsewhere, "keep.txt"), "not ours\n");
	fs.symlinkSync(elsewhere, path.join(dir, "presence"));
	assert.deepEqual(convertStores(dir), ["presence"]);
	assert.equal(fs.readFileSync(path.join(elsewhere, "keep.txt"), "utf8"), "not ours\n");
});

test("convertStores reports a file it cannot remove, goes on to the next, and does not throw.", { skip: process.getuid?.() === 0 ? "root removes anything" : false }, () => {
	const dir = tmp("pi-loops-convert-");
	fs.mkdirSync(path.join(dir, "presence"));
	fs.writeFileSync(path.join(dir, "presence", "box-41-w22.json"), "{}\n");
	fs.writeFileSync(path.join(dir, "scheduler.json"), "{}\n");
	// A directory that cannot be written to keeps its entries.
	fs.chmodSync(path.join(dir, "presence"), 0o500);
	const said: string[] = [];
	try {
		assert.deepEqual(convertStores(dir, (line) => void said.push(line)), ["scheduler.json"]);
	} finally {
		fs.chmodSync(path.join(dir, "presence"), 0o700);
	}
	assert.equal(said.length, 1);
	assert.match(said[0], /^could not remove presence, which an older version left: /);
});
