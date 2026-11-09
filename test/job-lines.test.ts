import { test } from "node:test";
import assert from "node:assert/strict";
import { inboxClaimRow, personRow, plainJobRow, queuedPrompt } from "../src/engine.ts";
import type { InboxEntry } from "../src/inbox.ts";
import { heldJobsNotice, jobLines, leftConversationLine, panelLines, pickQueued, queueLines, toolsCapNotice, loopLabel } from "../src/job-lines.ts";
import { formatLocal } from "../src/schedule.ts";
import { parseSchedule, stamp } from "../src/schedule.ts";
import type { LoopJob, RunRecord } from "../src/store.ts";

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

const linesFor = (jobs: LoopJob[], opts: Partial<Parameters<typeof jobLines>[1]> = {}) =>
	jobLines(jobs, { runs: [], inbox: [], requests: () => [], view: { sessionId: SESSION, holdsOwn: true, holderOf: () => undefined }, now: NOW, home: HOME, cwdExists: () => true, ...opts });

const job = (over: Partial<LoopJob> = {}): LoopJob => ({
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
	const [head, action, meta] = linesFor([job()], { runs, inbox });
	assert.equal(head, ' 1. cron-b91def87 "pr-watch"  enabled  */15 * * * *  [stateful]  [quiet ×4]');
	assert.equal(action, "    action: check the repo issues");
	assert.match(meta, /^    next .+ · runs 412 · 30d: 6 findings · 6 dismissed \(4 with a reason\) · ~\/code\/acme-api$/);
});

test("a plain job of a session not open here is marked asleep and has no next run", () => {
	const [head, , meta] = linesFor([job({ stateful: false, sessionId: "01a09f6d-1111", runCount: 0 })]);
	assert.equal(head, ' 1. cron-b91def87 "pr-watch"  enabled  */15 * * * *  [session 01a09f6d-1111 — resume it to run]');
	assert.equal(meta, "    next — · runs 0 · ~/code/acme-api");
});

test("a plain job of a session another window holds says where it is open, with no pid, and keeps its next run", () => {
	const [head, , meta] = linesFor([job({ stateful: false, sessionId: "01a09f6d-1111", runCount: 0 })], { view: { sessionId: SESSION, holdsOwn: true, holderOf: (id) => (id === "01a09f6d-1111" ? 4242 : undefined) } });
	assert.equal(head, ' 1. cron-b91def87 "pr-watch"  enabled  */15 * * * *  [session 01a09f6d-1111 — open in a terminal]');
	assert.match(meta, /^    next \d{4}-\d{2}-\d{2} \d{2}:\d{2}/, "it will run, in that window");
});

/** The job's prompt as the row its conversation holds, queued `ageMs` before NOW. */
const queuedRow = (jobId: string, ageMs: number) => plainJobRow({ id: jobId, sessionId: SESSION, prompt: "check the repo issues", cwd: "/home/dev/code/acme-api", model: undefined, thinking: undefined }, `run-${jobId}`, `cron:${jobId}`, "", { pid: 1, instance: "w", version: "0" }, NOW - ageMs);

test("a plain job whose prompt is queued says so, with how long", () => {
	const plain = job({ stateful: false, sessionId: SESSION, runCount: 0 });
	const [head] = linesFor([plain], { requests: (id) => (id === SESSION ? [queuedRow(plain.id, 3 * 60_000)] : []) });
	assert.equal(head, ' 1. cron-b91def87 "pr-watch"  enabled  */15 * * * *  [queued 3m]');
	// A hand-over that failed: the row waits out its backoff, and the line says until when.
	const until = stamp(NOW + 4 * 60_000);
	const [backing] = linesFor([plain], { requests: () => [{ ...queuedRow(plain.id, 90_000), not_before: until, attempts: 1 }] });
	assert.equal(backing, ` 1. cron-b91def87 "pr-watch"  enabled  */15 * * * *  [queued 1m — backing off until ${until}]`);
});

test("a job with nothing queued looks as before", () => {
	const plain = job({ stateful: false, sessionId: SESSION, runCount: 0 });
	const before = linesFor([plain]);
	assert.equal(before[0], ' 1. cron-b91def87 "pr-watch"  enabled  */15 * * * *');
	// Another job's row in the same conversation is not this job's prompt.
	assert.deepEqual(linesFor([plain], { requests: () => [queuedRow("cron-other", 60_000)] }), before);
	// The row a held turn is running is shown as running, not as queued.
	const running = { ...plain, running: { runId: "run-cron-b91def87", pid: 7, startedAt: stamp(NOW - 1000) } } as LoopJob;
	const [head] = linesFor([running], { requests: () => [queuedRow(plain.id, 60_000)] });
	assert.equal(head, ' 1. cron-b91def87 "pr-watch"  enabled  */15 * * * *  running run-cron-b91def87');
	// A loop has no queue to wait in.
	assert.doesNotMatch(linesFor([job()], { requests: () => [queuedRow("cron-b91def87", 60_000)] })[0], /queued/);
});

