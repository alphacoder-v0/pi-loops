/**
 * A seeded simulation of the request engine: random schedules of what happens to a conversation's
 * queue (rows appended, drains, pi's turns, crashes, restarts, the lease moving, a file deleted),
 * run against the real `drain`, `RequestStore` and `Inbox`, with the invariants of
 * test/sim/invariants.ts checked after every step. test/sim/world.ts says what is simulated.
 *
 *   SIM_SEED       the first seed (default 1; schedule n runs seed SIM_SEED + n)
 *   SIM_SCHEDULES  how many schedules (default 2700: one world in four has an extension that rewrites, which leaves about 2000 without)
 *   SIM_STEPS      steps in each (default 40)
 *
 * A failure names its seed; `SIM_SEED=<seed> SIM_SCHEDULES=1` runs that schedule alone and prints it.
 */
import { type TestContext, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { track } from "./tmp.ts";
import { KNOWN, REWRITTEN_HOLDS } from "./sim/invariants.ts";
import { type Plan, type Run, plan, run } from "./sim/schedule.ts";
import { EPOCH } from "./sim/world.ts";

function setting(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	assert.match(raw, /^\d+$/, `${name} is a whole number`);
	return Number(raw);
}

const FIRST_SEED = setting("SIM_SEED", 1);
const SCHEDULES = setting("SIM_SCHEDULES", 2700);
const STEPS = setting("SIM_STEPS", 40);
/** The exits a full run must have taken at least once each: a generator that stopped reaching one checks nothing about it. */
const EXITS = ["delivered", "dead", "cancelled", "stale", "refused", "job-removed", "done"];
/** The first seed of this run that showed each known defect: the main test finds them, the `todo` tests show them. */
const firstSeedOf = new Map<string, number>();

type Play = (p: Plan, enforce?: string) => Promise<Run>;

/**
 * What a simulated run needs from the test it is in: a clock that only the schedule moves, a disk
 * that does not sync, and a directory. Returns `play`, which runs one plan in a world of its own.
 * `keep` leaves a failed schedule's files for whoever reads the failure (test/tmp.ts keeps the
 * directory of a failed test); without it everything is removed when the test ends.
 */
function simulator(t: TestContext, keep: boolean): Play {
	// Nothing here waits: the engine's clock, its stamps and the inbox lock's sleep all read these mocks.
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: EPOCH });
	// The simulated disk loses nothing a write finished, so an fsync has nothing to add, and every
	// atomic rewrite makes two. Assigned, not `t.mock.method`: a mock keeps every call it sees.
	const fsync = fs.fsyncSync;
	fs.fsyncSync = () => undefined;
	syncBuiltinESMExports();
	// In memory where the platform has such a directory: the engine takes a lock directory for every
	// write, and two hundred thousand of them are most of this test's time on a disk.
	const root = fs.mkdtempSync(path.join(fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir(), "pi-loops-sim-"));
	if (keep) track(root);
	t.after(() => {
		fs.fsyncSync = fsync;
		syncBuiltinESMExports();
		if (!keep) fs.rmSync(root, { recursive: true, force: true });
	});
	const time = { setTime: (ms: number) => t.mock.timers.setTime(ms), tick: (ms: number) => t.mock.timers.tick(ms) };
	let worlds = 0;
	return async (p, enforce) => {
		const dir = path.join(root, `${p.seed}-${++worlds}`);
		const ran = await run(p, dir, time, enforce);
		if (!ran.violation || !keep) fs.rmSync(dir, { recursive: true, force: true });
		return ran;
	};
}

/**
 * A schedule of fewer steps than `failing` that breaks the same invariant: each step is left out in
 * turn, last first, and stays out when the schedule still fails the same way, until a whole pass
 * takes none out. Not always the least there is, but short enough to read.
 */
async function shortest(failing: Plan, invariant: string, play: (p: Plan) => Promise<Run>): Promise<Run | undefined> {
	let best = failing;
	let ran: Run | undefined;
	for (let shrunk = true; shrunk; ) {
		shrunk = false;
		for (let at = best.steps.length - 1; at >= 0; at--) {
			const shorter = { ...best, steps: best.steps.filter((_, index) => index !== at) };
			const result = await play(shorter);
			if (result.violation?.invariant !== invariant) continue;
			best = shorter;
			ran = result;
			shrunk = true;
		}
	}
	return ran;
}

const worldOf = (p: Plan): string => p.seconds.map((second, index) => `c${index}: a window (${second.modes[0]}) and ${second.kind === "window" ? `a second window (${second.modes[1]})` : "the background process"}${second.running ? "" : ", not started"}`).join("; ") + (p.ticks ? "; a message takes a millisecond" : "; the clock stands still inside a step") + (p.rewrites ? "; another extension rewrites every message" : "");

/**
 * What a failure says: the seed, the step, the invariant, the schedule as it ran, and a shorter one
 * that fails the same way. `whole: false` leaves the schedule as it ran to the seed, which runs it again.
 */
