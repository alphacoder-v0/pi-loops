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
		"jobs.json": '{"version":3,"jobs":[]}\n',
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
	assert.deepEqual([...convertStores(dir).removed].sort(), ["next-runs.json", "presence", "scheduler.json"]);
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
	assert.deepEqual(convertStores(dir), { removed: [], jobs: 0, rows: 0 });
	assert.deepEqual(convertStores(path.join(dir, "no-such-directory")), { removed: [], jobs: 0, rows: 0 });
});

test("convertStores does not throw when the loops directory is a file.", () => {
	const dir = tmp("pi-loops-convert-");
	const notADirectory = path.join(dir, "loops");
	fs.writeFileSync(notADirectory, "not a directory\n");
	assert.deepEqual(convertStores(notADirectory, () => {}).removed, []);
	assert.equal(fs.readFileSync(notADirectory, "utf8"), "not a directory\n");
});

test("convertStores does not throw when the loops directory cannot be read: it reports each name and returns.", { skip: process.getuid?.() === 0 ? "root reads anything" : false }, () => {
	const dir = tmp("pi-loops-convert-");
	fs.writeFileSync(path.join(dir, "scheduler.json"), "{}\n");
	fs.chmodSync(dir, 0o000);
	const said: string[] = [];
	try {
		assert.deepEqual(convertStores(dir, (line) => void said.push(line)).removed, []);
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

/** A `version: 2` jobs.json as 0.24.2 wrote it. */
function writeV2(dir: string, jobs: Record<string, unknown>[]): string {
	const text = `${JSON.stringify({ version: 2, jobs }, null, 2)}\n`;
	fs.writeFileSync(path.join(dir, "jobs.json"), text);
	return text;
}
const v2Loop = (dir: string, over: Record<string, unknown> = {}) => ({ id: "cron-convert", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "work", cwd: dir, enabled: true, catchUp: true, createdAt: "2026-01-05T08:00:00.000Z", runCount: 0, skippedOverlap: 0, ...over });

test("[convert-steps] A version 2 jobs.json: each cursor into clock.json, the text kept as jobs.json.v2.bak, the definitions written as version 3.", () => {
	const dir = tmp("pi-loops-convert-");
	const text = writeV2(dir, [v2Loop(dir, { runCount: 7, skippedOverlap: 2, lastDueAt: "2026-01-05T09:00:00.000Z", lastFiredAt: "2026-01-05T09:00:01.000Z", lastCompletedAt: "2026-01-05T09:01:00.000Z", consecutiveFailures: 1, cwdMissingSince: "2026-01-05T08:30:00.000Z", clearedAt: "2026-01-05T08:10:00.000Z", host: "old-box" })]);
	const said: string[] = [];
	assert.deepEqual(convertStores(dir, (line) => void said.push(line)), { removed: [], jobs: 1, rows: 0 });
	const clock = JSON.parse(fs.readFileSync(path.join(dir, "clock.json"), "utf8"));
	assert.deepEqual(clock.jobs["cron-convert"], { slot: "2026-01-05T09:00:00.000Z", fired: "2026-01-05T09:00:01.000Z", runs: 7, collapsed: 2, cleared: "2026-01-05T08:10:00.000Z", cwdMissing: "2026-01-05T08:30:00.000Z" });
	assert.equal(fs.readFileSync(path.join(dir, "jobs.json.v2.bak"), "utf8"), text);
	const written = JSON.parse(fs.readFileSync(path.join(dir, "jobs.json"), "utf8"));
	assert.equal(written.version, 3);
	assert.deepEqual(Object.keys(written.jobs[0]).sort(), ["catchUp", "createdAt", "cwd", "enabled", "id", "prompt", "schedule", "stateful"]);
	assert.equal(new JobStore(dir).load()[0].id, "cron-convert");
	assert.match(said.join("\n"), /version 2 converted to version 3 \(1 job\(s\), 0 owed run\(s\) queued\)/);
	// The second start finds version 3 and writes nothing.
	const before = [fs.readFileSync(path.join(dir, "jobs.json"), "utf8"), fs.readFileSync(path.join(dir, "clock.json"), "utf8")];
	assert.deepEqual(convertStores(dir), { removed: [], jobs: 0, rows: 0 });
	assert.deepEqual([fs.readFileSync(path.join(dir, "jobs.json"), "utf8"), fs.readFileSync(path.join(dir, "clock.json"), "utf8")], before);
});

test("[convert-disabled] A disabled job of version 2 gets its code from its reason; an enabled job's error becomes the clock's note.", () => {
	const dir = tmp("pi-loops-convert-");
	writeV2(dir, [
		v2Loop(dir, { id: "cron-person", enabled: false }),
		v2Loop(dir, { id: "cron-gone", enabled: false, stateful: false, sessionId: "s", lastError: "disabled: session 1a2b3c4d no longer exists (/cron gc removes it)" }),
		v2Loop(dir, { id: "cron-parked", enabled: false, lastError: "parked: its last 3 runs were interrupted" }),
		v2Loop(dir, { id: "cron-cwd", enabled: false, lastError: "disabled: cwd /gone has been missing since then" }),
		v2Loop(dir, { id: "cron-noted", lastDueAt: "2026-01-05T09:00:00.000Z", lastError: "missed 09:00 while no pi was running (catch-up disabled)" }),
	]);
	convertStores(dir);
	const jobs = new JobStore(dir).load();
	assert.deepEqual(jobs.map((job) => [job.id, job.disabled?.code]), [["cron-person", "person"], ["cron-gone", "session-gone"], ["cron-parked", "interrupted"], ["cron-cwd", "cwd-missing"], ["cron-noted", undefined]]);
	const clock = JSON.parse(fs.readFileSync(path.join(dir, "clock.json"), "utf8"));
	assert.deepEqual(clock.jobs["cron-noted"].note, { at: "2026-01-05T09:00:00.000Z", text: "missed 09:00 while no pi was running (catch-up disabled)" });
});

test("[convert-owed] An owed slot and a dead run marker become one row each of the job's lane; a second start writes none.", () => {
	const dir = tmp("pi-loops-convert-");
	const slot = new Date(Date.now() - 60_000).toISOString();
	writeV2(dir, [v2Loop(dir, { lastDueAt: slot, owedSlot: slot, interruptions: 2, running: { runId: "old-run", pid: 2_000_000_000, startedAt: slot } })]);
	assert.equal(convertStores(dir).rows, 1);
	const row = new RequestStore(dir).list("@cron-convert")[0];
	assert.equal(row?.created_by.instance, "convert");
	assert.equal(row?.attempts, 2);
	assert.equal(row?.payload?.slot, slot);
	assert.equal(convertStores(dir).rows, 0);
	assert.equal(new RequestStore(dir).list("@cron-convert").length, 1);
});

test("[convert-crash] A start that stopped after the rows and before version 3 is finished by the next: the cursors are written again, the rows are not.", () => {
	const dir = tmp("pi-loops-convert-");
	const slot = new Date(Date.now() - 60_000).toISOString();
	const text = writeV2(dir, [v2Loop(dir, { runCount: 4, lastDueAt: slot, owedSlot: slot })]);
	convertStores(dir);
	// The version 2 file is back as it was before step 5, with a stale cursor a partial attempt left.
	fs.writeFileSync(path.join(dir, "jobs.json"), text);
	fs.writeFileSync(path.join(dir, "clock.json"), JSON.stringify({ v: 1, jobs: { "cron-convert": { runs: 1 } } }));
	assert.deepEqual(convertStores(dir), { removed: [], jobs: 1, rows: 0 });
	assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "clock.json"), "utf8")).jobs["cron-convert"].runs, 4);
	assert.equal(new RequestStore(dir).list("@cron-convert").length, 1);
});

