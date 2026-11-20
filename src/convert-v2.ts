import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { plainJobRow, plainRunId } from "./engine.ts";
import { loopLane } from "./lane.ts";
import { pidAlive } from "./lock.ts";
import { RequestStore } from "./requests.ts";
import type { JobClock } from "./clock.ts";
import { type Disabled, JobStore, type LoopJob, type LoopJobV3 } from "./store.ts";

/** The end of the `lastError` of a job whose conversation was gone: such a job is `disabled.code: "session-gone"`, and `/cron gc` removes it. */
export const DEAD_SESSION_MARKER = "no longer exists (/cron gc removes it)";

/** Read a version 2 job as its version 3 definition and clock entry. */
export function fromV2(job: LoopJob): { job: LoopJobV3; clock: JobClock } {
	const {
		lastDueAt, lastFiredAt, runCount, lastCompletedAt, lastError, running: _running,
		skippedOverlap: _skippedOverlap, consecutiveFailures: _consecutiveFailures,
		owedSlot: _owedSlot, interruptions: _interruptions, cwdMissingSince: _cwdMissingSince,
		...definition
	} = job;
	let disabled: Disabled | undefined;
	if (!job.enabled) {
		const why = lastError ?? "disabled by a person";
		const code: Disabled["code"] = why.endsWith(DEAD_SESSION_MARKER) ? "session-gone" : why.startsWith("disabled: cwd ") ? "cwd-missing" : why.startsWith("parked: ") ? "interrupted" : why.startsWith("disabled: ") ? "schedule" : "person";
		disabled = { code, why, at: lastCompletedAt ?? lastFiredAt ?? job.createdAt };
	}
	return {
		job: { ...definition, enabled: job.enabled, ...(disabled ? { disabled } : {}) },
		clock: {
			...(lastDueAt ? { slot: lastDueAt } : {}),
			...(lastFiredAt ? { fired: lastFiredAt } : {}),
			runs: runCount,
			...(job.skippedOverlap ? { collapsed: job.skippedOverlap } : {}),
			...(job.lastError && job.enabled ? { note: { at: lastDueAt ?? job.createdAt, text: job.lastError } } : {}),
			...("clearedAt" in job && typeof job.clearedAt === "string" ? { cleared: job.clearedAt } : {}),
		},
	};
}

/** Private files of older versions that nothing reads now. */
export const RETIRED_FILES: readonly string[] = ["next-runs.json", "scheduler.json", "presence"];

/**
 * Remove retired files and convert version 2 claims to request rows. Every start does it, and a
 * window and pi-loops can both do it on the same directory: a marker whose pid is alive stays, and
 * so does its job's turn to be converted. A row of a converted slot has an id derived from the job and
 * the slot, so a second conversion appends nothing and removes no row the first one wrote.
 */
export function convertStores(dir: string, log: (line: string) => void = () => {}): string[] {
	const removed: string[] = [];
	for (const name of RETIRED_FILES) {
		const file = path.join(dir, name);
		try {
			if (!fs.lstatSync(file, { throwIfNoEntry: false })) continue;
			fs.rmSync(file, { recursive: true, force: true });
			removed.push(name);
		} catch (err: any) {
			log(`could not remove ${name}, which an older version left: ${err?.message ?? err}`);
		}
	}
	convertV2Rows(dir, log);
	return removed;
}

function convertV2Rows(dir: string, log: (line: string) => void): void {
	const jobs = new JobStore(dir);
	if (!fs.existsSync(jobs.jobsFile)) return;
	const initial = jobs.load();
	if (!initial.some((job) => job.running || job.owedSlot !== undefined)) return;
	const requests = new RequestStore(dir);
	const records = jobs.allRuns();
	const booted = Date.now() - os.uptime() * 1000;
	jobs.mutateSync((all) => {
		for (const job of all) {
			const marker = job.running;
			const lane = job.stateful ? loopLane(job.id) : job.sessionId;
			if (!lane) {
				// No lane can run it: the fields are not read anywhere else, so they are removed once.
				delete job.running;
				delete job.owedSlot;
				continue;
			}
			const isLoop = job.stateful;
			let keepMarker = false;
			let slot: string | undefined = job.owedSlot;
			let attempts = job.interruptions ?? 0;
			if (marker) {
				const ended = records.some((record) => record.runId === marker.runId);
				if (ended) {
					job.runCount = Math.max(job.runCount, records.find((record) => record.runId === marker.runId)?.ordinal ?? job.runCount + 1);
				} else {
					const recycled = Number.isFinite(booted) && Date.parse(marker.startedAt) < booted - 60_000;
					const alive = marker.pid === process.pid || (!recycled && pidAlive(marker.pid));
					if (alive) {
						keepMarker = true;
						log(`cron ${job.name ?? job.id}: an older pi-loops process still has a run marker; leaving it alone`);
					} else {
						if (isLoop) slot ??= job.lastDueAt ?? marker.startedAt;
						else if (job.sessionId && !promptWritten(requests, job.sessionId, marker.runId)) slot ??= job.lastDueAt ?? marker.startedAt;
						else if (job.sessionId && !requests.list(job.sessionId).some((row) => row.id === marker.runId)) job.runCount++;
					}
				}
			}
			if (!keepMarker && slot) {
				const id = plainRunId(job.id, slot);
				const base = plainJobRow(job, id, `cron:${job.id}`, "", { pid: process.pid, instance: "convert", version: "0" }, Date.now());
				requests.appendIfAbsent({ ...base, lane, attempts, payload: { ...base.payload!, slot } });
			}
			if (!keepMarker) {
				delete job.running;
				delete job.owedSlot;
			}
		}
		return { jobs: all, result: undefined };
	});
}

function promptWritten(requests: RequestStore, session: string, runId: string): boolean {
	const leasePath = path.join(requests.dir, "leases", `${session}.json`);
	let file: string | undefined;
	try { file = (JSON.parse(fs.readFileSync(leasePath, "utf8")) as { sessionFile?: string }).sessionFile; }
	catch { /* no lease file */ }
	if (!file) return false;
	try {
		return fs.readFileSync(file, "utf8").split("\n").some((line) => line.includes(`[Trigger ${runId}] `));
	} catch { return false; }
}
