/**
 * A seeded simulation of asks (test/sim/asks.ts): runs of a loop, a check and a conversation ask a
 * person about a call; yeses, noes and cancels from a terminal, the page and the CLI; the rider's
 * drains; runs that make the granted call, make it again, and end in every way; a process that dies
 * at any write; hand edits, a rotation and the conversion of an older version's claims; a window on
 * the conversation whose scheduled turn asks, whose idle drain runs a yes, whose run meets another
 * extension's message, and which leaves or dies at any write. The real `Answers`, `Inbox`,
 * `RequestStore`, `GuardSeats`, `guardCall`, `createAnswerLanes`, `WindowExecutor`, `windowGuard`
 * and `createWindowAnswers` do the work.
 *
 *   SIM_SEED       the first seed (default 1; schedule n runs seed SIM_SEED + n)
 *   SIM_SCHEDULES  how many schedules (default 120)
 *   SIM_STEPS      steps in each (default 60)
 *
 * A failure names its seed, its step and its invariant, prints its steps and a shorter schedule
 * that fails the same way; `SIM_SEED=<seed> SIM_SCHEDULES=1` runs it alone. An interleaving that
 * random schedules reach rarely is a scene below, driven step by step.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { track } from "./tmp.ts";
import { type AskOutcome, type AskStep, playAsks, planAsks, shortestAsks } from "./sim/asks.ts";

function setting(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	assert.match(raw, /^\d+$/, `${name} is a whole number`);
	return Number(raw);
}
const FIRST_SEED = setting("SIM_SEED", 1);
const SCHEDULES = setting("SIM_SCHEDULES", 120);
const STEPS = setting("SIM_STEPS", 60);

/** In memory where the platform has such a directory: every write takes a lock directory and an atomic rewrite. */
const ROOT = fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir();
const play = (steps: readonly AskStep[]): Promise<AskOutcome> => playAsks(track(fs.mkdtempSync(path.join(ROOT, "pi-loops-sim-asks-"))), steps);
const printed = (out: AskOutcome): string => out.lines.map((line) => `    ${line}`).join("\n");

/** What a failure says: the seed, the step, the invariant, the schedule, and a shorter one that fails the same way. */
async function failure(seed: number | string, steps: readonly AskStep[], out: AskOutcome): Promise<string> {
	const { step, invariant, message } = out.violation!;
	const short = await shortestAsks(steps, invariant, play);
	return [
		`seed ${seed}, step ${step}: ${invariant}`,
		`  ${message}`,
		`  the schedule (SIM_SEED=${seed} SIM_SCHEDULES=1 SIM_STEPS=${STEPS} runs it again):`,
		printed(out),
		...(short ? [`  a shorter schedule that breaks the same invariant: ${short.violation?.message}`, printed(short)] : []),
	].join("\n");
}

test("[I5] [I7] asks keep their rules through seeded schedules of questions, answers, cancels, runs, crashes, hand edits and restarts", { timeout: 120_000 }, async () => {
	const seen = new Set<string>();
	for (let n = 0; n < SCHEDULES; n++) {
		const seed = FIRST_SEED + n;
		const steps = planAsks(seed, STEPS);
		const out = await play(steps);
		if (SCHEDULES === 1) console.log(printed(out));
		for (const s of out.seen) seen.add(s);
		if (out.violation) assert.fail(await failure(seed, steps, out));
	}
	if (SCHEDULES >= 100) {
		const must = [
			"Q1 in a loop lane", "Q1 in a check lane", "Q1 in a conversation lane",
			"said Y1", "said Y2", "said YC", "said N1", "V1",
			"met E1", "met E3", "met E4", "met hold", "met F1", "met F2", "met F3",
			"H1 puts a row back", "K1", "K2",
			"a run starts in a loop lane", "a run starts in a check lane", "a run starts in a conversation lane",
			"a granted call runs", "a granted call is asked about again", "an answer ends done", "an answer ends unfinished",
			"dies in the middle of its writes", "dies with a run going", "a window takes the conversation during an answer's turn", "rotation drops findings",
			"Q1 in a window's scheduled turn", "met E4 in a window", "met hold in a window", "a run starts in a window", "a granted call runs in a window",
			"an answer ends done in a window", "the window dies in the middle of its writes", "the window dies with a turn going",
		];
		assert.deepEqual(must.filter((m) => !seen.has(m)), [], "every schedule reaches these together");
	}
	console.log(`${SCHEDULES} schedules of ${STEPS} steps; reached: ${[...seen].sort().join(", ")}`);
});

