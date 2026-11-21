/**
 * src/answers.ts against the stores, and the `PROTOCOL` harness. Each transition's durable writes are
 * logged with the lock held at each and compared with `PROTOCOL` of test/answer-protocol.ts. Then the process is
 * stopped after each prefix of those writes, a new process takes over with the same stores, and its
 * next ticks, drains and closings run until nothing moves. The final state is checked each time.
 *
 * A stop is a `Crash` thrown just after a write lands; from then on every write of the dead process
 * throws before it is made, so a catch on the way out cannot write more. No model runs: a run of an
 * answer is a stand-in that writes the record its runner would.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { type AnswerExecutor, type AnswerStart, type Answers, type AnswersDeps, type MeetOutcome, createAnswers } from "../src/answers.ts";
import { type Call, WHY, answerRow, answerRowId, answerStep, besideId, inputHash, isAnswerRow, noRowId, questionFinding, resolveCap } from "../src/ask.ts";
import { Inbox, type InboxEntry as Finding, type InboxSection, type NewFinding, type Sync, UNDER_INBOX_LOCK } from "../src/inbox.ts";
import { type Lane, type LaneId, parseLane } from "../src/lane.ts";
import { type ClaimedRow, type Listed, type Row, RequestStore } from "../src/requests.ts";
import { stamp } from "../src/schedule.ts";
import { JobStore, type LoopJob, type RunRecord } from "../src/store.ts";
import { type ProtocolWrite, PROTOCOL } from "./answer-protocol.ts";
import { TriggerStore } from "../src/triggers.ts";
import { tmp } from "./tmp.ts";

const JOB = "cron-a1";
const LOOP = "@cron-a1";
const CONV = "01a1dce4-8ad1-77c0-89b0-475ccfeaf683";
const CHECK = "@check-proj-1a2b3c4d";
const PERSON = { by: "terminal", session: CONV } as const;
/** pi's session id of a loop's or a check's run that asked. */
const SID = "0199aaaa-0000-7000-8000-0000000000a1";
const NOW = Date.parse("2026-11-20T02:00:00.000Z");
const COMMAND = "git push --force origin main";
const CALL: Call = { tool: "bash", tool_call_id: "call-1", command: COMMAND, input_sha256: inputHash({ command: COMMAND }), reason: "git push --force on main/master" };

class Crash extends Error {
	constructor() {
		super("the process stopped");
	}
}

type Logged = { write: ProtocolWrite["write"]; lock: ProtocolWrite["lock"] };

/** The stores of one loops directory, the process that runs on them now, and what the harness saw. */
interface World {
	dir: string;
	cwd: string;
	inbox: Inbox;
	requests: RequestStore;
	jobs: JobStore;
	audit: TriggerStore;
	log: Logged[];
	/** The process stops after this many logged writes. */
	stopAfter: number;
	dead: boolean;
	/** A write of this kind fails once, before it is made, in a living process. */
	failNext?: ProtocolWrite["write"];
	inboxHeld: boolean;
	sections: number;
	runEnds: RunRecord[];
	/** Runs started, by finding: a yes is run at most once. */
	starts: Map<string, number>;
	/** A conversation's session file, as its lease names it. */
	conversations: Map<string, string>;
	/** Pids of other processes that are alive. */
	alive: Set<number>;
	/** Why E4 waits beside a disabled loop, when the test says so. */
	block?: string;
	proc: Proc;
	answers: Answers;
	wrapped: AnswersDeps;
}

function durable<T>(w: World, write: Logged["write"], lock: Logged["lock"], make: () => T, wrote: (result: T) => boolean): T {
	if (w.dead) throw new Crash();
	if (w.failNext === write) {
		w.failNext = undefined;
		throw new Error(`the ${write} write failed`);
	}
	const result = make();
	if (wrote(result)) {
		w.log.push({ write, lock });
		if (w.log.length >= w.stopAfter) {
			w.dead = true;
			throw new Crash();
		}
	}
	return result;
}

