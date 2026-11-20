import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { DEAD_AFTER_ATTEMPTS } from "./backoff.ts";
import { plainJobRow, plainRunId } from "./engine.ts";
import { loopLane, parseLane } from "./lane.ts";
import { pidAlive, withFileLockSync, writeFileAtomic } from "./lock.ts";
import { RequestStore } from "./requests.ts";
import { type JobClock, type RunClose, validStamp } from "./clock.ts";
import { stamp } from "./schedule.ts";
import { clockStore } from "./stores.ts";
import { DISABLED_BY_PERSON, type Disabled, JOBS_FILE_VERSION, JobStore, type LoopJob, type RunningMarker } from "./store.ts";

/** The eleven counters a job of a version 2 `jobs.json` carried beside its definition. */
export interface V2Counters {
	lastDueAt?: string;
	lastFiredAt?: string;
	lastCompletedAt?: string;
	lastError?: string;
	running?: RunningMarker;
	runCount: number;
	skippedOverlap: number;
	/** Failures in a row. Cleared by a success; drives the backoff in the scheduler. */
	consecutiveFailures?: number;
	/**
	 * A slot handed back unrun: the host's turn in a closed conversation was taken back by a window,
	 * or stopped by the host itself (a stop, an upgrade, the budget), or its process died before a
	 * record was written. The next dispatch runs it at once instead of calling it missed — the
	 * catch-up rule is for slots nobody tried, and this one was tried. Cleared by the next claim.
	 */
	owedSlot?: string;
	/**
	 * Runs in a row that started and never finished: the process running them died mid-run. Three
	 * park the job (disabled, with why) rather than letting one that takes its process down with it
	 * do so on every start. Cleared by a run that finishes, and by enabling the job again.
	 */
	interruptions?: number;
	/**
	 * When this job's `cwd` was first found missing, if it still is.
	 *
	 * A directory that is not there at this instant is usually not a directory that is gone: a
	 * network mount, an external disk or an encrypted volume comes up *after* the first pi does at
	 * boot. Disabling on the first miss killed jobs for being twenty seconds early. Cleared the
	 * moment the directory is back — so this is a transient marker like `lastError`, which is why
	 * it does not bump `JOBS_FILE_VERSION`: an older build sharing this directory drops it on its
	 * next write, and the only consequence is that the grace period starts again.
	 */
	cwdMissingSince?: string;
}

/** A job as a version 2 `jobs.json` holds it: the definition and the counters, and no `disabled`. */
export type V2Job = Omit<LoopJob, "disabled" | "proposed"> & V2Counters;

/** The end of the `lastError` of a job whose conversation was gone: such a job is `disabled.code: "session-gone"`, and `/cron gc` removes it. */
export const DEAD_SESSION_MARKER = "no longer exists (/cron gc removes it)";

/** Read a version 2 job as its version 3 definition and clock entry. */
export function fromV2(job: V2Job): { job: LoopJob; clock: JobClock } {
	const {
		lastDueAt, lastFiredAt, runCount, lastCompletedAt, lastError, running: _running,
		skippedOverlap, consecutiveFailures: _consecutiveFailures,
		owedSlot: _owedSlot, interruptions: _interruptions, cwdMissingSince: _cwdMissingSince,
		clearedAt, ...definition
	} = job as V2Job & { clearedAt?: unknown };
	// A hand-edited file may hold anything: each field is kept only when it is what it says, and a
	// field that is not is dropped alone, so the rest of the cursor stays readable (src/clock.ts validEntry).
	const due = validStamp(lastDueAt) ? lastDueAt : undefined;
	const fired = validStamp(lastFiredAt) ? lastFiredAt : undefined;
	const error = typeof lastError === "string" ? lastError : undefined;
	const noteAt = due ?? (validStamp(job.createdAt) ? job.createdAt : undefined);
	let disabled: Disabled | undefined;
	if (!job.enabled) {
		const why = error ?? DISABLED_BY_PERSON;
		const code: Disabled["code"] = why.endsWith(DEAD_SESSION_MARKER) ? "session-gone" : why.startsWith("disabled: cwd ") ? "cwd-missing" : why.startsWith("parked: ") ? "interrupted" : why.startsWith("disabled: ") ? "schedule" : "person";
		const at = [lastCompletedAt, lastFiredAt, job.createdAt].find(validStamp) ?? stamp(0);
		disabled = { code, why, at };
	}
	return {
		job: { ...definition, enabled: job.enabled, ...(disabled ? { disabled } : {}) },
		clock: {
			...(due ? { slot: due } : {}),
			...(fired ? { fired } : {}),
			runs: Number.isInteger(runCount) && runCount >= 0 ? runCount : 0,
			...(Number.isInteger(skippedOverlap) && skippedOverlap > 0 ? { collapsed: skippedOverlap } : {}),
			...(error && job.enabled && noteAt ? { note: { at: noteAt, text: error } } : {}),
			...(validStamp(clearedAt) ? { cleared: clearedAt } : {}),
		},
	};
}

