/**
 * A schedule: the list of things that happen to a world, drawn from one seed, and the code that
 * makes each of them happen. A step is a kind and three numbers, read against the world as it is
 * when the step runs ("the second live process", "the third queued row"), so the list is a function
 * of the seed alone, and a step can be taken out of it without changing what the others mean. That
 * is what lets a failing schedule be cut down to the steps that matter.
 */
import { type DrainResult, cancelRow, conversationHas, enqueue, goalRow, handOver, inboxClaimRow, personRow, plainJobRow, plainRunId, requestFingerprint, ringProduced, ruleResultRow, stopRow } from "../../src/engine.ts";
import type { SessionRequest } from "../../src/requests.ts";
import { stamp } from "../../src/schedule.ts";
import { type Violation, createChecker, type Coverage } from "./invariants.ts";
import { pick, prng, weighted } from "./prng.ts";
import { type Conversation, type Fault, PAGE_PID, type PiMove, type Process, type Timers, type World, advance, atOnce, buryAs, createWorld, drainAs, everyProcess, held, kill, label, leaseMayMove, live, moveLease, noFacts, piMove, piMoves, start, who } from "./world.ts";

type Kind = "produce" | "drain" | "pi" | "clock" | "process" | "lease" | "setting" | "inbox" | "delete";

export interface Step {
	kind: Kind;
	a: number;
	b: number;
	c: number;
}

export interface Plan {
	seed: number;
	/** One conversation or two; for each, whether its second process is a viewer window or the background process, and whether it runs from the start. */
	seconds: Array<{ kind: Process["kind"]; running: boolean }>;
	steps: Step[];
	/** The numbers the restart that ends the schedule draws its crashes from. */
	closing: number[];
}

const WEIGHTS: ReadonlyArray<readonly [Kind, number]> = [["produce", 25], ["drain", 30], ["pi", 20], ["clock", 9], ["process", 6], ["inbox", 5], ["lease", 2], ["setting", 2], ["delete", 1]];
/** A hand-over that is over at once, the ring wait, the grace after a hand-over, and the three backoffs (src/engine.ts). */
const WAITS_MS = [300, 2_000, 10_000, 60_000, 5 * 60_000, 30 * 60_000];
/** Longer than any wait the engine has: after this, nothing is held back by the clock. */
const PAST_EVERY_WAIT_MS = 31 * 60_000;
const CWD = "/p";
const PAGE = { pid: PAGE_PID, instance: "page", version: "sim" };
/** `pi-loops abort` and its like: a process that wrote its row and is gone. */
const CLI = { pid: 1, instance: "cli", version: "sim" };

export function plan(seed: number, steps: number): Plan {
	const next = prng(seed);
	const seconds = Array.from({ length: 1 + (next() % 2) }, () => ({ kind: pick<Process["kind"]>(["window", "background"], next()), running: next() % 2 === 0 }));
	return { seed, seconds, steps: Array.from({ length: steps }, () => ({ kind: weighted(WEIGHTS, next()), a: next(), b: next(), c: next() })), closing: Array.from({ length: 6 }, next) };
}

const signedBy = (proc: Process | undefined): SessionRequest["created_by"] => (proc ? { pid: proc.pid, instance: proc.name, version: "sim" } : CLI);
const seconds = (ms: number): string => (ms < 1_000 ? `${ms} ms` : ms < 60_000 ? `${ms / 1_000} s` : `${ms / 60_000} min`);
const names = (world: World, ids: readonly string[]): string => ids.map((id) => label(world, id)).join(", ");

function outcome(world: World, out: DrainResult | undefined): string {
	if (!out) return "the process died in it";
	const parts = [out.delivered.length ? `handed over ${names(world, out.delivered)}` : "", out.removed.length ? `removed ${names(world, out.removed)}` : "", out.failed.length ? `failed ${names(world, out.failed)}` : "", out.dead.length ? `dead ${names(world, out.dead)}` : "", out.waiting.length ? `${out.waiting.length} waiting` : ""];
	return parts.filter(Boolean).join("; ") || "nothing to do";
}

/** A row that arrives having failed already, in a life before the schedule: its attempts are counted as that history. */
function arrives(row: SessionRequest, c: number): SessionRequest {
	const before = (c >>> 8) % 6 === 0 ? 1 + ((c >>> 12) % 2) : 0;
	return before ? { ...row, attempts: before } : row;
}

