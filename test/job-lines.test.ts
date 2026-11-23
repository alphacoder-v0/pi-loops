import { test } from "node:test";
import assert from "node:assert/strict";
import { personRow, plainJobRow, queuedPrompt, recipeRow } from "../src/engine.ts";
import type { InboxEntry } from "../src/inbox.ts";
import { heldJobsNotice, jobLines, leftConversationLine, panelLines, pickQueued, proposalsNotice, queueLines, statusField, statusWord, toolsCapNotice, loopLabel, wokeWords } from "../src/job-lines.ts";
import { formatLocal } from "../src/schedule.ts";
import { capWords } from "../src/guard.ts";
import { parseSchedule, stamp } from "../src/schedule.ts";
import type { RunRecord } from "../src/store.ts";
import { fromV2, type V2Job } from "../src/convert-v2.ts";
import { type ListedJob, listedJob, runHistory } from "../src/job-status.ts";

/**
 * docs/loops.md:319-323 prints the two lines `/cron` shows for a job, and :146-150 names the
 * `[session … — resume it to run]` and `[orphan: cwd missing]` markers. Those lines are the
 * behaviour, so each marker and column gets asserted here — a test that only reads the parts
 * (`job-signal.ts`, `job-owner.ts`) cannot see one go from the line a person reads.
 */
const DAY = 86_400_000;
const NOW = Date.parse("2026-09-15T09:00:00.000+08:00");
const HOME = "/home/dev";
const SESSION = "01a09fef-2222";

/**
 * The jobs here are written as a version 2 file held them, and converted as a start converts them
 * (src/convert-v2.ts `fromV2`): the definition for jobs.json, the cursor for clock.json.
 */
const linesFor = (jobs: V2Job[], opts: Partial<Parameters<typeof jobLines>[1]> = {}) =>
	jobLines(jobs.map((j) => fromV2(j).job), { clock: Object.fromEntries(jobs.map((j) => [j.id, fromV2(j).clock])), runs: [], inbox: [], requests: () => [], view: { sessionId: SESSION, holdsOwn: true, holderOf: () => undefined }, now: NOW, home: HOME, cwdExists: () => true, showCwd: false, ...opts });

const job = (over: Partial<V2Job> = {}): V2Job => ({
	id: "cron-b91def87",
	name: "pr-watch",
	schedule: parseSchedule("*/15 * * * *", NOW),
	stateful: true,
	prompt: "check the repo issues",
	cwd: "/home/dev/code/acme-api",
	enabled: true,
	catchUp: true,
	createdAt: new Date(NOW - 10 * DAY).toISOString(),
	runCount: 412,
	skippedOverlap: 0,
	...over,
});

/** A job as the panel gets it: listed, with no rows and no run log. */
const shown = (j: V2Job): ListedJob => { const { job: definition, clock } = fromV2(j); return listedJob(definition, clock, [], undefined); };

const run = (daysAgo: number, findings: number): RunRecord => {
	const at = new Date(NOW - daysAgo * DAY).toISOString();
	return { runId: `r-${daysAgo}`, jobId: "cron-b91def87", stateful: true, cwd: "/home/dev/code/acme-api", pid: 1, startedAt: at, finishedAt: at, ok: true, findings, droppedFindings: 0, stateUpdated: true };
};
let inboxSeq = 0;
const entry = (daysAgo: number, over: Partial<InboxEntry> = {}): InboxEntry => ({
	id: `inb-${inboxSeq++}`,
	created_at: new Date(NOW - daysAgo * DAY).toISOString(),
	source: "cron:cron-b91def87",
	text: "f",
	kind: "news",
	run_id: "r",
	job_id: "cron-b91def87",
	cwd: "/home/dev/code/acme-api",
	verified: null,
	dismiss_reason: null,
	status: "dismissed",
	...over,
});