/** The stand-in executor of one process: a run list, and a claim that goes through the logged store. */
class Proc implements AnswerExecutor {
	readonly pid: number;
	readonly runs = new Set<string>();
	readonly w: World;
	n = 0;
	constructor(w: World, pid: number) {
		this.w = w;
		this.pid = pid;
	}
	blocked(lane: Lane): string | undefined {
		if (this.w.block !== undefined) return this.w.block;
		const job = lane.kind === "loop" ? this.w.jobs.load().find((j) => `@${j.id}` === lane.id) : undefined;
		return job && !job.enabled ? "its job is disabled" : undefined;
	}
	live(row: ClaimedRow): boolean {
		return row.run.pid === this.pid ? this.runs.has(row.run.id) : this.w.alive.has(row.run.pid);
	}
	claim(row: Row, _finding: Finding, lock: typeof UNDER_INBOX_LOCK, now: number): ClaimedRow | undefined {
		const run = { id: `run-${this.pid}-${++this.n}`, pid: this.pid, started_at: stamp(now) };
		if (!this.w.wrapped.requests.claim(row.lane, row.id, run as Listed, lock)) return undefined;
		this.runs.add(run.id);
		return { ...row, kind: "input", run };
	}
	release(runId: string): void {
		this.runs.delete(runId);
	}
}

function readEntries(file: string): readonly unknown[] | undefined {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return undefined; // the file is gone
	}
	return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
}

function wrap(w: World): AnswersDeps {
	const laneLock = (): Logged["lock"] => (w.inboxHeld ? "inbox+lane" : "lane");
	const requests = w.requests;
	return {
		inbox: {
			file: w.inbox.file,
			list: () => w.inbox.list(),
			section: <T>(fn: (tx: InboxSection) => Sync<T>): Promise<T> => {
				w.sections++;
				return w.inbox.section((tx) => {
					w.inboxHeld = true;
					try {
						return fn({ list: () => tx.list(), find: (id) => tx.find(id), fileOnce: (entry, id) => tx.fileOnce(entry, id), write: (c, ...more) => durable(w, "finding", "inbox", () => tx.write(c, ...more), () => true) });
					} finally {
						w.inboxHeld = false;
					}
				});
			},
		},
		requests: {
			list: (lane) => requests.list(lane),
			appendIfAbsent: (row, opts, lock) => durable(w, "row+", laneLock(), () => requests.appendIfAbsent(row, opts, lock), (r) => r),
			claim: (lane, id, run, lock) => durable(w, "row.run", laneLock(), () => requests.claim(lane, id, run, lock), (r) => r),
			update: (lane, id, patch, lock) => durable(w, "row~", laneLock(), () => requests.update(lane, id, patch, lock), (r) => r),
			remove: (lane, ids, lock) => {
				const gone = [...ids];
				const there = requests.list(lane).some((r) => gone.includes(r.id));
				durable(w, "row-", laneLock(), () => requests.remove(lane, gone, lock), () => there);
			},
			removeIf: (lane, id, when, lock) => durable(w, "row-", laneLock(), () => requests.removeIf(lane, id, when, lock), (r) => r.outcome === "removed"),
		},
		jobs: {
			load: () => w.jobs.load(),
			appendRunOnce: (make) => durable(w, "record", "runs", () => w.jobs.appendRunOnce(make), (r) => r !== undefined),
			listRuns: (jobId, limit) => w.jobs.listRuns(jobId, limit),
			sessionDirFor: (jobId) => w.jobs.sessionDirFor(jobId),
		},
		audit: { appendAudit: (record) => durable(w, "audit", "none", () => w.audit.appendAudit(record), () => true) },
		sessionFile: (id) => w.conversations.get(id),
		entries: readEntries,
		checkSessionDir: (cwd) => w.jobs.sessionDirFor(`check-${path.basename(cwd)}`),
		checkLaneOf: (cwd) => (cwd === w.cwd ? CHECK : undefined),
		runEnd: (record) => durable(w, "run_end", "none", () => w.runEnds.push(record), () => true),
		self: () => ({ pid: w.proc.pid, instance: `proc-${w.proc.pid}`, version: "0.24.3" }),
		now: () => NOW,
		log: () => undefined,
	};
}

/** A new process on the same stores: nothing of the dead one's memory, its run list or its pid. */
function restart(w: World): void {
	w.dead = false;
	w.stopAfter = Infinity;
	w.failNext = undefined;
	w.proc = new Proc(w, w.proc.pid + 1);
	w.answers = createAnswers(w.wrapped);
}

function loopJob(cwd: string): LoopJob {
	return { id: JOB, schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "watch", cwd, enabled: true, catchUp: true, createdAt: "2026-11-01T00:00:00.000Z" } as LoopJob;
}

