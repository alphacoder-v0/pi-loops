import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { type ClaimRowStores, RETIRED_FILES, convertClaimRows, convertStores } from "../src/convert-v2.ts";
import { type ProtocolWrite, PROTOCOL } from "../src/ask.ts";
import { Inbox } from "../src/inbox.ts";
import { TriggerStore } from "../src/triggers.ts";
import { JobStore, JobsNotConverted } from "../src/store.ts";
import { RequestStore } from "../src/requests.ts";
import { clockStore } from "../src/stores.ts";

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

test("[convert-put-back] A version 2 file put back while pi-loops runs is read as definitions, and a write of it throws until the next start converts it.", async () => {
	const dir = tmp("pi-loops-convert-");
	writeV2(dir, [v2Loop(dir, { runCount: 5, lastError: "missed a slot" })]);
	const store = new JobStore(dir);
	assert.deepEqual(store.load().map((job) => [job.id, (job as any).runCount]), [["cron-convert", undefined]], "the definition, no counter");
	const before = fs.readFileSync(path.join(dir, "jobs.json"), "utf8");
	await assert.rejects(store.update("cron-convert", (job) => { job.name = "renamed"; }), (err: Error) => err instanceof JobsNotConverted && /version 2 was put back while pi-loops ran; restart pi-loops to convert it$/.test(err.message));
	assert.equal(fs.readFileSync(path.join(dir, "jobs.json"), "utf8"), before, "nothing of it is lost before the start converts it");
	convertStores(dir);
	assert.equal((await store.update("cron-convert", (job) => { job.name = "renamed"; }))?.name, "renamed");
});

test("[convert-malformed] A hand-edited version 2 file converts, twice, without throwing: a field that is not what it says is dropped alone, an owed run goes only to the job's own lane", () => {
	const dir = tmp("pi-loops-convert-");
	const slot = new Date(Date.now() - 60_000).toISOString();
	writeV2(dir, [
		v2Loop(dir, { id: "cron-number-error", enabled: false, lastError: 5 }),
		v2Loop(dir, { id: "cron-bad-fields", runCount: 4, skippedOverlap: 1.5, lastDueAt: slot, lastFiredAt: "yesterday", cwdMissingSince: 7, lastError: { text: "x" }, interruptions: -100, owedSlot: slot }),
		v2Loop(dir, { id: "cron-escape", stateful: false, sessionId: "../../evil", owedSlot: slot }),
		v2Loop(dir, { id: "cron-other-lane", stateful: false, sessionId: "@cron-victim", owedSlot: slot, tools: ["bash"] }),
		v2Loop(dir, { id: "cron-marker", running: "not a marker", owedSlot: 12345 }),
		null as any, 42 as any, { name: "no id" },
	]);
	const said: string[] = [];
	for (let start = 0; start < 2; start++) assert.doesNotThrow(() => convertStores(dir, (line) => void said.push(line)), `start ${start + 1}`);
	assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "jobs.json"), "utf8")).version, 3);
	const jobs = new JobStore(dir).load();
	assert.deepEqual(jobs.map((job) => job.id), ["cron-number-error", "cron-bad-fields", "cron-escape", "cron-other-lane", "cron-marker"]);
	assert.deepEqual(jobs[0].disabled?.code, "person", "a reason that is not text is no reason");
	const clock = clockStore(dir).read().jobs;
	assert.deepEqual(clock["cron-bad-fields"], { slot, runs: 4 }, "the good fields of a cursor stay when others are dropped");
	const requests = new RequestStore(dir);
	assert.deepEqual(requests.list("@cron-bad-fields").map((row) => row.attempts), [0], "an attempt count that is not one starts at 0");
	assert.equal(fs.existsSync(path.join(dir, "requests")) && fs.readdirSync(path.join(dir, "requests")).some((name) => name.includes("victim") || name.includes("evil")), false, "no row for a lane that is not the job's own conversation");
	assert.equal(requests.list("@cron-marker").length, 0, "a slot that is not a stamp owes nothing");
	assert.ok(said.some((line) => /cron-escape: its owed run is not queued/.test(line)) && said.some((line) => /cron-other-lane: its owed run is not queued/.test(line)));
	assert.ok(said.some((line) => /3 entries with no id left out/.test(line)));
});

