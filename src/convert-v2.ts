import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loopLane, parseLane } from "./lane.ts";
import { pidAlive, withFileLockSync, writeFileAtomic } from "./lock.ts";
import { answerStep } from "./ask.ts";
import { Inbox, UNDER_INBOX_LOCK } from "./inbox.ts";
import { RequestStore } from "./requests.ts";
import { TriggerStore } from "./triggers.ts";
import { type JobClock, type RunClose, validStamp } from "./clock.ts";
import { stamp } from "./schedule.ts";
import { holdUpgrade, upgradeHeld } from "./upgrade-hold.ts";
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
export const RETIRED_FILES: readonly string[] = ["next-runs.json", "scheduler.json", "presence", "polls.json", "dedup.json"];

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
	/** Whether this conversion wrote the upgrade's pause (src/upgrade-hold.ts). */
	readonly held: boolean;
	/** Rules of `triggers.json` that gained a `gate` from their `precheck`. */
	readonly gates: number;
}

/**
 * The conversion of a loops directory that 0.24.2 left, at every start (design section 5). Under
 * `jobs.lock`, for a `version: 2` `jobs.json`: (1) each job's cursor into `clock.json`, (2) no row
 * for an owed slot or a dead run marker (each owed slot is logged; a plain job's whose prompt is in its
 * conversation is counted as a run), (5) `jobs.json.v2.bak`, then `jobs.json` as version 3
 * with the counters dropped and `disabled` from the reason; then each claim row of 0.24.2 leaves its
 * queue (`convertClaimRows`), and (6) the retired files go. No mark
 * says "converted": each step reads its own store, so a crash after any step leaves stores that the
 * next start finishes, and a window and pi-loops can both run it on one directory. A row of a
 * converted slot has an id derived from the job and the slot, so a second attempt appends nothing.
 */
export function convertStores(dir: string, log: (line: string) => void = () => {}): Conversion {
	const converted = convertJobs(dir, log);
	const gates = convertRules(dir, log);

	convertClaimRows({ inbox: new Inbox(dir), requests: new RequestStore(dir), audit: new TriggerStore(dir) }, log);
	const removed: string[] = [];
	for (const name of RETIRED_FILES) {
		const file = path.join(dir, name);
		// `pi-loops resume` reads presence/ to see whether pi-loops 0.22 still runs here: kept while the pause holds.
		if (name === "presence" && upgradeHeld(dir)) continue;
		try {
			if (!fs.lstatSync(file, { throwIfNoEntry: false })) continue;
			fs.rmSync(file, { recursive: true, force: true });
			removed.push(name);
		} catch (err: any) {
			log(`could not remove ${name}, which an older version left: ${err?.message ?? err}`);
		}
	}
	return { removed, jobs: converted.jobs, gates, held: converted.held };
}

/** Whether a private file that only an older version writes is in `dir` (`RETIRED_FILES`). */
function retiredFilesThere(dir: string): boolean {
	return RETIRED_FILES.some((name) => {
		try { return !!fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false }); }
		catch { return false; /* not readable: not known to be there */ }
	});
}

/**
 * Step 4 (design section 5, as the owner decided on 2026-11-23): `triggers.json` stays `version: 1`,
 * and a rule that has only 0.24.2's `precheck` gains the same path as a `gate`. Under the rules'
 * lock. A rule that has a `gate` keeps it, and nothing else in the file changes; a file that does not
 * parse is left for the store to say what is wrong with it. A second run finds nothing to fill.
 */
function convertRules(dir: string, log: (line: string) => void): number {
	const file = path.join(dir, "triggers.json");
	if (!fs.existsSync(file)) return 0;
	return withFileLockSync(path.join(dir, "triggers.lock"), () => {
		let parsed: { rules?: unknown };
		try { parsed = JSON.parse(fs.readFileSync(file, "utf8")) as typeof parsed; }
		catch { return 0; }
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.rules)) return 0;
		let filled = 0;
		for (const rule of parsed.rules as unknown[]) {
			if (!rule || typeof rule !== "object" || Array.isArray(rule)) continue;
			const r = rule as { gate?: unknown; precheck?: unknown };
			const pre = r.precheck as { of?: unknown; raw?: unknown; resolved?: unknown } | undefined;
			if (r.gate !== undefined || !pre || typeof pre !== "object" || Array.isArray(pre)) continue;
			r.gate = { kind: "path", of: pre.of, raw: pre.raw, resolved: pre.resolved };
			filled++;
		}
		if (!filled) return 0;
		writeFileAtomic(file, `${JSON.stringify(parsed, null, 2)}\n`);
		log(`triggers.json: ${filled} rule(s) that wait for a path have their gate`);
		return filled;
	});
}


