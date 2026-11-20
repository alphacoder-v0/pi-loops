import { failurePause } from "./backoff.ts";
import { fromV2 } from "./convert-v2.ts";
import { claimAlive, plainCollapseKey } from "./engine.ts";
import { loopLane } from "./lane.ts";
import { runEnd } from "./settle.ts";
import type { JobClock } from "./clock.ts";
import type { ClaimedRow, RequestStore, Row } from "./requests.ts";
type CountedRow = Row & { collapsed?: number; collapsed_slot?: string };
import { computeNext, formatLocal } from "./schedule.ts";
import type { Disabled, JobStore, LoopJob, LoopJobV3, RunningMarker, RunRecord } from "./store.ts";

export interface BudgetState { readonly spent: number; readonly cap: number; readonly over: boolean }

/** Automation cost since local midnight. An unreadable run log does not stop the clock. */
export function budgetState(ledger: Pick<JobStore, "spend">, capValue: number | undefined, now: number): BudgetState {
	const cap = capValue ?? 0;
	if (cap <= 0) return { spent: 0, cap: 0, over: false };
	const midnight = new Date(now);
	midnight.setHours(0, 0, 0, 0);
	try {
		const spent = ledger.spend(midnight.getTime()).total;
		return { spent, cap, over: spent >= cap };
	} catch {
		return { spent: 0, cap, over: false }; // an unreadable run log must not stop the clock
	}
}

/** What the run log says about one job, folded in file order. */
export interface JobHistory {
	readonly ordinal: number;
	readonly streak: number;
	readonly failed?: { readonly at: string; readonly error: string };
	readonly finished?: string;
	/** The end of the newest run that wrote its own record: main's `lastCompletedAt`. An interrupted run wrote none. */
	readonly completed?: string;
	readonly spent: ReadonlySet<string>;
}

/** Fold run records once for all jobs. */
export function runHistory(records: readonly RunRecord[]): ReadonlyMap<string, JobHistory> {
	const histories = new Map<string, { ordinal: number; streak: number; failed?: { at: string; error: string }; finished?: string; completed?: string; spent: Set<string> }>();
	for (const record of records) {
		let history = histories.get(record.jobId);
		if (!history) {
			history = { ordinal: 0, streak: 0, spent: new Set() };
			histories.set(record.jobId, history);
		}
		history.finished = record.finishedAt;
		const end = runEnd(record);
		if (end.how !== "interrupted") history.completed = record.finishedAt;
		if (end.how === "succeeded") {
			history.streak = 0;
			history.failed = undefined;
			history.ordinal = Math.max(history.ordinal, record.ordinal ?? 0);
			history.spent.add(record.runId);
		} else if (end.how === "failed") {
			history.streak += 1;
			history.failed = { at: end.at, error: end.error };
			history.ordinal = Math.max(history.ordinal, record.ordinal ?? 0);
			history.spent.add(record.runId);
		} else if (end.how === "stopped") history.spent.add(record.runId);
	}
	return histories;
}

/** What a listing shows for one job, with each field derived from its clock, rows or records. */
export interface JobStatus {
	readonly state: "enabled" | "disabled" | "proposed";
	readonly disabled?: Disabled;
	readonly next?: number;
	readonly slot?: string;
	readonly fired?: string;
	readonly finished?: string;
	readonly running?: { readonly runId: string; readonly since: string; readonly collapsed?: number };
	readonly queued?: { readonly since: string; readonly why?: string; readonly collapsed?: number; readonly attempts: number };
	readonly error?: { readonly text: string; readonly streak: number; readonly retryAt?: number };
	readonly note?: string;
	readonly runs: number;
}

