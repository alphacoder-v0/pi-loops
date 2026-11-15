/**
 * A seeded simulation of a lane the background runs (test/sim/claims.ts): rows a run claims, runs
 * that end in every way, and a process that dies at any step, against the real request engine.
 *
 *   SIM_SEED       the first seed (default 1; schedule n runs seed SIM_SEED + n)
 *   SIM_SCHEDULES  how many schedules (default 400)
 *   SIM_STEPS      steps in each (default 40)
 *
 * A failure names its seed and prints its steps; `SIM_SEED=<seed> SIM_SCHEDULES=1` runs it alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import { play } from "./sim/claims.ts";
import { prng } from "./sim/prng.ts";

function setting(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	assert.match(raw, /^\d+$/, `${name} is a whole number`);
	return Number(raw);
}
const FIRST_SEED = setting("SIM_SEED", 1);
const SCHEDULES = setting("SIM_SCHEDULES", 400);
const STEPS = setting("SIM_STEPS", 40);

test("[2.1-1] [2.1-2] a lane the background runs keeps its rules through seeded schedules of claims, ends, crashes and restarts", async () => {
	const seen = new Set<string>();
	for (let n = 0; n < SCHEDULES; n++) {
		const seed = FIRST_SEED + n;
		const out = await play(tmp("pi-loops-sim-claims-"), prng(seed), STEPS);
		for (const s of out.seen) seen.add(s);
		if (out.violation) assert.fail(`seed ${seed}: ${out.violation}\n  the schedule (SIM_SEED=${seed} SIM_SCHEDULES=1 SIM_STEPS=${STEPS} runs it again):\n${out.steps.map((s, i) => `    ${i + 1}. ${s}`).join("\n")}`);
	}
	if (SCHEDULES >= 200) {
		for (const must of ["exit delivered", "exit stopped", "exit dead", "a row stays owed", "a run ok", "a run failed", "a run stopped", "a run aborted", "dies in the middle of a drain", "dies with a run going", "dies idle"]) assert.ok(seen.has(must), `no schedule reached: ${must}`);
	}
	console.log(`${SCHEDULES} schedules of ${STEPS} steps; reached: ${[...seen].sort().join(", ")}`);
});
