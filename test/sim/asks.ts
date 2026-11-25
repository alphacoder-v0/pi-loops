/**
 * A simulated loops directory where runs ask a person about a call, and people answer. The real
 * `Answers`, `Inbox`, `RequestStore`, `GuardSeats`, `guardCall`, `createAnswerLanes` and
 * `convertClaimRows` do the work, on real files; a schedule is a list of steps drawn from one seed.
 *
 * What is simulated: the runner (a run writes its prompt, makes calls through the real guard, and
 * ends as the schedule says), the conversation's lease, and the process: it dies after any durable
 * write (the write log of test/ask.test.ts), and a new one starts on the same files, converting what
 * an older version left as `openStores` does.
 *
 * A window on the conversation is a second process with the real `WindowExecutor`, `windowGuard`
 * and `createWindowAnswers` over the same files; pi in it is simulated: a turn message it was handed
 * starts when the schedule says, the model's calls go through the window's guard, another
 * extension's message can arrive in a run, and `agent_settled` reaches the executor, then the
 * answers. The window dies after any durable write of its own, as the process does. `block` is a
 * pi that holds the conversation and runs none of its answers (`pi -p`, a window standing aside).
 *
 * What is left out: the engine's drain of a conversation's other rows (a `no-` row stays queued; a
 * scheduled turn is handed to the window without a row in the file), hooks, the policy's `[danger]
 * allow`, and the liveness of a live process's claim as another process reads it: every simulated
 * pid is dead to the system probe, so a window reads an orphaned claim of the live background as dead.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { type AnswerLanes, createAnswerLanes } from "../../src/answer-lanes.ts";
import { type Answerer, type Answers, type AnswersDeps, createAnswers } from "../../src/answers.ts";
import { type Grant, type ResolvedCap, answerRow, answerRowId, inputHash, isAnswerRow, resolveCap } from "../../src/ask.ts";
import { type Held, type HeldConversations, heldCap } from "../../src/background-executor.ts";
import { type ClaimRowStores, convertClaimRows } from "../../src/convert-v2.ts";
import { dangerousCommandReason } from "../../src/danger.ts";
import { plainJobRow } from "../../src/engine.ts";
import { type GuardDeps, type GuardReport, type GuardSeat, GuardSeats, guardCall } from "../../src/guard.ts";
import { INBOX_ROTATE_BYTES, Inbox, type InboxEntry, type InboxSection, type Sync, findingId } from "../../src/inbox.ts";
import { type ConversationId, type LaneId, checkLane, laneFileName, parseLane } from "../../src/lane.ts";
import { DEFAULT_RUN_TIMEOUT_MS } from "../../src/loop-run.ts";
import { type ClaimedRow, RequestStore, type Row, type UnclaimedRow } from "../../src/requests.ts";
import { RunList } from "../../src/run-list.ts";
import { type RunnerResult, type SubagentRequest, failedRun } from "../../src/runner.ts";
import { stamp } from "../../src/schedule.ts";
import { SubagentSlots } from "../../src/slots.ts";
import { JobStore, type LoopJob } from "../../src/store.ts";
import { checkSessionDir } from "../../src/check-run.ts";
import { TriggerStore } from "../../src/triggers.ts";
import { type RowCap, type WindowAnswers, WindowExecutor, createWindowAnswers, windowGuard } from "../../src/window-executor.ts";
import { type FindingMemory, decidedOnceOver, findingMemory, remember, standingOf } from "./invariants.ts";
import { pick, prng, weighted } from "./prng.ts";

export type AskStepKind =
	/** A run of a loop, a check or the conversation makes a call the policy asks about (Q1), or files a finding of its own. */
	| "ask"
	/** One or two surfaces answer one finding at once: yes or no, from a terminal, the page or the CLI. */
	| "say"
	/** A yes and a no to one finding at once, from two surfaces: one wins. */
	| "yes-and-no"
	| "cancel"
	/** The `answers` rider (H1, then the loop and check lanes) and the drain of the conversation's answers. */
	| "tick"
	/** A run that is going moves on: its prompt, the granted call, the granted call again, another call, its end. */
	| "run"
	/** The process dies after `a % 6` more durable writes (at once for 0); the next step starts a new one. */
	| "kill"
	/** A row written by hand for a finding, in its lane or another, with or without a claim. */
	| "forge"
	| "remove-job"
	| "delete-conversation"
	/** A pi that runs none of the conversation's answers takes it, and gives it back. */
	| "block"
	| "unblock"
	/** A window opens on the conversation and takes its lease. */
	| "window-open"
	/** The window's scheduled turn is handed to pi, starts, and makes one or two calls the policy asks about (Q1). The turn goes on. */
	| "window-ask"
	/** pi in the window starts the turn it was handed, or the turn going makes a call: the granted one, the granted one again, another. */
	| "window-run"
	/** Another extension's message starts in the window's run. */
	| "window-foreign"
	/** The window's turn settles, aborted or not, and the window meets the conversation's answer rows. */
	| "window-settle"
	/** The window leaves the conversation: its answer turns close, and its lease goes. */
	| "window-close"
	/** The window's process dies after `a % 6` more durable writes of its own (at once for 0). */
	| "window-die"
	/** A lane's queue file is deleted. */
	| "lose-queue"
	/** A hand edit of inbox.jsonl: a copied question, a changed lane, an ask moved to another session, another project, an unreadable answer. */
	| "edit-finding"
	/** inbox.jsonl grows past its size and is rotated. */
	| "rotate-inbox"
	/** A row 0.24.2 queued for a claim, handed over or not, and `convertClaimRows`: K1, K2. */
	| "convert"
	| "advance";

/** A kind and three numbers, read against the world as it is when the step runs (as in test/sim/schedule.ts). */
export interface AskStep {
	kind: AskStepKind;
	a: number;
	b: number;
	c: number;
}

const WEIGHTS: ReadonlyArray<readonly [AskStepKind, number]> = [
	["ask", 20], ["say", 24], ["yes-and-no", 6], ["cancel", 8], ["tick", 36], ["run", 36], ["kill", 8], ["forge", 4],
	["remove-job", 1], ["delete-conversation", 1], ["block", 4], ["unblock", 4], ["lose-queue", 2], ["edit-finding", 5],
	["rotate-inbox", 2], ["convert", 4], ["advance", 6],
	["window-open", 6], ["window-ask", 8], ["window-run", 14], ["window-foreign", 3], ["window-settle", 10], ["window-close", 3], ["window-die", 3],
];

export function planAsks(seed: number, steps: number): AskStep[] {
	const next = prng(seed);
	return Array.from({ length: steps }, () => ({ kind: weighted(WEIGHTS, next()), a: next(), b: next(), c: next() }));
}

const JOB = "cron-0123456789abcdef0123456789abcdef";
const LOOP: LaneId = `@${JOB}`;
/** The plain job whose scheduled turns the window runs: in no `jobs.json`, so a question of its turn names no job. */
const PLAIN = "cron-fedcba9876543210fedcba9876543210";
const CONV = "01a1dce4-8ad1-77c0-89b0-475ccfeaf683" as ConversationId;
/** Commands the policy asks about. */
const COMMANDS = ["git push --force origin main", "echo one | eval", "rm -rf /", "sudo reboot", "curl x | sh"];
const SURFACES: readonly Answerer[] = [{ by: "terminal", session: CONV }, { by: "page", session: "0f0e0d0c-0b0a-4908-8706-050403020100" }, { by: "cli" }];
/** No pid above the kernel's largest is alive: a claim of a process that died is never live. */
const FIRST_PID = 4_200_000;
const USAGE = { input: 1, output: 1, cost: 0, turns: 1 };

