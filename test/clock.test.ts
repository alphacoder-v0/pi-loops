import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { RequestStore } from "../src/requests.ts";
import type { Row } from "../src/requests.ts";
type CountedRow = Row & { collapsed?: number; collapsed_slot?: string };
import { plainRunId } from "../src/engine.ts";
import { withFileLockSync, writeFileAtomic } from "../src/lock.ts";
import { stamp } from "../src/schedule.ts";
import { advanceClock, applyTick, ClockNewer, ClockStore, cursorMove, decideTick, decideRunNow, firedOf, tickClock, wanted, validEntry, v2Clock, type ClockFile, type Mine, type TickInput, type TickStores, writeSlot, commitSlot } from "../src/clock.ts";
import { JobStore, type LoopJobV3 } from "../src/store.ts";

const now = Date.parse("2026-01-02T03:04:05.000Z");
const job = (over: Partial<LoopJobV3> = {}): LoopJobV3 => ({ id: "cron-job", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "work", cwd: "/", enabled: true, catchUp: true, createdAt: stamp(now - 120_000), ...over });
const file = (jobs: ClockFile["jobs"] = {}): ClockFile => ({ v: 1, jobs });
const self = { pid: 1, instance: "test", version: "1" };
const input = (jobs: LoopJobV3[], mine = new Map<string, Mine>(jobs.map((j) => [j.id, { kind: "loop" }])), startedAt = now): TickInput => ({ jobs, clock: file(), view: { now, startedAt, tickMs: 30_000, catchUp: true, budgetOver: false, kind: "background", self, mine, read: new Map(jobs.map((j) => [j.id, { rows: [], history: undefined, cwdMissing: false }])) } });
const row = (id: string, lane = "@cron-job"): CountedRow => ({ v: 3, id, lane, kind: "input", source: "cron:cron-job", mode: "unattended", wake: "turn", collapse_key: "cron:cron-job", created_at: stamp(now), created_by: self, attempts: 0 });
const stores = (dir: string): { requests: RequestStore; clock: ClockStore; deps: TickStores } => {
	const requests = new RequestStore(dir);
	const clock = new ClockStore({ file: path.join(dir, "clock.json"), lock: path.join(dir, "clock.lock") }, { locked: withFileLockSync, write: writeFileAtomic });
	return { requests, clock, deps: { requests, clock, heldEpoch: () => 1 } };
};

test("[T3-cursor] advanceClock compares both stamps, keeps absent fired, and moves only once.", () => {
	const move = { job: "cron-job", read: { slot: undefined, fired: undefined }, slot: stamp(now), fires: true };
	const first = advanceClock(file(), move, true);
	assert.equal(first.result, "moved");
	assert.equal(first.next.jobs["cron-job"].runs, 1);
	assert.equal(advanceClock(first.next, move, true).result, "lost");
	assert.deepEqual(advanceClock(file({ "cron-job": { slot: "old", runs: 0 } }), move, true).next.jobs["cron-job"], { slot: "old", runs: 0 });
});

test("[T3-epoch] A lease epoch lost before T3 leaves the file untouched, with the lease read under its lock.", () => {
	const current = file();
	const result = advanceClock(current, { job: "cron-job", read: {}, slot: stamp(now), fires: true }, false);
	assert.equal(result.result, "not-holder");
	assert.equal(result.next, current);
	const dir = tmp();
	const location = path.join(dir, "clock.json");
	writeFileAtomic(location, JSON.stringify(current));
	let locked = false;
	const clock = new ClockStore({ file: location, lock: path.join(dir, "clock.lock") }, {
		locked: (lockPath, fn, opts) => withFileLockSync(lockPath, () => { locked = true; try { return fn(); } finally { locked = false; } }, opts),
		write: () => assert.fail("a lost lease must not write"),
	});
	assert.equal(clock.advance({ job: "cron-job", read: {}, slot: stamp(now), fires: true }, () => { assert.equal(locked, true); return false; }), "not-holder");
});

