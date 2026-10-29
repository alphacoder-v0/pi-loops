/**
 * The clock. The same scheduler runs in two roles, and only what it owns differs: the always-on
 * host runs every loop, and a pi window runs the plain jobs of the conversation whose lease it
 * holds (src/lease.ts). Nobody is elected. A missed tick is caught up once, collapsed, unless the
 * job opted out.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import { PresenceRegistry, type PresenceEntry, type PresenceKind, type PresenceSelf } from "./presence.ts";
import * as path from "node:path";
import { Inbox } from "./inbox.ts";
import { pidAlive, writeFileAtomic } from "./lock.ts";
import { composeCheckerPrompt, composeLoopPrompt, findingKind, parseCheckerOutput, parseRunOutput, stripProtocolTags } from "./protocol.ts";
import { type RunnerResult, type SubagentRunner, failedRun } from "./runner.ts";
import { previewRedacted, redact } from "./redact.ts";
import { type SubagentSlot, SubagentSlots } from "./slots.ts";
import { backoffWaitMs, computeDue, computeNext, formatLocal, formatLocalZoned, formatSchedule, isValidSchedule, stamp } from "./schedule.ts";
import { type CheckerRecord, JobStore, type LoopJob, type RunRecord, newId } from "./store.ts";
import { ownerSession, runsHere, whereRuns, type OwnerView } from "./job-owner.ts";

export const DEFAULT_TICK_MS = 30_000;
/** Consecutive failures before a job is retried on a widening gap rather than every due tick. */
export const FAILURE_BACKOFF_AFTER = 3;
export const FAILURE_BACKOFF_BASE_MS = 5 * 60_000;
export const FAILURE_BACKOFF_MAX_MS = 6 * 60 * 60_000;
export const DEFAULT_RUN_TIMEOUT_MS = 15 * 60_000;
export const MAX_CONCURRENT_RUNS = 3;
/**
 * How long `removeJob` waits for an aborted run to write its record before removing the job anyway.
 * Two seconds is enough: the drain exists to let a normal abort write its record first, not to
 * outlast a wedged sub-agent — the job is removed regardless, and `runOnce` discards its state.
 */
export const REMOVE_DRAIN_MS = 2_000;

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
	/** Inject-mode job is due: deliver `prompt` to the current session. `runId` is the id in its `[Trigger …]` prefix. */
	onInject?: (job: LoopJob, prompt: string, runId: string) => void | Promise<void>;
	/**
	 * The host: run `prompt` as a turn in the closed conversation it now holds. Resolves when the turn
	 * is over with the run's result; `preempted` when a window took the conversation back before the
	 * turn completed (a turn that completed is done, whoever holds the lease now).
	 */
	onHeldTurn?: (job: LoopJob, prompt: string, runId: string, held: HeldSession, signal: AbortSignal) => Promise<{ preempted: boolean; result: RunnerResult }>;
	onRunStart?: (job: LoopJob, runId: string) => void;
	/** A run is being fired for a tick that was missed while no pi was open. */
	onCatchUp?: (job: LoopJob, dueAt: number) => void;
	onRunFinished?: (outcome: RunOutcome) => void;
	/** A one-shot removed itself: the control plane records it the way a person's removal is recorded. */
	onJobRetired?: (job: LoopJob, reason: string) => void;
	onInboxChanged?: () => void;
	/** Every tick, before dispatch. Other subsystems (leases, dynamic triggers) piggyback on it. */
	onTick?: (now: number) => void | Promise<void>;
	/** A whole tick failed: nothing ran. A failure that needs a person, where `log` is a diagnostic at either level. */
	onSchedulerError?: (message: string) => void;
	/** Today's spend passed the configured cap; nothing more will be dispatched today. */
	onBudgetExceeded?: (spent: number, cap: number) => void;
	/**
	 * A diagnostic, with how serious it is. Only the scheduler knows whether a line is routine
	 * (taking the timer over) or a failure, and the caller was reading it back off the wording with
	 * a regex over these strings. Absent `level` means `"warning"`: a line that does not say it is
	 * routine is not.
	 */
	log?: (message: string, level?: "info" | "warning") => void;
}

