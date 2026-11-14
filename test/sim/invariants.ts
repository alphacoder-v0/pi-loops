/**
 * What must hold after every step of a schedule, each as a named function that returns what it
 * found broken. They read the queue files, the inbox, the audit, the conversation and what the
 * simulated pi was handed and wrote (world.ts); none of them asks `decideDrain` what it would do.
 * The rules they hold the engine to are written here as the design states them (three failures make
 * a dead letter; which exit a row may take), so a change to the engine's own constants is a change
 * these checks see.
 */
import type { SessionRequest } from "../../src/requests.ts";
import { type Conversation, type Copy, type Removal, type World, everyProcess, failedHandOvers, held, label, who } from "./world.ts";

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
	/** Hand-overs of a row that has left its queue since: what a stop asked of them is over. */
	released: Set<Copy>;
	/** Rows that left as delivered on another row's message with the same words: still owed a message of their own. */
	owedItsOwn: Map<string, { sessionId: string; rowId: string }>;
}

/** How often each exit was taken and how many rows were handed over, for the test's summary: a schedule that exercises nothing proves nothing. */
export interface Coverage {
	exits: Record<string, number>;
	handOvers: number;
	/** Turns handed to a pi that still held another turn unstarted: what today's engine allows for prefixed rows (see `oneTurnFromTheHolder`). */
	turnsBesideATurn: number;
	decisions: number;
	/** Rows delivered a second time by a hand-over offered again after a refusal, which the design accepts: prefixed rows, and rows only their text proves. */
	offeredAgainTwice: { prefixed: number; byText: number };
	/** Rows that left as delivered on another row's message with the same words, which the text proof cannot tell apart. */
	provedByAnother: number;
}

type Queues = ReadonlyMap<string, SessionRequest[]>;
/** `end`: the schedule is over, the restart that ends it included. */
type Invariant = (world: World, memory: Memory, queues: Queues, coverage: Coverage, end: boolean) => string[];

const keyOf = (sessionId: string, id: string): string => `${sessionId} ${id}`;
const conversationOf = (world: World, sessionId: string): Conversation => world.conversations.find((c) => c.id === sessionId)!;

/**
 * I2. A row leaves its queue only by a named exit, and the trace of that exit is there before the
 * row goes: delivered (pi wrote the row), dead (a finding carries its id), or
 * cancelled, stale, refused, job-removed, done (an audit line). Each exit is also one the row could
 * take: only a stop or a cancel is `done`; `stale` is theirs too, a goal's continuation's once the
 * goal is over, and a person's message's when its conversation is gone; `cancelled` needs a stop or
 * a cancel that named the row, and a turn pi does not hold already (a stop aborts that one as it
 * starts); `job-removed` a job that is gone; `refused` a mode that is not the source's, and such a
 * row is never delivered.
 *
 * `delivered` needs a message pi wrote for that row itself, with one excuse, which is counted
 * (`Coverage.provedByAnother`): another row's message with the same words, written at or after this
 * row's hand-over stamp, which the engine's text proof takes for this row's by design (world.ts
 * `deliveredBy`).
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
		if (gone.delivered) gone.exit = "delivered";
		else if (gone.findings > spent.findings) gone.exit = "dead";
		else if (gone.audited.length > spent.audited) gone.exit = gone.audited[0];
		// The window's word that the row's turn ran, which no file proves: an exit the engine has, held under `KNOWN`.
		else if (gone.ranUnproved) gone.exit = "ran";
		memory.spent.set(key, { findings: gone.findings, audited: gone.audited.length });
		if (gone.exit === undefined) {
			out.push(`${name} left the queue of ${row.session_id} with nothing to account for it: pi wrote no message for it, no finding carries its id, no audit line names it`);
			continue;
		}
		memory.exited.add(key);
		for (const copy of world.copies) if (copy.sessionId === row.session_id && copy.rowId === row.id) memory.released.add(copy);
		coverage.exits[gone.exit] = (coverage.exits[gone.exit] ?? 0) + 1;
		if (gone.delivered === "another row's message") {
			coverage.provedByAnother++;
			memory.owedItsOwn.set(key, { sessionId: row.session_id, rowId: row.id });
		}
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
		case "ran":
			return undefined;
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
 * I2, for a row that left as delivered on another row's message with the same words. The text
 * proof cannot tell the two apart, and that is harmless when pi writes both in the end, which
 * takes a hand-over of the row's own that pi still holds when the row leaves: once out of the
 * queue it is never handed over again. So when the schedule is over (`end`), pi has written the
 * row itself or still holds it; otherwise the person said the same words twice and was answered
 * once.
 */
