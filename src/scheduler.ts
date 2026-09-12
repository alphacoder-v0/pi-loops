/**
 * The heartbeat. One pi process on the machine owns the timer at a time
 * (leadership lives in scheduler.<host>.json with a heartbeat); every other process
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
import { type SubagentSlot, SubagentSlots } from "./slots.ts";
import { computeDue, computeNext, formatLocal, formatLocalZoned, formatSchedule, isValidSchedule, stamp } from "./schedule.ts";
import { type CheckerRecord, JobStore, type LoopJob, type RunRecord, newId } from "./store.ts";

export const DEFAULT_TICK_MS = 30_000;
export const LEADER_STALE_MS = 90_000;
/** Consecutive failures before a job is retried on a widening gap rather than every due tick. */
export const FAILURE_BACKOFF_AFTER = 3;
export const FAILURE_BACKOFF_BASE_MS = 5 * 60_000;
export const FAILURE_BACKOFF_MAX_MS = 6 * 60 * 60_000;
/** A run claimed by another machine (shared $HOME) is only assumed dead after this long. */
export const FOREIGN_RUN_STALE_MS = 24 * 60 * 60 * 1000;
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
	/**
	 * Sub-agents in flight at once (`[cron] max_concurrent_runs`) — loop runs, trigger checks and the
	 * /goal evaluator together, not loop runs alone. Only read when no shared `slots` pool is injected.
	 */
	maxConcurrentRuns: number;
	/** Stop dispatching once today's automation has cost this much. 0 or absent = no cap. */
	dailyBudgetUsd?: number;
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
	/** A whole tick failed: nothing ran. Louder than `log`, which is for routine diagnostics. */
	onSchedulerError?: (message: string) => void;
	/** Today's spend passed the configured cap; nothing more will be dispatched today. */
	onBudgetExceeded?: (spent: number, cap: number) => void;
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
	/**
	 * The process-wide sub-agent admission counter, shared with the trigger runtime and the /goal
	 * evaluator (src/slots.ts). Omitted, the scheduler bounds only itself against
	 * `maxConcurrentRuns` — which is the bug this exists to close, so production always passes one.
	 */
	slots?: SubagentSlots;
}

export const DEAD_SESSION_MARKER = "no longer exists (/cron gc removes it)";
const DEAD_SESSION_SCAN_MS = 10 * 60_000;

/**
 * How long a job's `cwd` may be missing before the job is disabled rather than kept waiting.
 *
 * Long enough for the slowest thing that legitimately arrives late — a network mount at boot — and
 * short enough that a genuinely deleted project stops being retried the same day.
 */
