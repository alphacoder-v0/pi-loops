import { test } from "node:test";
import assert from "node:assert/strict";
import { fromV2, jobStatus, runHistory } from "../src/job-status.ts";
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