test("a loop's lines: the markers, the action, and the 30-day counts", () => {
	// Six findings in the window (two runs' worth), a quiet streak of four, and six dismissals of
	// which four carry a reason — the example in docs/loops.md:319-323.
	const runs = [run(20, 3), run(15, 3), run(5, 0), run(3, 0), run(2, 0), run(1, 0)];
	const inbox = [entry(20, { dismiss_reason: "noise" }), entry(20, { dismiss_reason: "noise" }), entry(20, { dismiss_reason: "noise" }), entry(20, { dismiss_reason: "noise" }), entry(20), entry(20)];
	const [head, action, meta] = linesFor([job()], { runs, inbox, showCwd: true });
	assert.equal(head, ' 1. cron-b91def87 "pr-watch"  */15 * * * *  [stateful]  [quiet ×4]');
	assert.equal(action, "    action: check the repo issues");
	assert.match(meta, /^    next .+ · runs 412 · 30d: 6 findings · 6 dismissed \(4 with a reason\) · ~\/code\/acme-api$/);
});

test("a plain job of a session not open here is marked asleep and has no next run", () => {
	const [head, , meta] = linesFor([job({ stateful: false, catchUp: false, sessionId: "01a09f6d-1111", runCount: 0 })]);
	assert.equal(head, ' 1. cron-b91def87 "pr-watch"  */15 * * * *  [session 01a09f6d-1111 — resume it to run]');
	assert.equal(meta, "    next — · runs 0", "the path only in /cron all: this list is one project's");
});

test("a plain job of a session another window holds says where it is open, with no pid, and keeps its next run", () => {
	const [head, , meta] = linesFor([job({ stateful: false, catchUp: false, sessionId: "01a09f6d-1111", runCount: 0 })], { view: { sessionId: SESSION, holdsOwn: true, holderOf: (id) => (id === "01a09f6d-1111" ? 4242 : undefined) } });
	assert.equal(head, ' 1. cron-b91def87 "pr-watch"  */15 * * * *  [session 01a09f6d-1111 — open in a terminal]');
	assert.match(meta, /^    next \d{4}-\d{2}-\d{2} \d{2}:\d{2}/, "it will run, in that window");
});

/** The job's prompt as the row its conversation holds, queued `ageMs` before NOW. */
const queuedRow = (jobId: string, ageMs: number) => plainJobRow({ id: jobId, sessionId: SESSION, prompt: "check the repo issues", cwd: "/home/dev/code/acme-api", model: undefined, thinking: undefined }, `run-${jobId}`, `cron:${jobId}`, "", { pid: 1, instance: "w", version: "0" }, NOW - ageMs);

test("a plain job whose prompt is queued says so, with how long", () => {
	const plain = job({ stateful: false, catchUp: false, sessionId: SESSION, runCount: 0 });
	const [head] = linesFor([plain], { requests: (id) => (id === SESSION ? [queuedRow(plain.id, 3 * 60_000)] : []) });
	assert.equal(head, ' 1. cron-b91def87 "pr-watch"  */15 * * * *  [queued 3m]');
	// A hand-over that failed: the row waits out its backoff, and the line says until when.
	const until = stamp(NOW + 4 * 60_000);
	const [backing] = linesFor([plain], { requests: () => [{ ...queuedRow(plain.id, 90_000), not_before: until, attempts: 1 }] });
	assert.equal(backing, ` 1. cron-b91def87 "pr-watch"  */15 * * * *  [queued 1m — backing off until ${until}]`);
});

test("a job with nothing queued looks as before", () => {
	const plain = job({ stateful: false, catchUp: false, sessionId: SESSION, runCount: 0 });
	const before = linesFor([plain]);
	assert.equal(before[0], ' 1. cron-b91def87 "pr-watch"  */15 * * * *');
	// Another job's row in the same conversation is not this job's prompt.
	assert.deepEqual(linesFor([plain], { requests: () => [queuedRow("cron-other", 60_000)] }), before);
	// A loop has no queue to wait in.
	assert.doesNotMatch(linesFor([job()], { requests: () => [queuedRow("cron-b91def87", 60_000)] })[0], /queued/);
});

