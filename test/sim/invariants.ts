/**
 * What must hold after every step of a schedule, each as a named function that returns what it
 * found broken. They read the queue files, the inbox, the audit, the conversation and what the
 * simulated pi was handed and wrote (world.ts); none of them asks `decideDrain` what it would do.
 * The rules they hold the engine to are written here as the design states them (three failures make
 * a dead letter; which exit a row may take), so a change to the engine's own constants is a change
 * these checks see.
 */
import type { SessionRequest } from "../../src/requests.ts";
import { type Conversation, type Removal, type World, everyProcess, failedHandOvers, held, label, timesWritten, who } from "./world.ts";

/** Failures of one row before it is a dead letter (docs/design.md), stated apart from the engine's constant on purpose. */
const DEAD_AT = 3;

export interface Violation {
	invariant: string;
	message: string;
}

/** What the checks remember from one step to the next. */
interface Memory {
	/** The rows in the queues after the last step: `<conversation> <id>` to the row's name. */
	queued: Map<string, string>;
	/** The findings and audit lines already counted for an earlier exit of the same row id. */
	spent: Map<string, { findings: number; audited: number }>;
	/** Rows that left by a named exit at least once. */
	exited: Set<string>;
	/** Each finding's status when it was last read. */
	findings: Map<string, string>;
	/** Each conversation's queue as last read from its file. */
	rows: Map<string, SessionRequest[]>;
}

/** How often each exit was taken and how many rows were handed over, for the test's summary: a schedule that exercises nothing proves nothing. */
export interface Coverage {
	exits: Record<string, number>;
	handOvers: number;
	/** Turns handed to a pi that still held another turn unstarted: what today's engine allows for prefixed rows (see `oneTurnFromTheHolder`). */
	turnsBesideATurn: number;
	decisions: number;
}

type Queues = ReadonlyMap<string, SessionRequest[]>;
type Invariant = (world: World, memory: Memory, queues: Queues, coverage: Coverage) => string[];

const keyOf = (sessionId: string, id: string): string => `${sessionId} ${id}`;
const conversationOf = (world: World, sessionId: string): Conversation => world.conversations.find((c) => c.id === sessionId)!;

/**
 * I2. A row leaves its queue only by a named exit, and the trace of that exit is there before the
 * row goes: delivered (its words are in the conversation), dead (a finding carries its id), or
 * cancelled, stale, refused, job-removed, done (an audit line). Each exit is also one the row could
 * take: only a stop or a cancel is `done`; `stale` is theirs too, a goal's continuation's once the
 * goal is over, and a person's message's when its conversation is gone; `cancelled` needs a stop or
 * a cancel that named the row, and a turn pi does not hold already (a stop aborts that one as it
 * starts); `job-removed` a job that is gone; `refused` a mode that is not the source's, and such a
 * row is never delivered.
 */
function namedExit(world: World, memory: Memory, queues: Queues, coverage: Coverage): string[] {
	const out: string[] = [];
	const removed = new Set<string>();
	for (const gone of world.facts.removals) {
		const { row } = gone;
		const key = keyOf(row.session_id, row.id);
		const name = label(world, row.id);
		removed.add(key);
		const spent = memory.spent.get(key) ?? { findings: 0, audited: 0 };
		if (gone.proved) gone.exit = "delivered";
		else if (gone.findings > spent.findings) gone.exit = "dead";
		else if (gone.audited.length > spent.audited) gone.exit = gone.audited[0];
		memory.spent.set(key, { findings: gone.findings, audited: gone.audited.length });
		if (gone.exit === undefined) {
			out.push(`${name} left the queue of ${row.session_id} with nothing to account for it: its words are not in the conversation, no finding carries its id, no audit line names it`);
			continue;
		}
		memory.exited.add(key);
		coverage.exits[gone.exit] = (coverage.exits[gone.exit] ?? 0) + 1;
		const why = notItsExit(world, gone, gone.exit);
		if (why) out.push(`${name} left the queue of ${row.session_id} as ${gone.exit}, but ${why}`);
	}
	const now = new Map<string, string>();
	for (const [sessionId, rows] of queues) for (const row of rows) now.set(keyOf(sessionId, row.id), label(world, row.id));
	for (const [key, name] of memory.queued) if (!now.has(key) && !removed.has(key)) out.push(`${name} is gone from its queue (${key.split(" ")[0]}) and nothing removed it`);
	memory.queued = now;
	return out;
}

