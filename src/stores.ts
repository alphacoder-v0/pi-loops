import * as fs from "node:fs";
import * as path from "node:path";
import { type ClockFile, ClockStore } from "./clock.ts";
import { convertStores } from "./convert-v2.ts";
import { withFileLockSync, writeFileAtomic } from "./lock.ts";
import { Inbox } from "./inbox.ts";
import { RequestStore } from "./requests.ts";
import { runHistory, type JobHistory } from "./job-status.ts";
import { RunList } from "./run-list.ts";
import { JobStore, type LoopJob } from "./store.ts";
import { TriggerStore } from "./triggers.ts";

export interface Book {
	readonly jobs: readonly LoopJob[];
	readonly clock: ClockFile;
}
export interface Stores {
	readonly dir: string;
	readonly jobs: JobStore;
	readonly clock: ClockStore;
	readonly inbox: Inbox;
	readonly requests: RequestStore;
	readonly rules: TriggerStore;
	book(): Book;
	history(): ReadonlyMap<string, JobHistory>;
}

/** The cursors of a loops directory (`clock.json`), for a reader that opens no other store. */
export function clockStore(dir: string): ClockStore {
	return new ClockStore({ file: path.join(dir, "clock.json"), lock: path.join(dir, "clock.lock") }, { locked: withFileLockSync, write: writeFileAtomic });
}

/**
 * What older versions left in `dir`, converted (src/convert-v2.ts), with the line that names the files
 * it removed. Run by a process once it may work here: never while an older pi-loops is open in `dir`
 * (src/older.ts), which reads the files this would convert or remove.
 */
export function convertDir(dir: string, log: (line: string) => void = () => {}): void {
	const { removed } = convertStores(dir, log);
	if (removed.length) log(`removed ${removed.join(", ")}: files of an older version that nothing reads now`);
}

/** The stores of `dir`. Opening them writes nothing: `convertDir` is the caller's, after src/older.ts lets it work. */
export function openStores(dir: string): Stores {
	const jobs = new JobStore(dir);
	const inbox = new Inbox(dir);
	const requests = new RequestStore(dir);
	const rules = new TriggerStore(dir);
	const clock = clockStore(dir);
	let historyStamp = "";
	let histories: ReadonlyMap<string, JobHistory> = new Map();
	return {
		dir, jobs, clock, inbox, requests, rules,
		book() {
			return { jobs: jobs.load(), clock: clock.read() };
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