async function world(): Promise<World> {
	const dir = tmp("pi-loops-ask-");
	const cwd = path.join(dir, "proj");
	fs.mkdirSync(cwd, { recursive: true });
	const w = {
		dir,
		cwd,
		inbox: new Inbox(dir),
		requests: new RequestStore(dir),
		jobs: new JobStore(dir),
		audit: new TriggerStore(dir),
		log: [],
		stopAfter: Infinity,
		dead: false,
		inboxHeld: false,
		sections: 0,
		runEnds: [],
		starts: new Map(),
		conversations: new Map(),
		alive: new Set(),
	} as unknown as World;
	w.proc = new Proc(w, 1000);
	w.wrapped = wrap(w);
	w.answers = createAnswers(w.wrapped);
	await w.jobs.add(loopJob(cwd));
	return w;
}

/** A transcript that holds `call`, blocked: the call and an error result. `spoil` takes one of them away or changes it. */
function writeTranscript(file: string, call: Call, spoil?: "no-call" | "another-tool" | "another-input" | "no-error-result", id = SID): void {
	const lines: unknown[] = [{ type: "session", id }];
	if (spoil !== "no-call") {
		const name = spoil === "another-tool" ? "powershell" : call.tool;
		const args = spoil === "another-input" ? { command: "ls" } : { command: call.command };
		lines.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: call.tool_call_id, name, arguments: args }] } });
		if (spoil !== "no-error-result") lines.push({ type: "message", message: { role: "toolResult", toolCallId: call.tool_call_id, isError: true, content: [] } });
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

/** A question from a run in `lane`, filed as Q1 files it. */
async function ask(w: World, lane: "loop" | "conversation" | "check", opts: { spoil?: Parameters<typeof writeTranscript>[2]; outside?: boolean } = {}): Promise<Finding> {
	const laneId = lane === "loop" ? LOOP : lane === "conversation" ? CONV : CHECK;
	let file: string;
	if (opts.outside) file = path.join(w.dir, "elsewhere", "t1.jsonl");
	else if (lane === "loop") file = path.join(w.jobs.sessionDirFor(JOB), `t1_${SID}.jsonl`);
	else if (lane === "check") file = path.join(w.wrapped.checkSessionDir(w.cwd), `t1_${SID}.jsonl`);
	else {
		file = path.join(w.dir, "conversations", `${CONV}.jsonl`);
		w.conversations.set(CONV, file);
	}
	// pi's session id of the run that asked: a conversation's own id in its lane.
	const sessionId = lane === "conversation" ? CONV : SID;
	writeTranscript(file, CALL, opts.spoil, sessionId);
	const origin = { source: lane === "loop" ? `cron:${JOB}` : lane, run_id: "r0", cwd: w.cwd, ...(lane === "loop" ? { job_id: JOB } : {}), who: "the loop" };
	const { id, entry } = questionFinding(CALL, { lane: laneId, sessionId, sessionFile: file, cap: resolveCap({ cwd: w.cwd }, 900_000) }, origin, stamp(NOW));
	return w.inbox.fileOnce(entry, id);
}

/** A finding that is no question, from the loop. */
async function news(w: World, over: Partial<NewFinding> = {}): Promise<Finding> {
	return w.inbox.append({ source: `cron:${JOB}`, run_id: "r0", cwd: w.cwd, text: "The nightly build is red since the last merge", job_id: JOB, lane: LOOP, ...over });
}

