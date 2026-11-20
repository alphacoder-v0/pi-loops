import { test } from "node:test";
import assert from "node:assert/strict";
import { INTERRUPTED, INTERRUPTIONS_BEFORE_PARKING, loopEnd, oneShotDoneV3, runEnd, settle, settleLoop } from "../src/settle.ts";
import { jobCounts, runHistory } from "../src/job-status.ts";
import type { LoopJob, RunRecord } from "../src/store.ts";
import type { ClaimedRow } from "../src/requests.ts";

const at = "2026-01-02T03:04:05.000Z";
const record = (fields: Partial<RunRecord> = {}): RunRecord => ({
	runId: "run", jobId: "job", stateful: false, cwd: "/tmp", pid: 1, startedAt: at,
	finishedAt: at, ok: false, findings: 0, droppedFindings: 0, stateUpdated: false, ...fields,
});
const job = (fields: Partial<Pick<LoopJob, "name" | "schedule" | "enabled">> = {}) => ({
	id: "cron-j", schedule: { kind: "every" as const, ms: 60_000 }, enabled: true, ...fields,
});
/** The run log after the closing's record: one failure in a row, one interrupted run. */
const counts = { streak: 1, interrupted: 1 };
const ends = [
	runEnd(record({ ok: true })),
	runEnd(record({ error: "broken" })),
	runEnd(record({ aborted: true, stoppedBy: "person" })),
	runEnd(record({ aborted: true })),
	runEnd(record({ interrupted: true })),
];

const loopJob = (schedule: LoopJob["schedule"] = { kind: "every", ms: 60_000 }): LoopJob => ({ id: "cron-j", schedule, stateful: true, prompt: "work", cwd: "/", enabled: true, catchUp: true, createdAt: at });
const claimed: ClaimedRow = { v: 3, id: "row", lane: "@cron-j", kind: "input", source: "cron:cron-j", mode: "unattended", wake: "turn", created_at: at, created_by: { pid: 1, instance: "i", version: "1" }, attempts: 0, run: { id: "run", pid: 1, started_at: at } };
const loopEnded = (fields: Partial<RunRecord> = {}) => {
	const rec = record(fields);
	return loopEnd(rec, runHistory([rec]).get(rec.jobId)!);
};

test("runEnd follows the record flags in order and supplies missing errors.", () => {
	assert.deepEqual(runEnd(record({ ok: true })), { how: "succeeded", at });
	assert.deepEqual(runEnd(record({ error: "broken" })), { how: "failed", error: "broken", at });
	assert.deepEqual(runEnd(record({ aborted: true, stoppedBy: "person" })), { how: "stopped", at });
	assert.deepEqual(runEnd(record({ aborted: true })), { how: "handed-back", at });
	assert.deepEqual(runEnd(record({ interrupted: true })), { how: "interrupted", at });
	assert.deepEqual(runEnd(record({ interrupted: true, ok: false })), { how: "interrupted", at });
	assert.deepEqual(runEnd(record({ aborted: true, stoppedBy: undefined })), { how: "handed-back", at });
	assert.deepEqual(runEnd(record()), { how: "failed", error: "run failed", at });
	assert.deepEqual(runEnd(record({ error: "" })), { how: "failed", error: "run failed", at });
});

const cells: { how: string; written: boolean; result: { row: Record<string, unknown> } }[] = [
	{ how: "succeeded", written: true, result: { row: { do: "leave", exit: "delivered" } } },
	// A run that ended spends its slot whether or not its prompt was written: its record is in the run log.
	{ how: "succeeded", written: false, result: { row: { do: "leave", exit: "delivered" } } },
	{ how: "failed", written: true, result: { row: { do: "leave", exit: "delivered" } } },
	{ how: "failed", written: false, result: { row: { do: "leave", exit: "delivered" } } },
	{ how: "stopped", written: true, result: { row: { do: "leave", exit: "delivered" } } },
	{ how: "stopped", written: false, result: { row: { do: "leave", exit: "stopped" } } },
	{ how: "handed-back", written: true, result: { row: { do: "leave", exit: "delivered", successor: true } } },
	{ how: "handed-back", written: false, result: { row: { do: "owed" } } },
	{ how: "interrupted", written: true, result: { row: { do: "leave", exit: "delivered" } } },
	{ how: "interrupted", written: false, result: { row: { do: "retry", why: "the process running it stopped" } } },
];

for (const cell of cells) {
	test(`The ${cell.how} ${cell.written ? "written" : "unwritten"} cell settles the row, and writes nothing on the job: the run log counts.`, () => {
		const end = ends.find((candidate) => candidate.how === cell.how)!;
		assert.deepEqual(settle(job(), end, cell.written, counts), cell.result);
	});
}