test("ClockStore treats missing and torn data as empty, and refuses a newer file without writing.", () => {
	const dir = tmp();
	const location = path.join(dir, "clock.json");
	const clock = new ClockStore({ file: location, lock: path.join(dir, "clock.lock") }, { locked: withFileLockSync, write: writeFileAtomic });
	assert.deepEqual(clock.read(), { v: 1, jobs: {} });
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(location, "{torn");
	assert.deepEqual(clock.read(), { v: 1, jobs: {} });
	fs.writeFileSync(location, '{"v":2,"jobs":{"future":{"runs":9}}}');
	const before = fs.readFileSync(location, "utf8");
	assert.throws(() => clock.read(), ClockNewer);
	assert.throws(() => clock.advance({ job: "cron-job", read: {}, slot: stamp(now), fires: true }));
	assert.throws(() => clock.closeRun("cron-job", { ordinal: 1 }));
	assert.equal(fs.readFileSync(location, "utf8"), before);
});

test("[clock-entry-dropped] Invalid clock entries read as absent while valid entries remain.", () => {
	const dir = tmp();
	const location = path.join(dir, "clock.json");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(location, JSON.stringify({ v: 1, jobs: { badSlot: { slot: 5 }, badType: "x", badRuns: { runs: "9" }, good: { slot: stamp(now), runs: 2 } } }));
	const clock = new ClockStore({ file: location, lock: path.join(dir, "clock.lock") }, { locked: withFileLockSync, write: writeFileAtomic });
	assert.deepEqual(Object.keys(clock.read().jobs), ["good"]);
	assert.equal(validEntry({ runs: 0, note: { at: stamp(now), text: "ok" } })?.runs, 0);
	assert.equal(validEntry({ runs: 0, note: { at: "bad", text: "no" } }), undefined);
});

test("[kept-enable-clears] ClockStore and v2Clock share close, reset and clear semantics.", async () => {
	const dir = tmp();
	const fileClock = new ClockStore({ file: path.join(dir, "clock.json"), lock: path.join(dir, "clock.lock") }, { locked: withFileLockSync, write: writeFileAtomic });
	const jobs = new JobStore(dir);
	await jobs.add({ id: "cron-job", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "p", cwd: dir, enabled: true, catchUp: true, createdAt: stamp(now), runCount: 1, skippedOverlap: 0, lastDueAt: stamp(now - 60_000), lastError: "previous failure" });
	const clocks = [fileClock, v2Clock(jobs)];
	for (const clock of clocks) {
		clock.closeRun("cron-job", { ordinal: 3, fired: stamp(now) });
		clock.reset("cron-job", stamp(now + 60_000));
		assert.equal(clock.advance({ job: "cron-job", read: { slot: stamp(now + 60_000), fired: stamp(now) }, fires: false }), "moved");
		clock.clear("cron-job", stamp(now + 120_000));
	}
	assert.equal(fileClock.read().jobs["cron-job"].runs, 3);
	assert.equal(fileClock.read().jobs["cron-job"].slot, stamp(now + 60_000));
	assert.equal(fileClock.read().jobs["cron-job"].cleared, stamp(now + 120_000));
	const saved = jobs.load()[0];
	assert.equal(saved.runCount, 3);
	assert.equal(saved.lastDueAt, stamp(now + 60_000));
	assert.equal((saved as any).clearedAt, stamp(now + 120_000));
	assert.equal(saved.lastError, undefined);
	const seeded = new ClockStore({ file: path.join(dir, "seed.json"), lock: path.join(dir, "seed.lock") }, { locked: withFileLockSync, write: writeFileAtomic });
	seeded.seed({ x: { slot: stamp(now), runs: 2 } });
	assert.equal(seeded.read().jobs.x.runs, 2);
});

test("[T2-row] The slot row has its derived id, collapse key and failure backoff, and its T3 move fires once.", () => {
	const j = job({ stateful: false, sessionId: "s" });
	const data = input([j]);
	data.view.read.set(j.id, { rows: [], cwdMissing: false, history: { ordinal: 0, streak: 3, failed: { at: stamp(now - 120_000), error: "bad" }, spent: new Set() } });
	data.view.mine.set(j.id, { kind: "plain", epoch: 1 });
	const [decision] = decideTick(data);
	assert.equal(decision.do, "row");
	if (decision.do !== "row") return;
	assert.equal(decision.row.id, plainRunId(j.id, decision.slot));
	assert.equal(decision.row.collapse_key, `cron:${j.id}`);
	assert.equal(decision.row.not_before, stamp(now - 60_000));
	assert.equal(cursorMove(decision).fired, stamp(now));
	assert.equal(cursorMove(decision).fires, true);
});