test("a loop whose checkout is gone says so", () => {
	const [head] = linesFor([job()], { cwdExists: () => false });
	assert.equal(head, ' 1. cron-b91def87 "pr-watch"  enabled  */15 * * * *  [stateful]  [orphan: cwd missing]');
});

test("a job that does not catch up, and one with a checker, are marked", () => {
	const [head] = linesFor([job({ catchUp: false, verify: true })]);
	assert.equal(head, ' 1. cron-b91def87 "pr-watch"  enabled  */15 * * * *  [stateful]  [verify]  [no-catchup]');
});

test("the last line is the last error, or when it last fired", () => {
	const error = linesFor([job({ lastError: "boom" })]);
	assert.equal(error.at(-1), "    last error: boom");
	const fired = linesFor([job({ lastFiredAt: "2026-09-15T08:00:00.000+08:00" })]);
	assert.equal(fired.at(-1), "    last fired: 2026-09-15T08:00:00.000+08:00");
});

test("a loop that has filed nothing has no 30-day part, and skipped overlaps keep their column", () => {
	const [, , meta] = linesFor([job()]);
	assert.doesNotMatch(meta, /30d:/);
	assert.match(meta, / · runs 412 · ~\/code\/acme-api$/);
	const [, , skipped] = linesFor([job({ skippedOverlap: 2 })]);
	assert.match(skipped, / · runs 412 · skipped overlaps 2 · ~\/code\/acme-api$/);
});

test("a queued row counts for its job only if the engine would run it, and its stamps are re-written, never echoed", () => {
	const now = Date.parse("2026-06-01T12:10:00Z");
	const job = { id: "cron-a" } as any;
	const base = { v: 2, session_id: "s", kind: "input", source: "cron:cron-a", mode: "unattended", wake: "turn", created_at: "2026-06-01T12:07:00Z", created_by: { pid: 1, instance: "w", version: "0" }, attempts: 0 } as any;
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
	const claim = inboxClaimRow("investigate the disk", "inb-12345678", address, QUEUE_NOW - 30_000);
	const result = { ...plainJobRow(plain, "t-1", "cron:cron-a", "", address.createdBy, QUEUE_NOW - 300_000), id: "t-1", source: "rule:local:dynamic" as const, mode: "none" as const, wake: "append" as const, payload: { text: "[Trigger t-1] rule fired: CI is red", cwd: "/p" } };
	const you = personRow("p-1", "and then push it", undefined, address, QUEUE_NOW - 5_000);
	const lines = queueLines([result, clock, claim, you], { now: QUEUE_NOW, jobName: (id) => (id === "cron-a" ? "ci-watch" : undefined), inFlight: new Set(["t-1"]) });
	// The engine's order: the result keeps its place, then what the person typed, then the clock's row.
	assert.deepEqual(lines.map((l) => l.split("\n")[0]), [
		" 1. rule local:dy · 5m · handed to pi · t-1",
		" 2. claim inb-1234 · 30s · waits for pi to be idle · " + claim.id,
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
	assert.equal(toolsCapNotice([a, b, c, loop, disabled]), "[cron] 2 plain jobs have --tools, which now limit their turns (a tool outside the list asks you first in a window, and is refused in the background): remind-b, cron-c — /cron set <ref> --tools - clears it");
	assert.equal(toolsCapNotice([b, loop]), "[cron] 1 plain job has --tools, which now limit its turns (a tool outside the list asks you first in a window, and is refused in the background): remind-b — /cron set <ref> --tools - clears it");
	assert.equal(toolsCapNotice([a, loop]), undefined, "a loop's tools are its own; a plain job without any is uncapped");
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
		jobs: [job(), job({ id: "cron-0000aaaa", name: undefined, stateful: false, enabled: false, schedule: parseSchedule("every 1h", NOW), prompt: "remind me" }), job({ id: "cron-0000bbbb", name: "busy", skippedOverlap: 2 })],
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
	assert.equal(panelLines({ ...input, jobs: [job()] }).find((l) => l.text.startsWith("Loops"))?.text, "Loops  1", "no disabled count when none is");
});
