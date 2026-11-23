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
import { formatLocal, formatLocalZoned, stamp } from "../src/schedule.ts";
import { advanceClock, applyTick, decideWake, followupId, nextScheduled, wakeSetText, ClockNewer, ClockStore, cursorMove, decideTick, decideRunNow, firedOf, tickClock, wanted, validEntry, type ClockFile, type Mine, type TickInput, type TickStores, writeSlot, commitSlot } from "../src/clock.ts";
import { JobStore, type LoopJob } from "../src/store.ts";

const now = Date.parse("2026-01-02T03:04:05.000Z");
const job = (over: Partial<LoopJob> = {}): LoopJob => ({ id: "cron-job", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "work", cwd: "/", enabled: true, catchUp: true, createdAt: stamp(now - 120_000), ...over });
const file = (jobs: ClockFile["jobs"] = {}): ClockFile => ({ v: 1, jobs });
const self = { pid: 1, instance: "test", version: "1" };
const input = (jobs: LoopJob[], mine = new Map<string, Mine>(jobs.map((j) => [j.id, { kind: "loop" }])), startedAt = now): TickInput => ({ jobs, clock: file(), view: { now, startedAt, tickMs: 30_000, catchUp: true, budgetOver: false, kind: "background", self, mine, read: new Map(jobs.map((j) => [j.id, { rows: [], history: undefined, cwdMissing: false }])) } });
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

test("[gate-held-count] A rule's gate entry counts held readings, keeps the last one, and survives the jobs' writes; a malformed one reads as absent.", () => {
	const dir = tmp();
	const location = path.join(dir, "clock.json");
	const clock = new ClockStore({ file: location, lock: path.join(dir, "clock.lock") }, { locked: withFileLockSync, write: writeFileAtomic });
	const absent = { at: stamp(now), state: "absent" as const };
	assert.equal(clock.noteGate("dyn-a", absent, true), undefined, "nothing before the first look");
	assert.deepEqual(clock.noteGate("dyn-a", absent, true), { looks: 1, last: absent });
	const present = { at: stamp(now + 1000), state: "present" as const };
	assert.deepEqual(clock.noteGate("dyn-a", present, false), { looks: 2, last: absent });
	assert.deepEqual(clock.readGate("dyn-a"), { looks: 2, last: present }, "a reading that opens a wake is not a held look");
	clock.advance({ job: "cron-job", read: {}, slot: stamp(now), fires: true });
	clock.closeRun("cron-job", { ordinal: 1 });
	assert.deepEqual(clock.read().rules, { "dyn-a": { looks: 2, last: present } }, "the jobs' writes keep the rules");
	assert.equal(clock.read().jobs["cron-job"].runs, 1);
	fs.writeFileSync(location, JSON.stringify({ v: 1, jobs: {}, rules: { bad: { looks: -1 }, badState: { looks: 1, last: { at: stamp(now), state: "maybe" } }, good: { looks: 0 } } }));
	assert.deepEqual(Object.keys(clock.read().rules ?? {}), ["good"]);
	fs.writeFileSync(location, JSON.stringify({ v: 1, jobs: {} }));
	assert.deepEqual(clock.read(), { v: 1, jobs: {} }, "no rules key until a rule's gate is looked at");
});

