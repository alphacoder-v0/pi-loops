/**
 * Which loops have stopped working, and the one line that says so.
 *
 * A loop's failures in a row (`status.streak`) drive its backoff and nothing else reads them, so a loop that has
 * failed forty nights in a row looks exactly like a healthy one until someone types `/cron`. This is
 * what the badge, the session-start line and `/cron` print instead — a question about a list of jobs,
 * answerable without a scheduler, a session or a clock.
 */
import { FAILING_AFTER } from "./backoff.ts";
import type { ListedJob } from "./job-status.ts";
import type { DynamicTriggerRule } from "./triggers.ts";

/**
 * Jobs failing, worst first. The threshold is the scheduler's backoff threshold, which
 * is the honest place to draw the line: below it a failure is a bad night, at it the scheduler has
 * already started widening the gap.
 */
export function failingJobs(jobs: readonly ListedJob[]): ListedJob[] {
	return jobs.filter((j) => j.enabled && j.status.streak >= FAILING_AFTER).sort((a, b) => b.status.streak - a.status.streak);
}

/** `2 loops failing (check-issues ×7)` — one clause, the worst one named, whatever the count. */
export function failingSummary(jobs: readonly ListedJob[]): string | undefined {
	const failing = failingJobs(jobs);
	const worst = failing[0];
	if (!worst) return undefined;
	const label = worst.name ?? worst.id;
	return `${failing.length} ${failing.length === 1 ? "loop" : "loops"} failing (${label.length > 24 ? `${label.slice(0, 23)}…` : label} ×${worst.status.streak})`;
}

/**
 * `[failing ×N]` for a rule whose checks have failed often enough that the runtime polls it with a
 * widening gap, or undefined. The threshold is the runtime's own, so the listing and the poll cannot
 * disagree; a disabled rule is not polled, so it is not marked, as `failingJobs` skips a disabled job.
 */
export function ruleFailureMark(rule: Pick<DynamicTriggerRule, "enabled" | "consecutiveFailures">): string | undefined {
	const n = rule.consecutiveFailures ?? 0;
	return rule.enabled && n >= FAILING_AFTER ? `[failing ×${n}]` : undefined;
}