test("[T2-replaces-refused] In a window, the next slot is not collapsed onto a plain job's row pi refused: that row goes, and the slot's own row takes its place.", () => {
	const j = job({ stateful: false, sessionId: "s" });
	const data = input([j]);
	data.view = { ...data.view, kind: "window" };
	const refused = { ...row("run-refused"), lane: "s", attempts: 1 };
	data.view.read.set(j.id, { rows: [refused], cwdMissing: false, history: undefined });
	data.view.mine.set(j.id, { kind: "plain", epoch: 1 });
	const [decision] = decideTick(data);
	assert.equal(decision.do, "row");
	if (decision.do !== "row") return;
	assert.equal(decision.replaces, "run-refused");
	assert.equal(decision.row.id, plainRunId(j.id, decision.slot));
});

test("[collapse-own-id] A queued row for the slot moves only the cursor.", () => {
	const j = job();
	const slot = stamp(now);
	const details = input([j]);
	details.view.read.set(j.id, { rows: [row(plainRunId(j.id, slot))], cwdMissing: false, history: undefined });
	const [decision] = decideTick(details);
	assert.deepEqual(decision, { job: j.id, lane: `@${j.id}`, slot, read: {}, at: stamp(now), owner: { kind: "loop" }, do: "cursor", why: "own-row" });
});

test("[collapse-slot] Loop overlap counts before missed; plain missed slots skip before collapsing.", () => {
	const j = job({ catchUp: false });
	const queued = row("queued");
	const loopInput = input([j], undefined, now + 100_000);
	loopInput.view.read.set(j.id, { rows: [queued], cwdMissing: false, history: undefined });
	const [loop] = decideTick(loopInput);
	assert.equal(loop.do, "collapse");
	const plain = job({ stateful: false, sessionId: "s", catchUp: false });
	const plainInput = input([plain], undefined, now + 100_000);
	plainInput.view.read.set(plain.id, { rows: [row("queued", "s")], cwdMissing: false, history: undefined });
	plainInput.view.mine.set(plain.id, { kind: "plain", epoch: 1 });
	assert.equal(decideTick(plainInput)[0].do, "skip");
});

test("[T3-loser] A ticker that loses T3 leaves its slot row queued for the winner to find.", () => {
	const dir = tmp();
	const { requests, clock, deps } = stores(dir);
	const [decision] = decideTick(input([job()]));
	assert.equal(decision.do, "row");
	if (decision.do !== "row") return;
	const written = requests.appendIfAbsent(decision.row);
	assert.equal(written, true);
	const winner = clock.advance(cursorMove(decision));
	assert.equal(winner, "moved");
	const loser = clock.advance(cursorMove(decision));
	assert.equal(loser, "lost");
	assert.deepEqual(requests.list(decision.lane).map((r) => r.id), [decision.row.id]);
	assert.equal(deps.requests.list(decision.lane).length, 1);

	const otherDir = tmp();
	const other = stores(otherDir);
	const firstSlot = stamp(now - 60_000);
	const laterSlot = stamp(now + 60_000);
	const firstDecision = { ...decision, slot: firstSlot, row: { ...decision.row, id: plainRunId(decision.job, firstSlot) } };
	const laterDecision = { ...decision, slot: laterSlot, row: { ...decision.row, id: plainRunId(decision.job, laterSlot) } };
	const firstWrite = writeSlot(firstDecision, other.deps);
	const laterWrite = writeSlot(laterDecision, other.deps);
	assert.equal(commitSlot(laterWrite, other.deps).t3, "moved");
	assert.equal(commitSlot(firstWrite, other.deps).t3, "lost");
	assert.deepEqual(other.requests.list(decision.lane).map((r) => r.id), [firstDecision.row.id, laterDecision.row.id]);
});

test("[T1-no-gate] applyTick writes the row and clock without an event log.", () => {
	const dir = tmp();
	const { deps } = stores(dir);
	const [decision] = decideTick(input([job()]));
	const result = applyTick([decision], deps);
	assert.equal(result[0].job, "cron-job");
	assert.equal(fs.existsSync(path.join(dir, "events.jsonl")), false);
});