/** A producer appends one row to `conversation`'s queue. */
function produce(world: World, conversation: Conversation, b: number, c: number): string {
	const at = world.clock;
	const n = ++world.made;
	const processes = live(conversation);
	const windows = processes.filter((p) => p.window);
	const queued = () => world.store.list(conversation.id).filter((row) => row.kind === "input");
	const to = conversation.id;
	const history = (row: SessionRequest): string => {
		if (!row.attempts) return "";
		world.threw.set(row.id, (world.threw.get(row.id) ?? 0) + row.attempts);
		return `, which failed ${row.attempts} times before`;
	};
	switch (b % 12) {
		case 0:
		case 1:
		case 2: {
			// The clock: a slot's id is derived, so the same slot written again is the same row.
			const job = pick(["j1", "j1", "j2"], c);
			const key = `${to}/${job}`;
			const slot = (c >>> 4) % 4 === 0 && world.lastSlot.has(key) ? world.lastSlot.get(key)! : n;
			world.lastSlot.set(key, slot);
			const id = plainRunId(job, `${to}:${slot}`);
			const name = `${job}#${slot}`;
			world.labels.set(id, name);
			const row = arrives(plainJobRow({ id: job, sessionId: to, prompt: `run ${job}, slot ${slot} of ${to}.`, cwd: CWD }, id, `cron:${job}`, "", signedBy(processes.length ? pick(processes, c >>> 16) : undefined), at), c);
			const written = enqueue(world.store, row, (queued) => conversationHas(conversation.entries, queued));
			return `the clock queues ${name} for ${to}${written ? history(row) : ": already queued, or collapsed onto a queued slot"}`;
		}
		case 3:
		case 4: {
			const id = `rule-${n}`;
			const flaw = pick(["", "", "", "", "", " without its prefix", " with its mode widened"], c);
			world.labels.set(id, `rule#${n}`);
			let row = ruleResultRow(to, `${flaw === " without its prefix" ? "" : `[Trigger ${id}] `}rule result ${n}.`, { traceId: id, sourceLabel: "r1", cwd: CWD }, signedBy(processes.length ? pick(processes, c >>> 16) : undefined), at);
			if (flaw === " without its prefix") world.malformed.add(id);
			else if (flaw === " with its mode widened") {
				row = { ...row, mode: "unattended" };
				world.tampered.add(id);
			} else row = arrives(row, c);
			world.store.append(row);
			return `a rule's result rule#${n} is queued for ${to}${flaw}${history(row)}`;
		}
		case 5: {
			if (!windows.length) return `${to}: no window pursues a goal`;
			const window = pick(windows, c);
			const row = goalRow(`goal: go on, step ${n}.`, { condition: "until it is done", iterations: n, updatedAt: stamp(at) }, { sessionId: to, cwd: CWD, createdBy: signedBy(window) }, at);
			world.labels.set(row.id, `goal#${n}`);
			const written = enqueue(world.store, row, (queued) => window.window!.delivered(queued));
			window.window!.produced(row);
			return `${who(window)} queues its goal's continuation goal#${n}${written ? "" : ": collapsed onto the one queued"}`;
		}
		case 6:
		case 7:
		case 8: {
			const id = `person-${n}`;
			world.labels.set(id, `person#${n}`);
			// One message in four says what the last one said: the stamp of its hand-over is all that tells the two apart.
			const again = (c >>> 6) % 4 === 0 ? world.lastWords.get(to) : undefined;
			const row = personRow(id, again ?? `the person says ${n}.`, undefined, { sessionId: to, cwd: CWD, createdBy: PAGE }, at);
			world.lastWords.set(to, row.payload!.text);
			world.store.append(row);
			const rung = c % 2 === 0 && windows.length ? (conversation.holder && windows.includes(conversation.holder) ? conversation.holder : pick(windows, c >>> 4)) : undefined;
			if (rung) ringProduced(world.store.list(to), id, requestFingerprint(row), (queued) => rung.window!.produced(queued));
			return `the page queues person#${n} for ${to}${again ? " in the words of the message before it" : ""}${rung ? `, and rings ${rung.name}` : ", and no ring comes"}`;
		}
		case 9: {
			const id = `stop-${n}`;
			world.labels.set(id, `stop#${n}`);
			// A stop is for something that runs or is about to: half of those that name a row name one pi already holds.
			const inputs = queued();
			const handed = inputs.filter((row) => everyProcess(world).some((p) => held(p).some((copy) => copy.rowId === row.id)));
			const target: NonNullable<SessionRequest["target"]> = c % 3 === 0 || !inputs.length ? { current: true, started_before: stamp(at) } : { id: pick(handed.length && (c >>> 2) % 2 === 0 ? handed : inputs, c >>> 3).id };
			if ("id" in target) world.targeted.add(target.id);
			world.store.append({ ...stopRow(to, target, "cli", CLI, at), id });
			return `stop#${n} is queued for ${to}, naming ${"id" in target ? label(world, target.id) : "the turn running now"}`;
		}
		default: {
			const id = `cancel-${n}`;
			world.labels.set(id, `cancel#${n}`);
			const inputs = queued();
			const target = inputs.length && c % 5 !== 0 ? pick(inputs, c >>> 3).id : "a-row-that-is-not-there";
			world.targeted.add(target);
			world.store.append({ ...cancelRow(to, { id: target }, "cli", CLI, at), id });
			return `cancel#${n} is queued for ${to}, naming ${label(world, target)}`;
		}
	}
}

