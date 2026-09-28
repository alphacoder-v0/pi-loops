import { test } from "node:test";
import assert from "node:assert/strict";
import type { InboxEntry } from "../src/inbox.ts";
import { jobLines } from "../src/job-lines.ts";
import { parseSchedule } from "../src/schedule.ts";
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
	jobLines(jobs, { runs: [], inbox: [], sessionId: SESSION, now: NOW, home: HOME, cwdExists: () => true, ...opts });

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
	assert.equal(head, ' 1. cron-b91def87 "pr-watch"  enabled  */15 * * * *  [session 01a09f6d — resume it to run]');
	assert.equal(meta, "    next — · runs 0 · ~/code/acme-api");
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

test("a loop that has filed nothing has no 30-day part, and overlap skips keep their column", () => {
	const [, , meta] = linesFor([job()]);
	assert.doesNotMatch(meta, /30d:/);
	assert.match(meta, / · runs 412 · ~\/code\/acme-api$/);
	const [, , skipped] = linesFor([job({ skippedOverlap: 2 })]);
	assert.match(skipped, / · runs 412 · overlap skips 2 · ~\/code\/acme-api$/);
});
