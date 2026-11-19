import { test } from "node:test";
import assert from "node:assert/strict";
import { fromV2, jobStatus, listedJob, runHistory } from "../src/job-status.ts";
import type { JobClock } from "../src/clock.ts";
import type { Row } from "../src/requests.ts";
type CountedRow = Row & { collapsed?: number; collapsed_slot?: string };
import type { LoopJob, LoopJobV3, RunRecord } from "../src/store.ts";

const at = "2026-01-02T03:04:05.000Z";
const job = (over: Partial<LoopJobV3> = {}): LoopJobV3 => ({ id: "cron-job", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "work", cwd: "/", enabled: true, catchUp: true, createdAt: at, ...over });
const record = (over: Partial<RunRecord> = {}): RunRecord => ({ runId: "r", jobId: "cron-job", stateful: true, cwd: "/", pid: 1, startedAt: at, finishedAt: at, ok: false, findings: 0, droppedFindings: 0, stateUpdated: false, ...over });
const row = (over: Partial<CountedRow> = {}): CountedRow => ({ v: 3, id: "row", lane: "@cron-job", kind: "input", source: "cron:cron-job", mode: "unattended", wake: "turn", collapse_key: "cron:cron-job", created_at: at, created_by: { pid: 1, instance: "i", version: "1" }, attempts: 0, ...over });

test("[status-runs-loop] Loop runs keep the highest successful or failed ordinal, including the clock floor.", () => {
	const history = runHistory([record({ runId: "a", ok: true, ordinal: 2 }), record({ runId: "b", ok: false, ordinal: 7 }), record({ runId: "c", aborted: true, ordinal: 9 })]).get("cron-job");
	assert.equal(jobStatus(job(), { runs: 8 }, [], history, Date.parse(at)).runs, 8);
	assert.equal(jobStatus(job(), { runs: 0 }, [], history, Date.parse(at)).runs, 7);
	// Main counts no run a person stopped (src/scheduler.ts returns before runCount++).
	const stopped = runHistory([record({ runId: "a", ok: true, ordinal: 2 }), record({ runId: "d", aborted: true, stoppedBy: "person", ordinal: 3 })]).get("cron-job");
	assert.equal(jobStatus(job(), { runs: 0 }, [], stopped, Date.parse(at)).runs, 2, "a person's stop is not a run");
});

test("[status-runs-plain] Plain runs come from clock fires, not records.", () => {
	const plain = job({ stateful: false, sessionId: "s" });
	const history = runHistory([record({ ok: true, ordinal: 99 })]).get("cron-job");
	assert.equal(jobStatus(plain, { runs: 3 }, [], history, Date.parse(at)).runs, 3);
});

test("[status-streak] Failure streak passes over interrupted runs and ends at success.", () => {
	const history = runHistory([record({ runId: "1", error: "a" }), record({ runId: "2", interrupted: true }), record({ runId: "3", error: "b", finishedAt: "2026-01-02T03:05:05.000Z" })]).get("cron-job");
	assert.equal(history?.streak, 2);
	assert.deepEqual(history?.failed, { at: "2026-01-02T03:05:05.000Z", error: "b" });
	assert.equal(runHistory([record({ error: "bad" }), record({ ok: true })]).get("cron-job")?.streak, 0);
});

test("[status-disabled] Main's five disabled reasons map to codes, and disabled jobs have no next slot.", () => {
	const v2 = { ...job(), enabled: false, runCount: 2, skippedOverlap: 0, lastError: "disabled: cwd /gone", lastFiredAt: at } as LoopJob;
	const converted = fromV2(v2);
	assert.equal(converted.job.disabled?.code, "cwd-missing");
	assert.equal(jobStatus(converted.job, converted.clock, [], undefined, Date.parse(at)).next, undefined);
	const reasons = [
		["stopped by a person", "person"],
		["no longer exists (/cron gc removes it)", "session-gone"],
		["disabled: cwd /gone", "cwd-missing"],
		["disabled: unusable schedule", "schedule"],
		["parked: stopped", "interrupted"],
	] as const;
	for (const [lastError, code] of reasons) assert.equal(fromV2({ ...v2, lastError }).job.disabled?.code, code, lastError);
});

