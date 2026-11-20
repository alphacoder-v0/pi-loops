/**
 * The world a simulated schedule runs in. Real: `drain`, `decideDrain` and `bury` (src/engine.ts),
 * the `RequestStore`, the `Inbox`, the audit file and every window's `WindowExecutor`, on one
 * temporary directory. Simulated: the clock, the processes, the lease, the conversation and pi.
 *
 * What the simulated pi does:
 * - It is idle, or it runs one turn. A message handed to it while idle waits in its queue, and pi
 *   still says it is idle (the phase before a run: input handlers, the credential check), until the
 *   schedule has it start the turn, or refuse the message without a word, as `prompt()` does when it
 *   throws before any run. Only a user message is refused so: a custom message that asks for a turn
 *   always gets its run (probe S2 of the structural review). For one sent from a timer pi says it is
 *   busy at once; for one sent from an `agent_settled` handler it says idle until the handler returns
 *   (P17). The world keeps to the second, where only the window's own record holds the lane.
 * - A turn row of ours reaches pi as a custom message (`pi-loops:turn`), with its row and its cap in
 *   its details (P8, P12 to P17): no `input` event comes for it, no extension rewrites it, its
 *   `message_start` carries the details, and `hasPendingMessages()` never counts it. The one row
 *   that reaches pi as a user message is a person row the page's pi was rung for.
 * - After each message that a turn row's custom message started, and again before the next message
 *   or the settle, the world asks the window whose turn it is, as a `tool_call` in that turn would
 *   (`Facts.toolCalls`). It asks the same after another extension's user message that pi writes
 *   behind such a turn, with no message of the person between the two: that message must not carry
 *   the scheduled turn on under the person's cap.
 * - A turn starts (`agent_start`), writes the message it began with (`message_start`, then the
 *   entry) and settles (`agent_end`, `agent_settled`). What it was handed meanwhile is written as
 *   follow-ups when it settles. What a stop does depends on the window's mode, which the seed
 *   draws. In a terminal (`tui`), Esc and `ctx.abort()` are the interactive mode's abort handler:
 *   it clears pi's queues, puts the queued texts of user messages into the editor, then aborts.
 *   The editor is one text: the queued texts as pi held them (after another extension's `input`
 *   handler, where there is one), before what was there (measured with words the person had
 *   typed; that what was there came from an earlier stop was not), and the person can type more
 *   behind them. Enter sends all of it as one message. In the page's pi (`rpc`) the page's Stop
 *   and `ctx.abort()` are `AgentSession.abort()`, which ends the turn and leaves what is queued behind it: pi is idle
 *   and still holds it, and starts no run for it. The next run starts with a message handed over
 *   or typed after the stop, and writes what pi kept behind that message. (Measured on pi 1.2.0:
 *   .docs/redesign-0243/signatures/M3b-probes.md, P2, P3 and G1 to G4.) A stop need not come from
 *   the person: the window asks for `ctx.abort()` as a message starts whose row a stop named, and
 *   when that message is a follow-up, pi writes it and stops there, with what waits behind it
 *   kept or put into the editor as after any stop. test/sim-model.test.ts holds these to the
 *   measurements, scene by scene.
 * - Pi emits `message_start` and `message_end` for a custom message as for a user message, with the
 *   custom type and the details it was sent with.
 * - Before pi persists a message it asks the window (`message_end`), which may give another
 *   message of the same role: what a window writes into the entry is in the entry.
 * - A custom message with no turn asked for is written at once.
 * - The person types into the window: a turn of their own, in words no row has. In the page they
 *   can also send a message straight to pi while a turn runs (`typeBehind`): a follow-up with no
 *   row, which the page's Stop keeps as it keeps ours (probe g9). In a terminal, Enter during a
 *   run steers (`steer`, probe g13): pi writes the message right after the current turn, behind
 *   the steers before it and before the follow-ups (g16), and Esc puts it first into the editor, as
 *   the person's words. With text in the editor, the steer is that whole text and the editor is
 *   empty (g16): a prompt of ours a stop put there goes out again, by the person.
 * - Another extension sends a user message of its own (`otherSends`): a follow-up during a run
 *   (P6), the first message of a run when pi is idle (g11, g14). The window is told of the input
 *   and not of a person's submission. Sent with no `deliverAs` during a run (`otherRejected`, g11),
 *   pi refuses it after the input: the window is told of an input, and no message comes.
 * - The page clears the queue (`clearQueue`; P10 after a stop, g12 during a run): a cancel for every
 *   input row, then the page's pi's queue is emptied, custom messages too, and no extension is told.
 * - A hand-over can throw (no model, no credentials).
 *
 * What it does not do:
 * - A conversation is one list of entries, durable the moment an entry is written, and every process
 *   sees it at once. A real second pi reads its own copy, which can be behind the file, so nothing
 *   here speaks for what a process does with a write it has not read (a crash between pi's write
 *   and the removal, then another window: src/engine.ts `releaseLocalRows`).
 * - No model, no tools, no compaction, no images, no MCP server. In one world of four another
 *   extension's `input` handler puts words before every user message (`World.rewrites`), as pi lets
 *   one (probes, P4). No window leaves a conversation and lives on
 *   (`created_by.left`), stands aside or runs `pi -p`, so `holderDelivers` is never false.
 * - The lease is a field, not src/lease.ts. It moves as the real one does: from a dead holder to any
 *   live process, from the background process to a window, and between two live windows only from
 *   the page's pi to a terminal, while the holder's pi runs no turn.
 * - The page never dies and never takes a message back.
 * - A crash is a process that stops before one of the engine's writes. A write is whole or absent,
 *   as the store's atomic writes are; a torn line is not simulated.
 * - A step is whole. Inside a drain, another process acts only between two of the drain's rows (it
 *   takes the lease, or its pi writes: `Fault`), and the draining window's own pi does not move, not
 *   even while the drain waits on the inbox for a dead letter.
 * - Time is the schedule's: `Date` and `setTimeout` are node:test's mocks, and nothing waits. In
 *   half the worlds the clock stands still inside a step, so a stamp and a message of one step are
 *   of one millisecond; in the other half every message pi writes takes a millisecond, as a real
 *   one takes time (`World.ticks`).
 */
import { CEILING, type DrainResult, type EngineSinks, type Executor, bury, proofOf, drain } from "../../src/engine.ts";
import { Inbox } from "../../src/inbox.ts";
import { RequestStore, type Row } from "../../src/requests.ts";
import { TriggerStore } from "../../src/triggers.ts";
import type { LeaseBinding } from "../../src/lease.ts";
import { TURN_TYPE, markDetails, markFor, markOn } from "../../src/mark.ts";
import { WindowExecutor } from "../../src/window-executor.ts";