/**
 * A loop's run files a finding, or two people decide one finding at once. A claim is the engine's
 * own (`handOver`): made in a window, it queues the hand-off under the inbox lock once the finding
 * is found new, and that window drains. A dismiss goes to the inbox alone.
 */
async function inbox(world: World, b: number, c: number): Promise<string> {
	const n = ++world.made;
	const findings = world.inbox.list();
	if (b % 3 === 0 || !findings.length) {
		await world.inbox.append({ source: "cron:loop", run_id: `loop-${n}`, cwd: CWD, text: `finding ${n}` });
		return `a loop files a finding (number ${findings.length + 1} in the inbox)`;
	}
	const index = c % findings.length;
	const entry = findings[index];
	const windows = everyProcess(world).filter((p) => p.alive && p.window);
	const says: string[] = [];
	const acts = [0, 1].map((i) => {
		const proc = (b >>> (3 + i)) % 2 === 0 || !windows.length ? undefined : pick(windows, c >>> (4 + 8 * i));
		if (!proc) {
			says.push("a dismiss");
			return async () => "ok" in (await world.inbox.decide(entry.id, "dismissed"));
		}
		const window = proc.window!;
		const row = { ...inboxClaimRow(`address finding ${index + 1} (claim ${n}.${i}).`, entry.id, { sessionId: proc.conversation.id, cwd: CWD, createdBy: signedBy(proc) }, world.clock), id: `claim-${n}.${i}` };
		world.labels.set(row.id, `claim#${n}.${i}`);
		says.push(`a claim in ${who(proc)}`);
		const deps = { store: world.store, delivered: (id: string) => window.delivered(id), produced: (queued: SessionRequest) => window.produced(queued), drain: () => drainAs(world, proc, false) };
		// A claim that won has drained, so it has a result; one that lost queued nothing and has none.
		return async () => (await handOver(deps, row, { inbox: world.inbox, entryId: entry.id })).result !== undefined;
	});
	const ok = (await atOnce(world, acts)).filter(Boolean).length;
	world.facts.decided.push({ was: entry.status, ok });
	return `finding ${index + 1} (${entry.status}) gets ${says[0]} and ${says[1]} at once: ${ok} ok`;
}

/**
 * How many writes a process makes before it dies, from one number: any count up to eleven, which is
 * past a third dead letter of one drain, the low counts more often, since most drains write little.
 */
const writesBeforeACrash = (n: number): number => (n >>> 4) % (2 + (n % 11));

/** What goes wrong in a drain, drawn from one number: in four drains of ten, nothing. */
function faultOf(c: number): { fault: Fault; says: string } {
	const nth = 1 + ((c >>> 4) % 3);
	// A crash can fall before any write of the drain; between any two of its rows the lease can leave, or another window's pi can write.
	if (c % 10 === 0) return { fault: { crashAfter: writesBeforeACrash(c >>> 4) }, says: `, and may die before write ${1 + writesBeforeACrash(c >>> 4)}` };
	if (c % 10 === 1) return { fault: { leaseLeavesAfter: nth }, says: `, and may lose the lease after row ${nth}` };
	if (c % 10 === 2) return { fault: { handOverThrows: true }, says: ", and pi throws at every hand-over" };
	if (c % 10 <= 5) return { fault: { othersWriteBefore: nth }, says: `, and another window's pi may write before row ${nth}` };
	return { fault: {}, says: "" };
}

/** One drain by `process`, said in a line. The background process first takes a conversation nobody alive holds, as it does for a closed one. */
async function drains(world: World, proc: Process, tick: boolean, fault: Fault = {}, says = ""): Promise<string> {
	const conversation = proc.conversation;
	if (proc.kind === "background" && leaseMayMove(conversation, proc) && !conversation.holder?.alive) moveLease(conversation, proc);
	const out = await drainAs(world, proc, tick, fault);
	return `${who(proc)}${conversation.holder === proc ? " (holder)" : ""} drains${tick ? " on a tick" : ""}${says}: ${outcome(world, out)}`;
}