test("a plain job whose row a run has claimed says running with the run's id, and not queued: its turn is going in the background", () => {
	const plain = job({ stateful: false, catchUp: false, sessionId: SESSION, runCount: 0 });
	const claimed = { ...queuedRow(plain.id, 60_000), run: { id: "run-claimed", pid: 4242, started_at: new Date(NOW - 30_000).toISOString() } };
	const [head] = linesFor([plain], { requests: (id) => (id === SESSION ? [claimed] : []) });
	assert.equal(head, ' 1. cron-b91def87 "pr-watch"  */15 * * * *  running run-claimed');
	// Another job's claim in the same conversation is not this job's run.
	const other = { ...queuedRow("cron-other", 60_000), run: claimed.run };
	assert.equal(linesFor([plain], { requests: () => [other] })[0], ' 1. cron-b91def87 "pr-watch"  */15 * * * *');
});

test("a loop whose checkout is gone says so", () => {
	const [head] = linesFor([job()], { cwdExists: () => false });
	assert.equal(head, ' 1. cron-b91def87 "pr-watch"  */15 * * * *  [stateful]  [orphan: cwd missing]');
});

test("a job that does not catch up, and one with a checker, are marked", () => {
	const [head] = linesFor([job({ catchUp: false, verify: true })]);
	assert.equal(head, ' 1. cron-b91def87 "pr-watch"  */15 * * * *  [stateful]  [verify]  [no-catchup]');
});

test("/cron marks only what differs from a job's default, and the path only across projects", () => {
	const plain = { stateful: false, sessionId: SESSION, runCount: 0 };
	assert.equal(linesFor([job({ ...plain, catchUp: false })])[0], ' 1. cron-b91def87 "pr-watch"  */15 * * * *', "a plain job does not catch up by default");
	assert.equal(linesFor([job({ ...plain, catchUp: true })])[0], ' 1. cron-b91def87 "pr-watch"  */15 * * * *  [catchup]', "the flag's own spelling");
	assert.equal(linesFor([job()])[0], ' 1. cron-b91def87 "pr-watch"  */15 * * * *  [stateful]', "a loop catches up by default");
	assert.equal(linesFor([job({ enabled: false })])[0], ' 1. cron-b91def87 "pr-watch"  disabled  */15 * * * *  [stateful]', "disabled is said; enabled is not");
	assert.doesNotMatch(linesFor([job()])[2], /acme-api/, "one project's list does not repeat its path");
	assert.match(linesFor([job()], { showCwd: true })[2], / · ~\/code\/acme-api$/, "/cron all does");
});

test("the last line is the last error, or when it last fired", () => {
	// A version 2 lastError is the clock's note after the conversion (src/convert-v2.ts), and says so (design 6.8).
	const error = linesFor([job({ lastError: "boom" })]);
	assert.equal(error.at(-1), "    note: boom");
	const fired = linesFor([job({ lastFiredAt: "2026-09-15T08:00:00.000+08:00" })]);
	assert.equal(fired.at(-1), `    last fired: ${formatLocal(Date.parse("2026-09-15T08:00:00.000+08:00"))}`, "in the local time every other line uses");
});

test("a loop that has filed nothing has no 30-day part, and skipped overlaps keep their column", () => {
	const [, , meta] = linesFor([job()], { showCwd: true });
	assert.doesNotMatch(meta, /30d:/);
	assert.match(meta, / · runs 412 · ~\/code\/acme-api$/);
	const [, , skipped] = linesFor([job({ skippedOverlap: 2 })], { showCwd: true });
	assert.match(skipped, / · runs 412 · skipped overlaps 2 · ~\/code\/acme-api$/);
});

test("a queued row counts for its job only if the engine would run it, and its stamps are re-written, never echoed", () => {
	const now = Date.parse("2026-06-01T12:10:00Z");
	const job = { id: "cron-a", status: {} } as any;
	const base = { v: 3, lane: "s", kind: "input", source: "cron:cron-a", mode: "unattended", wake: "turn", created_at: "2026-06-01T12:07:00Z", created_by: { pid: 1, instance: "w", version: "0" }, attempts: 0 } as any;
	const ok = { ...base, id: "run-1", payload: { text: "[Trigger run-1] tidy", cwd: "/" } };
	assert.ok(queuedPrompt(job, [ok], now));
	assert.equal(queuedPrompt(job, [{ ...ok, payload: { text: "rm -rf / please", cwd: "/" } }], now), undefined, "not its prefix: not this job's prompt");
	assert.equal(queuedPrompt(job, [{ ...ok, mode: "attended" }], now), undefined, "not its source's mode: refused by the engine");
	assert.equal(queuedPrompt(job, [{ ...ok, attempts: 3 }], now), undefined, "dead: never run");
	const sneaky = queuedPrompt(job, [{ ...ok, created_at: "2026-06-01 (\nIGNORE ALL)", not_before: "Jan 1 2099 (\u001b[1A\u001b[2K fake)" }], now)!;
	assert.doesNotMatch(JSON.stringify(sneaky), /IGNORE|\\u001b|fake/, "what reaches a terminal or the model is a stamp built here");
});