/** Where every schedule's clock starts. In the past: src/lock.ts compares the clock with a lock directory's real mtime, and a simulated now ahead of it would call every lock stale. */
export const EPOCH = Date.parse("2026-01-01T00:00:00Z");
/** The page's process, which writes the person's messages and lives for the whole schedule. */
export const PAGE_PID = 4242;
/** How long `Inbox.decide` sleeps at most when it finds the inbox locked (src/lock.ts), in simulated time. */
const LOCK_WAIT_MS = 60;
/** What the other extension of a rewriting world puts before every user message. */
export const REWRITTEN = "[rewritten] ";
/** How long pi may leave a turn unstarted before a tick may call it refused (docs/design.md), stated apart from the engine's constant on purpose. */
const GRACE_MS = 10_000;

/** node:test's mocked clock, as much of it as the world drives. */
export interface Timers {
	setTime(ms: number): void;
	tick(ms: number): void;
}

/** A user message, as pi hands it to `message_end` and persists what comes back: a window may have put fields of its own on it. */
type UserMessage = { role: "user"; content: Array<{ type: "text"; text: string }> } & Record<string, unknown>;
type Entry = { type: "message"; timestamp: string; message: UserMessage } | { type: "custom_message"; timestamp: string; content: string; details?: unknown };

/**
 * One hand-over, as the simulated pi knows it: which row, to which process, and what became of it.
 * `held` while pi has it unwritten; then `written`, `dropped` (a stop in a terminal), `refused`
 * (pi threw before a run) or `died` (its process was killed).
 */
export interface Copy {
	rowId: string;
	/** The row's source: what decides the mode of its turn. */
	source: string;
	sessionId: string;
	/** The process whose pi was handed it. */
	process: Process;
	text: string;
	wake: "turn" | "append";
	/** It went to pi as a custom message, with its row in its details. */
	custom: boolean;
	/** It went to pi as a user message (the person's own page message): only its words tell the window which message is its own. And whether it is a person's message. */
	provedByText: boolean;
	person: boolean;
	handedAt: number;
	state: "held" | "written" | "dropped" | "refused" | "died";
	/** When pi took it up, or let it go: until then it sat unstarted. */
	leftQueueAt?: number;
	writtenAt?: number;
	/**
	 * Why the engine stopped waiting for it while pi still held it: a tick judged the hand-over
	 * refused (`refused`); pi kept it queued behind a turn a stop aborted, and the window took it for
	 * dropped (`stop`); the lease went to another process (`lease`). A write after that is a late send.
	 */
	gaveUp?: "refused" | "stop" | "lease";
	/** A stop named the row while pi held this turn unstarted: pi is to abort it as it starts. */
	stopNamed?: boolean;
	/** `ctx.abort()` was called as pi began this message. */
	abortedAtStart?: boolean;
	/** The row whose mark pi's entry of this copy carries, when it carries one. */
	markedAs?: string;
	/**
	 * A person's own page message written with no mark: another extension changed its words, and the
	 * window did not know it by them. The row goes back to the page, once.
	 */
	markLess?: true;
	/** A stop in a terminal put this hand-over's text into the editor, and the person sent it: written by them, not by pi's queue. */
	fromTheEditor?: boolean;
}

interface Item {
	text: string;
	custom: boolean;
	/** A custom message's type, as it was sent. */
	customType?: string;
	copy?: Copy;
	/** The details a custom message was sent with: pi persists them in its entry (probe P8). */
	details?: unknown;
	/** The person's own words (a steer): a stop in a terminal puts them into the editor as theirs. */
	person?: true;
	/** Another extension's user message. */
	extension?: true;
	/** A steer sent with text in the editor: it is that whole text, and the editor it was (probe g16). */
	editor?: Editor;
}

export interface Pi {
	running: boolean;
	/** The message the running turn began with, until pi writes it. */
	current?: Item;
	/** Handed over and not taken up: prompts before a run while idle, follow-ups while a turn runs. */
	queue: Item[];
	/** How often `ctx.abort()` was called in the running turn: once is enough to end it with its follow-ups still queued. */
	aborts: number;
	/** When the running turn started, and the row whose message it last began. */
	startedAt?: number;
	turnOf?: string;
	/** The hand-over whose custom message started the turn pi is in, until the next message starts or the run settles. */
	turnBy?: Copy;
	/** The hand-over whose custom message pi last wrote in this run, with no message of the person written since: its cap is to be in force still. */
	capBy?: Copy;
	/**
	 * What a stop left in the page's pi: the follow-ups of the turn it ended, in order. Pi starts no
	 * run for them. The next run starts with a message handed over or typed after the stop, and
	 * writes these behind that message when it ends unstopped (measured on pi 1.2.0: the row handed
	 * over after the stop first, then what pi kept).
	 */
	kept: Item[];
	/** A terminal's editor. */
	editor: Editor;
}

/**
 * A terminal's editor is one text. A stop puts the queued user messages before what is there, one
 * paragraph each, as pi queued them (after another extension's `input` handler, where there is
 * one). The person can add words of their own, and Enter sends all of it as one message.
 */
export interface Editor {
	text: string;
	/** The hand-overs a stop put there, each with the paragraph that stands for it. */
	put: Array<{ paragraph: string; copy?: Copy }>;
	/** The paragraphs the person typed and has not sent. */
	typed: string[];
	/** The text as the last stop left it, before any extension's `agent_settled` handler: what pi did, for the scenes of the model. */
	afterStop?: string;
}

const idlePi = (): Pi => ({ running: false, queue: [], aborts: 0, kept: [], editor: { text: "", put: [], typed: [] } });
const paragraphs = (...texts: string[]): string => texts.filter((text) => text !== "").join("\n\n");

export type Mode = "tui" | "rpc";

export interface Process {
	pid: number;
	name: string;
	kind: "window" | "background";
	/** A window's pi runs in a terminal or behind the browser page; it decides what a stop does to pi's queue. */
	mode: Mode;
	conversation: Conversation;
	alive: boolean;
	/** A window's pi; the background process has none, and this stays empty. */
	pi: Pi;
	window?: WindowExecutor;
	/** What a window's extension sees of its pi: the part of the fake context that a scene asks directly. */
	ctx?: { hasPendingMessages(): boolean; ui: { getEditorText(): string; setEditorText(text: string): void } };
	executor: Executor;
	/** A window's lease says a row of ours is held (`LeaseBinding.hold`), until the window lets go. */
	held?: boolean;
	/** The rows this window was told it produced or was rung for (`WindowExecutor.produced`): the only ones whose attended source it believes. */
	vouched: Set<string>;
}

export interface Conversation {
	id: string;
	entries: Entry[];
	deleted: boolean;
	/** Who holds the lease; a dead holder keeps it until a live process takes it. */
	holder?: Process;
	slots: Array<{ kind: Process["kind"]; mode: Mode; process?: Process }>;
	goalActive: boolean;
}

