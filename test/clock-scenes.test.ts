import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { proofOf, landed, plainRunId } from "../src/engine.ts";
import { ClockStore, applyFollowup, applyTick, decideTick, writeFollowup, writeSlot, commitSlot, type ClockFile, type Mine, type TickInput } from "../src/clock.ts";
import { closeLoopRun, type RunRecordM4b } from "../src/loop-run.ts";
import { openStores } from "../src/stores.ts";
import { withFileLockSync, writeFileAtomic } from "../src/lock.ts";
import { RequestStore, type ClaimedRow, type Row } from "../src/requests.ts";
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

test("[scene-followup-T2] A tick writes a follow-up's row and dies before it takes the follow-up: the next tick writes no second row, whether the row waits or already ran.", () => {
	for (const ran of [false, true]) {
		const { requests, clock } = fixture();
		clock.seed({ [job.id]: { slot: stamp(base), fired: stamp(base), runs: 1 } });
		clock.setFollowup(job.id, { at: stamp(base - 1_000), note: "check CI on #12", set_by: "run-a" }, false, base - 600_000);
		const tick = decideTick({ jobs: [job], clock: clock.read(), view: { now: base, startedAt: base, tickMs: 30_000, catchUp: true, budgetOver: false, kind: "background", self, mine: new Map<string, Mine>([[job.id, { kind: "loop" }]]), read: new Map([[job.id, { rows: [], cwdMissing: false, history: undefined }]]) } });
		const woke = tick.find((d) => d.do === "followup");
		assert.ok(woke && woke.do === "followup" && woke.write === "row", "the first tick writes the follow-up's row");
		if (!woke || woke.do !== "followup" || woke.write !== "row") return;
		// T2, then the process dies: the follow-up is still in clock.json.
		assert.equal(requests.appendIfAbsent(woke.row), true);
		assert.equal(clock.read().jobs[job.id].followup?.id, woke.followup.id);
		let spent: Set<string> | undefined;
		if (ran) {
			assert.equal(requests.claim(woke.lane, woke.row.id, { id: woke.row.id, pid: self.pid, started_at: stamp(base + 1_000) } as never), true);
			requests.remove(woke.lane, [woke.row.id]);
			spent = new Set([woke.row.id]);
		}
		const again = decideTick({ jobs: [job], clock: clock.read(), view: { now: base + 30_000, startedAt: base + 30_000, tickMs: 30_000, catchUp: true, budgetOver: false, kind: "background", self, mine: new Map<string, Mine>([[job.id, { kind: "loop" }]]), read: new Map([[job.id, { rows: requests.list(woke.lane), cwdMissing: false, history: spent ? { ordinal: 1, streak: 0, interrupted: [], spent } : undefined }]]) } }).find((d) => d.do === "followup");
		assert.deepEqual(again && again.do === "followup" ? [again.write, again.write === "none" ? again.why : undefined] : undefined, ["none", ran ? "spent" : "own-row"]);
		if (!again || again.do !== "followup") return;
		assert.deepEqual(applyFollowup(again, { requests, clock }, base + 30_000), { job: job.id, followup: woke.followup.id, t2: "nothing", t3: "moved" });
		assert.deepEqual(requests.list(woke.lane).map((row) => row.id), ran ? [] : [woke.row.id], "one row, never two");
		assert.equal(clock.read().jobs[job.id].followup, undefined);
	}
});