/** Steps of a scene, by name. The numbers pick what the step says (test/sim/asks.ts, `apply`): 0 is the first lane, command, finding or run. */
const S = (kind: AskStep["kind"], a = 0, b = 0, c = 0): AskStep => ({ kind, a, b, c });
/** A yes from a terminal alone: c = 192 picks the yes, the terminal, and no second word. */
const YES = S("say", 0, 1, 192);
/** A question from the loop's run about its first command; a yes; a tick that starts its answer. */
const ASKED_AND_STARTED = [S("ask", 0, 0, 2), YES, S("tick")];
/** The moves of a run with a grant: its prompt (b = 0 first), the granted call (b = 0 next), the call again (b = 0 after it), an end ok (b = 6 after it). */
const PROMPT = S("run", 0, 0);
const GRANTED = S("run", 0, 0);
const AGAIN = S("run", 0, 0);
const OK = S("run", 0, 6);

async function scene(steps: readonly AskStep[], reached: readonly string[]): Promise<AskOutcome> {
	const out = await play(steps);
	if (out.violation) assert.fail(await failure("a scene", steps, out));
	assert.deepEqual(reached.filter((r) => !out.seen.has(r)), [], `the scene reaches what it is for:\n${printed(out)}`);
	return out;
}

test("[I5] a run that makes its granted call twice runs it once: the second is asked about again", async () => {
	await scene([...ASKED_AND_STARTED, PROMPT, GRANTED, AGAIN, OK, S("tick")], ["a granted call runs", "a granted call is asked about again", "an answer ends done"]);
});

test("[I5] [V1] a yes cancelled before its tick runs nothing; a second yes runs once on its own row", async () => {
	const out = await scene([S("ask", 0, 0, 2), YES, S("cancel", 0, 1, 1), S("tick"), S("tick"), YES, S("tick"), PROMPT, GRANTED, OK, S("tick")], ["V1", "a granted call runs"]);
	assert.ok(out.lines.some((line) => /a cancel .*: cancelled/.test(line)), printed(out));
});

test("[I5] a row written by hand in another lane for a yes runs nothing there", async () => {
	// The loop's run files a finding of its own (c = 0); a yes; a row for it by hand in the check lane (c = 1); two ticks.
	await scene([S("ask", 0, 0, 0), YES, S("forge", 0, 1, 1), S("tick"), S("tick")], ["met E1"]);
});

test("[I5] [E4] a stop after each write of a yes, its start and its closing: the call runs at most once, every answer ends", async () => {
	for (let writes = 1; writes <= 5; writes++) {
		for (const at of [1, 2, 3]) {
			const steps = [...ASKED_AND_STARTED, PROMPT, GRANTED, OK, S("tick")];
			steps.splice(at, 0, S("kill", writes));
			const out = await play(steps);
			if (out.violation) assert.fail(await failure(`a stop after ${writes} writes at step ${at + 1}`, steps, out));
		}
	}
});

test("[K1] [K2] [I7] a claim 0.24.2 queued is converted, handed over or not, also with a stop after each write", async () => {
	await scene([S("convert", 0, 0), S("convert", 0, 1), S("tick")], ["K1", "K2"]);
	for (let writes = 1; writes <= 3; writes++) {
		const steps = [S("kill", writes), S("convert", 0, 1), S("tick"), YES, S("tick")];
		const out = await play(steps);
		if (out.violation) assert.fail(await failure(`a conversion stopped after ${writes} writes`, steps, out));
	}
});

/** A window opens; its scheduled turn asks about the first command, settles, and the window meets no row yet (c = 1: not aborted). */
const WINDOW_ASKED = [S("window-open"), S("window-ask"), S("window-settle", 0, 0, 1)];
/** The moves of pi in the window: it starts the turn it was handed (`window-run` with no turn), the granted call (b = 0), the call again (b = 0 after it). */
const W_START = S("window-run");
const W_GRANTED = S("window-run");
const W_AGAIN = S("window-run");
const W_SETTLE = S("window-settle", 0, 0, 1);

test("[I5] [M5b.10] a yes to a window's question runs in that window once: the same call again in its turn is asked again", async () => {
	const out = await scene([...WINDOW_ASKED, YES, S("tick"), W_START, W_GRANTED, W_AGAIN, W_SETTLE, S("tick")], ["Q1 in a window's scheduled turn", "met E4 in a window", "a run starts in a window", "a granted call runs in a window", "a granted call is asked about again in a window", "an answer ends done in a window"]);
	assert.ok(!out.seen.has("a run starts in a conversation lane"), `the background runs nothing:\n${printed(out)}`);
});

