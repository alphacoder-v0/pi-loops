/**
 * Which loops have stopped working, and the one line that says so.
 *
 * `consecutiveFailures` drives the scheduler's backoff and nothing else reads it, so a loop that has
 * failed forty nights in a row looks exactly like a healthy one until someone types `/cron`. This is
 * what the badge, the session-start line and `/cron` print instead — a question about a list of jobs,
 * answerable without a scheduler, a session or a clock.
 */
import { FAILURE_BACKOFF_AFTER } from "./scheduler.ts";
import type { LoopJob } from "./store.ts";

/**
 * Jobs failing on `hostName`, worst first. The threshold is the scheduler's backoff threshold, which
 * is the honest place to draw the line: below it a failure is a bad night, at it the scheduler has
 * already started widening the gap. A job pinned to another host (a shared $HOME) is that host's to
 * report, not ours.
 */
export function failingJobs(jobs: LoopJob[], hostName: string): LoopJob[] {
	return jobs.filter((j) => j.enabled && (!j.host || j.host === hostName) && (j.consecutiveFailures ?? 0) >= FAILURE_BACKOFF_AFTER).sort((a, b) => (b.consecutiveFailures ?? 0) - (a.consecutiveFailures ?? 0));
}

/** `2 job(s) failing (check-issues ×7)` — one clause, the worst one named, whatever the count. */
export function failingSummary(jobs: LoopJob[], hostName: string): string | undefined {
	const failing = failingJobs(jobs, hostName);
	const worst = failing[0];
	if (!worst) return undefined;
	const label = worst.name ?? worst.id;
	return `${failing.length} job(s) failing (${label.length > 24 ? `${label.slice(0, 23)}…` : label} ×${worst.consecutiveFailures})`;
}
