/** The waits after a failure of a queued row, a loop or a rule check: one table for the three. */
export const BACKOFF_MS: readonly number[] = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];

/** The wait after the n-th failure in a row, n >= 1. Past the table it stays at the last step. */
export function backoffFor(n: number): number {
	return BACKOFF_MS[Math.min(Math.max(n, 1), BACKOFF_MS.length) - 1];
}

/** Failures in a row at which a loop or a rule check counts as failing, and starts to wait. */
export const FAILING_AFTER = 3;

/** How long a loop or a check with `streak` failures in a row waits after its last failure: nothing below FAILING_AFTER, then the table from its first step. */
export function failurePause(streak: number): number {
	return streak < FAILING_AFTER ? 0 : backoffFor(streak - FAILING_AFTER + 1);
}
