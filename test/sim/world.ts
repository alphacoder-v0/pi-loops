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
 *   follow-ups when it settles, unless the person pressed Esc or a stop aborted the turn: then the
 *   queue is dropped unwritten.
 * - A custom message with no turn asked for is written at once.
 * - The person types into the window: a turn of their own, in words no row has.
 * - A hand-over can throw (no model, no credentials).
 *
 * What it does not do:
 * - A conversation is one list of entries, durable the moment an entry is written, and every process
 *   sees it at once. A real second pi reads its own copy, which can be behind the file.
 * - No model, no tools, no compaction, no images, no MCP server. No extension rewrites a prompt, so
 *   `ExecutorView.ran` stays empty. No window leaves a conversation and lives on
 *   (`created_by.left`), stands aside or runs `pi -p`, so `holderDelivers` is never false.
 * - The lease is a field, not src/lease.ts. It moves as the real one does: from a dead holder to any
 *   live process, from the background process to a window, and between two live windows only while
 *   the holder's pi runs no turn (a terminal taking a conversation from the page's pi).
 * - The page never dies and never takes a message back.
 * - A crash is a process that stops before one of the engine's writes. A write is whole or absent,
 *   as the store's atomic writes are; a torn line is not simulated.
 * - A step is whole. Inside a drain, another process acts only between two of the drain's rows (it
 *   takes the lease, or its pi writes: `Fault`), and the draining window's own pi does not move, not
 *   even while the drain waits on the inbox for a dead letter.
 * - Time is the schedule's: `Date` and `setTimeout` are node:test's mocks, and nothing waits.
 */
import { CEILING, type DrainResult, type EngineSinks, type Executor, bury, conversationView, drain } from "../../src/engine.ts";
import { Inbox } from "../../src/inbox.ts";
import { RequestStore, type SessionRequest } from "../../src/requests.ts";
import { TriggerStore } from "../../src/triggers.ts";
import { WindowExecutor } from "../../src/window-executor.ts";

/** Where every schedule's clock starts. In the past: src/lock.ts compares the clock with a lock directory's real mtime, and a simulated now ahead of it would call every lock stale. */
export const EPOCH = Date.parse("2026-01-01T00:00:00Z");
/** The page's process, which writes the person's messages and lives for the whole schedule. */
export const PAGE_PID = 4242;
/** How long `Inbox.decide` sleeps at most when it finds the inbox locked (src/lock.ts), in simulated time. */
const LOCK_WAIT_MS = 60;
/** How long pi may leave a turn unstarted before a tick may call it refused (docs/design.md), stated apart from the engine's constant on purpose. */
const GRACE_MS = 10_000;

/** node:test's mocked clock, as much of it as the world drives. */
export interface Timers {
	setTime(ms: number): void;
	tick(ms: number): void;
}

type Entry = { type: "message"; timestamp: string; message: { role: "user"; content: Array<{ type: "text"; text: string }> } } | { type: "custom_message"; timestamp: string; content: string };

/**
 * One hand-over, as the simulated pi knows it: which row, to which process, and what became of it.
 * `held` while pi has it unwritten; then `written`, `dropped` (Esc, an aborted turn), `refused`
 * (pi threw before a run) or `died` (its process was killed).
 */
export interface Copy {
	rowId: string;
	sessionId: string;
	text: string;
	wake: "turn" | "append";
	/** The row carries no `[Trigger <id>]`: only a message with its words proves it. */
	provedByText: boolean;
	handedAt: number;
	state: "held" | "written" | "dropped" | "refused" | "died";
	/** When pi took it up, or let it go: until then it sat unstarted. */
	leftQueueAt?: number;
	/** The engine gave it up while pi still held it (a refusal judged, the lease moved away): a write after that is a late send. */
	late: boolean;
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
	/** `ctx.abort()` was called in this turn: its follow-ups are dropped when it settles. */
	aborted: boolean;
}

export interface Process {
	pid: number;
	name: string;
	kind: "window" | "background";
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
	slots: Array<{ kind: Process["kind"]; process?: Process }>;
	goalActive: boolean;
}

/** A row taken out of a queue, with what could account for it read at that instant, before the removal. */
export interface Removal {
	row: SessionRequest;
	proved: boolean;
	findings: number;
	/** The exit states the audit holds for the row, newest first. */
	audited: string[];
	failures: number;
	buried: boolean;
	/** The pi of the process that removes the row holds its turn, handed over and unwritten. */
	heldByRemover: boolean;
	/** Set by the check that names the exit (invariants.ts). */
	exit?: string;
}

