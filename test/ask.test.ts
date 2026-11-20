/**
 * src/answers.ts against the stores, and the `PROTOCOL` harness. Each transition's durable writes are
 * logged with the lock held at each and compared with `PROTOCOL` of src/ask.ts. Then the process is
 * stopped after each prefix of those writes, a new process takes over with the same stores, and its
 * next ticks, drains and closings run until nothing moves. The final state is checked each time.
 *
 * A stop is a `Crash` thrown just after a write lands; from then on every write of the dead process
 * throws before it is made, so a catch on the way out cannot write more. No model runs: a run of an
 * answer is a stand-in that writes the record its runner would.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { type AnswerExecutor, type AnswerStart, type Answers, type AnswersDeps, type MeetOutcome, createAnswers } from "../src/answers.ts";
import { type Call, type ProtocolWrite, type RunRecordM5a, PROTOCOL, WHY, answerRow, answerRowId, besideId, inputHash, isAnswerRow, noRowId, questionFinding } from "../src/ask.ts";
import { Inbox, type InboxEntry as Finding, type InboxSection, type NewFinding, type Sync, UNDER_INBOX_LOCK } from "../src/inbox.ts";
import { type Lane, type LaneId, parseLane } from "../src/lane.ts";
import { type ClaimedRow, type Listed, type Row, RequestStore } from "../src/requests.ts";
import { stamp } from "../src/schedule.ts";
import { JobStore, type LoopJob } from "../src/store.ts";
import { TriggerStore } from "../src/triggers.ts";
import { tmp } from "./tmp.ts";

const JOB = "cron-a1";
const LOOP = "@cron-a1";
const CONV = "01a1dce4-8ad1-77c0-89b0-475ccfeaf683";
const CHECK = "@check-proj-1a2b3c4d";
const PERSON = { by: "terminal", session: CONV } as const;
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
	runEnds: RunRecordM5a[];
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
function writeTranscript(file: string, call: Call, spoil?: "no-call" | "another-tool" | "another-input" | "no-error-result"): void {
	const lines: unknown[] = [{ type: "session", id: "s1" }];
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
	else if (lane === "loop") file = path.join(w.jobs.sessionDirFor(JOB), "t1.jsonl");
	else if (lane === "check") file = path.join(w.wrapped.checkSessionDir(w.cwd), "t1.jsonl");
	else {
		file = path.join(w.dir, "conversations", `${CONV}.jsonl`);
		w.conversations.set(CONV, file);
	}
	writeTranscript(file, CALL, opts.spoil);
	const origin = { source: lane === "loop" ? `cron:${JOB}` : lane, run_id: "r0", cwd: w.cwd, ...(lane === "loop" ? { job_id: JOB } : {}), who: "the loop" };
	const { id, entry } = questionFinding(CALL, { lane: laneId, sessionFile: file, cap: { cwd: w.cwd } }, origin, stamp(NOW));
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
async function run(w: World, start: AnswerStart, how: { ok?: boolean; grantUsed?: boolean; aborted?: boolean } = {}): Promise<void> {
	w.starts.set(start.finding.id, (w.starts.get(start.finding.id) ?? 0) + 1);
	const record: RunRecordM5a = {
		runId: start.row.run.id,
		jobId: start.jobId,
		stateful: start.row.lane.startsWith("@cron-"),
		cwd: start.finding.cwd,
		pid: start.row.run.pid,
		startedAt: start.row.run.started_at,
		finishedAt: stamp(NOW),
		ok: how.ok ?? !how.aborted,
		findings: 0,
		droppedFindings: 0,
		stateUpdated: false,
		row: start.row.id,
		cause: "answer",
		...(how.aborted ? { aborted: true as const } : {}),
		...(start.resume ? { resumed: start.resume } : {}),
		...(start.grant ? { grant_used: how.grantUsed ?? true } : {}),
	};
	await w.answers.close(start.row, NOW, record);
	w.proc.release(start.row.run.id);
}

/** The next ticks and drains of the process that runs now, until nothing moves: H1, then every `ans-` row met, and a run started by E4 run and closed. */
async function settle(w: World): Promise<void> {
	for (let round = 0; round < 12; round++) {
		let moved = (await w.answers.repair(() => true, NOW)).length > 0;
		for (const row of answerRows(w)) {
			const met = await w.answers.meet(parseLane(row.lane)!, row.id, w.proc, NOW);
			if (met.met === "E4") await run(w, met.start);
			if (met.met !== "nothing" && met.met !== "hold" && met.met !== "W1") moved = true;
		}
		if (!moved) return;
	}
	assert.fail("the drains did not settle");
}