test("[wake-collapse] A follow-up joins a queued slot row and the tick dies before it takes the follow-up: a tick while that row runs, or after it ran and left, writes no row, and the follow-up runs once.", async () => {
	for (const when of ["running", "left"] as const) {
		const stores = openStores(tmp("pi-loops-clock-scene-"));
		writeFileAtomic(stores.jobs.jobsFile, JSON.stringify({ version: 3, jobs: [job] }));
		stores.clock.seed({ [job.id]: { slot: stamp(base), fired: stamp(base), runs: 1 } });
		stores.clock.setFollowup(job.id, { at: stamp(base + 30_000), note: "check CI on #12", set_by: "run-a" }, false, base - 600_000);
		const view = (at: number, lane: string): TickInput["view"] => ({ now: at, startedAt: base, tickMs: 30_000, catchUp: true, budgetOver: false, kind: "background", self, mine: new Map<string, Mine>([[job.id, { kind: "loop" }]]), read: new Map([[job.id, { rows: stores.requests.list(lane), cwdMissing: false, history: stores.history().get(job.id) }]]) });
		const lane = `@${job.id}`;
		const [slot, woke] = decideTick({ jobs: [job], clock: stores.clock.read(), view: view(base + 60_000, lane) });
		assert.ok(slot.do === "row" && woke?.do === "followup" && woke.write === "onto" && woke.onto === slot.row.id, "the follow-up joins the slot's row");
		if (slot.do !== "row" || woke?.do !== "followup" || woke.write !== "onto") return;
		assert.equal(commitSlot(writeSlot(slot, { requests: stores.requests }), { clock: stores.clock, heldEpoch: () => 1 }).t3, "moved");
		// T2 of the follow-up, then the process dies: the follow-up is still in clock.json.
		assert.equal(writeFollowup(woke, stores), "added");
		assert.equal(stores.clock.read().jobs[job.id].followup?.id, woke.followup.id);
		const started = base + 65_000;
		assert.equal(stores.requests.claim(lane, slot.row.id, { id: slot.row.id, pid: self.pid, started_at: stamp(started) } as never), true);
		if (when === "left") {
			const claimed = stores.requests.list(lane)[0] as ClaimedRow;
			const ended: RunRecordM4b = { ...record(slot.row.id, started), row: slot.row.id, cause: "wake", woken: claimed.payload?.woken, ordinal: 2 };
			await closeLoopRun(claimed, {
				stores,
				engine: () => ({ jobs: { exists: () => true, enabled: () => true, goalActive: () => false }, inbox: stores.inbox, audit: stores.rules, ledger: stores.jobs, counts: () => ({ streak: 0, interrupted: 0 }), self: () => self }),
				sinks: { started: () => undefined, finished: () => undefined, log: () => undefined },
				holder: () => ({ pid: self.pid, procStart: undefined }),
			}, started + 1_000, ended);
			assert.deepEqual(stores.requests.list(lane), [], "the run left");
		}
		const at = base + 90_000;
		applyTick(decideTick({ jobs: [job], clock: stores.clock.read(), view: view(at, lane) }), { requests: stores.requests, clock: stores.clock, heldEpoch: () => 1 }, at);
		assert.deepEqual(stores.requests.list(lane).map((row) => row.id), when === "running" ? [slot.row.id] : [], `${when}: no second row for the follow-up`);
		assert.equal(stores.clock.read().jobs[job.id].followup, undefined, `${when}: the follow-up is taken`);
	}
});

function sceneDeps(stores: ReturnType<typeof openStores>) {
	return {
		stores,
		engine: () => ({ jobs: { exists: () => true, enabled: () => true, goalActive: () => false }, inbox: stores.inbox, audit: stores.rules, ledger: stores.jobs, counts: () => ({ streak: 0, interrupted: 0 }), self: () => self }),
		sinks: { started: () => undefined, finished: () => undefined, log: () => undefined },
		holder: () => ({ pid: self.pid, procStart: undefined }),
	};
}

test("[collapse-once] A slot collapses onto a going run, and that run closes and leaves before the tick's T3 (T3 lost, or the tick dies): the slot is not counted again on the follow-up's row.", async () => {
	for (const t3 of ["lost", "never"] as const) {
		const stores = openStores(tmp("pi-loops-clock-scene-"));
		writeFileAtomic(stores.jobs.jobsFile, JSON.stringify({ version: 3, jobs: [job] }));
		const lane = `@${job.id}`;
		const tick = (at: number) => decideTick({ jobs: [job], clock: stores.clock.read(), view: { now: at, startedAt: base, tickMs: 30_000, catchUp: true, budgetOver: false, kind: "background", self, mine: new Map<string, Mine>([[job.id, { kind: "loop" }]]), read: new Map([[job.id, { rows: stores.requests.list(lane), cwdMissing: false, history: stores.history().get(job.id) }]]) } });
		const [first] = tick(base);
		assert.ok(first.do === "row", "the first slot writes its row");
		if (first.do !== "row") return;
		assert.equal(commitSlot(writeSlot(first, stores), { clock: stores.clock, heldEpoch: () => 1 }).t3, "moved");
		const started = base + 5_000;
		assert.equal(stores.requests.claim(lane, first.row.id, { id: first.row.id, pid: self.pid, started_at: stamp(started) } as never), true);
		// The run closes on the row as it claimed it, as runLoop does: a collapse while it goes is not on this copy.
		const claimed = stores.requests.list(lane)[0] as ClaimedRow;
		stores.clock.setFollowup(job.id, { at: stamp(base + 60_000), note: "look again", set_by: first.row.id }, false, started);
		const [slot, woke] = tick(base + 70_000);
		assert.ok(slot.do === "collapse" && slot.overlap && woke?.do === "followup" && woke.write === "row", "the next slot collapses onto the going run; the follow-up gets its own row");
		if (slot.do !== "collapse" || woke?.do !== "followup") return;
		const collapsed = writeSlot(slot, stores);
		assert.equal(collapsed.t2, "counted");
		await closeLoopRun(claimed, sceneDeps(stores), started + 70_000, { ...record(first.row.id, started), row: first.row.id, ordinal: 1 });
		assert.deepEqual(stores.requests.list(lane), [], "the run left");
		if (t3 === "lost") commitSlot(collapsed, { clock: stores.clock, heldEpoch: () => 1 });
		assert.equal(applyFollowup(woke, stores, base + 75_000).t2, "wrote");
		const counted = applyTick(tick(base + 80_000), { requests: stores.requests, clock: stores.clock, heldEpoch: () => 1 }, base + 80_000).filter((outcome) => "slot" in outcome && outcome.slot === slot.slot && outcome.t2 === "counted");
		assert.deepEqual(counted, [], `${t3}: slot ${slot.slot} is counted once`);
	}
});

