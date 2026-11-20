/**
 * How the turn of a plain job ends: what becomes of its row and of its job. One table, read by
 * whoever closes a run: the process that ran it, and a later drain that finds its process gone.
 * Pure, and a leaf: it imports types, and one constant of src/backoff.ts.
 */
import { DEAD_AFTER_ATTEMPTS } from "./backoff.ts";
import type { ClaimedRow } from "./requests.ts";
import type { Disabled, LoopJob, RunRecord } from "./store.ts";
import type { JobHistory } from "./job-status.ts";

/** A job whose runs were interrupted this many times in a row is turned off: the turn may be what stops the process. */
export const INTERRUPTIONS_BEFORE_PARKING = 3;

/**
 * How a run ended, as its run record states it. `at` is the record's `finishedAt`.
 *
 *   succeeded    `ok`
 *   failed       not `ok`, not `aborted`, not `interrupted`; `error` is the record's
 *   stopped      `aborted` with `stoppedBy: "person"`
 *   handed-back  `aborted` without `stoppedBy`: a window took the conversation, a quit, an
 *                upgrade, a removed job, the budget
 *   interrupted  the process was gone before it wrote a record
 */
export type RunEnd = (
	| { readonly how: "succeeded" }
	| { readonly how: "failed"; readonly error: string }
	| { readonly how: "stopped" }
	| { readonly how: "handed-back" }
	| { readonly how: "interrupted" }
) & { readonly at: string };

/** The one maker of a `RunEnd`: an end is read from a record, so an end in hand means the record exists. */
export function runEnd(record: RunRecord): RunEnd {
	const at = record.finishedAt;
	if (record.interrupted) return { how: "interrupted", at };
	if (record.aborted && record.stoppedBy === "person") return { how: "stopped", at };
	if (record.aborted) return { how: "handed-back", at };
	if (record.ok) return { how: "succeeded", at };
	return { how: "failed", error: record.error || "run failed", at };
}

/** The reason of the attempt that a row gets when the process that ran it stopped before its prompt was written. */
export const INTERRUPTED = "the process running it stopped";

/**
 * What `settle` decides. `row` has one discriminant, so a result cannot both leave the row and
 * keep it, and only a row that leaves as `delivered` can have a successor.
 */
export interface Settlement {
	readonly row:
		/** The slot is spent: the run ended, or its prompt is in the conversation. `successor`: one more row asks again. */
		| { readonly do: "leave"; readonly exit: "delivered"; readonly successor?: true }
		/** A person stopped the run before the prompt was written. The slot is spent. */
		| { readonly do: "leave"; readonly exit: "stopped" }
		/** The claim is cleared and no attempt is counted. The row is the owed slot. */
		| { readonly do: "owed" }
		/** The claim is cleared, an attempt is counted, and the row backs off. */
		| { readonly do: "retry"; readonly why: string };
	/**
	 * The job turned off, when its interrupted runs in a row reached `INTERRUPTIONS_BEFORE_PARKING`.
	 * Every other count is the run log's (`jobCounts`), so a closing that runs twice counts nothing
	 * twice, and `JobStore.disable` keeps the first reason.
	 */
	readonly disable?: Disabled;
}

/** What the run log says of the job when its run's record is in it: failures in a row, and interrupted runs in a row since its last enable. */
export interface SettleCounts {
	readonly streak: number;
	readonly interrupted: number;
}

/** What a cell counts against the job. The run log holds each count; `interruption` can turn the job off. */
type JobCell = "success" | "failure" | "stop" | "interruption" | "none";

type Cell =
	/** `one-shot-retry`: a successor only for a one-shot whose failures after this one are under two. */
	| { readonly row: "delivered"; readonly job: JobCell; readonly successor: "never" | "always" | "one-shot-retry" }
	| { readonly row: "stopped" | "owed" | "retry"; readonly job: JobCell };

/**
 * The table. The compiler checks that every cell is there. `settle` is this lookup plus the two
 * things a cell cannot say alone: the count after the patch, and whether the patch was applied
 * already. A run that ended spends its slot whether or not its prompt was written: its record is
 * in the run log, and its failure is the job's. Only a run that did not end reads the conversation.
 */
const SPENT_OK: Cell = { row: "delivered", job: "success", successor: "never" };
// A failed turn spends its slot. Only a one-shot is asked again, once.
const SPENT_FAILED: Cell = { row: "delivered", job: "failure", successor: "one-shot-retry" };
const CELLS: Record<RunEnd["how"], Record<"written" | "unwritten", Cell>> = {
	succeeded: { written: SPENT_OK, unwritten: SPENT_OK },
	failed: { written: SPENT_FAILED, unwritten: SPENT_FAILED },
	stopped: {
		// A stop after the prompt was written leaves as `delivered`, not as `stopped`.
		written: { row: "delivered", job: "stop", successor: "never" },
		unwritten: { row: "stopped", job: "stop" },
	},
	"handed-back": {
		// The answer was cut off. One successor asks again, in whichever process holds the conversation next.
		written: { row: "delivered", job: "none", successor: "always" },
		unwritten: { row: "owed", job: "none" },
	},
	interrupted: {
		// The prompt is there and the process died. It is not asked again.
		written: { row: "delivered", job: "interruption", successor: "never" },
		unwritten: { row: "retry", job: "interruption" },
	},
};

