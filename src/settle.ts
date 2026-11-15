/**
 * How the turn of a plain job ends: what becomes of its row and of its job. One table, read by
 * whoever closes a run: the process that ran it, and a later drain that finds its process gone.
 * Pure, and a leaf: it imports types only.
 */
import type { LoopJob, RunRecord } from "./store.ts";

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

/**
 * What `settle` decides. `row` has one discriminant, so a result cannot both leave the row and
 * keep it, and only a row that leaves as `delivered` can have a successor.
 */
export interface Settlement {
	readonly row:
		/** The prompt is in the conversation. `successor`: one more row asks again. */
		| { readonly do: "leave"; readonly exit: "delivered"; readonly successor?: true }
		/** A person stopped the run before the prompt was written. The slot is spent. */
		| { readonly do: "leave"; readonly exit: "stopped" }
		/** The claim is cleared and no attempt is counted. The row is the owed slot. */
		| { readonly do: "owed" }
		/** The claim is cleared, an attempt is counted, and the row backs off. */
		| { readonly do: "retry"; readonly why: string };
	/**
	 * The job's fields to write with `Object.assign` inside `JobStore.update`. A key whose value is
	 * undefined clears its field. Absent: nothing to write. Every patch sets `lastCompletedAt` to
	 * `end.at`, and a job that carries that stamp gets no patch, so a patch is applied once per record.
	 */
	readonly job?: Partial<Pick<LoopJob, "lastCompletedAt" | "lastError" | "consecutiveFailures" | "interruptions">>;
}

/** The job fields a cell writes. `none` writes nothing. */
type JobCell =
	/** `lastCompletedAt = end.at`, `consecutiveFailures` and `interruptions` cleared, `lastError` cleared when the job is enabled. */
	| "success"
	/** `lastCompletedAt = end.at`, `consecutiveFailures + 1`, `lastError = end.error`, `interruptions` cleared. A one-shot's first failure adds " (one-shot: retrying once)". */
	| "failure"
	/** `lastCompletedAt = end.at`, `interruptions` cleared. A stop is no failure: the streak and the last error are not written. */
	| "stop"
	| "none";

type Cell =
	/** `one-shot-retry`: a successor only for a one-shot whose failures after this one are under two. */
	| { readonly row: "delivered"; readonly job: JobCell; readonly successor: "never" | "always" | "one-shot-retry" }
	| { readonly row: "stopped" | "owed"; readonly job: JobCell }
	| { readonly row: "retry"; readonly job: JobCell; readonly why: "the run's error" | "its prompt is not in the conversation" | "the process running it stopped" };

/**
 * The table. The compiler checks that every cell is there. `settle` is this lookup plus the two
 * things a cell cannot say alone: the failure count after the patch, and whether the patch was
 * applied already. One-shot or not changes one cell (`failed` and `written`), and `oneShotDone`.
 */
const CELLS: Record<RunEnd["how"], Record<"written" | "unwritten", Cell>> = {
	succeeded: {
		written: { row: "delivered", job: "success", successor: "never" },
		// The runner said ok and the prompt is not in the conversation: not delivered, so tried again.
		unwritten: { row: "retry", job: "success", why: "its prompt is not in the conversation" },
	},
	failed: {
		// A failed turn spends its slot. Only a one-shot is asked again, once.
		written: { row: "delivered", job: "failure", successor: "one-shot-retry" },
		// The hand-over failed. The row itself is the retry.
		unwritten: { row: "retry", job: "failure", why: "the run's error" },
	},
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
		written: { row: "delivered", job: "none", successor: "never" },
		unwritten: { row: "retry", job: "none", why: "the process running it stopped" },
	},
};

/**
 * How a plain job's turn ends. Pure: no clock, no file. `job` is the job the turn's row names, as
 * it is in `jobs.json` now (the caller is inside `JobStore.update`), or undefined when it was
 * removed. `written` says the row's prompt is in the conversation, or, in a lane that is not a
 * conversation, that the run ended.
 *
 * The row's result depends on `end.how` and `written` only, but for `successor`, which needs the
 * job. Settling one record twice changes nothing the second time: no patch, and the same row.
 * `runCount`, `lastDueAt`, `lastFiredAt` and `owedSlot` are never in the patch: the clock counts
 * a slot when it writes the row.
 */
export function settle(job: Pick<LoopJob, "schedule" | "enabled" | "lastCompletedAt" | "consecutiveFailures"> | undefined, end: RunEnd, written: boolean): Settlement {
	const cell = CELLS[end.how][written ? "written" : "unwritten"];
	const applied = job !== undefined && job.lastCompletedAt === end.at;
	const failures = (job?.consecutiveFailures ?? 0) + (cell.job === "failure" && !applied ? 1 : 0);
	const retryOnce = job?.schedule.kind === "once" && cell.job === "failure" && failures < 2;
	let patch: Settlement["job"];
	if (job && !applied) {
		if (cell.job === "success") {
			patch = { lastCompletedAt: end.at, consecutiveFailures: undefined, interruptions: undefined };
			if (job.enabled) patch.lastError = undefined;
		} else if (cell.job === "failure" && end.how === "failed") {
			patch = {
				lastCompletedAt: end.at,
				consecutiveFailures: failures,
				interruptions: undefined,
				lastError: retryOnce ? `${end.error} (one-shot: retrying once)` : end.error,
			};
		} else if (cell.job === "stop") {
			patch = { lastCompletedAt: end.at, interruptions: undefined };
		}
	}
	let row: Settlement["row"];
	if (cell.row === "delivered") {
		const successor = job !== undefined && (cell.successor === "always" || (cell.successor === "one-shot-retry" && retryOnce));
		row = successor ? { do: "leave", exit: "delivered", successor: true } : { do: "leave", exit: "delivered" };
	} else if (cell.row === "retry") {
		row = { do: "retry", why: cell.why === "the run's error" && end.how === "failed" ? end.error : cell.why };
	} else {
		row = cell.row === "stopped" ? { do: "leave", exit: "stopped" } : { do: "owed" };
	}
	return patch === undefined ? { row } : { row, job: patch };
}

/**
 * The one-shot rule. A plain one-shot is done when its slot was counted (`runCount >= 1`) and
 * either none of its rows is queued (`queued` is false: the prompt ran, was stopped, or died) or
 * it failed twice. Derived from the job and the queue, so a process that stops anywhere in the
 * end of a turn loses no retirement: the next tick asks again. With `settle`: a success or a stop
 * leaves no row; the first failure leaves a successor or the row itself; a hand-back leaves a
 * successor or the owed row.
 */
export function oneShotDone(job: Pick<LoopJob, "stateful" | "schedule" | "runCount" | "running" | "consecutiveFailures">, queued: boolean): boolean {
	return !job.stateful && job.schedule.kind === "once" && !job.running && job.runCount >= 1
		&& ((job.consecutiveFailures ?? 0) >= 2 || !queued);
}