/** Private files of older versions that nothing reads now. */
export const RETIRED_FILES: readonly string[] = ["next-runs.json", "scheduler.json", "presence"];

/**
 * A job as `sidecars/cron.json` carries it. The file stays `version: 1` and its jobs keep 0.24.2's
 * shape, so 0.24.2 can import it and show its run count: the definition, `runCount` and
 * `lastFiredAt` from the cursor, and the reason of a job pi-loops turned off as `lastError`.
 */
export function toArchiveJob(job: LoopJob, clock: JobClock | undefined): Record<string, unknown> {
	const { disabled, proposed: _proposed, ...definition } = job;
	return {
		...definition,
		runCount: clock?.runs ?? 0,
		skippedOverlap: 0,
		...(clock?.fired ? { lastFiredAt: clock.fired } : {}),
		...(disabled && disabled.why !== DISABLED_BY_PERSON ? { lastError: disabled.why } : {}),
	};
}

/** What an archive's job carries into the cursor: its run count and last fire (V4), as 0.24.2's import kept them. */
export function fromArchiveCarry(raw: unknown): RunClose {
	const job = raw as { runCount?: unknown; lastFiredAt?: unknown };
	const runs = typeof job.runCount === "number" && Number.isInteger(job.runCount) && job.runCount > 0 ? job.runCount : undefined;
	const fired = typeof job.lastFiredAt === "string" && Number.isFinite(Date.parse(job.lastFiredAt)) ? job.lastFiredAt : undefined;
	return { ...(runs === undefined ? {} : { ordinal: runs }), ...(fired === undefined ? {} : { fired }) };
}

/** What `convertStores` did, for the log line of the process that ran it. */
export interface Conversion {
	/** The retired private files that were removed. */
	readonly removed: readonly string[];
	/** Jobs written as version 3; 0 when the file was version 3 or absent. */
	readonly jobs: number;
	/** Rows written for an owed slot or a dead marker. */
	readonly rows: number;
}

/**
 * The conversion of a loops directory that 0.24.2 left, at every start (design section 5). Under
 * `jobs.lock`, for a `version: 2` `jobs.json`: (1) each job's cursor into `clock.json`, (2) one row
 * for each owed slot and each dead run marker, (5) `jobs.json.v2.bak`, then `jobs.json` as version 3
 * with the counters dropped and `disabled` from the reason; then (6) the retired files go. No mark
 * says "converted": each step reads its own store, so a crash after any step leaves stores that the
 * next start finishes, and a window and pi-loops can both run it on one directory. A row of a
 * converted slot has an id derived from the job and the slot, so a second attempt appends nothing.
 */
export function convertStores(dir: string, log: (line: string) => void = () => {}): Conversion {
	const converted = convertJobs(dir, log);
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
	return { removed, ...converted };
}

