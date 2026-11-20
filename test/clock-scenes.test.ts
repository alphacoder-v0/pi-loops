import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { proofOf, landed, plainRunId } from "../src/engine.ts";
import { ClockStore, decideTick, writeSlot, commitSlot, type ClockFile, type Mine } from "../src/clock.ts";
import { withFileLockSync, writeFileAtomic } from "../src/lock.ts";
import { RequestStore, type Row } from "../src/requests.ts";
import { stamp } from "../src/schedule.ts";
import { runEnd } from "../src/settle.ts";
import type { LoopJob, RunRecord } from "../src/store.ts";

const base = Date.parse("2026-01-02T03:04:05.000Z");
const self = { pid: process.pid, instance: "scene", version: "test" };
const job: LoopJob = { id: "cron-scene", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "work", cwd: "/", enabled: true, catchUp: true, createdAt: stamp(base - 120_000), runCount: 0, skippedOverlap: 0 };
const emptyClock = (): ClockFile => ({ v: 1, jobs: {} });
function fixture() {
	const dir = tmp("pi-loops-clock-scene-");
	const requests = new RequestStore(dir);
	const clock = new ClockStore({ file: path.join(dir, "clock.json"), lock: path.join(dir, "clock.lock") }, { locked: withFileLockSync, write: writeFileAtomic });
	return { requests, clock };
}
function decide(at: number, options: { clock?: ClockFile; startedAt?: number; catchUp?: boolean; rows?: Row[]; spent?: Set<string> } = {}) {
	return decideTick({
		jobs: [job], clock: options.clock ?? emptyClock(),
		view: {
			now: at, startedAt: options.startedAt ?? at, tickMs: 30_000, catchUp: options.catchUp ?? true, budgetOver: false,
			kind: "background", self, mine: new Map<string, Mine>([[job.id, { kind: "loop" }]]),
			read: new Map([[job.id, { rows: options.rows ?? [], cwdMissing: false, history: options.spent ? { ordinal: 1, streak: 0, spent: options.spent } : undefined }]]),
		},
	})[0];
}
function record(id: string, startedAt: number): RunRecord {
	return { runId: id, jobId: job.id, stateful: true, cwd: job.cwd, pid: self.pid, startedAt: stamp(startedAt), finishedAt: stamp(startedAt + 1_000), ok: true, findings: 0, droppedFindings: 0, stateUpdated: false };
}

test("[scene-orphan-runs-once] Two stale tickers append distinct slots; the T3 loser stays queued and runs once.", () => {
	const { requests, clock } = fixture();
	const first = decide(base);
	const second = decide(base + 60_000);
	assert.equal(first.do, "row");
	assert.equal(second.do, "row");
	if (first.do !== "row" || second.do !== "row") return;
	assert.notEqual(first.row.id, second.row.id);
	const a = writeSlot(first, { requests });
	const b = writeSlot(second, { requests });
	assert.equal(a.t2, "wrote");
	assert.equal(b.t2, "wrote");
	assert.equal(commitSlot(b, { clock, heldEpoch: () => 1 }).t3, "moved");
	assert.equal(commitSlot(a, { clock, heldEpoch: () => 1 }).t3, "lost");
	assert.deepEqual(requests.list(first.lane).map((row) => row.id), [first.row.id, second.row.id]);
	assert.equal(requests.claim(first.lane, first.row.id, { id: first.row.id, pid: self.pid, started_at: stamp(base + 120_000) } as never), true);
	assert.equal(requests.claim(first.lane, first.row.id, { id: first.row.id, pid: self.pid, started_at: stamp(base + 120_000) } as never), false);
	const runs = [record(first.row.id, base + 120_000)];
	assert.equal(runs.filter((run) => run.runId === first.row.id && runEnd(run).how === "succeeded").length, 1);
	requests.remove(first.lane, [first.row.id]);
	assert.deepEqual(requests.list(first.lane).map((row) => row.id), [second.row.id]);
	const later = decide(base + 60_000, { clock: clock.read() });
	assert.equal(later.do, "pass");
	assert.deepEqual(requests.list(first.lane).map((row) => row.id), [second.row.id]);
});