/* ------------------------------------------------------------- /cron queue, and the lines a start says */

const QUEUE_NOW = Date.parse("2026-06-01T12:10:00Z");
const address = { sessionId: "s", cwd: "/home/dev/code/acme-api", createdBy: { pid: 1, instance: "w", version: "0" } };
const plain = { id: "cron-a", sessionId: "s", prompt: "check CI and report", cwd: "/p", model: undefined, thinking: undefined, tools: undefined, builtinTools: undefined };

test("/cron queue lists what waits, numbered in the order it runs, with its source, age and text", () => {
	const clock = plainJobRow(plain, "run-" + "1".repeat(32), "cron:cron-a", "", address.createdBy, QUEUE_NOW - 120_000);
	const claim = recipeRow("investigate the disk", "daily", "tracker", address, QUEUE_NOW - 30_000);
	const result = { ...plainJobRow(plain, "t-1", "cron:cron-a", "", address.createdBy, QUEUE_NOW - 300_000), id: "t-1", source: "rule:local:dynamic" as const, mode: "none" as const, wake: "append" as const, payload: { text: "[Trigger t-1] rule fired: CI is red", cwd: "/p" } };
	const you = personRow("p-1", "and then push it", undefined, address, QUEUE_NOW - 5_000);
	const lines = queueLines([result, clock, claim, you], { now: QUEUE_NOW, jobName: (id) => (id === "cron-a" ? "ci-watch" : undefined), inFlight: new Set(["t-1"]) });
	// The engine's order: the result keeps its place, then what the person typed, then the clock's row.
	assert.deepEqual(lines.map((l) => l.split("\n")[0]), [
		" 1. rule local:dy · 5m · handed to pi · t-1",
		" 2. recipe daily · 30s · waits for pi to be idle · " + claim.id,
		" 3. you · 5s · waits for pi to be idle · p-1",
		" 4. cron ci-watch · 2m · waits for pi to be idle · run-" + "1".repeat(32),
	]);
	assert.deepEqual(lines.map((l) => l.split("\n")[1]), ["    rule fired: CI is red", "    investigate the disk", "    and then push it", "    check CI and report"], "the text without the engine prefix");
	assert.deepEqual(queueLines([], { now: QUEUE_NOW, jobName: () => undefined, inFlight: new Set() }), ["(nothing is queued for this conversation)"]);
	const backoff = { ...clock, attempts: 1, last_error: "pi did not start a turn for it", not_before: "2026-06-01T12:11:00Z" };
	assert.match(queueLines([backoff], { now: QUEUE_NOW, jobName: () => undefined, inFlight: new Set() })[0], /backing off: pi did not start a turn for it/);
	// /cron queue cancel <n|id>: the listing's numbers, an id, or a prefix that names one row.
	const rows = [result, clock, claim, you];
	assert.equal(pickQueued(rows, "2")?.id, claim.id);
	assert.equal(pickQueued(rows, "4")?.id, clock.id);
	assert.equal(pickQueued(rows, "p-1")?.id, "p-1");
	assert.equal(pickQueued(rows, "run-1111")?.id, clock.id, "a unique prefix");
	assert.equal(pickQueued(rows, "9"), undefined);
	assert.equal(pickQueued(rows, ""), undefined, "nothing names nothing");
	assert.equal(pickQueued([clock, { ...clock, id: "run-" + "1".repeat(31) + "2" }], "run-1111"), undefined, "a prefix of two names neither");
});

