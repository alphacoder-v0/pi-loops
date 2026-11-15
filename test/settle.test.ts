import { test } from "node:test";
import assert from "node:assert/strict";
import { oneShotDone, runEnd, settle } from "../src/settle.ts";
import type { LoopJob, RunRecord } from "../src/store.ts";

const at = "2026-01-02T03:04:05.000Z";
const record = (fields: Partial<RunRecord> = {}): RunRecord => ({
	runId: "run", jobId: "job", stateful: false, cwd: "/tmp", pid: 1, startedAt: at,
	finishedAt: at, ok: false, findings: 0, droppedFindings: 0, stateUpdated: false, ...fields,
});
const job = (fields: Partial<Pick<LoopJob, "schedule" | "enabled" | "lastCompletedAt" | "consecutiveFailures">> = {}) => ({
	schedule: { kind: "every" as const, ms: 60_000 }, enabled: true, consecutiveFailures: 1, ...fields,
});
const ends = [
	runEnd(record({ ok: true })),
	runEnd(record({ error: "broken" })),
	runEnd(record({ aborted: true, stoppedBy: "person" })),
	runEnd(record({ aborted: true })),
	runEnd(record({ interrupted: true })),
];

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

const cells: { how: string; written: boolean; result: { row: Record<string, unknown>; job?: unknown } }[] = [
	{ how: "succeeded", written: true, result: { row: { do: "leave", exit: "delivered" }, job: { lastCompletedAt: at, consecutiveFailures: undefined, interruptions: undefined, lastError: undefined } } },
	{ how: "succeeded", written: false, result: { row: { do: "retry", why: "its prompt is not in the conversation" }, job: { lastCompletedAt: at, consecutiveFailures: undefined, interruptions: undefined, lastError: undefined } } },
	{ how: "failed", written: true, result: { row: { do: "leave", exit: "delivered" }, job: { lastCompletedAt: at, consecutiveFailures: 2, interruptions: undefined, lastError: "broken" } } },
	{ how: "failed", written: false, result: { row: { do: "retry", why: "broken" }, job: { lastCompletedAt: at, consecutiveFailures: 2, interruptions: undefined, lastError: "broken" } } },
	{ how: "stopped", written: true, result: { row: { do: "leave", exit: "delivered" }, job: { lastCompletedAt: at, interruptions: undefined } } },
	{ how: "stopped", written: false, result: { row: { do: "leave", exit: "stopped" }, job: { lastCompletedAt: at, interruptions: undefined } } },
	{ how: "handed-back", written: true, result: { row: { do: "leave", exit: "delivered", successor: true } } },
	{ how: "handed-back", written: false, result: { row: { do: "owed" } } },
	{ how: "interrupted", written: true, result: { row: { do: "leave", exit: "delivered" } } },
	{ how: "interrupted", written: false, result: { row: { do: "retry", why: "the process running it stopped" } } },
];

for (const cell of cells) {
	test(`The ${cell.how} ${cell.written ? "written" : "unwritten"} cell settles the row and job.`, () => {
		const end = ends.find((candidate) => candidate.how === cell.how)!;
		assert.deepEqual(settle(job(), end, cell.written), cell.result);
	});
}

test("[settle-failure] A failed turn spends a written slot and counts one failure.", () => {
	assert.deepEqual(settle(job(), runEnd(record({ error: "broken" })), true), cells[2].result);
	assert.deepEqual(settle(job(), runEnd(record({ error: "broken" })), false), cells[3].result);
});

test("[settle-stopped] A stop spends no failure and preserves the error fields.", () => {
	const end = runEnd(record({ aborted: true, stoppedBy: "person" }));
	assert.deepEqual(settle(job(), end, true), cells[4].result);
	assert.deepEqual(settle(job(), end, false), cells[5].result);
});

test("[settle-successor] A hand-back asks again only when its prompt was written.", () => {
	const end = runEnd(record({ aborted: true }));
	assert.deepEqual(settle(job(), end, true), { row: { do: "leave", exit: "delivered", successor: true } });
	assert.deepEqual(settle(job(), end, false), { row: { do: "owed" } });
});

