/**
 * A seeded simulation of the clock and I1 through tickers, crashes, row runs and loop settlement.
 *
 *   SIM_SEED       first seed (default 1; schedule n runs seed SIM_SEED + n)
 *   SIM_SCHEDULES  schedules to run (default 400)
 *   SIM_STEPS      steps per schedule (default 100)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import { play } from "./sim/clock.ts";
import { prng } from "./sim/prng.ts";

function setting(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	assert.match(raw, /^\d+$/, `${name} is a whole number`);
	return Number(raw);
}
const FIRST_SEED = setting("SIM_SEED", 1);
const SCHEDULES = setting("SIM_SCHEDULES", 400);
const STEPS = setting("SIM_STEPS", 100);

test("[I1] one row per job and slot through tickers, crashes and settlement", async () => {
	const seen = new Set<string>();
	for (let n = 0; n < SCHEDULES; n++) {
		const seed = FIRST_SEED + n;
		const out = await play(tmp("pi-loops-sim-clock-"), prng(seed), STEPS);
		for (const item of out.seen) seen.add(item);
		if (out.violation) assert.fail(`seed ${seed}: ${out.violation}\n  the schedule (SIM_SEED=${seed} SIM_SCHEDULES=1 SIM_STEPS=${STEPS} runs it again):\n${out.steps.map((step, i) => `    ${i + 1}. ${step}`).join("\n")}`);
	}
	// Four events need several rare steps in a row: npm test's 400 schedules are not enough for them, the milestone's 4000 are.
	if (SCHEDULES >= 2000) {
		for (const must of ["orphan runs once", "cursor spent", "spent copy leaves without a run", "skip leaves fired"]) assert.ok(seen.has(must), `no schedule reached: ${must}`);
	}
	if (SCHEDULES >= 200) {
		for (const must of ["dies between T2 and T3", "two tickers cross T2 and T3", "lost T3", "not-holder T3", "owed copy runs", "collapse counted", "collapse counted-before", "loop collapse leaves fired", "end succeeded", "end failed", "end stopped", "end handed-back", "end interrupted", "closing cut after record", "closing cut after job patch", "closing cut after successor", "closing cut after row", "clock forgotten", "clock newer"]) assert.ok(seen.has(must), `no schedule reached: ${must}`);
	}
	console.log(`${SCHEDULES} schedules of ${STEPS} steps; reached: ${[...seen].sort().join(", ")}`);
});
