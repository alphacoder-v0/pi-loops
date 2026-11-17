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
import { advanceClock, applyTick, ClockNewer, ClockStore, cursorMove, decideTick, wanted, type ClockFile, type Mine, type TickInput, type TickStores, writeSlot, commitSlot } from "../src/clock.ts";
import type { LoopJobV3 } from "../src/store.ts";

const now = Date.parse("2026-01-02T03:04:05.000Z");
const job = (over: Partial<LoopJobV3> = {}): LoopJobV3 => ({ id: "cron-job", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "work", cwd: "/", enabled: true, catchUp: true, createdAt: stamp(now - 120_000), ...over });
const file = (jobs: ClockFile["jobs"] = {}): ClockFile => ({ v: 1, jobs });
const self = { pid: 1, instance: "test", version: "1" };
const input = (jobs: LoopJobV3[], mine = new Map<string, Mine>(jobs.map((j) => [j.id, { kind: "loop" }])), startedAt = now): TickInput => ({ jobs, clock: file(), view: { now, startedAt, tickMs: 30_000, catchUp: true, kind: "background", self, mine, read: new Map(jobs.map((j) => [j.id, { rows: [], history: undefined, cwdMissing: false }])) } });
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
	assert.throws(() => clock.raiseRuns("cron-job", 1));
	assert.equal(fs.readFileSync(location, "utf8"), before);
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
	// The cursor stands on the slot and fired is unmoved, as after a loop's collapse.
	const clock = file({ [loop.id]: { slot: first.slot, runs: 0 } });
	const [again] = decideTick({ ...tick, clock });
	assert.deepEqual(again, { do: "pass", job: loop.id, why: "not-due" });
});
