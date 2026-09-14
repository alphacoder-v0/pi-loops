/**
 * Where a job runs, as one question the scheduler, the lists and `/cron run` all ask the same way.
 *
 * A stateful loop belongs to the machine: whichever process holds the clock runs it. A plain job
 * belongs to the session that created it — its result is a message in that conversation, so it
 * fires only in the process holding that session. Another session sees it, and sees that it is
 * asleep; it is not broken, and nothing here promises it a next run it will not get.
 */
import type { LoopJob } from "./store.ts";

/** Would the process holding `sessionId` dispatch this job? (For a loop, only if it is also the leader.) */
export function runsIn(job: Pick<LoopJob, "stateful" | "sessionId">, sessionId: string | undefined): boolean {
	if (job.stateful) return true;
	return !!sessionId && job.sessionId === sessionId;
}

/** The short form of the session a plain job belongs to. */
export function ownerSession(job: Pick<LoopJob, "stateful" | "sessionId">): string | undefined {
	return job.stateful ? undefined : (job.sessionId ?? "?").slice(0, 8);
}

/**
 * The line a list shows for a plain job that will not run here — worded as what to do, because
 * "not open here" was read as an error. Undefined when the job runs here.
 */
export function asleepNote(job: Pick<LoopJob, "stateful" | "sessionId">, sessionId: string | undefined): string | undefined {
	if (runsIn(job, sessionId)) return undefined;
	return `session ${ownerSession(job)} — resume it to run`;
}