test("[kept-enable-clears] The clock closes, resets and clears: an enable drops the note, as main's enable cleared the error.", () => {
	const dir = tmp();
	const clock = new ClockStore({ file: path.join(dir, "clock.json"), lock: path.join(dir, "clock.lock") }, { locked: withFileLockSync, write: writeFileAtomic });
	clock.seed({ "cron-job": { slot: stamp(now - 60_000), runs: 1, note: { at: stamp(now - 60_000), text: "missed a slot" } } });
	clock.closeRun("cron-job", { ordinal: 3, fired: stamp(now) });
	clock.reset("cron-job", stamp(now + 60_000));
	assert.equal(clock.advance({ job: "cron-job", read: { slot: stamp(now + 60_000), fired: stamp(now) }, fires: false }), "moved");
	assert.equal(clock.read().jobs["cron-job"].note?.text, "missed a slot");
	clock.clear("cron-job", stamp(now + 120_000));
	const saved = clock.read().jobs["cron-job"];
	assert.deepEqual([saved.runs, saved.slot, saved.cleared, saved.note], [3, stamp(now + 60_000), stamp(now + 120_000), undefined]);
	clock.cwdMissing("cron-job", stamp(now));
	clock.countCollapse("cron-job");
	assert.deepEqual([clock.read().jobs["cron-job"].cwdMissing, clock.read().jobs["cron-job"].collapsed], [stamp(now), 1]);
	clock.cwdMissing("cron-job", undefined);
	assert.equal(clock.read().jobs["cron-job"].cwdMissing, undefined, "a directory that is back clears the first look");
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
	const { requests, deps } = stores(tmp());
	requests.appendIfAbsent(refused);
	assert.equal(writeSlot(decision, deps).t2, "wrote");
	assert.deepEqual(requests.list("s").map((r) => r.id), [decision.row.id]);
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

test("tickClock writes the due row and advances its cursor in clock.json; jobs.json is not written.", async () => {
	const dir = tmp();
	const stored = { id: "cron-job", schedule: { kind: "every" as const, ms: 60_000 }, stateful: true, prompt: "work", cwd: dir, enabled: true, catchUp: true, createdAt: stamp(now - 120_000) };
	const jobs = new JobStore(dir);
	await jobs.add(stored);
	const before = fs.readFileSync(jobs.jobsFile, "utf8");
	const requests = new RequestStore(dir);
	const clock = new ClockStore({ file: path.join(dir, "clock.json"), lock: path.join(dir, "clock.lock") }, { locked: withFileLockSync, write: writeFileAtomic });
	const result = tickClock({ kind: "background", self, startedAt: now, tickMs: 30_000, catchUp: true, budgetOver: false, mine: () => ({ kind: "loop" }) }, {
		book: () => ({ jobs: jobs.load(), clock: clock.read() }),
		history: () => new Map(), requests, clock,
		proof: () => ({ has: () => false, older: () => false, heldRunWrote: () => false, ran: () => undefined }),
		cwdExists: () => true, heldEpoch: () => undefined,
	}, now);
	assert.equal(result[0].decision.do, "row");
	assert.equal(requests.list("@cron-job").length, 1);
	assert.equal(clock.read().jobs["cron-job"]?.slot, result[0].decision.do === "row" ? result[0].decision.slot : undefined);
	assert.equal(fs.readFileSync(jobs.jobsFile, "utf8"), before, "the definitions are not written by a tick");
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

test("[cron-set-wins] A schedule reset wins over a tick that read the old cursor.", () => {
	const dir = tmp();
	const clock = new ClockStore({ file: path.join(dir, "clock.json"), lock: path.join(dir, "clock.lock") }, { locked: withFileLockSync, write: writeFileAtomic });
	clock.seed({ "cron-job": { slot: stamp(now - 60_000), runs: 0 } });
	const stale = { job: "cron-job", read: { slot: stamp(now - 60_000) }, slot: stamp(now), fires: false };
	clock.reset("cron-job", stamp(now + 60_000));
	assert.equal(clock.advance(stale), "lost");
	assert.equal(clock.read().jobs["cron-job"].slot, stamp(now + 60_000));
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

test("[proposed] A proposal is passed over by the tick, named by no `wanted`, and refused by /cron run.", () => {
	const proposed = job({ enabled: false, proposed: { at: stamp(now - 120_000), session: "s" } });
	assert.deepEqual(decideTick(input([proposed]))[0], { do: "pass", job: proposed.id, why: "proposed" });
	assert.equal(wanted({ jobs: [proposed], clock: file(), now, mine: new Set([proposed.id]) }).size, 0);
	const plain = job({ stateful: false, sessionId: "s", name: "pr-watch", enabled: false, proposed: { at: stamp(now), session: "s" } });
	assert.equal(decideRunNow(plain, undefined, [], { kind: "window", self, view: { sessionId: "s", holdsOwn: true }, epoch: 4 }, now).refused, "is proposed and waits for your yes: /cron enable pr-watch asks again");
});

/* ------------------------------------------------ wake_me: a loop's follow-up (design 3.3, 6.6) */

const clockAt = (dir: string) => new ClockStore({ file: path.join(dir, "clock.json"), lock: path.join(dir, "clock.lock") }, { locked: withFileLockSync, write: writeFileAtomic });
const hhmm = (ms: number) => formatLocal(ms).slice(11);
const wakeRun = (startedAt: number, cause?: "wake") => ({ jobId: "cron-job", startedAt: stamp(startedAt), ...(cause ? { cause } : {}) });
const loopTick = (clock: ClockFile, rows: CountedRow[] = [], spent: string[] = [], at = now) => ({ jobs: [job()], clock, view: { ...input([job()]).view, now: at, read: new Map([["cron-job", { rows, history: spent.length ? { ordinal: 1, streak: 0, interrupted: [], spent: new Set(spent) } : undefined, cwdMissing: false }]]) } });

test("[wake-me] wake_me's write: the job's follow-up in clock.json under clock.lock, the cursor kept, and design 6.6's words", () => {
	const dir = tmp();
	const clock = clockAt(dir);
	clock.seed({ "cron-job": { slot: stamp(now - 60_000), fired: stamp(now - 60_000), runs: 4 } });
	const answer = decideWake({ when: "in 20m", note: "check CI on #12" }, { job: job(), clock: clock.read().jobs["cron-job"], runs: [], now });
	assert.deepEqual(answer, { at: stamp(now + 20 * 60_000), note: "check CI on #12", quiet: false });
	if ("refused" in answer) return;
	assert.equal(clock.setFollowup("cron-job", { ...answer, set_by: "run-a" }, answer.quiet, now), undefined, "nothing was replaced");
	const entry = clock.read().jobs["cron-job"];
	assert.deepEqual(entry.followup, { id: followupId("cron-job", "run-a", answer.at), at: answer.at, note: "check CI on #12", set_by: "run-a", created_at: stamp(now) });
	assert.deepEqual([entry.slot, entry.fired, entry.runs], [stamp(now - 60_000), stamp(now - 60_000), 4], "the cursor is the tick's");
	assert.equal(entry.quietUntil, undefined);
	assert.equal(wakeSetText(job(), entry, answer, undefined, now), `set: this loop wakes at ${formatLocalZoned(now + 20 * 60_000)} ("check CI on #12"). Its next scheduled run is ${hhmm(now + 60_000)}.`);
	assert.match(followupId("cron-job", "run-a", answer.at), /^fu-[0-9a-f]{32}$/);
	assert.deepEqual(decideWake({ when: "at 2026-01-02T03:30:00Z", note: "x" }, { job: job(), clock: undefined, runs: [], now }), { at: stamp(Date.parse("2026-01-02T03:30:00Z")), note: "x", quiet: false }, "an ISO time with its offset");
});

test("[wake-me] a follow-up that came due writes its row (source wake:, woken = [note]), then goes from clock.json", () => {
	const dir = tmp();
	const { requests, clock, deps } = stores(dir);
	clock.seed({ "cron-job": { slot: stamp(now), fired: stamp(now), runs: 1 } });
	clock.setFollowup("cron-job", { at: stamp(now - 1_000), note: "look at #12", set_by: "run-a" }, false, now - 600_000);
	const read = clock.read();
	assert.deepEqual([...wanted({ jobs: [job()], clock: read, now, mine: new Set(["cron-job"]) })], [["cron-job", "@cron-job"]], "a due follow-up is read though no slot is due");
	const decisions = decideTick(loopTick(read));
	assert.deepEqual(decisions.map((d) => d.do), ["pass", "followup"]);
	const woke = decisions[1];
	assert.equal(woke.do === "followup" && woke.write, "row");
	if (woke.do !== "followup" || woke.write !== "row") return;
	assert.deepEqual([woke.row.id, woke.row.source, woke.row.lane, woke.row.mode, woke.row.collapse_key, woke.row.payload?.woken], [read.jobs["cron-job"].followup!.id, "wake:cron-job", "@cron-job", "unattended", "cron:cron-job", ["look at #12"]]);
	const [, outcome] = applyTick(decisions, deps, now);
	assert.deepEqual(outcome, { job: "cron-job", followup: woke.followup.id, t2: "wrote", t3: "moved" });
	assert.deepEqual(requests.list("@cron-job").map((r) => r.id), [woke.followup.id]);
	assert.equal(clock.read().jobs["cron-job"].followup, undefined);
	assert.equal(clock.read().jobs["cron-job"].slot, stamp(now), "the cursor is untouched");
	assert.deepEqual(decideTick(loopTick(clock.read(), requests.list("@cron-job") as CountedRow[])).map((d) => d.do), ["pass"], "and the next tick has nothing more to do");
});

test("[wake-bounds] when: at least 60 seconds ahead", () => {
	const refused = decideWake({ when: "in 59s", note: "x" }, { job: job(), clock: undefined, runs: [], now });
	assert.deepEqual(refused, { refused: `not set: a wake is at least 60 seconds and at most 7 days ahead. Its next scheduled run is ${hhmm(now + 60_000)}.` });
	assert.equal("at" in decideWake({ when: "in 1m", note: "x" }, { job: job(), clock: undefined, runs: [], now }), true, "60 seconds is allowed");
});

test("[wake-bounds] when: at most 7 days ahead", () => {
	assert.deepEqual(decideWake({ when: "in 7d1m", note: "x" }, { job: job(), clock: undefined, runs: [], now }), { refused: `not set: a wake is at least 60 seconds and at most 7 days ahead. Its next scheduled run is ${hhmm(now + 60_000)}.` });
	assert.equal("at" in decideWake({ when: `at ${new Date(now + 7 * 86_400_000).toISOString()}`, note: "x" }, { job: job(), clock: undefined, runs: [], now }), true, "7 days is allowed");
});

test("[wake-bounds] at most 24 runs started by follow-ups in 24 hours, counted from the run log", () => {
	const runs = Array.from({ length: 24 }, (_, i) => wakeRun(now - 3_600_000 * i - 1_000, "wake"));
	assert.deepEqual(decideWake({ when: "in 20m", note: "x" }, { job: job(), clock: undefined, runs, now }), { refused: `not set: this loop has woken itself 24 times in the last 24 hours. Its next scheduled run is ${hhmm(now + 60_000)}.` });
	assert.equal("at" in decideWake({ when: "in 20m", note: "x" }, { job: job(), clock: undefined, runs: runs.slice(1), now }), true, "23 follow-up runs: one more is allowed");
	const older = [...runs.slice(1), wakeRun(now - 86_400_000 - 1_000, "wake")];
	assert.equal("at" in decideWake({ when: "in 20m", note: "x" }, { job: job(), clock: undefined, runs: older, now }), true, "a follow-up run older than 24 hours does not count");
	const slots = [...runs.slice(1), wakeRun(now - 1_000)];
	assert.equal("at" in decideWake({ when: "in 20m", note: "x" }, { job: job(), clock: undefined, runs: slots, now }), true, "a scheduled run does not count");
});

test("[wake-bounds] note: at most 500 characters", () => {
	assert.deepEqual(decideWake({ when: "in 20m", note: "n".repeat(501) }, { job: job(), clock: undefined, runs: [], now }), { refused: `not set: a note is at most 500 characters, and this one has 501. Its next scheduled run is ${hhmm(now + 60_000)}.` });
	assert.equal("at" in decideWake({ when: "in 20m", note: "n".repeat(500) }, { job: job(), clock: undefined, runs: [], now }), true);
});

test("[wake-replace] a second wake_me replaces everything the first set: the follow-up, and the quiet with it", () => {
	const dir = tmp();
	const clock = clockAt(dir);
	const first = { at: stamp(now + 3_600_000), note: "nothing before then", set_by: "run-a" };
	clock.setFollowup("cron-job", first, true, now);
	assert.deepEqual([clock.read().jobs["cron-job"].quietUntil, clock.read().jobs["cron-job"].quietWhy], [first.at, "nothing before then"]);
	const second = decideWake({ when: "in 20m", note: "check CI on #12" }, { job: job(), clock: clock.read().jobs["cron-job"], runs: [], now });
	if ("refused" in second) return assert.fail(second.refused);
	const replaced = clock.setFollowup("cron-job", { ...second, set_by: "run-b" }, second.quiet, now);
	assert.equal(replaced?.at, first.at);
	const entry = clock.read().jobs["cron-job"];
	assert.equal(entry.followup?.note, "check CI on #12");
	assert.equal(entry.followup?.id, followupId("cron-job", "run-b", second.at));
	assert.deepEqual([entry.quietUntil, entry.quietWhy], [undefined, undefined], "a call with no quiet clears the quiet the first set");
	assert.equal(wakeSetText(job(), entry, second, replaced, now), `set: this loop wakes at ${formatLocalZoned(now + 20 * 60_000)} ("check CI on #12"). This replaces the wake you set for ${hhmm(now + 3_600_000)}. Its next scheduled run is ${hhmm(now + 60_000)}.`);
	assert.equal(clock.clearWake("cron-job"), true, "/cron set --wake - takes it all");
	assert.deepEqual(Object.keys(clock.read().jobs["cron-job"]), ["runs"]);
	assert.equal(clock.clearWake("cron-job"), false);
});

test("[wake-quiet] a slot before quietUntil is skipped with the loop's words; the cursor moves and no row is written; the first slot after runs", () => {
	const dir = tmp();
	const { requests, clock, deps } = stores(dir);
	const until = now + 30 * 60_000;
	clock.setFollowup("cron-job", { at: stamp(until), note: "nothing changes over the weekend", set_by: "run-a" }, true, now - 60_000);
	const [skip] = decideTick(loopTick(clock.read()));
	assert.equal(skip.do, "skip");
	if (skip.do !== "skip") return;
	assert.equal(skip.note, `quiet until ${formatLocal(until)}, asked by the loop: "nothing changes over the weekend"`);
	assert.equal(commitSlot(writeSlot(skip, deps), deps).t3, "moved");
	assert.equal(clock.read().jobs["cron-job"].slot, skip.slot);
	assert.deepEqual(requests.list("@cron-job"), []);
	assert.equal(nextScheduled(job(), clock.read().jobs["cron-job"], now, clock.read().jobs["cron-job"].quietUntil)! >= until, true, "the next scheduled run the model is told is the first after the quiet");
	const later = decideTick(loopTick(clock.read(), [], [], until + 60_000));
	assert.deepEqual(later.map((d) => [d.do, d.do === "followup" ? d.write : undefined]), [["row", undefined], ["followup", "onto"]], "after the quiet the slot runs, and the follow-up joins its row");
});

test("[wake-collapse] a follow-up that comes due while a slot's row is queued adds its note to that row: one run with both reasons", () => {
	const dir = tmp();
	const { requests, clock, deps } = stores(dir);
	const queued = { ...row(plainRunId("cron-job", stamp(now - 60_000)), "@cron-job"), payload: { text: "go", cwd: "/" } } as CountedRow;
	requests.appendIfAbsent(queued as never);
	clock.seed({ "cron-job": { slot: stamp(now), fired: stamp(now - 60_000), runs: 1 } });
	clock.setFollowup("cron-job", { at: stamp(now - 1_000), note: "look at #12", set_by: "run-a" }, false, now - 600_000);
	const decisions = decideTick(loopTick(clock.read(), requests.list("@cron-job") as CountedRow[]));
	assert.deepEqual(decisions.map((d) => d.do === "followup" ? `followup ${d.write}` : d.do), ["pass", "followup onto"]);
	applyTick(decisions, deps, now);
	assert.deepEqual(requests.list("@cron-job").map((r) => [r.id, r.payload?.woken]), [[queued.id, ["look at #12"]]]);
	assert.equal(clock.read().jobs["cron-job"].followup, undefined);
	// The same tick decides a slot's row and the follow-up: the note goes on the slot's row.
	const fresh = stores(tmp());
	fresh.clock.setFollowup("cron-job", { at: stamp(now - 1_000), note: "both", set_by: "run-a" }, false, now - 600_000);
	const both = decideTick(loopTick(fresh.clock.read()));
	applyTick(both, fresh.deps, now);
	assert.deepEqual(fresh.requests.list("@cron-job").map((r) => [r.source, r.payload?.woken]), [["cron:cron-job", ["both"]]], "one row, with both reasons");
});

test("[wake-collapse] a slot that comes due while the follow-up's row is queued collapses onto it", () => {
	const dir = tmp();
	const { requests, clock, deps } = stores(dir);
	clock.setFollowup("cron-job", { at: stamp(now - 1_000), note: "look at #12", set_by: "run-a" }, false, now - 600_000);
	clock.seed({ "cron-job": { ...clock.read().jobs["cron-job"], slot: stamp(now), fired: stamp(now) } });
	applyTick(decideTick(loopTick(clock.read())), deps, now);
	const [woke] = requests.list("@cron-job");
	assert.equal(woke.source, "wake:cron-job");
	const [slot] = decideTick(loopTick(clock.read(), requests.list("@cron-job") as CountedRow[], [], now + 60_000));
	assert.equal(slot.do, "collapse");
	if (slot.do !== "collapse") return;
	assert.equal(slot.onto, woke.id);
	assert.equal(commitSlot(writeSlot(slot, deps), deps).t3, "moved");
	assert.deepEqual(requests.list("@cron-job").map((r) => [r.id, (r as CountedRow).collapsed, r.payload?.woken]), [[woke.id, 1, ["look at #12"]]]);
});

test("[wake-me] a disabled or proposed loop's follow-up waits, and a wake the file holds in a shape this build does not write is dropped with the cursor kept", () => {
	const due = { v: 1 as const, jobs: { "cron-job": { runs: 0, followup: { id: "fu-1", at: stamp(now - 1_000), note: "x", set_by: "r", created_at: stamp(now - 9_000) } } } };
	assert.deepEqual(decideTick({ ...loopTick(due), jobs: [job({ enabled: false })] }).map((d) => d.do), ["pass"]);
	assert.deepEqual(decideTick({ ...loopTick(due), jobs: [job({ enabled: false, proposed: { at: stamp(now), session: "s" } })] }).map((d) => d.do), ["pass"]);
	assert.deepEqual(validEntry({ slot: stamp(now), runs: 2, followup: { at: "never" }, quietUntil: stamp(now) }), { slot: stamp(now), runs: 2 });
});