/** A row taken out of a queue, with what could account for it read at that instant, before the removal. */
export interface Removal {
	row: Row;
	/** For an input: how its delivery shows in what pi wrote (`deliveredBy`). */
	delivered?: "its own message";
	findings: number;
	/** How many `dead` lines the audit holds for the row: a dead letter writes one each time, and its finding once. */
	dead: number;
	/** The exit states the audit holds for the row, newest first. */
	audited: string[];
	failures: number;
	buried: boolean;
	/** The pi of the process that removes the row holds its turn, handed over and unwritten. */
	heldByRemover: boolean;
	/** For a stop or a cancel that names a row: whether that row is still queued and undelivered, and whether a live pi was handed it and has neither written nor lost it. */
	named?: { queued: boolean; inFlight: boolean };
	/** For a stop a window removes: that window's pi at this instant. */
	removerPi?: { running: boolean; startedAt?: number; turnOf?: string; aborted: boolean };
	/** Set by the check that names the exit (invariants.ts). */
	exit?: string;
}

/** A row handed to pi, or written by the background process, with the state of things at that instant. */
export interface HandOver {
	drain: number;
	process: Process;
	row: Row;
	wake: "turn" | "append";
	holds: boolean;
	/** The row is in its queue file. */
	queued: boolean;
	/** The row is one a window runs itself (a claim, its goal's continuation), and the window that produced it is alive. */
	producerRunsIt: boolean;
	piRunning: boolean;
	/**
	 * Turns this pi held unwritten and the engine had not given up: all of them, and those that went as
	 * a user message and are still inside the grace (past it a tick may call one refused, in this very drain).
	 */
	turnsHeld: number;
	textTurnsHeld: number;
	/**
	 * Turns of ours this idle pi was handed and has not started, that are still owed: no stop or cancel
	 * named them; a user message is inside the grace; a custom message's row is still in its queue (one
	 * another process took out holds nothing, and pi takes two custom messages in the order they came, P13).
	 */
	pendingTurnsHeld: number;
	/** Pi wrote this row already, from its queue. */
	written: boolean;
	/** The person sent this row's text already, from the editor where a stop in a terminal had put it. */
	sentFromTheEditor: boolean;
}

/**
 * A tool call in a turn that a turn row's custom message started, as the window would decide it:
 * whose turn the window says it is at that instant, and whether the window was vouched for the row.
 * `after`: the call is in the turn of another extension's message, written behind that row's.
 */
export interface ToolCall {
	process: Process;
	copy: Copy;
	after?: "another extension's message";
	decidedWith: ReturnType<WindowExecutor["currentTurn"]>;
	vouched: boolean;
}

/** Two decisions on one finding at once: its status before, and how many of the two were told `ok`. */
export interface Decided {
	was: string;
	ok: number;
}

/** What happened in the step being applied, as it happened; the invariants read it after the step. */
export interface Facts {
	removals: Removal[];
	handOvers: HandOver[];
	written: Copy[];
	toolCalls: ToolCall[];
	decided: Decided[];
	/** The processes that held the conversation from the start of a drain to its end, and did not die in it. */
	drained: Process[];
}

export interface World {
	store: RequestStore;
	inbox: Inbox;
	audit: TriggerStore;
	time: Timers;
	clock: number;
	conversations: Conversation[];
	jobs: Map<string, { exists: boolean; enabled: boolean }>;
	nextPid: number;
	/** How many rows, findings and typed messages the schedule has made: each is named by its number. */
	made: number;
	/** A readable name for each row id, for the printed schedule and the messages. */
	labels: Map<string, string>;
	/** The last slot the clock queued for each conversation and job: the clock can write the same slot again. */
	lastSlot: Map<string, number>;
	/** What the person last said in each conversation: they can say the same words again. */
	lastWords: Map<string, string>;
	/** Every hand-over there was, and the hand-overs that threw (with the failures a row arrived with), by row id. */
	copies: Copy[];
	threw: Map<string, number>;
	/** Rows a stop or a cancel named; rows written without their prefix; rows whose mode was widened in the file. */
	targeted: Set<string>;
	malformed: Set<string>;
	tampered: Set<string>;
	facts: Facts;
	drains: number;
	crashes: number;
	/** The row the engine is handing over right now, for the simulated pi to file its copy under. */
	sending?: { row: Row; wake: "turn" | "append" };
	handOverThrows: boolean;
	/** Every message pi writes takes a millisecond; without it the clock stands still inside a step. */
	ticks: boolean;
	/** Another extension's `input` handler puts words before the text of every user message: a prefix of ours is then not at the start, and a row's words are not the message's first. */
	rewrites: boolean;
	/** The hand-overs that pi let go of when the page cleared the queue: none of them may be written afterwards. */
	cleared: Copy[];
	/** Of `cleared`, the ones whose row has left its queue since. */
	clearedLeft: Set<Copy>;
	/** How often the page cleared a queue, and the cancels it wrote for that. */
	clears: { drawn: number; cancels: number };
}

/** A world of one conversation for each of `seconds`: its first process is a window, started; its second is of `kind`, started when `running`; `modes` are the two processes'. */
export function createWorld(dir: string, time: Timers, seconds: ReadonlyArray<{ kind: Process["kind"]; running: boolean; modes: readonly [Mode, Mode] }>, opts: { ticks?: boolean; rewrites?: boolean } = {}): World {
	const world: World = {
		store: new RequestStore(dir),
		inbox: new Inbox(dir),
		audit: new TriggerStore(dir),
		time,
		clock: EPOCH,
		conversations: [],
		jobs: new Map([["j1", { exists: true, enabled: true }], ["j2", { exists: true, enabled: true }]]),
		nextPid: 1000,
		made: 0,
		labels: new Map(),
		lastSlot: new Map(),
		lastWords: new Map(),
		copies: [],
		threw: new Map(),
		targeted: new Set(),
		malformed: new Set(),
		tampered: new Set(),
		facts: noFacts(),
		drains: 0,
		crashes: 0,
		handOverThrows: false,
		ticks: opts.ticks === true,
		rewrites: opts.rewrites === true,
		cleared: [],
		clearedLeft: new Set(),
		clears: { drawn: 0, cancels: 0 },
	};
	time.setTime(EPOCH);
	for (const [index, second] of seconds.entries()) {
		const conversation: Conversation = { id: `c${index}`, entries: [], deleted: false, goalActive: true, slots: [{ kind: "window", mode: second.modes[0] }, { kind: second.kind, mode: second.modes[1] }] };
		world.conversations.push(conversation);
		start(world, conversation, 0);
		if (second.running) start(world, conversation, 1);
	}
	return world;
}

export const noFacts = (): Facts => ({ removals: [], handOvers: [], written: [], toolCalls: [], decided: [], drained: [] });

export function advance(world: World, ms: number): void {
	world.clock += ms;
	world.time.setTime(world.clock);
}

