import { failurePause } from "./backoff.ts";
import { plainCollapseKey } from "./engine.ts";
import { loopLane } from "./lane.ts";
import { runEnd } from "./settle.ts";
import type { JobClock } from "./clock.ts";
import type { Row } from "./requests.ts";
type CountedRow = Row & { collapsed?: number; collapsed_slot?: string };
import { computeNext } from "./schedule.ts";
import type { Disabled, LoopJob, LoopJobV3, RunRecord } from "./store.ts";

/** What the run log says about one job, folded in file order. */
export interface JobHistory {
	readonly ordinal: number;
	readonly streak: number;
	readonly failed?: { readonly at: string; readonly error: string };
	readonly finished?: string;
	readonly spent: ReadonlySet<string>;
}

/** Fold run records once for all jobs. */
export function runHistory(records: readonly RunRecord[]): ReadonlyMap<string, JobHistory> {
	const histories = new Map<string, { ordinal: number; streak: number; failed?: { at: string; error: string }; finished?: string; spent: Set<string> }>();
	for (const record of records) {
		let history = histories.get(record.jobId);
		if (!history) {
			history = { ordinal: 0, streak: 0, spent: new Set() };
			histories.set(record.jobId, history);
		}
		history.finished = record.finishedAt;
		const end = runEnd(record);
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
		try { next = computeNext({ schedule: job.schedule, createdAt: Date.parse(job.createdAt), lastFiredAt: clock?.fired === undefined ? undefined : Date.parse(clock.fired) }, now); }
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
		const code: Disabled["code"] = /no longer exists/.test(why) ? "session-gone" : why.startsWith("disabled: cwd ") ? "cwd-missing" : why.startsWith("parked: ") ? "interrupted" : why.startsWith("disabled: ") ? "schedule" : "person";
		disabled = { code, why, at: lastCompletedAt ?? lastFiredAt ?? job.createdAt };
	}
	return {
		job: { ...definition, enabled: job.enabled, ...(disabled ? { disabled } : {}) },
		clock: { ...(lastDueAt ? { slot: lastDueAt } : {}), ...(lastFiredAt ? { fired: lastFiredAt } : {}), runs: runCount },
	};
}