// A loop as the lists show it: the fields main wrote, derived from rows, the run log and the cursor.
const T = (minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString();
const v2 = (over: Partial<LoopJob> = {}): LoopJob => ({ id: "cron-job", schedule: { kind: "every", ms: 600_000 }, stateful: true, prompt: "work", cwd: "/", enabled: true, catchUp: true, createdAt: at, runCount: 0, skippedOverlap: 0, ...over });
const claimed = (startedAt: string, over: Partial<CountedRow> = {}): CountedRow => ({ ...row(over), run: { id: "run-1", pid: 7, started_at: startedAt } } as CountedRow);
const shown = (job: LoopJob, rows: CountedRow[], records: RunRecord[], opts: { live?: boolean; cwd?: boolean; now?: number } = {}) =>
	listedJob(job, rows, runHistory(records).get(job.id), () => opts.live ?? true);

test("[listed-running] A loop runs while a live claim is on its row: the claim is the marker, and its start is the last fire.", () => {
	const job = v2({ lastDueAt: T(0), lastFiredAt: T(0) });
	const running = shown(job, [claimed(T(10))], []);
	assert.deepEqual([running.running?.runId, running.running?.startedAt, running.lastFiredAt, running.lastError], ["run-1", T(10), T(10), undefined]);
	const dead = shown(job, [claimed(T(10))], [], { live: false });
	assert.deepEqual([dead.running, dead.lastFiredAt], [undefined, T(0)], "a claim whose process is gone is no run");
	assert.equal(shown(v2({ running: { runId: "old", pid: 9, startedAt: T(1) } }), [], []).running?.runId, "old", "an older version's marker that conversion kept is still a run");
	assert.equal(shown(job, [claimed(T(10), { collapsed: 2, collapsed_slot: T(20) })], []).lastError, "skipped: previous run still active");
	assert.equal(shown(job, [claimed(T(12), { collapsed: 1, collapsed_slot: T(10) })], []).lastError, undefined, "a slot counted onto the row while it waited to start is no skip of this run");
});

test("[listed-failure] The last failure is the error while it is the newest run that ended; a stop, a success or an enable clears it.", () => {
	const failed = record({ runId: "a", error: "boom", finishedAt: T(1) });
	const job = v2({ lastDueAt: T(0), lastFiredAt: T(0) });
	assert.deepEqual([shown(job, [], [failed]).lastError, shown(job, [], [failed]).consecutiveFailures, shown(job, [], [failed]).lastCompletedAt], ["boom", 1, T(1)]);
	const stopped = record({ runId: "b", aborted: true, stoppedBy: "person", finishedAt: T(11) });
	assert.deepEqual([shown(job, [], [failed, stopped]).lastError, shown(job, [], [failed, stopped]).consecutiveFailures, shown(job, [], [failed, stopped]).lastCompletedAt], [undefined, 1, T(11)], "the launch of the stopped run cleared the error; the streak stays");
	assert.equal(shown(job, [], [failed, record({ runId: "c", ok: true, finishedAt: T(12) })]).consecutiveFailures, undefined);
	assert.equal(shown({ ...job, clearedAt: T(5) } as LoopJob, [], [failed]).lastError, undefined, "an enable after the failure");
	assert.equal(shown(v2({ enabled: false }), [], [failed]).lastError, "boom", "a disable by a person keeps it");
	assert.equal(shown(v2({ enabled: false, lastError: "disabled: cwd / has been missing since then" }), [], [failed]).lastError, "disabled: cwd / has been missing since then");
	const interrupted = record({ runId: "d", interrupted: true, error: "the process running it stopped", finishedAt: T(20) });
	assert.equal(shown(job, [], [failed, interrupted]).lastCompletedAt, T(1), "an interrupted run wrote no record of its own");
});

test("[listed-waiting] A row that waits shows the reason the background wrote on it, and no due slot: main wrote that at the launch.", () => {
	const job = v2({ lastDueAt: T(20), lastError: "a note of the clock" });
	const deferred = "deferred: 1 sub-agent(s) already in flight (max 1)";
	const waiting = shown(job, [row({ payload: { text: "x", cwd: "/", slot: T(0) }, waiting: deferred })], []);
	assert.deepEqual([waiting.lastError, waiting.lastDueAt], [deferred, undefined]);
	assert.equal(shown(job, [row()], []).lastError, "a note of the clock", "a row with no reason written says nothing of its own");
	const retry = shown(v2({ lastDueAt: T(0), lastFiredAt: T(0) }), [row({ attempts: 1 })], []);
	assert.deepEqual([retry.lastError, retry.lastDueAt, retry.lastFiredAt], ["cleared stale running state (previous pi process ended mid-run); the run will be retried", undefined, undefined], "an interrupted run is owed again: main rolled both stamps back");
});

test("[listed-one-shot] A one-shot's first failure says it retries once, and its stamps are rolled back; a parked loop's are too.", () => {
	const once = v2({ schedule: { kind: "once", at: Date.parse(at) }, lastDueAt: at, lastFiredAt: T(1) });
	const failed = shown(once, [row()], [record({ error: "boom", finishedAt: T(2) })]);
	assert.deepEqual([failed.lastError, failed.lastDueAt, failed.lastFiredAt], ["boom (one-shot: retrying once)", undefined, undefined]);
	const parked = shown(v2({ enabled: false, lastError: "parked: its last 3 runs were interrupted", lastDueAt: T(30), lastFiredAt: T(0) }), [], []);
	assert.deepEqual([parked.lastError, parked.lastDueAt, parked.lastFiredAt], ["parked: its last 3 runs were interrupted", undefined, undefined]);
});

test("[listed-plain] A plain job is listed as jobs.json has it: its turns still write the fields.", () => {
	const plain = v2({ stateful: false, sessionId: "s", lastError: "kept", consecutiveFailures: 4 });
	assert.equal(shown(plain, [claimed(T(1))], [record({ error: "other" })]), plain);
});