test("[settle-ended] A successful loop run leaves its row delivered and counts the record ordinal.", () => {
	assert.deepEqual(settleLoop(claimed, loopJob(), loopEnded({ ok: true, ordinal: 4 }), true), { row: { do: "leave", exit: "delivered" }, runs: 4 });
});
test("[settle-failed] A repeating loop failure spends its row without retrying it.", () => {
	assert.deepEqual(settleLoop(claimed, loopJob(), loopEnded({ error: "broken", ordinal: 2 }), true), { row: { do: "leave", exit: "delivered" }, runs: 2 });
});

test("[settle-failure] A failed turn spends its slot, whether or not its prompt was written.", () => {
	assert.deepEqual(settle(job(), runEnd(record({ error: "broken" })), true, counts), cells[2].result);
	assert.deepEqual(settle(job(), runEnd(record({ error: "broken" })), false, counts), cells[3].result);
});

test("[settle-successor] A hand-back asks again only when its prompt was written.", () => {
	const end = runEnd(record({ aborted: true }));
	assert.deepEqual(settle(job(), end, true, counts), { row: { do: "leave", exit: "delivered", successor: true } });
	assert.deepEqual(settle(job(), end, false, counts), { row: { do: "owed" } });
});

test("[settle-one-shot] A one-shot is asked once more by a successor after its first failure, also when the prompt was not written; not after its second.", () => {
	const once = job({ schedule: { kind: "once", at: 1 } });
	const failed = runEnd(record({ error: "broken" }));
	assert.deepEqual(settle(once, failed, true, { streak: 1, interrupted: 0 }), { row: { do: "leave", exit: "delivered", successor: true } });
	assert.deepEqual(settle(once, failed, false, { streak: 1, interrupted: 0 }), { row: { do: "leave", exit: "delivered", successor: true } });
	assert.deepEqual(settle(once, failed, true, { streak: 2, interrupted: 0 }), { row: { do: "leave", exit: "delivered" } });
	assert.deepEqual(settle(job(), failed, true, { streak: 1, interrupted: 0 }), { row: { do: "leave", exit: "delivered" } }, "a repeating job is not asked again");
});

test("[settle-parked] The third interrupted turn in a row turns the job off with main's words; a disabled job is not turned off again.", () => {
	const interrupted = runEnd(record({ interrupted: true }));
	assert.equal(settle(job(), interrupted, true, { streak: 0, interrupted: INTERRUPTIONS_BEFORE_PARKING - 1 }).disable, undefined);
	assert.deepEqual(settle(job(), interrupted, false, { streak: 0, interrupted: INTERRUPTIONS_BEFORE_PARKING }).disable, { code: "interrupted", why: `parked: its last ${INTERRUPTIONS_BEFORE_PARKING} runs were interrupted before they finished (the process running them stopped each time; see host.log) — /cron enable cron-j to try again`, at });
	assert.equal(settle(job({ enabled: false }), interrupted, true, { streak: 0, interrupted: 5 }).disable, undefined);
	assert.equal(settle(job(), runEnd(record({ error: "broken" })), true, { streak: 9, interrupted: 9 }).disable, undefined, "only an interruption parks");
});

test("A removed job gets no change or successor.", () => {
	for (const cell of cells) {
		const end = ends.find((candidate) => candidate.how === cell.how)!;
		const result = settle(undefined, end, cell.written, counts);
		assert.equal(result.disable, undefined);
		assert.notEqual((result.row as { successor?: boolean }).successor, true);
	}
});

test("Every end and written state produces a recognized row decision.", () => {
	for (const end of ends) {
		for (const written of [true, false]) {
			assert.ok(["leave", "owed", "retry"].includes(settle(job(), end, written, counts).row.do));
		}
	}
});

test("[settle-stopped] A person stop leaves the row and a one-shot keeps main's manual rerun reason.", () => {
	const stopped = loopEnded({ aborted: true, stoppedBy: "person" });
	assert.deepEqual(settleLoop(claimed, loopJob(), stopped, true), { row: { do: "leave", exit: "stopped" } });
	assert.deepEqual(settleLoop(claimed, loopJob({ kind: "once", at: 1 }), stopped, true), { row: { do: "leave", exit: "stopped" }, job: { disabled: { code: "person", why: "stopped by a person; /cron run cron-j runs it now", at } } });
});

test("[settle-interrupted] Alone interruptions retry at once and park the job on the third, with the row spent and no dead letter, as main.", () => {
	const end = loopEnded({ interrupted: true });
	assert.deepEqual(settleLoop({ ...claimed, attempts: 0 }, loopJob(), end, true).row, { do: "retry", attempts: 1, why: INTERRUPTED, wait: false });
	const parked = settleLoop({ ...claimed, attempts: 2 }, loopJob(), end, true);
	assert.deepEqual(parked.row, { do: "leave", exit: "parked" });
	assert.equal(parked.job?.disabled.code, "interrupted");
});