export function jobStatus(job: LoopJobV3, clock: JobClock | undefined, rows: readonly CountedRow[], history: JobHistory | undefined, now: number): JobStatus {
	const state = job.proposed ? "proposed" : job.enabled ? "enabled" : "disabled";
	let next: number | undefined;
	if (state === "enabled") {
		try { next = computeNext({ schedule: job.schedule, createdAt: Date.parse(job.createdAt), fired: clock?.fired === undefined ? undefined : Date.parse(clock.fired) }, now); }
		catch { next = undefined; }
	}
	const key = job.stateful ? undefined : plainCollapseKey(job.id);
	const mine = rows.filter((row) => row.kind === "input" && (job.stateful ? row.lane === loopLane(job.id) : row.collapse_key === key));
	const runningRow = mine.find((row) => row.run);
	const queuedRow = mine.filter((row) => !row.run).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
	const pause = history ? failurePause(history.streak) : 0;
	const retryAt = history?.failed && pause > 0 ? Date.parse(history.failed.at) + pause : undefined;
	return {
		state,
		...(state === "disabled" && job.disabled ? { disabled: job.disabled } : {}),
		...(next === undefined ? {} : { next }),
		...(clock?.slot === undefined ? {} : { slot: clock.slot }),
		...(clock?.fired === undefined ? {} : { fired: clock.fired }),
		...(history?.finished === undefined ? {} : { finished: history.finished }),
		...(runningRow?.run ? { running: { runId: runningRow.run.id, since: runningRow.run.started_at, collapsed: runningRow.collapsed } } : {}),
		...(queuedRow ? { queued: { since: queuedRow.created_at, ...(queuedRow.not_before && Date.parse(queuedRow.not_before) > now ? { why: `backing off${queuedRow.last_error ? `: ${queuedRow.last_error}` : ""}` } : {}), collapsed: queuedRow.collapsed, attempts: queuedRow.attempts } } : {}),
		...(history?.failed ? { error: { text: history.failed.error, streak: history.streak, ...(retryAt !== undefined && retryAt > now ? { retryAt } : {}) } } : {}),
		...(clock?.note ? { note: clock.note.text } : {}),
		runs: job.stateful ? Math.max(history?.ordinal ?? 0, clock?.runs ?? 0) : clock?.runs ?? 0,
	};
}


/** What says why a loop's queued row does not start yet: the background's drain asks it, and writes the answer on the row (`Row.waiting`). */
export interface GateFacts {
	readonly cwdExists: (cwd: string) => boolean;
	readonly budget: () => BudgetState;
	/** The sub-agent slots of the process that runs loops; a window does not know them. */
	readonly slots?: () => { readonly inUse: number; readonly free: number; readonly limit: number };
}

/** Why a loop's queued row waits, in the words main wrote into `lastError`, or undefined when it can start. */
export function loopWait(job: Pick<LoopJob, "cwd" | "cwdMissingSince">, facts: GateFacts, now: number): string | undefined {
	if (!facts.cwdExists(job.cwd)) {
		const since = Date.parse(job.cwdMissingSince ?? "") || now;
		return `waiting: cwd ${job.cwd} is not there yet (since ${formatLocal(since)}; disabled if it stays missing)`;
	}
	const budget = facts.budget();
	if (budget.over) return `paused: today's automation has cost $${budget.spent.toFixed(2)} of the $${budget.cap.toFixed(2)} budget ([limits] daily_budget_usd)`;
	const slots = facts.slots?.();
	if (slots && slots.free <= 0) return `deferred: ${slots.inUse} sub-agent(s) already in flight (max ${slots.limit})`;
	return undefined;
}

/**
 * A loop as main's `jobs.json` had it, for the lists. Since a loop's runs are rows of its lane,
 * nothing writes `running`, `lastCompletedAt` or `consecutiveFailures` of a loop, and `lastError`
 * only for the clock's notes and a disable's reason. They are derived here from its rows, its run
 * log and its cursor, as main wrote them:
 *
 *   running              the live claim on a row of its lane, or an older version's marker
 *   lastFiredAt          that claim's start while it goes (main wrote it at the launch), else the cursor's
 *   lastDueAt            none while a row waits to start: main wrote it at the launch, and the slot
 *                        of the launch before is not kept, so it is not shown
 *   lastDueAt and lastFiredAt  neither, for a row that is owed again (an interrupted run, a one-shot's
 *                        second try) and for a loop parked after interrupted runs: main rolled both
 *                        back so that the slot fires again
 *   lastCompletedAt      the end of the newest run that wrote its own record
 *   consecutiveFailures  the failed records at the end of the run log
 *   lastError            the first that applies: a disabled job's reason; why a waiting row waits
 *                        (`Row.waiting`, which the background writes); an interrupted run's retry;
 *                        a slot skipped while the run goes (`Row.skipped`); nothing else while
 *                        it goes (the launch cleared it); then the later of the last failure (while
 *                        it is the newest run that ended, and not one before an enable) and the
 *                        clock's note
 *
 * A plain job is returned as it is: its turns still write these fields (until M4b.B).
 */
/** What a list shows of a job beside its definition: its cursor, its run and its failures. */
export interface ListedStatus {
	/** The last slot the schedule fired or owes: main's `lastDueAt`. */
	readonly due?: string;
	/** When the last run started: main's `lastFiredAt`. */
	readonly fired?: string;
	/** When the last run that wrote its own record ended: main's `lastCompletedAt`. */
	readonly completed?: string;
	readonly runs: number;
	/** Skipped overlaps, a lifetime count. */
	readonly collapsed: number;
	/** Failures in a row. */
	readonly streak: number;
	/** The one line a list shows after `last error:`. */
	readonly error?: string;
	/** The run going now. */
	readonly run?: RunningMarker;
}

