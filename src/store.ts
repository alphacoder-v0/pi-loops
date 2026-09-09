/**
 * Persistent job store: one JSON file shared by every pi process on the machine,
 * plus per-job loop-state Markdown files and a run log.
 *
 * Layout (default root ~/.pi/agent/loops, override with PI_LOOPS_DIR):
 *   jobs.json            all jobs (global, survives pi restarts)
 *   state/<job-id>.md    loop state — the "state spine", human-readable
 *   inbox.jsonl          the triage inbox (see inbox.ts)
 *   runs.jsonl           run log, bounded
 *   scheduler.json       which process currently owns the timer
 *   *.lock               mkdir locks
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { withFileLock, writeFileAtomic } from "./lock.ts";
import { LOOP_STATE_MAX_CHARS, capChars } from "./protocol.ts";
import type { Schedule } from "./schedule.ts";

export const MAX_PROMPT_BYTES = 8192;

export interface RunningMarker {
	runId: string;
	pid: number;
	startedAt: string;
}

export interface LoopJob {
	id: string;
	name?: string;
	schedule: Schedule;
	/** pie semantics: false = inject-and-run into the owning session; true = loop (fresh sub-agent + state spine + inbox). */
	stateful: boolean;
	prompt: string;
	/** Working directory the sub-agent runs in. */
	cwd: string;
	/** "provider/model-id" for the sub-agent; undefined → inherit from the hosting session at run time. */
	model?: string;
	thinking?: string;
	tools?: string[];
	enabled: boolean;
	/** Maker/checker (pie phase 3): a second sub-agent reviews findings before they enter the inbox. */
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
	usage?: { input: number; output: number; cost: number; turns: number };
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

export function defaultLoopsDir(agentDir?: string): string {
	if (process.env.PI_LOOPS_DIR) return process.env.PI_LOOPS_DIR;
	const base = agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	return path.join(base, "loops");
}

/**
 * Which session a plain (inject) job belongs to. A sub-agent that schedules one is acting for the
 * session that runs it — pie writes the job into the parent session's cron.toml — so the parent's
 * id wins over the child's own throwaway session. Loops are machine-global and belong to none.
 */
export function owningSessionId(stateful: boolean, sessionId: string | undefined, parentSessionId?: string): string | undefined {
	if (stateful) return undefined;
	return parentSessionId || sessionId;
}

/**
 * Does pi still have a session with this id? pi keeps `<sessionsRoot>/<encoded cwd>/<timestamp>_<id>.jsonl`;
 * a plain job whose session is gone can never inject again (pie deletes the sidecars with the session).
 */
export function sessionExists(sessionsRoot: string, sessionId: string): boolean {
	let projects: string[];
	try {
		projects = fs.readdirSync(sessionsRoot);
	} catch {
		return false;
	}
	const suffix = `_${sessionId}.jsonl`;
	for (const p of projects) {
		try {
			if (fs.readdirSync(path.join(sessionsRoot, p)).some((f) => f.endsWith(suffix) || f === `${sessionId}.jsonl`)) return true;
		} catch {
			/* not a directory */
		}
	}
	return false;
}

/** pie: `<prefix>-<uuid simple>` (32 hex). Prefixes, names and ordinals still resolve (`resolveJobRef`). */
export function newId(prefix: string): string {
	return `${prefix}-${randomBytes(16).toString("hex")}`;
}

interface JobsFile {
	version: 1;
	jobs: LoopJob[];
}

export class JobStore {
	readonly dir: string;
	readonly jobsFile: string;
	readonly stateDir: string;
	readonly runsFile: string;
	readonly sessionsDir: string;
	private readonly lockPath: string;

	constructor(dir: string) {
		this.dir = dir;
		this.jobsFile = path.join(dir, "jobs.json");
		this.stateDir = path.join(dir, "state");
		this.runsFile = path.join(dir, "runs.jsonl");
		this.sessionsDir = path.join(dir, "sessions");
		this.lockPath = path.join(dir, "jobs.lock");
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

	/** Read all jobs. A missing file is an empty store; a corrupt file throws. */
	load(): LoopJob[] {
		let text: string;
		try {
			text = fs.readFileSync(this.jobsFile, "utf8");
		} catch (err: any) {
			if (err?.code === "ENOENT") return [];
			throw err;
		}
		if (!text.trim()) return [];
		const parsed = JSON.parse(text) as JobsFile;
		if (!Array.isArray(parsed?.jobs)) throw new Error(`${this.jobsFile}: missing "jobs" array`);
		return parsed.jobs;
	}

	private save(jobs: LoopJob[]): void {
		const file: JobsFile = { version: 1, jobs };
		writeFileAtomic(this.jobsFile, `${JSON.stringify(file, null, 2)}\n`);
	}

	/** Read-modify-write under the cross-process lock. `fn` returns the new job list. */
	async mutate<T>(fn: (jobs: LoopJob[]) => { jobs: LoopJob[]; result: T }): Promise<T> {
		return withFileLock(this.lockPath, () => {
			const { jobs, result } = fn(this.load());
			this.save(jobs);
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

	async remove(id: string): Promise<LoopJob | undefined> {
		const removed = await this.mutate((jobs) => {
			const job = jobs.find((j) => j.id === id);
			return { jobs: jobs.filter((j) => j.id !== id), result: job };
		});
		if (removed) {
			try {
				fs.rmSync(this.statePath(id), { force: true });
				fs.rmSync(path.join(this.sessionsDir, id), { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
		return removed;
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

	appendRun(record: RunRecord): void {
		fs.mkdirSync(this.dir, { recursive: true });
		fs.appendFileSync(this.runsFile, `${JSON.stringify(record)}\n`, "utf8");
		this.maybeRotateRuns();
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

	private maybeRotateRuns(): void {
		try {
			const size = fs.statSync(this.runsFile).size;
			if (size < 1_000_000) return;
			const lines = fs.readFileSync(this.runsFile, "utf8").split("\n").filter(Boolean);
			writeFileAtomic(this.runsFile, `${lines.slice(-Math.floor(lines.length / 2)).join("\n")}\n`);
		} catch {
			/* best effort */
		}
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