/** A row handed to pi, or written by the background process, with the state of things at that instant. */
export interface HandOver {
	drain: number;
	process: Process;
	row: SessionRequest;
	wake: "turn" | "append";
	holds: boolean;
	/** The row is one a window runs itself (a claim, its goal's continuation), and the window that produced it is alive. */
	producerRunsIt: boolean;
	piRunning: boolean;
	/** Turns this pi held unwritten and the engine had not given up: all of them, and those proved only by their text. */
	turnsHeld: number;
	textTurnsHeld: number;
	proved: boolean;
}

/** Two decisions on one finding at once. */
export interface Decided {
	was: string;
	ok: number;
	/** Hand-off rows that are queued though their claim lost. */
	stray: number;
}

/** What happened in the step being applied, as it happened; the invariants read it after the step. */
export interface Facts {
	removals: Removal[];
	handOvers: HandOver[];
	written: Copy[];
	decided: Decided[];
	/**
	 * The conversations whose queue file something wrote to, and whether anything wrote to the inbox.
	 * Every write of a schedule goes through a producer of schedule.ts or the watched store and sinks
	 * below, so a file nobody touched is read again by no check: reading two queues and the inbox
	 * after each of eighty thousand steps was a third of the run.
	 */
	queuesWritten: Set<string>;
	inboxWritten: boolean;
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
	sending?: { row: SessionRequest; wake: "turn" | "append" };
	handOverThrows: boolean;
}

/** A world of one conversation for each of `seconds`: its first process is a window, started; its second is of `kind`, started when `running`. */
export function createWorld(dir: string, time: Timers, seconds: ReadonlyArray<{ kind: Process["kind"]; running: boolean }>): World {
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
		copies: [],
		threw: new Map(),
		targeted: new Set(),
		malformed: new Set(),
		tampered: new Set(),
		facts: noFacts(),
		drains: 0,
		crashes: 0,
		handOverThrows: false,
	};
	time.setTime(EPOCH);
	for (const [index, second] of seconds.entries()) {
		const conversation: Conversation = { id: `c${index}`, entries: [], deleted: false, goalActive: true, slots: [{ kind: "window" }, { kind: second.kind }] };
		world.conversations.push(conversation);
		start(world, conversation, 0);
		if (second.running) start(world, conversation, 1);
	}
	return world;
}

export const noFacts = (): Facts => ({ removals: [], handOvers: [], written: [], decided: [], queuesWritten: new Set(), inboxWritten: false });

export function advance(world: World, ms: number): void {
	world.clock += ms;
	world.time.setTime(world.clock);
}

export const label = (world: World, id: string): string => world.labels.get(id) ?? id;
export const who = (proc: Process): string => `${proc.conversation.id}/${proc.name}`;
export const live = (conversation: Conversation): Process[] => conversation.slots.flatMap((slot) => (slot.process?.alive ? [slot.process] : []));
export const everyProcess = (world: World): Process[] => world.conversations.flatMap((c) => c.slots.flatMap((slot) => (slot.process ? [slot.process] : [])));
const pidAlive = (world: World, pid: number): boolean => pid === PAGE_PID || everyProcess(world).some((p) => p.pid === pid && p.alive);

const textOf = (entry: Entry): string => (entry.type === "message" ? entry.message.content[0].text : entry.content);
/**
 * How many entries of the conversation carry exactly `text`. Every row of a schedule has words of
 * its own that end in a full stop, so none is the start of another's (the engine proves a
 * text-proved row by a message that starts with its text), and this counts the row's deliveries.
 */
export const timesWritten = (conversation: Conversation, text: string): number => conversation.entries.filter((entry) => textOf(entry) === text).length;
export const findingsFor = (world: World, rowId: string): number => world.inbox.list().filter((entry) => entry.run_id === rowId).length;
/** The states the audit's `request` lines give row `rowId`, newest first, without `failed` and `dead`: those two are not exits a line alone proves. */
export const auditedExits = (world: World, rowId: string): string[] => world.audit.listAudit(Number.MAX_SAFE_INTEGER, (r) => r.type === "request" && r.traceId === rowId && r.state !== "failed" && r.state !== "dead").map((r) => r.state);

/** The copies `process`'s pi holds unwritten. */
export const held = (proc: Process): Copy[] => [proc.pi.current, ...proc.pi.queue].flatMap((item) => (item?.copy ? [item.copy] : []));

/**
 * The hand-overs of row `rowId` that failed, as the simulated pi saw them: one that threw, one pi
 * dropped or refused, and a turn that sat unstarted for `GRACE_MS`, which a tick may judge
 * refused. The engine's `attempts` may count these and nothing else.
 */
export function failedHandOvers(world: World, rowId: string): number {
	const failed = (copy: Copy) => copy.state === "dropped" || copy.state === "refused" || (copy.wake === "turn" && (copy.leftQueueAt ?? world.clock) - copy.handedAt >= GRACE_MS);
	return (world.threw.get(rowId) ?? 0) + world.copies.filter((copy) => copy.rowId === rowId && failed(copy)).length;
}