/**
 * The lease side of plain-job ownership (src/lease.ts): a plain job fires only in the instance that
 * holds its session's lease, and its claim re-checks that the lease has not moved since.
 */
export interface PlainJobLeases {
	/** The epoch of this instance's lease on `sessionId`, when it holds it. */
	heldEpoch(sessionId: string): number | undefined;
	/** The pid of the live holder of `sessionId`'s lease, when there is one. */
	holderOf(sessionId: string): number | undefined;
	/** Windows: whether the host fires this closed conversation's plain jobs (it runs, and knows the file). */
	hostRuns?(sessionId: string): boolean;
	/** The host: take a closed conversation for one turn (src/lease.ts acquireForHost), or undefined. */
	acquireForWork?(sessionId: string, runId: string, jobId: string): HeldSession | undefined;
	/** The host: give the conversation back after the turn. A window that took it meanwhile keeps it. */
	releaseWork?(sessionId: string, epoch: number): void;
}

/** A closed conversation the host holds for one turn. */
export interface HeldSession {
	sessionId: string;
	epoch: number;
	sessionFile: string;
	cwd?: string;
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
	/** "host" = the always-on process: it also writes next-runs.json and sweeps dead sessions. Default "interactive". */
	kind?: PresenceKind;
	/**
	 * Which jobs this scheduler dispatches. The host passes "loops only", a window "the plain jobs of
	 * the conversation it holds". Omitted (tests), it owns every loop and the plain jobs `view` says run here.
	 */
	owns?: (job: LoopJob, view: OwnerView) => boolean;
	/**
	 * The process-wide sub-agent admission counter, shared with the trigger runtime and the /goal
	 * evaluator (src/slots.ts). Omitted, the scheduler bounds only itself against
	 * `maxConcurrentRuns` — which is the bug this exists to close, so production always passes one.
	 */
	slots?: SubagentSlots;
	/** Omitted, the session of `getSession()` counts as held by this instance (tests, the host, which has none). */
	leases?: PlainJobLeases;
	/** The extension instance this scheduler runs for: the same id its session lease names. */
	instance?: string;
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

export class LoopScheduler {
	readonly store: JobStore;
	readonly inbox: Inbox;
	private readonly dir: string;
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
	private startedAt = 0;
	private readonly inflight = new Map<string, { ctrl: AbortController; label: string; jobId: string; startedAt: string; promptPreview: string; sessionFile?: string }>();
	/** Promises of runs in flight, so stop() can wait for their records to land. */
	private readonly runs = new Set<Promise<void>>();
	private stopped = false;
	private tickPromise?: Promise<void>;
	readonly instance: string;
	private readonly leases?: PlainJobLeases;
	private readonly owns: (job: LoopJob, view: OwnerView) => boolean;
	/** This process in the machine-wide presence registry (which pi is open where). */
	readonly presence: PresenceRegistry;
	readonly self: PresenceSelf;

	constructor(opts: SchedulerOptions) {
		this.dir = opts.dir;
		this.store = new JobStore(opts.dir);
		this.inbox = new Inbox(opts.dir);
		// Written by the host alone. A cron expression is matched against local time, so if two
		// machines sharing a `$HOME` both ran, they would write different answers over one another —
		// which is why that arrangement is unsupported rather than handled (docs/design.md §19).
		this.nextRunsFile = path.join(opts.dir, "next-runs.json");
		this.getSession = opts.getSession;
		this.hooks = opts.hooks ?? {};
		this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
		this.runner = opts.runner;
		this.now = opts.now ?? Date.now;
		this.hop = opts.hop ?? 0;
		this.getSettings = opts.getSettings ?? (() => ({ maxConcurrentRuns: MAX_CONCURRENT_RUNS, catchUp: true }));
		this.slots = opts.slots ?? new SubagentSlots(() => this.getSettings().maxConcurrentRuns);
		this.instance = opts.instance ?? newId("sched");
		this.leases = opts.leases;
		this.owns = opts.owns ?? ((job, view) => runsHere(job, view));
		this.sessionExists = opts.sessionExists;
		this.kind = opts.kind ?? "interactive";
		const session = opts.getSession();
		this.self = { pid: process.pid, host: os.hostname(), instance: this.instance, sessionId: session.sessionId, cwd: session.cwd, kind: this.kind, leases: true };
		this.presence = new PresenceRegistry(opts.dir, this.self);
	}