function convertJobs(dir: string, log: (line: string) => void): { jobs: number; held: boolean } {
	const none = { jobs: 0, held: false };
	const jobsFile = path.join(dir, "jobs.json");
	// No jobs.json: an upgrade only when a file that only an older version writes is there (rules, and no
	// loop). It holds too, and an empty version 3 file says it is done.
	if (!fs.existsSync(jobsFile)) {
		if (!retiredFilesThere(dir)) return none;
		return withFileLockSync(path.join(dir, "jobs.lock"), () => {
			if (fs.existsSync(jobsFile)) return none; // another process did it meanwhile
			holdUpgrade(dir);
			writeFileAtomic(jobsFile, `${JSON.stringify({ version: JOBS_FILE_VERSION, jobs: [] }, null, 2)}\n`);
			log("jobs.json: an older pi-loops worked here with rules only; pi-loops is paused until `pi-loops resume`");
			return { jobs: 0, held: true };
		});
	}
	return withFileLockSync(path.join(dir, "jobs.lock"), () => {
		let text: string;
		try { text = fs.readFileSync(jobsFile, "utf8"); }
		catch (err: any) { if (err?.code === "ENOENT") return none; throw err; }
		let parsed: { version?: unknown; jobs?: unknown };
		// A file that does not parse is not converted: the store says what is wrong with it, as it did before.
		try { parsed = JSON.parse(text) as typeof parsed; }
		catch { return none; }
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.jobs)) return none;
		// Only a file that says it is version 2 or older is converted: a version that is not a number is not one this code wrote.
		if (typeof parsed.version !== "number" || parsed.version >= JOBS_FILE_VERSION) return none;
		const jobs = (parsed.jobs as unknown[]).filter((job): job is V2Job => !!job && typeof job === "object" && !Array.isArray(job) && typeof (job as V2Job).id === "string");
		const dropped = parsed.jobs.length - jobs.length;
		const requests = new RequestStore(dir);
		const store = new JobStore(dir);
		const records = store.allRuns();
		const booted = Date.now() - os.uptime() * 1000;
		// Step 1: the cursors. The version 2 file is the truth until step 5 writes version 3, so an entry a partial attempt left is written again.
		const entries: Record<string, JobClock> = {};
		const owed: Array<{ job: V2Job; slot: string }> = [];
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
			if (slot) owed.push({ job, slot });
		}
		clockStore(dir).seed(entries);
		// Step 2, the owed slots: none is queued. The upgrade's pause holds every job until a person resumes
		// it (src/upgrade-hold.ts); then the loop runs as a loop turned on again does.
		for (const { job, slot } of owed) log(`cron ${job.name ?? job.id}: its owed run of ${slot} is not queued: after \`pi-loops resume\` the loop runs as a loop turned on again does`);
		// Step 3: the pause, before the commit point, so a start that stops between the two holds anyway.
		holdUpgrade(dir);
		// Step 5: the version 2 text kept beside, then the definitions as version 3, each as on or off as it
		// was. This write is the upgrade's one commit point: a start that stops before it does every step
		// again, and one after it finds version 3 and does none.
		const v3 = jobs.map((job) => {
			const { host: _host, ...rest } = job as V2Job & { host?: unknown };
			return fromV2(rest as V2Job).job;
		});
		writeFileAtomic(`${jobsFile}.v2.bak`, text);
		const converted = `${JSON.stringify({ version: JOBS_FILE_VERSION, jobs: v3 }, null, 2)}\n`;
		// The store's own backup (`jobs.json.bak`, what it tells a person to restore) is version 2 too
		// while 0.24.2 wrote it last: restored, it would be an upgrade again. It becomes this version's.
		writeFileAtomic(`${jobsFile}.bak`, converted);
		writeFileAtomic(jobsFile, converted);
		log(`jobs.json: version 2 converted to version 3 (${jobs.length} job(s)${dropped ? `, ${dropped} entr${dropped === 1 ? "y" : "ies"} with no id left out` : ""}); the version 2 file is jobs.json.v2.bak; pi-loops is paused until \`pi-loops resume\``);
		return { jobs: jobs.length, held: true };
	});
}