test("the one-time start lines: every conversation's plain jobs, the ones --tools caps, and the conversation a window left", () => {
	const a = { ...job(), id: "cron-a", name: "remind-a", stateful: false, sessionId: "sess-a" };
	const b = { ...job(), id: "cron-b", name: "remind-b", stateful: false, sessionId: "sess-b", tools: ["read", "grep"] };
	const c = { ...job(), id: "cron-c", name: undefined, stateful: false, sessionId: "sess-b", tools: ["bash"] };
	const loop = job();
	const asleep = { ...job(), id: "cron-d", stateful: false, sessionId: undefined };
	const disabled = { ...job(), id: "cron-e", stateful: false, sessionId: "sess-e", enabled: false, tools: ["read"] };
	assert.equal(heldJobsNotice([a, b, c, loop, asleep, disabled]), "[cron] 3 plain jobs in 2 conversations run in the background while their conversation is closed (once it has been opened in this pi-loops), and each run is a model turn — /cron all lists them", "every conversation's, not only the ones a lease is known for");
	assert.equal(heldJobsNotice([a, loop]), "[cron] 1 plain job in 1 conversation runs in the background while its conversation is closed (once it has been opened in this pi-loops), and each run is a model turn — /cron all lists them", "one: singular, never (s)");
	assert.equal(heldJobsNotice([loop, asleep, disabled]), undefined);
	assert.equal(toolsCapNotice([a, b, c, loop, disabled], capWords), `[cron] 2 plain jobs have --tools, which now limit their turns: remind-b, cron-c — /cron set <ref> --tools - clears it. ${capWords({ tools: [] }).person}`, "what the turns do is the guard's own words");
	assert.ok(toolsCapNotice([b], capWords)!.endsWith(" — /cron set <ref> --tools - clears it. A dangerous command, or a command outside the job's tools, is not run: pi-loops asks you, in the conversation and in the inbox, and the turn goes on without it. A call of cron_remove, set_cron_job_state, remove_trigger or set_trigger_state is asked about the same way. Another built-in tool outside them is refused, and so is a tool of another extension or an MCP server. pi-loops' other tools run."), "which say a command outside the list is asked about and a tool of an MCP server is refused");
	assert.equal(toolsCapNotice([b, loop], capWords), `[cron] 1 plain job has --tools, which now limit its turns: remind-b — /cron set <ref> --tools - clears it. ${capWords({ tools: [] }).person}`);
	assert.equal(toolsCapNotice([a, loop], capWords), undefined, "a loop's tools are its own; a plain job without any is uncapped");
	assert.equal(leftConversationLine("01a09fef-2222-7abc", 2, true), "[cron] the conversation you left (01a09fef-2222) has 2 plain jobs that run in the background now, each run a model turn — /cron all lists them, /cron disable <ref> stops one");
	assert.match(leftConversationLine("01a09fef-2222", 1, false)!, /has 1 plain job that runs in the background while a pi window is open \(\[host\] auto = false\)/);
	assert.equal(leftConversationLine("01a09fef-2222", 0, true), undefined);
});

test("a loop's label is its name, else the first 13 characters of its id", () => {
	assert.equal(loopLabel({ id: "cron-15c11c9f364f92b42c49f6d15ea2bff6", name: "pr-watch" }), "pr-watch");
	assert.equal(loopLabel({ id: "cron-15c11c9f364f92b42c49f6d15ea2bff6" }), "cron-15c11c9f");
	assert.equal(loopLabel({ id: "cron-15c11c9f364f92b42c49f6d15ea2bff6", name: "" }), "cron-15c11c9f", "an empty name is no name");
	assert.equal(loopLabel({ id: "cron-b91def87" }), "cron-b91def87", "a short id whole");
});