test("tickClock reads only jobs.json v2, writes the due row, and advances its cursor there.", async () => {
	const dir = tmp();
	const stored = { id: "cron-job", schedule: { kind: "every" as const, ms: 60_000 }, stateful: true, prompt: "work", cwd: dir, enabled: true, catchUp: true, createdAt: stamp(now - 120_000), runCount: 0, skippedOverlap: 0 };
	const jobs = new JobStore(dir);
	await jobs.add(stored);
	const requests = new RequestStore(dir);
	const clock = v2Clock(jobs);
	const result = tickClock({ kind: "background", self, startedAt: now, tickMs: 30_000, catchUp: true, budgetOver: false, mine: () => ({ kind: "loop" }) }, {
		book: () => ({ jobs: [job()], clock: file() }),
		history: () => new Map(), requests, clock,
		proof: () => ({ has: () => false, older: () => false, heldRunWrote: () => false, ran: () => undefined }),
		cwdExists: () => true, heldEpoch: () => undefined,
	}, now);
	assert.equal(result[0].decision.do, "row");
	assert.equal(requests.list("@cron-job").length, 1);
	assert.equal(jobs.load()[0].lastDueAt, result[0].decision.do === "row" ? result[0].decision.slot : undefined);
	assert.equal(fs.existsSync(path.join(dir, "clock.json")), false);
});

test("wanted names only due jobs and avoids non-owned or disabled lanes.", () => {
	const due = job();
	const notMine = job({ id: "cron-other" });
	assert.deepEqual([...wanted({ jobs: [due, notMine, job({ id: "cron-off", enabled: false })], clock: file(), now, mine: new Set([due.id, "cron-off"]) })], [[due.id, `@${due.id}`]]);
});

test("[collapse-slot] A collapse whose target row left before T2 does not move the cursor: the next tick decides the slot again.", () => {
	const dir = tmp();
	const { clock, deps } = stores(dir);
	const queued = row("run-earlier");
	const tick = input([job()]);
	const view = { ...tick.view, read: new Map([["cron-job", { rows: [queued], history: undefined, cwdMissing: false }]]) };
	const [decision] = decideTick({ ...tick, view });
	assert.equal(decision.do, "collapse");
	if (decision.do !== "collapse") return;
	// The row is not in the store: it ran and left between the tick's read and T2.
	const outcome = commitSlot(writeSlot(decision, deps), deps);
	assert.equal(outcome.t2, "missing");
	assert.notEqual(outcome.t3, "moved", "the slot is not spent on a row that is gone");
	assert.equal(clock.read().jobs["cron-job"], undefined, "the cursor did not move");
});

test("[T3-cursor] A slot that is not later than the cursor is not decided again: a loop's collapse leaves fired, and an every schedule then names the same slot.", () => {
	const loop = job();
	const tick = input([loop]);
	const [first] = decideTick(tick);
	assert.equal(first.do, "row");
	if (first.do !== "row") return;
	assert.equal(cursorMove(first).fired, undefined);
	// The cursor stands on the slot and fired is unmoved, as after a loop's collapse.
	const clock = file({ [loop.id]: { slot: first.slot, runs: 0 } });
	const [again] = decideTick({ ...tick, clock });
	assert.deepEqual(again, { do: "pass", job: loop.id, why: "not-due" });
});

test("[cron-set-wins] A schedule reset wins over a tick that read the old cursor.", async () => {
	const dir = tmp();
	const jobs = new JobStore(dir);
	await jobs.add({ id: "cron-job", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "p", cwd: dir, enabled: true, catchUp: true, createdAt: stamp(now), runCount: 0, skippedOverlap: 0, lastDueAt: stamp(now - 60_000) });
	const clock = v2Clock(jobs);
	const stale = { job: "cron-job", read: { slot: stamp(now - 60_000) }, slot: stamp(now), fires: false };
	clock.reset("cron-job", stamp(now + 60_000));
	assert.equal(clock.advance(stale), "lost");
	assert.equal(jobs.load()[0].lastDueAt, stamp(now + 60_000));
});