/* ------------------------------------------------------------ processes */

/** A new process in slot `index` of `conversation`. It takes the lease when no live process has it, and a window takes it from the background process; otherwise it is a viewer. */
export function start(world: World, conversation: Conversation, index: number): Process {
	const slot = conversation.slots[index];
	const base = { pid: world.nextPid++, conversation, alive: true, pi: { running: false, queue: [], aborted: false } };
	const proc = slot.kind === "window" ? windowProcess(world, { ...base, name: `w${index}`, kind: "window" }) : backgroundProcess(world, { ...base, name: "bg", kind: "background" });
	slot.process = proc;
	if (!conversation.holder?.alive || (conversation.holder.kind === "background" && proc.kind === "window")) conversation.holder = proc;
	return proc;
}

/** The process is gone, and with it everything pi was handed and had not written. */
export function kill(world: World, proc: Process): void {
	proc.alive = false;
	for (const copy of held(proc)) leave(copy, "died", world.clock);
	proc.pi = { running: false, queue: [], aborted: false };
}

/** Whether `to` can take the lease now: from a dead holder always, from the background process when `to` is a window, from a live window when `to` is a window and that holder's pi runs no turn. */
export function leaseMayMove(conversation: Conversation, to: Process): boolean {
	const from = conversation.holder;
	if (!to.alive || from === to) return false;
	if (!from?.alive) return true;
	if (from.kind === "background") return to.kind === "window";
	return to.kind === "window" && !from.pi.running;
}

/** The lease goes to `to`. What the old holder's pi still holds is nobody's to wait for now: the new holder cannot see it. */
export function moveLease(conversation: Conversation, to: Process): void {
	if (conversation.holder?.alive) for (const copy of held(conversation.holder)) copy.late = true;
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
	const source = sending.row.source;
	const copy: Copy = { rowId: sending.row.id, sessionId: proc.conversation.id, text, wake: sending.wake, provedByText: source === "goal" || source === "person" || source.startsWith("inbox:"), handedAt: world.clock, state: "held", late: false };
	world.copies.push(copy);
	return copy;
}

function write(world: World, proc: Process, item: Item): void {
	const at = world.clock;
	// `message_start` first, then the entry: pi's agent loop emits the two back to back.
	if (!item.custom) proc.window?.messageStarted({ role: "user", content: item.text }, at);
	proc.conversation.entries.push(item.custom ? { type: "custom_message", timestamp: stampOf(at), content: item.text } : { type: "message", timestamp: stampOf(at), message: { role: "user", content: [{ type: "text", text: item.text }] } });
	if (!item.copy) return;
	leave(item.copy, "written", at);
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
		mode: "tui",
		hasUI: false,
		ui: { notify: () => undefined },
		sessionManager: { getEntries: () => conversation.entries },
		abort: () => void (proc.pi.aborted = proc.pi.running),
	};
	type Args = ConstructorParameters<typeof WindowExecutor>;
	const window = new WindowExecutor(pi as unknown as Args[0], { here: () => ({ sessionId: conversation.id, holds: conversation.holder === proc }) }, () => ctx as unknown as ReturnType<Args[2]>, { pid: proc.pid }, (row) => row.created_by.left === undefined && pidAlive(world, row.created_by.pid), () => world.store.list(conversation.id));
	proc.window = window;
	proc.executor = window;
	return proc;
}

/** The background process on a closed conversation, as src/host-runtime.ts builds it: `append` rows only, written into the file at once. */
function backgroundProcess(world: World, base: Omit<Process, "executor">): Process {
	const proc = base as Process;
	const conversation = proc.conversation;
	proc.executor = {
		holds: () => proc.alive && conversation.holder === proc,
		entries: () => conversationView(() => conversation.entries),
		view: () => ({ kind: "held", ceiling: CEILING.held, admits: (row) => row.wake !== "turn", idle: true, inFlight: new Set<string>(), connected: () => true, producerAlive: () => true, mine: () => false }),
		append: (row) => write(world, proc, { text: row.payload?.text ?? "", custom: true, copy: copyFor(world, proc, row.payload?.text ?? "") }),
		turn: () => {
			throw new Error("the background process does not run turn requests yet");
		},
		abort: () => undefined,
		abortWhenStarted: () => undefined,
		refused: () => undefined,
	};
	return proc;
}

/* ------------------------------------------------------------ pi's moves */

export type PiMove = "start" | "write" | "settle" | "esc" | "refuse" | "type";

