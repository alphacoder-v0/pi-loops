import { test } from "node:test";
import assert from "node:assert/strict";
import { INTERRUPTED, INTERRUPTIONS_BEFORE_PARKING, oneShotDone, runEnd, settle } from "../src/settle.ts";
import type { LoopJob, RunRecord } from "../src/store.ts";

const at = "2026-01-02T03:04:05.000Z";
const record = (fields: Partial<RunRecord> = {}): RunRecord => ({
	runId: "run", jobId: "job", stateful: false, cwd: "/tmp", pid: 1, startedAt: at,
	finishedAt: at, ok: false, findings: 0, droppedFindings: 0, stateUpdated: false, ...fields,
});
const job = (fields: Partial<Pick<LoopJob, "name" | "schedule" | "enabled" | "lastCompletedAt" | "consecutiveFailures" | "interruptions">> = {}) => ({
	id: "cron-j", schedule: { kind: "every" as const, ms: 60_000 }, enabled: true, consecutiveFailures: 1, ...fields,
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
	// A run that ended spends its slot whether or not its prompt was written: its record is in the run log.
	{ how: "succeeded", written: false, result: { row: { do: "leave", exit: "delivered" }, job: { lastCompletedAt: at, consecutiveFailures: undefined, interruptions: undefined, lastError: undefined } } },
	{ how: "failed", written: true, result: { row: { do: "leave", exit: "delivered" }, job: { lastCompletedAt: at, consecutiveFailures: 2, interruptions: undefined, lastError: "broken" } } },
	{ how: "failed", written: false, result: { row: { do: "leave", exit: "delivered" }, job: { lastCompletedAt: at, consecutiveFailures: 2, interruptions: undefined, lastError: "broken" } } },
	{ how: "stopped", written: true, result: { row: { do: "leave", exit: "delivered" }, job: { lastCompletedAt: at, interruptions: undefined } } },
	{ how: "stopped", written: false, result: { row: { do: "leave", exit: "stopped" }, job: { lastCompletedAt: at, interruptions: undefined } } },
	{ how: "handed-back", written: true, result: { row: { do: "leave", exit: "delivered", successor: true } } },
	{ how: "handed-back", written: false, result: { row: { do: "owed" } } },
	{ how: "interrupted", written: true, result: { row: { do: "leave", exit: "delivered" }, job: { lastCompletedAt: at, interruptions: 1 } } },
	{ how: "interrupted", written: false, result: { row: { do: "retry", why: "the process running it stopped" }, job: { lastCompletedAt: at, interruptions: 1 } } },
];

for (const cell of cells) {
	test(`The ${cell.how} ${cell.written ? "written" : "unwritten"} cell settles the row and job.`, () => {
		const end = ends.find((candidate) => candidate.how === cell.how)!;
		assert.deepEqual(settle(job(), end, cell.written), cell.result);
	});
}

test("[settle-failure] A failed turn spends its slot and counts one failure, whether or not its prompt was written.", () => {
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

test("[settle-one-shot] A one-shot is asked once more by a successor, including when the prompt was not written.", () => {
	const once = job({ schedule: { kind: "once", at: 1 }, consecutiveFailures: 0 });
	const first = runEnd(record({ error: "broken" }));
	assert.deepEqual(settle(once, first, true), { row: { do: "leave", exit: "delivered", successor: true }, job: { lastCompletedAt: at, consecutiveFailures: 1, interruptions: undefined, lastError: "broken (one-shot: retrying once)" } });
	const beforeSecond = { ...once, consecutiveFailures: 1 };
	const second = runEnd(record({ error: "broken", finishedAt: "2026-01-02T03:05:05.000Z" }));
	assert.deepEqual(settle(beforeSecond, second, true), { row: { do: "leave", exit: "delivered" }, job: { lastCompletedAt: second.at, consecutiveFailures: 2, interruptions: undefined, lastError: "broken" } });
	assert.deepEqual(settle({ ...once, consecutiveFailures: 0 }, first, false), { row: { do: "leave", exit: "delivered", successor: true }, job: { lastCompletedAt: at, consecutiveFailures: 1, interruptions: undefined, lastError: "broken (one-shot: retrying once)" } });
	// A recurring job's first failure is under two as well, and it is not asked again.
	assert.deepEqual(settle(job({ consecutiveFailures: 0 }), first, true), { row: { do: "leave", exit: "delivered" }, job: { lastCompletedAt: at, consecutiveFailures: 1, interruptions: undefined, lastError: "broken" } });
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

test("A record older than the last one that was settled is not counted: a closing that runs again after another came between counts nothing twice.", () => {
	const older = runEnd(record({ error: "broken", finishedAt: "2026-01-02T03:04:05.000Z" }));
	const newer = runEnd(record({ interrupted: true, finishedAt: "2026-01-02T03:04:09.000Z" }));
	// The older record was settled, then the newer one: the job carries the newer stamp.
	const after = { ...job({ consecutiveFailures: 0 }), ...settle(job({ consecutiveFailures: 0 }), older, true).job, ...settle(job(), newer, true).job };
	assert.equal(after.lastCompletedAt, newer.at);
	const again = settle(after, older, true);
	assert.deepEqual([Object.hasOwn(again, "job"), again.row], [false, { do: "leave", exit: "delivered" }]);
	// The stamps are compared as times, whatever offset each was written with.
	assert.equal(Object.hasOwn(settle(job({ lastCompletedAt: "2026-01-02T04:04:09.000+01:00" }), older, true), "job"), false);
	// A record newer than the job's stamp is settled: the clock's stamp at the slot is earlier than the turn's end.
	assert.equal(settle(job({ lastCompletedAt: "2026-01-02T03:00:00.000Z", consecutiveFailures: 0 }), older, true).job?.consecutiveFailures, 1);
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

test("A job whose turn stops its process again and again is turned off at the third time, and says why; a turn that ends clears the count.", () => {
	assert.equal(INTERRUPTIONS_BEFORE_PARKING, 3);
	assert.equal(INTERRUPTED, "the process running it stopped");
	const cut = (n: number) => runEnd(record({ interrupted: true, finishedAt: `2026-01-02T03:0${n}:05.000Z` }));
	for (const written of [true, false]) {
		let state = job({ name: "nightly", consecutiveFailures: undefined });
		const first = settle(state, cut(1), written);
		assert.deepEqual(first.job, { lastCompletedAt: cut(1).at, interruptions: 1 }, "the first: counted, and the job stays on");
		state = { ...state, ...first.job };
		const second = settle(state, cut(2), written);
		assert.deepEqual(second.job, { lastCompletedAt: cut(2).at, interruptions: 2 });
		state = { ...state, ...second.job };
		const third = settle(state, cut(3), written);
		assert.deepEqual(third.job, { lastCompletedAt: cut(3).at, interruptions: 3, enabled: false, lastError: "parked: its last 3 runs were interrupted before they finished (the process running them stopped each time; see host.log) — /cron enable cron-j to try again" });
		// The row's result is the cell's, parked or not.
		assert.deepEqual(third.row, written ? { do: "leave", exit: "delivered" } : { do: "retry", why: INTERRUPTED });
		// The same record settled again counts nothing more.
		assert.equal(Object.hasOwn(settle({ ...state, ...third.job }, cut(3), written), "job"), false);
	}
	// The command names the job by its id: two jobs can have one name.
	assert.match(settle(job({ name: "nightly", interruptions: 2 }), cut(1), true).job!.lastError!, /\/cron enable cron-j to try again$/);
	// A turn that ended, or that a person stopped, clears the count.
	for (const end of [runEnd(record({ ok: true })), runEnd(record({ error: "broken" })), runEnd(record({ aborted: true, stoppedBy: "person" }))]) assert.equal(settle(job({ interruptions: 2 }), end, true).job!.interruptions, undefined, end.how);
	// A hand-back writes nothing, so the count stands.
	assert.equal(Object.hasOwn(settle(job({ interruptions: 2 }), runEnd(record({ aborted: true })), true), "job"), false);
});