test("[I5] [M5b.10] a yes that lands while the window's turn runs waits; the window closes before the turn settles, and the background runs it once", async () => {
	const out = await scene([S("window-open"), S("window-ask"), YES, S("tick"), S("window-close"), S("tick"), PROMPT, GRANTED, OK, S("tick")], ["Q1 in a window's scheduled turn", "met hold in a window", "met E4", "a run starts in a conversation lane", "a granted call runs", "an answer ends done"]);
	assert.ok(!out.seen.has("a run starts in a window"), `the window starts nothing:\n${printed(out)}`);
});

test("[I5] [M5b.10] another extension's message in the window's answer turn ends the grant: the granted call after it is asked again", async () => {
	await scene([...WINDOW_ASKED, YES, S("tick"), W_START, S("window-foreign"), W_GRANTED, W_SETTLE, S("tick")], ["a run starts in a window", "a granted call is asked about after a foreign message", "an answer ends unfinished in a window"]);
});

test("[I5] [M5b.10] the window dies after the answer's claim and before the call: the background closes it once, and nothing runs", async () => {
	await scene([...WINDOW_ASKED, YES, S("tick"), W_START, S("window-die"), S("tick"), S("tick")], ["a run starts in a window", "the window dies with a turn going", "met F2"]);
	// The window dies after each of its writes from the yes's claim to the turn's closing.
	for (let writes = 1; writes <= 5; writes++) {
		for (const at of [4, 5, 6, 7]) {
			const steps = [...WINDOW_ASKED, YES, S("tick"), W_START, W_GRANTED, W_SETTLE, S("tick"), S("tick")];
			steps.splice(at, 0, S("window-die", writes));
			const out = await play(steps);
			if (out.violation) assert.fail(await failure(`the window dies after ${writes} writes at step ${at + 1}`, steps, out));
		}
	}
});

/**
 * Found by seed 1140 (and by this schedule on the simulation before the window): a run starts in the
 * check lane, a hand edit makes its answer unreadable, and the process dies; the next process meets
 * the row by E1 ("the answer cannot be read") and removes it, so the run that started has no record.
 * Neither docs/ nor the answer protocol says whether E1 owes such a run its record. Under `todo` until
 * that is decided: then src/ is fixed, or the check exempts a finding edited by hand.
 */
test("[TWICE] a hand edit that makes a started answer unreadable, then a stop: the run that started has a record", { todo: "a decision of docs/ first: see the comment above" }, async () => {
	const steps: AskStep[] = [
		{ kind: "ask", a: 2868880854, b: 393613093, c: 2791758388 }, { kind: "ask", a: 3117889000, b: 1815652123, c: 2719479024 },
		{ kind: "yes-and-no", a: 2930886029, b: 517972243, c: 2224104652 }, { kind: "ask", a: 3743832061, b: 3382214970, c: 4155184003 },
		{ kind: "ask", a: 2902136881, b: 2708121287, c: 2344554946 }, { kind: "tick", a: 730861142, b: 1141023904, c: 1137259009 },
		{ kind: "edit-finding", a: 2987822513, b: 414012454, c: 3004040086 }, { kind: "kill", a: 2495698169, b: 2091657673, c: 3452787528 },
		{ kind: "say", a: 1351273163, b: 166446629, c: 4026380251 }, { kind: "tick", a: 3054402833, b: 3170745247, c: 510521511 },
	];
	// Its own directory, removed whatever the result: a `todo` that fails would keep `track`'s on every run.
	const dir = fs.mkdtempSync(path.join(ROOT, "pi-loops-sim-asks-todo-"));
	try {
		const out = await playAsks(dir, steps);
		if (out.violation) assert.fail(`${out.violation.invariant}: ${out.violation.message}\n${printed(out)}`);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * Found by seed 3085 (and by these four steps on the simulation before the window): a row written by
 * hand with a yes's row id before the yes keeps the yes's own row out (`appendIfAbsent`); the tick's
 * H1 sees that row and appends nothing, then its drain removes it by E1 ("an earlier yes's"), so the
 * pending answer has no row until the next tick's H1. Under `todo` until it is decided whether a tick
 * owes an open answer its row (H1 after the drain too), or the check exempts a lane with a row forged by hand.
 */
test("[STUCK] a row forged by hand with a yes's id, then the yes: after a tick the pending answer has its row", { todo: "a decision of docs/ first: see the comment above" }, async () => {
	const dir = fs.mkdtempSync(path.join(ROOT, "pi-loops-sim-asks-todo-"));
	try {
		// A question from the check's run (a = 1, c = 2), a row by hand for it in the check lane (c = 1), a yes, a tick.
		const out = await playAsks(dir, [S("ask", 1, 0, 2), S("forge", 0, 0, 1), YES, S("tick")]);
		if (out.violation) assert.fail(`${out.violation.invariant}: ${out.violation.message}\n${printed(out)}`);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