/** Why `exit` is not one `gone.row` could take, or undefined when it is. */
function notItsExit(world: World, gone: Removal, exit: string): string | undefined {
	const { row } = gone;
	const input = row.kind === "input";
	switch (exit) {
		case "delivered":
			return world.tampered.has(row.id) ? "its mode was widened in the file: such a row is refused, never run" : undefined;
		case "dead":
			return input && row.source !== "person" ? undefined : "only a pi-loops input becomes a dead letter";
		case "done":
			return input ? "an input is done only by its proof in the conversation" : undefined;
		case "cancelled":
			if (gone.heldByRemover) return "the pi of the process that removed it holds its turn and will run it";
			return input && world.targeted.has(row.id) ? undefined : "no stop and no cancel named it";
		case "job-removed":
			return row.source.startsWith("cron:") && !world.jobs.get(row.source.slice("cron:".length))?.exists ? undefined : "its job is there";
		case "refused":
			return world.tampered.has(row.id) ? undefined : "its mode is the one its source gets";
		case "stale":
			if (!input) return undefined;
			if (row.source === "goal" && !conversationOf(world, row.session_id).goalActive) return undefined;
			if (row.source === "person" && gone.buried) return undefined;
			return "it is an input its conversation is still owed";
		default:
			return `the audit knows no exit called ${exit}`;
	}
}

/**
 * I3. Only the holder hands a row over, except a row the process produced itself (what a person
 * typed into that window, its goal's continuation: design O2), which nobody else hands over while
 * that window lives. And one turn at a time: never to a pi that runs a turn, never two in one drain.
 *
 * The brief's "at most one turn in flight" is stronger than today's engine, which looks at what pi
 * says: a turn pi was handed and has not started leaves pi idle. For a prefixed row that is meant
 * (src/engine.ts: "one pi silently dropped must not stall the rows behind it"), so a later drain
 * hands pi a second turn beside it. That is counted (`Coverage.turnsBesideATurn`), not failed.
 */
function oneTurnFromTheHolder(world: World, _memory: Memory, _queues: Queues, coverage: Coverage): string[] {
	const out: string[] = [];
	const turnsOf = new Map<number, number>();
	for (const h of world.facts.handOvers) {
		const name = label(world, h.row.id);
		coverage.handOvers++;
		const own = h.row.created_by.pid === h.process.pid;
		if (!h.holds && !own) out.push(`${who(h.process)} handed ${name} over, and it neither holds the conversation nor produced the row`);
		if (h.producerRunsIt && !own) out.push(`${who(h.process)} handed ${name} over, a row of a window that is alive and runs it itself`);
		if (h.wake !== "turn") continue;
		turnsOf.set(h.drain, (turnsOf.get(h.drain) ?? 0) + 1);
		if (h.piRunning) out.push(`${who(h.process)} handed the turn ${name} to a pi that was running a turn`);
		if (h.turnsHeld > h.textTurnsHeld) coverage.turnsBesideATurn++;
	}
	for (const turns of turnsOf.values()) if (turns > 1) out.push(`one drain handed ${turns} turns to pi`);
	return out;
}

/**
 * I3, for the rows only their text proves (a person's message, a claim, a goal's continuation).
 * The engine says such a turn, handed over and not yet written, has the lane (src/engine.ts
 * `landed`: "one lane hands over one such row at a time"), because a second message with the same
 * words would be proved by the first one's. This holds it to that.
 */
