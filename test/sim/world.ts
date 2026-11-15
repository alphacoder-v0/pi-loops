/**
 * The world a simulated schedule runs in. Real: `drain`, `decideDrain` and `bury` (src/engine.ts),
 * the `RequestStore`, the `Inbox`, the audit file and every window's `WindowExecutor`, on one
 * temporary directory. Simulated: the clock, the processes, the lease, the conversation and pi.
 *
 * What the simulated pi does:
 * - It is idle, or it runs one turn. A message handed to it while idle waits in its queue, and pi
 *   still says it is idle (the phase before a run: input handlers, the credential check), until the
 *   schedule has it start the turn, or refuse the message without a word, as `prompt()` does when it
 *   throws before any run.
 * - A turn starts (`agent_start`), writes the message it began with (`message_start`, then the
 *   entry) and settles (`agent_end`, `agent_settled`). What it was handed meanwhile is written as
 *   follow-ups when it settles. What a stop does depends on the window's mode, which the seed
 *   draws. In a terminal (`tui`), Esc and `ctx.abort()` are the interactive mode's abort handler:
 *   it clears pi's queues, puts the queued texts of user messages into the editor, then aborts.
 *   The person can then send the editor's text: one message, the texts joined, as they would any
 *   message of their own. In the page's pi (`rpc`) the page's Stop and `ctx.abort()` are
 *   `AgentSession.abort()`, which ends the turn and leaves what is queued behind it: pi is idle
 *   and still holds it, and writes it in its next run, which the schedule starts as it starts any
 *   turn pi was handed. (Measured on pi 1.2.0: .docs/redesign-0243/signatures/M3b-probes.md, P2 and P3.)
 * - Before pi persists a message it asks the window (`message_end`), which may give another
 *   message of the same role: what a window writes into the entry is in the entry.
 * - A custom message with no turn asked for is written at once.
 * - The person types into the window: a turn of their own, in words no row has.
 * - A hand-over can throw (no model, no credentials).
 *
 * What it does not do:
 * - A conversation is one list of entries, durable the moment an entry is written, and every process
 *   sees it at once. A real second pi reads its own copy, which can be behind the file, so nothing
 *   here speaks for what a process does with a write it has not read (a crash between pi's write
 *   and the removal, then another window: src/engine.ts `releaseLocalRows`).
 * - No model, no tools, no compaction, no images, no MCP server. In three worlds of four no
 *   extension rewrites a prompt, so whatever the window puts in `ExecutorView.ran` it took for a
 *   rewritten prompt by mistake; in the fourth another extension's `input` handler puts words
 *   before every user message (`World.rewrites`), as pi lets one (probes, P4). No window leaves a conversation and lives on
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
type Entry = { type: "message"; timestamp: string; message: UserMessage } | { type: "custom_message"; timestamp: string; content: string };

/**
 * One hand-over, as the simulated pi knows it: which row, to which process, and what became of it.
 * `held` while pi has it unwritten; then `written`, `dropped` (a stop in a terminal), `refused`
 * (pi threw before a run) or `died` (its process was killed).
 */
export interface Copy {
	rowId: string;
	sessionId: string;
	/** The process whose pi was handed it. */
	process: Process;
	text: string;
	wake: "turn" | "append";
	/** The row carries no `[Trigger <id>]`: only a message with its words proves it. And whether it is a person's message. */
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
	/** A stop in a terminal put this hand-over's text into the editor, and the person sent it: written by them, not by pi's queue. */
	fromTheEditor?: boolean;
}

interface Item {
	text: string;
	custom: boolean;
	copy?: Copy;
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
	/** A terminal's editor: the queued user messages that a stop took out of pi's queue, for the person to send or not. */
	editor: Item[];
}

const idlePi = (): Pi => ({ running: false, queue: [], aborts: 0, editor: [] });

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
	executor: Executor;
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
	delivered?: "its own message" | "another row's message";
	findings: number;
	/** How many `dead` lines the audit holds for the row: a dead letter writes one each time, and its finding once. */
	dead: number;
	/** The exit states the audit holds for the row, newest first. */
	audited: string[];
	failures: number;
	buried: boolean;
	/** The pi of the process that removes the row holds its turn, handed over and unwritten. */
	heldByRemover: boolean;
	/** The window that removes the row says its turn ran under a message that lost its prefix (`ExecutorView.ran`); asked only of an unproved input. */
	ranUnproved?: boolean;
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
	 * Turns this pi held unwritten and the engine had not given up: all of them, and those only their
	 * text proves that are still inside the grace (past it a tick may call one refused, in this very drain).
	 */
	turnsHeld: number;
	textTurnsHeld: number;
	/** Pi wrote this row already, from its queue. */
	written: boolean;
	/** The person sent this row's text already, from the editor where a stop in a terminal had put it. */
	sentFromTheEditor: boolean;
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