export const label = (world: World, id: string): string => world.labels.get(id) ?? id;
export const who = (proc: Process): string => `${proc.conversation.id}/${proc.name}`;
export const live = (conversation: Conversation): Process[] => conversation.slots.flatMap((slot) => (slot.process?.alive ? [slot.process] : []));
export const everyProcess = (world: World): Process[] => world.conversations.flatMap((c) => c.slots.flatMap((slot) => (slot.process ? [slot.process] : [])));
const pidAlive = (world: World, pid: number): boolean => pid === PAGE_PID || everyProcess(world).some((p) => p.pid === pid && p.alive);

/**
 * How `row`'s delivery shows in what the simulated pi wrote: a message that counts for it
 * (`countsFor`: its own, or one with the very same words that carries its mark). The simulation
 * writes no version 2 line, so the text proof of one is not modelled.
 */
export function deliveredBy(world: World, row: Row): Removal["delivered"] {
	return world.copies.some((copy) => copy.sessionId === row.lane && copy.state === "written" && countsFor(world, copy) === row.id) ? "its own message" : undefined;
}

/**
 * The row a message pi wrote counts for. Its own, unless its entry carries the mark of another row
 * with the very same words: nobody can tell two such messages apart, and the window may give either
 * one the mark (src/window-claim.ts `claimOf`). A mark of a row with other words counts for nothing
 * here; the check "a mark names its own row's message" says so.
 */
export function countsFor(world: World, copy: Copy): string {
	if (copy.markedAs === undefined || copy.markedAs === copy.rowId) return copy.rowId;
	return world.copies.some((other) => other.rowId === copy.markedAs && other.sessionId === copy.sessionId && other.text === copy.text) ? copy.markedAs : copy.rowId;
}

/**
 * A message pi wrote that answers its row: not one the window aborted as pi began it (no answer came;
 * the window does that for a stop or a cancel, and the same row queued again later is a new request).
 */
export const answered = (copy: Copy): boolean => copy.state === "written" && !copy.abortedAtStart;

export const findingsFor = (world: World, rowId: string): number => world.inbox.list().filter((entry) => entry.run_id === rowId).length;
/** The states the audit's `request` lines give row `rowId`, newest first, without `failed` and `dead`: those two are not exits a line alone proves. */
/** How many times the audit says row `rowId` became a dead letter. */
export const deadLines = (world: World, rowId: string): number => world.audit.listAudit(Number.MAX_SAFE_INTEGER, (r) => r.type === "request" && r.traceId === rowId && r.state === "dead").length;
export const auditedExits = (world: World, rowId: string): string[] => world.audit.listAudit(Number.MAX_SAFE_INTEGER, (r) => r.type === "request" && r.traceId === rowId && r.state !== "failed" && r.state !== "dead").map((r) => r.state);

/** The copies `process`'s pi holds unwritten. */
export const held = (proc: Process): Copy[] => [proc.pi.current, ...proc.pi.kept, ...proc.pi.queue].flatMap((item) => (item?.copy ? [item.copy] : []));

/**
 * The hand-overs of row `rowId` that failed, as the simulated pi saw them: one that threw, one pi
 * dropped or refused, and a user message that sat unstarted for `GRACE_MS`, which a tick may judge
 * refused. No grace runs for a custom message. The engine's `attempts` may count these and nothing else.
 */
export function failedHandOvers(world: World, rowId: string): number {
	const failed = (copy: Copy) => copy.markLess || copy.state === "dropped" || copy.state === "refused" || (copy.provedByText && (copy.leftQueueAt ?? world.clock) - copy.handedAt >= GRACE_MS);
	return (world.threw.get(rowId) ?? 0) + world.copies.filter((copy) => copy.rowId === rowId && failed(copy)).length;
}

/* ------------------------------------------------------------ processes */

/** A new process in slot `index` of `conversation`. It takes the lease when no live process has it, and a window takes it from the background process; otherwise it is a viewer. */
export function start(world: World, conversation: Conversation, index: number): Process {
	const slot = conversation.slots[index];
	const base = { pid: world.nextPid++, mode: slot.mode, conversation, alive: true, pi: idlePi(), vouched: new Set<string>() };
	const proc = slot.kind === "window" ? windowProcess(world, { ...base, name: `w${index}`, kind: "window" }) : backgroundProcess(world, { ...base, name: "bg", kind: "background" });
	slot.process = proc;
	if (!conversation.holder?.alive || (conversation.holder.kind === "background" && proc.kind === "window")) conversation.holder = proc;
	return proc;
}

/** The process is gone, and with it everything pi was handed and had not written. */
export function kill(world: World, proc: Process): void {
	proc.alive = false;
	for (const copy of held(proc)) leave(copy, "died", world.clock);
	proc.pi = idlePi();
}

/** Whether `to` can take the lease now: from a dead holder always; from the background process when `to` is a window; from a live window only when that is the page's pi, `to` is a terminal, and the holder's pi runs no turn. */
export function leaseMayMove(conversation: Conversation, to: Process): boolean {
	const from = conversation.holder;
	if (!to.alive || from === to) return false;
	if (!from?.alive) return true;
	if (from.kind === "background") return to.kind === "window";
	return to.kind === "window" && from.mode === "rpc" && to.mode === "tui" && !from.pi.running && !from.held;
}

/** The lease goes to `to`. What the old holder's pi still holds is nobody's to wait for now: the new holder cannot see it. */
export function moveLease(conversation: Conversation, to: Process): void {
	if (conversation.holder?.alive) for (const copy of held(conversation.holder)) copy.gaveUp ??= "lease";
	conversation.holder = to;
}

function leave(copy: Copy | undefined, state: Copy["state"], at: number): void {
	if (!copy) return;
	copy.state = state;
	copy.leftQueueAt ??= at;
}

const stampOf = (at: number): string => new Date(at).toISOString(); // pi's own format: the `timestamp` it puts on a session entry is UTC

/** The copy of the row being handed over, filed as pi (or the background process) receives it. */
function copyFor(world: World, proc: Process, text: string, custom: boolean): Copy | undefined {
	const sending = world.sending;
	if (!sending) return undefined;
	const copy: Copy = { rowId: sending.row.id, source: sending.row.source, sessionId: proc.conversation.id, process: proc, text, wake: sending.wake, custom, provedByText: !custom, person: sending.row.source === "person", handedAt: world.clock, state: "held" };
	world.copies.push(copy);
	return copy;
}

/** A `tool_call` now, in the turn a turn row's custom message started: what the window's guard would be told (`WindowExecutor.currentTurn`). */
function toolCall(world: World, proc: Process): void {
	const copy = proc.pi.turnBy;
	if (copy && proc.window) world.facts.toolCalls.push({ process: proc, copy, decidedWith: proc.window.currentTurn(), vouched: proc.vouched.has(copy.rowId) });
}