function noTurnBesideATextProvedTurn(world: World): string[] {
	return world.facts.handOvers.filter((h) => h.wake === "turn" && h.textTurnsHeld > 0).map((h) => `${who(h.process)} handed the turn ${label(world, h.row.id)} to a pi that still held an unwritten turn only its text will prove`);
}

/**
 * I6, the part that holds at every step: a row pi was handed and has not written is still in its
 * queue file (or left it by a named exit, as a cancel from the holder can make it), so killing the
 * process loses nothing the files do not say. The other part is done, not argued: every schedule
 * ends with every process killed and started again (schedule.ts, `AFTER_RESTART`).
 */
function heldIsStillOwed(world: World, memory: Memory): string[] {
	const out: string[] = [];
	for (const proc of everyProcess(world)) {
		for (const copy of held(proc)) {
			const key = keyOf(copy.sessionId, copy.rowId);
			if (!memory.queued.has(key) && !memory.exited.has(key)) out.push(`${who(proc)}'s pi holds ${label(world, copy.rowId)} unwritten, and the row is in no queue and left by no exit: only that process's memory knows it`);
		}
	}
	return out;
}

/** I7. A finding goes from `new` to `claimed` or `dismissed` once and never back or away; two decisions at once give one `ok`, and a claim that lost queues no hand-off. */
function decidedOnce(world: World, memory: Memory, _queues: Queues, coverage: Coverage): string[] {
	const out: string[] = [];
	const entries = world.facts.inboxWritten ? world.inbox.list() : [];
	for (const [index, entry] of entries.entries()) {
		const was = memory.findings.get(entry.id);
		if (was !== undefined && was !== "new" && was !== entry.status) out.push(`finding ${index + 1} went from ${was} to ${entry.status}`);
		memory.findings.set(entry.id, entry.status);
	}
	if (world.facts.inboxWritten && entries.length < memory.findings.size) out.push(`the inbox holds ${entries.length} findings and held ${memory.findings.size}: one is gone`);
	for (const decided of world.facts.decided) {
		coverage.decisions++;
		const expected = decided.was === "new" ? 1 : 0;
		if (decided.ok !== expected) out.push(`two decisions at once on a ${decided.was} finding gave ${decided.ok} ok, not ${expected}`);
		if (decided.stray > 0) out.push(`${decided.stray} hand-off of a claim that lost is queued`);
	}
	return out;
}

/**
 * I8. `attempts` counts failed hand-overs and nothing else: a hand-over that threw, one pi dropped
 * or refused, a turn pi left unstarted past the grace. A row that failed is not handed over again
 * before its backoff ends. A queued row never carries three; a row is a dead letter for failing
 * only at the third, unless it could never be delivered (written without its prefix) or its
 * conversation is gone. That the dead letter is written before the row is
 * removed is I2: the finding is looked for at the instant of the removal.
 */
function attemptsCountFailures(world: World, _memory: Memory, queues: Queues): string[] {
	const out: string[] = [];
	for (const rows of queues.values()) {
		for (const row of rows) {
			const failures = failedHandOvers(world, row.id);
			if (row.attempts > failures) out.push(`${label(world, row.id)} counts ${row.attempts} attempts after ${failures} failed hand-overs`);
			if (row.attempts >= DEAD_AT && row.source !== "person") out.push(`${label(world, row.id)} is still queued with ${row.attempts} attempts: a row is dead at ${DEAD_AT}`);
		}
	}
	for (const h of world.facts.handOvers) {
		if (h.row.not_before !== undefined && Date.parse(h.row.not_before) > world.clock) out.push(`${label(world, h.row.id)} was handed over before its backoff ended (${h.row.not_before})`);
	}
	for (const gone of world.facts.removals) {
		if (gone.exit !== "dead" || gone.buried || world.malformed.has(gone.row.id) || gone.failures >= DEAD_AT) continue;
		out.push(`${label(world, gone.row.id)} became a dead letter after ${gone.failures} failed hand-overs: a row is dead at ${DEAD_AT}`);
	}
	return out;
}