test("[settle-alone] A process interruption beside another run leaves the slot owed without an attempt.", () => {
	assert.deepEqual(settleLoop({ ...claimed, attempts: 2 }, loopJob(), loopEnded({ interrupted: true }), false).row, { do: "owed" });
});

test("[settle-oneshot] The first one-shot failure asks once more; a second does not, and runs define completion.", () => {
	const firstRecord = record({ runId: "first", error: "bad", ordinal: 1 });
	const secondRecord = record({ runId: "second", error: "bad", ordinal: 2, finishedAt: "2026-01-02T03:05:05.000Z" });
	const history = runHistory([firstRecord, secondRecord]).get(firstRecord.jobId)!;
	const firstEnd = loopEnd(firstRecord, runHistory([firstRecord]).get(firstRecord.jobId)!);
	const secondEnd = loopEnd(secondRecord, history);
	const once = loopJob({ kind: "once", at: 1 });
	assert.deepEqual(settleLoop(claimed, once, firstEnd, true).row, { do: "leave", exit: "delivered", successor: true });
	assert.deepEqual(settleLoop(claimed, once, secondEnd, true).row, { do: "leave", exit: "delivered" });
	assert.equal(oneShotDoneV3(once, { runs: 1, queued: true, error: { streak: 2 } }), true);
	assert.equal(oneShotDoneV3(once, { runs: 0, queued: false }), false);
});

test("[settle-twice] Every loop end is an absolute, repeatable settlement.", () => {
	const endings = [loopEnded({ ok: true, ordinal: 1 }), loopEnded({ error: "bad", ordinal: 1 }), loopEnded({ aborted: true, stoppedBy: "person" }), loopEnded({ aborted: true }), loopEnded({ interrupted: true })];
	for (const end of endings) for (const schedule of [{ kind: "every" as const, ms: 60_000 }, { kind: "once" as const, at: 1 }]) {
		const job = loopJob(schedule);
		for (const alone of [false, true]) assert.deepEqual(settleLoop(claimed, job, end, alone), settleLoop(claimed, job, end, alone));
	}
});

test("A job whose turn stops its process again and again is turned off at the third time, and says why; a turn that ends, or an enable, clears the count.", () => {
	assert.equal(INTERRUPTIONS_BEFORE_PARKING, 3);
	assert.equal(INTERRUPTED, "the process running it stopped");
	const cut = (n: number) => record({ runId: `cut-${n}`, jobId: "cron-j", interrupted: true, finishedAt: `2026-01-02T03:0${n}:05.000Z` });
	const countsAfter = (records: RunRecord[], cleared?: string) => jobCounts(runHistory(records).get("cron-j"), cleared);
	for (const written of [true, false]) {
		assert.equal(settle(job({ name: "nightly" }), runEnd(cut(1)), written, countsAfter([cut(1)])).disable, undefined, "the first: counted, and the job stays on");
		assert.equal(settle(job({ name: "nightly" }), runEnd(cut(2)), written, countsAfter([cut(1), cut(2)])).disable, undefined);
		const third = settle(job({ name: "nightly" }), runEnd(cut(3)), written, countsAfter([cut(1), cut(2), cut(3)]));
		// The command names the job by its id: two jobs can have one name.
		assert.equal(third.disable?.why, "parked: its last 3 runs were interrupted before they finished (the process running them stopped each time; see host.log) — /cron enable cron-j to try again");
		// The row's result is the cell's, parked or not.
		assert.deepEqual(third.row, written ? { do: "leave", exit: "delivered" } : { do: "retry", why: INTERRUPTED });
	}
	// A turn that ended, or that a person stopped, clears the count.
	for (const ended of [record({ runId: "ok", jobId: "cron-j", ok: true, finishedAt: "2026-01-02T03:02:30.000Z" }), record({ runId: "bad", jobId: "cron-j", error: "broken", finishedAt: "2026-01-02T03:02:30.000Z" }), record({ runId: "stop", jobId: "cron-j", aborted: true, stoppedBy: "person", finishedAt: "2026-01-02T03:02:30.000Z" })]) {
		assert.equal(countsAfter([cut(1), cut(2), ended, cut(3)]).interrupted, 1, runEnd(ended).how);
	}
	// A hand-back counts nothing, so the count stands.
	assert.equal(countsAfter([cut(1), cut(2), record({ runId: "back", jobId: "cron-j", aborted: true, finishedAt: "2026-01-02T03:02:30.000Z" }), cut(3)]).interrupted, 3);
	// An enable after the second clears the two before it, as main's enable cleared the count.
	assert.equal(countsAfter([cut(1), cut(2), cut(3)], "2026-01-02T03:02:30.000Z").interrupted, 1);
});