export const noFacts = (): Facts => ({ removals: [], handOvers: [], written: [], decided: [], drained: [] });

export function advance(world: World, ms: number): void {
	world.clock += ms;
	world.time.setTime(world.clock);
}

export const label = (world: World, id: string): string => world.labels.get(id) ?? id;
export const who = (proc: Process): string => `${proc.conversation.id}/${proc.name}`;
export const live = (conversation: Conversation): Process[] => conversation.slots.flatMap((slot) => (slot.process?.alive ? [slot.process] : []));
export const everyProcess = (world: World): Process[] => world.conversations.flatMap((c) => c.slots.flatMap((slot) => (slot.process ? [slot.process] : [])));
const pidAlive = (world: World, pid: number): boolean => pid === PAGE_PID || everyProcess(world).some((p) => p.pid === pid && p.alive);

/** The sources whose rows carry no `[Trigger <id>]`: only a message with the row's words proves one. */
const provedByText = (source: string): boolean => source === "goal" || source === "person" || source.startsWith("inbox:");
/**
 * How `row`'s delivery shows in what the simulated pi wrote: by a hand-over of the row itself, or,
 * for a row only its text proves, by another row's message in the same conversation with the same
 * words, written at or after this row's hand-over stamp. The second is the one thing the engine's
 * text proof cannot tell from the first, by design (docs/design.md decision 23: "Its proof of
 * delivery is a user message whose text starts with the row's … written at or after `handed_at`").
 * A row's words end in a full stop, so none is the start of another's; two messages of the person
 * can be the same words.
 */
export function deliveredBy(world: World, row: Row): Removal["delivered"] {
	const written = world.copies.filter((copy) => copy.sessionId === row.lane && copy.state === "written");
	if (written.some((copy) => copy.rowId === row.id)) return "its own message";
	const stamp = provedByText(row.source) && row.handed_at !== undefined ? Date.parse(row.handed_at) : Number.NaN;
	return written.some((copy) => copy.text === row.payload?.text && copy.writtenAt! >= stamp) ? "another row's message" : undefined;
}
export const findingsFor = (world: World, rowId: string): number => world.inbox.list().filter((entry) => entry.run_id === rowId).length;
/** The states the audit's `request` lines give row `rowId`, newest first, without `failed` and `dead`: those two are not exits a line alone proves. */
/** How many times the audit says row `rowId` became a dead letter. */
export const deadLines = (world: World, rowId: string): number => world.audit.listAudit(Number.MAX_SAFE_INTEGER, (r) => r.type === "request" && r.traceId === rowId && r.state === "dead").length;
export const auditedExits = (world: World, rowId: string): string[] => world.audit.listAudit(Number.MAX_SAFE_INTEGER, (r) => r.type === "request" && r.traceId === rowId && r.state !== "failed" && r.state !== "dead").map((r) => r.state);

/** The copies `process`'s pi holds unwritten. */
export const held = (proc: Process): Copy[] => [proc.pi.current, ...proc.pi.queue].flatMap((item) => (item?.copy ? [item.copy] : []));

/**
 * The hand-overs of row `rowId` that failed, as the simulated pi saw them: one that threw, one pi
 * dropped or refused, and a turn that sat unstarted for `GRACE_MS`, which a tick may judge
 * refused. The engine's `attempts` may count these and nothing else. One more is counted here
 * though pi did not fail: a row pi kept queued behind an aborted turn, which the window takes for
 * dropped (the known defect `KNOWN` names in invariants.ts).
 */
export function failedHandOvers(world: World, rowId: string): number {
	const failed = (copy: Copy) => copy.state === "dropped" || copy.state === "refused" || copy.gaveUp === "stop" || (copy.wake === "turn" && (copy.leftQueueAt ?? world.clock) - copy.handedAt >= GRACE_MS);
	return (world.threw.get(rowId) ?? 0) + world.copies.filter((copy) => copy.rowId === rowId && failed(copy)).length;
}

/* ------------------------------------------------------------ processes */