/** `rest`: what still waits behind `item` when pi writes it out of a queue it took whole (a settle). */
function write(world: World, proc: Process, item: Item, rest: readonly Item[] = []): void {
	const at = world.clock;
	const aborts = proc.pi.aborts;
	// The last tool call of the turn before this message.
	toolCall(world, proc);
	// `message_start` first, then `message_end`, then the entry: pi's agent loop emits them back to
	// back, and persists the message that `message_end` gave back, when it gave one.
	// What pi writes of a user message is what the `input` handlers made of it.
	const text = world.rewrites && !item.custom ? `${REWRITTEN}${item.text}` : item.text;
	let message: UserMessage = { role: "user", content: [{ type: "text", text }] };
	// Pi emits both events for a custom message too, with the role `custom`, its type and the details
	// it was sent with (P8, P13), and persists the details a `message_end` handler gives back (P18).
	let details = item.details;
	if (item.custom) {
		const custom = { role: "custom", customType: item.customType, content: text, ...(details === undefined ? {} : { details }) };
		proc.window?.messageStarted(custom, at);
		const ended = proc.window?.messageEnded(custom, at) as { message: { role: string; details?: unknown } } | undefined;
		if (ended?.message.role === "custom") details = ended.message.details;
	} else {
		proc.window?.messageStarted({ role: "user", content: text }, at);
		const ended = proc.window?.messageEnded(message, at);
		if (ended?.message.role === "user") message = ended.message;
	}
	proc.conversation.entries.push(item.custom ? { type: "custom_message", timestamp: stampOf(at), content: item.text, ...(details === undefined ? {} : { details }) } : { type: "message", timestamp: stampOf(at), message });
	if (world.ticks) advance(world, 1);
	// What the person sent from the editor: each hand-over whose paragraph is still in it is written now, by them.
	for (const put of item.editor?.put ?? []) {
		if (!put.copy || !item.editor!.text.includes(put.paragraph)) continue;
		const copy: Copy = { ...put.copy, state: "written", writtenAt: at, fromTheEditor: true };
		world.copies.push(copy);
		world.facts.written.push(copy);
	}
	// The turn that follows is this message's: a turn row's custom message, or someone's user message.
	// An `append` row's message changes nothing about whose turn it is. Another extension's message
	// behind a turn row's leaves that row's cap in force; a message of the person may lift it.
	if (item.customType === TURN_TYPE) proc.pi.turnBy = proc.pi.capBy = item.copy;
	else if (!item.custom) {
		proc.pi.turnBy = undefined;
		if (!item.extension) proc.pi.capBy = undefined;
		else if (proc.pi.capBy && proc.window) world.facts.toolCalls.push({ process: proc, copy: proc.pi.capBy, after: "another extension's message", decidedWith: proc.window.currentTurn(), vouched: proc.vouched.has(proc.pi.capBy.rowId) });
	}
	if (!item.copy) return;
	const mark = markOn(proc.conversation.entries[proc.conversation.entries.length - 1]);
	if (mark) item.copy.markedAs = mark.id;
	// Only a person's own page message where its words were rewritten: it starts with the rewriter's
	// words, so the window does not know it by its own at the start. A custom message is never rewritten.
	else if (world.rewrites && !item.custom) item.copy.markLess = true;
	if (item.copy.wake === "turn") proc.pi.turnOf = item.copy.rowId;
	item.copy.abortedAtStart = proc.pi.aborts > aborts;
	leave(item.copy, "written", at);
	item.copy.writtenAt = at;
	world.facts.written.push(item.copy);
	// The first tool call of the turn this message started.
	if (item.customType === TURN_TYPE) toolCall(world, proc);
}

function windowProcess(world: World, base: Omit<Process, "executor">): Process {
	const proc = base as Process;
	const conversation = proc.conversation;
	const receive = (text: string, custom: string | undefined, queued: boolean, details?: unknown): void => {
		if (world.handOverThrows) throw new Error("no model selected");
		const item: Item = { text, custom: custom !== undefined, ...(custom === undefined ? {} : { customType: custom }), copy: copyFor(world, proc, text, custom !== undefined), ...(details === undefined ? {} : { details }) };
		// pi's `input` for a user message an extension sends: our handler first, inside the call, with
		// the text as sent (probe P6; the other load order is not modelled). A custom message makes no `input`.
		if (custom === undefined) proc.window?.inputSeen({ source: "extension", text, ...(queued ? { streamingBehavior: "followUp" as const } : {}) }, world.clock);
		if (queued) proc.pi.queue.push(item);
		else write(world, proc, item);
	};
	const pi = {
		sendMessage: (message: { customType: string; content: string; details?: unknown }, options?: { triggerTurn?: boolean }) => receive(message.content, message.customType, options?.triggerTurn === true, message.details),
		sendUserMessage: (content: string) => receive(content, undefined, true),
	};
	const ctx = {
		isIdle: () => !proc.pi.running,
		mode: proc.mode,
		// True in a terminal and in the page's pi (measured).
		hasUI: true,
		// The editor, as an extension reads and sets it: one text.
		ui: { notify: () => undefined, getEditorText: () => proc.pi.editor.text, setEditorText: (text: string) => void (proc.pi.editor.text = text) },
		// The user messages pi holds behind a turn: follow-ups while one runs, and what a stop left in
		// the page's pi (measured: true at `agent_end` after the page's Stop, false in a terminal, and a
		// custom message is not counted). A prompt an idle pi has not started is not one of them.
		hasPendingMessages: () => [...proc.pi.kept, ...(proc.pi.running ? proc.pi.queue : [])].some((item) => !item.custom),
		sessionManager: { getEntries: () => conversation.entries },
		abort: () => void (proc.pi.aborts += proc.pi.running ? 1 : 0),
	};
	type Args = ConstructorParameters<typeof WindowExecutor>;
	// The lease's hold, as a field: the holder's is on its lease, and a viewer's is a receipt with no
	// write. A window that lost the lease mid-drain gets a receipt here too: the lease's own tests hold
	// that case (test/lease.test.ts), and the engine asks `holds` before every row.
	const binding = {
		here: () => ({ sessionId: conversation.id, holds: conversation.holder === proc }),
		hold: () => {
			if (conversation.holder === proc) proc.held = true;
			return {} as ReturnType<LeaseBinding["hold"]>;
		},
		letGo: () => void (proc.held = false),
	};
	const window = new WindowExecutor(pi as unknown as Args[0], binding, () => ctx as unknown as ReturnType<Args[2]>, { pid: proc.pid }, (row) => row.created_by.left === undefined && pidAlive(world, row.created_by.pid), () => world.store.list(conversation.id), undefined, () => []);
	const produced = window.produced.bind(window);
	window.produced = (row) => {
		proc.vouched.add(row.id);
		produced(row);
	};
	proc.window = window;
	proc.executor = window;
	proc.ctx = ctx;
	return proc;
}

/**
 * The background process on a closed conversation, in this world: `append` rows only, written into the
 * file at once. It starts no turn here: a plain job's turn in the background has a world of its own
 * (test/sim/held.ts), and this one keeps to what pi and the windows do to a queue.
 */
