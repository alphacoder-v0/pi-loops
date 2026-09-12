/**
 * Persistent job store: one JSON file shared by every pi process on the machine,
 * plus per-job loop-state Markdown files and a run log.
 *
 * Layout (default root ~/.pi/agent/loops, override with PI_LOOPS_DIR):
 *   jobs.json            all jobs (global, survives pi restarts)
 *   state/<job-id>.md    loop state — the "state spine", human-readable
 *   inbox.jsonl          the triage inbox (see inbox.ts)
 *   runs.jsonl           run log, bounded
 *   scheduler.<host>.json  which process on this machine currently owns the timer
 *   *.lock               mkdir locks
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { withFileLock, withFileLockSync, writeFileAtomic } from "./lock.ts";
import { LOOP_STATE_MAX_CHARS, capChars } from "./protocol.ts";
import type { Schedule } from "./schedule.ts";

export const MAX_PROMPT_BYTES = 8192;

export interface RunningMarker {
	/** The machine that started it: another host's pid table says nothing about this run. */
	host?: string;
	runId: string;
	pid: number;
	startedAt: string;
}

export interface LoopJob {
	id: string;
	name?: string;
	schedule: Schedule;
	/** false = inject-and-run into the owning session; true = loop (fresh sub-agent + state spine + inbox). */
	stateful: boolean;
	prompt: string;
	/** Working directory the sub-agent runs in. */
	cwd: string;
	/** "provider/model-id" for the sub-agent; undefined → inherit from the hosting session at run time. */
	model?: string;
	thinking?: string;
	tools?: string[];
	enabled: boolean;
	/** Maker/checker: a second sub-agent reviews findings before they enter the inbox. */
	verify?: boolean;
	/** "provider/model-id" for the checker; undefined → same as the maker. */
	checkerModel?: string;
	/** Fire once on startup if a tick was missed while no pi was running (default true). */
	catchUp: boolean;
	timeoutMs?: number;
	createdAt: string;
	createdBy?: { sessionId?: string; cwd: string };
	/** Host the job belongs to (shared $HOME across machines): other hosts ignore it. Missing = any host (pre-0.1.3). */
	host?: string;
	/** non-stateful jobs only: the session that receives the message. */
	sessionId?: string;
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

export interface RunRecord {
	runId: string;
	jobId: string;
	jobName?: string;
	stateful: boolean;
	cwd: string;
	pid: number;
	startedAt: string;
	finishedAt: string;
	ok: boolean;
	exitCode?: number;
	error?: string;
	findings: number;
	droppedFindings: number;
	stateUpdated: boolean;
	model?: string;
	usage?: { input: number; output: number; cost: number; turns: number; cacheRead?: number; cacheWrite?: number };
	/** Something the run survived but the user should know about (a pinned model that fell back). */
	warning?: string;
	/** Provider retries and context compactions inside the run: a quiet retry storm looks clean without these. */
	retries?: number;
	compactions?: number;
	summary?: string;
	/** Child session id / transcript file (inspect with /cron trace, resume with `pi --session <file>`). */
	sessionId?: string;
	sessionFile?: string;
	/** Present when the job has verify=true and the maker reported findings. */
	checker?: CheckerRecord;
}

export interface CheckerRecord {
	ok: boolean;
	error?: string;
	/** Findings the checker kept (after rewrite) — these entered the inbox. */
	kept: number;
	/** Findings the checker dropped, with its reasons. */
	dropped: Array<{ text: string; reason: string }>;
	/** Findings the checker gave no verdict for; they enter the inbox marked unverified. */
	unreviewed: number;
	durationMs: number;
	cost: number;
	model?: string;
	sessionFile?: string;
}

/** Transcripts kept per loop; older ones are deleted when a run completes. */
export const SESSIONS_KEPT_PER_JOB = 20;

/** Past this the run log is halved (docs/configuration.md). */
export const RUNS_ROTATE_BYTES = 1_000_000;

export function defaultLoopsDir(agentDir?: string): string {
	if (process.env.PI_LOOPS_DIR) return process.env.PI_LOOPS_DIR;
	const base = agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	return path.join(base, "loops");
}

/**
 * Which session a plain (inject) job belongs to. A sub-agent that schedules one is acting for the
 * session that runs it, so the parent's id wins over the child's throwaway one. Loops are
 * machine-global and belong to no session.
 */
export function owningSessionId(stateful: boolean, sessionId: string | undefined, parentSessionId?: string): string | undefined {
	if (stateful) return undefined;
	return parentSessionId || sessionId;
}

/**
 * Does pi still have a session with this id? A plain job whose session is gone can never inject
 * again, so this is what parks one.
 *
 * pi names the sessions it starts `<sessionsRoot>/<encoded cwd>/<timestamp>_<id>.jsonl`, and that
 * name is the cheap answer. It is not the authority, though: a session started from the browser
 * front end is created by asking pi to switch to a path that does not exist yet, and the id pi
 * mints for it cannot be known in time to put in the name. Believing the name disabled every
 * inject-and-run job in such a session ten minutes after it was made — and `/cron gc` deletes what
 * this parks. The header is what `listSessions` already reads, and it is what decides here too.
 */
export function sessionExists(sessionsRoot: string, sessionId: string): boolean {
	let projects: string[];
	try {
		projects = fs.readdirSync(sessionsRoot);
	} catch {
		return false;
	}
	const suffix = `_${sessionId}.jsonl`;
	const rest: Array<[string, string[]]> = [];
	for (const p of projects) {
		const dir = path.join(sessionsRoot, p);
		let files: string[];
		try {
			files = fs.readdirSync(dir);
		} catch {
			continue; // not a directory
		}
		if (files.some((f) => f.endsWith(suffix) || f === `${sessionId}.jsonl`)) return true;
		rest.push([dir, files]);
	}
	// Nothing is named after it, which is the usual answer for a session that is really gone — so
	// this second pass runs on the way to "no", and the scan that calls it runs every ten minutes.
	for (const [dir, files] of rest) {
		for (const f of files) {
			if (!f.endsWith(".jsonl")) continue;
			if (sessionIdOf(path.join(dir, f)) === sessionId) return true;
		}
	}
	return false;
}

/** The id in a session file's header, without reading the transcript behind it. */
function sessionIdOf(file: string): string | undefined {
	let head: string;
	try {
		// A regular file, checked before it is opened. Anything else in this directory is not a
		// session — and a fifo named like one never returns from `openSync`, which would hang the
		// scan this is called from, on the leader's tick, for ever.
		if (!fs.statSync(file).isFile()) return undefined;
		const fd = fs.openSync(file, "r");
		try {
			const buf = Buffer.alloc(4096);
			head = buf.toString("utf8", 0, fs.readSync(fd, buf, 0, buf.length, 0));
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
	try {
		const header = JSON.parse(head.split("\n", 1)[0] ?? "");
		return header?.type === "session" && typeof header.id === "string" ? header.id : undefined;
	} catch {
		return undefined;
	}
}

/** `<prefix>-<uuid simple>` (32 hex). Prefixes, names and ordinals still resolve (`resolveJobRef`). */
export function newId(prefix: string): string {
	return `${prefix}-${randomBytes(16).toString("hex")}`;
}

/**
 * A hostname as one filename component: `scheduler.<tag>.json`, `next-runs.<tag>.json`, one
 * presence file per pi. Two machines sharing a `$HOME` must not write over each other, and a
 * hostname may contain characters a path segment may not.
 *
 * `src/web.mjs` spells the same expression out again because it has no imports, and `src/presence.ts`
 * has its own copy; `test/store.test.ts` pins those spellings to this one.
 */
export function hostFileTag(host: string = os.hostname()): string {
	return host.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * On-disk shape of `jobs.json`, bumped whenever a field becomes load-bearing, so an older pi-loops sharing this directory refuses
 * the file instead of silently rewriting it without that field. Version 2 adds `host` (which gates
 * dispatch), `verify`/`checkerModel`, `timeoutMs` and `consecutiveFailures`.
 */
export const JOBS_FILE_VERSION = 2;

/** Local `YYYY-MM-DD`, so a day boundary means the same thing here as it does to the user. */
function localDay(ms: number): string {
	return new Date(ms).toLocaleDateString("en-CA");
}

interface JobsFile {
	version: number;
	jobs: LoopJob[];
}

export class JobStore {
	readonly dir: string;
	readonly jobsFile: string;
	readonly stateDir: string;
	readonly runsFile: string;
	readonly sessionsDir: string;
	private readonly lockPath: string;
	private readonly runsLockPath: string;

	constructor(dir: string) {
		this.dir = dir;
		this.jobsFile = path.join(dir, "jobs.json");
		this.stateDir = path.join(dir, "state");
		this.runsFile = path.join(dir, "runs.jsonl");
		this.sessionsDir = path.join(dir, "sessions");
		this.lockPath = path.join(dir, "jobs.lock");
		this.runsLockPath = path.join(dir, "runs.lock");
	}

	/** Where a job's sub-agent transcripts live. Created on demand. */
	sessionDirFor(jobId: string): string {
		const dir = path.join(this.sessionsDir, jobId);
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	}

	/** Keep only the newest `keep` transcripts of a job. Best effort. */
	pruneSessions(jobId: string, keep = SESSIONS_KEPT_PER_JOB): void {
		const dir = path.join(this.sessionsDir, jobId);
		try {
			const files = fs
				.readdirSync(dir)
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
				.sort((a, b) => b.mtime - a.mtime);
			for (const { f } of files.slice(keep)) fs.rmSync(path.join(dir, f), { force: true });
		} catch {
			/* nothing to prune */
		}
	}

	/** Read all jobs. A missing file is an empty store; a corrupt or too-new file throws. */
	load(): LoopJob[] {
		return this.parse(this.read());
	}

	/** The file exactly as it is on disk, or undefined when it does not exist yet. */
	private read(): string | undefined {
		try {
			return fs.readFileSync(this.jobsFile, "utf8");
		} catch (err: any) {
			if (err?.code === "ENOENT") return undefined;
			throw err;
		}
	}

	private parse(text: string | undefined): LoopJob[] {
		if (text === undefined) return []; // no file yet: a machine with no jobs
		// An existing but empty file is damage (a torn write, an external truncation), not "no jobs".
		// Returning [] here would let the next tick's write erase every job with no error anywhere.
		if (!text.trim()) throw new Error(`${this.jobsFile} is empty; restore it from ${this.jobsFile}.bak or delete it to start over`);
		const parsed = JSON.parse(text) as JobsFile;
		// A file stamped by a newer pi-loops may carry fields this build does not know and would
		// drop on its next write. Refuse it instead: two versions sharing a $HOME must not silently
		// downgrade each other's jobs.
		if (typeof parsed?.version === "number" && parsed.version > JOBS_FILE_VERSION) {
			throw new Error(`${this.jobsFile}: version ${parsed.version} was written by a newer pi-loops (this build understands ${JOBS_FILE_VERSION}); upgrade pi-loops`);
		}
		if (!Array.isArray(parsed?.jobs)) throw new Error(`${this.jobsFile}: missing "jobs" array`);
		return parsed.jobs;
	}

	/** The last content that parsed, so a truncated `jobs.json` has something to restore from. */
	private backup(text: string): void {
		try {
			writeFileAtomic(`${this.jobsFile}.bak`, text);
		} catch {
			/* a backup is a courtesy, never a reason to fail a write */
		}
	}

	private serialize(jobs: LoopJob[]): string {
		const file: JobsFile = { version: JOBS_FILE_VERSION, jobs };
		return `${JSON.stringify(file, null, 2)}\n`;
	}

	/**
	 * Read-modify-write under the cross-process lock. `fn` returns the new job list.
	 *
	 * A pass that changes nothing writes nothing: every pi window runs this on every 30s tick, so an
	 * unconditional save means three idle windows rewriting the file 8640 times a day — and a file
	 * whose mtime moves constantly tells a reader nothing about when the automation last changed.
	 */
	async mutate<T>(fn: (jobs: LoopJob[]) => { jobs: LoopJob[]; result: T }): Promise<T> {
		return withFileLock(this.lockPath, () => {
			const before = this.read();
			const { jobs, result } = fn(this.parse(before));
			if (before === undefined && !jobs.length) return result; // no file and no jobs: create nothing
			const next = this.serialize(jobs);
			if (next !== before) {
				// The content that just parsed is worth keeping: it is what a truncated file is restored from.
				if (before !== undefined) this.backup(before);
				writeFileAtomic(this.jobsFile, next);
			}
			return result;
		});
	}

	/** Update one job in place. Returns the updated job, or undefined when it no longer exists. */
	async update(id: string, patch: (job: LoopJob) => void): Promise<LoopJob | undefined> {
		return this.mutate((jobs) => {
			const job = jobs.find((j) => j.id === id);
			if (job) patch(job);
			return { jobs, result: job };
		});
	}

	async add(job: LoopJob): Promise<LoopJob> {
		return this.mutate((jobs) => ({ jobs: [...jobs, job], result: job }));
	}

	/** Remove every job matching `pred` (state files and transcripts included); returns them. */
	async removeWhere(pred: (job: LoopJob) => boolean): Promise<LoopJob[]> {
		const removed = await this.mutate((jobs) => ({ jobs: jobs.filter((j) => !pred(j)), result: jobs.filter(pred) }));
		for (const job of removed) {
			try {
				fs.rmSync(this.statePath(job.id), { force: true });
				fs.rmSync(path.join(this.sessionsDir, job.id), { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
		return removed;
	}

	/**
	 * Remove a job. Its loop state — the notes it accumulated over months, and the whole reason a
	 * stateful loop can say "only what changed" — is kept unless `purge` is set, because the usual
	 * way to change a job's schedule or prompt is to remove it and add it again. Nothing deletes
	 * the state file from any production path either. Transcripts follow the state.
	 */
	async remove(id: string, opts: { purge?: boolean } = {}): Promise<LoopJob | undefined> {
		const removed = await this.mutate((jobs) => {
			const job = jobs.find((j) => j.id === id);
			return { jobs: jobs.filter((j) => j.id !== id), result: job };
		});
		if (removed && opts.purge) {
			try {
				fs.rmSync(this.statePath(id), { force: true });
				fs.rmSync(path.join(this.sessionsDir, id), { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
		return removed;
	}

	/** Delete one loop's state and transcripts (`/cron gc --purge`). */
	purgeState(id: string): void {
		try {
			fs.rmSync(this.statePath(id), { force: true });
			fs.rmSync(path.join(this.sessionsDir, id), { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}

	/** Loop state left behind by removed jobs, so `/cron gc` can offer to clear it. */
	orphanStates(): Array<{ id: string; bytes: number }> {
		const live = new Set(this.load().map((j) => j.id));
		try {
			return fs
				.readdirSync(path.join(this.dir, "state"))
				.filter((f) => f.endsWith(".md") && !live.has(f.slice(0, -3)))
				.map((f) => ({ id: f.slice(0, -3), bytes: fs.statSync(path.join(this.dir, "state", f)).size }));
		} catch {
			return [];
		}
	}

	/* ---------------------------------------------------- loop state */

	statePath(jobId: string): string {
		return path.join(this.stateDir, `${jobId}.md`);
	}

	readState(jobId: string): string | undefined {
		try {
			const text = fs.readFileSync(this.statePath(jobId), "utf8");
			return text.trim() ? capChars(text, LOOP_STATE_MAX_CHARS) : undefined;
		} catch (err: any) {
			if (err?.code === "ENOENT") return undefined;
			throw err;
		}
	}

	writeState(jobId: string, state: string): void {
		writeFileAtomic(this.statePath(jobId), `${capChars(state, LOOP_STATE_MAX_CHARS)}\n`);
	}

	/* ------------------------------------------------------- run log */

	/**
	 * Append one run record, then rotate if the log grew past its cap. Both under `runs.lock`:
	 * rotation rewrites the whole file, so an append that walked in between another process's read
	 * and its write would simply be lost. Its own lock rather than `jobs.lock` — this is a
	 * synchronous spin, and `mutate` holds `jobs.lock` across an await.
	 */
	appendRun(record: RunRecord): void {
		fs.mkdirSync(this.dir, { recursive: true });
		withFileLockSync(this.runsLockPath, () => {
			fs.appendFileSync(this.runsFile, `${JSON.stringify(record)}\n`, "utf8");
			this.rotateRuns();
		});
	}

	listRuns(jobId?: string, limit = 20): RunRecord[] {
		let text: string;
		try {
			text = fs.readFileSync(this.runsFile, "utf8");
		} catch (err: any) {
			if (err?.code === "ENOENT") return [];
			throw err;
		}
		const out: RunRecord[] = [];
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const rec = JSON.parse(line) as RunRecord;
				if (!jobId || rec.jobId === jobId) out.push(rec);
			} catch {
				/* skip corrupt line */
			}
		}
		return out.slice(-limit);
	}

	/**
	 * What automation has cost since `sinceMs`. A loop that dies with its session never needs this;
	 * one that outlives it does, because nobody is watching the bill. A headless host runs for days,
	 * so the only way a user learns the cost is if something adds it up.
	 *
	 * `total` includes `rotated` — costs whose individual records the log has already
	 * dropped — because a cap that forgets what rotation ate stops capping. `byJob` covers only the
	 * records still in the log, and `sinceMs` is rounded down to its local day for the rotated part.
	 */
	spend(sinceMs: number): { total: number; runs: number; rotated: number; byJob: Map<string, { cost: number; runs: number; name?: string }> } {
		const byJob = new Map<string, { cost: number; runs: number; name?: string }>();
		let total = 0;
		let runs = 0;
		for (const rec of this.allRuns()) {
			const at = Date.parse(rec.finishedAt || rec.startedAt);
			// An unparseable stamp must not count toward today forever: one such record carrying a
			// real cost above the cap would pause every job on the machine, permanently.
			if (!Number.isFinite(at) || at < sinceMs) continue;
			const cost = (rec.usage?.cost ?? 0) + (rec.checker?.cost ?? 0);
			total += cost;
			runs++;
			const entry = byJob.get(rec.jobId) ?? { cost: 0, runs: 0, name: rec.jobName };
			entry.cost += cost;
			entry.runs++;
			if (rec.jobName) entry.name = rec.jobName;
			byJob.set(rec.jobId, entry);
		}
		const rotated = this.rotatedSpend(sinceMs);
		return { total: total + rotated, runs, rotated, byJob };
	}

	/** Every record still in the log (it is rotated, so this is bounded). */
	allRuns(): RunRecord[] {
		return this.listRuns(undefined, Number.MAX_SAFE_INTEGER);
	}

	/**
	 * Halve the log once it passes `RUNS_ROTATE_BYTES`, after folding what is about to be dropped
	 * into the daily totals. The log rotates by size, so on a busy machine the morning's records can
	 * be gone before the day is over — and a spend cap reading only the log would then see the day as
	 * cheap and resume dispatching. `spend.json` is a few hundred bytes and rotation never touches
	 * it. Caller holds `runs.lock`.
	 */
	private rotateRuns(): void {
		try {
			const size = fs.statSync(this.runsFile).size;
			if (size < RUNS_ROTATE_BYTES) return;
			const lines = fs.readFileSync(this.runsFile, "utf8").split("\n").filter(Boolean);
			const keep = Math.floor(lines.length / 2);
			// One record can be over the limit on its own, and `slice(-0)` is the whole array — so
			// without this the file would never shrink and its cost would be counted twice.
			this.foldSpend(keep === 0 ? lines : lines.slice(0, lines.length - keep));
			writeFileAtomic(this.runsFile, keep === 0 ? "" : `${lines.slice(-keep).join("\n")}\n`);
		} catch {
			/* best effort */
		}
	}

	/** Daily totals that outlive rotation: `{ "2026-09-09": 1.23 }`, kept for a week. */
	private foldSpend(dropped: string[]): void {
		const totals = this.rotatedSpendByDay();
		for (const line of dropped) {
			try {
				const rec = JSON.parse(line) as RunRecord;
				const at = Date.parse(rec.finishedAt || rec.startedAt);
				if (!Number.isFinite(at)) continue;
				const day = localDay(at);
				totals[day] = (totals[day] ?? 0) + (rec.usage?.cost ?? 0) + (rec.checker?.cost ?? 0);
			} catch {
				/* skip corrupt line */
			}
		}
		const cutoff = localDay(Date.now() - 7 * 86_400_000);
		for (const day of Object.keys(totals)) if (day < cutoff) delete totals[day];
		try {
			writeFileAtomic(path.join(this.dir, "spend.json"), JSON.stringify(totals));
		} catch {
			/* best effort */
		}
	}

	private rotatedSpendByDay(): Record<string, number> {
		try {
			const parsed = JSON.parse(fs.readFileSync(path.join(this.dir, "spend.json"), "utf8")) as unknown;
			if (!parsed || typeof parsed !== "object") return {};
			const out: Record<string, number> = {};
			for (const [day, cost] of Object.entries(parsed as Record<string, unknown>)) {
				if (typeof cost === "number" && Number.isFinite(cost)) out[day] = cost;
			}
			return out;
		} catch {
			return {};
		}
	}

	/** What rotation already folded away on or after `sinceMs`, so a cap still counts it. */
	rotatedSpend(sinceMs: number): number {
		const from = localDay(sinceMs);
		let total = 0;
		for (const [day, cost] of Object.entries(this.rotatedSpendByDay())) if (day >= from) total += cost;
		return total;
	}
}

/** Resolve "<n>" (1-based position in `jobs`) or an id / unique id prefix / exact name. */
export function resolveJobRef(jobs: LoopJob[], ref: string): LoopJob | undefined {
	const trimmed = ref.trim();
	if (!trimmed) return undefined;
	if (/^\d+$/.test(trimmed)) return jobs[Number(trimmed) - 1];
	const exact = jobs.find((j) => j.id === trimmed || j.name === trimmed);
	if (exact) return exact;
	const byPrefix = jobs.filter((j) => j.id.startsWith(trimmed));
	return byPrefix.length === 1 ? byPrefix[0] : undefined;
}