/** A job as every list shows it: the definition, and its status from its clock, its rows and its run log. */
export type ListedJob = LoopJobV3 & { readonly status: ListedStatus };

export function listedJob(job: LoopJob, rows: readonly Row[], history: JobHistory | undefined, live: (row: ClaimedRow) => boolean = claimAlive): ListedJob {
	const definition = fromV2(job).job;
	if (!job.stateful) return { ...definition, status: { ...(job.lastDueAt ? { due: job.lastDueAt } : {}), ...(job.lastFiredAt ? { fired: job.lastFiredAt } : {}), ...(job.lastCompletedAt ? { completed: job.lastCompletedAt } : {}), runs: job.runCount, collapsed: job.skippedOverlap, streak: job.consecutiveFailures ?? 0, ...(job.lastError ? { error: job.lastError } : {}), ...(job.running ? { run: job.running } : {}) } };
	const mine = rows.filter((row) => row.kind === "input") as CountedRow[];
	const claim = mine.find((row): row is ClaimedRow & CountedRow => row.run !== undefined && live(row as ClaimedRow));
	const waiting = mine.filter((row) => !row.run).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
	const cleared = (job as LoopJob & { clearedAt?: string }).clearedAt;
	// Main cleared the error at every launch: a failure shows while it is the newest run that ended with a record of its own.
	const failed = history?.failed && history.failed.at === history.completed && !(cleared && Date.parse(history.failed.at) <= Date.parse(cleared)) ? history.failed : undefined;
	const oneShotRetry = job.schedule.kind === "once" && waiting !== undefined && failed !== undefined && (history?.streak ?? 0) === 1;
	const parked = !job.enabled && job.lastError?.startsWith("parked: ") === true;
	const owedAgain = parked || (!claim && waiting !== undefined && (waiting.attempts > 0 || oneShotRetry));
	let lastFiredAt = job.lastFiredAt;
	if (claim && (!lastFiredAt || Date.parse(claim.run.started_at) > Date.parse(lastFiredAt))) lastFiredAt = claim.run.started_at;
	let lastDueAt = job.lastDueAt;
	if (owedAgain || (!claim && waiting)) lastDueAt = undefined;
	if (owedAgain) lastFiredAt = undefined;
	const note = job.enabled ? job.lastError : undefined;
	const lastError = ((): string | undefined => {
		if (!job.enabled) return job.lastError ?? failed?.error;
		if (waiting && !claim) {
			if (typeof waiting.waiting === "string" && waiting.waiting) return waiting.waiting;
			if (waiting.attempts > 0) return "cleared stale running state (previous pi process ended mid-run); the run will be retried";
		}
		// Only a slot counted while this run went is a skip (`Row.skipped`): not one counted while the row waited or its process was gone.
		if (claim) return claim.skipped ? "skipped: previous run still active" : undefined;
		if (failed && !(note && job.lastDueAt && Date.parse(job.lastDueAt) > Date.parse(failed.at))) return oneShotRetry ? `${failed.error} (one-shot: retrying once)` : failed.error;
		return note;
	})();
	return {
		...definition,
		status: {
			...(lastDueAt === undefined ? {} : { due: lastDueAt }),
			...(lastFiredAt === undefined ? {} : { fired: lastFiredAt }),
			...(history?.completed === undefined ? {} : { completed: history.completed }),
			runs: job.runCount,
			collapsed: job.skippedOverlap,
			streak: history?.streak ?? 0,
			...(lastError === undefined ? {} : { error: lastError }),
			// An older version's marker is kept only while its pid is alive (src/convert-v2.ts): it is still a run.
			...(claim ? { run: { runId: claim.run.id, pid: claim.run.pid, startedAt: claim.run.started_at } } : job.running ? { run: job.running } : {}),
		},
	};
}

/** Every job of `jobs.json` as the lists show it (`listedJob`): one read of the jobs, of each loop's lane, and of the folded run log. */
export function listedJobs(stores: { readonly jobs: Pick<JobStore, "load">; readonly requests: Pick<RequestStore, "list">; history(): ReadonlyMap<string, JobHistory> }, live?: (row: ClaimedRow) => boolean): ListedJob[] {
	const jobs = stores.jobs.load();
	const histories = jobs.some((job) => job.stateful) ? stores.history() : new Map<string, JobHistory>();
	return jobs.map((job) => {
		if (!job.stateful) return listedJob(job, [], undefined, live);
		const lane = loopLane(job.id);
		let rows: Row[] = [];
		try { if (lane) rows = stores.requests.list(lane); }
		catch { /* an unreadable lane lists as one with no rows */ }
		return listedJob(job, rows, histories.get(job.id), live);
	});
}
