/**
 * The heartbeat. One pi process on the machine owns the timer at a time
 * (leadership lives in scheduler.json with a heartbeat); every other process
 * with this extension stands by and takes over when the owner exits or dies.
 * Loop jobs are therefore host-agnostic: close the pi that created a loop and
 * any other open pi keeps it ticking; restart pi and missed ticks are caught up
 * (once, collapsed) unless the job opted out.
 *
 * Inject-mode jobs are session-bound: they only fire from the process whose
 * current session is the one that created them.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Inbox } from "./inbox.ts";
import { pidAlive, withFileLock, writeFileAtomic } from "./lock.ts";
import { composeCheckerPrompt, composeLoopPrompt, parseCheckerOutput, parseRunOutput, stripProtocolTags } from "./protocol.ts";
import { runPiSubagent, type RunnerResult } from "./runner.ts";
import { previewRedacted, redact } from "./redact.ts";
import { computeDue, formatLocal } from "./schedule.ts";
import { type CheckerRecord, JobStore, type LoopJob, type RunRecord, newId } from "./store.ts";

export const DEFAULT_TICK_MS = 30_000;
export const LEADER_STALE_MS = 90_000;
export const DEFAULT_RUN_TIMEOUT_MS = 15 * 60_000;
export const MAX_CONCURRENT_RUNS = 3;

export interface SessionSnapshot {
	sessionId?: string;
	cwd: string;
	model?: string;
	thinking?: string;
}

export interface RunOutcome {
	job: LoopJob;
	record: RunRecord;
	findings: string[];
	result: RunnerResult;
}

export interface SchedulerHooks {
	/** Inject-mode job is due: deliver `prompt` to the current session. */
	onInject?: (job: LoopJob, prompt: string) => void | Promise<void>;
	onRunStart?: (job: LoopJob, runId: string) => void;
	/** A run is being fired for a tick that was missed while no pi was open. */
	onCatchUp?: (job: LoopJob, dueAt: number) => void;
	onRunFinished?: (outcome: RunOutcome) => void;
	onInboxChanged?: () => void;
	/** Every tick, after leadership is settled. Other subsystems (dynamic triggers) piggyback on it. */
	onTick?: (now: number, leader: boolean) => void | Promise<void>;
	/** Leadership gained or lost. */
	onLeadership?: (leader: boolean) => void | Promise<void>;
	log?: (message: string) => void;
}

export interface SchedulerOptions {
	dir: string;
	getSession: () => SessionSnapshot;
	hooks?: SchedulerHooks;
	tickMs?: number;
	piBin?: string;
	now?: () => number;
	/** Trigger hop of this process; sub-agents get hop + 1. */
	hop?: number;
}

interface LeaderRecord {
	pid: number;
	host: string;
	/** Distinguishes scheduler instances inside one process (reload, tests). */
	instance: string;
	sessionId?: string;
	startedAt: string;
	heartbeatAt: string;
}

export class LoopScheduler {
	readonly store: JobStore;
	readonly inbox: Inbox;
	private readonly dir: string;
	private readonly leaderFile: string;
	private readonly leaderLock: string;
	private readonly getSession: () => SessionSnapshot;
	private readonly hooks: SchedulerHooks;
	private readonly tickMs: number;
	private readonly piBin?: string;
	private readonly now: () => number;
	private readonly hop: number;
	private timer: NodeJS.Timeout | undefined;
	private ticking = false;
	private leader = false;
	private startedAt = 0;
	private readonly inflight = new Map<string, { ctrl: AbortController; label: string; jobId: string; startedAt: string; promptPreview: string }>();
	private readonly instance = newId("sched");

	constructor(opts: SchedulerOptions) {
		this.dir = opts.dir;
		this.store = new JobStore(opts.dir);
		this.inbox = new Inbox(opts.dir);
		this.leaderFile = path.join(opts.dir, "scheduler.json");
		this.leaderLock = path.join(opts.dir, "scheduler.lock");
		this.getSession = opts.getSession;
		this.hooks = opts.hooks ?? {};
		this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
		this.piBin = opts.piBin;
		this.now = opts.now ?? Date.now;
		this.hop = opts.hop ?? 0;
	}