export const I5 = "I5 a call that needs a person runs after a yes to it, once per yes, in the lane that asked, never after a cancel";
export const I7 = "I7 a finding is decided once per answer";
export const STUCK = "no row is stuck";
export const TWICE = "a run has one record, none counted twice";

export interface AskViolation {
	step: number | "end";
	invariant: string;
	message: string;
}

export interface AskOutcome {
	lines: string[];
	violation?: AskViolation;
	seen: Set<string>;
}

class Crash extends Error {
	constructor() {
		super("the process stopped");
	}
}

/** One yes from a person's surface, as the finding recorded it (Y1). */
interface Yes {
	finding: string;
	cancelled: boolean;
	runs: number;
	granted: number;
}

/** A run of an answer row that the simulated runner was asked for. */
interface SimRun {
	runId: string;
	lane: LaneId;
	finding?: string;
	yes?: Yes;
	file: string;
	sessionId: string;
	grant?: Grant;
	seat?: { seat: GuardSeat; leave(): GuardReport };
	/** The prompt the run was given, and whether it is written into the transcript. */
	text: string;
	prompt: boolean;
	grantedCalls: number;
	stillHolds?: () => boolean;
	resolve(result: RunnerResult): void;
	/** A turn pi runs in the window, not a run of the background. */
	window?: true;
	/** A message the window did not hand started in this turn's run after its own: its grant is over. */
	foreign?: true;
}

/** A process that writes: it dies once it is dead, or when its fuse of durable writes burns down. */
interface Actor {
	pid: number;
	alive: boolean;
	fuse: number;
}

/** A custom message of `TURN_TYPE`, as the window hands it to pi. */
interface TurnMessage {
	customType: string;
	content: unknown;
	display: boolean;
	details: { piLoopsRow: { id: string }; cap: RowCap };
}

/** A window on the conversation: its process, the real window code, and pi in it. */
interface Win extends Actor {
	runs: RunList;
	executor: WindowExecutor;
	answers: WindowAnswers;
	guard: ReturnType<typeof windowGuard>;
	/** pi's session manager, as the guard keys its seats by it and the executor reads its entries. */
	session: { getSessionId(): string; getSessionFile(): string | undefined; getEntries(): readonly unknown[] };
	idle: boolean;
	/** Turn messages pi was handed and has not started, oldest first. */
	handed: Array<{ message: TurnMessage; run: SimRun }>;
	/** The turn pi runs now. */
	turn?: SimRun;
}

interface Proc extends Actor {
	runs: RunList;
	seats: GuardSeats;
	answers: Answers;
	lanes: AnswerLanes;
	going: SimRun[];
}

/** The conversation as its lease and its file are. */
interface Conversation {
	file: string;
	deleted: boolean;
	window: boolean;
	epoch: number;
	held?: { epoch: number; pid: number };
}

const lineOf = (value: unknown): string => `${JSON.stringify(value)}\n`;
const person = (by: unknown): boolean => by === "terminal" || by === "page";
const flagged = (command: string, dir: string): boolean => dangerousCommandReason(command, undefined, [], dir) !== undefined;
const askOf = (id: string): string => findingId(`ask | ${id}`);

function readEntries(file: string): readonly unknown[] | undefined {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return undefined; // the file is gone
	}
	return text.split("\n").filter(Boolean).flatMap((line) => {
		try {
			return [JSON.parse(line) as unknown];
		} catch {
			return []; // a line torn by a hand edit reads as nothing, as pi reads it
		}
	});
}

/**
 * Run `steps` in a new loops directory under `dir`, checking every invariant after every step, then
 * let the world finish: the window leaves, a process lives, every run ends, and ticks go on past
 * every wait until no answer row is left.
 */