function backgroundProcess(world: World, base: Omit<Process, "executor">): Process {
	const proc = base as Process;
	const conversation = proc.conversation;
	proc.executor = {
		holds: () => proc.alive && conversation.holder === proc,
		proof: () => proofOf(conversation.id, () => conversation.entries, () => []),
		view: () => ({ kind: "held", ceiling: CEILING.held, blocked: (row) => (row.wake === "turn" ? "turn rows wait for a window" : undefined), claimLive: () => false, idle: true, inFlight: new Set<string>(), connected: () => true, producerAlive: () => true, mine: () => false }),
		// As src/background-executor.ts does: the mark in the custom entry's details.
		append: (row) => write(world, proc, { text: row.payload?.text ?? "", custom: true, customType: "pi-loops:trigger", copy: copyFor(world, proc, row.payload?.text ?? "", true), details: markDetails(markFor(row)) }),
		turn: () => {
			throw new Error("this world's background starts no turn (test/sim/held.ts has that)");
		},
		abort: () => undefined,
		abortWhenStarted: () => undefined,
		refused: () => undefined,
	};
	return proc;
}

/* ------------------------------------------------------------ pi's moves */

export type PiMove = "start" | "write" | "settle" | "esc" | "refuse" | "type" | "enter" | "typeBehind" | "otherSends" | "otherRejected" | "steer";

/** What `process`'s pi can do next; a move listed twice is twice as likely. */
export function piMoves(proc: Process): PiMove[] {
	const pi = proc.pi;
	// While a turn runs: the person sends a message behind it in the page, or steers in a terminal; another extension sends one anywhere, or sends one pi refuses.
	const behind: PiMove[] = proc.mode === "rpc" ? ["typeBehind", "steer", "otherSends", "otherRejected"] : ["steer", "otherSends", "otherRejected"];
	if (pi.running) return pi.current ? ["write", "write", "settle", "esc", ...behind] : ["settle", "esc", ...behind];
	// A terminal's editor that a stop filled: the person sends it, or adds words of their own first
	// (`type`). What a stop left in the page's pi starts nothing: no `start` and no `refuse` for it.
	const enter: PiMove[] = pi.editor.text !== "" ? ["enter"] : [];
	// Only a user message is refused without a word: a custom message that asks for a turn gets its run.
	const refuse: PiMove[] = pi.queue[0]?.custom === false ? ["refuse"] : [];
	return pi.queue.length ? ["start", "start", "start", ...refuse, "type", "type", "otherSends", ...enter] : ["type", ...enter];
}

export function piMove(world: World, proc: Process, move: PiMove): void {
	const pi = proc.pi;
	const window = proc.window!;
	const at = world.clock;
	switch (move) {
		case "start":
			pi.running = true;
			pi.startedAt = at;
			pi.current = pi.queue.shift();
			if (pi.current?.copy) pi.current.copy.leftQueueAt ??= at;
			window.agentStarted(at);
			break;
		case "write":
			write(world, proc, pi.current!);
			pi.current = undefined;
			break;
		case "refuse":
			leave(pi.queue.shift()?.copy, "refused", at);
			break;
		case "type":
			// Into an editor that holds text, the person's words go behind it, unsent: one text.
			if (pi.editor.text !== "") {
				const words = `typed #${++world.made}.`;
				pi.editor.typed.push(words);
				pi.editor.text = paragraphs(pi.editor.text, words);
				break;
			}
			// The person's own message: `input`, then a run that starts with it.
			{
				const words = `typed #${++world.made}.`;
				window.inputSeen({ source: proc.mode === "tui" ? "interactive" : "rpc", text: words }, at);
				pi.running = true;
				pi.startedAt = at;
				window.agentStarted(at);
				write(world, proc, { text: words, custom: false });
			}
			break;
		case "typeBehind":
			// The person's message while a turn runs, sent to pi and not through a row: `input`, and a follow-up of no row.
			{
				const words = `typed behind #${++world.made}.`;
				window.inputSeen({ source: "rpc", text: words, streamingBehavior: "followUp" }, at);
				pi.queue.push({ text: words, custom: false });
			}
			break;
		case "steer": {
			// Enter during a run in a terminal, or the page's steer (rpc `prompt` with `streamingBehavior:
			// "steer"`, which pi queues the same way): `input` from the person, and a message behind the
			// steers before it and ahead of the follow-ups (g16). In a terminal with text in the editor, the
			// steer is that whole text, and the editor is empty (g16; pi's interactive mode does the same).
			const sent = pi.editor.text !== "" ? pi.editor : undefined;
			if (sent) pi.editor = idlePi().editor;
			const item: Item = { text: sent ? sent.text : `steered #${++world.made}.`, custom: false, person: true, ...(sent ? { editor: sent } : {}) };
			window.inputSeen({ source: proc.mode === "tui" ? "interactive" : "rpc", text: item.text, streamingBehavior: "steer" }, at);
			const behindSteers = pi.queue.findIndex((queued) => !queued.person);
			pi.queue.splice(behindSteers === -1 ? pi.queue.length : behindSteers, 0, item);
			break;
		}
		case "otherRejected":
			// Another extension's `sendUserMessage` with no `deliverAs` while a turn runs: `input`, then pi throws, and no message.
			window.inputSeen({ source: "extension", text: `another extension says #${++world.made}.` }, at);
			break;
		case "otherSends": {
			// Another extension's `sendUserMessage`: `input` with the source `extension`, so no submission of the person is counted.
			const item: Item = { text: `another extension says #${++world.made}.`, custom: false, extension: true };
			window.inputSeen({ source: "extension", text: item.text, ...(pi.running ? { streamingBehavior: "followUp" as const } : {}) }, at);
			if (pi.running) pi.queue.push(item);
			else {
				pi.running = true;
				pi.startedAt = at;
				window.agentStarted(at);
				write(world, proc, item);
			}
			break;
		}
		case "enter": {
			// The person sends the editor: one message, all of its text, and a run that starts with it.
			// Each hand-over whose paragraph is still in the text is written now, by them.
			const sent = pi.editor;
			pi.editor = idlePi().editor;
			window.inputSeen({ source: "interactive", text: sent.text }, at);
			pi.running = true;
			pi.startedAt = at;
			window.agentStarted(at);
			write(world, proc, { text: sent.text, custom: false, editor: sent });
			break;
		}
		case "settle":
		case "esc": {
			if (pi.current) write(world, proc, pi.current);
			pi.current = undefined;
			// Pi takes what waits behind the turn one message at a time: what an earlier stop left
			// first, then the follow-ups (pi has one queue). A stop ends that: Esc or the page's Stop
			// (`esc`), or `ctx.abort()`, which the window can ask for as any of these messages starts.
			// The message that asked is written; what waits behind it is not. A stop in a terminal
			// clears pi's queue and puts the queued user messages into the editor, before what is
			// there. A stop in the page's pi leaves the rest queued: pi holds it, and the window,
			// which reads a settled pi's unwritten rows as dropped, stops waiting for it.
			const waiting = [...pi.kept.splice(0), ...pi.queue.splice(0)];
			let stopped = move === "esc" || pi.aborts > 0;
			while (!stopped && waiting.length) {
				write(world, proc, waiting.shift()!, waiting);
				stopped = pi.aborts > 0;
			}
			if (proc.mode === "tui") {
				const put = waiting.filter((item) => !item.custom).map((item) => ({ paragraph: world.rewrites ? `${REWRITTEN}${item.text}` : item.text, copy: item.copy }));
				for (const item of waiting) leave(item.copy, "dropped", at);
				// A steer is the person's words: nothing may take them out of the editor. One
				// that carried the editor's text is that editor again: the person's words, and what a stop put there.
				for (const item of waiting) {
					if (!item.person) continue;
					if (item.editor) {
						pi.editor.typed.push(...item.editor.typed);
						pi.editor.put.push(...item.editor.put);
					} else pi.editor.typed.push(world.rewrites ? `${REWRITTEN}${item.text}` : item.text);
				}
				pi.editor.put.push(...put);
				pi.editor.text = paragraphs(...put.map((item) => item.paragraph), pi.editor.text);
				pi.editor.afterStop = pi.editor.text;
			} else {
				for (const item of waiting) if (item.copy) item.copy.gaveUp ??= "stop";
				pi.kept.push(...waiting);
			}
			// The last tool call of the run's last turn.
			toolCall(world, proc);
			Object.assign(pi, { running: false, aborts: 0, startedAt: undefined, turnOf: undefined, turnBy: undefined, capBy: undefined });
			window.agentEnded();
			window.settled(stopped);
			break;
		}
	}
}

