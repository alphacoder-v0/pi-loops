/**
 * A seeded simulation of a closed conversation whose plain job pi-loops in the background runs
 * (test/sim/held.ts): rows a run claims, prompts that are written or not, runs that end in every
 * way, a window that takes the conversation, and a process that dies at any write, against the real
 * request engine, the real closing and the real settle table.
 *
 *   SIM_SEED       the first seed (default 1; schedule n runs seed SIM_SEED + n)
 *   SIM_SCHEDULES  how many schedules (default 400)
 *   SIM_STEPS      steps in each (default 70)
 *
 * A failure names its seed and prints its steps; `SIM_SEED=<seed> SIM_SCHEDULES=1` runs it alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import { play } from "./sim/held.ts";
import { prng } from "./sim/prng.ts";

function setting(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	assert.match(raw, /^\d+$/, `${name} is a whole number`);
	return Number(raw);
}
const FIRST_SEED = setting("SIM_SEED", 1);
const SCHEDULES = setting("SIM_SCHEDULES", 400);
const STEPS = setting("SIM_STEPS", 70);

test("[R3] [R4] [R5] a held turn keeps its rules through seeded schedules of claims, written prompts, ends, take-backs, crashes and restarts: one record a run, no prompt answered twice, no failure or attempt counted twice", async () => {
	const seen = new Set<string>();
	for (let n = 0; n < SCHEDULES; n++) {
		const seed = FIRST_SEED + n;
		const out = await play(tmp("pi-loops-sim-held-"), prng(seed), STEPS);
		for (const s of out.seen) seen.add(s);
		if (out.violation) assert.fail(`seed ${seed}: ${out.violation}\n  the schedule (SIM_SEED=${seed} SIM_SCHEDULES=1 SIM_STEPS=${STEPS} runs it again):\n${out.steps.map((s, i) => `    ${i + 1}. ${s}`).join("\n")}`);
	}
	if (SCHEDULES >= 200) {
		for (const must of ["exit delivered", "exit stopped", "exit dead", "a successor is queued", "a run ok, written", "a run failed, written", "a run failed, not written", "a run stopped, written", "a run stopped, not written", "a run handed-back, written", "a run handed-back, not written", "a window takes the conversation during a turn", "dies in the middle of its writes", "dies with a run going", "dies idle"]) assert.ok(seen.has(must), `no schedule reached: ${must}`);
	}
	console.log(`${SCHEDULES} schedules of ${STEPS} steps; reached: ${[...seen].sort().join(", ")}`);
});