test("[convert-version-text] A version that is not a number is not converted: the file stays as it is, and its jobs read as definitions.", () => {
	const dir = tmp("pi-loops-convert-");
	const text = JSON.stringify({ version: "3", jobs: [{ ...v2Loop(dir), runCount: undefined, skippedOverlap: undefined, enabled: false, disabled: { code: "cwd-missing", why: "disabled: cwd /gone", at: "2026-01-05T08:00:00.000Z" } }] });
	fs.writeFileSync(path.join(dir, "jobs.json"), text);
	assert.deepEqual(convertStores(dir), { removed: [], jobs: 0, rows: 0 });
	assert.equal(fs.readFileSync(path.join(dir, "jobs.json"), "utf8"), text);
	assert.equal(fs.existsSync(path.join(dir, "jobs.json.v2.bak")), false);
	assert.equal(new JobStore(dir).load()[0].disabled?.why, "disabled: cwd /gone");
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

/* A row that 0.24.2 queued for a claim (source `inbox:<finding>`), converted at start: K1 and K2 of PROTOCOL (src/ask.ts). */

const CONV = "01a1dce4-8ad1-77c0-89b0-475ccfeaf683";
const HANDED = `inb-${"a".repeat(32)}`;
const OPEN = `inb-${"b".repeat(32)}`;
const LOST = `inb-${"c".repeat(32)}`;

/** A finding that 0.24.2 claimed: `claimed` with `claimed_by`, and no answer. */
function oldClaimedFinding(id: string, cwd: string): Record<string, unknown> {
	return { id, created_at: "2026-11-01T09:00:00.000+00:00", status: "claimed", kind: "checkpoint", source: "cron:watch", run_id: `run-${id.slice(4)}`, cwd, text: "decide this", verified: null, dismiss_reason: null, job_id: "cron-watch", claimed_by: "terminal" };
}

/** The version 2 line of the row 0.24.2's `/inbox claim` queued in a conversation. */
function oldClaimRow(finding: string, cwd: string, handed: boolean): Record<string, unknown> {
	return { v: 2, session_id: CONV, id: `claim-${finding.slice(4, 12)}`, kind: "input", source: `inbox:${finding}`, mode: "attended", wake: "turn", payload: { text: `[Trigger claim] ${finding}`, cwd }, created_by: { pid: 2_000_000_000, instance: "w", version: "0.24.2" }, created_at: "2026-11-01T09:01:00.000+00:00", attempts: 0, ...(handed ? { handed_at: "2026-11-01T09:01:01.000+00:00" } : {}) };
}

/** A loops directory 0.24.2 left with one claim row per finding of `rows`, and `findings` in its inbox. */
function claimDir(rows: Array<{ finding: string; handed: boolean }>, findings: string[]): string {
	const dir = tmp("pi-loops-convert-");
	fs.writeFileSync(path.join(dir, "inbox.jsonl"), findings.map((id) => `${JSON.stringify(oldClaimedFinding(id, dir))}\n`).join(""));
	const file = new RequestStore(dir).file(CONV);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, rows.map(({ finding, handed }) => `${JSON.stringify(oldClaimRow(finding, dir, handed))}\n`).join(""));
	return dir;
}

class Stopped extends Error {}

/**
 * The stores of `dir` for `convertClaimRows`, each durable write logged with the locks held at it
 * (as test/ask.test.ts logs them), and a process that stops just after write `stopAfter`: from then on
 * every write throws before it is made.
 */
function loggedStores(dir: string, stopAfter = Infinity): { stores: ClaimRowStores; log: Array<{ write: ProtocolWrite["write"]; lock: ProtocolWrite["lock"] }> } {
	const inbox = new Inbox(dir);
	const requests = new RequestStore(dir);
	const audit = new TriggerStore(dir);
	const log: Array<{ write: ProtocolWrite["write"]; lock: ProtocolWrite["lock"] }> = [];
	let inboxHeld = false;
	let laneHeld = false;
	let dead = false;
	const durable = <T>(write: ProtocolWrite["write"], lock: ProtocolWrite["lock"], make: () => T, wrote: (result: T) => boolean): T => {
		if (dead) throw new Stopped();
		const result = make();
		if (wrote(result)) {
			log.push({ write, lock });
			if (log.length >= stopAfter) {
				dead = true;
				throw new Stopped();
			}
		}
		return result;
	};
	const stores: ClaimRowStores = {
		inbox: {
			sectionSync: (fn) =>
				inbox.sectionSync((tx) => {
					inboxHeld = true;
					try {
						return fn({ list: () => tx.list(), find: (id) => tx.find(id), fileOnce: (entry, id) => tx.fileOnce(entry, id), write: (c, ...more) => durable("finding", laneHeld ? "inbox+lane" : "inbox", () => tx.write(c, ...more), () => true) });
					} finally {
						inboxHeld = false;
					}
				}),
		},
		requests: {
			sessions: () => requests.sessions(),
			list: (lane) => requests.list(lane),
			removeIf: (lane, id, when, lock) => {
				const held = inboxHeld ? "inbox+lane" : "lane";
				return durable("row-", held, () => {
					laneHeld = true;
					try {
						return requests.removeIf(lane, id, when, lock);
					} finally {
						laneHeld = false;
					}
				}, (r) => r.outcome === "removed");
			},
		},
		audit: { appendAudit: (record) => durable("audit", "none", () => audit.appendAudit(record), () => true) },
	};
	return { stores, log };
}

const want = (writes: readonly ProtocolWrite[]) => writes.map(({ write, lock }) => ({ write, lock }));
const findingOf = (dir: string, id: string) => new Inbox(dir).list().find((f) => f.id === id);
const convertedAudit = (dir: string) => new TriggerStore(dir).listAudit(100, (r) => r.type === "request" && r.state === "converted").reverse().map((r) => [r.traceId, r.details?.finding, r.details?.reason]);
const snapshot = (dir: string) => [fs.readFileSync(path.join(dir, "inbox.jsonl"), "utf8"), fs.existsSync(new RequestStore(dir).file(CONV)) ? fs.readFileSync(new RequestStore(dir).file(CONV), "utf8") : null];

test("[K1] A claim row 0.24.2 handed over leaves at start, its finding stays claimed, and a second start changes nothing; a stop after each write converges", () => {
	const dir = claimDir([{ finding: HANDED, handed: true }], [HANDED]);
	const { stores, log } = loggedStores(dir);
	assert.deepEqual(convertClaimRows(stores, () => {}), { handed: 1, reopened: 0 });
	assert.deepEqual(log, want(PROTOCOL.K1), "the writes and their locks are PROTOCOL's");
	assert.deepEqual(new RequestStore(dir).list(CONV), []);
	assert.equal(findingOf(dir, HANDED)?.status, "claimed", "it was handed to pi before the upgrade: nothing to open again");
	assert.deepEqual(convertedAudit(dir), [[`claim-${HANDED.slice(4, 12)}`, HANDED, "handed over before the upgrade"]]);
	const before = snapshot(dir);
	assert.deepEqual(convertStores(dir), { removed: [], jobs: 0, rows: 0 });
	assert.deepEqual(snapshot(dir), before, "the second start writes nothing");
	for (let stop = 1; stop <= PROTOCOL.K1.length; stop++) {
		const v = claimDir([{ finding: HANDED, handed: true }], [HANDED]);
		const crashed = loggedStores(v, stop);
		convertClaimRows(crashed.stores, () => {});
		assert.deepEqual(crashed.log, want(PROTOCOL.K1).slice(0, stop), `stopped after write ${stop}`);
		convertStores(v);
		assert.deepEqual(new RequestStore(v).list(CONV), [], `stop ${stop}: the row is gone`);
		assert.equal(findingOf(v, HANDED)?.status, "claimed", `stop ${stop}: the finding stays claimed`);
	}
});

test("[K2] A claim row 0.24.2 had not handed over opens its finding again and leaves; a row whose finding is gone just leaves; a second start changes nothing; a stop after each write converges", () => {
	const dir = claimDir([{ finding: OPEN, handed: false }, { finding: LOST, handed: false }], [OPEN]);
	const { stores, log } = loggedStores(dir);
	const said: string[] = [];
	assert.deepEqual(convertClaimRows(stores, (line) => void said.push(line)), { handed: 0, reopened: 1 });
	assert.deepEqual(log, [...want(PROTOCOL.K2), { write: "row-", lock: "inbox+lane" }, { write: "audit", lock: "none" }], "K2's writes, then the lost one's row and audit");
	assert.deepEqual(new RequestStore(dir).list(CONV), []);
	const open = findingOf(dir, OPEN);
	assert.equal(open?.status, "new");
	for (const field of ["claimed_by", "answered_by", "answer"] as const) assert.equal(open?.[field], undefined, `no ${field}`);
	assert.equal(new Inbox(dir).list().length, 1, "no finding is filed for the one that is gone");
	assert.deepEqual(convertedAudit(dir), [[`claim-${OPEN.slice(4, 12)}`, OPEN, "open again after the upgrade"], [`claim-${LOST.slice(4, 12)}`, LOST, "its finding is not in the inbox"]]);
	assert.ok(said.some((line) => /1 claim\(s\) queued before the upgrade are open again/.test(line)), said.join("\n"));
	const before = snapshot(dir);
	convertStores(dir);
	assert.deepEqual(snapshot(dir), before, "the second start writes nothing");
	for (let stop = 1; stop <= PROTOCOL.K2.length; stop++) {
		const v = claimDir([{ finding: OPEN, handed: false }], [OPEN]);
		const crashed = loggedStores(v, stop);
		convertClaimRows(crashed.stores, () => {});
		assert.deepEqual(crashed.log, want(PROTOCOL.K2).slice(0, stop), `stopped after write ${stop}`);
		if (stop === 1) assert.equal(new RequestStore(v).list(CONV).length, 1, "a stop after the finding leaves the row, which finds it at the next start");
		convertStores(v);
		assert.deepEqual(new RequestStore(v).list(CONV), [], `stop ${stop}: the row is gone`);
		assert.equal(findingOf(v, OPEN)?.status, "new", `stop ${stop}: the finding is open again`);
		assert.equal(findingOf(v, OPEN)?.claimed_by, undefined);
	}
});

test("[K2] A finding a person answered after the row's finding was opened again is not opened a second time", () => {
	const dir = claimDir([{ finding: OPEN, handed: false }], []);
	// A stop after K2 left the row; then a person said yes from this version before the next start.
	const yes = { ...oldClaimedFinding(OPEN, dir), answered_by: "terminal", answer: { state: "pending", at: "2026-11-01T09:05:00.000+00:00" } };
	fs.writeFileSync(path.join(dir, "inbox.jsonl"), `${JSON.stringify(yes)}\n`);
	assert.deepEqual(convertClaimRows(loggedStores(dir).stores, () => {}), { handed: 0, reopened: 0 });
	assert.deepEqual(new RequestStore(dir).list(CONV), []);
	assert.deepEqual([findingOf(dir, OPEN)?.status, findingOf(dir, OPEN)?.answered_by, findingOf(dir, OPEN)?.answer?.state], ["claimed", "terminal", "pending"]);
});