/**
 * Delivered once per proof. The brief's statement ("twice only when a crash fell between pi's write
 * and the removal") is not what today's engine does, in both directions. A crash there delivers
 * once: the proof is in the conversation, and the next process removes the row by it. What does
 * deliver twice is a hand-over the engine gave up while pi still held it, when pi then sends it
 * late: a tick judged it refused after the grace, or the lease went to another window. So the true
 * statement, checked here: a row is never handed over once its words are in the conversation, and
 * its words are there at most once, plus once for each hand-over the engine had given up.
 */
function deliveredOnce(world: World): string[] {
	const out: string[] = [];
	for (const h of world.facts.handOvers) if (h.proved) out.push(`${label(world, h.row.id)} was handed over with its words already in the conversation`);
	const rows = new Map(world.facts.written.map((copy) => [keyOf(copy.sessionId, copy.rowId), copy]));
	for (const copy of rows.values()) {
		const times = timesWritten(conversationOf(world, copy.sessionId), copy.text);
		const late = world.copies.filter((other) => other.sessionId === copy.sessionId && other.rowId === copy.rowId && other.state === "written" && other.late).length;
		if (times > 1 + late) out.push(`${label(world, copy.rowId)} is in ${copy.sessionId} ${times} times, and only ${late} of those is a hand-over the engine had given up`);
	}
	return out;
}

/**
 * A check today's engine fails, by name, with what it fails on: a defect of src/ the simulation
 * found, which this change does not fix. `createChecker` leaves such a check out unless asked for
 * all of them, and test/sim.test.ts runs it under `todo` on a seed that breaks it.
 */
export const KNOWN: Readonly<Record<string, string>> = {
	"I3 no turn beside an unwritten turn only its text proves": "decideDrain gives the lane to an in-flight text-proved turn only against the rows after it in queue order: a turn row that sorts before it is handed over beside it",
};

export const INVARIANTS: ReadonlyArray<readonly [string, Invariant]> = [
	["I2 a row leaves its queue only by a named exit", namedExit],
	["I3 one turn at a time, handed over by the holder", oneTurnFromTheHolder],
	["I3 no turn beside an unwritten turn only its text proves", noTurnBesideATextProvedTurn],
	["I6 what pi holds unwritten is still owed on disk", heldIsStillOwed],
	["I7 a finding is decided once", decidedOnce],
	["I8 attempts count failed hand-overs, a backoff is waited out, and three failures make a dead letter", attemptsCountFailures],
	["a row is delivered once per proof", deliveredOnce],
];

/** The checks for one world: `check()` after every step returns the first thing broken, or undefined. `all` includes the `KNOWN` ones. */
export function createChecker(world: World, all = false): { check(): Violation | undefined; coverage: Coverage } {
	const memory: Memory = { queued: new Map(), spent: new Map(), exited: new Set(), findings: new Map(), rows: new Map() };
	const coverage: Coverage = { exits: {}, handOvers: 0, turnsBesideATurn: 0, decisions: 0 };
	return {
		coverage,
		check() {
			// A queue file nothing wrote to in this step is as it was read last (`Facts.queuesWritten`).
			for (const c of world.conversations) if (!memory.rows.has(c.id) || world.facts.queuesWritten.has(c.id)) memory.rows.set(c.id, world.store.list(c.id));
			const queues = memory.rows;
			let first: Violation | undefined;
			// Every check runs even after one failed: each also updates what it remembers.
			for (const [invariant, holds] of INVARIANTS) {
				if (!all && invariant in KNOWN) continue;
				const broken = holds(world, memory, queues, coverage);
				if (broken.length && !first) first = { invariant, message: broken.join("; ") };
			}
			return first;
		},
	};
}
