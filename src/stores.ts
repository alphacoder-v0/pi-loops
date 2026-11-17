import * as fs from "node:fs";
import { type Clock, type ClockFile, type JobClock, v2Clock } from "./clock.ts";
import { convertStores } from "./convert-v2.ts";
import { Inbox } from "./inbox.ts";
import { RequestStore } from "./requests.ts";
import { runHistory, fromV2, type JobHistory } from "./job-status.ts";
import { RunList } from "./run-list.ts";
import { JobStore, type LoopJobV3 } from "./store.ts";
import { TriggerStore } from "./triggers.ts";

export interface Book {
	readonly jobs: readonly LoopJobV3[];
	readonly clock: ClockFile;
}
export interface Stores {
	readonly dir: string;
	readonly jobs: JobStore;
	readonly clock: Clock;
	readonly inbox: Inbox;
	readonly requests: RequestStore;
	readonly rules: TriggerStore;
	book(): Book;
	history(): ReadonlyMap<string, JobHistory>;
}

export function openStores(dir: string, log: (line: string) => void = () => {}): Stores {
	const removed = convertStores(dir, log);
	if (removed.length) log(`removed ${removed.join(", ")}: files of an older version that nothing reads now`);
	const jobs = new JobStore(dir);
	const inbox = new Inbox(dir);
	const requests = new RequestStore(dir);
	const rules = new TriggerStore(dir);
	const clock = v2Clock(jobs);
	let historyStamp = "";
	let histories: ReadonlyMap<string, JobHistory> = new Map();
	return {
		dir, jobs, clock, inbox, requests, rules,
		book() {
			const converted = jobs.load().map(fromV2);
			const entries: Record<string, JobClock> = {};
			for (const item of converted) entries[item.job.id] = item.clock;
			return { jobs: converted.map((item) => item.job), clock: { v: 1, jobs: entries } };
		},
		history() {
			let current = "missing";
			try { const stat = fs.statSync(jobs.runsFile); current = `${stat.size}:${stat.mtimeMs}`; }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			if (current !== historyStamp) {
				histories = runHistory(jobs.allRuns());
				historyStamp = current;
			}
			return histories;
		},
	};
}

/** How long `removeJob` waits for an aborted run to write its record. */
export const REMOVE_DRAIN_MS = 2_000;

export async function removeJob(stores: Pick<Stores, "jobs">, runs: RunList | undefined, id: string, opts: { purge?: boolean } = {}): Promise<{ job: ReturnType<JobStore["load"]>[number] | undefined; aborted: number }> {
	const runIds = runs?.all().filter((run) => run.jobId === id).map((run) => run.runId) ?? [];
	for (const runId of runIds) runs?.get(runId)?.ctrl.abort();
	const deadline = Date.now() + REMOVE_DRAIN_MS;
	while (runIds.some((runId) => runs?.get(runId) !== undefined) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
	return { job: await stores.jobs.remove(id, opts), aborted: runIds.length };
}