function promptWritten(requests: RequestStore, session: string, runId: string): boolean {
	const leasePath = path.join(requests.dir, "leases", `${session}.json`);
	let file: string | undefined;
	try { file = (JSON.parse(fs.readFileSync(leasePath, "utf8")) as { sessionFile?: string }).sessionFile; }
	catch { /* no lease file */ }
	if (!file) return false;
	try {
		// Only a regular file: a read of a FIFO would hold the conversion, and the start, for ever.
		if (!fs.statSync(file).isFile()) return false;
		return fs.readFileSync(file, "utf8").split("\n").some((line) => line.includes(`[Trigger ${runId}] `));
	} catch { return false; }
}

/** The stores `convertClaimRows` reads and writes: a test logs each write and stops the process after any of them. */
export interface ClaimRowStores {
	inbox: Pick<Inbox, "sectionSync">;
	requests: Pick<RequestStore, "sessions" | "list" | "removeIf">;
	audit: Pick<TriggerStore, "appendAudit">;
}

/** The source of a row that 0.24.2's `/inbox claim` queued: `inbox:` and the finding's id. No source of this version starts so. */
const OLD_CLAIM = "inbox:";

/**
 * The third step of `convertStores` (design section 5; K1 and K2 of `PROTOCOL` in test/answer-protocol.ts): each
 * row of a conversation that 0.24.2 queued for a claim leaves its lane. For each, one
 * `inbox.sectionSync`, and inside it one `removeIf` that decides on the row as it is under the lane's lock:
 *   - K1, `handed_at` is set: pi had the claim before the upgrade, so the row leaves and its finding stays claimed.
 *   - K2, no `handed_at`: `answerStep("K2")` opens its finding again if it is still 0.24.2's claim, then the row leaves.
 *     A finding that is gone, or that a person answered since, is left as it is.
 * Each row's audit comes after both locks. A stop at any write leaves the row or nothing: the next
 * start finds the row again, and a finding that is `new` already is not written twice.
 */
export function convertClaimRows(stores: ClaimRowStores, log: (line: string) => void): { handed: number; reopened: number } {
	const out = { handed: 0, reopened: 0 };
	for (const lane of stores.requests.sessions()) {
		for (const row of stores.requests.list(lane)) {
			const source = row.source as string;
			if (row.kind !== "input" || !source.startsWith(OLD_CLAIM)) continue;
			const finding = source.slice(OLD_CLAIM.length);
			try {
				let reason: string | undefined;
				let cwd = row.payload?.cwd ?? "";
				const taken = stores.inbox.sectionSync((tx) =>
					stores.requests.removeIf(lane, row.id, (now) => {
						if (now.handed_at !== undefined) {
							reason = "handed over before the upgrade";
							return true;
						}
						const there = tx.find(finding);
						if (!there) reason = "its finding is not in the inbox";
						else {
							cwd = there.cwd;
							const reopen = answerStep("K2", there, { to: "none" }, { at: stamp(), lane: undefined });
							if (!("refused" in reopen)) {
								tx.write(reopen);
								out.reopened++;
							}
							reason = !("refused" in reopen) || there.status === "new" ? "open again after the upgrade" : "its finding was answered since";
						}
						return true;
					}, UNDER_INBOX_LOCK),
				);
				if (taken.outcome !== "removed" || reason === undefined) continue;
				if (taken.row.handed_at !== undefined) out.handed++;
				stores.audit.appendAudit({ cwd, type: "request", traceId: row.id, state: "converted", sourceLabel: source, eventLabel: lane, details: { session_id: lane, kind: row.kind, finding, reason } });
			} catch (err: unknown) {
				log(`the claim ${row.id} queued before the upgrade was not converted; the next start tries again: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}
	if (out.handed || out.reopened) log(`${out.handed} claim(s) handed over before the upgrade left their queue; ${out.reopened} claim(s) queued before the upgrade are open again in the inbox`);
	return out;
}