test("the widget is the project's rules, loops, runs and MCP, with marks only where a row differs", () => {
	const at = (ms: number) => formatLocal(ms).slice(11);
	const rule = { condition: "the file /tmp/ready exists", action: "tell me", enabled: true, fireOnce: true };
	const input = {
		rules: [rule, { ...rule, condition: "a deploy fails", action: "open an issue", enabled: false, fireOnce: false }, { ...rule, condition: "CI is red", action: "say so", failureMark: "[failing ×4]" }],
		poll: { at: new Date(NOW).toISOString(), outcome: "failed" },
		jobs: ([job(), job({ id: "cron-0000aaaa", name: undefined, stateful: false, enabled: false, schedule: parseSchedule("every 1h", NOW), prompt: "remind me" }), job({ id: "cron-0000bbbb", name: "busy", skippedOverlap: 2 })] as V2Job[]).map(shown),
		runs: [{ ...run(0, 1), finishedAt: new Date(NOW).toISOString() }],
		runText: (r: RunRecord, name?: string) => `${name ?? r.jobId} ran`,
		sources: [{ name: "github", state: "connected", tools: 3 }, { name: "slack", state: "error", tools: 0 }],
		hookEvents: ["run_finished"],
	};
	assert.deepEqual(panelLines(input), [
		{ text: "Rules", tone: "head" },
		{ text: "the file /tmp/ready exists → tell me", tone: "ok" },
		{ text: "a deploy fails → open an issue  [disabled]  [every time]", tone: "dim" },
		{ text: "CI is red → say so  [failing ×4]", tone: "warn" },
		{ text: `Last check  ${at(NOW)} · failed`, tone: "warn" },
		{ text: "Loops  3 · 1 disabled", tone: "head" },
		{ text: "pr-watch  */15 * * * *  check the repo issues", tone: "ok" },
		{ text: "cron-0000aaaa  every 1h  remind me  [disabled]", tone: "dim" },
		{ text: "busy  */15 * * * *  check the repo issues  skipped overlaps 2", tone: "warn" },
		{ text: "Runs", tone: "head" },
		{ text: `${at(NOW)} pr-watch ran`, tone: "ok" },
		{ text: "MCP  servers 2 · tools 3", tone: "head" },
		{ text: "  github connected · 3 tools  slack error", tone: "warn" },
		{ text: "Hooks  cli_hooks 1 rule (run_finished)", tone: "head" },
	]);
	const quiet = panelLines({ ...input, poll: { at: input.poll.at, outcome: "no match" } }).map((l) => l.text);
	assert.ok(!quiet.some((l) => l.startsWith("Last check")), "a check that found nothing is not news");
	assert.ok(!panelLines({ ...input, poll: { at: input.poll.at, outcome: "matched 2" } }).some((l) => l.text.startsWith("Last check")), "nor one that matched: the rule's result says so");
	assert.ok(!quiet.some((l) => /enabled|stateful|Inbox|notification hooks|trace/.test(l)), "no column that is the same on every row, no inbox count the footer has");
	assert.deepEqual(panelLines({ ...input, rules: [], poll: undefined, jobs: [], runs: [], sources: [] }), [], "nothing to show is no widget, hooks or not");
	assert.equal(panelLines({ ...input, jobs: [shown(job())] }).find((l) => l.text.startsWith("Loops"))?.text, "Loops  1", "no disabled count when none is");
});

