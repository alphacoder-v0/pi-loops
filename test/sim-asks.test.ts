/**
 * A seeded simulation of asks (test/sim/asks.ts): runs of a loop, a check and a conversation ask a
 * person about a call; yeses, noes and cancels from a terminal, the page and the CLI; the rider's
 * drains; runs that make the granted call, make it again, and end in every way; a process that dies
 * at any write; hand edits, a rotation and the conversion of an older version's claims. The real
 * `Answers`, `Inbox`, `RequestStore`, `GuardSeats`, `guardCall` and `createAnswerLanes` do the work.
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