test("[convert-live] A run marker whose process lives gets no row and one line: that older process still runs it, and its record will come.", () => {
	const dir = tmp("pi-loops-convert-");
	const slot = new Date(Date.now() - 60_000).toISOString();
	// A pid that is alive: this process's parent, which is not this process.
	writeV2(dir, [v2Loop(dir, { id: "cron-dead", lastDueAt: slot, running: { runId: "dead-run", pid: 2_000_000_000, startedAt: slot } }), v2Loop(dir, { id: "cron-live", lastDueAt: slot, running: { runId: "live-run", pid: process.ppid, startedAt: new Date().toISOString() } })]);
	const said: string[] = [];
	convertStores(dir, (line) => void said.push(line));
	assert.equal(new RequestStore(dir).list("@cron-dead").length, 1, "the dead marker's slot is a row");
	assert.equal(new RequestStore(dir).list("@cron-live").length, 0);
	assert.ok(said.some((line) => /cron-live: an older pi-loops process still runs it; its record will come/.test(line)));
	assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "jobs.json"), "utf8")).version, 3);
});

test("[convert-unreadable] A jobs.json that does not parse is left as it is, for the store to say what is wrong with it.", () => {
	const dir = tmp("pi-loops-convert-");
	fs.writeFileSync(path.join(dir, "jobs.json"), "{ half-typed");
	assert.deepEqual(convertStores(dir), { removed: [], jobs: 0, rows: 0 });
	assert.equal(fs.readFileSync(path.join(dir, "jobs.json"), "utf8"), "{ half-typed");
	assert.equal(fs.existsSync(path.join(dir, "jobs.json.v2.bak")), false);
});

test("convertStores removes a retired name that is a link, and leaves what the link points to.", () => {
	const dir = tmp("pi-loops-convert-");
	const elsewhere = tmp("pi-loops-elsewhere-");
	fs.writeFileSync(path.join(elsewhere, "keep.txt"), "not ours\n");
	fs.symlinkSync(elsewhere, path.join(dir, "presence"));
	assert.deepEqual(convertStores(dir).removed, ["presence"]);
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
		assert.deepEqual(convertStores(dir, (line) => void said.push(line)).removed, ["scheduler.json"]);
	} finally {
		fs.chmodSync(path.join(dir, "presence"), 0o700);
	}
	assert.equal(said.length, 1);
	assert.match(said[0], /^could not remove presence, which an older version left: /);
});