const CWD_GRACE_MS = 30 * 60_000;

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
	/** Every sub-agent this process starts takes a slot from here, loop runs and trigger checks alike. */
	readonly slots: SubagentSlots;
	private readonly sessionExists?: (sessionId: string) => boolean;
	readonly kind: PresenceKind;
	private lastDeadSessionScan = 0;
	/** The last set of next runs written, so an unchanged tick writes nothing. */
	private lastNextRuns: string | undefined;
	private readonly nextRunsFile: string;
	private timer: NodeJS.Timeout | undefined;
	private ticking = false;
	private leader = false;
	private startedAt = 0;
	private readonly inflight = new Map<string, { ctrl: AbortController; label: string; jobId: string; startedAt: string; promptPreview: string; sessionFile?: string }>();
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
		// One leader per host: machines sharing a $HOME must not elect each other.
		this.leaderFile = path.join(opts.dir, `scheduler.${os.hostname().replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
		// Per host, like the leader record beside it, and for the same reason. Leadership is per
		// host; two machines sharing a `$HOME` are both leaders, and a cron expression is matched
		// against local time — so one file would be two machines writing different answers over each
		// other, and a panel showing whichever wrote last.
		this.nextRunsFile = path.join(opts.dir, `next-runs.${os.hostname().replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
		this.leaderLock = path.join(opts.dir, "scheduler.lock");
		this.getSession = opts.getSession;
		this.hooks = opts.hooks ?? {};
		this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
		this.runner = opts.runner;
		this.now = opts.now ?? Date.now;
		this.hop = opts.hop ?? 0;
		this.getSettings = opts.getSettings ?? (() => ({ maxConcurrentRuns: MAX_CONCURRENT_RUNS, catchUp: true }));
		this.slots = opts.slots ?? new SubagentSlots(() => this.getSettings().maxConcurrentRuns);
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
	runningRuns(): Array<{ runId: string; label: string; jobId: string; startedAt: string; promptPreview: string; sessionFile?: string }> {
		return [...this.inflight.entries()].map(([runId, r]) => ({ runId, label: r.label, jobId: r.jobId, startedAt: r.startedAt, promptPreview: r.promptPreview, sessionFile: r.sessionFile }));
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
		// `tick` catches everything it can, but its own error path calls back into hooks and logging,
		// which are the caller's code. Nothing above this has a handler, so it ends here.
		const safeTick = () => void this.tick().catch((err: any) => this.log(`tick failed: ${err?.message ?? err}`));
		this.timer = setInterval(safeTick, this.tickMs);
		this.timer.unref();
		safeTick();
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
				startedAt: mine && rec ? rec.startedAt : stamp(now),
				heartbeatAt: stamp(now),
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
		try {
			await this.hooks.onLeadership?.(false);
		} catch (err: any) {
			this.log(`leadership hook failed: ${err?.message ?? err}`);
		}
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

	/**
	 * What automation has spent since local midnight, and whether that is over the cap. A headless
	 * host runs unattended for days; without this the only thing bounding the bill is the schedule.
	 */
	budgetState(now = this.now()): { spent: number; cap: number; over: boolean } {
		const cap = this.getSettings().dailyBudgetUsd ?? 0;
		if (cap <= 0) return { spent: 0, cap: 0, over: false };
		const midnight = new Date(now);
		midnight.setHours(0, 0, 0, 0);
		try {
			const spent = this.store.spend(midnight.getTime()).total;
			return { spent, cap, over: spent >= cap };
		} catch {
			return { spent: 0, cap, over: false }; // an unreadable run log must not stop the clock
		}
	}

	/** One scheduler pass. Public so tests can drive it without timers. */
	async tick(): Promise<void> {
		try {
			await this.tickInner();
		} catch (err: any) {
			// Last line of defence: whatever failed, the clock keeps its next appointment. This is a
			// warning, not a log line: a tick that keeps failing means nothing is running at all.
			this.hooks.onSchedulerError?.(`tick failed: ${err?.message ?? err}`);
			this.log(`tick failed: ${err?.message ?? err}`);
		}
	}

	private async tickInner(): Promise<void> {
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
			// A UI hook that throws must not escape the tick: `start()` runs it as `void this.tick()`
			// and pi installs no unhandledRejection handler, so an unguarded throw here kills pi.
			if (leader !== wasLeader) {
				try {
					await this.hooks.onLeadership?.(leader);
				} catch (err: any) {
					this.log(`leadership hook failed: ${err?.message ?? err}`);
				}
			}
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
				// `mutate` writes only when the list really changed, so a tick with nothing to clear
				// costs one read and no write (store.ts).
				jobs = await this.store.mutate((all) => {
					this.clearStaleRunning(all);
					return { jobs: all, result: all };
				});
			} catch (err: any) {
				this.log(`cannot read jobs: ${err?.message ?? err}`);
				return;
			}
			// What the store cannot say and every reader wants: when each job runs next. It is a pure
			// function of the job, but computing it needs the cron evaluator — which the browser
			// front end does not have and should not grow a second copy of. The leader writes the
			// answers where that front end already reads pi-loops' own files, and only when one of
			// them changes, which for a nightly job is once a day.
			if (leader) this.writeNextRuns(jobs, now);
			if (leader && this.sessionExists && now - this.lastDeadSessionScan >= DEAD_SESSION_SCAN_MS) {
				this.lastDeadSessionScan = now;
				try {
					await this.disableDeadSessionJobs(jobs);
				} catch (err: any) {
					this.log(`dead-session check failed: ${err?.message ?? err}`);
				}
			}
			const host = os.hostname();
			for (const job of jobs) {
				if (!job.enabled) continue;
				if (job.host && job.host !== host) continue; // another machine's job (shared $HOME)
				const owned = job.stateful ? leader : !!session.sessionId && job.sessionId === session.sessionId;
				if (!owned) continue;
				// One unusable job must never stop the clock for the others: a schedule that cannot be
				// evaluated disables that job and says why, instead of throwing out of the tick (pi
				// installs no unhandledRejection handler, so that would take the whole session down).
				try {
					if (!isValidSchedule(job.schedule)) throw new Error("unusable schedule");
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
				} catch (err: any) {
					const message = `disabled: ${err?.message ?? err} (${formatSchedule(job.schedule)})`;
					this.log(`loop ${job.id}: ${message}`);
					await this.store.update(job.id, (j) => {
						j.enabled = false;
						j.lastError = message;
					});
				}
			}
		} finally {
			this.ticking = false;
			finish();
		}
	}

	/**
	 * A plain job whose session pi no longer has can never inject again; they are parked with
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

	/**
	 * `next-runs.json`: job id → when it next runs, as the scheduler itself computes it.
	 *
	 * Derived, so it lives beside the store rather than in it — a next run is not a fact about the
	 * job, it is an answer about the clock, and `jobs.json` is what several processes take a lock to
	 * edit. Best effort throughout: a reader that finds it missing or stale shows no next run, which
	 * is what it showed before this existed.
	 */
	private writeNextRuns(jobs: LoopJob[], now: number): void {
		const next: Record<string, string> = {};
		for (const job of jobs) {
			if (!job.enabled || !isValidSchedule(job.schedule)) continue;
			const at = computeNext({ schedule: job.schedule, createdAt: Date.parse(job.createdAt), lastFiredAt: job.lastFiredAt ? Date.parse(job.lastFiredAt) : undefined }, now);
			if (at !== undefined) next[job.id] = stamp(at);
		}
		const text = `${JSON.stringify({ at: stamp(now), next }, null, 1)}\n`;
		// The timestamp moves every tick and the answers do not, so the comparison ignores it: this
		// writes when a job fires or is edited, not 2880 times a day.
		const fingerprint = JSON.stringify(next);
		if (fingerprint === this.lastNextRuns) return;
		this.lastNextRuns = fingerprint;
		try {
			writeFileAtomic(this.nextRunsFile, text);
		} catch {
			/* a derived file is a courtesy; never a reason to disturb the tick */
		}
	}

	/** Remove the jobs `disableDeadSessionJobs` parked; returns them. */
	async gc(inScope: (job: LoopJob) => boolean = () => true): Promise<LoopJob[]> {
		return this.store.removeWhere((j) => inScope(j) && !j.enabled && !!j.lastError?.endsWith(DEAD_SESSION_MARKER));
	}

	/** Clear running markers left behind by processes that are gone. Mutates `jobs` in place. */
	private clearStaleRunning(jobs: LoopJob[]): void {
		const booted = Date.now() - os.uptime() * 1000;
		for (const job of jobs) {
			if (!job.running) continue;
			const { pid, runId, startedAt } = job.running;
			// Another machine's pid table says nothing about this run (shared $HOME); leave it to the
			// host that owns it, and fall back to a generous age check so it cannot stick forever.
			if (job.running.host && job.running.host !== this.self.host) {
				if (Date.parse(startedAt) > Date.now() - FOREIGN_RUN_STALE_MS) continue;
			} else {
				const isMine = pid === process.pid;
				// A pid is only evidence while it can still be the same process: after a reboot the
				// numbers are handed out again, and a recycled pid would park the job forever.
				const recycled = Number.isFinite(booted) && Date.parse(startedAt) < booted - 60_000;
				const alive = isMine ? this.inflight.has(runId) : !recycled && pidAlive(pid);
				if (alive) continue;
			}
			// The run that died is owed again: roll the bookkeeping back so the next tick re-fires it
			// (collapsed like any other missed tick) instead of silently skipping to the next slot.
			job.running = undefined;
			job.lastDueAt = undefined;
			job.lastFiredAt = undefined;
			job.lastError = "cleared stale running state (previous pi process ended mid-run); the run will be retried";
		}
	}

	private async dispatch(job: LoopJob, due: number, now: number, session: SessionSnapshot): Promise<void> {
		const dueIso = stamp(due);
		if (job.stateful && !fs.existsSync(job.cwd)) {
			/**
			 * The checkout is not there. That is usually a deleted worktree or a moved project — but
			 * at boot it is just as often a directory that has not arrived yet: a network mount, an
			 * external disk, an encrypted volume, all of which come up *after* the first pi does.
			 * Disabling on the first miss meant a nightly job died silently for being twenty seconds
			 * early, stayed disabled when the mount appeared, and was only ever noticed by the work
			 * not happening.
			 *
			 * So the slot is owed rather than consumed — `lastDueAt` is untouched, as it is for a job
			 * held back by the budget — and the job is disabled only once the directory has been
			 * missing for the whole grace period. A mount that turns up inside it runs the owed slot
			 * on the next tick.
			 */
			const since = Date.parse(job.cwdMissingSince ?? "") || now;
			const gone = now - since >= CWD_GRACE_MS;
			await this.store.update(job.id, (j) => {
				j.cwdMissingSince = stamp(since);
				if (gone) {
					j.enabled = false;
					j.lastDueAt = dueIso;
					j.lastError = `disabled: cwd ${job.cwd} has been missing since ${formatLocal(since)} (re-enable after /cron add --cwd or restoring it)`;
				} else {
					j.lastError = `waiting: cwd ${job.cwd} is not there yet (since ${formatLocal(since)}; disabled if it stays missing)`;
				}
			});
			if (gone) this.log(`cron ${job.name ?? job.id}: disabled, cwd ${job.cwd} missing since ${formatLocal(since)}`);
			return;
		}
		// Back, and the run that was owed is about to happen: the marker must not outlive the outage.
		if (job.cwdMissingSince) {
			await this.store.update(job.id, (j) => {
				j.cwdMissingSince = undefined;
				if (j.lastError?.startsWith("waiting: cwd ")) j.lastError = undefined;
			});
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
		const budget = this.budgetState(now);
		if (budget.over) {
			// Plain jobs are gated too: injecting one makes the parent agent take a turn, which is
			// billed like any other. The slot stays owed: `lastDueAt` is untouched, so whatever is due runs once the day
			// rolls over or the cap is raised, instead of being silently skipped.
			const message = `paused: today's automation has cost $${budget.spent.toFixed(2)} of the $${budget.cap.toFixed(2)} budget ([limits] daily_budget_usd)`;
			if (job.lastError !== message) {
				await this.store.update(job.id, (j) => {
					j.lastError = message;
				});
				this.hooks.onBudgetExceeded?.(budget.spent, budget.cap);
			}
			return;
		}
		if (!job.stateful) {
			// A plain job's whole point is to land in a chat, and the headless host has none. The
			// ownership test above already excludes these (the host's snapshot has no sessionId), so
			// this is belt and braces: the bookkeeping below commits before `onInject` runs, and a
			// host that ever gained a session id would otherwise record an undelivered job as a
			// completed run and delete a one-shot unfired.
			if (this.kind === "host") return;
			await this.store.update(job.id, (j) => {
				j.lastDueAt = dueIso;
				j.lastFiredAt = stamp(now);
				j.lastCompletedAt = j.lastFiredAt;
				j.lastError = undefined;
				j.runCount++;
			});
			// Inject-and-run: the job's action lands in the parent chat as a user message with
			// the engine-enforced `[Trigger <trace>] ` prefix.
			const note = missedWhileDown ? `\n(catching up a run due ${formatLocal(due)})` : "";
			await this.hooks.onInject?.(job, `[Trigger ${newId("run")}] ${job.prompt}${note}`);
			if (job.schedule.kind === "once") await this.store.remove(job.id);
			return;
		}
		// A failing job is retried with a widening gap instead of at every due tick: a loop whose
		// sub-agent kills the process used to re-fire on the very next start, in a loop.
		const failures = job.consecutiveFailures ?? 0;
		if (failures >= FAILURE_BACKOFF_AFTER && job.lastCompletedAt) {
			const wait = Math.min(FAILURE_BACKOFF_MAX_MS, FAILURE_BACKOFF_BASE_MS * 2 ** Math.min(failures - FAILURE_BACKOFF_AFTER, 8));
			if (now - Date.parse(job.lastCompletedAt) < wait) return;
		}
		// The counter is shared with trigger checks and the /goal evaluator (src/slots.ts): the cap is
		// on sub-agents, not on loop runs, so "already in flight" counts theirs too.
		const slot = this.slots.acquire();
		if (!slot) {
			// Deferred, not skipped: `lastDueAt` stays untouched so the slot is still owed and the next
			// tick tries again. Without a trace a starved loop is indistinguishable from one that never
			// ran; `launch` clears `lastError` again as soon as it gets through.
			const { inUseCount, limit } = this.slots;
			await this.store.update(job.id, (j) => {
				j.lastError = `deferred: ${inUseCount} sub-agent(s) already in flight (max ${limit})`;
			});
			return;
		}
		if (this.stopped) {
			slot.release();
			return;
		}
		if (missedWhileDown) this.hooks.onCatchUp?.(job, due);
		// Never await a run inside a tick: heartbeats, leadership, presence and trigger checks keep
		// going while sub-agents work, and several loops really do run at once.
		this.track(this.launch(job, dueIso, now, session, missedWhileDown), slot);
	}

	private track(run: Promise<void>, slot: SubagentSlot): void {
		const tracked = run
			.catch((err: any) => this.log(`run failed: ${err?.message ?? err}`))
			.finally(() => {
				// Every run lands here — resolved, rejected or aborted — which is what keeps a run that
				// throws from leaking its slot for the life of the process.
				slot.release();
				this.runs.delete(tracked);
			});
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
				j.lastFiredAt = stamp(now);
				j.runCount++;
			});
			return true;
		}
		// `/cron run` is a direct instruction, so a busy machine does not get to refuse it — but it
		// still occupies a slot, so the shared count stays honest even when that overruns the limit.
		this.track(this.launch(job, undefined, now, this.getSession(), false), this.slots.occupy());
		return true;
	}

	private async launch(job: LoopJob, dueIso: string | undefined, now: number, session: SessionSnapshot, catchingUp: boolean): Promise<void> {
		const runId = newId("run");
		const startedAt = stamp(now);
		// Kept so an aborted run can hand its slot back rather than skipping to the next one.
		const priorDueAt = job.lastDueAt;
		const priorFiredAt = job.lastFiredAt;
		const claimed = await this.store.update(job.id, (j) => {
			if (j.running) return;
			j.running = { runId, pid: process.pid, host: this.self.host, startedAt };
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
		try {
			await this.runOnce(job, claimed, runId, startedAt, ctrl, session, now, catchingUp, { dueAt: priorDueAt, firedAt: priorFiredAt });
		} finally {
			// Whatever failed (a state file that cannot be read, a hook that threw), the run id is
			// released — otherwise `clearStaleRunning` would call the job alive forever.
			if (this.inflight.delete(runId)) {
				await this.store
					.update(job.id, (j) => {
						if (j.running?.runId === runId) j.running = undefined;
					})
					.catch(() => undefined);
			}
		}
	}

	/** The body of one run: everything between claiming the job and writing its record. */
	private async runOnce(job: LoopJob, claimed: LoopJob, runId: string, startedAt: string, ctrl: AbortController, session: SessionSnapshot, now: number, catchingUp: boolean, prior: { dueAt?: string; firedAt?: string }): Promise<void> {
		const previousState = this.store.readState(job.id);
		const prompt = composeLoopPrompt(job.prompt, previousState, {
			name: job.name,
			// Zoned, unlike everything shown on a screen: this one goes into a sub-agent's prompt,
			// where a model is asked to reason about how long ago the last run was and has no
			// surrounding context to tell it which clock this came off. It used to be a bare local
			// time that the docs described as UTC.
			runAt: `${formatLocalZoned(now)}${catchingUp ? " (catching up a missed tick)" : ""}`,
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
				onSessionFile: (file) => {
					const entry = this.inflight.get(runId);
					if (entry) entry.sessionFile = file;
				},
			});
		} catch (err: any) {
			result = failedRun(err?.message ?? String(err));
		}
		// NOTE: the run stays in `inflight` until the checker is done too. Releasing it here would
		// make `clearStaleRunning` see "my pid, not in flight", clear the running marker, roll the
		// schedule back and re-fire the same job while its checker is still working.

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
		// Maker/checker: with verify=true a second, adversarial sub-agent reviews the
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
			const source = `cron:${job.name ?? job.id.slice(0, 13)}`; // `cron:<13-char id prefix>`; the name is friendlier when set
			for (const f of reviewed) {
				try {
					await this.inbox.append({ source, text: f.text, runId, jobId: job.id, cwd: job.cwd, verified: f.verified, verifiedReason: f.reason });
					findings.push(f.text);
				} catch (err: any) {
					this.log(`loop ${job.id}: inbox append failed: ${err?.message ?? err}`);
				}
			}
		}

		const finishedAt = stamp(this.now());
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
			warning: result.warning,
			retries: result.retries,
			compactions: result.compactions,
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
		// An abort is not a run: quitting, a session swap or `/cron abort` interrupted it, so the
		// slot it claimed is given back and the next tick re-fires it (a tick is never lost this
		// way because its runs die with the session that owned them).
		const aborted = !result.ok && (result.stopReason === "aborted" || ctrl.signal.aborted);
		const updated = await this.store.update(job.id, (j) => {
			if (j.running?.runId === runId) j.running = undefined;
			j.lastCompletedAt = finishedAt;
			j.lastError = result.ok ? undefined : record.error;
			if (aborted) {
				j.lastDueAt = prior.dueAt;
				j.lastFiredAt = prior.firedAt;
			} else {
				j.runCount++;
				// A job that fails every time costs money every time. Count the streak so `dispatch`
				// can back off, and clear it the moment one run works.
				j.consecutiveFailures = result.ok ? undefined : (j.consecutiveFailures ?? 0) + 1;
			}
		});
		if (updated && !result.ok && (updated.consecutiveFailures ?? 0) >= FAILURE_BACKOFF_AFTER) {
			this.hooks.onSchedulerError?.(`${updated.name ?? updated.id} has failed ${updated.consecutiveFailures} times in a row; backing off (last: ${record.error ?? "unknown"})`);
		}
		// Only now: while the run id is in `inflight`, `clearStaleRunning` treats the job as alive,
		// which is exactly right until its `running` marker is gone from the store.
		this.inflight.delete(runId);
		// A one-shot is retired once its single slot is resolved. A failure gets exactly one more
		// attempt — transient model/network errors are the common case and the user asked for the run,
		// not for a job — and is then retired too, with the error kept in the run log and reported by
		// `onRunFinished`. Anything else leaves a failed `in 10m` enabled forever with no next run.
		if (updated && job.schedule.kind === "once" && !aborted) {
			if (result.ok || updated.runCount >= 2) await this.store.remove(job.id);
			else
				await this.store.update(job.id, (j) => {
					j.lastDueAt = undefined;
					j.lastFiredAt = undefined;
					j.lastError = `${record.error ?? "run failed"} (one-shot: retrying once)`;
				});
		}

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