test("[scene-cursor-spent] A row survives T2 without T3, then its completed run spends that slot.", () => {
	const { requests, clock } = fixture();
	const decision = decide(base);
	assert.equal(decision.do, "row");
	if (decision.do !== "row") return;
	assert.equal(writeSlot(decision, { requests }).t2, "wrote");
	assert.equal(clock.read().jobs[job.id], undefined);
	assert.equal(requests.claim(decision.lane, decision.row.id, { id: decision.row.id, pid: self.pid, started_at: stamp(base + 1_000) } as never), true);
	const runs = [record(decision.row.id, base + 1_000)];
	assert.equal(runs.filter((run) => run.runId === decision.row.id && runEnd(run).how === "succeeded").length, 1);
	requests.remove(decision.lane, [decision.row.id]);
	assert.deepEqual(requests.list(decision.lane), []);
	const again = decide(base, { spent: new Set([decision.row.id]) });
	assert.equal(again.do, "cursor");
	if (again.do !== "cursor") return;
	assert.equal(again.why, "spent");
	assert.equal(commitSlot(writeSlot(again, { requests }), { clock, heldEpoch: () => 1 }).t3, "moved");
	assert.equal(clock.read().jobs[job.id].slot, decision.slot);
	assert.deepEqual(requests.list(decision.lane), []);
});

test("[scene-spent-copy-leaves] A stale copy appended after a successful run is proved and removed without a claim.", () => {
	const { requests, clock } = fixture();
	const a = decide(base);
	const b = decide(base);
	assert.equal(a.do, "row");
	assert.equal(b.do, "row");
	if (a.do !== "row" || b.do !== "row") return;
	const written = writeSlot(b, { requests });
	assert.equal(written.t2, "wrote");
	assert.equal(commitSlot(written, { clock, heldEpoch: () => 1 }).t3, "moved");
	assert.equal(requests.claim(b.lane, b.row.id, { id: b.row.id, pid: self.pid, started_at: stamp(base + 1_000) } as never), true);
	const runs = [record(b.row.id, base + 1_000)];
	requests.remove(b.lane, [b.row.id]);
	assert.deepEqual(requests.list(b.lane), []);
	assert.equal(writeSlot(a, { requests }).t2, "wrote");
	const copy = requests.list(a.lane)[0];
	assert.equal(copy.id, plainRunId(job.id, a.slot));
	assert.equal(landed(copy, proofOf(a.lane, () => [], () => runs)), true);
	requests.remove(a.lane, [copy.id]);
	assert.deepEqual(requests.list(a.lane), []);
});

test("[scene-skip-leaves-fired] A late ticker skips a missed slot and commits its note without changing fired.", () => {
	const { requests, clock } = fixture();
	const initial: ClockFile = { v: 1, jobs: { [job.id]: { fired: stamp(base - 120_000), runs: 3 } } };
	clock.seed(initial.jobs);
	const decision = decide(base, { clock: initial, startedAt: base + 60_000, catchUp: false });
	assert.equal(decision.do, "skip");
	if (decision.do !== "skip") return;
	assert.match(decision.note, /^missed .* \(catch-up disabled\)$/);
	const outcome = commitSlot(writeSlot(decision, { requests }), { clock, heldEpoch: () => 1 });
	assert.equal(outcome.t3, "moved");
	assert.equal(clock.read().jobs[job.id].slot, decision.slot);
	assert.equal(clock.read().jobs[job.id].fired, initial.jobs[job.id].fired);
	assert.equal(clock.read().jobs[job.id].runs, initial.jobs[job.id].runs);
	assert.deepEqual(requests.list(decision.lane), []);
});
