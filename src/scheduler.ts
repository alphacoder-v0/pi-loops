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
import { PresenceRegistry, type PresenceEntry, type PresenceKind, type PresenceSelf } from "./presence.ts";
import * as path from "node:path";
import { Inbox } from "./inbox.ts";
import { pidAlive, withFileLock, writeFileAtomic } from "./lock.ts";
import { composeCheckerPrompt, composeLoopPrompt, parseCheckerOutput, parseRunOutput, stripProtocolTags } from "./protocol.ts";
import { type RunnerResult, type SubagentRunner, failedRun } from "./runner.ts";
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
	/** The interactive pi trusted this project (`pi --approve` / trust prompt); children in the same cwd inherit it. */
	trusted?: boolean;
}

export interface SchedulerSettings {
	/** Loop runs in flight at once (`[cron] max_concurrent_runs`). */
	maxConcurrentRuns: number;
	/** Global switch for firing ticks missed while no pi was open (`[cron] catch_up`); per-job `catchUp` still applies. */
	catchUp: boolean;
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
	/** Runs loop and checker sub-agents (in-process through pi's SDK in production; tests inject a fake). */
	runner: SubagentRunner;
	now?: () => number;
	/** Trigger hop of this process; sub-agents get hop + 1. */
	hop?: number;
	/** Live settings (re-read on every use so a config reload takes effect). */
	getSettings?: () => SchedulerSettings;
	/** Does pi still have this session? Plain jobs of deleted sessions are disabled (and `gc()` removes them). */
	sessionExists?: (sessionId: string) => boolean;
	/** "host" = the headless keeper of the clock; any interactive pi preempts it. Default "interactive". */
	kind?: PresenceKind;
}

export const DEAD_SESSION_MARKER = "no longer exists (/cron gc removes it)";
const DEAD_SESSION_SCAN_MS = 10 * 60_000;

interface LeaderRecord {
	pid: number;
	host: string;
	/** Distinguishes scheduler instances inside one process (reload, tests). */
	instance: string;
	sessionId?: string;
	kind?: PresenceKind;
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
	private readonly runner: SubagentRunner;
	private readonly now: () => number;
	private readonly hop: number;
	private readonly getSettings: () => SchedulerSettings;
	private readonly sessionExists?: (sessionId: string) => boolean;
	readonly kind: PresenceKind;
	private lastDeadSessionScan = 0;
	private timer: NodeJS.Timeout | undefined;
	private ticking = false;
	private leader = false;
	private startedAt = 0;
	private readonly inflight = new Map<string, { ctrl: AbortController; label: string; jobId: string; startedAt: string; promptPreview: string }>();
	/** Promises of runs in flight, so stop() can wait for their records to land. */
	private readonly runs = new Set<Promise<void>>();
	private stopped = false;
	private tickPromise?: Promise<void>;
	private readonly instance = newId("sched");
	/** This process in the machine-wide presence registry (which pi is open where). */
	readonly presence: PresenceRegistry;
	readonly self: PresenceSelf;

