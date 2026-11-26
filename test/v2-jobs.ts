/**
 * Jobs written as 0.24.2's version 2 file held them, for tests whose scenes predate version 3: a
 * job goes in as a start converts it (src/convert-v2.ts `fromV2`), and is read back in the words of
 * that file, each value derived as the lists derive it.
 */
import type { ClockStore } from "../src/clock.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { convertStores, fromV2, type V2Job } from "../src/convert-v2.ts";
import { readUiPrefs } from "../src/ui-prefs.ts";
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
 * A loops directory with a version 2 `jobs.json`, converted as a start converts it, and each loop and
 * rule the upgrade turned off turned on again, as a person does after the upgrade: for scenes about
 * something other than the upgrade.
 */
export function convertedAndOn(dir: string): void {
	convertStores(dir);
	const jobsFile = path.join(dir, "jobs.json");
	if (fs.existsSync(jobsFile)) {
		const file = JSON.parse(fs.readFileSync(jobsFile, "utf8")) as { version: number; jobs: Array<{ enabled: boolean; disabled?: { code: string } }> };
		for (const job of file.jobs) if (job.disabled?.code === "upgrade") { job.enabled = true; delete job.disabled; }
		fs.writeFileSync(jobsFile, `${JSON.stringify(file, null, 2)}\n`);
	}
	const off = readUiPrefs(dir).upgradeOff;
	const rulesFile = path.join(dir, "triggers.json");
	if (off && fs.existsSync(rulesFile)) {
		const file = JSON.parse(fs.readFileSync(rulesFile, "utf8")) as { rules: Array<{ id: string; enabled: boolean }> };
		for (const rule of file.rules) if (off.rules.includes(rule.id)) rule.enabled = true;
		fs.writeFileSync(rulesFile, `${JSON.stringify(file, null, 2)}\n`);
	}
}