/** A new process in slot `index` of `conversation`. It takes the lease when no live process has it, and a window takes it from the background process; otherwise it is a viewer. */
export function start(world: World, conversation: Conversation, index: number): Process {
	const slot = conversation.slots[index];
	const base = { pid: world.nextPid++, mode: slot.mode, conversation, alive: true, pi: idlePi() };
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
	return to.kind === "window" && from.mode === "rpc" && to.mode === "tui" && !from.pi.running;
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
function copyFor(world: World, proc: Process, text: string): Copy | undefined {
	const sending = world.sending;
	if (!sending) return undefined;
	const copy: Copy = { rowId: sending.row.id, sessionId: proc.conversation.id, process: proc, text, wake: sending.wake, provedByText: provedByText(sending.row.source), person: sending.row.source === "person", handedAt: world.clock, state: "held" };
	world.copies.push(copy);
	return copy;
}

function write(world: World, proc: Process, item: Item): void {
	const at = world.clock;
	const aborts = proc.pi.aborts;
	// `message_start` first, then `message_end`, then the entry: pi's agent loop emits them back to
	// back, and persists the message that `message_end` gave back, when it gave one.
	// What pi writes of a user message is what the `input` handlers made of it.
	const text = world.rewrites && !item.custom ? `${REWRITTEN}${item.text}` : item.text;
	let message: UserMessage = { role: "user", content: [{ type: "text", text }] };
	if (!item.custom) {
		proc.window?.messageStarted({ role: "user", content: text }, at);
		const ended = (proc.window as unknown as { messageEnded?: (message: UserMessage, at: number) => UserMessage | undefined } | undefined)?.messageEnded?.(message, at);
		if (ended?.role === "user") message = ended;
	}
	proc.conversation.entries.push(item.custom ? { type: "custom_message", timestamp: stampOf(at), content: item.text } : { type: "message", timestamp: stampOf(at), message });
	if (world.ticks) advance(world, 1);
	if (!item.copy) return;
	if (!item.custom) proc.pi.turnOf = item.copy.rowId;
	item.copy.abortedAtStart = proc.pi.aborts > aborts;
	leave(item.copy, "written", at);
	item.copy.writtenAt = at;
	world.facts.written.push(item.copy);
}

function windowProcess(world: World, base: Omit<Process, "executor">): Process {
	const proc = base as Process;
	const conversation = proc.conversation;
	const receive = (text: string, custom: boolean, queued: boolean): void => {
		if (world.handOverThrows) throw new Error("no model selected");
		const item: Item = { text, custom, copy: copyFor(world, proc, text) };
		if (queued) proc.pi.queue.push(item);
		else write(world, proc, item);
	};
	const pi = {
		sendMessage: (message: { content: string }, options?: { triggerTurn?: boolean }) => receive(message.content, true, options?.triggerTurn === true),
		sendUserMessage: (content: string) => receive(content, false, true),
	};
	const ctx = {
		isIdle: () => !proc.pi.running,
		mode: proc.mode,
		hasUI: false,
		// The editor, as an extension reads and sets it: the texts a stop put there, one paragraph each.
		ui: { notify: () => undefined, getEditorText: () => proc.pi.editor.map((item) => item.text).join("\n\n"), setEditorText: (text: string) => void (proc.pi.editor = proc.pi.editor.filter((item) => text.split("\n\n").includes(item.text))) },
		sessionManager: { getEntries: () => conversation.entries },
		abort: () => void (proc.pi.aborts += proc.pi.running ? 1 : 0),
	};
	type Args = ConstructorParameters<typeof WindowExecutor>;
	const window = new WindowExecutor(pi as unknown as Args[0], { here: () => ({ sessionId: conversation.id, holds: conversation.holder === proc }) }, () => ctx as unknown as ReturnType<Args[2]>, { pid: proc.pid }, (row) => row.created_by.left === undefined && pidAlive(world, row.created_by.pid), () => world.store.list(conversation.id), undefined, () => []);
	proc.window = window;
	proc.executor = window;
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
		proof: () => proofOf(() => conversation.entries, () => []),
		view: () => ({ kind: "held", ceiling: CEILING.held, blocked: (row) => (row.wake === "turn" ? "turn rows wait for a window" : undefined), claimLive: () => false, idle: true, inFlight: new Set<string>(), connected: () => true, producerAlive: () => true, mine: () => false }),
		append: (row) => write(world, proc, { text: row.payload?.text ?? "", custom: true, copy: copyFor(world, proc, row.payload?.text ?? "") }),
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

export type PiMove = "start" | "write" | "settle" | "esc" | "refuse" | "type" | "enter";

/** What `process`'s pi can do next; a move listed twice is twice as likely. */
export function piMoves(proc: Process): PiMove[] {
	const pi = proc.pi;
	if (pi.running) return pi.current ? ["write", "write", "settle", "esc"] : ["settle", "esc"];
	// A terminal's editor that a stop filled: the person sends it, or types something else and leaves it.
	const enter: PiMove[] = pi.editor.length ? ["enter"] : [];
	return pi.queue.length ? ["start", "start", "start", "refuse", "type", "type", ...enter] : ["type", ...enter];
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
			// The person's own message: `input`, then a run that starts with it.
			window.inputSeen(at);
			window.personInput();
			pi.running = true;
			pi.startedAt = at;
			window.agentStarted(at);
			write(world, proc, { text: `typed #${++world.made}.`, custom: false });
			break;
		case "enter": {
			// The person sends what a stop put into the editor: one message, the texts joined, and a
			// run that starts with it. Each hand-over whose text is in it is written now, by them.
			const sent = pi.editor.splice(0);
			window.inputSeen(at);
			window.personInput();
			pi.running = true;
			pi.startedAt = at;
			window.agentStarted(at);
			write(world, proc, { text: sent.map((item) => item.text).join("\n\n"), custom: false });
			for (const item of sent) {
				if (!item.copy) continue;
				const copy: Copy = { ...item.copy, state: "written", writtenAt: at, fromTheEditor: true };
				world.copies.push(copy);
				world.facts.written.push(copy);
			}
			break;
		}
		case "settle":
		case "esc": {
			if (pi.current) write(world, proc, pi.current);
			pi.current = undefined;
			// Follow-ups are written in order, unless the turn was stopped: by Esc or the page's Stop
			// (`esc`), or by `ctx.abort()` (one of the follow-ups can ask for it as it starts). A stop in
			// a terminal clears pi's queue and puts the queued user messages into the editor. A stop in
			// the page's pi ends the turn with the rest still queued: pi holds them, and the window,
			// which reads a settled pi's unwritten rows as dropped, stops waiting for them.
			const stopped = move === "esc" || pi.aborts > 0;
			for (const item of pi.queue.splice(0)) {
				if (!stopped) write(world, proc, item);
				else if (proc.mode === "tui") {
					leave(item.copy, "dropped", at);
					if (!item.custom) pi.editor.push(item);
				} else {
					pi.queue.push(item);
					if (item.copy) item.copy.gaveUp ??= "stop";
				}
			}
			Object.assign(pi, { running: false, aborts: 0, startedAt: undefined, turnOf: undefined });
			window.agentEnded();
			window.settled();
			break;
		}
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
			const removal: Removal = { row, delivered: row.kind === "input" ? deliveredBy(world, row) : undefined, findings: findingsFor(world, row.id), dead: deadLines(world, row.id), audited: auditedExits(world, row.id), failures: failedHandOvers(world, row.id), buried: conversation.deleted, heldByRemover: !!remover && held(remover).some((copy) => copy.rowId === row.id && !copy.gaveUp) };
			if (row.kind === "input" && !removal.delivered) removal.ranUnproved = remover?.window?.view(sessionId).ran?.has(row.id) ?? false;
			const target = row.kind !== "input" && row.target && "id" in row.target ? row.target.id : undefined;
			// A pi was handed the named row and has neither written nor lost it; one that refused it in silence counts until a tick judges the refusal: its window cannot know before.
			if (target !== undefined) removal.named = { queued: rows.some((r) => r.id === target && r.kind === "input" && !deliveredBy(world, r)), inFlight: world.copies.some((c) => c.sessionId === sessionId && c.rowId === target && c.process.alive && (c.state === "held" || (c.state === "refused" && c.gaveUp !== "refused"))) };
			if (row.kind === "stop" && remover?.window) {
				const pi = remover.pi;
				removal.removerPi = { running: pi.running, startedAt: pi.startedAt, turnOf: pi.turnOf, aborted: pi.aborts > 0 };
				for (const item of [pi.current, ...pi.queue]) if (item?.copy && item.copy.rowId === target && item.copy.wake === "turn" && !item.copy.gaveUp) item.copy.stopNamed = true;
			}
			world.facts.removals.push(removal);
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
	const handOver = (row: Row, wake: "turn" | "append", call: () => void): void => {
		crash.write();
		const turns = held(proc).filter((copy) => copy.wake === "turn" && !copy.gaveUp);
		const local = row.source === "goal" || row.source.startsWith("inbox:");
		world.facts.handOvers.push({ drain: number, process: proc, row, wake, holds: conversation.holder === proc, queued: world.store.list(conversation.id).some((queued) => queued.id === row.id), producerRunsIt: local && row.created_by.left === undefined && pidAlive(world, row.created_by.pid), piRunning: proc.pi.running, turnsHeld: turns.length, textTurnsHeld: turns.filter((copy) => copy.provedByText && world.clock - copy.handedAt < GRACE_MS).length, written: world.copies.some((copy) => copy.sessionId === conversation.id && copy.rowId === row.id && copy.state === "written" && !copy.fromTheEditor), sentFromTheEditor: world.copies.some((copy) => copy.sessionId === conversation.id && copy.rowId === row.id && copy.state === "written" && copy.fromTheEditor === true) });
		world.sending = { row, wake };
		world.handOverThrows = fault.handOverThrows === true;
		try {
			call();
		} catch (err) {
			world.threw.set(row.id, (world.threw.get(row.id) ?? 0) + 1);
			throw err;
		} finally {
			world.sending = undefined;
			world.handOverThrows = false;
		}
		rowSettled();
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
		abortWhenStarted: (id) => inner.abortWhenStarted(id),
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