	constructor(opts: SchedulerOptions) {
		this.dir = opts.dir;
		this.store = new JobStore(opts.dir);
		this.inbox = new Inbox(opts.dir);
		// One leader per host: machines sharing a $HOME must not elect each other (pie: per host, per session).
		this.leaderFile = path.join(opts.dir, `scheduler.${os.hostname().replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
		this.leaderLock = path.join(opts.dir, "scheduler.lock");
		this.getSession = opts.getSession;
		this.hooks = opts.hooks ?? {};
		this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
		this.runner = opts.runner;
		this.now = opts.now ?? Date.now;
		this.hop = opts.hop ?? 0;
		this.getSettings = opts.getSettings ?? (() => ({ maxConcurrentRuns: MAX_CONCURRENT_RUNS, catchUp: true }));
		this.sessionExists = opts.sessionExists;
		this.kind = opts.kind ?? "interactive";
		const s = opts.getSession();
		this.self = { pid: process.pid, host: os.hostname(), instance: this.instance, sessionId: s.sessionId, cwd: s.cwd, kind: this.kind };
		this.presence = new PresenceRegistry(opts.dir, this.self);
	}

	/** Live pi processes on every host (stale entries pruned). */
	presenceList(now = this.now()): PresenceEntry[] {
		return this.presence.list(now);
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
		this.stopped = false;
		this.startedAt = this.now();
		fs.mkdirSync(this.dir, { recursive: true });
		this.timer = setInterval(() => void this.tick(), this.tickMs);
		this.timer.unref();
		void this.tick();
	}

	/** Idempotent. Stops the timer, releases leadership, aborts in-flight runs. */
	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		await this.tickPromise; // a tick past its leadership claim must not launch after we leave
		for (const { ctrl } of this.inflight.values()) ctrl.abort();
		await this.drain(5000);
		await this.releaseLeadership();
		this.presence.remove();
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
		// The headless host only keeps the clock while nobody is around: an interactive pi takes it
		// back the moment it opens, and the host exits when it sees that (see host.ts).
		if (this.kind === "interactive" && rec.kind === "host") return true;
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
				kind: this.kind,
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
		if (this.ticking || this.stopped) return;
		this.ticking = true;
		let finish!: () => void;
		this.tickPromise = new Promise<void>((r) => (finish = r));
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
			const session = this.getSession();
			try {
				this.presence.heartbeat(now, { cwd: session.cwd, sessionId: session.sessionId });
			} catch (err: any) {
				this.log(`presence heartbeat failed: ${err?.message ?? err}`);
			}
			try {
				await this.hooks.onTick?.(now, leader);
			} catch (err: any) {
				this.log(`tick hook failed: ${err?.message ?? err}`);
			}
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
			if (leader && this.sessionExists && now - this.lastDeadSessionScan >= DEAD_SESSION_SCAN_MS) {
				this.lastDeadSessionScan = now;
				await this.disableDeadSessionJobs(jobs);
			}
			const host = os.hostname();
			for (const job of jobs) {
				if (!job.enabled) continue;
				if (job.host && job.host !== host) continue; // another machine's job (shared $HOME)
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
			finish();
		}
	}

	/**
	 * A plain job whose session pi no longer has can never inject again. pie loses such jobs with
	 * the session's sidecars; here they are disabled with a marker and `/cron gc` removes them.
	 */
	private async disableDeadSessionJobs(jobs: LoopJob[]): Promise<void> {
		const exists = this.sessionExists;
		if (!exists) return;
		// Open somewhere (--no-session, --session-dir, another sessions root)? Then it is alive whatever the disk says.
		const live = new Set(this.presence.list(this.now()).map((e) => e.sessionId).filter(Boolean));
		const dead = jobs.filter((j) => j.enabled && !j.stateful && j.sessionId && (!j.host || j.host === os.hostname()) && !live.has(j.sessionId) && !exists(j.sessionId));
		for (const job of dead) {
			await this.store.update(job.id, (j) => {
				j.enabled = false;
				j.lastError = `disabled: session ${job.sessionId!.slice(0, 8)} ${DEAD_SESSION_MARKER}`;
			});
			this.log(`cron ${job.name ?? job.id}: disabled, its session ${job.sessionId!.slice(0, 8)} no longer exists`);
		}
	}

	/** Remove the jobs `disableDeadSessionJobs` parked; returns them. */
	async gc(): Promise<LoopJob[]> {
		return this.store.removeWhere((j) => !j.enabled && !!j.lastError?.endsWith(DEAD_SESSION_MARKER));
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
		if (missedWhileDown && !(job.catchUp && this.getSettings().catchUp)) {
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
		if (this.inflight.size >= this.getSettings().maxConcurrentRuns) return; // try again next tick
		if (this.stopped) return;
		if (missedWhileDown) this.hooks.onCatchUp?.(job, due);
		// Never await a run inside a tick: heartbeats, leadership, presence and trigger checks keep
		// going while sub-agents work, and several loops really do run at once.
		this.track(this.launch(job, dueIso, now, session, missedWhileDown));
	}

	private track(run: Promise<void>): void {
		const tracked = run.catch((err: any) => this.log(`run failed: ${err?.message ?? err}`)).finally(() => this.runs.delete(tracked));
		this.runs.add(tracked);
	}

	/** Wait (bounded) for in-flight runs to finish writing their records. */
	async drain(timeoutMs: number): Promise<boolean> {
		if (!this.runs.size) return true;
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<false>((r) => {
			timer = setTimeout(() => r(false), timeoutMs);
		});
		const done = Promise.allSettled([...this.runs]).then(() => true as const);
		const result = await Promise.race([done, timeout]);
		if (timer) clearTimeout(timer);
		return result;
	}

	/** Fire a job now, ignoring its schedule. Returns false if it is already running. */
	async runNow(jobId: string): Promise<boolean> {
		const job = this.store.load().find((j) => j.id === jobId);
		if (!job || job.running || this.stopped) return false;
		const now = this.now();
		if (!job.stateful) {
			await this.hooks.onInject?.(job, `[Trigger ${newId("run")}] ${job.prompt}`);
			await this.store.update(job.id, (j) => {
				j.lastFiredAt = new Date(now).toISOString();
				j.runCount++;
			});
			return true;
		}
		this.track(this.launch(job, undefined, now, this.getSession(), false));
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
			result = await this.runner({
				cwd: job.cwd,
				prompt,
				model,
				thinking,
				tools: job.tools,
				timeoutMs: job.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
				signal: ctrl.signal,
				sessionDir: this.store.sessionDirFor(job.id),
				hop: this.hop + 1,
				parentSessionId: session.sessionId,
				parentCwd: session.cwd,
				kind: "loop",
				jobId: job.id,
				runId,
			});
		} catch (err: any) {
			result = failedRun(err?.message ?? String(err));
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
			const session = this.getSession();
			result = await this.runner({
				cwd: job.cwd,
				prompt: composeCheckerPrompt(job.prompt, makerState, findings, { name: job.name }),
				model,
				thinking,
				tools: job.tools,
				timeoutMs: job.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
				signal,
				sessionDir: this.store.sessionDirFor(job.id),
				hop: this.hop + 1,
				parentSessionId: session.sessionId,
				parentCwd: session.cwd,
				kind: "checker",
				jobId: job.id,
				runId,
			});
		} catch (err: any) {
			result = failedRun(err?.message ?? String(err));
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