export async function playAsks(dir: string, steps: readonly AskStep[]): Promise<AskOutcome> {
	const out: AskOutcome = { lines: [], seen: new Set() };
	const cwd = path.join(dir, "proj");
	fs.mkdirSync(cwd, { recursive: true });
	const inbox = new Inbox(dir);
	const requests = new RequestStore(dir);
	const jobs = new JobStore(dir);
	const audit = new TriggerStore(dir);
	const CHECK = checkLane(cwd)!;
	const LANES: readonly LaneId[] = [LOOP, CHECK, CONV];
	const conversation: Conversation = { file: path.join(dir, "conversations", `${CONV}.jsonl`), deleted: false, window: false, epoch: 0 };
	fs.mkdirSync(path.dirname(conversation.file), { recursive: true });
	fs.writeFileSync(conversation.file, lineOf({ type: "session", id: CONV, cwd }));
	await jobs.add({ id: JOB, schedule: { kind: "every", ms: 3_600_000 }, stateful: true, prompt: "watch", cwd, enabled: true, catchUp: false, createdAt: stamp(Date.now()) } as LoopJob);

	let now = Date.now();
	let n = 0;
	let pids = FIRST_PID;
	let closing = 0;
	/** The window that holds the conversation, while it lives and holds it. */
	let win: Win | undefined;
	/** A window holds the conversation: the simulated one, or a pi that runs none of its answers. */
	const windowed = (): boolean => conversation.window || win !== undefined;
	let rotated = false;
	const memory: FindingMemory = findingMemory();
	const edited = new Set<string>();
	const yeses = new Map<string, Yes[]>();
	/** Every run the runner was asked for, by its claim: each has one record once the schedule is over. */
	const started: string[] = [];
	const broken: Array<{ invariant: string; message: string }> = [];
	const logs: string[] = [];
	const fail = (invariant: string, message: string): void => void broken.push({ invariant, message });

	/** A durable write of `me`: refused once it is dead, and its last when the fuse burns down. */
	function durable<T>(me: Actor, make: () => T, wrote: (result: T) => boolean = () => true): T {
		if (!me.alive) throw new Crash();
		const result = make();
		if (wrote(result) && --me.fuse <= 0) {
			me.fuse = Infinity;
			die(me, "in the middle of its writes");
			throw new Crash();
		}
		return result;
	}

	/** `me` stops: the background's runs and lease go with it; a window's lease is free for the next holder, as a dead pid's is. */
	function die(me: Actor, when: string): void {
		me.alive = false;
		if (me === win) {
			win.handed = [];
			win.turn = undefined;
			win = undefined;
			out.seen.add(`the window dies ${when}`);
			return;
		}
		(me as Proc).going = [];
		if (conversation.held?.pid === me.pid) conversation.held = undefined;
		out.seen.add(`dies ${when}`);
	}

	const wrapTx = (tx: InboxSection, me: Actor): InboxSection => ({
		list: () => tx.list(),
		find: (id) => tx.find(id),
		write: (change, ...more) => durable(me, () => tx.write(change, ...more)),
		fileOnce: (entry, id) => {
			const there = tx.find(id) !== undefined;
			return durable(me, () => tx.fileOnce(entry, id), () => !there);
		},
	});

	function storeOf(me: Actor): RequestStore {
		const store: RequestStore = Object.create(requests);
		store.appendIfAbsent = (row, opts, lock) => durable(me, () => requests.appendIfAbsent(row, opts, lock), (did) => did);
		store.claim = (lane, id, run, lock) => durable(me, () => requests.claim(lane, id, run, lock), (did) => did);
		store.update = (lane, id, patch, lock) => durable(me, () => requests.update(lane, id, patch, lock), (did) => did);
		store.remove = (lane, ids, lock) => {
			const there = requests.list(lane).some((row) => ids.includes(row.id));
			durable(me, () => requests.remove(lane, ids, lock), () => there);
		};
		store.removeIf = (lane, id, when, lock) => durable(me, () => requests.removeIf(lane, id, when, lock), (taken) => taken.outcome === "removed");
		return store;
	}

	const conversations = (me: Proc): HeldConversations => ({
		closed: () => !windowed(),
		hold: (_id, _runId) => {
			if (conversation.deleted) return { refused: "its file is gone" };
			if (windowed()) return { refused: "a window holds it" };
			conversation.epoch++;
			conversation.held = { epoch: conversation.epoch, pid: me.pid };
			return { sessionId: CONV, epoch: conversation.epoch, sessionFile: conversation.file, cwd };
		},
		release: (held) => {
			if (conversation.held?.epoch === held.epoch) conversation.held = undefined;
		},
		holds: (held: Held) => me.alive && !windowed() && conversation.held?.epoch === held.epoch,
		trusts: () => true,
	});

	const checkCap = (at: string): ResolvedCap => resolveCap({ cwd: at }, DEFAULT_RUN_TIMEOUT_MS);

	/** The facts of the yes, the finding and the lane at the moment a run starts or a call runs. */
	function startOf(run: SimRun): void {
		const row = requests.list(run.lane).find((r) => r.id === run.runId);
		const id = row?.payload?.finding;
		run.finding = id;
		if (row?.run) started.push(`${row.run.id} ${row.run.started_at}`);
		const finding = inbox.list().find((f) => f.id === id);
		const name = nameOf(run);
		if (!finding) return fail(I5, `${name} started for a finding that is not in the inbox`);
		const yes = yeses.get(finding.id)?.at(-1);
		run.yes = yes;
		if (finding.status !== "claimed" || !person(finding.answered_by)) fail(I5, `${name} started for ${finding.id}, which is ${finding.status} by ${finding.answered_by ?? "nobody"}, not a yes from a terminal or the page`);
		if (finding.answer?.state !== "started" || finding.answer.run.id !== run.runId) fail(I5, `${name} started for ${finding.id}, whose answer is ${finding.answer?.state ?? "none"} and not started with this run`);
		if (!yes) fail(I5, `${name} started for ${finding.id}, and no person said yes to it`);
		else if (yes.cancelled) fail(I5, `${name} started for ${finding.id} after its yes was cancelled`);
		else if (yes.runs++ > 0) fail(I5, `${name} is the second run of one yes to ${finding.id}`);
		if (finding.lane !== run.lane) fail(I5, `${name} started for ${finding.id}, whose lane is ${finding.lane ?? "none"}`);
		out.seen.add(run.window ? "a run starts in a window" : `a run starts in a ${parseLane(run.lane)?.kind} lane`);
	}

	const nameOf = (run: SimRun): string => `${run.window ? "the window's turn" : "the run"} ${run.runId.slice(0, 12)} in ${run.lane}`;

	/** Whether the guard blocks one call: a background run's seat through `guardCall`, a window's turn through the window's `tool_call` handler. */
	type Judge = (id: string, input: { command: string }) => Promise<boolean>;
	const background = (me: Proc, run: SimRun): Judge => async (id, input) => (await guardCall({ toolName: "bash", toolCallId: id, input, cwd }, run.seat?.seat, guardDeps(me))) !== undefined;
	const inWindow = (w: Win): Judge => async (id, input) => (await w.guard({ toolName: "bash", toolCallId: id, input }, { cwd, sessionManager: w.session }))?.block === true;

	/** A call a run makes through the real guard. Returns whether it ran. */
	async function call(judge: Judge, run: SimRun, command: string): Promise<boolean> {
		const id = `tc-${++n}`;
		const input = { command };
		const blocked = await judge(id, input);
		append(run.file, { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: input }] } });
		append(run.file, { type: "message", message: { role: "toolResult", toolCallId: id, isError: blocked, content: [] } });
		if (blocked || !flagged(command, dir)) return !blocked;
		const name = nameOf(run);
		const granted = run.grant !== undefined && inputHash(input) === run.grant.call.input_sha256;
		if (!granted) {
			fail(I5, `${name} ran \`${command}\`, which needs a person, with no grant for it`);
			return true;
		}
		run.grantedCalls++;
		out.seen.add(`${run.grantedCalls > 1 ? "a granted call runs again" : "a granted call runs"}${run.window ? " in a window" : ""}`);
		if (run.foreign) fail(I5, `${name} ran the granted call of ${run.grant!.finding} after a message the window did not hand started in its run`);
		const finding = inbox.list().find((f) => f.id === run.grant!.finding);
		if (run.finding !== run.grant!.finding) fail(I5, `${name} ran the call granted to ${run.grant!.finding} for the finding ${run.finding}`);
		if (finding && !edited.has(finding.id)) {
			if (finding.status !== "claimed" || !person(finding.answered_by)) fail(I5, `${name} ran the granted call of ${finding.id}, which is ${finding.status} by ${finding.answered_by ?? "nobody"}`);
			if (finding.answer?.state !== "started" || finding.answer.run.id !== run.runId) fail(I5, `${name} ran the granted call of ${finding.id}, whose answer is ${finding.answer?.state ?? "none"}`);
			if (finding.ask?.call.input_sha256 !== inputHash(input)) fail(I5, `${name} ran a call whose hash is not the one ${finding.id} asked about`);
			if (finding.ask?.lane !== run.lane) fail(I5, `${name} ran the granted call of ${finding.id}, which ${finding.ask?.lane} asked`);
		}
		const yes = run.yes;
		if (!yes) fail(I5, `${name} ran a granted call with no yes`);
		else if (yes.cancelled) fail(I5, `${name} ran the granted call of ${yes.finding} after its yes was cancelled`);
		else if (yes.granted++ > 0) fail(I5, `${name} ran the granted call of ${yes.finding} ${yes.granted} times for one yes`);
		return true;
	}

	const append = (file: string, value: unknown): void => {
		if (file === conversation.file && conversation.deleted) return;
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, lineOf(value));
	};

	const guardDeps = (me: Actor): GuardDeps => ({
		inbox: { list: () => inbox.list(), fileOnce: (entry, id) => inbox.section((tx) => wrapTx(tx, me).fileOnce(entry, id)) },
		allowCommands: () => [],
		loopsDir: dir,
		hop: 1,
		now: () => now,
		log: (line) => void logs.push(line),
	});

	function answersDeps(me: Actor, instance = "background"): AnswersDeps {
		const store = storeOf(me);
		return {
			inbox: { file: inbox.file, list: () => inbox.list(), section: <T>(fn: (tx: InboxSection) => Sync<T>): Promise<T> => inbox.section((tx) => fn(wrapTx(tx, me))) },
			requests: store,
			jobs: { load: () => jobs.load(), appendRunOnce: (make) => durable(me, () => jobs.appendRunOnce(make), (r) => r !== undefined), listRuns: (id, limit) => jobs.listRuns(id, limit), sessionDirFor: (id) => jobs.sessionDirFor(id) },
			audit: { appendAudit: (record) => durable(me, () => audit.appendAudit(record)) },
			sessionFile: (id) => (id === CONV ? conversation.file : undefined),
			entries: readEntries,
			checkSessionDir: (at) => checkSessionDir(jobs, at),
			checkLaneOf: (at) => checkLane(at),
			runEnd: () => durable(me, () => undefined),
			self: () => ({ pid: me.pid, instance, version: "sim" }),
			now: () => now,
			log: (line) => void logs.push(line),
		};
	}

	/** The real `Answers`, with what the schedule reached and every closing counted until it ends. */
	function tracked(real: Answers, where = ""): Answers {
		return {
			...real,
			meet: async (lane, rowId, executor, at) => {
				const met = await real.meet(lane, rowId, executor, at);
				out.seen.add(`met ${met.met}${where}`);
				return met;
			},
			close: async (row, at, ended) => {
				closing++;
				try {
					return await real.close(row, at, ended);
				} finally {
					closing--;
				}
			},
			repair: async (executes, at) => {
				const ids = await real.repair(executes, at);
				if (ids.length) out.seen.add(`H1 puts a row back${where}`);
				return ids;
			},
		};
	}

	function start(): Proc {
		const me = { pid: ++pids, alive: true, fuse: Infinity, runs: new RunList(), seats: new GuardSeats(), going: [] } as unknown as Proc;
		const real = createAnswers(answersDeps(me));
		me.answers = real;
		const store = storeOf(me);
		me.lanes = createAnswerLanes({
			answers: tracked(real),
			stores: { jobs, inbox, requests: store, book: () => ({ jobs: jobs.load(), clock: { v: 1, jobs: {} } }) },
			runs: me.runs,
			runner: (req) => runner(me, req),
			slots: new SubagentSlots(4),
			session: () => ({ cwd, sessionId: "background" }),
			hop: 1,
			holder: () => ({ pid: me.pid, procStart: undefined }),
			budgetCap: () => undefined,
			cwdExists: () => true,
			transcriptHeld: () => false,
			// A check's run here files its questions and ends in the same step: none is going when a lane drains.
			checkRunning: () => false,
			checkSessionDir: (at) => checkSessionDir(jobs, at),
			checkCap,
			conversations: conversations(me),
			started: () => undefined,
			log: (line) => void logs.push(line),
			now: () => now,
		});
		return me;
	}

	/** The simulated runner: a run that waits for the schedule to move it. */
	function runner(me: Proc, req: SubagentRequest): Promise<RunnerResult> {
		const lane = req.guard?.lane ?? "";
		let file: string;
		let sessionId: string;
		if (req.sessionFile !== undefined) {
			file = req.sessionFile;
			sessionId = req.sessionId;
		} else if (req.resume !== undefined) {
			file = req.resume.file;
			sessionId = req.resume.sessionId;
		} else {
			sessionId = `answer-session-${++n}`;
			file = path.join(req.sessionDir ?? dir, `${n}_${sessionId}.jsonl`);
			append(file, { type: "session", id: sessionId, cwd });
		}
		req.onSessionFile?.(file);
		return new Promise<RunnerResult>((resolve) => {
			const run: SimRun = { runId: req.runId ?? "", lane, file, sessionId, ...(req.guard?.grant ? { grant: req.guard.grant } : {}), text: req.prompt, prompt: false, grantedCalls: 0, ...(req.stillHolds ? { stillHolds: req.stillHolds } : {}), resolve };
			if (req.guard) run.seat = me.seats.enter({ getSessionId: () => sessionId }, file, req.guard);
			startOf(run);
			me.going.push(run);
		});
	}

	/** Until every closing that a step set off is over. */
	async function quiet(): Promise<void> {
		for (let i = 0; i < 2_000; i++) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			if (closing === 0 && i >= 3) return;
		}
		throw new Error("a closing did not end");
	}

	async function end(me: Proc, run: SimRun, how: "ok" | "failed" | "stopped"): Promise<string> {
		const taken = run.stillHolds?.() === false;
		const as = taken ? "stopped" : how;
		const report = run.seat?.leave();
		const files = { sessionId: run.sessionId, sessionFile: run.file, ...(report ? { guard: report } : {}) };
		const result: RunnerResult = as === "ok" ? { ok: true, timedOut: false, text: "", usage: USAGE, exitCode: 0, ...files } : as === "failed" ? failedRun("boom", files) : failedRun("aborted", { stopReason: "aborted", ...files });
		me.going = me.going.filter((r) => r !== run);
		run.resolve(result);
		await quiet();
		const finding = inbox.list().find((f) => f.id === run.finding);
		const state = finding?.answer?.state;
		if (state === "done" || state === "unfinished") out.seen.add(`an answer ends ${state}`);
		return `ends ${as}${taken ? " (a window took the conversation)" : ""}: the answer is ${state ?? "gone"}`;
	}

	/** A window opens on the conversation: a process of its own, wired as src/pi-loops.ts wires one, over a simulated pi. */
	function openWindow(): Win {
		const w = { pid: ++pids, alive: true, fuse: Infinity, runs: new RunList(), idle: true, handed: [] } as unknown as Win;
		const holder = { pid: w.pid, procStart: undefined };
		const holds = (): boolean => w.alive && win === w;
		w.session = { getSessionId: () => CONV, getSessionFile: () => conversation.file, getEntries: () => readEntries(conversation.file) ?? [] };
		const ctx = { mode: "tui", hasUI: false, cwd, isIdle: () => w.idle, hasPendingMessages: () => false, sessionManager: w.session, ui: { notify: () => undefined }, abort: () => undefined } as unknown as ExtensionContext;
		/** pi is handed a turn message: an answer's turn starts its run as it is handed (E4b is written), and I5 is checked then. */
		const sendMessage = (message: TurnMessage): void => {
			const rowId = message.details.piLoopsRow.id;
			const answer = rowId.startsWith("ans-");
			const grant = answer ? w.answers.seat(message.details.cap)?.seed.grant : undefined;
			const run: SimRun = { runId: rowId, lane: CONV, file: conversation.file, sessionId: CONV, ...(grant ? { grant } : {}), text: String(message.content), prompt: false, grantedCalls: 0, resolve: () => undefined, window: true };
			if (answer) startOf(run);
			w.handed.push({ message, run });
		};
		const pi = { sendMessage, sendUserMessage: () => undefined } as unknown as Pick<ExtensionAPI, "sendMessage" | "sendUserMessage">;
		const binding = { here: () => ({ sessionId: CONV, holds: holds() }), hold: () => holds(), letGo: () => undefined };
		const store = storeOf(w);
		w.executor = new WindowExecutor(pi, binding, () => ctx, holder, () => true, () => requests.list(CONV), undefined, () => jobs.allRuns(), undefined, (runId) => w.runs.get(runId) !== undefined);
		const answers = tracked(createAnswers(answersDeps(w, "terminal")), " in a window");
		w.answers = createWindowAnswers({ answers, requests: store, runs: w.runs, executor: w.executor, here: () => ({ sessionId: CONV, cwd, sessionFile: conversation.file }), jobs: () => jobs.load(), holder: () => holder, log: (line) => void logs.push(line) });
		w.guard = windowGuard({
			current: () => w.executor.currentTurn(),
			config: () => ({ allowCommands: [], loopsDir: dir }),
			log: (line) => void logs.push(line),
			inbox: guardDeps(w).inbox,
			now: () => now,
			jobOf: () => undefined,
			answerTurn: (cap) => w.answers.seat(cap),
			seats: new GuardSeats(),
		});
		return w;
	}

	/** pi in the window starts the oldest turn it was handed: its message is written into the conversation, mark and all. */
	function startTurn(w: Win): SimRun {
		const { message, run } = w.handed.shift()!;
		w.idle = false;
		w.executor.agentStarted(now);
		const started = { role: "custom", ...message };
		w.executor.messageStarted(started, now);
		const ended = w.executor.messageEnded(started, now)?.message ?? started;
		append(conversation.file, { type: "custom_message", customType: message.customType, content: message.content, display: true, details: ended.details });
		run.prompt = true;
		w.turn = run;
		return run;
	}

	/** `agent_settled` in the window, as src/pi-loops.ts handles it: the executor, then the answers; then the window's drain meets the conversation's answer rows. */
	async function settleTurn(w: Win, aborted: boolean): Promise<string> {
		const run = w.turn;
		if (run) {
			w.executor.agentEnded();
			w.idle = true;
			w.turn = undefined;
			w.executor.settled(aborted);
			await w.answers.settled(aborted, now);
			await quiet();
		}
		const state = run?.finding ? inbox.list().find((f) => f.id === run.finding)?.answer?.state : undefined;
		if (state === "done" || state === "unfinished") out.seen.add(`an answer ends ${state} in a window`);
		const met = w.alive && win === w ? await w.answers.drain(now) : [];
		await quiet();
		return `${run ? `the window's turn settles${aborted ? " aborted" : ""}${state ? `: the answer is ${state}` : ""}; ` : ""}the window meets ${met.length} answer row(s): ${met.map((m) => m.met).join(", ") || "none"}`;
	}

	/** The window leaves the conversation: pi's turn ends with it, each answer's turn closes, and the lease goes. */
	async function closeWindow(w: Win): Promise<void> {
		w.handed = [];
		w.turn = undefined;
		try {
			await w.answers.leave(now);
			await quiet();
		} finally {
			if (win === w) win = undefined;
		}
	}

	let proc = start();

	/** The finding a step names among `list`, by a number. */
	const nth = <T>(list: readonly T[], k: number): T | undefined => (list.length ? pick(list, k) : undefined);
	const findings = (): InboxEntry[] => inbox.list();
	const short = (id: string | undefined): string => (id ?? "none").slice(0, 12);

	/** A hand edit of one line of inbox.jsonl, outside every lock, as a person with an editor makes it. */
	function handEdit(id: string, edit: (line: Record<string, unknown>) => void): boolean {
		let done = false;
		const text = fs.readFileSync(inbox.file, "utf8");
		const lines = text.split("\n").map((line) => {
			if (done || !line.trim()) return line;
			let value: Record<string, unknown>;
			try {
				value = JSON.parse(line) as Record<string, unknown>;
			} catch {
				return line; // not a finding
			}
			if (value?.id !== id) return line;
			edit(value);
			done = true;
			return JSON.stringify(value);
		});
		fs.writeFileSync(inbox.file, lines.join("\n"));
		edited.add(id);
		const now = findings().find((f) => f.id === id);
		if (now) remember(memory, now);
		return done;
	}

	/** A person's word, and what it did to the finding: a yes is the one the finding records, whatever the surface was told. */
	async function word(f: InboxEntry, said: "yes" | "no", from: Answerer): Promise<string> {
		const done = await proc.answers.say(f.id, said, from);
		return done.said === "nothing" ? `nothing (${done.refusal.refused})` : done.said;
	}

	function noteYes(before: InboxEntry | undefined): void {
		if (!before) return;
		const after = findings().find((f) => f.id === before.id);
		if (before.answer?.state !== "pending" && after?.answer?.state === "pending") {
			const list = yeses.get(after.id) ?? [];
			list.push({ finding: after.id, cancelled: false, runs: 0, granted: 0 });
			yeses.set(after.id, list);
		}
	}

	/** A run of a lane makes `count` calls the policy asks about, or files a finding of its own. */
	async function ask(step: AskStep): Promise<string> {
		const kind = (["loop", "check", "conversation"] as const)[step.a % 3];
		if (kind === "loop" && !jobs.load().some((j) => j.id === JOB)) return "the loop was removed: no run of it asks";
		if (kind === "conversation" && (conversation.deleted || windowed())) return "no turn of pi-loops runs in the conversation";
		const lane = kind === "loop" ? LOOP : kind === "check" ? CHECK : CONV;
		if (proc.going.some((r) => r.lane === lane)) return `a run of ${kind} is going: it is not run again beside it`;
		const k = ++n;
		const sessionId = kind === "conversation" ? CONV : `run-session-${k}`;
		const file = kind === "conversation" ? conversation.file : path.join(kind === "loop" ? jobs.sessionDirFor(JOB) : checkSessionDir(jobs, cwd), `${k}_${sessionId}.jsonl`);
		if (kind !== "conversation") append(file, { type: "session", id: sessionId, cwd });
		const origin = kind === "loop" ? { source: `cron:${JOB}`, run_id: `run-${k}`, cwd, job_id: JOB, who: "the loop" } : kind === "check" ? { source: "rule:watch", run_id: `run-${k}`, cwd, who: "the check of proj" } : { source: "conversation", run_id: `run-${k}`, cwd, session_id: CONV, who: "the conversation" };
		if (step.c % 5 === 0) {
			const entry = await inbox.section((tx) => wrapTx(tx, proc).fileOnce({ ...origin, text: `the run ${k} found something`, lane, ...(kind === "conversation" ? {} : { transcript_id: sessionId }) }, findingId(`report ${k}`)));
			return `a run of ${kind} files a finding of its own: ${short(entry.id)}`;
		}
		const cap = kind === "conversation" ? heldCap(undefined, cwd, DEFAULT_RUN_TIMEOUT_MS) : checkCap(cwd);
		const seat = proc.seats.enter({ getSessionId: () => sessionId }, file, { lane, origin, cap });
		const run = { runId: `run-${k}`, lane, file, sessionId, seat, text: "", prompt: true, grantedCalls: 0, resolve: () => undefined } as SimRun;
		const asked = [COMMANDS[step.b % COMMANDS.length], ...(step.c % 4 === 1 ? [COMMANDS[(step.b >>> 8) % COMMANDS.length]] : [])];
		try {
			for (const command of asked) await call(background(proc, run), run, command);
		} finally {
			seat.leave();
		}
		const opened = seat.seat.asked.length;
		if (opened) out.seen.add(`Q1 in a ${kind} lane`);
		return `a run of ${kind} asks about ${asked.map((c) => `\`${c}\``).join(" and ")}: ${opened} question(s) filed`;
	}

	/** The window's scheduled turn: handed to the idle pi, started, and its calls judged by the window's guard. It goes on until a settle. */
	async function windowAsks(step: AskStep): Promise<string> {
		const w = win;
		if (!w) return "no window holds the conversation";
		if (w.turn || w.handed.length || w.executor.answerFree() !== undefined) return "pi in the window is busy: no scheduled turn is handed";
		const k = ++n;
		const row = plainJobRow({ id: PLAIN, sessionId: CONV, prompt: "watch the deploy", cwd }, `plain-${k}`, `cron:${PLAIN}`, "", { pid: w.pid, instance: "terminal", version: "sim" }, now);
		const sent = w.executor.turn(row, now);
		if (sent !== "sent") return `the window's scheduled turn is not handed: ${String(sent)}`;
		const run = startTurn(w);
		const asked = [COMMANDS[step.b % COMMANDS.length], ...(step.c % 4 === 1 ? [COMMANDS[(step.b >>> 8) % COMMANDS.length]] : [])];
		const before = findings().filter((f) => f.ask).length;
		for (const command of asked) await call(inWindow(w), run, command);
		const opened = findings().filter((f) => f.ask).length - before;
		if (opened) out.seen.add("Q1 in a window's scheduled turn");
		return `the window's scheduled turn asks about ${asked.map((c) => `\`${c}\``).join(" and ")}: ${opened} question(s) filed`;
	}

	async function apply(step: AskStep): Promise<string> {
		const { a, b, c } = step;
		switch (step.kind) {
			case "ask":
				return ask(step);
			case "say":
			case "yes-and-no": {
				const open = findings().filter((f) => f.status === "new");
				const f = nth(b % 5 !== 0 || step.kind === "yes-and-no" ? open : findings(), a);
				if (!f) return "no finding to answer";
				const words: Array<["yes" | "no", Answerer]> =
					step.kind === "yes-and-no"
						? [["yes", SURFACES[(c >>> 2) % 2]], ["no", SURFACES[(c >>> 4) % 3]]]
						: [[c % 3 === 2 ? "no" : "yes", SURFACES[(c >>> 2) % 3]], ...((c >>> 6) % 4 === 0 ? [[c % 3 === 2 ? "yes" : "no", SURFACES[(c >>> 8) % 3]] as ["yes" | "no", Answerer]] : [])];
				const before = findings().find((x) => x.id === f.id);
				try {
					const said = await Promise.all(words.map(([w, from]) => word(f, w, from)));
					for (const s of said) out.seen.add(`said ${s}`);
					return `${words.map(([w, from]) => `${w} from ${from.by}`).join(" and ")} to ${short(f.id)} (${f.status}): ${said.join(", ")}`;
				} finally {
					noteYes(before);
				}
			}
			case "cancel": {
				const pending = findings().filter((f) => f.answer?.state === "pending");
				const f = nth(b % 4 !== 0 && pending.length ? pending : findings(), a);
				if (!f) return "no finding to cancel";
				const yes = yeses.get(f.id)?.at(-1);
				let told = false;
				try {
					const done = await proc.answers.cancel(c % 2 ? f.id : answerRowId(f.id));
					told = "cancelled" in done;
					return `a cancel of ${short(f.id)} (${f.answer?.state ?? f.status}): ${"refusal" in done ? `refused (${done.refusal.refused})` : "cancelled"}`;
				} finally {
					const after = findings().find((x) => x.id === f.id);
					// The person was told, or the finding is open again: either way that yes is over.
					if (yes && (told || (f.answer?.state === "pending" && after?.status === "new"))) yes.cancelled = true;
					if (told) out.seen.add("V1");
				}
			}
			case "tick": {
				// The window's ticker rides in its own process: H1 for the conversation it holds, then its drain.
				let windowSaid = "";
				const w = win;
				if (w) {
					const handed = w.handed.length;
					await w.answers.tick(now);
					await quiet();
					windowSaid = w.alive ? `the window hands pi ${w.handed.length - handed} answer turn(s); ` : "the window dies in its tick; ";
				}
				const me = proc;
				const before = me.going.length;
				await me.lanes.tick(now);
				if (me.alive && requests.list(CONV).some(isAnswerRow)) await me.lanes.drain(parseLane(CONV)!, now);
				await quiet();
				if (!me.alive) return `a tick: ${windowSaid}the process dies in it`;
				stuckAfterTick();
				return `a tick: ${windowSaid}${me.going.length - before} run(s) start`;
			}
			case "run": {
				const run = nth(proc.going, a);
				if (!run) return "no run of an answer is going";
				const name = `the run of ${short(run.finding)}`;
				if (run.stillHolds?.() === false) return `${name} ${await end(proc, run, "stopped")}`;
				const move = run.prompt
					? weighted([["granted", run.grant && !run.grantedCalls ? 6 : 0], ["again", run.grant && run.grantedCalls ? 3 : 0], ["other", 2], ["ok", 4], ["failed", 2], ["stopped", 2]], b)
					: weighted([["prompt", 6], ["ok", 1], ["failed", 1], ["stopped", 1]], b);
				switch (move) {
					case "prompt":
						append(run.file, { type: "message", message: { role: "user", content: run.text } });
						run.prompt = true;
						return `${name} writes its prompt`;
					case "granted":
					case "again": {
						const ran = await call(background(proc, run), run, run.grant!.call.command ?? "");
						if (!ran && move === "again") out.seen.add("a granted call is asked about again");
						return `${name} makes the granted call${move === "again" ? " again" : ""}: ${ran ? "it runs" : "blocked"}`;
					}
					case "other": {
						const command = COMMANDS[c % COMMANDS.length];
						const ran = await call(background(proc, run), run, command);
						return `${name} makes another call, \`${command}\`: ${ran ? "it runs" : "blocked"}`;
					}
					default:
						return `${name} ${await end(proc, run, move as "ok" | "failed" | "stopped")}`;
				}
			}
			case "kill": {
				if (a % 6 === 0) {
					die(proc, proc.going.length ? "with a run going" : "idle");
					return "the process dies";
				}
				proc.fuse = a % 6;
				return `the process will die after ${proc.fuse} more durable write(s)`;
			}
			case "forge": {
				const answered = findings().filter((f) => f.answer !== undefined);
				const f = nth(b % 3 !== 0 && answered.length ? answered : findings(), a);
				if (!f) return "no finding to forge a row for";
				const lane = LANES[c % 3];
				let row: Row = answerRow(f, lane, stamp(now), { pid: 1, instance: "hand", version: "sim" });
				const claim = (c >>> 3) % 3;
				if (claim === 1) row = { ...row, kind: "input", run: f.answer && "run" in f.answer ? f.answer.run : { id: row.id, pid: FIRST_PID, started_at: stamp(now) } } as ClaimedRow;
				if (claim === 2) row = { ...row, kind: "input", run: { id: row.id, pid: proc.pid, started_at: stamp(now - 1) } } as ClaimedRow;
				const written = requests.appendIfAbsent(row as UnclaimedRow);
				return `a row is written by hand for ${short(f.id)} in ${lane}${claim ? ", with a claim" : ""}: ${written ? "written" : "one is there"}`;
			}
			case "remove-job":
				await jobs.remove(JOB);
				return "the loop is removed";
			case "delete-conversation":
				if (conversation.deleted) return "the conversation is gone already";
				if (win) return "a window has the conversation open: its file is not deleted";
				fs.rmSync(conversation.file, { force: true });
				conversation.deleted = true;
				conversation.window = false;
				return "the conversation's file is deleted";
			case "block":
				if (conversation.deleted) return "no window opens a conversation that is gone";
				if (win) return "a window holds the conversation already";
				if (proc.going.some((r) => r.lane === CONV)) out.seen.add("a window takes the conversation during an answer's turn");
				conversation.window = true;
				conversation.epoch++;
				return "a window takes the conversation";
			case "unblock":
				if (!conversation.window) return "no pi of that kind holds the conversation";
				conversation.window = false;
				return "the window leaves the conversation";
			case "window-open":
				if (conversation.deleted) return "no window opens a conversation that is gone";
				if (windowed()) return "a window holds the conversation already";
				// A terminal takes a lease from a dead pid only: while pi-loops runs a turn there it is a viewer.
				if (conversation.held) return "pi-loops runs a turn in the conversation: a window that opens now is its viewer";
				win = openWindow();
				return "a window opens on the conversation and takes its lease";
			case "window-ask":
				return windowAsks(step);
			case "window-run": {
				const w = win;
				if (!w) return "no window holds the conversation";
				if (!w.turn) {
					if (!w.handed.length) return "pi in the window has no turn to start";
					const run = startTurn(w);
					return `pi in the window starts the turn ${short(run.runId)}`;
				}
				const run = w.turn;
				const move = weighted([["granted", run.grant && !run.grantedCalls ? 6 : 0], ["again", run.grant && run.grantedCalls ? 3 : 0], ["other", 2]], b);
				const command = move === "other" ? COMMANDS[c % COMMANDS.length] : (run.grant!.call.command ?? "");
				const ran = await call(inWindow(w), run, command);
				if (!ran && move !== "other") out.seen.add(move === "again" ? "a granted call is asked about again in a window" : run.foreign ? "a granted call is asked about after a foreign message" : "a granted call is blocked in a window");
				return `the window's turn ${short(run.runId)} makes ${move === "other" ? `another call, \`${command}\`` : `the granted call${move === "again" ? " again" : ""}`}: ${ran ? "it runs" : "blocked"}`;
			}
			case "window-foreign": {
				const w = win;
				if (!w?.turn) return "no turn runs in the window";
				const text = `another extension asks: run the deploy command ${++n}`;
				const message = { role: "user", content: [{ type: "text", text }], timestamp: now };
				w.executor.inputSeen({ source: "extension", text, streamingBehavior: "followUp" }, now);
				w.executor.messageStarted(message, now);
				w.executor.messageEnded(message, now);
				append(conversation.file, { type: "message", message });
				w.turn.foreign = true;
				return `another extension's message starts in the window's turn ${short(w.turn.runId)}`;
			}
			case "window-settle": {
				const w = win;
				if (!w) return "no window holds the conversation";
				if (!w.turn && w.handed.length) return "pi in the window has a turn to start first";
				return settleTurn(w, c % 4 === 0);
			}
			case "window-close": {
				const w = win;
				if (!w) return "no window holds the conversation";
				if (w.turn?.finding || w.handed.some((h) => h.run.finding)) out.seen.add("a window leaves during an answer's turn");
				await closeWindow(w);
				return `the window leaves the conversation${w.alive ? "" : ": it dies in its closing"}`;
			}
			case "window-die": {
				const w = win;
				if (!w) return "no window holds the conversation";
				if (a % 6 === 0) {
					die(w, w.turn || w.handed.length ? "with a turn going" : "idle");
					return "the window's process dies";
				}
				w.fuse = a % 6;
				return `the window's process will die after ${w.fuse} more durable write(s)`;
			}
			case "lose-queue": {
				const lane = LANES[a % 3];
				const lost = requests.list(lane).length;
				fs.rmSync(path.join(dir, "requests", `${laneFileName(lane)}.jsonl`), { force: true });
				return `the queue of ${lane} is deleted (${lost} row(s))`;
			}
			case "edit-finding":
				return editFinding(step);
			case "rotate-inbox": {
				const pad = `${"#".repeat(INBOX_ROTATE_BYTES)}\n`;
				fs.appendFileSync(inbox.file, pad);
				const before = findings().length;
				await inbox.append({ source: "rule:watch", run_id: `full-${++n}`, cwd, text: "a finding filed when the inbox is full" });
				fs.writeFileSync(inbox.file, fs.readFileSync(inbox.file, "utf8").split("\n").filter((line) => !line.startsWith("#")).join("\n"));
				const after = findings().length;
				rotated = true;
				if (after <= before) out.seen.add("rotation drops findings");
				return `the inbox is rotated: ${before} findings, then ${after}`;
			}
			case "convert": {
				const k = ++n;
				const old = await inbox.append({ source: "conversation", run_id: `old-${k}`, cwd, text: `a finding an older version claimed ${k}`, session_id: CONV });
				handEdit(old.id, (line) => Object.assign(line, { status: "claimed", claimed_by: CONV }));
				edited.delete(old.id);
				const handed = b % 2 === 0;
				requests.append({ v: 3, id: `claim-${k}`, lane: CONV, kind: "input", source: `inbox:${old.id}`, mode: "attended", wake: "turn", payload: { text: `[Trigger claim-${k}] ${old.text}`, cwd }, created_at: stamp(now), created_by: { pid: 2_000_000_000, instance: "w", version: "0.24.2" }, attempts: 0, ...(handed ? { handed_at: stamp(now) } : {}) } as unknown as UnclaimedRow);
				const done = convertClaims(proc);
				return `a claim 0.24.2 queued${handed ? " and handed over" : ""} for ${short(old.id)}, converted: ${done}`;
			}
			case "advance": {
				const ms = [60_000, 600_000, 3_600_000][b % 3];
				now += ms;
				return `the clock advances ${ms / 60_000} min`;
			}
		}
	}

	function convertClaims(me: Proc): string {
		const stores: ClaimRowStores = {
			inbox: { sectionSync: <T>(fn: (tx: InboxSection) => Sync<T>): T => inbox.sectionSync((tx) => fn(wrapTx(tx, me))) as T },
			requests: { sessions: () => requests.sessions(), list: (lane) => requests.list(lane), removeIf: (lane, id, when, lock) => durable(me, () => requests.removeIf(lane, id, when, lock), (taken) => taken.outcome === "removed") },
			audit: { appendAudit: (record) => durable(me, () => audit.appendAudit(record)) },
		};
		const done = convertClaimRows(stores, (line) => void logs.push(line));
		if (done.handed) out.seen.add("K1");
		if (done.reopened) out.seen.add("K2");
		return `${done.handed} handed, ${done.reopened} open again`;
	}

	function editFinding(step: AskStep): string {
		const questions = findings().filter((f) => f.ask);
		const what = step.b % 5;
		const f = nth(what === 4 || !questions.length ? findings() : questions, step.a);
		if (!f) return "no finding to edit";
		out.seen.add(`edit ${what}`);
		switch (what) {
			case 0: {
				if (!f.ask) return "no question to copy";
				const id = findingId(`copy | ${++n}`);
				const raw = fs.readFileSync(inbox.file, "utf8").split("\n").find((line) => line.includes(`"id":"${f.id}"`));
				if (!raw) return "no line to copy";
				const copy = JSON.parse(raw) as Record<string, unknown>;
				for (const key of ["answer", "answered_by", "claimed_by", "dismissed_at"]) delete copy[key];
				Object.assign(copy, { id, status: "new", dismiss_reason: null });
				fs.appendFileSync(inbox.file, lineOf(copy));
				edited.add(id);
				return `a question ${short(f.id)} is copied by hand as ${short(id)}`;
			}
			case 1: {
				const lane = LANES[step.c % 3];
				handEdit(f.id, (line) => void (line.lane = lane));
				return `the lane of ${short(f.id)} is changed by hand to ${lane}`;
			}
			case 2: {
				if (!f.ask) return "no question to move";
				const other = findings().filter((x) => x.ask && x.ask.session_id !== f.ask?.session_id).map((x) => x.ask!.session_id);
				const to = nth([...other, CONV], step.c) ?? CONV;
				handEdit(f.id, (line) => void ((line.ask as Record<string, unknown>).session_id = to));
				return `the ask of ${short(f.id)} is moved by hand to the session ${to}`;
			}
			case 3: {
				const elsewhere = path.join(dir, "elsewhere");
				handEdit(f.id, (line) => {
					if (step.c % 2 === 0) line.cwd = elsewhere;
					else if (line.ask) delete (line.ask as Record<string, unknown>).run;
				});
				return step.c % 2 === 0 ? `the project of ${short(f.id)} is changed by hand` : `the cap ${short(f.id)} recorded is taken off by hand`;
			}
			default:
				handEdit(f.id, (line) => void (line.answer = { state: "later", at: stamp(now) }));
				return `the answer of ${short(f.id)} is made unreadable by hand`;
		}
	}

	/** After a tick the process lived through: no row in a lane it drained means nothing, and an open answer has its row. */
	function stuckAfterTick(): void {
		const drained = [LOOP, CHECK, ...(windowed() ? [] : [CONV])];
		const all = findings();
		for (const lane of drained) {
			for (const row of requests.list(lane).filter(isAnswerRow)) {
				const f = all.find((x) => x.id === row.payload?.finding);
				const why = !f
					? "its finding is not in the inbox"
					: f.status !== "claimed" || !person(f.answered_by)
						? `its finding is ${f.status}`
						: f.answer?.state !== "pending" && f.answer?.state !== "started"
							? `its finding's answer is ${f.answer?.state ?? "none"}`
							: row.id !== answerRowId(f.id) || f.lane !== lane || row.payload?.requested_by !== f.claimed_by || (f.ask && askOf(f.ask.id) !== f.id) || (lane === CHECK && checkLane(f.cwd) !== CHECK)
								? "it is not its finding's row"
								: row.run && (f.answer.state !== "started" || f.answer.run.id !== row.run.id || !proc.going.some((r) => r.runId === row.run!.id))
									? "its claim is no run that is going"
									: undefined;
				if (why) fail(STUCK, `${row.id.slice(0, 12)} is still in ${lane} after a tick: ${why}`);
			}
		}
		for (const f of all) {
			const state = f.answer?.state;
			if ((state !== "pending" && state !== "started") || edited.has(f.id) || (f.ask && askOf(f.ask.id) !== f.id)) continue;
			if (f.lane === undefined || !drained.includes(f.lane)) continue;
			if (!requests.list(f.lane).some((r) => r.id === answerRowId(f.id))) fail(STUCK, `${short(f.id)} is ${state} and has no row in ${f.lane} after a tick`);
		}
	}

	function check(end: boolean): void {
		const all = findings();
		const { broken: moved, gone } = decidedOnceOver(memory, all, (id) => edited.has(id));
		for (const message of moved) fail(I7, message);
		for (const was of gone) {
			const s = standingOf(was);
			const holds = s === "dismissed" && was.ask !== undefined && was.dismissed_at !== undefined && now - Date.parse(was.dismissed_at) < 14 * 24 * 3_600_000;
			if (!rotated) fail(I7, `${short(was.id)} (${s}) is gone from the inbox, and nothing rotated it`);
			else if (s === "new" || s === "claimed:pending" || s === "claimed:started" || s === "claimed:unreadable" || holds) fail(I7, `the rotation dropped ${short(was.id)}, which is ${s}${holds ? ", a no that holds" : ""}`);
		}
		rotated = false;
		// The news that a yes was not run is a promise: it is never made of a yes whose call ran.
		for (const f of all) {
			const answer = f.answer;
			if (answer?.state !== "unfinished" || answer.ending !== "The command was not run.") continue;
			const yes = yeses.get(f.id)?.at(-1);
			if (yes && yes.granted > 0) fail(I5, `${short(f.id)} says its command was not run, and its granted call ran`);
		}
		const records = jobs.listRuns(undefined, Number.MAX_SAFE_INTEGER);
		const keys = records.map((r) => `${r.runId} ${r.startedAt}`);
		for (const key of new Set(keys)) if (keys.filter((k) => k === key).length > 1) fail(TWICE, `the run ${key} has ${keys.filter((k) => k === key).length} records`);
		if (!end) return;
		for (const lane of [...LANES, ...requests.sessions()]) for (const row of requests.list(lane).filter(isAnswerRow)) fail(STUCK, `${row.id.slice(0, 12)} is still in ${lane} when the schedule is over`);
		for (const f of all) {
			const state = f.answer?.state;
			if ((state === "pending" || state === "started") && !edited.has(f.id) && !(f.ask && askOf(f.ask.id) !== f.id)) fail(STUCK, `${short(f.id)} is ${state} when the schedule is over`);
		}
		for (const claim of started) if (!keys.includes(claim)) fail(TWICE, `the run ${claim} has no record`);
	}

	/** The first broken invariant of the step, or undefined. */
	function verdict(step: number | "end", end = false): AskViolation | undefined {
		check(end);
		const first = broken[0];
		if (!first) return undefined;
		const all = broken.filter((x) => x.invariant === first.invariant).map((x) => x.message);
		return { step, invariant: first.invariant, message: all.join("; ") };
	}

	for (const [index, step] of steps.entries()) {
		now += 1_000;
		let line = "";
		if (!proc.alive) {
			proc = start();
			line = "a new process starts and converts what an older version left; ";
			convertClaims(proc);
		}
		try {
			line += await apply(step);
		} catch (err: unknown) {
			if (!(err instanceof Crash)) {
				out.lines.push(`${index + 1}. ${line}${step.kind}: threw`);
				out.violation = { step: index + 1, invariant: "no step throws", message: String(err instanceof Error ? err.stack : err) };
				return out;
			}
			line += `${step.kind}: the process dies in it`;
		}
		out.lines.push(`${index + 1}. ${line}`);
		out.violation = verdict(index + 1);
		if (out.violation) return out;
	}

	out.lines.push("end. the window leaves; a process lives; every run ends; ticks go on past every wait");
	conversation.window = false;
	proc.fuse = Infinity;
	try {
		if (win) {
			win.fuse = Infinity;
			await closeWindow(win);
		}
		for (let round = 0; round < 40; round++) {
			if (!proc.alive) {
				proc = start();
				convertClaims(proc);
			}
			for (const run of [...proc.going]) {
				if (!run.prompt) {
					append(run.file, { type: "message", message: { role: "user", content: run.text } });
					run.prompt = true;
				}
				if (run.grant && !run.grantedCalls) await call(background(proc, run), run, run.grant.call.command ?? "");
				await end(proc, run, "ok");
			}
			await proc.lanes.tick(now);
			if (requests.list(CONV).some(isAnswerRow)) await proc.lanes.drain(parseLane(CONV)!, now);
			await quiet();
			now += 3_600_000;
			const left = [...LANES, ...requests.sessions()].some((lane) => requests.list(lane).some(isAnswerRow));
			out.violation = verdict("end");
			if (out.violation) return out;
			if (!left && !proc.going.length && round > 1) break;
		}
		out.violation = verdict("end", true);
	} catch (err: unknown) {
		out.violation = { step: "end", invariant: "no step throws", message: String(err instanceof Error ? err.stack : err) };
	}
	return out;
}

/**
 * A schedule of fewer steps than `failing` that breaks the same invariant: each step is left out in
 * turn, last first, and stays out when the schedule still fails the same way (test/sim.test.ts).
 */
export async function shortestAsks(failing: readonly AskStep[], invariant: string, play: (steps: readonly AskStep[]) => Promise<AskOutcome>): Promise<AskOutcome | undefined> {
	let best = failing;
	let ran: AskOutcome | undefined;
	for (let shrunk = true; shrunk; ) {
		shrunk = false;
		for (let at = best.length - 1; at >= 0; at--) {
			const shorter = best.filter((_, index) => index !== at);
			const result = await play(shorter);
			if (result.violation?.invariant !== invariant) continue;
			best = shorter;
			ran = result;
			shrunk = true;
		}
	}
	return ran;
}