function answeredThoughAnotherSaidTheSame(world: World, memory: Memory, _queues: Queues, _coverage: Coverage, end: boolean): string[] {
	if (!end) return [];
	const out: string[] = [];
	for (const { sessionId, rowId } of memory.owedItsOwn.values()) {
		const copies = world.copies.filter((copy) => copy.sessionId === sessionId && copy.rowId === rowId);
		if (!copies.some((copy) => copy.state === "written" || copy.state === "held")) out.push(`${label(world, rowId)} left the queue of ${sessionId} as delivered on another row's message with the same words, and pi never wrote it: two messages, one answer`);
	}
	return out;
}

/**
 * I2, for the one exit no file proves: the window removes a row as done because a turn began with
 * a message that carried no prefix, which it takes for the row's own prompt, rewritten by another
 * extension. Nothing rewrites a prompt in the simulation, so every such exit is a row removed that
 * pi had not written.
 */
function doneOnlyByProof(world: World): string[] {
	return world.facts.removals.filter((gone) => gone.exit === "ran").map((gone) => `${label(world, gone.row.id)} left the queue of ${gone.row.session_id} as done on the window's word that its turn ran, and pi had not written it`);
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
 * words would be proved by the first one's. This holds it to that, for a turn still inside the
 * grace after its hand-over: past it a tick may call the hand-over refused, which ends the claim.
 */
function noTurnBesideATextProvedTurn(world: World): string[] {
	return world.facts.handOvers.filter((h) => h.wake === "turn" && h.textTurnsHeld > 0).map((h) => `${who(h.process)} handed the turn ${label(world, h.row.id)} to a pi that still held an unwritten turn only its text will prove`);
}

/**
 * I6, the part that holds at every step: a row pi was handed and has not written is still in its
 * queue file (or left it by a named exit, as a cancel from the holder can make it), so killing the
 * process loses nothing the files do not say; and a row is in its queue when it is handed over.
 * The other part is done, not argued: every schedule ends with every process killed and started
 * again (schedule.ts, `AFTER_RESTART`).
 */
function heldIsStillOwed(world: World, memory: Memory): string[] {
	const out: string[] = world.facts.handOvers.filter((h) => !h.queued).map((h) => `${who(h.process)} handed ${label(world, h.row.id)} over, and the row is not in its queue`);
	for (const proc of everyProcess(world)) {
		for (const copy of held(proc)) {
			const key = keyOf(copy.sessionId, copy.rowId);
			if (!memory.queued.has(key) && !memory.exited.has(key)) out.push(`${who(proc)}'s pi holds ${label(world, copy.rowId)} unwritten, and the row is in no queue and left by no exit: only that process's memory knows it`);
		}
	}
	return out;
}

/**
 * I7. A finding goes from `new` to `claimed` or `dismissed` once and never back or away; two
 * decisions at once give one `ok`; and the hand-off of a claim (src/engine.ts `handOver`, which the
 * schedule calls) is queued only for a finding that is claimed, so a claim that lost queued nothing.
 */
function decidedOnce(world: World, memory: Memory, queues: Queues, coverage: Coverage): string[] {
	const out: string[] = [];
	const entries = world.inbox.list();
	for (const [index, entry] of entries.entries()) {
		const was = memory.findings.get(entry.id);
		if (was !== undefined && was !== "new" && was !== entry.status) out.push(`finding ${index + 1} went from ${was} to ${entry.status}`);
		memory.findings.set(entry.id, entry.status);
	}
	if (entries.length < memory.findings.size) out.push(`the inbox holds ${entries.length} findings and held ${memory.findings.size}: one is gone`);
	for (const decided of world.facts.decided) {
		coverage.decisions++;
		const expected = decided.was === "new" ? 1 : 0;
		if (decided.ok !== expected) out.push(`two decisions at once on a ${decided.was} finding gave ${decided.ok} ok, not ${expected}`);
	}
	for (const rows of queues.values()) {
		for (const row of rows) {
			if (!row.source.startsWith("inbox:")) continue;
			const status = memory.findings.get(row.source.slice("inbox:".length));
			if (status !== "claimed") out.push(`${label(world, row.id)}, the hand-off of a claim, is queued and its finding is ${status ?? "not in the inbox"}`);
		}
	}
	return out;
}

/**
 * A stop and a cancel do what they name. When one leaves the queue, the row it named is not left
 * queued and undelivered, unless a pi was handed that row's turn already: then a cancel does
 * nothing, and a stop has the turn aborted as it starts. A stop that named the turn pi is running
 * (by its row, or as "the turn running now" when that turn began before the stop was asked for)
 * has asked pi to abort it. Afterwards the named turn, when pi begins it, is aborted there; and one
 * pi dropped instead (Esc) leaves as cancelled at that window's next drain, never offered again.
 *
 * Which turn pi runs or begins is asked for prefixed rows only: the window knows a text-proved
 * turn by its words, which two rows can share. And a turn pi kept queued behind an aborted turn is
 * left out (the page's pi does that): the window takes it for dropped, a defect `KNOWN` names.
 */
function stopsAndCancelsWork(world: World, memory: Memory): string[] {
	const out: string[] = [];
	for (const { row, named, removerPi: pi } of world.facts.removals) {
		const target = row.target;
		if (row.kind === "input" || !target) continue;
		if (named?.queued && !named.inFlight && "id" in target) out.push(`${label(world, row.id)} left the queue, and ${label(world, target.id)}, which it named, is still queued with no pi holding its turn`);
		if (row.kind !== "stop" || !pi?.running || pi.aborted) continue;
		const runs = "id" in target ? pi.turnOf === target.id : pi.startedAt !== undefined && pi.startedAt < Date.parse(target.started_before);
		if (runs) out.push(`${label(world, row.id)} named the turn pi was running, and pi was not asked to abort it`);
	}
	for (const copy of world.facts.written) {
		if (copy.stopNamed && !copy.provedByText && copy.gaveUp !== "stop" && !copy.abortedAtStart) out.push(`pi began the turn ${label(world, copy.rowId)}, which a stop had named while pi held it unstarted, and was not asked to abort it`);
	}
	for (const copy of world.copies) {
		if (!copy.stopNamed || copy.state !== "dropped" || copy.gaveUp || memory.released.has(copy) || !world.facts.drained.includes(copy.process)) continue;
		out.push(`${label(world, copy.rowId)} is still queued after ${who(copy.process)} drained: a stop named it, pi dropped it, and it was to leave as cancelled`);
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

/** Why a hand-over the engine gave up while pi still held it, written late, may be a second delivery of its row. */
type Excuse = "refused" | "refused, proved by its text" | "stop" | "lease";
/** The two the design accepts (see `deliveredOnce`); the others are defects, each held under `KNOWN`. */
const ACCEPTED: readonly Excuse[] = ["refused", "refused, proved by its text"];

/** A person's message pi refused is never offered again, so nothing excuses a second delivery of one after a refusal. */
const excuseOf = (copy: Copy): Excuse | undefined => (copy.gaveUp !== "refused" ? copy.gaveUp : copy.person ? undefined : copy.provedByText ? "refused, proved by its text" : "refused");

/** The rows pi wrote in this step that are now written more often than once plus their excused late sends. */
function writtenTooOften(world: World, excused: readonly Excuse[], coverage?: Coverage): string[] {
	const out: string[] = [];
	const rows = new Map(world.facts.written.map((copy) => [keyOf(copy.sessionId, copy.rowId), copy]));
	for (const [key, { sessionId, rowId }] of rows) {
		const written = world.copies.filter((copy) => keyOf(copy.sessionId, copy.rowId) === key && copy.state === "written");
		const late = written.filter((copy) => excused.includes(excuseOf(copy)!));
		if (written.length > 1 + late.length) out.push(`pi wrote ${label(world, rowId)} into ${sessionId} ${written.length} times (${written.map((copy) => `${who(copy.process)}${copy.gaveUp ? `, given up: ${copy.gaveUp}` : ""}`).join("; ")})`);
		else if (coverage && written.length === 2 && late.some((copy) => ACCEPTED.includes(excuseOf(copy)!))) coverage.offeredAgainTwice[late[0].provedByText ? "byText" : "prefixed"]++;
	}
	return out;
}

/**
 * Delivered once per proof. A row is never handed over once pi has written it, and a person's
 * message pi refused is never handed over again (docs/design.md decision 23: "A person row gets
 * `last_error` and is never handed over again"). Pi writes a row once. The design accepts one
 * second delivery: a hand-over a tick judged refused, offered again after its backoff, when pi
 * then sends the first late. Decision 23 says it of a prefixed row ("A pi-loops row, proved by its
 * prefix, counts an attempt and is offered again after the backoff"), and the engine treats a row
 * only its text proves (a claim, a goal's continuation) alike (src/engine.ts `decideDrain`: "A
 * pi-loops row is proved by its prefix, or by its hand-over stamp and text, so offering it again is
 * safe"). Both are excused and counted (`Coverage.offeredAgainTwice`); it takes a pi that holds a
 * prompt unstarted past the grace and the backoff. Every other second delivery the simulation
 * finds is a defect; those today's engine has are excused here and held, one by one, under `KNOWN`.
 *
 * The brief expected two deliveries "when a crash fell between pi's write and the removal". The
 * simulation finds one: the proof is in the conversation and the next process removes the row by
 * it. That says little about the real engine, because here every process sees a write at once; a
 * second real pi reads its own copy of the conversation, which need not show what the first wrote.
 */
function deliveredOnce(world: World, _memory: Memory, _queues: Queues, coverage: Coverage): string[] {
	const out = writtenTooOften(world, [...ACCEPTED, ...Object.values(KNOWN_SECOND_DELIVERIES)], coverage);
	for (const h of world.facts.handOvers) {
		if (h.written) out.push(`${label(world, h.row.id)} was handed over after pi had written it`);
		if (h.row.source === "person" && h.row.last_error !== undefined) out.push(`${label(world, h.row.id)}, a person's message pi refused (${h.row.last_error}), was handed over again`);
	}
	return out;
}

/** The second deliveries today's engine makes that the design does not accept, by the name of the check that fails on each. */
const KNOWN_SECOND_DELIVERIES: Readonly<Record<string, Excuse>> = {
	"a row is delivered once when the lease moves while pi holds its turn unstarted": "lease",
	"a row is delivered once after a stop in the page's pi": "stop",
};

/**
 * A check today's engine fails, by name: the defect of src/ the simulation found, which this change
 * does not fix, and a seed that showed it when it was found. Such a check does not fail a schedule
 * (unless `createChecker` is told to enforce it); what it finds is reported beside, and
 * test/sim.test.ts shows it under `todo` on the first seed of its run that breaks it, or on this one.
 */
export const KNOWN: Readonly<Record<string, { defect: string; seed: number }>> = {
	"I3 no turn beside an unwritten turn only its text proves": { seed: 177, defect: "decideDrain gives the lane to an in-flight text-proved turn only against the rows after it in queue order: a turn row that sorts before it is handed over beside it (#245)" },
	"I2 a person's message is answered even when another has the same words": { seed: 7, defect: "landed takes a row only its text proves for delivered by another row's message with the same words, written at or after its hand-over stamp: when its own hand-over came to nothing (it threw and left last_error, or its window died), the row is removed as done, not given back to the page, and the person, who said the same words twice, is answered once. Needs no more of pi than a failed hand-over or a crash (#250)" },
	"I2 a row is done only by its proof": { seed: 3346, defect: "a message without a prefix that no handed-over row claims (a text-proved row's late send, once that row has left the queue) is taken for the oldest prefixed turn pi was handed and has not started: that row is removed as done while pi still holds it unwritten. Narrow: pi's phase before a run has to outlast the ten-second grace (#247)" },
	"a row is delivered once when the lease moves while pi holds its turn unstarted": { seed: 618, defect: "a window takes the lease while the holder's pi holds a turn it was handed and has not started (the lease says a turn runs only from agent_start): the new holder hands the row over again, and both pis write it; for a person's message that is one prompt answered twice. Narrow: the lease has to be taken during pi's phase before a run (#248)" },
	"a row is delivered once after a stop in the page's pi": { seed: 1736, defect: "in rpc mode (the page's pi) a stop is AgentSession.abort(), which keeps what pi queued behind the aborted turn; the window takes it for dropped, hands the row over again, and pi writes both. A terminal's abort clears the queue, as Esc does (#249)" },
};

export const INVARIANTS: ReadonlyArray<readonly [string, Invariant]> = [
	["I2 a row leaves its queue only by a named exit", namedExit],
	["I2 a row is done only by its proof", doneOnlyByProof],
	["I2 a person's message is answered even when another has the same words", answeredThoughAnotherSaidTheSame],
	["I3 one turn at a time, handed over by the holder", oneTurnFromTheHolder],
	["I3 no turn beside an unwritten turn only its text proves", noTurnBesideATextProvedTurn],
	["I6 what pi holds unwritten is still owed on disk", heldIsStillOwed],
	["I7 a finding is decided once", decidedOnce],
	["a stop and a cancel do what they name", stopsAndCancelsWork],
	["I8 attempts count failed hand-overs, a backoff is waited out, and three failures make a dead letter", attemptsCountFailures],
	["a row is delivered once per proof", deliveredOnce],
	...Object.entries(KNOWN_SECOND_DELIVERIES).map(([name, excuse]): [string, Invariant] => [name, (world) => writtenTooOften(world, [...ACCEPTED, ...Object.values(KNOWN_SECOND_DELIVERIES).filter((other) => other !== excuse)])]),
];

/**
 * The checks for one world. `check()` after every step returns the first thing broken, or
 * undefined, and beside it what the `KNOWN` checks found; `enforce` names one of those to treat
 * as any other check. `check(true)` is the last one, when the schedule is over.
 */
export function createChecker(world: World, enforce?: string): { check(end?: boolean): { violation?: Violation; known: Violation[] }; coverage: Coverage } {
	const memory: Memory = { queued: new Map(), spent: new Map(), exited: new Set(), findings: new Map(), released: new Set(), owedItsOwn: new Map() };
	const coverage: Coverage = { exits: {}, handOvers: 0, turnsBesideATurn: 0, decisions: 0, offeredAgainTwice: { prefixed: 0, byText: 0 }, provedByAnother: 0 };
	return {
		coverage,
		check(end = false) {
			const queues = new Map(world.conversations.map((c) => [c.id, world.store.list(c.id)]));
			let violation: Violation | undefined;
			const known: Violation[] = [];
			// Every check runs even after one failed: each also updates what it remembers.
			for (const [invariant, holds] of INVARIANTS) {
				const broken = holds(world, memory, queues, coverage, end);
				if (!broken.length) continue;
				if (invariant in KNOWN && invariant !== enforce) known.push({ invariant, message: broken.join("; ") });
				else violation ??= { invariant, message: broken.join("; ") };
			}
			return { violation, known };
		},
	};
}