/** What `process`'s pi can do next; a move listed twice is twice as likely. */
export function piMoves(proc: Process): PiMove[] {
	const pi = proc.pi;
	if (pi.running) return pi.current ? ["write", "write", "settle", "esc"] : ["settle", "settle", "esc"];
	return pi.queue.length ? ["start", "start", "start", "refuse", "type"] : ["type"];
}

export function piMove(world: World, proc: Process, move: PiMove): void {
	const pi = proc.pi;
	const window = proc.window!;
	const at = world.clock;
	switch (move) {
		case "start":
			pi.running = true;
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
			window.agentStarted(at);
			write(world, proc, { text: `typed #${++world.made}.`, custom: false });
			break;
		case "settle":
		case "esc":
			if (pi.current) write(world, proc, pi.current);
			pi.current = undefined;
			// Follow-ups are written in order; Esc, or an abort (which one of them can ask for as it starts), drops the rest.
			for (const item of pi.queue.splice(0)) {
				if (move === "esc" || pi.aborted) leave(item.copy, "dropped", at);
				else write(world, proc, item);
			}
			pi.running = false;
			pi.aborted = false;
			window.agentEnded();
			window.settled();
			break;
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
		world.facts.queuesWritten.add(sessionId);
		return real.update(sessionId, id, patch);
	};
	watched.remove = (sessionId, ids) => {
		const gone = [...ids];
		fuse.write();
		world.facts.queuesWritten.add(sessionId);
		const conversation = world.conversations.find((c) => c.id === sessionId)!;
		for (const row of real.list(sessionId)) {
			if (!gone.includes(row.id)) continue;
			world.facts.removals.push({ row, proved: row.kind === "input" && timesWritten(conversation, row.payload?.text ?? "") > 0, findings: findingsFor(world, row.id), audited: auditedExits(world, row.id), failures: failedHandOvers(world, row.id), buried: conversation.deleted, heldByRemover: !!remover && held(remover).some((copy) => copy.rowId === row.id && !copy.late) });
		}
		real.remove(sessionId, gone);
		removed();
	};
	return watched;
}

function watchedSinks(world: World, fuse: Fuse): EngineSinks {
	return {
		jobs: { exists: (id) => world.jobs.get(id)?.exists ?? false, enabled: (id) => world.jobs.get(id)?.enabled ?? false, goalActive: (sessionId) => world.conversations.find((c) => c.id === sessionId)?.goalActive ?? false },
		inbox: {
			append: async (entry) => {
				fuse.write();
				world.facts.inboxWritten = true;
				return world.inbox.append(entry);
			},
			appendOnce: async (entry, key, opts) => {
				fuse.write();
				world.facts.inboxWritten = true;
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
	const handOver = (row: SessionRequest, wake: "turn" | "append", call: () => void): void => {
		crash.write();
		const turns = held(proc).filter((copy) => copy.wake === "turn" && !copy.late);
		const local = row.source === "goal" || row.source.startsWith("inbox:");
		world.facts.handOvers.push({ drain: number, process: proc, row, wake, holds: conversation.holder === proc, producerRunsIt: local && row.created_by.left === undefined && pidAlive(world, row.created_by.pid), piRunning: proc.pi.running, turnsHeld: turns.length, textTurnsHeld: turns.filter((copy) => copy.provedByText).length, proved: timesWritten(conversation, row.payload?.text ?? "") > 0 });
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
		entries: (sessionId) => inner.entries(sessionId),
		turn: (row, at) => handOver(row, "turn", () => inner.turn(row, at)),
		append: (row, wakeAgent) => handOver(row, "append", () => inner.append(row, wakeAgent)),
		abort: () => inner.abort(),
		abortWhenStarted: (id) => inner.abortWhenStarted(id),
		refused: (id) => {
			// The engine stops waiting for this hand-over; if pi still has it, pi may yet send it late.
			for (const copy of held(proc)) if (copy.rowId === id) copy.late = true;
			inner.refused(id);
		},
	};
	try {
		return await drain(conversation.id, watchedStore(world, crash, proc, rowSettled), executor, world.clock, watchedSinks(world, crash), { tick });
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
 * Two decisions on one finding at once. The first call runs its critical section before it returns
 * its promise; the second finds the lock taken and sleeps on a timer, which the simulated clock ends.
 */
export async function decideTwice(world: World, entryId: string, decisions: ReadonlyArray<{ to: "claimed" | "dismissed"; by?: string; before?: () => void }>): Promise<number> {
	world.facts.inboxWritten = true;
	const calls = decisions.map((d) => world.inbox.decide(entryId, d.to, { by: d.by, before: d.before }));
	const results = [await calls[0]];
	world.time.tick(LOCK_WAIT_MS);
	world.clock += LOCK_WAIT_MS;
	results.push(await calls[1]);
	return results.filter((result) => "ok" in result).length;
}
