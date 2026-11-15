/**
 * How the turn of a plain job ends: what becomes of its row and of its job. One table, read by
 * whoever closes a run: the process that ran it, and a later drain that finds its process gone.
 * Pure, and a leaf: it imports types only.
 */
import type { LoopJob, RunRecord } from "./store.ts";

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
	 * The job's fields to write with `Object.assign` inside `JobStore.update`. A key whose value is
	 * undefined clears its field. Absent: nothing to write. Every patch sets `lastCompletedAt` to
	 * `end.at`, and a job whose `lastCompletedAt` is that stamp or a later one gets no patch. So a
	 * record is never counted twice, also when a closing runs again after another row's closing
	 * came between. The cost: when a process stops in the middle of two closings of one job, the
	 * older record's count can be lost.
	 */
	readonly job?: Partial<Pick<LoopJob, "lastCompletedAt" | "lastError" | "consecutiveFailures" | "interruptions" | "enabled">>;
}

/** The job fields a cell writes. `none` writes nothing. */
type JobCell =
	/** `lastCompletedAt = end.at`, `consecutiveFailures` and `interruptions` cleared, `lastError` cleared when the job is enabled. */
	| "success"
	/** `lastCompletedAt = end.at`, `consecutiveFailures + 1`, `lastError = end.error`, `interruptions` cleared. A one-shot's first failure adds " (one-shot: retrying once)". */
	| "failure"
	/** `lastCompletedAt = end.at`, `interruptions` cleared. A stop is no failure: the streak and the last error are not written. */
	| "stop"
	/** `lastCompletedAt = end.at`, `interruptions + 1`; at `INTERRUPTIONS_BEFORE_PARKING` the job is turned off and says why. */
	| "interruption"
	| "none";

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
 * it is in `jobs.json` now (the caller is inside `JobStore.update`), or undefined when it was
 * removed. `written` says the row's prompt is in the conversation.
 *
 * The row's result depends on `end.how` and `written` only, but for `successor`, which needs the
 * job. Settling one record twice changes nothing the second time: no patch, and the same row.
 * A record older than the last one that was settled changes nothing either.
 * `runCount`, `lastDueAt`, `lastFiredAt` and `owedSlot` are never in the patch: the clock counts
 * a slot when it writes the row.
 */
export function settle(job: Pick<LoopJob, "id" | "name" | "schedule" | "enabled" | "lastCompletedAt" | "consecutiveFailures" | "interruptions"> | undefined, end: RunEnd, written: boolean): Settlement {
	const cell = CELLS[end.how][written ? "written" : "unwritten"];
	// Settled already: this record, or a later one. Stamps are compared as times; each carries its writer's offset.
	const applied = job !== undefined && job.lastCompletedAt !== undefined && Date.parse(job.lastCompletedAt) >= Date.parse(end.at);
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
		} else if (cell.job === "interruption") {
			const interruptions = (job.interruptions ?? 0) + 1;
			patch = { lastCompletedAt: end.at, interruptions };
			// Turned off rather than run again at every start: each time, the process stopped while this
			// job's turn was running. Still not proof (a reboot in the middle of a turn counts too), so
			// the reason says what is known, and enabling the job again tries once more.
			if (interruptions >= INTERRUPTIONS_BEFORE_PARKING) {
				patch.enabled = false;
				patch.lastError = `parked: its last ${interruptions} runs were interrupted before they finished (the process running them stopped each time; see host.log) — /cron enable ${job.name ?? job.id} to try again`;
			}
		}
	}
	let row: Settlement["row"];
	if (cell.row === "delivered") {
		const successor = job !== undefined && (cell.successor === "always" || (cell.successor === "one-shot-retry" && retryOnce));
		row = successor ? { do: "leave", exit: "delivered", successor: true } : { do: "leave", exit: "delivered" };
	} else if (cell.row === "retry") {
		row = { do: "retry", why: INTERRUPTED };
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
 * leaves no row; the first failure leaves a successor; a hand-back leaves a successor or the owed
 * row.
 */
export function oneShotDone(job: Pick<LoopJob, "stateful" | "schedule" | "runCount" | "running" | "consecutiveFailures">, queued: boolean): boolean {
	return !job.stateful && job.schedule.kind === "once" && !job.running && job.runCount >= 1
		&& ((job.consecutiveFailures ?? 0) >= 2 || !queued);
}