async function failure(planned: Plan, ran: Run, play: (p: Plan) => Promise<Run>, whole = true): Promise<string> {
	const { step, invariant, message } = ran.violation!;
	const short = await shortest(planned, invariant, play);
	const again = `SIM_SEED=${planned.seed} SIM_SCHEDULES=1 SIM_STEPS=${STEPS}`;
	return [
		`seed ${planned.seed}, step ${step}: ${invariant}`,
		`  ${message}`,
		...(whole ? [`the schedule (${again} runs it again; ${worldOf(planned)}):`, ...ran.lines.map((line) => `  ${line}`)] : [`${again} runs the schedule and prints it (${worldOf(planned)})`]),
		...(short ? [`a shorter schedule that breaks the same invariant (${short.lines.length} lines): ${short.violation?.message}`, ...short.lines.map((line) => `  ${line}`)] : []),
	].join("\n");
}

test("the request engine keeps its invariants through seeded schedules of appends, drains, crashes and restarts", async (t) => {
	const play = simulator(t, true);
	let steps = 0;
	let crashes = 0;
	let handOvers = 0;
	let decisions = 0;
	let turnsBesideATurn = 0;
	let provedByAnother = 0;
	const offeredAgainTwice = { prefixed: 0, byText: 0 };
	let firstBeside: number | undefined;
	const exits: Record<string, number> = {};
	for (let seed = FIRST_SEED; seed < FIRST_SEED + SCHEDULES; seed++) {
		const planned = plan(seed, STEPS);
		const ran = await play(planned);
		if (SCHEDULES === 1) console.log([`schedule of seed ${seed} (${worldOf(planned)}):`, ...ran.lines.map((line) => `  ${line}`)].join("\n"));
		if (ran.violation) assert.fail(await failure(planned, ran, play));
		// A known defect is shown in a world where no extension rewrites, but for the one that is of such worlds: there another check can break first and be taken for that one.
		for (const invariant of Object.keys(ran.known)) if (!firstSeedOf.has(invariant) && (!planned.rewrites || invariant === REWRITTEN_HOLDS)) firstSeedOf.set(invariant, seed);
		steps += planned.steps.length;
		crashes += ran.crashes;
		handOvers += ran.coverage.handOvers;
		decisions += ran.coverage.decisions;
		turnsBesideATurn += ran.coverage.turnsBesideATurn;
		provedByAnother += ran.coverage.provedByAnother;
		offeredAgainTwice.prefixed += ran.coverage.offeredAgainTwice.prefixed;
		offeredAgainTwice.byText += ran.coverage.offeredAgainTwice.byText;
		if (ran.coverage.turnsBesideATurn && firstBeside === undefined) firstBeside = seed;
		for (const [exit, count] of Object.entries(ran.coverage.exits)) exits[exit] = (exits[exit] ?? 0) + count;
	}
	t.diagnostic(`simulated ${SCHEDULES} schedules, ${steps} steps, ${crashes} crashes injected (seeds ${FIRST_SEED} to ${FIRST_SEED + SCHEDULES - 1})`);
	t.diagnostic(`${handOvers} hand-overs; exits: ${EXITS.map((exit) => `${exit} ${exits[exit] ?? 0}`).join(", ")}; ${decisions} findings decided twice at once; ${turnsBesideATurn} turns handed to a pi that held another unstarted${firstBeside === undefined ? "" : ` (first in seed ${firstBeside})`}`);
	t.diagnostic(`excused by the design: ${offeredAgainTwice.prefixed} prefixed rows and ${offeredAgainTwice.byText} text-proved rows delivered twice after a refusal and a second offer; ${provedByAnother} rows delivered on another row's message with the same words`);
	if (SCHEDULES >= 1000 && STEPS >= 30) {
		assert.deepEqual(EXITS.filter((exit) => !exits[exit]), [], "every exit is taken at least once in a full run");
		assert.ok(crashes > 0 && decisions > 0, "a full run injects crashes and decides findings");
	}
});

// A check today's engine fails is not left out in silence: it runs here under `todo`, on the first
// seed of the run above that broke it, so the output shows the defect with a seed and a schedule,
// and shows the day that seed breaks it no more.
for (const [invariant, known] of Object.entries(KNOWN)) {
	test(`known defect: ${invariant}`, { todo: known.defect }, async (t) => {
		// A run of chosen seeds shows what those seeds show; the usual run falls back on the seed the defect was found with.
		const seed = firstSeedOf.get(invariant) ?? (process.env.SIM_SEED ? undefined : known.seed);
		if (seed === undefined) return;
		const play = simulator(t, false);
		const planned = plan(seed, STEPS);
		const ran = await play(planned, invariant);
		if (ran.violation?.invariant === invariant) assert.fail(await failure(planned, ran, (p) => play(p, invariant), false));
	});
}