	/** What this instance knows about who holds which session: the lists and dispatch ask it the same way. */
	ownerView(session: SessionSnapshot = this.getSession()): OwnerView {
		const sessionId = session.sessionId;
		const leases = this.leases;
		if (!leases) return { sessionId, holdsOwn: !!sessionId };
		return { sessionId, holdsOwn: !!sessionId && leases.heldEpoch(sessionId) !== undefined, holderOf: (id) => leases.holderOf(id), hostRuns: leases.hostRuns ? (id) => leases.hostRuns!(id) : undefined };
	}

	/** Live pi processes on every host (stale entries pruned). */
	presenceList(now = this.now()): PresenceEntry[] {
		return this.presence.list(now);
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

	/**
	 * Remove a job. A run of it that is in flight is aborted first and given up to
	 * REMOVE_DRAIN_MS to write its record, so the removal does not race the run's end.
	 * Returns the removed job (undefined when there was none) and how many runs were aborted.
	 */
	async removeJob(id: string, opts: { purge?: boolean } = {}): Promise<{ job: LoopJob | undefined; aborted: number }> {
		const runIds = [...this.inflight.entries()].filter(([, r]) => r.jobId === id).map(([runId]) => runId);
		for (const runId of runIds) this.inflight.get(runId)?.ctrl.abort();
		// The wall clock, not `this.now()`: this is a real wait, and a test that moved its injected
		// clock must not be able to hold the removal open for ever.
		const deadline = Date.now() + REMOVE_DRAIN_MS;
		while (runIds.some((runId) => this.inflight.has(runId)) && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 25));
		}
		// If a run is still there past the drain the job is removed anyway; `runOnce` re-reads the
		// store before it writes anything, so a late run leaves nothing behind.
		const job = await this.store.remove(id, opts);
		return { job, aborted: runIds.length };
	}

	/** Idempotent. Starts the tick timer. */
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

