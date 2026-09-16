/**
 * What a loop's runs came to: findings filed, and what a person did with them.
 *
 * `/cron cost` has always said what a loop spends; nothing said whether anyone wanted what it
 * bought. A loop whose every finding is dismissed is noise at whatever price, and a loop that has
 * found nothing for a month is either watching a quiet thing or watching the wrong one. Both are
 * questions about the run log and the inbox together, answerable without a scheduler or a clock —
 * the shape of `job-health.ts`, for the other half of "is this loop worth keeping".
 */
import type { InboxEntry } from "./inbox.ts";
import type { RunRecord } from "./store.ts";

export interface LoopSignal {
	/** Runs that finished in the window (failed ones included: they cost, and they are what `quiet` is measured against). */
	runs: number;
	/** Findings that reached the inbox in the window, from the run log. */
	findings: number;
	/** Of the findings the inbox still holds from this window: claimed, dismissed, and dismissed with a reason. */
	claimed: number;
	dismissed: number;
	dismissedWithReason: number;
	/** Consecutive finished runs, newest backwards over the whole log, that found nothing. Not bounded by the window. */
	quiet: number;
}

/** How long the `/cron` listing looks back. Long enough for a weekly loop to have a few runs in it. */
export const SIGNAL_WINDOW_MS = 30 * 86_400_000;
/** From here `/cron` marks a loop `quiet ×N`: three empty runs is where a loop stops looking merely between events. */
export const QUIET_MARK_AFTER = 3;

/**
 * `runs` is the run log, any order; `inbox` the whole inbox. Both are filtered here so a caller can
 * hand over what it already loaded. `sinceMs` bounds the counts; `quiet` is counted from the newest
 * run backwards regardless of it, because a streak is a streak whenever it started.
 */
export function loopSignal(jobId: string, runs: RunRecord[], inbox: InboxEntry[], sinceMs: number): LoopSignal {
	const own = runs.filter((r) => r.jobId === jobId);
	const at = (iso: string) => Date.parse(iso);
	const inWindow = own.filter((r) => {
		const t = at(r.finishedAt || r.startedAt);
		return Number.isFinite(t) && t >= sinceMs;
	});
	const findings = inWindow.reduce((n, r) => n + (r.findings ?? 0), 0);
	let claimed = 0;
	let dismissed = 0;
	let dismissedWithReason = 0;
	for (const e of inbox) {
		if (e.job_id !== jobId) continue;
		const t = at(e.created_at);
		if (!Number.isFinite(t) || t < sinceMs) continue;
		if (e.status === "claimed") claimed++;
		else if (e.status === "dismissed") {
			dismissed++;
			if (e.dismiss_reason) dismissedWithReason++;
		}
	}
	// The log is appended in finishing order, so the tail is the newest; sort anyway in case a
	// caller merged two sources. A run that failed found nothing, and counts toward the streak:
	// a loop that has been erroring for a week is quiet in the sense that matters here too, and
	// `job-health.ts` already says why.
	const ordered = [...own].sort((a, b) => at(a.finishedAt || a.startedAt) - at(b.finishedAt || b.startedAt));
	let quiet = 0;
	for (let i = ordered.length - 1; i >= 0 && (ordered[i].findings ?? 0) === 0; i--) quiet++;
	return { runs: inWindow.length, findings, claimed, dismissed, dismissedWithReason, quiet };
}

/**
 * `9 findings · 2 claimed · 7 dismissed` — the counts a person reads a loop's worth off. Nothing
 * when no finding was filed: a loop that found nothing has nothing to be judged by yet, and
 * `quiet ×N` says that part.
 */
export function signalSummary(s: LoopSignal): string | undefined {
	if (!s.findings) return undefined;
	const parts = [`${s.findings} finding${s.findings === 1 ? "" : "s"}`];
	if (s.claimed) parts.push(`${s.claimed} claimed`);
	if (s.dismissed) parts.push(`${s.dismissed} dismissed${s.dismissedWithReason ? ` (${s.dismissedWithReason} with a reason)` : ""}`);
	return parts.join(" · ");
}