/** A process starts in slot `index` of `conversation`. */
function open(world: World, conversation: Conversation, index: number): string {
	const proc = start(world, conversation, index % conversation.slots.length);
	return `${who(proc)} starts${conversation.holder === proc ? " and takes the lease" : ", without the lease"}`;
}

const PI_SAYS: Record<PiMove, string> = { start: "starts the turn it was handed", write: "writes the turn's message", settle: "settles", esc: "is stopped with Esc and settles", refuse: "refuses what it was handed, silently", type: "runs a message the person typed" };

/** Make `step` happen in `world`, and say what happened in one line. */
export async function apply(world: World, step: Step): Promise<string> {
	const conversation = pick(world.conversations, step.a);
	const { b, c } = step;
	switch (step.kind) {
		case "produce":
			return produce(world, conversation, b, c);
		case "inbox":
			return inbox(world, b, c);
		case "clock": {
			const ms = pick(WAITS_MS, b);
			advance(world, ms);
			return `the clock advances ${seconds(ms)}`;
		}
		case "drain": {
			const { fault, says } = faultOf(c);
			if (conversation.deleted) {
				const buried = await buryAs(world, conversation, fault.crashAfter);
				return `pi-loops buries the queue of ${conversation.id}${fault.crashAfter !== undefined ? says : ""}: ${buried ? `${buried.length} rows` : "the process died in it"}`;
			}
			const processes = live(conversation);
			if (!processes.length) return open(world, conversation, b);
			// The holder twice as often as the other: a viewer's drain finds only its own rows.
			return drains(world, pick(conversation.holder?.alive ? [conversation.holder, ...processes] : processes, b), (c >>> 8) % 2 === 0, fault, says);
		}
		case "pi": {
			const windows = live(conversation).filter((p) => p.window);
			if (!windows.length) return conversation.deleted ? `${conversation.id} is gone: no pi runs` : open(world, conversation, 0);
			const proc = pick(windows, b);
			const moves = piMoves(proc);
			// An idle pi with nothing handed to it: the person types one time in three, and otherwise
			// the window's tick comes round, or pi would run the person's turns most of the time.
			if (moves.length === 1 && moves[0] === "type" && c % 3 !== 0) return drains(world, proc, true);
			const move = pick(moves, c);
			piMove(world, proc, move);
			return `${who(proc)}: pi ${PI_SAYS[move]}`;
		}
		case "process": {
			if (c % 16 === 0) {
				for (const proc of everyProcess(world)) if (proc.alive) kill(world, proc);
				return "every process dies";
			}
			if (conversation.deleted) return `${conversation.id} is gone: nothing starts on it`;
			const chosen = conversation.slots[b % 2];
			if (chosen.process?.alive && (c >>> 4) % 2 === 0) {
				kill(world, chosen.process);
				return `${who(chosen.process)} dies`;
			}
			const index = chosen.process?.alive ? conversation.slots.findIndex((slot) => !slot.process?.alive) : b % 2;
			if (index < 0) return `${conversation.id}: both processes live on`;
			return open(world, conversation, index);
		}
		case "lease": {
			const processes = live(conversation);
			const taker = processes.length ? pick(processes, b) : undefined;
			if (!taker || !leaseMayMove(conversation, taker)) return `${conversation.id}: the lease stays where it is`;
			moveLease(conversation, taker);
			// A process that takes a conversation drains it at once, while the one it took it from may still be at work.
			const { fault, says } = faultOf(c);
			return `the lease of ${conversation.id} goes to ${taker.name}; ${await drains(world, taker, true, fault, says)}`;
		}
		case "setting": {
			if (b % 4 === 0) {
				world.jobs.get("j2")!.exists = false;
				return "job j2 is removed";
			}
			if (b % 4 === 1) {
				const job = world.jobs.get("j1")!;
				job.enabled = !job.enabled;
				return `job j1 is ${job.enabled ? "enabled" : "disabled"}`;
			}
			conversation.goalActive = !conversation.goalActive;
			return `the goal of ${conversation.id} is ${conversation.goalActive ? "set" : "cleared"}`;
		}
		case "delete": {
			if (conversation.deleted || c % 3 !== 0) return `${conversation.id}: its file stays`;
			for (const proc of live(conversation)) kill(world, proc);
			conversation.deleted = true;
			const buried = await buryAs(world, conversation, (c >>> 4) % 4 === 0 ? writesBeforeACrash(c >>> 6) : undefined);
			return `the file of ${conversation.id} is deleted and its processes end; pi-loops buries its queue: ${buried ? `${buried.length} rows` : "the process died in it"}`;
		}
	}
}