	get isLeader(): boolean {
		return this.leader;
	}

	get runningCount(): number {
		return this.inflight.size;
	}

	/** Labels of the loops this process is running right now. */
	runningLabels(): string[] {
		return [...this.inflight.values()].map((r) => r.label);
	}

	/** In-flight runs with the details `/triggers running` shows. */
	runningRuns(): Array<{ runId: string; label: string; jobId: string; startedAt: string; promptPreview: string }> {
		return [...this.inflight.entries()].map(([runId, r]) => ({ runId, label: r.label, jobId: r.jobId, startedAt: r.startedAt, promptPreview: r.promptPreview }));
	}

	/** Abort one in-flight run (kills the sub-agent). */
	abortRun(runId: string): boolean {
		const r = this.inflight.get(runId);
		if (!r) return false;
		r.ctrl.abort();
		return true;
	}

	/** Idempotent. Starts the tick timer and takes leadership if free. */
	start(): void {
		if (this.timer) return;
		this.startedAt = this.now();
		fs.mkdirSync(this.dir, { recursive: true });
		this.timer = setInterval(() => void this.tick(), this.tickMs);
		this.timer.unref();
		void this.tick();
	}

	/** Idempotent. Stops the timer, releases leadership, aborts in-flight runs. */
	async stop(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		for (const { ctrl } of this.inflight.values()) ctrl.abort();
		await this.releaseLeadership();
	}

	readLeader(): LeaderRecord | undefined {
		try {
			return JSON.parse(fs.readFileSync(this.leaderFile, "utf8")) as LeaderRecord;
		} catch {
			return undefined;
		}
	}

	private isMine(rec: LeaderRecord | undefined): boolean {
		return !!rec && rec.pid === process.pid && rec.host === os.hostname() && rec.instance === this.instance;
	}

	private leaderIsStale(rec: LeaderRecord | undefined, now: number): boolean {
		if (!rec) return true;
		if (this.isMine(rec)) return false;
		const age = now - Date.parse(rec.heartbeatAt);
		if (Number.isNaN(age) || age > LEADER_STALE_MS) return true;
		if (rec.host === os.hostname() && !pidAlive(rec.pid)) return true;
		return false;
	}

	private async claimOrRenewLeadership(now: number): Promise<boolean> {
		return withFileLock(this.leaderLock, () => {
			const rec = this.readLeader();
			const mine = this.isMine(rec);
			if (!mine && !this.leaderIsStale(rec, now)) {
				this.leader = false;
				return false;
			}
			const next: LeaderRecord = {
				pid: process.pid,
				host: os.hostname(),
				instance: this.instance,
				sessionId: this.getSession().sessionId,
				startedAt: mine && rec ? rec.startedAt : new Date(now).toISOString(),
				heartbeatAt: new Date(now).toISOString(),
			};
			writeFileAtomic(this.leaderFile, `${JSON.stringify(next, null, 2)}\n`);
			if (!this.leader) this.log(`took over the loop scheduler (pid ${process.pid})`);
			this.leader = true;
			return true;
		});
	}

	private async releaseLeadership(): Promise<void> {
		if (!this.leader) return;
		this.leader = false;
		await this.hooks.onLeadership?.(false);
		try {
			await withFileLock(this.leaderLock, () => {
				if (this.isMine(this.readLeader())) fs.rmSync(this.leaderFile, { force: true });
			});
		} catch {
			/* best effort */
		}
	}

	private log(message: string): void {
		this.hooks.log?.(message);
	}