const find = (w: World, id: string): Finding | undefined => w.inbox.list().find((f) => f.id === id);
const answerRows = (w: World): Row[] => [...w.requests.sessions(), ...w.requests.lanes().map((l) => l.id)].flatMap((lane) => w.requests.list(lane).filter((r) => r.id.startsWith("ans-")));
const audits = (w: World): Array<{ state: string; traceId: string }> => (fs.existsSync(w.audit.auditFile) ? fs.readFileSync(w.audit.auditFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** The stand-in of an answer's run: it ends ok, makes the granted call when it has a grant, and closes. */
async function run(w: World, start: AnswerStart, how: { ok?: boolean; grantUsed?: boolean; aborted?: boolean } = {}, at = NOW): Promise<void> {
	w.starts.set(start.finding.id, (w.starts.get(start.finding.id) ?? 0) + 1);
	const record: RunRecord = {
		runId: start.row.run.id,
		jobId: start.jobId,
		stateful: start.row.lane.startsWith("@cron-"),
		cwd: start.finding.cwd,
		pid: start.row.run.pid,
		startedAt: start.row.run.started_at,
		finishedAt: stamp(at),
		ok: how.ok ?? !how.aborted,
		findings: 0,
		droppedFindings: 0,
		stateUpdated: false,
		row: start.row.id,
		cause: "answer",
		...(how.aborted ? { aborted: true as const } : {}),
		...(start.resume ? { resumed: start.resume.file } : {}),
		...(start.grant ? { grant_used: how.grantUsed ?? true } : {}),
	};
	await w.answers.close(start.row, at, record);
	w.proc.release(start.row.run.id);
}

/** The next ticks and drains of the process that runs now, until nothing moves: H1, then every `ans-` row met, and a run started by E4 run and closed. */
async function settle(w: World): Promise<void> {
	// The clock moves only to the end of a backoff: a later tick finds the row F1 held until then.
	let at = NOW;
	for (let round = 0; round < 12; round++) {
		let moved = (await w.answers.repair(() => true, at)).length > 0;
		let wake = Infinity;
		for (const row of answerRows(w)) {
			const met = await w.answers.meet(parseLane(row.lane)!, row.id, w.proc, at);
			if (met.met === "E4") await run(w, met.start, {}, at);
			if (met.met !== "nothing" && met.met !== "hold" && met.met !== "W1") moved = true;
			const until = Date.parse(w.requests.list(row.lane).find((r) => r.id === row.id)?.not_before ?? "");
			if (met.met === "hold" && until > at) wake = Math.min(wake, until);
		}
		if (!moved && wake === Infinity) return;
		if (!moved) at = wake;
	}
	assert.fail("the drains did not settle");
}

const COMPANION = { done: undefined, unfinished: "outcome", not_run: "not-run" } as const;

/** What holds after every settle: a yes run once, one record per run, a final state with its one companion, no row beside a final answer, a row beside an open one. */
function invariants(w: World): void {
	for (const [id, n] of w.starts) assert.equal(n, 1, `the yes to ${id} ran ${n} times`);
	const runs = w.jobs.listRuns(undefined, Number.MAX_SAFE_INTEGER).map((r) => r.runId);
	assert.equal(new Set(runs).size, runs.length, "one record per run id");
	const all = w.inbox.list();
	const ids = all.map((f) => f.id);
	assert.equal(new Set(ids).size, ids.length, "each finding once");
	for (const f of all) {
		const state = f.answer?.state;
		if (state === undefined || state === "unreadable") continue;
		const rows = answerRows(w).filter((r) => r.payload?.finding === f.id);
		if (state === "pending" || state === "started") {
			assert.equal(rows.length, 1, `an open answer of ${f.id} has its row`);
			continue;
		}
		assert.equal(rows.length, 0, `no row beside the ${state} answer of ${f.id}`);
		for (const what of ["outcome", "not-run"] as const) assert.equal(ids.filter((i) => i === besideId(f.id, what)).length, COMPANION[state] === what ? 1 : 0, `${state} has ${what} ${COMPANION[state] === what ? "once" : "never"}`);
	}
}

const want = (writes: readonly ProtocolWrite[]): Logged[] => writes.map(({ write, lock }) => ({ write, lock }));

/**
 * The crash table of one transition. `setup` makes the stores as they are before it; `act` is the
 * transition; its log must be `writes`. `after` is what the living process does next (it runs the
 * answer it started). Then a stop after each prefix, a new process, its drains; `final` checks the
 * state with `stop` the number of writes made before the stop (undefined: no stop).
 */
async function crashTable<T>(opts: { setup: () => Promise<World>; act: (w: World) => Promise<T>; writes: readonly ProtocolWrite[]; after?: (w: World, out: T) => Promise<void>; stopped?: (w: World, stop: number) => void; final: (w: World, stop: number | undefined) => void }): Promise<void> {
	const writes = want(opts.writes);
	const w = await opts.setup();
	w.log = [];
	const out = await opts.act(w);
	assert.deepEqual(w.log, writes, "the writes and their locks are PROTOCOL's");
	await opts.after?.(w, out);
	await settle(w);
	invariants(w);
	opts.final(w, undefined);
	for (let stop = 1; stop <= writes.length; stop++) {
		const v = await opts.setup();
		v.log = [];
		v.stopAfter = stop;
		await opts.act(v).catch((err: unknown) => {
			if (!(err instanceof Crash)) throw err;
		});
		assert.ok(v.dead, `the process stopped after write ${stop}`);
		assert.deepEqual(v.log, writes.slice(0, stop), `the first ${stop} writes`);
		restart(v);
		opts.stopped?.(v, stop);
		await settle(v);
		invariants(v);
		opts.final(v, stop);
	}
}

/** A yes to `finding`, made and queued before the transition under test. */
async function yes(w: World, finding: Finding): Promise<void> {
	const said = await w.answers.say(finding.id, "yes", PERSON);
	assert.equal(said.said, "Y1");
}

/** A yes, met and started by the process, with no run behind it yet. */
async function started(w: World, finding: Finding): Promise<AnswerStart> {
	await yes(w, finding);
	const met = await w.answers.meet(parseLane(LOOP)!, answerRowId(finding.id), w.proc, NOW);
	assert.equal(met.met, "E4");
	return (met as Extract<MeetOutcome, { met: "E4" }>).start;
}

const meetRow = (w: World, f: Finding, lane: LaneId = LOOP): Promise<MeetOutcome> => w.answers.meet(parseLane(lane)!, answerRowId(f.id), w.proc, NOW);

/* ===== Scratch scenes of the M5a mutation ledger. Not part of the repository. ===== */

test("[scene e-no-lock] section E reads pending, a cancel lands, the first yes's late Y1b comes back: no run after the cancel", async () => {
	const w = await world();
	const f = await ask(w, "loop");
	await yes(w, f);
	const firstRow = answerRows(w)[0];
	const real = w.wrapped.inbox.section;
	let open!: () => void;
	const gate = new Promise<void>((resolve) => (open = resolve));
	// The next section waits: the executor has read the finding before inbox.lock and not yet taken it.
	w.wrapped.inbox.section = (<T>(fn: (tx: InboxSection) => Sync<T>): Promise<T> => {
		w.wrapped.inbox.section = real;
		return gate.then(() => real(fn));
	}) as typeof real;
	const met = meetRow(w, f);
	assert.ok("cancelled" in (await w.answers.cancel(f.id)), "the cancel goes through");
	w.requests.appendIfAbsent({ ...firstRow } as never);
	open();
	const out = await met;
	if (out.met === "E4") await run(w, out.start);
	assert.equal(w.starts.get(f.id) ?? 0, 0, `the command of a cancelled yes ran (met ${out.met})`);
	assert.equal(find(w, f.id)?.status, "new");
});

test("[scene c3-no-call-check] the session file is deleted after the prompt and comes back without the call: the news is careful", async () => {
	const w = await world();
	const f = await ask(w, "loop");
	const start = await started(w, f);
	const file = path.join(w.jobs.sessionDirFor(JOB), `t1_${SID}.jsonl`);
	fs.appendFileSync(file, `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `[Trigger ${start.row.id}] run it` }] } })}\n`);
	fs.rmSync(file);
	// The run appends after the file was deleted: the file is back with its header, no call and no prompt.
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", id: SID })}\n${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n`);
	await run(w, start, { aborted: true });
	const a = find(w, f.id)?.answer;
	assert.equal(a?.state, "unfinished");
	assert.equal(a?.state === "unfinished" && a.ending, "The command may or may not have run.");
});

test("[scene e4b-first] E4b durable and E4a not (the crash the swap opens): E1, H1 and F2 end it unfinished, and nothing runs", async () => {
	const w = await world();
	const f = await ask(w, "loop");
	await yes(w, f);
	const claim = { id: answerRowId(f.id), pid: 999_999, started_at: stamp(NOW) };
	await w.inbox.section((tx) => {
		const step = answerStep("E4", tx.find(f.id), { to: "started", run: claim as never }, { at: stamp(NOW), lane: LOOP });
		assert.ok(!("refused" in step));
		tx.write(step);
	});
	assert.equal(answerRows(w)[0].run, undefined, "the row has no claim");
	restart(w);
	const metOnce = await meetRow(w, f);
	assert.equal(metOnce.met, "E1", "a row with no run beside started is stale");
	assert.equal(answerRows(w).length, 0);
	assert.deepEqual(await w.answers.repair(() => true, NOW), [answerRowId(f.id)], "H1 puts the row back with answer.run");
	assert.deepEqual(answerRows(w)[0].run, claim);
	const metTwice = await meetRow(w, f);
	assert.equal(metTwice.met, "F2");
	await settle(w);
	invariants(w);
	const a = find(w, f.id)?.answer;
	assert.equal(w.starts.size, 0, "nothing ran");
	assert.equal(a?.state, "unfinished");
	assert.equal(a?.state === "unfinished" && a.why, WHY.died);
	assert.equal(a?.state === "unfinished" && a.ending, "The command was not run.");
	assert.ok(find(w, besideId(f.id, "outcome")), "the news outcome is filed");
});