test("[6.8] /cron says a failing loop's last failure, how many in a row and its next try; a clock's note; and why a queued run waits, since when", () => {
	const id = "cron-0123456789abcdef0123456789abcdef";
	const hhmm = (ms: number) => formatLocal(ms).slice(11);
	const failedAt = NOW - 6 * 3_600_000 + 30 * 60_000;
	const failed = (n: number): RunRecord => ({ runId: `run-f${n}`, jobId: id, stateful: true, cwd: "/", pid: 1, startedAt: new Date(failedAt - (7 - n) * 60_000).toISOString(), finishedAt: new Date(failedAt - (7 - n) * 60_000).toISOString(), ok: false, error: "401 Unauthorized", findings: 0, droppedFindings: 0, stateUpdated: false });
	const failing = linesFor([job({ id })], { runs: [1, 2, 3, 4, 5, 6, 7].map(failed) });
	assert.ok(failing.includes(`    last run failed: 401 Unauthorized (7 in a row; next try ${hhmm(failedAt + 6 * 3_600_000)})`), failing.join("\n"));
	assert.ok(!failing.some((l) => l.includes("last error:")), "no second word for the same fact");
	const once = linesFor([job({ id })], { runs: [failed(7)] });
	assert.ok(once.includes("    last run failed: 401 Unauthorized"), "one failure: no count, and no pause before the next slot");
	const { job: definition } = fromV2(job({ id }));
	const note = jobLines([definition], { clock: { [id]: { runs: 3, note: { at: new Date(NOW - 60_000).toISOString(), text: "missed 2026-09-15 08:45 while pi-loops was not running (catch-up disabled)" } } }, runs: [], inbox: [], requests: () => [], view: { sessionId: SESSION, holdsOwn: true, holderOf: () => undefined }, now: NOW, home: HOME, cwdExists: () => true, showCwd: false });
	assert.ok(note.includes("    note: missed 2026-09-15 08:45 while pi-loops was not running (catch-up disabled)"), note.join("\n"));
	const since = NOW - 20 * 60_000;
	const queued = { ...plainJobRow({ ...definition, sessionId: undefined }, "row-q", `cron:${id}`, "", { pid: 1, instance: "x", version: "0" }, since), lane: `@${id}`, waiting: "deferred: 3 sub-agent(s) already in flight (max 3)" };
	const waits = linesFor([job({ id })], { requests: (lane) => (lane === `@${id}` ? [queued as any] : []) });
	assert.ok(waits.includes(`    queued since ${hhmm(since)}: deferred: 3 sub-agent(s) already in flight (max 3)`), waits.join("\n"));
	// cron_list gives the model the same facts as fields, with stamps.
	const listed = (runs: RunRecord[], rows: any[] = [], clock = fromV2(job({ id })).clock) => listedJob(definition, clock, rows, runHistory(runs).get(id));
	const next = NOW + 15 * 60_000;
	assert.equal(statusField(statusWord(listed([1, 2, 3, 4, 5, 6, 7].map(failed)), NOW, next)!, NOW), `last_error: 401 Unauthorized (7 in a row; next try ${stamp(failedAt + 6 * 3_600_000)})`);
	assert.equal(statusField(statusWord(listed([], [queued]), NOW, next)!, NOW), `queued: 20m (since ${stamp(since)}) — deferred: 3 sub-agent(s) already in flight (max 3)`);
	assert.equal(statusField(statusWord(listed([], [], { runs: 3, note: { at: new Date(NOW - 60_000).toISOString(), text: "missed 08:45" } }), NOW, next)!, NOW), "note: missed 08:45");
});

test("[panel] the widget counts a proposal as proposed, not as disabled", () => {
	const proposal = { ...shown(job({ id: "cron-0000cccc", name: "pr-watch" })), enabled: false, proposed: { at: new Date(NOW).toISOString(), session: SESSION } };
	const off = { ...shown(job({ id: "cron-0000dddd", name: "old" })), enabled: false };
	const head = (jobs: ReturnType<typeof shown>[]) => panelLines({ rules: [], jobs, runs: [], runText: () => "", sources: [], hookEvents: [] }).find((l) => l.text.startsWith("Loops"))?.text;
	assert.equal(head([shown(job()), proposal]), "Loops  2 · 1 proposed");
	assert.equal(head([shown(job()), proposal, off]), "Loops  3 · 1 disabled · 1 proposed");
});

test("a path is written with ~ only when it is inside the home directory, not when it starts with the same letters", () => {
	assert.match(linesFor([job({ cwd: "/home/alice/x" })], { home: "/home/al", showCwd: true })[2], / · \/home\/alice\/x$/, "never ~ice/x");
	assert.match(linesFor([job({ cwd: "/home/al/x" })], { home: "/home/al", showCwd: true })[2], / · ~\/x$/);
});

test("[listed-cron] /cron shows a loop's run from the claim on its row and its last error from the run log, not from jobs.json fields nothing writes", () => {
	const id = "cron-0123456789abcdef0123456789abcdef";
	const started = new Date(NOW - 60_000).toISOString();
	const claim = { ...plainJobRow(job({ id }), "run-claimed", `cron:${id}`, "", { pid: 1, instance: "x", version: "0" }, NOW - 60_000), lane: `@${id}`, run: { id: "run-claimed", pid: process.pid, started_at: started } };
	const running = linesFor([job({ id, lastError: "stale words" })], { requests: (lane) => (lane === `@${id}` ? [claim as any] : []), live: () => true });
	assert.match(running[0], /running run-claimed/);
	assert.equal(running.some((line) => line.includes("stale words")), false, "the launch cleared the error, as main's did");
	const failed: RunRecord = { runId: "run-failed", jobId: id, stateful: true, cwd: "/", pid: 1, startedAt: started, finishedAt: started, ok: false, error: "provider 500", findings: 0, droppedFindings: 0, stateUpdated: false };
	const after = linesFor([job({ id })], { runs: [failed] });
	assert.ok(after.some((line) => line === "    last run failed: provider 500"), after.join("\n"));
});