/**
 * The page's "clear queue" for `conversation`: a cancel from the person for every input row in the
 * queue file, then rpc `clear_queue` to the page's pi. Pi lets go of what it kept after a stop and,
 * while a turn runs, of the follow-ups behind it, custom messages too; the prompt it runs and a
 * prompt an idle pi has not started are not in that queue. No extension is told: the window learns
 * of it from the cancels and from what pi does not write. Returns the ids of the cancels, and
 * undefined when no page's pi is on the conversation.
 */
export function clearQueue(world: World, conversation: Conversation, cancel: (target: string) => string): string[] | undefined {
	const page = live(conversation).find((proc) => proc.window && proc.mode === "rpc");
	if (!page) return undefined;
	const cancels = world.store.list(conversation.id).filter((row) => row.kind === "input").map((row) => cancel(row.id));
	world.clears.drawn++;
	world.clears.cancels += cancels.length;
	const pi = page.pi;
	for (const item of [...pi.kept.splice(0), ...(pi.running ? pi.queue.splice(0) : [])]) {
		leave(item.copy, "dropped", world.clock);
		if (item.copy) world.cleared.push(item.copy);
	}
	return cancels;
}

/**
 * A turn row handed to `proc`'s pi outside the engine. The engine hands an idle pi one prompt of ours
 * at a time; a version before marks, or a race of two drains, could hand a second. The scenes of the
 * model use this to put two prompts behind one run.
 */
export function handOverOutside(world: World, proc: Process, row: Row): void {
	world.sending = { row, wake: "turn" };
	try {
		proc.window!.turn(row as Parameters<WindowExecutor["turn"]>[0], world.clock);
	} finally {
		world.sending = undefined;
	}
}

/* ------------------------------------------------------------ the engine, with its writes watched */

/**
 * What can go wrong inside one drain: the process dies before its n-th write; pi throws at a
 * hand-over; and the two things another process can do to a drain that is one step here. It takes
 * the lease, once the drain has handed over or removed its n-th row and before its next one. Or its
 * pi writes a turn it still holds, just before the drain's n-th row: at the engine's look whether it
 * still holds the conversation, which it takes before every row, so the write falls between the
 * drain's decision and the row.
 */
export interface Fault {
	crashAfter?: number;
	handOverThrows?: boolean;
	leaseLeavesAfter?: number;
	othersWriteBefore?: number;
}

/** Lets `after` writes through, then throws at every one: a dead process writes nothing more, whatever catches the throw. */
function fuse(after = Infinity) {
	let left = after;
	const state = {
		blown: false,
		write(): void {
			if (state.blown || left-- <= 0) {
				state.blown = true;
				throw new Error("simulated crash: the process died before this write");
			}
		},
	};
	return state;
}

type Fuse = ReturnType<typeof fuse>;

/** The real store, with a look at every removal just before it happens, the fuse before every write, and a word to the caller after a removal. */
function watchedStore(world: World, fuse: Fuse, remover?: Process, removed: () => void = () => undefined): RequestStore {
	const real = world.store;
	const watched: RequestStore = Object.create(real);
	watched.update = (sessionId, id, patch) => {
		fuse.write();
		return real.update(sessionId, id, patch);
	};
	watched.remove = (sessionId, ids) => {
		const gone = [...ids];
		fuse.write();
		const conversation = world.conversations.find((c) => c.id === sessionId)!;
		const rows = real.list(sessionId);
		for (const row of rows) {
			if (!gone.includes(row.id)) continue;
			const removal: Removal = { row, delivered: row.kind === "input" ? deliveredBy(world, row) : undefined, findings: findingsFor(world, row.id), dead: deadLines(world, row.id), audited: auditedExits(world, row.id), failures: failedHandOvers(world, row.id), buried: conversation.deleted, heldByRemover: !!remover && held(remover).some((copy) => copy.rowId === row.id && !copy.gaveUp && !copy.stopNamed) };
			const target = row.kind !== "input" && row.target && "id" in row.target ? row.target.id : undefined;
			// A pi was handed the named row and has neither written nor lost it; one that refused it in silence counts until a tick judges the refusal: its window cannot know before.
			if (target !== undefined) removal.named = { queued: rows.some((r) => r.id === target && r.kind === "input" && !deliveredBy(world, r)), inFlight: world.copies.some((c) => c.sessionId === sessionId && c.rowId === target && c.process.alive && (c.state === "held" || (c.state === "refused" && c.gaveUp !== "refused"))) };
			if (row.kind === "stop" && remover?.window) {
				const pi = remover.pi;
				removal.removerPi = { running: pi.running, startedAt: pi.startedAt, turnOf: pi.turnOf, aborted: pi.aborts > 0 };
				for (const item of [pi.current, ...pi.queue]) if (item?.copy && item.copy.rowId === target && item.copy.wake === "turn" && !item.copy.gaveUp) item.copy.stopNamed = true;
			}
			world.facts.removals.push(removal);
			// A row queued again with the same id after this (a loop's slot) is a new request, which the clear did not name.
			for (const copy of world.cleared) if (copy.sessionId === sessionId && copy.rowId === row.id) world.clearedLeft.add(copy);
		}
		real.remove(sessionId, gone);
		removed();
	};
	// The drain's removal of a row that landed and has no claim: the same look, through `remove`.
	watched.removeIf = (sessionId, id, when) => {
		const row = real.list(sessionId).find((r) => r.id === id);
		if (!row) return { outcome: "missing" };
		if (!when(row)) return { outcome: "kept", row };
		watched.remove(sessionId, [id]);
		return { outcome: "removed", row };
	};
	return watched;
}