test("[settle-one-shot] A one-shot retries once, including when the prompt was not written.", () => {
	const once = job({ schedule: { kind: "once", at: 1 }, consecutiveFailures: 0 });
	const first = runEnd(record({ error: "broken" }));
	assert.deepEqual(settle(once, first, true), { row: { do: "leave", exit: "delivered", successor: true }, job: { lastCompletedAt: at, consecutiveFailures: 1, interruptions: undefined, lastError: "broken (one-shot: retrying once)" } });
	const beforeSecond = { ...once, consecutiveFailures: 1 };
	const second = runEnd(record({ error: "broken", finishedAt: "2026-01-02T03:05:05.000Z" }));
	assert.deepEqual(settle(beforeSecond, second, true), { row: { do: "leave", exit: "delivered" }, job: { lastCompletedAt: second.at, consecutiveFailures: 2, interruptions: undefined, lastError: "broken" } });
	assert.deepEqual(settle({ ...once, consecutiveFailures: 0 }, first, false), { row: { do: "retry", why: "broken" }, job: { lastCompletedAt: at, consecutiveFailures: 1, interruptions: undefined, lastError: "broken (one-shot: retrying once)" } });
	assert.deepEqual(settle(job(), first, true), cells[2].result);
});

function onceJob(fields: Partial<Pick<LoopJob, "stateful" | "schedule" | "runCount" | "running" | "consecutiveFailures">> = {}) {
	return { stateful: false, schedule: { kind: "once" as const, at: 1 }, runCount: 1, ...fields };
}

test("Settling the same record twice leaves the row unchanged and omits the job patch.", () => {
	for (const cell of cells) {
		const end = ends.find((candidate) => candidate.how === cell.how)!;
		const before = job();
		const first = settle(before, end, cell.written);
		const second = settle({ ...before, ...first.job }, end, cell.written);
		assert.equal(Object.hasOwn(second, "job"), false, `${cell.how}, written=${cell.written}`);
		assert.deepEqual(second.row, first.row);
	}
	const before = onceJob({ consecutiveFailures: 0 });
	const end = runEnd(record({ error: "broken" }));
	const first = settle(before, end, true);
	const second = settle({ ...before, ...first.job }, end, true);
	assert.equal(Object.hasOwn(second, "job"), false);
	assert.deepEqual(second.row, first.row);
});

test("A removed job gets no patch or successor.", () => {
	for (const cell of cells) {
		const end = ends.find((candidate) => candidate.how === cell.how)!;
		const result = settle(undefined, end, cell.written);
		assert.equal(Object.hasOwn(result, "job"), false);
		// The row's result is the table's, without the successor that only a job can have.
		const { successor: _, ...row } = cell.result.row;
		assert.deepEqual(result.row, row, `${cell.how}, written=${cell.written}`);
	}
});

test("Success clears an enabled job's error and preserves a disabled job's error.", () => {
	const end = runEnd(record({ ok: true }));
	assert.equal(Object.hasOwn(settle(job({ enabled: false }), end, true).job!, "lastError"), false);
	assert.deepEqual(settle(job(), end, true).job, { lastCompletedAt: at, consecutiveFailures: undefined, interruptions: undefined, lastError: undefined });
});

test("oneShotDone waits for queued work unless two failures retire the one-shot.", () => {
	assert.equal(oneShotDone(onceJob(), false), true);
	assert.equal(oneShotDone(onceJob({ consecutiveFailures: 1 }), true), false);
	assert.equal(oneShotDone(onceJob({ consecutiveFailures: 2 }), true), true);
	assert.equal(oneShotDone(onceJob({ schedule: { kind: "every", ms: 60_000 } }), false), false);
	assert.equal(oneShotDone(onceJob({ stateful: true }), false), false);
	assert.equal(oneShotDone(onceJob({ runCount: 0 }), false), false);
	assert.equal(oneShotDone(onceJob({ running: { runId: "r", startedAt: at } }), false), false);
});

test("Every end and written state produces a recognized row decision.", () => {
	for (const end of ends) {
		for (const written of [true, false]) {
			assert.ok(["leave", "owed", "retry"].includes(settle(job(), end, written).row.do));
		}
	}
});