test("/cron lists a proposal where it lists a disabled job, with the two commands that answer it, and a session start names it (design 6.3)", () => {
	const proposed = { ...fromV2(job()).job, enabled: false, proposed: { at: new Date(NOW).toISOString(), session: SESSION } };
	const lines = jobLines([proposed], { clock: {}, runs: [], inbox: [], requests: () => [], view: { sessionId: SESSION, holdsOwn: true, holderOf: () => undefined }, now: NOW, home: HOME, cwdExists: () => true, showCwd: false });
	assert.equal(lines[0], ` 1. cron-b91def87 "pr-watch"  proposed: waits for your yes  */15 * * * *  [stateful]`);
	assert.equal(lines[1], "    action: check the repo issues");
	assert.match(lines[2], /^    next — · runs 0/, "the meta line a disabled job has");
	assert.equal(lines[3], "    /cron enable pr-watch asks again · /cron remove pr-watch cancels it");
	assert.equal(proposalsNotice([proposed], [], SESSION), "[cron] 1 watch waits for your yes: /cron enable pr-watch asks again");
	assert.equal(proposalsNotice([proposed], [], "another"), undefined, "only this conversation's");
	const rule = { id: "dyn-1", condition: "c", action: "a", enabled: false, fireOnce: true, promoteToChat: true, createdAt: "", cwd: "/", proposed: { at: "", session: SESSION } };
	assert.equal(proposalsNotice([proposed], [rule], SESSION), "[cron] 2 watches wait for your yes: /cron enable pr-watch · /triggers enable dyn-1 ask again");
	assert.equal(panelLines({ rules: [rule], jobs: [], runs: [], runText: () => "", sources: [], hookEvents: [] })[1].text, "c → a  [proposed]");
});

test("[wake-me] /cron under a loop: its next wake and its quiet, as the loop asked (design 6.6); /cron runs says a run woke itself", () => {
	const loop = job();
	const definition = fromV2(loop).job;
	const wakeAt = NOW + 80 * 60_000;
	const monday = NOW + 3 * DAY;
	const weekday = new Date(monday).toLocaleDateString("en-US", { weekday: "short" });
	const clock = { ...fromV2(loop).clock!, followup: { id: "fu-1", at: stamp(wakeAt), note: "check CI on #12", set_by: "run-a", created_at: stamp(NOW) }, quietUntil: stamp(monday), quietWhy: "nothing changes over the weekend" };
	const lines = linesFor([loop], { clock: { [loop.id]: clock } });
	assert.ok(lines.includes(`    next wake ${formatLocal(wakeAt).slice(11)}, asked by the loop: "check CI on #12"`), lines.join("\n"));
	assert.ok(lines.includes(`    quiet until ${weekday} ${formatLocal(monday).slice(11)}, asked by the loop: "nothing changes over the weekend" (/cron run pr-watch wakes it now)`), lines.join("\n"));
	const after = linesFor([loop], { clock: { [loop.id]: { ...clock, followup: undefined } }, now: monday + 60_000 });
	assert.equal(after.some((l) => /next wake|quiet until/.test(l)), false, "a quiet that has passed and a wake that is gone say nothing");
	assert.equal(listedJob(definition, clock, [], undefined).status.wake?.note, "check CI on #12");
	const record = { runId: "fu-1", jobId: loop.id, stateful: true, cwd: loop.cwd, pid: 1, startedAt: stamp(NOW), finishedAt: stamp(NOW + 5_000), ok: true, findings: 0, droppedFindings: 0, stateUpdated: true };
	assert.equal(wokeWords({ ...record, woken: ["check CI on #12"] } as RunRecord), `, woke itself: "check CI on #12"`);
	assert.equal(wokeWords(record as RunRecord), "", "a scheduled run says nothing more");
});