test("[dead-slot-exit] A committed slot's run is interrupted three times: the closing parks the job and removes its row, an exit that holds the slot.", async () => {
	const stores = openStores(tmp("pi-loops-clock-scene-"));
	writeFileAtomic(stores.jobs.jobsFile, JSON.stringify({ version: 3, jobs: [job] }));
	const lane = `@${job.id}`;
	const decision = decide(base);
	assert.ok(decision.do === "row");
	if (decision.do !== "row") return;
	assert.equal(commitSlot(writeSlot(decision, stores), { clock: stores.clock, heldEpoch: () => 1 }).t3, "moved");
	const outcomes: string[] = [];
	for (let attempt = 0; attempt < 3; attempt++) {
		const started = base + (attempt + 1) * 10_000;
		assert.equal(stores.requests.claim(lane, decision.row.id, { id: decision.row.id, pid: self.pid, started_at: stamp(started) } as never), true, `claim ${attempt + 1}`);
		const claimed = stores.requests.list(lane)[0] as ClaimedRow;
		const ended: RunRecordM4b = { ...record(decision.row.id, started), row: decision.row.id, ok: false, interrupted: true };
		outcomes.push((await closeLoopRun(claimed, sceneDeps(stores), started + 1_000, ended)).outcome);
	}
	assert.deepEqual(outcomes, ["failed", "failed", "removed"]);
	assert.deepEqual(stores.requests.list(lane), [], "the row left, parked");
	assert.equal(stores.jobs.load().find((item) => item.id === job.id)?.disabled?.code, "interrupted");
});

test("[wake-collapse] Two tickers decide one follow-up from different reads: the first T2 puts it in a row and the second writes nothing; a T2 after that row's run took the follow-up writes nothing.", () => {
	const { requests, clock } = fixture();
	const lane = `@${job.id}`;
	clock.seed({ [job.id]: { slot: stamp(base), fired: stamp(base), runs: 1 } });
	clock.setFollowup(job.id, { at: stamp(base + 10_000), note: "check CI on #12", set_by: "run-a" }, false, base);
	const tickAt = (at: number) => decideTick({ jobs: [job], clock: clock.read(), view: { now: at, startedAt: base, tickMs: 30_000, catchUp: true, budgetOver: false, kind: "background", self, mine: new Map<string, Mine>([[job.id, { kind: "loop" }]]), read: new Map([[job.id, { rows: requests.list(lane), cwdMissing: false, history: undefined }]]) } });
	const [, stale] = tickAt(base + 30_000);
	const [slot, fresh] = tickAt(base + 60_000);
	assert.ok(stale?.do === "followup" && stale.write === "row" && slot.do === "row" && fresh?.do === "followup" && fresh.write === "onto", "the slow ticker writes the follow-up's own row, the other joins it to the slot's row");
	if (stale?.do !== "followup" || slot.do !== "row" || fresh?.do !== "followup") return;
	assert.equal(commitSlot(writeSlot(slot, { requests }), { clock, heldEpoch: () => 1 }).t3, "moved");
	assert.equal(writeFollowup(fresh, { requests, clock }), "added");
	assert.equal(writeFollowup(stale, { requests, clock }), "there");
	assert.deepEqual(requests.list(lane).map((row) => [row.id, row.payload?.woken_ids]), [[slot.row.id, [fresh.followup.id]]], "one row carries the follow-up");
	// The slot's row runs and its closing takes the follow-up; the slow ticker's T2 comes after.
	requests.remove(lane, [slot.row.id]);
	clock.closeRun(job.id, { fired: stamp(base + 61_000), followups: [fresh.followup.id] });
	assert.equal(clock.read().jobs[job.id].followup, undefined);
	assert.equal(writeFollowup(stale, { requests, clock }), "gone");
	assert.deepEqual(requests.list(lane), []);
});