test("[kept-skipped-overlaps] Only a queued plain prompt or running loop row increments skipped overlap.", () => {
	const loop = job();
	const tick = input([loop]);
	tick.view.read.set(loop.id, { rows: [row("waiting")], cwdMissing: false, history: undefined });
	const [waiting] = decideTick(tick);
	assert.equal(waiting.do, "collapse");
	if (waiting.do === "collapse") assert.equal(cursorMove(waiting).collapsed, undefined);
	const active = input([loop]);
	active.view.read.set(loop.id, { rows: [{ ...row("running"), run: { id: "r", pid: 1, started_at: stamp(now - 120_000) } }], cwdMissing: false, history: undefined });
	const [overlap] = decideTick(active);
	assert.equal(overlap.do, "collapse");
	if (overlap.do === "collapse") assert.equal(cursorMove(overlap).collapsed, true);
	const plain = job({ stateful: false, sessionId: "s" });
	const plainInput = input([plain]);
	plainInput.view.mine.set(plain.id, { kind: "plain", epoch: 1 });
	plainInput.view.read.set(plain.id, { rows: [row("queued", "s")], cwdMissing: false, history: undefined });
	const [plainOverlap] = decideTick(plainInput);
	assert.equal(plainOverlap.do, "collapse");
	if (plainOverlap.do === "collapse") assert.equal(cursorMove(plainOverlap).collapsed, true);
});

test("[kept-catch-up-note] A caught-up loop row carries its slot and catch-up marker.", () => {
	const tick = input([job()], undefined, now + 100_000);
	const [decision] = decideTick(tick);
	assert.equal(decision.do, "row");
	if (decision.do !== "row") return;
	assert.equal(decision.missed, decision.slot);
	assert.equal(decision.row.payload?.slot, decision.slot);
	assert.equal((decision.row.payload as { catch_up?: true }).catch_up, true);
});

test("[kept-last-fired] A loop slot does not fire the schedule cursor; its run start does.", () => {
	const [decision] = decideTick(input([job()]));
	assert.equal(decision.do, "row");
	if (decision.do !== "row") return;
	assert.equal(cursorMove(decision).fired, undefined);
	const dir = tmp();
	const { clock } = stores(dir);
	clock.closeRun(decision.job, { fired: stamp(now + 1_000) });
	assert.equal(clock.read().jobs[decision.job].fired, stamp(now + 1_000));
	const live = { ...row("running"), run: { id: "r", pid: 1, started_at: stamp(now - 30_000) } };
	assert.equal(firedOf({ fired: stamp(now - 120_000), runs: 1 }, [live]), stamp(now - 30_000), "a live claim's start is the loop's last fired");
	const tick = input([job()]);
	tick.clock = file({ [decision.job]: { fired: stamp(now - 120_000), runs: 1 } });
	tick.view.read.set(decision.job, { rows: [live], cwdMissing: false, history: undefined });
	assert.deepEqual(decideTick(tick)[0], { do: "pass", job: decision.job, why: "not-due" }, "the live run start is the base of its every schedule");
});

test("[non-loop-id-note] A stateful job id that cannot name a loop lane is passed over.", () => {
	const invalid = job({ id: "not a lane" });
	assert.deepEqual(decideTick(input([invalid]))[0], { do: "pass", job: invalid.id, why: "not-a-loop-id" });
});

test("decideRunNow refuses queued or foreign jobs and builds a plain run row with fired but no slot.", () => {
	const plain = job({ stateful: false, sessionId: "s" });
	const scope = { kind: "window" as const, self, view: { sessionId: "s", holdsOwn: true }, epoch: 4 };
	const decision = decideRunNow(plain, { runs: 0 }, [], scope, now);
	assert.equal("row" in decision, true);
	if (!("row" in decision)) return;
	assert.equal(decision.row.source, `cron-run:${plain.id}`);
	assert.equal(decision.move.slot, undefined);
	assert.equal(decision.move.fired, stamp(now));
	assert.equal(decideRunNow(plain, undefined, [row("queued", "s")], scope, now).refused, "already has its prompt queued in this conversation");
	assert.equal(decideRunNow(plain, undefined, [], { ...scope, epoch: undefined }, now).refused, "has no chat to run in (pi-loops in the background has no session)");
});
