/**
 * Jobs written as 0.24.2's version 2 file held them, for tests whose scenes predate version 3: a
 * job goes in as a start converts it (src/convert-v2.ts `fromV2`), and is read back in the words of
 * that file, each value derived as the lists derive it.
 */
import type { ClockStore } from "../src/clock.ts";
import { convertStores, fromV2, type V2Job } from "../src/convert-v2.ts";
import { resumeUpgrade } from "../src/upgrade-hold.ts";
import { jobCounts, listedJob, runHistory } from "../src/job-status.ts";
import type { JobStore } from "../src/store.ts";

interface JobsAndClock {
	readonly jobs: JobStore;
	readonly clock: ClockStore;
}

/** Adds a job written as 0.24.2 held it: the definition to jobs.json and the cursor to clock.json, as a start converts it. */
export async function addV2(stores: JobsAndClock, v2: Record<string, unknown>) {
	const { job: definition, clock } = fromV2(v2 as unknown as V2Job);
	await stores.jobs.add(definition);
	stores.clock.seed({ [definition.id]: clock });
	return definition;
}
/** A job in the words of 0.24.2's file, for the assertions: each value is what the lists derive from the definition, the cursor and the run log. */
export function viewV2(stores: JobsAndClock, id: string): any {
	const definition = stores.jobs.load().find((j) => j.id === id);
	if (!definition) return undefined;
	const clock = stores.clock.read().jobs[id];
	const history = runHistory(stores.jobs.allRuns()).get(id);
	const { status } = listedJob(definition, clock, [], history);
	return { ...definition, runCount: status.runs, lastDueAt: status.due, lastFiredAt: status.fired, lastCompletedAt: status.completed, consecutiveFailures: status.streak || undefined, lastError: status.error, skippedOverlap: status.collapsed, running: undefined, owedSlot: undefined, interruptions: jobCounts(history, clock?.cleared).interrupted || undefined };
}


/**
 * A loops directory with a version 2 `jobs.json`, converted as a start converts it, and the upgrade's
 * pause ended, as a person does after the upgrade: for scenes about something other than the upgrade.
 */
export function convertedAndOn(dir: string): void {
	convertStores(dir);
	resumeUpgrade(dir);
}