	/** One scheduler pass. Public so tests can drive it without timers. */
	async tick(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			const now = this.now();
			let leader = false;
			const wasLeader = this.leader;
			try {
				leader = await this.claimOrRenewLeadership(now);
			} catch (err: any) {
				this.log(`leadership check failed: ${err?.message ?? err}`);
			}
			if (leader !== wasLeader) await this.hooks.onLeadership?.(leader);
			try {
				await this.hooks.onTick?.(now, leader);
			} catch (err: any) {
				this.log(`tick hook failed: ${err?.message ?? err}`);
			}
			const session = this.getSession();
			let jobs: LoopJob[];
			try {
				jobs = await this.store.mutate((all) => {
					const changed = this.clearStaleRunning(all);
					return { jobs: all, result: changed ? all : all };
				});
			} catch (err: any) {
				this.log(`cannot read jobs: ${err?.message ?? err}`);
				return;
			}
			for (const job of jobs) {
				if (!job.enabled) continue;
				const owned = job.stateful ? leader : !!session.sessionId && job.sessionId === session.sessionId;
				if (!owned) continue;
				const due = computeDue(
					{
						schedule: job.schedule,
						createdAt: Date.parse(job.createdAt),
						lastDueAt: job.lastDueAt ? Date.parse(job.lastDueAt) : undefined,
						lastFiredAt: job.lastFiredAt ? Date.parse(job.lastFiredAt) : undefined,
					},
					now,
				);
				if (due === undefined) continue;
				await this.dispatch(job, due, now, session);
			}
		} finally {
			this.ticking = false;
		}
	}

	private clearStaleRunning(jobs: LoopJob[]): boolean {
		let changed = false;
		for (const job of jobs) {
			if (!job.running) continue;
			const { pid, runId } = job.running;
			const isMine = pid === process.pid;
			const alive = isMine ? this.inflight.has(runId) : pidAlive(pid);
			if (alive) continue;
			// The run that died is owed again: roll the bookkeeping back so the next tick re-fires it
			// (collapsed like any other missed tick) instead of silently skipping to the next slot.
			job.running = undefined;
			job.lastDueAt = undefined;
			job.lastFiredAt = undefined;
			job.lastError = "cleared stale running state (previous pi process ended mid-run); the run will be retried";
			changed = true;
		}
		return changed;
	}

	private async dispatch(job: LoopJob, due: number, now: number, session: SessionSnapshot): Promise<void> {
		const dueIso = new Date(due).toISOString();
		if (job.stateful && !fs.existsSync(job.cwd)) {
			// Orphan: the checkout is gone (deleted worktree, moved project). Disable instead of failing every tick.
			await this.store.update(job.id, (j) => {
				j.enabled = false;
				j.lastDueAt = dueIso;
				j.lastError = `disabled: cwd ${job.cwd} no longer exists (re-enable after /cron add --cwd or restoring it)`;
			});
			this.log(`cron ${job.name ?? job.id}: disabled, cwd ${job.cwd} no longer exists`);
			return;
		}
		if (job.running) {
			await this.store.update(job.id, (j) => {
				j.skippedOverlap++;
				j.lastDueAt = dueIso;
				j.lastError = "skipped: previous run still active";
			});
			return;
		}
		const missedWhileDown = due < this.startedAt - this.tickMs;
		if (missedWhileDown && !job.catchUp) {
			await this.store.update(job.id, (j) => {
				j.lastDueAt = dueIso;
				j.lastError = `missed ${formatLocal(due)} while no pi was running (catch-up disabled)`;
			});
			return;
		}
		if (!job.stateful) {
			await this.store.update(job.id, (j) => {
				j.lastDueAt = dueIso;
				j.lastFiredAt = new Date(now).toISOString();
				j.lastCompletedAt = j.lastFiredAt;
				j.lastError = undefined;
				j.runCount++;
			});
			// pie's InjectAndRun: the job's action lands in the parent chat as a user message with
			// the engine-enforced `[Trigger <trace>] ` prefix.
			const note = missedWhileDown ? `\n(catching up a run due ${formatLocal(due)})` : "";
			await this.hooks.onInject?.(job, `[Trigger ${newId("run")}] ${job.prompt}${note}`);
			if (job.schedule.kind === "once") await this.store.remove(job.id);
			return;
		}
		if (this.inflight.size >= MAX_CONCURRENT_RUNS) return; // try again next tick
		if (missedWhileDown) this.hooks.onCatchUp?.(job, due);
		await this.launch(job, dueIso, now, session, missedWhileDown);
	}

	/** Fire a job now, ignoring its schedule. Returns false if it is already running. */
	async runNow(jobId: string): Promise<boolean> {
		const job = this.store.load().find((j) => j.id === jobId);
		if (!job || job.running) return false;
		const now = this.now();
		if (!job.stateful) {
			await this.hooks.onInject?.(job, `[Trigger ${newId("run")}] ${job.prompt}`);
			await this.store.update(job.id, (j) => {
				j.lastFiredAt = new Date(now).toISOString();
				j.runCount++;
			});
			return true;
		}
		await this.launch(job, undefined, now, this.getSession(), false);
		return true;
	}

	private async launch(job: LoopJob, dueIso: string | undefined, now: number, session: SessionSnapshot, catchingUp: boolean): Promise<void> {
		const runId = newId("run");
		const startedAt = new Date(now).toISOString();
		const claimed = await this.store.update(job.id, (j) => {
			if (j.running) return;
			j.running = { runId, pid: process.pid, startedAt };
			if (dueIso) j.lastDueAt = dueIso;
			j.lastFiredAt = startedAt;
			j.lastError = undefined;
		});
		if (!claimed || claimed.running?.runId !== runId) return;

		const ctrl = new AbortController();
		this.inflight.set(runId, { ctrl, label: job.name ?? job.id, jobId: job.id, startedAt, promptPreview: previewRedacted(job.prompt, 120) });
		try {
			this.hooks.onRunStart?.(claimed, runId);
		} catch (err: any) {
			this.hooks.log?.(`onRunStart hook failed: ${err?.message ?? err}`);
		}

		const previousState = this.store.readState(job.id);
		const prompt = composeLoopPrompt(job.prompt, previousState, {
			name: job.name,
			runAt: `${formatLocal(now)}${catchingUp ? " (catching up a missed tick)" : ""}`,
		});
		const model = job.model ?? session.model;
		const thinking = job.thinking ?? session.thinking;

		let result: RunnerResult;
		try {
			result = await runPiSubagent({
				cwd: job.cwd,
				prompt,
				model,
				thinking,
				tools: job.tools,
				timeoutMs: job.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
				signal: ctrl.signal,
				piBin: this.piBin,
				sessionDir: this.store.sessionDirFor(job.id),
				env: { PI_LOOPS_JOB_ID: job.id, PI_LOOPS_RUN_ID: runId, PI_LOOPS_HOP: String(this.hop + 1) },
			});
		} catch (err: any) {
			result = {
				ok: false,
				exitCode: 1,
				timedOut: false,
				text: "",
				stderr: "",
				errorMessage: err?.message ?? String(err),
				usage: { input: 0, output: 0, cost: 0, turns: 0 },
			};
		} finally {
			this.inflight.delete(runId);
		}

		// Tag extraction never fails a run: malformed/missing tags leave the state untouched.
		const parsed = parseRunOutput(result.text);
		let stateUpdated = false;
		if (result.ok && parsed.state !== undefined) {
			try {
				this.store.writeState(job.id, parsed.state);
				stateUpdated = true;
			} catch (err: any) {
				this.log(`loop ${job.id}: state write failed: ${err?.message ?? err}`);
			}
		}
		// Maker/checker (pie phase 3): with verify=true a second, adversarial sub-agent reviews the
		// findings before they reach the inbox. Fail-open: if the checker itself fails, findings
		// still enter the inbox, but marked unverified — a broken checker must not silence the loop.
		let checker: CheckerRecord | undefined;
		let reviewed: Array<{ text: string; verified?: boolean; reason?: string }> = parsed.findings.map((text) => ({ text }));
		if (result.ok && job.verify && parsed.findings.length && !ctrl.signal.aborted) {
			const outcome = await this.runChecker(job, runId, parsed.state ?? previousState, parsed.findings, ctrl.signal, job.checkerModel ?? model, thinking);
			checker = outcome.record;
			reviewed = outcome.reviewed;
		}
		const findings: string[] = [];
		if (result.ok) {
			const source = `cron:${job.name ?? job.id.slice(0, 13)}`; // pie: `cron:<13-char id prefix>`; the name is friendlier when set
			for (const f of reviewed) {
				try {
					this.inbox.append({ source, text: f.text, runId, jobId: job.id, cwd: job.cwd, verified: f.verified, verifiedReason: f.reason });
					findings.push(f.text);
				} catch (err: any) {
					this.log(`loop ${job.id}: inbox append failed: ${err?.message ?? err}`);
				}
			}
		}

		const finishedAt = new Date(this.now()).toISOString();
		const record: RunRecord = {
			runId,
			jobId: job.id,
			jobName: job.name,
			stateful: job.stateful,
			cwd: job.cwd,
			pid: process.pid,
			startedAt,
			finishedAt,
			ok: result.ok,
			exitCode: result.exitCode,
			error: result.ok ? undefined : redact(result.errorMessage ?? "unknown error"),
			findings: findings.length,
			droppedFindings: parsed.droppedFindings,
			stateUpdated,
			model: result.model ?? model,
			usage: result.usage,
			summary: previewRedacted(stripProtocolTags(result.text), 400) || undefined,
			sessionId: result.sessionId,
			sessionFile: result.sessionFile,
			checker,
		};
		this.store.pruneSessions(job.id);
		try {
			this.store.appendRun(record);
		} catch (err: any) {
			this.log(`run log append failed: ${err?.message ?? err}`);
		}
		const updated = await this.store.update(job.id, (j) => {
			if (j.running?.runId === runId) j.running = undefined;
			j.lastCompletedAt = finishedAt;
			j.lastError = result.ok ? undefined : record.error;
			j.runCount++;
		});
		if (updated && job.schedule.kind === "once" && result.ok) await this.store.remove(job.id);

		try {
			if (findings.length) this.hooks.onInboxChanged?.();
			this.hooks.onRunFinished?.({ job: updated ?? job, record, findings, result });
		} catch (err: any) {
			this.hooks.log?.(`onRunFinished hook failed: ${err?.message ?? err}`);
		}
	}

	private async runChecker(
		job: LoopJob,
		runId: string,
		makerState: string | undefined,
		findings: string[],
		signal: AbortSignal,
		model: string | undefined,
		thinking: string | undefined,
	): Promise<{ record: CheckerRecord; reviewed: Array<{ text: string; verified?: boolean; reason?: string }> }> {
		const started = this.now();
		let result: RunnerResult;
		try {
			result = await runPiSubagent({
				cwd: job.cwd,
				prompt: composeCheckerPrompt(job.prompt, makerState, findings, { name: job.name }),
				model,
				thinking,
				tools: job.tools,
				timeoutMs: job.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
				signal,
				piBin: this.piBin,
				sessionDir: this.store.sessionDirFor(job.id),
				env: { PI_LOOPS_JOB_ID: job.id, PI_LOOPS_RUN_ID: runId, PI_LOOPS_ROLE: "checker", PI_LOOPS_HOP: String(this.hop + 1) },
			});
		} catch (err: any) {
			result = { ok: false, exitCode: 1, timedOut: false, text: "", stderr: "", errorMessage: err?.message ?? String(err), usage: { input: 0, output: 0, cost: 0, turns: 0 } };
		}
		const verdicts = result.ok ? parseCheckerOutput(result.text) : new Map();
		const reviewed: Array<{ text: string; verified?: boolean; reason?: string }> = [];
		const dropped: CheckerRecord["dropped"] = [];
		let unreviewed = 0;
		findings.forEach((text, i) => {
			const v = verdicts.get(i + 1);
			if (!v) {
				unreviewed++;
				reviewed.push({ text, verified: undefined, reason: result.ok ? "checker gave no verdict" : `checker failed: ${result.errorMessage ?? "unknown error"}` });
			} else if (v.verdict === "keep") reviewed.push({ text: v.rewrite ?? text, verified: true, reason: v.reason || undefined });
			else dropped.push({ text, reason: v.reason || "no reason given" });
		});
		const record: CheckerRecord = {
			ok: result.ok,
			error: result.ok ? undefined : redact(result.errorMessage ?? "unknown error"),
			kept: reviewed.filter((r) => r.verified).length,
			dropped: dropped.map((d) => ({ text: previewRedacted(d.text, 500), reason: previewRedacted(d.reason, 300) })),
			unreviewed,
			durationMs: this.now() - started,
			cost: result.usage.cost,
			model: result.model ?? model,
			sessionFile: result.sessionFile,
		};
		if (!result.ok) this.log(`loop ${job.name ?? job.id}: checker failed (${record.error}); findings enter the inbox unverified`);
		return { record, reviewed };
	}
}