export const AFTER_RESTART = "I6 after every process is killed and started again, what was owed is delivered or reported";

/**
 * I6, done: kill every process, start one window per conversation from the files alone, and let it
 * work with a pi that takes every turn, a clock past every wait and job j1 enabled. A crash can
 * fall here too, after any write of the first drains (`numbers` say where); the window then starts
 * again. Every row then ends by a named exit. What may stay: a person's message pi refused, which
 * keeps its error for the page to take back. `check` runs after each conversation's restart, over
 * everything that happened in it; false stops the run. Returns the rows left over.
 */
async function killEveryProcessAndFinish(world: World, numbers: readonly number[], check: () => boolean): Promise<string[]> {
	for (const proc of everyProcess(world)) if (proc.alive) kill(world, proc);
	world.jobs.get("j1")!.enabled = true;
	const left: string[] = [];
	let drawn = 0;
	const crash = (): number | undefined => {
		const n = numbers[drawn++ % numbers.length];
		return n % 3 === 0 ? writesBeforeACrash(n >>> 4) : undefined;
	};
	for (const conversation of world.conversations) {
		const owed = () => world.store.list(conversation.id).filter((row) => !(row.source === "person" && row.last_error !== undefined));
		// One set of facts for the conversation's whole restart: the checks read them once, after it.
		world.facts = noFacts();
		let rows = owed();
		if (conversation.deleted) {
			if (!(await buryAs(world, conversation, crash()))) await buryAs(world, conversation);
		} else {
			let window = start(world, conversation, 0);
			for (let round = 0, rounds = 2 * rows.length + 9; round < rounds && rows.length; round++) {
				advance(world, PAST_EVERY_WAIT_MS);
				await drainAs(world, window, true, round < 3 ? { crashAfter: crash() } : {});
				if (!window.alive) window = start(world, conversation, 0);
				while (window.pi.running || window.pi.queue.length) piMove(world, window, !window.pi.running ? "start" : window.pi.current ? "write" : "settle");
				rows = owed();
			}
		}
		if (!check()) return [];
		left.push(...owed().map((row) => `${label(world, row.id)} (${conversation.id})`));
	}
	return left;
}

export interface Run {
	/** One line per step, as it happened. */
	lines: string[];
	violation?: Violation & { step: number | "end" };
	/** What the checks today's engine is known to fail found first, by check. */
	known: Record<string, { step: number | "end"; message: string }>;
	crashes: number;
	coverage: Coverage;
}

/**
 * Run `plan` in a new world under `dir`, checking every invariant after every step and after the
 * restart that ends it. A check `KNOWN` names does not end the run, unless it is the one to `enforce`.
 */
export async function run(plan: Plan, dir: string, time: Timers, enforce?: string): Promise<Run> {
	const world = createWorld(dir, time, plan.seconds);
	const checker = createChecker(world, enforce);
	const lines: string[] = [];
	const known: Run["known"] = {};
	const done = (violation?: Run["violation"]): Run => ({ lines, violation, known, crashes: world.crashes, coverage: checker.coverage });
	const check = (step: number | "end"): Violation | undefined => {
		const found = checker.check();
		for (const { invariant, message } of found.known) known[invariant] ??= { step, message };
		return found.violation;
	};
	for (const [index, step] of plan.steps.entries()) {
		world.facts = noFacts();
		try {
			lines.push(`${index + 1}. ${await apply(world, step)}`);
		} catch (err: any) {
			lines.push(`${index + 1}. ${step.kind}: threw`);
			return done({ step: index + 1, invariant: "no step throws", message: String(err?.stack ?? err) });
		}
		const violation = check(index + 1);
		if (violation) return done({ step: index + 1, ...violation });
	}
	lines.push("end. every process is killed; one window per conversation starts again and works until its queue is empty");
	let violation: Violation | undefined;
	try {
		const left = await killEveryProcessAndFinish(world, plan.closing, () => (violation = check("end")) === undefined);
		if (!violation && left.length) violation = { invariant: AFTER_RESTART, message: `still queued, neither delivered nor reported: ${left.join(", ")}` };
	} catch (err: any) {
		violation = { invariant: "no step throws", message: String(err?.stack ?? err) };
	}
	return done(violation && { step: "end", ...violation });
}