/**
 * How a plain job's turn ends. Pure: no clock, no file. `job` is the job the turn's row names, as
 * it is in `jobs.json` now, or undefined when it was removed. `written` says the row's prompt is in
 * the conversation. `counts` are read from the run log after this run's record is in it.
 *
 * The row's result depends on `end.how` and `written` only, but for `successor`, which needs the
 * job: a one-shot's first failure (a streak of 1) is asked once more. The job is turned off when
 * its interrupted runs in a row reach `INTERRUPTIONS_BEFORE_PARKING`: each time, the process stopped
 * while this job's turn was running. Still not proof: a reboot in the middle of a turn counts too,
 * and so does a turn that only ran beside the run that stopped the process. So the reason says what
 * is known, and enabling the job again tries once more.
 */
export function settle(job: Pick<LoopJob, "id" | "schedule" | "enabled"> | undefined, end: RunEnd, written: boolean, counts: SettleCounts): Settlement {
	const cell = CELLS[end.how][written ? "written" : "unwritten"];
	const retryOnce = job?.schedule.kind === "once" && cell.job === "failure" && counts.streak < 2;
	const disable: Disabled | undefined = job && job.enabled && cell.job === "interruption" && counts.interrupted >= INTERRUPTIONS_BEFORE_PARKING
		? { code: "interrupted", why: `parked: its last ${counts.interrupted} runs were interrupted before they finished (the process running them stopped each time; see host.log) — /cron enable ${job.id} to try again`, at: end.at }
		: undefined;
	let row: Settlement["row"];
	if (cell.row === "delivered") {
		const successor = job !== undefined && (cell.successor === "always" || (cell.successor === "one-shot-retry" && retryOnce));
		row = successor ? { do: "leave", exit: "delivered", successor: true } : { do: "leave", exit: "delivered" };
	} else if (cell.row === "retry") {
		row = { do: "retry", why: INTERRUPTED };
	} else {
		row = cell.row === "stopped" ? { do: "leave", exit: "stopped" } : { do: "owed" };
	}
	return disable === undefined ? { row } : { row, disable };
}

/** A loop's end and its record-derived counts. */
export type LoopEnd = RunEnd & { readonly runs: number; readonly streak: number };

export function loopEnd(record: RunRecord, history: JobHistory): LoopEnd {
	return { ...runEnd(record), runs: history.ordinal, streak: history.streak } as LoopEnd;
}

export interface LoopSettlement {
	readonly row:
		| { readonly do: "leave"; readonly exit: "delivered"; readonly successor?: true }
		| { readonly do: "leave"; readonly exit: "stopped" | "parked" }
		| { readonly do: "owed" }
		| { readonly do: "retry"; readonly attempts: number; readonly why: string; readonly wait: false }
		| { readonly do: "dead"; readonly attempts: number; readonly why: string };
	readonly job?: { readonly disabled: Disabled };
	readonly runs?: number;
}

type LoopCell =
	| { readonly row: "spent"; readonly successor: "never" | "first-failure" }
	| { readonly row: "stopped"; readonly job: "keep" | "disable" }
	| { readonly row: "owed" }
	| { readonly row: "attempt" };

const LOOP_CELLS: Record<RunEnd["how"], Record<"repeating" | "one-shot", LoopCell>> = {
	succeeded: { repeating: { row: "spent", successor: "never" }, "one-shot": { row: "spent", successor: "never" } },
	failed: { repeating: { row: "spent", successor: "never" }, "one-shot": { row: "spent", successor: "first-failure" } },
	stopped: { repeating: { row: "stopped", job: "keep" }, "one-shot": { row: "stopped", job: "disable" } },
	"handed-back": { repeating: { row: "owed" }, "one-shot": { row: "owed" } },
	interrupted: { repeating: { row: "attempt" }, "one-shot": { row: "attempt" } },
};

export function settleLoop(row: ClaimedRow, job: Pick<LoopJob, "id" | "name" | "schedule"> | undefined, end: LoopEnd, alone: boolean): LoopSettlement {
	const kind = job?.schedule.kind === "once" ? "one-shot" : "repeating";
	const cell = LOOP_CELLS[end.how][kind];
	if (cell.row === "spent") {
		const successor = !!job && cell.successor === "first-failure" && end.streak === 1;
		return { row: { do: "leave", exit: "delivered", ...(successor ? { successor: true as const } : {}) }, runs: end.runs };
	}
	if (cell.row === "stopped") {
		if (cell.job === "disable" && job) return { row: { do: "leave", exit: "stopped" }, job: { disabled: { code: "person", why: `stopped by a person; /cron run ${job.name ?? job.id} runs it now`, at: end.at } } };
		return { row: { do: "leave", exit: "stopped" } };
	}
	if (cell.row === "owed" || !alone) return { row: { do: "owed" } };
	// As main: the slot whose run was interrupted runs again at the next tick, with no wait, and the
	// third interruption in a row parks the job; the row leaves with it, and nothing goes to the inbox.
	const attempts = row.attempts + 1;
	if (attempts < DEAD_AFTER_ATTEMPTS) return { row: { do: "retry", attempts, why: INTERRUPTED, wait: false } };
	if (!job) return { row: { do: "dead", attempts, why: INTERRUPTED } };
	return {
		row: { do: "leave", exit: "parked" },
		job: { disabled: { code: "interrupted", at: end.at, why: `parked: its last ${attempts} runs were interrupted before they finished (the process running them stopped each time, with no other loop running; see host.log) — /cron enable ${job.id} to try again` } },
	};
}

export function oneShotDoneV3(job: Pick<LoopJob, "schedule">, status: { running?: unknown; queued?: unknown; runs: number; error?: { streak: number } }): boolean {
	return job.schedule.kind === "once" && !status.running && status.runs >= 1 && ((status.error?.streak ?? 0) >= 2 || !status.queued);
}