const COMPANION = { done: undefined, unfinished: "outcome", not_run: "not-run", cancelled: "again" } as const;

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
		for (const what of ["outcome", "not-run", "again"] as const) assert.equal(ids.filter((i) => i === besideId(f.id, what)).length, COMPANION[state] === what ? 1 : 0, `${state} has ${what} ${COMPANION[state] === what ? "once" : "never"}`);
	}
}

const want = (writes: readonly ProtocolWrite[]): Logged[] => writes.map(({ write, lock }) => ({ write, lock }));

/**
 * The crash table of one transition. `setup` makes the stores as they are before it; `act` is the
 * transition; its log must be `writes`. `after` is what the living process does next (it runs the
 * answer it started). Then a stop after each prefix, a new process, its drains; `final` checks the
 * state with `stop` the number of writes made before the stop (undefined: no stop).
 */
async function crashTable<T>(opts: { setup: () => Promise<World>; act: (w: World) => Promise<T>; writes: readonly ProtocolWrite[]; after?: (w: World, out: T) => Promise<void>; final: (w: World, stop: number | undefined) => void }): Promise<void> {
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

/* ================================================================================================ */

test("[Y1] a yes is pending with its row; a stop after each write ends done once", async () => {
	let f!: Finding;
	await crashTable({
		setup: async () => {
			const w = await world();
			f = await ask(w, "loop");
			return w;
		},
		act: (w) => w.answers.say(f.id, "yes", PERSON),
		writes: PROTOCOL.Y1,
		final: (w) => {
			assert.equal(find(w, f.id)?.answer?.state, "done");
			assert.equal(w.starts.get(f.id), 1);
		},
	});
});

test("[Y1] two yeses at once give one Y1; a finding with no lane gets one; the row carries the finding only", async () => {
	const w = await world();
	const f = await news(w, { lane: undefined });
	const [a, b] = await Promise.all([w.answers.say(f.id, "yes", PERSON), w.answers.say(f.id, "yes", { by: "page", session: CONV })]);
	assert.deepEqual([a.said, b.said].sort(), ["Y1", "nothing"]);
	assert.equal(find(w, f.id)?.lane, LOOP);
	const rows = w.requests.list(LOOP);
	assert.equal(rows.length, 1);
	assert.deepEqual(Object.keys(rows[0].payload ?? {}).sort(), ["cwd", "finding", "requested_by", "text"]);
	assert.equal(rows[0].payload?.finding, f.id);
});

test("[Y2] a yes with no lane is not_run with its news, in one rewrite", async () => {
	for (const lane of ["loop", "conversation"] as const) {
		let f!: Finding;
		await crashTable({
			setup: async () => {
				const w = await world();
				f = await ask(w, lane);
				if (lane === "loop") await w.jobs.remove(JOB);
				else fs.rmSync(w.conversations.get(CONV)!);
				return w;
			},
			act: (w) => w.answers.say(f.id, "yes", PERSON),
			writes: PROTOCOL.Y2,
			final: (w) => {
				const a = find(w, f.id)?.answer;
				assert.equal(a?.state, "not_run");
				assert.equal(a?.state === "not_run" && a.why, lane === "loop" ? WHY.loopRemoved : WHY.conversationDeleted);
				assert.ok(find(w, besideId(f.id, "not-run"))?.text.includes(COMMAND));
				assert.equal(answerRows(w).length, 0);
			},
		});
	}
});

test("[YC] a yes from the command line has no answer and no row; a forged row for it meets E1", async () => {
	let f!: Finding;
	await crashTable({
		setup: async () => {
			const w = await world();
			f = await news(w);
			return w;
		},
		act: (w) => w.answers.say(f.id, "yes", { by: "cli" }),
		writes: PROTOCOL.YC,
		final: (w) => {
			const got = find(w, f.id)!;
			assert.equal(got.status, "claimed");
			assert.equal(got.answered_by, "cli");
			assert.equal(got.answer, undefined);
			assert.equal(answerRows(w).length, 0);
		},
	});
	const w = await world();
	f = await news(w);
	await w.answers.say(f.id, "yes", { by: "cli" });
	w.requests.appendIfAbsent(answerRow(find(w, f.id)!, LOOP, stamp(NOW), w.wrapped.self()));
	assert.deepEqual(await meetRow(w, f), { met: "E1", exit: "stale" });
	assert.equal(answerRows(w).length, 0);
});

test("[N1] a no to a conversation's question dismisses it and writes the no- row", async () => {
	let f!: Finding;
	await crashTable({
		setup: async () => {
			const w = await world();
			f = await ask(w, "conversation");
			return w;
		},
		act: (w) => w.answers.say(f.id, "no", PERSON, { reason: "not on main" }),
		writes: PROTOCOL.N1,
		final: (w, stop) => {
			const got = find(w, f.id)!;
			assert.equal(got.status, "dismissed");
			assert.equal(got.dismiss_reason, "not on main");
			assert.equal(got.answer, undefined);
			// A stop between N1a and N1b leaves the conversation untold; the no holds on the finding.
			assert.equal(w.requests.list(CONV).some((r) => r.id === noRowId(f.id)), stop !== 1);
		},
	});
	const w = await world();
	const loopAsk = await ask(w, "loop");
	w.log = [];
	const said = await w.answers.say(loopAsk.id, "no", PERSON);
	assert.deepEqual(said.said === "N1" && said.told, false);
	assert.deepEqual(w.log, want(PROTOCOL.N1.filter((p) => !("when" in p))), "a loop's question gets no no- row");
});

test("[E1] a row that means nothing leaves, audit stale: each condition", async () => {
	const forged = async (w: World, finding: Finding, over: Partial<Row> = {}, lane: LaneId = LOOP): Promise<Row> => {
		const row = { ...answerRow(finding, lane, stamp(NOW), w.wrapped.self()), ...over } as Row;
		if (row.run) {
			fs.mkdirSync(path.dirname(w.requests.file(lane)), { recursive: true });
			fs.appendFileSync(w.requests.file(lane), `${JSON.stringify(row)}\n`);
		} else w.requests.appendIfAbsent(row as Parameters<RequestStore["appendIfAbsent"]>[0]);
		return row;
	};
	const cases: Array<[string, (w: World) => Promise<{ row: Row; lane: LaneId }>]> = [
		["missing", async (w) => ({ row: await forged(w, { ...(await news(w)), id: `inb-${"9".repeat(32)}` }), lane: LOOP })],
		["not a real yes", async (w) => ({ row: await forged(w, await news(w)), lane: LOOP })],
		[
			"wrong id",
			async (w) => {
				const f = await news(w);
				await yes(w, f);
				return { row: await forged(w, f, { id: `ans-${"7".repeat(32)}` }), lane: LOOP };
			},
		],
		[
			"wrong lane",
			async (w) => {
				const f = await news(w);
				await yes(w, f);
				return { row: await forged(w, f, {}, CONV), lane: CONV };
			},
		],
		[
			"another project's check lane",
			async (w) => {
				const f = await news(w, { lane: CHECK, cwd: path.join(w.dir, "other"), job_id: undefined });
				await w.answers.say(f.id, "yes", PERSON);
				return { row: w.requests.list(CHECK)[0], lane: CHECK };
			},
		],
		[
			"unreadable answer",
			async (w) => {
				const f = await news(w);
				await yes(w, f);
				const text = fs.readFileSync(w.inbox.file, "utf8").replace('"state":"pending"', '"state":"later"');
				fs.writeFileSync(w.inbox.file, text);
				return { row: w.requests.list(LOOP)[0], lane: LOOP };
			},
		],
		[
			"a claim that is not the answer's",
			async (w) => {
				const f = await news(w);
				await started(w, f);
				w.requests.remove(LOOP, [answerRowId(f.id)]);
				return { row: await forged(w, find(w, f.id)!, { run: { id: "run-forged", pid: 1000, started_at: stamp(NOW) } } as Partial<Row>), lane: LOOP };
			},
		],
	];
	for (const [name, make] of cases) {
		const w = await world();
		const { row, lane } = await make(w);
		w.log = [];
		const met = await w.answers.meet(parseLane(lane)!, row.id, w.proc, NOW);
		assert.deepEqual(met, { met: "E1", exit: "stale" }, name);
		assert.deepEqual(w.log, want(PROTOCOL.E1), name);
		assert.ok(!w.requests.list(lane).some((r) => r.id === row.id), `${name}: the row left`);
		assert.equal(audits(w).at(-1)?.state, "stale", name);
	}
	let f!: Finding;
	await crashTable({
		setup: async () => {
			const w = await world();
			f = await news(w);
			await forged(w, f);
			return w;
		},
		act: (w) => meetRow(w, f),
		writes: PROTOCOL.E1,
		final: (w) => {
			assert.equal(answerRows(w).length, 0);
			assert.equal(find(w, f.id)?.status, "new");
		},
	});
});

test("[E2] a queued yes of a removed loop is not_run with its news; the row put back by H1 meets E2", async () => {
	let f!: Finding;
	const setup = async (): Promise<World> => {
		const w = await world();
		f = await ask(w, "loop");
		await yes(w, f);
		await w.jobs.remove(JOB);
		return w;
	};
	const final = (w: World): void => {
		const a = find(w, f.id)?.answer;
		assert.equal(a?.state === "not_run" && a.why, WHY.loopRemoved);
		assert.equal(w.starts.size, 0);
	};
	await crashTable({ setup, act: (w) => meetRow(w, f), writes: PROTOCOL.E2, final });
	const w = await setup();
	fs.rmSync(path.join(w.dir, "requests"), { recursive: true, force: true });
	assert.deepEqual(await w.answers.repair(() => true, NOW), [answerRowId(f.id)]);
	assert.deepEqual(await meetRow(w, f), { met: "E2", exit: "job-removed" });
	final(w);
	assert.equal(audits(w).at(-1)?.state, "job-removed");
});

test("[E3] a question whose blocked call is not proved is refused: one case per check, nothing runs", async () => {
	const checks = ["file-gone", "outside", "no-call", "another-tool", "another-input", "no-error-result"] as const;
	for (const check of checks) {
		let f!: Finding;
		await crashTable({
			setup: async () => {
				const w = await world();
				f = await ask(w, "loop", check === "outside" ? { outside: true } : check === "file-gone" ? {} : { spoil: check });
				if (check === "file-gone") fs.rmSync(f.ask!.session_file);
				await yes(w, f);
				return w;
			},
			act: (w) => meetRow(w, f),
			writes: PROTOCOL.E3,
			final: (w) => {
				const a = find(w, f.id)?.answer;
				assert.equal(a?.state, "not_run", check);
				assert.equal(w.starts.size, 0, check);
				assert.equal(w.jobs.listRuns().length, 0, check);
			},
		});
	}
});

test("[E4] the claim, then started; the living process runs it once; a stop after the claim retries, after started it ends unfinished", async () => {
	let f!: Finding;
	await crashTable({
		setup: async () => {
			const w = await world();
			f = await ask(w, "loop");
			await yes(w, f);
			return w;
		},
		act: (w) => meetRow(w, f),
		writes: PROTOCOL.E4,
		after: async (w, met) => {
			assert.equal(met.met, "E4");
			const start = (met as Extract<MeetOutcome, { met: "E4" }>).start;
			assert.equal(start.grant?.call.tool_call_id, CALL.tool_call_id);
			assert.equal(start.resume, f.ask!.session_file);
			assert.equal(start.jobId, JOB);
			assert.equal(start.finding.answer?.state, "started");
			assert.deepEqual(await meetRow(w, f), { met: "W1" }, "a second meet starts nothing");
			await run(w, start);
		},
		final: (w, stop) => {
			const a = find(w, f.id)?.answer;
			if (stop === 2) {
				// The yes is spent at E4b: the process that died ran nothing, and the transcript proves it.
				assert.equal(a?.state, "unfinished");
				assert.equal(a?.state === "unfinished" && a.ending, "The command was not run.");
				assert.equal(w.starts.size, 0);
			} else {
				assert.equal(a?.state, "done");
				assert.equal(w.starts.get(f.id), 1);
			}
		},
	});
});

test("[E4] a yes to a loop that is off waits, and goes on once the loop is enabled; a held transcript holds E4", async () => {
	const w = await world();
	const f = await ask(w, "loop");
	await w.jobs.disable(JOB, { code: "person", why: "disabled by a person", at: stamp(NOW) });
	await yes(w, f);
	w.log = [];
	assert.deepEqual(await meetRow(w, f), { met: "hold", why: "its job is disabled" });
	await settle(w);
	assert.equal(find(w, f.id)?.answer?.state, "pending");
	assert.equal(w.requests.list(LOOP)[0].waiting, "its job is disabled");
	assert.ok(!w.log.some((l) => l.write === "row.run" || l.write === "finding"), "E4 does not happen");
	await w.jobs.enable(JOB);
	await settle(w);
	assert.equal(find(w, f.id)?.answer?.state, "done");
	assert.equal(w.starts.get(f.id), 1);

	const v = await world();
	const g = await ask(v, "loop");
	await yes(v, g);
	v.block = "another pi holds the transcript";
	assert.deepEqual(await meetRow(v, g), { met: "hold", why: "another pi holds the transcript" });
	assert.equal(find(v, g.id)?.answer?.state, "pending");
});

test("[W1] a live claim beside pending, started or a final answer writes nothing", async () => {
	// pending: another live process claimed it and has not written started yet.
	const w = await world();
	const f = await news(w);
	await yes(w, f);
	w.alive.add(4242);
	w.requests.claim(LOOP, answerRowId(f.id), { id: "run-x", pid: 4242, started_at: stamp(NOW) } as Listed);
	w.log = [];
	assert.deepEqual(await meetRow(w, f), { met: "W1" });
	assert.deepEqual(w.log, want(PROTOCOL.W1));

	// started: this process runs it.
	const v = await world();
	const g = await news(v);
	await started(v, g);
	v.log = [];
	assert.deepEqual(await meetRow(v, g), { met: "W1" });
	assert.deepEqual(v.log, []);

	// final: the run closed C1 to C3 and has not removed its row yet.
	const u = await world();
	const h = await news(u);
	const start = await started(u, h);
	u.log = [];
	u.stopAfter = 3;
	await run(u, start).catch((err: unknown) => {
		if (!(err instanceof Crash)) throw err;
	});
	u.dead = false;
	u.stopAfter = Infinity;
	u.proc.runs.add(start.row.run.id);
	assert.equal(find(u, h.id)?.answer?.state, "done");
	u.log = [];
	assert.deepEqual(await meetRow(u, h), { met: "W1" });
	assert.deepEqual(u.log, []);
});

test("[F1] a dead claim beside pending is cleared with one attempt; a throw at E4b in a living process counts F1; the third ends not_run", async () => {
	let f!: Finding;
	const claimedThenStopped = async (): Promise<World> => {
		const w = await world();
		f = await ask(w, "loop");
		await yes(w, f);
		w.stopAfter = w.log.length + 1;
		await meetRow(w, f).catch((err: unknown) => {
			if (!(err instanceof Crash)) throw err;
		});
		restart(w);
		return w;
	};
	await crashTable({
		setup: claimedThenStopped,
		act: (w) => meetRow(w, f),
		writes: PROTOCOL.F1,
		after: async (_w, met) => assert.deepEqual(met, { met: "F1", attempts: 1 }),
		final: (w) => {
			assert.equal(find(w, f.id)?.answer?.state, "done");
			assert.equal(w.starts.get(f.id), 1);
		},
	});

	// E4b throws in a living process: the run leaves the list, the claim stays, the next meet counts F1.
	const w = await world();
	const g = await ask(w, "loop");
	await yes(w, g);
	w.failNext = "finding";
	await assert.rejects(meetRow(w, g), /the finding write failed/);
	assert.equal(w.proc.runs.size, 0);
	assert.ok(w.requests.list(LOOP)[0].run, "the claim stays on the row");
	assert.deepEqual(await meetRow(w, g), { met: "F1", attempts: 1 });
	assert.equal(w.requests.list(LOOP)[0].attempts, 1);
	assert.equal(w.requests.list(LOOP)[0].run, undefined);

	// Three stops between E4a and E4b: the third F1 is F1-dead.
	const deadTable = async (): Promise<World> => {
		const v = await claimedThenStopped();
		for (let i = 1; i < 3; i++) {
			assert.deepEqual(await meetRow(v, f), { met: "F1", attempts: i });
			v.stopAfter = v.log.length + 1;
			await meetRow(v, f).catch((err: unknown) => {
				if (!(err instanceof Crash)) throw err;
			});
			restart(v);
		}
		return v;
	};
	await crashTable({
		setup: deadTable,
		act: (v) => meetRow(v, f),
		writes: PROTOCOL["F1-dead"],
		final: (v) => {
			const a = find(v, f.id)?.answer;
			assert.equal(a?.state === "not_run" && a.why, WHY.notStarted);
			assert.equal(v.runEnds.length, 0, "no run_end: no run_start was emitted");
			assert.equal(v.starts.size, 0);
		},
	});
});

/** A started answer whose process stopped after E4b: the row has a dead claim. */
async function startedThenStopped(make: (w: World) => Promise<Finding>): Promise<{ w: World; f: Finding }> {
	const w = await world();
	const f = await make(w);
	await yes(w, f);
	w.stopAfter = w.log.length + 2;
	await meetRow(w, f).catch((err: unknown) => {
		if (!(err instanceof Crash)) throw err;
	});
	restart(w);
	return { w, f };
}

test("[F2] a dead claim beside started closes C1 to C4 with an interrupted record", async () => {
	let f!: Finding;
	await crashTable({
		setup: async () => {
			const s = await startedThenStopped((w) => ask(w, "loop"));
			f = s.f;
			return s.w;
		},
		act: (w) => meetRow(w, f),
		writes: PROTOCOL.F2,
		after: async (_w, met) => assert.deepEqual(met, { met: "F2", state: "unfinished" }),
		final: (w) => {
			const a = find(w, f.id)?.answer;
			assert.equal(a?.state, "unfinished");
			assert.equal(a?.state === "unfinished" && a.why, WHY.died);
			const records = w.jobs.listRuns(undefined, Number.MAX_SAFE_INTEGER);
			assert.equal(records.length, 1);
			assert.equal(records[0].interrupted, true);
			assert.equal((records[0] as RunRecordM5a).cause, "answer");
			assert.ok(w.runEnds.length >= 1, "run_end at least once; it can repeat after a stop");
		},
	});
});

test("[F3] a dead claim beside a final answer: run_end only for an answer with a claim, then the row leaves", async () => {
	// done: the run closed C1 to C3 and its process stopped before C4.
	let f!: Finding;
	await crashTable({
		setup: async () => {
			const w = await world();
			f = await ask(w, "loop");
			const start = await started(w, f);
			w.stopAfter = w.log.length + 3;
			await run(w, start).catch((err: unknown) => {
				if (!(err instanceof Crash)) throw err;
			});
			restart(w);
			w.runEnds = [];
			return w;
		},
		act: (w) => meetRow(w, f),
		writes: PROTOCOL.F3,
		after: async (_w, met) => assert.deepEqual(met, { met: "F3", state: "done" }),
		final: (w) => {
			assert.equal(find(w, f.id)?.answer?.state, "done");
			assert.ok(w.runEnds.every((r) => r.runId.startsWith("run-1000-")), "run_end with the record of the run");
		},
	});

	// not_run by F1-dead, whose process stopped before the row left: no claim on the answer, no run_end.
	const w = await world();
	const g = await news(w);
	await yes(w, g);
	for (let i = 0; i < 3; i++) {
		w.stopAfter = w.log.length + 1;
		await meetRow(w, g).catch((err: unknown) => {
			if (!(err instanceof Crash)) throw err;
		});
		restart(w);
		if (i < 2) await meetRow(w, g);
	}
	w.stopAfter = w.log.length + 1;
	await meetRow(w, g).catch((err: unknown) => {
		if (!(err instanceof Crash)) throw err;
	});
	restart(w);
	assert.equal(find(w, g.id)?.answer?.state, "not_run");
	w.log = [];
	assert.deepEqual(await meetRow(w, g), { met: "F3", state: "not_run" });
	assert.deepEqual(w.log, want(PROTOCOL.F3.filter((p) => !("when" in p))));
	assert.equal(w.runEnds.length, 0);
});

/** The closing table, C1 to C4, from the living process that ran the answer. */
async function closingTable(check: (w: World, f: Finding, stop: number | undefined) => void, how: Parameters<typeof run>[2] = {}): Promise<void> {
	let f!: Finding;
	let start!: AnswerStart;
	await crashTable({
		setup: async () => {
			const w = await world();
			f = await ask(w, "loop");
			start = await started(w, f);
			return w;
		},
		act: (w) => run(w, start, how),
		writes: PROTOCOL.C,
		final: (w, stop) => check(w, f, stop),
	});
}

test("[C1] one record per run id, with cause, resumed and grant_used", async () => {
	await closingTable((w, f) => {
		const records = w.jobs.listRuns(undefined, Number.MAX_SAFE_INTEGER) as RunRecordM5a[];
		assert.equal(records.length, 1);
		assert.equal(records[0].cause, "answer");
		assert.equal(records[0].resumed, f.ask!.session_file);
		assert.equal(records[0].grant_used, true);
		assert.equal(records[0].ok, true, "the record the run wrote is the one a later F2 reads");
		assert.equal(find(w, f.id)?.answer?.state, "done");
	});
});

test("[C2] run_end comes before C3 and C4, again after a stop, from the record after a restart", async () => {
	await closingTable((w, _f, stop) => {
		assert.ok(w.runEnds.length >= 1);
		assert.ok(w.runEnds.every((r) => r.ok && r.cause === "answer"), "made from the record the run wrote");
		if (stop === 1) assert.equal(w.runEnds.length, 1, "a stop after C1: the next process sends it once");
		if (stop === 2 || stop === 3) assert.equal(w.runEnds.length, 2, "a stop after C2 or C3: it repeats once");
	});
});

test("[C3] done needs grant_used; an unused grant is unfinished with the ending the transcript proves; a final state is not written again", async () => {
	await closingTable((w, f) => {
		const a = find(w, f.id)?.answer;
		assert.equal(a?.state, "unfinished");
		assert.equal(a?.state === "unfinished" && a.why, WHY.unused);
		assert.equal(a?.state === "unfinished" && a.ending, "The command was not run.");
		assert.ok(find(w, besideId(f.id, "outcome"))?.text.endsWith("The command was not run."));
	}, { grantUsed: false });

	// The transcript holds the prompt: the command may have run.
	const w = await world();
	const f = await ask(w, "loop");
	const start = await started(w, f);
	fs.appendFileSync(f.ask!.session_file, `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `[Trigger ${start.row.id}] run it` }] } })}\n`);
	await run(w, start, { ok: false });
	const a = find(w, f.id)?.answer;
	assert.equal(a?.state === "unfinished" && a.ending, "The command may or may not have run.");

	// A second closing writes no finding.
	w.log = [];
	const again = await w.answers.close(start.row, NOW);
	assert.equal(again.state, "unfinished");
	assert.ok(!w.log.some((l) => l.write === "finding"));
});

test("[C4] the row leaves last", async () => {
	await closingTable((w, f, stop) => {
		assert.equal(answerRows(w).length, 0);
		assert.equal(find(w, f.id)?.answer?.state, "done");
		if (stop === undefined) assert.equal(audits(w).length, 0, "a closing writes no audit line");
	});
});

test("[V1] a cancel writes cancelled and the successor in one rewrite; refused when started or final", async () => {
	const w = await world();
	const f = await ask(w, "loop");
	await yes(w, f);
	w.log = [];
	const out = await w.answers.cancel(answerRowId(f.id));
	assert.ok("cancelled" in out);
	assert.equal(w.log.filter((l) => l.write === "finding").length, 1, "one rewrite");
	assert.equal(find(w, f.id)?.answer?.state, "cancelled");
	const again = find(w, besideId(f.id, "again"))!;
	assert.equal(again.status, "new");
	assert.equal(again.ask?.id, f.ask!.id);
	assert.equal(again.lane, LOOP);

	const v = await world();
	const g = await news(v);
	const start = await started(v, g);
	assert.deepEqual(await v.answers.cancel(g.id), { refusal: { refused: "state", state: "started" } });
	await run(v, start);
	assert.deepEqual(await v.answers.cancel(g.id), { refusal: { refused: "state", state: "done" } });
});

test("[V2] the row leaves under inbox.lock; a stop between V1 and V2 leaves it to E1; a cancel and E4 at once: one wins", async () => {
	let f!: Finding;
	await crashTable({
		setup: async () => {
			const w = await world();
			f = await ask(w, "loop");
			await yes(w, f);
			return w;
		},
		act: (w) => w.answers.cancel(f.id),
		writes: PROTOCOL.V,
		final: (w) => {
			assert.equal(find(w, f.id)?.answer?.state, "cancelled");
			assert.equal(answerRows(w).length, 0);
			assert.equal(w.starts.size, 0);
		},
	});
	for (let i = 0; i < 4; i++) {
		const w = await world();
		const g = await news(w);
		await yes(w, g);
		const [cancel, met] = await Promise.all([w.answers.cancel(g.id), meetRow(w, g)]);
		if (met.met === "E4") {
			assert.ok("refusal" in cancel, "E4 first: the cancel is refused");
			await run(w, met.start);
			assert.equal(find(w, g.id)?.answer?.state, "done");
		} else {
			assert.ok("cancelled" in cancel, "the cancel first: E4 does not happen");
			await settle(w);
			assert.equal(find(w, g.id)?.answer?.state, "cancelled");
			assert.equal(w.starts.size, 0);
		}
		invariants(w);
	}
});

test("[H1] a lost row comes back for pending and started, also after the job is removed; nothing is read when nothing is open", async () => {
	let f!: Finding;
	await crashTable({
		setup: async () => {
			const w = await world();
			f = await ask(w, "loop");
			await yes(w, f);
			fs.rmSync(path.join(w.dir, "requests"), { recursive: true, force: true });
			return w;
		},
		act: (w) => w.answers.repair(() => true, NOW),
		writes: PROTOCOL.H1,
		final: (w) => assert.equal(find(w, f.id)?.answer?.state, "done"),
	});

	// started: the row comes back with the claim its finding records, and F2 closes it.
	const { w, f: g } = await startedThenStopped((x) => ask(x, "loop"));
	fs.rmSync(path.join(w.dir, "requests"), { recursive: true, force: true });
	const claim = find(w, g.id)?.answer;
	assert.deepEqual(await w.answers.repair(() => true, NOW), [answerRowId(g.id)]);
	assert.deepEqual(w.requests.list(LOOP)[0].run, claim?.state === "started" ? claim.run : undefined);
	await settle(w);
	assert.equal(find(w, g.id)?.answer?.state, "unfinished");
	invariants(w);

	// A process that does not execute the lane appends nothing.
	const u = await world();
	const h = await news(u);
	await yes(u, h);
	u.requests.remove(LOOP, [answerRowId(h.id)]);
	assert.deepEqual(await u.answers.repair((lane) => lane.kind !== "loop", NOW), []);

	// Nothing open, the inbox unchanged: the second tick reads nothing.
	const q = await world();
	await news(q);
	await q.answers.repair(() => true, NOW);
	const before = q.sections;
	assert.deepEqual(await q.answers.repair(() => true, NOW), []);
	assert.equal(q.sections, before, "no section when nothing is open and the file did not move");
});

test("[deleted-conversation] a queued yes in a conversation that was deleted is not_run with its news", async () => {
	let f!: Finding;
	await crashTable({
		setup: async () => {
			const w = await world();
			f = await ask(w, "conversation");
			await yes(w, f);
			fs.rmSync(w.conversations.get(CONV)!);
			return w;
		},
		act: (w) => meetRow(w, f, CONV),
		writes: PROTOCOL.GONE,
		final: (w) => {
			const a = find(w, f.id)?.answer;
			assert.equal(a?.state === "not_run" && a.why, WHY.conversationDeleted);
			assert.equal(w.requests.list(CONV).length, 0);
		},
	});
});

test("[deleted-conversation-blocked-lane] the deleted conversation applies in a blocked lane", async () => {
	const w = await world();
	const f = await ask(w, "conversation");
	await yes(w, f);
	fs.rmSync(w.conversations.get(CONV)!);
	w.block = "a window holds the conversation";
	w.log = [];
	assert.deepEqual(await meetRow(w, f, CONV), { met: "GONE", exit: "stale" });
	assert.deepEqual(w.log, want(PROTOCOL.GONE));
	assert.equal(find(w, f.id)?.answer?.state, "not_run");
});

test("[removed-job] one write; the queued answer meets E2; the running one in the loop's lane is stopped and closes unfinished", async () => {
	let queued!: Finding;
	let running!: Finding;
	let start!: AnswerStart;
	await crashTable({
		setup: async () => {
			const w = await world();
			running = await news(w, { text: "The release notes are stale" });
			start = await started(w, running);
			queued = await ask(w, "loop");
			await yes(w, queued);
			return w;
		},
		act: async (w) => {
			await w.jobs.remove(JOB);
			durable(w, "jobs", "jobs", () => undefined, () => true);
		},
		writes: PROTOCOL["removed-job"],
		// The living process stops the run of the removed loop (the rider of M5a.7), which closes it.
		after: (w) => run(w, start, { aborted: true }),
		final: (w) => {
			const q = find(w, queued.id)?.answer;
			assert.equal(q?.state === "not_run" && q.why, WHY.loopRemoved);
			assert.equal(find(w, running.id)?.answer?.state, "unfinished");
			assert.equal(w.starts.has(queued.id), false);
		},
	});
});