	/** Idempotent. Stops the timer and aborts in-flight runs. */
	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		await this.tickPromise; // a tick already dispatching must not launch after we leave
		for (const { ctrl } of this.inflight.values()) ctrl.abort();
		// What is lost past this is the record, not the run: the sub-agent is already aborted, and
		// waiting longer only delays the quit that asked for it.
		const DRAIN_TIMEOUT_MS = 5_000;
		await this.drain(DRAIN_TIMEOUT_MS);
	}

	private log(message: string, level?: "info" | "warning"): void {
		this.hooks.log?.(message, level);
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
			const host = this.kind === "host";
			const session = this.getSession();
			try {
				// A hook that throws must not escape the tick: `start()` runs it as `void this.tick()` and
				// pi installs no unhandledRejection handler, so an unguarded throw here kills pi.
				await this.hooks.onTick?.(now);
			} catch (err: any) {
				this.log(`tick hook failed: ${err?.message ?? err}`);
			}
			let jobs: LoopJob[];
			try {
				// `mutate` writes only when the list really changed, so a tick with nothing to clear
				// costs one read and no write (store.ts).
				let retired: LoopJob[] = [];
				jobs = await this.store.mutate((all) => {
					retired = this.clearStaleRunning(all);
					return { jobs: all, result: all };
				});
				for (const job of retired) {
					try {
						this.hooks.onJobRetired?.(job, "one-shot finished before its process ended");
					} catch (err: any) {
						this.log(`onJobRetired hook failed: ${err?.message ?? err}`);
					}
				}
			} catch (err: any) {
				this.log(`cannot read jobs: ${err?.message ?? err}`);
				return;
			}
			// What the store cannot say and every reader wants: when each job runs next. It is a pure
			// function of the job, but computing it needs the cron evaluator — which the browser
			// front end does not have and should not grow a second copy of. The host writes the
			// answers where that front end already reads pi-loops' own files, and only when one of
			// them changes, which for a nightly job is once a day.
			if (host) this.writeNextRuns(jobs, now);
			if (host && this.sessionExists && now - this.lastDeadSessionScan >= DEAD_SESSION_SCAN_MS) {
				this.lastDeadSessionScan = now;
				try {
					await this.disableDeadSessionJobs(jobs);
				} catch (err: any) {
					this.log(`dead-session check failed: ${err?.message ?? err}`);
				}
			}
			const view = this.ownerView(session);
			for (const job of jobs) {
				if (!job.enabled) continue;
				if (!this.owns(job, view)) continue;
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
		const dead = jobs.filter((j) => j.enabled && !j.stateful && j.sessionId && !live.has(j.sessionId) && !exists(j.sessionId));
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

	/**
	 * Remove the jobs `disableDeadSessionJobs` parked; returns them. These are plain jobs of deleted
	 * sessions with nothing left to run, so gc says yes to `purge`: their leftover state and
	 * transcripts go with them.
	 */
	async gc(inScope: (job: LoopJob) => boolean = () => true): Promise<LoopJob[]> {
		return this.store.removeWhere((j) => inScope(j) && !j.enabled && !!j.lastError?.endsWith(DEAD_SESSION_MARKER), { purge: true });
	}

	/**
	 * Clear running markers left behind by processes that are gone. Mutates `jobs` in place and
	 * returns the one-shots it retired, for the caller to report once the store is written.
	 *
	 * A dead marker is looked up in the run log first. A run whose record is there finished, and only
	 * its last write to the store was lost (the process died between `appendRun` and the update after
	 * it): its slot is spent, so the bookkeeping is finished from the record instead of rolling back
	 * and running it a second time. Only a run with no record is owed again.
	 */
	private clearStaleRunning(jobs: LoopJob[]): LoopJob[] {
		// The wall clock, not `this.now()`: `os.uptime()` is measured against it, so the boot instant
		// is only meaningful in the same terms — which is why a test cannot move this comparison.
		const booted = Date.now() - os.uptime() * 1000;
		let records: Map<string, RunRecord> | undefined;
		const recordOf = (runId: string): RunRecord | undefined => {
			records ??= new Map(this.store.allRuns().map((r) => [r.runId, r]));
			return records.get(runId);
		};
		const retired: LoopJob[] = [];
		for (const job of jobs) {
			if (!job.running) continue;
			const { pid, runId, startedAt } = job.running;
			const isMine = pid === process.pid;
			// A pid is only evidence while it can still be the same process: after a reboot the
			// numbers are handed out again, and a recycled pid would park the job forever.
			const recycled = Number.isFinite(booted) && Date.parse(startedAt) < booted - 60_000;
			const alive = isMine ? this.inflight.has(runId) : !recycled && pidAlive(pid);
			if (alive) continue;
			job.running = undefined;
			const record = recordOf(runId);
			if (record) {
				job.lastCompletedAt = record.finishedAt;
				job.lastError = record.ok ? undefined : record.error;
				job.runCount++;
				job.consecutiveFailures = record.ok ? undefined : (job.consecutiveFailures ?? 0) + 1;
				if (job.schedule.kind === "once" && (record.ok || job.runCount >= 2)) retired.push(job);
				continue;
			}
			// The run that died is owed again: roll the bookkeeping back so the next tick re-fires it
			// (collapsed like any other missed tick) instead of silently skipping to the next slot. It
			// was tried, so a process that starts after its due time must not call it missed.
			job.owedSlot = job.lastDueAt ?? startedAt;
			job.lastDueAt = undefined;
			job.lastFiredAt = undefined;
			job.lastError = "cleared stale running state (previous pi process ended mid-run); the run will be retried";
		}
		for (const job of retired) jobs.splice(jobs.indexOf(job), 1);
		return retired;
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
			// A plain job's marker is the host's turn in its conversation: that turn either completes the
			// slot or hands it back owed, so there is nothing to skip — wait for it.
			if (!job.stateful) return;
			await this.store.update(job.id, (j) => {
				j.skippedOverlap++;
				j.lastDueAt = dueIso;
				j.lastError = "skipped: previous run still active";
			});
			return;
		}
		// A slot handed back unrun was tried, not missed: it runs now whatever the catch-up setting says.
		const owed = !!job.owedSlot && Date.parse(job.owedSlot) <= due;
		const missedWhileDown = !owed && due < this.startedAt - this.tickMs;
		if (missedWhileDown && !(job.catchUp && this.getSettings().catchUp)) {
			await this.store.update(job.id, (j) => {
				j.lastDueAt = dueIso;
				j.lastError = `missed ${formatLocal(due)} while ${this.kind === "host" ? "the host was not running" : "no pi was running"} (catch-up disabled)`;
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
		if (!job.stateful && this.kind !== "host") {
			await this.injectPlainJob(job, dueIso, now, missedWhileDown ? `\n(catching up a run due ${formatLocal(due)})` : "");
			return;
		}
		// A failing job is retried with a widening gap instead of at every due tick: a loop whose
		// sub-agent kills the process used to re-fire on the very next start, in a loop.
		const failures = job.consecutiveFailures ?? 0;
		if (failures >= FAILURE_BACKOFF_AFTER && job.lastCompletedAt) {
			const wait = backoffWaitMs(failures, FAILURE_BACKOFF_AFTER, FAILURE_BACKOFF_BASE_MS, FAILURE_BACKOFF_MAX_MS);
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
		// Never await a run inside a tick: leases, presence and trigger checks keep
		// going while sub-agents work, and several loops really do run at once.
		if (!job.stateful) {
			this.track(this.launchHeld(job, dueIso, now, missedWhileDown ? `\n(catching up a run due ${formatLocal(due)})` : ""), slot);
			return;
		}
		this.track(this.launch(job, dueIso, now, session, missedWhileDown), slot);
	}

	/**
	 * A plain job firing: the bookkeeping, the injection, and the retirement of a one-shot. Both the
	 * timer (`dispatch`) and `/cron run` come through here — they were two copies, and the second one
	 * had drifted: no `once` retirement, no `lastDueAt` / `lastCompletedAt`, `lastError` never cleared.
	 *
	 * `dueIso` is the slot being spent, absent when the run was asked for rather than scheduled;
	 * `note` is appended to the injected text (the catch-up line). Returns whether the job was
	 * actually injected, so `/cron run` does not report a run that never happened.
	 */
	private async injectPlainJob(job: LoopJob, dueIso: string | undefined, now: number, note = ""): Promise<boolean> {
		// A plain job's whole point is to land in a chat, and the headless host has none. The
		// ownership test in `dispatch` already excludes these (the host's snapshot has no sessionId), so
		// this is belt and braces: the bookkeeping below commits before `onInject` runs, and a
		// host that ever gained a session id would otherwise record an undelivered job as a
		// completed run and delete a one-shot unfired.
		if (this.kind === "host") return false;
		// The epoch the lease had when this instance decided the job was its own. Read again inside
		// the claim: a lease that moved since (this window closed its session, another took it) means
		// the slot is no longer ours to fire.
		const epoch = job.sessionId ? this.leases?.heldEpoch(job.sessionId) : undefined;
		if (this.leases && epoch === undefined) return false;
		let claimed = false;
		await this.store.update(job.id, (j) => {
			// The slot was decided from a snapshot, as in `launch`: if another instance fired or skipped
			// this job since, its stamps moved, and firing again would put the message in the chat twice.
			if (j.lastDueAt !== job.lastDueAt || j.lastFiredAt !== job.lastFiredAt) return;
			if (this.leases && (!j.sessionId || this.leases.heldEpoch(j.sessionId) !== epoch)) return;
			claimed = true;
			if (dueIso) j.lastDueAt = dueIso;
			j.lastFiredAt = stamp(now);
			j.lastCompletedAt = j.lastFiredAt;
			j.owedSlot = undefined;
			// Only an enabled job's error is stale news. A disabled one's is why it is disabled — and
			// for a job the dead-session sweep parked it is the marker `gc()` matches on.
			if (j.enabled) j.lastError = undefined;
			j.runCount++;
		});
		if (!claimed) return false;
		// Inject-and-run: the job's action lands in the parent chat as a user message with
		// the engine-enforced `[Trigger <run id>] ` prefix. The id is handed over as well: it is minted
		// here, and the caller used to read it back out of the string this just formatted.
		const runId = newId("run");
		await this.hooks.onInject?.(job, `[Trigger ${runId}] ${job.prompt}${note}`, runId);
		if (job.schedule.kind === "once") {
			await this.store.remove(job.id);
			try {
				this.hooks.onJobRetired?.(job, "one-shot fired");
			} catch (err: any) {
				this.log(`onJobRetired hook failed: ${err?.message ?? err}`);
			}
		}
		return true;
	}

	/**
	 * The host firing a plain job of a closed conversation: take the conversation, claim the slot
	 * against the stamps and the lease's epoch, run the turn in it, give the conversation back. A
	 * window that opens the conversation meanwhile takes it at once; the turn stops at its next event
	 * and the slot is handed back, so the window fires it instead — a slot runs to completion once.
	 */
	private async launchHeld(job: LoopJob, dueIso: string, now: number, note: string): Promise<void> {
		const leases = this.leases;
		const sessionId = job.sessionId;
		if (!sessionId || !leases?.acquireForWork || !this.hooks.onHeldTurn) return;
		const runId = newId("run");
		const held = leases.acquireForWork(sessionId, runId, job.id);
		if (!held) return; // the slot stays owed: the conversation is busy, open or recently written
		try {
			const startedAt = stamp(now);
			let claimed = false;
			await this.store.update(job.id, (j) => {
				if (j.running) return;
				if (j.lastDueAt !== job.lastDueAt || j.lastFiredAt !== job.lastFiredAt) return;
				if (leases.heldEpoch(sessionId) !== held.epoch) return;
				claimed = true;
				// Written before the turn starts, as a loop's marker is: a host that dies mid-turn leaves
				// it behind, and the next host finds an unfinished run instead of a slot spent in silence.
				j.running = { runId, pid: process.pid, host: this.self.host, startedAt };
				j.lastDueAt = dueIso;
				j.lastFiredAt = startedAt;
				j.owedSlot = undefined;
			});
			if (!claimed) return;
			const ctrl = new AbortController();
			this.inflight.set(runId, { ctrl, label: job.name ?? job.id, jobId: job.id, startedAt, promptPreview: previewRedacted(job.prompt, 120) });
			let outcome: { preempted: boolean; result: RunnerResult };
			try {
				outcome = await this.hooks.onHeldTurn(job, `[Trigger ${runId}] ${job.prompt}${note}`, runId, held, ctrl.signal);
			} catch (err: any) {
				outcome = { preempted: false, result: failedRun(err?.message ?? String(err)) };
			}
			const { result } = outcome;
			// Handed back unrun, so the slot is owed: a window took the conversation (and runs it now), or
			// this host stopped the turn itself — a stop, an upgrade, `/cron abort`, the daily budget.
			const budgetStopped = !result.ok && (result.errorMessage ?? "").startsWith("stopped by today's");
			const handedBack = !result.ok && (outcome.preempted || ctrl.signal.aborted || budgetStopped);
			const record: RunRecord = {
				runId,
				jobId: job.id,
				jobName: job.name,
				stateful: false,
				cwd: held.cwd ?? job.cwd,
				pid: process.pid,
				startedAt,
				finishedAt: stamp(this.now()),
				ok: result.ok,
				exitCode: result.exitCode,
				error: result.ok ? undefined : redact(result.errorMessage ?? "unknown error"),
				findings: 0,
				droppedFindings: 0,
				stateUpdated: false,
				model: result.model ?? job.model,
				usage: result.usage,
				warning: result.warning,
				retries: result.retries,
				compactions: result.compactions,
				summary: previewRedacted(result.text, 400) || undefined,
				sessionId,
				sessionFile: held.sessionFile,
				forSession: job.createdBy?.sessionId ?? sessionId,
			};
			// Every turn is recorded, a stopped one too: it was billed, and the daily budget, `/cron runs`
			// and the status page all read the run log.
			try {
				this.store.appendRun(record);
			} catch (err: any) {
				this.log(`run log append failed: ${err?.message ?? err}`);
			}
			let updated: LoopJob | undefined;
			try {
				updated = await this.store.update(job.id, (j) => {
					if (j.running?.runId === runId) j.running = undefined;
					if (handedBack) {
						// Given back with a compare: only while the stamps are still the ones this claim wrote.
						if (j.lastFiredAt !== startedAt) return;
						j.lastDueAt = job.lastDueAt;
						j.lastFiredAt = job.lastFiredAt;
						j.owedSlot = dueIso;
						return;
					}
					j.lastCompletedAt = record.finishedAt;
					j.runCount++;
					// Only an enabled job's error is stale news: a disabled one's says why it is disabled.
					if (j.enabled || !result.ok) j.lastError = record.error;
					j.consecutiveFailures = result.ok ? undefined : (j.consecutiveFailures ?? 0) + 1;
				});
			} catch (err: any) {
				this.log(`cron ${job.id}: could not write the store after its turn (${err?.message ?? err})`);
			}
			this.inflight.delete(runId);
			if (handedBack) {
				this.log(`cron ${job.name ?? job.id}: ${outcome.preempted ? `a window opened session ${sessionId.slice(0, 8)} during its turn; that window runs it` : `turn stopped (${record.error}); the slot is owed`}`, "info");
				return;
			}
			if (updated && !result.ok && (updated.consecutiveFailures ?? 0) >= FAILURE_BACKOFF_AFTER) {
				this.hooks.onSchedulerError?.(`${updated.name ?? updated.id} has failed ${updated.consecutiveFailures} times in a row; backing off (last: ${record.error ?? "unknown"})`);
			}
			// A one-shot gets the same single retry a one-shot loop gets, then it is retired.
			if (updated && job.schedule.kind === "once" && (result.ok || updated.runCount >= 2)) {
				await this.store.remove(job.id);
				try {
					this.hooks.onJobRetired?.(job, result.ok ? "one-shot fired" : `one-shot failed twice (${record.error})`);
				} catch (err: any) {
					this.log(`onJobRetired hook failed: ${err?.message ?? err}`);
				}
			}
		} finally {
			leases.releaseWork?.(sessionId, held.epoch);
		}
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

	/**
	 * Fire a job now, ignoring its schedule. Returns `true`, or the reason it did not run — phrased
	 * to follow the job's name, which is the shape `/cron run` has always reported a refusal in
	 * ("nightly is already running").
	 */
	async runNow(jobId: string): Promise<true | string> {
		const job = this.store.load().find((j) => j.id === jobId);
		if (!job) return "is no longer in the store";
		if (job.running) return "is already running";
		if (this.stopped) return "cannot run: this session's scheduler has stopped";
		const now = this.now();
		if (!job.stateful) {
			// A disabled plain job stays parked. Its prompt would land in whatever chat is open now
			// rather than the one it was written for, and the injection clears `lastError` — which for a
			// job the dead-session sweep parked is the marker `gc()` matches on, so running it once left
			// a job nothing could fire and nothing could collect.
			if (!job.enabled) return "is disabled (/cron enable it first)";
			// The same reasoning for a job that is enabled but belongs to another session: its prompt is
			// written for that conversation, and running it here would land it in this one.
			const where = whereRuns(job, this.ownerView());
			if (where.kind === "terminal") return `belongs to session ${ownerSession(job)}, which is open in pid ${where.pid} — run it there`;
			if (where.kind !== "here") return `belongs to session ${ownerSession(job)}, which is not open here — resume it, or /cron add the job again in this chat`;
			// No `dueIso`: this run was asked for, so whatever slot the schedule owes is still owed.
			if (!(await this.injectPlainJob(job, undefined, now))) return this.kind === "host" ? "has no chat to run in (the background host has no session)" : "was fired by another window at the same moment";
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
			// The slot was decided from a snapshot. If another process ran or skipped this job since,
			// its stamps moved: that slot is spent, and running it again would run it twice.
			if (j.lastDueAt !== priorDueAt || j.lastFiredAt !== priorFiredAt) return;
			j.running = { runId, pid: process.pid, host: this.self.host, startedAt };
			if (dueIso) j.lastDueAt = dueIso;
			j.lastFiredAt = startedAt;
			j.lastError = undefined;
			j.owedSlot = undefined;
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
		// `job` is the pre-claim snapshot, so its `lastFiredAt` is when the previous run started —
		// a reason given before that was already in front of that run.
		const dismissed = this.inbox.feedbackFor(job.id, job.lastFiredAt).map((e) => ({ text: String(e.text), reason: String(e.dismiss_reason ?? "") }));
		const prompt = composeLoopPrompt(job.prompt, previousState, {
			name: job.name,
			dismissed,
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

		// The job may have been removed while the run was in flight — by `/cron remove` here, by the
		// tool, or by another pi window. Its state and findings belong to a job that is gone, so they
		// are discarded; the run record is still written below, because the run did happen.
		// A store that cannot be read (a torn write, a file from a newer build) must not cost a run its
		// record and its findings: the question here is only whether the job was removed, and the safe
		// answer to "cannot tell" is no.
		let stillThere = true;
		try {
			stillThere = this.store.load().some((j) => j.id === job.id);
		} catch (err: any) {
			this.log(`loop ${job.id}: could not read the store after the run (${err?.message ?? err}); keeping its state and findings`);
		}
		if (!stillThere) this.log(`loop ${job.id}: removed during the run; its state and findings are discarded`);

		// Tag extraction never fails a run: malformed/missing tags leave the state untouched.
		const parsed = parseRunOutput(result.text);
		let stateUpdated = false;
		if (stillThere && result.ok && parsed.state !== undefined) {
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
		if (stillThere && result.ok && job.verify && parsed.findings.length && !ctrl.signal.aborted) {
			const outcome = await this.runChecker(job, runId, parsed.state ?? previousState, parsed.findings, ctrl.signal, job.checkerModel ?? model, thinking);
			checker = outcome.record;
			reviewed = outcome.reviewed;
		}
		const findings: string[] = [];
		if (stillThere && result.ok) {
			// cron:<name>, else cron:<id prefix> — "cron-" plus 8 hex, the width /inbox shows.
			const source = `cron:${job.name ?? job.id.slice(0, "cron-".length + 8)}`;
			for (const f of reviewed) {
				try {
					await this.inbox.append({ source, text: f.text, run_id: runId, job_id: job.id, cwd: job.cwd, kind: findingKind(f.text), verified: f.verified, verified_reason: f.reason, session_id: job.createdBy?.sessionId, transcript: result.sessionFile });
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
			forSession: job.createdBy?.sessionId,
		};
		this.store.pruneSessions(job.id, undefined, this.inbox.pinnedTranscripts(job.id));
		try {
			this.store.appendRun(record);
		} catch (err: any) {
			this.log(`run log append failed: ${err?.message ?? err}`);
		}
		// An abort is not a run: quitting, a session swap or `/cron abort` interrupted it, so the
		// slot it claimed is given back and the next tick re-fires it (a tick is never lost this
		// way because its runs die with the session that owned them).
		const aborted = !result.ok && (result.stopReason === "aborted" || ctrl.signal.aborted);
		// The same unreadable store that was tolerated above must not cost the run its `onRunFinished`
		// either: the record is already written, and the job's own bookkeeping is the one part that
		// can be skipped when the file cannot be read.
		let updated: LoopJob | undefined;
		try {
			updated = await this.store.update(job.id, (j) => {
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
		} catch (err: any) {
			this.log(`loop ${job.id}: could not write the store after the run (${err?.message ?? err})`);
		}
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
			if (result.ok || updated.runCount >= 2) {
				await this.store.remove(job.id);
				try {
					this.hooks.onJobRetired?.(job, result.ok ? "one-shot finished" : "one-shot failed twice");
				} catch (err: any) {
					this.log(`onJobRetired hook failed: ${err?.message ?? err}`);
				}
			} else {
				await this.store.update(job.id, (j) => {
					j.lastDueAt = undefined;
					j.lastFiredAt = undefined;
					j.lastError = `${record.error ?? "run failed"} (one-shot: retrying once)`;
				});
			}
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