function watchedSinks(world: World, fuse: Fuse): EngineSinks {
	return {
		jobs: { exists: (id) => world.jobs.get(id)?.exists ?? false, enabled: (id) => world.jobs.get(id)?.enabled ?? false, goalActive: (sessionId) => world.conversations.find((c) => c.id === sessionId)?.goalActive ?? false },
		inbox: {
			fileOnce: async (entry, id) => {
				fuse.write();
				return world.inbox.fileOnce(entry, id);
			},
			appendOnce: async (entry, key, opts) => {
				fuse.write();
				return world.inbox.appendOnce(entry, key, opts);
			},
		},
		audit: {
			appendAudit: (record) => {
				fuse.write();
				return world.audit.appendAudit(record);
			},
			listAudit: (limit, filter) => world.audit.listAudit(limit, filter),
		},
	};
}

/** One drain by `process`. Returns what the engine returned, or undefined when the process died in it. */
export async function drainAs(world: World, proc: Process, tick: boolean, fault: Fault = {}): Promise<DrainResult | undefined> {
	const conversation = proc.conversation;
	const crash = fuse(fault.crashAfter);
	const inner = proc.executor;
	const number = ++world.drains;
	let settled = 0;
	let looks = 0;
	// One of the drain's rows is handed over or removed: the conversation can be taken here, before the next one.
	const rowSettled = (): void => {
		if (++settled !== fault.leaseLeavesAfter) return;
		const taker = live(conversation).find((other) => leaseMayMove(conversation, other));
		if (taker) moveLease(conversation, taker);
	};
	// The engine's first look comes before it decides; each later one comes before a row.
	const looked = (): void => {
		if (++looks !== 1 + (fault.othersWriteBefore ?? NaN)) return;
		for (const other of live(conversation)) {
			if (other === proc || !other.window) continue;
			if (!other.pi.running && other.pi.queue.length) piMove(world, other, "start");
			if (other.pi.current) piMove(world, other, "write");
		}
	};
	const handOver = <T>(row: Row, wake: "turn" | "append", call: () => T): T => {
		crash.write();
		const turns = held(proc).filter((copy) => copy.wake === "turn" && !copy.gaveUp);
		const stillQueued = new Set(world.store.list(conversation.id).map((queued) => queued.id));
		const local = row.source === "goal";
		world.facts.handOvers.push({ drain: number, process: proc, row, wake, holds: conversation.holder === proc, queued: world.store.list(conversation.id).some((queued) => queued.id === row.id), producerRunsIt: local && row.created_by.left === undefined && pidAlive(world, row.created_by.pid), piRunning: proc.pi.running, turnsHeld: turns.length, textTurnsHeld: turns.filter((copy) => copy.provedByText && world.clock - copy.handedAt < GRACE_MS).length, pendingTurnsHeld: proc.pi.running ? 0 : proc.pi.queue.filter((item) => item.copy && item.copy.wake === "turn" && !item.copy.gaveUp && !item.copy.stopNamed && (item.custom ? stillQueued.has(item.copy.rowId) : world.clock - item.copy.handedAt < GRACE_MS)).length, written: world.copies.some((copy) => copy.sessionId === conversation.id && countsFor(world, copy) === row.id && answered(copy) && !copy.fromTheEditor && !copy.markLess), sentFromTheEditor: world.copies.some((copy) => copy.sessionId === conversation.id && copy.rowId === row.id && copy.state === "written" && copy.fromTheEditor === true) });
		world.sending = { row, wake };
		world.handOverThrows = fault.handOverThrows === true;
		let sent: T;
		try {
			sent = call();
		} catch (err) {
			world.threw.set(row.id, (world.threw.get(row.id) ?? 0) + 1);
			throw err;
		} finally {
			world.sending = undefined;
			world.handOverThrows = false;
		}
		rowSettled();
		return sent;
	};
	const executor: Executor = {
		holds: (sessionId) => {
			looked();
			return inner.holds(sessionId);
		},
		view: (sessionId) => inner.view(sessionId),
		proof: (sessionId) => inner.proof(sessionId),
		turn: (row, at) => handOver(row, "turn", () => inner.turn(row, at)),
		append: (row, wakeAgent) => handOver(row, "append", () => inner.append(row, wakeAgent)),
		abort: () => inner.abort(),
		abortWhenStarted: (id) => {
			// A stop or a cancel named a row this pi holds and has not begun: a turn is to be aborted as it
			// starts; a custom message has no start to abort, and the cancel takes the row out all the same.
			for (const item of [proc.pi.current, ...proc.pi.kept, ...proc.pi.queue]) if (item?.copy && item.copy.rowId === id && !item.copy.gaveUp) item.copy.stopNamed = true;
			inner.abortWhenStarted(id);
		},
		refused: (id) => {
			// The engine stops waiting for this hand-over; if pi still has it, pi may yet send it late.
			for (const copy of held(proc)) if (copy.rowId === id) copy.gaveUp ??= "refused";
			inner.refused(id);
		},
	};
	const holder = conversation.holder === proc;
	try {
		const out = await drain(conversation.id, watchedStore(world, crash, proc, rowSettled), executor, world.clock, watchedSinks(world, crash), { tick });
		if (holder && conversation.holder === proc && !crash.blown) world.facts.drained.push(proc);
		return out;
	} catch (err) {
		if (!crash.blown) throw err;
		return undefined;
	} finally {
		if (crash.blown) {
			kill(world, proc);
			world.crashes++;
		}
	}
}

/** The conversation's file is gone: every row of its queue is buried, by a process that may die on the way. */
export async function buryAs(world: World, conversation: Conversation, crashAfter?: number): Promise<string[] | undefined> {
	const crash = fuse(crashAfter);
	try {
		return await bury(conversation.id, watchedStore(world, crash), watchedSinks(world, crash), "its conversation is gone");
	} catch (err) {
		if (!crash.blown) throw err;
		world.crashes++;
		return undefined;
	}
}

/**
 * Two things done to the inbox at once. The first runs its critical section before it returns its
 * promise; the second finds the lock taken and sleeps on a timer, which the simulated clock ends.
 */
export async function atOnce<T>(world: World, acts: ReadonlyArray<() => Promise<T>>): Promise<T[]> {
	const calls = acts.map((act) => act());
	const first = await calls[0];
	world.time.tick(LOCK_WAIT_MS);
	world.clock += LOCK_WAIT_MS;
	return [first, await calls[1]];
}