function convertJobs(dir: string, log: (line: string) => void): { jobs: number; rows: number } {
	const jobsFile = path.join(dir, "jobs.json");
	if (!fs.existsSync(jobsFile)) return { jobs: 0, rows: 0 };
	return withFileLockSync(path.join(dir, "jobs.lock"), () => {
		let text: string;
		try { text = fs.readFileSync(jobsFile, "utf8"); }
		catch (err: any) { if (err?.code === "ENOENT") return { jobs: 0, rows: 0 }; throw err; }
		let parsed: { version?: unknown; jobs?: unknown };
		// A file that does not parse is not converted: the store says what is wrong with it, as it did before.
		try { parsed = JSON.parse(text) as typeof parsed; }
		catch { return { jobs: 0, rows: 0 }; }
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.jobs)) return { jobs: 0, rows: 0 };
		// Only a file that says it is version 2 or older is converted: a version that is not a number is not one this code wrote.
		if (typeof parsed.version !== "number" || parsed.version >= JOBS_FILE_VERSION) return { jobs: 0, rows: 0 };
		const jobs = (parsed.jobs as unknown[]).filter((job): job is V2Job => !!job && typeof job === "object" && !Array.isArray(job) && typeof (job as V2Job).id === "string");
		const dropped = parsed.jobs.length - jobs.length;
		const requests = new RequestStore(dir);
		const store = new JobStore(dir);
		const records = store.allRuns();
		const booted = Date.now() - os.uptime() * 1000;
		// Step 1: the cursors. The version 2 file is the truth until step 5 writes version 3, so an entry a partial attempt left is written again.
		const entries: Record<string, JobClock> = {};
		const owed: Array<{ job: V2Job; lane: string; slot: string; attempts: number }> = [];
		for (const job of jobs) {
			const entry = { ...fromV2(job).clock };
			if (validStamp(job.cwdMissingSince)) entry.cwdMissing = job.cwdMissingSince;
			// The lane its owed run goes to: the loop's own, or the conversation a plain job names when that is a conversation's id.
			const lane = job.stateful ? loopLane(job.id) : typeof job.sessionId === "string" && parseLane(job.sessionId)?.kind === "conversation" ? job.sessionId : undefined;
			const running = job.running as unknown;
			const marker = running && typeof running === "object" && typeof (running as RunningMarker).runId === "string" && Number.isInteger((running as RunningMarker).pid) && validStamp((running as RunningMarker).startedAt) ? running as RunningMarker : undefined;
			const lastDue = validStamp(job.lastDueAt) ? job.lastDueAt : undefined;
			let slot = validStamp(job.owedSlot) ? job.owedSlot : undefined;
			if (marker) {
				const record = records.find((r) => r.runId === marker.runId);
				if (record) entry.runs = Math.max(entry.runs, record.ordinal ?? entry.runs + 1);
				else {
					const recycled = Number.isFinite(booted) && Date.parse(marker.startedAt) < booted - 60_000;
					const alive = marker.pid === process.pid || (!recycled && pidAlive(marker.pid));
					if (alive) log(`cron ${job.name ?? job.id}: an older pi-loops process still runs it; its record will come`);
					else if (job.stateful) slot ??= lastDue ?? marker.startedAt;
					else if (lane && !promptWritten(requests, lane, marker.runId)) slot ??= lastDue ?? marker.startedAt;
					else if (lane && !requests.list(lane).some((row) => row.id === marker.runId)) entry.runs++;
				}
			}
			entries[job.id] = entry;
			const interrupted = job.interruptions as unknown;
			if (slot && lane) owed.push({ job, lane, slot, attempts: Number.isInteger(interrupted) && (interrupted as number) > 0 ? Math.min(interrupted as number, DEAD_AFTER_ATTEMPTS) : 0 });
			else if (slot) log(`cron ${job.name ?? job.id}: its owed run is not queued: it names no conversation pi-loops can write to`);
		}
		clockStore(dir).seed(entries);
		// Step 2: the owed slots, each a row of its lane.
		let rows = 0;
		for (const { job, lane, slot, attempts } of owed) {
			const id = plainRunId(job.id, slot);
			const base = plainJobRow(fromV2(job).job, id, `cron:${job.id}`, "", { pid: process.pid, instance: "convert", version: "0" }, Date.now());
			if (requests.appendIfAbsent({ ...base, lane, attempts, payload: { ...base.payload!, slot } })) rows++;
		}
		// Step 5: the version 2 text kept beside, then the definitions as version 3.
		writeFileAtomic(`${jobsFile}.v2.bak`, text);
		writeFileAtomic(jobsFile, `${JSON.stringify({ version: JOBS_FILE_VERSION, jobs: jobs.map((job) => { const { host: _host, ...rest } = job as V2Job & { host?: unknown }; return fromV2(rest as V2Job).job; }) }, null, 2)}\n`);
		log(`jobs.json: version 2 converted to version 3 (${jobs.length} job(s), ${rows} owed run(s) queued${dropped ? `, ${dropped} entr${dropped === 1 ? "y" : "ies"} with no id left out` : ""}); the version 2 file is jobs.json.v2.bak`);
		return { jobs: jobs.length, rows };
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
