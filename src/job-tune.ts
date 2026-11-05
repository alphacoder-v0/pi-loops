/**
 * What the page suggests for a loop, as a function: at most one change, decided from the loop's
 * signal (src/job-signal.ts), never applied by itself.
 *
 * Two kinds. A loop that has found nothing in its last `QUIET_SUGGEST_AFTER` runs and runs more
 * often than hourly is offered "Run hourly instead"; one whose recent findings were all dismissed
 * and none claimed is offered "Pause". A quiet hourly or daily loop gets nothing: quiet is not a
 * fault (docs/loops.md, "Was it worth running").
 *
 * The key names the loop, the kind and the schedule it was computed under. The page posts only the
 * key back; the server computes the suggestion again and refuses a key that no longer matches, so
 * a page can never ask for a change the server would not suggest. Keep records the key on the job
 * (`tuneKept`): the same suggestion is not offered again, and a schedule change makes a new key.
 */
import { applyJobEdit, type JobEditContext, type NextRun } from "./job-edit.ts";
import type { LoopSignal } from "./job-signal.ts";
import { computeNext, formatSchedule, type Schedule } from "./schedule.ts";
import type { LoopJob } from "./store.ts";

/** "Run hourly instead" from this many empty runs in a row. */
export const QUIET_SUGGEST_AFTER = 12;
/** "Pause" when the window has at least this many findings and this many dismissed, and none claimed. */
export const PAUSE_FINDINGS = 5;
export const PAUSE_DISMISSED = 5;
const HOUR_MS = 3_600_000;

export type TuneKind = "slower" | "pause";

export interface Suggestion {
	kind: TuneKind;
	key: string;
	label: "Run hourly instead" | "Pause";
}

/** The numbers a loop row shows: `30d: 6 findings · 0 claimed · 6 dismissed · quiet ×12`. */
export interface RowSignal {
	findings30d: number;
	claimed30d: number;
	dismissed30d: number;
	quietStreak: number;
}

export function rowSignal(s: LoopSignal): RowSignal {
	return { findings30d: s.findings, claimed30d: s.claimed, dismissed30d: s.dismissed, quietStreak: s.quiet };
}

/** How long the schedule waits between two runs from `now`; undefined when it has no two. */
function periodMs(schedule: Schedule, createdAt: number, now: number): number | undefined {
	if (schedule.kind === "every") return schedule.ms;
	if (schedule.kind !== "cron") return undefined;
	const first = computeNext({ schedule, createdAt }, now);
	const second = first === undefined ? undefined : computeNext({ schedule, createdAt }, first);
	return first === undefined || second === undefined ? undefined : second - first;
}

/** The hourly schedule of the same kind: `every 1h`, or the top of every hour. */
function hourly(schedule: Schedule): Schedule {
	return schedule.kind === "every" ? { kind: "every", ms: HOUR_MS } : { kind: "cron", expr: "0 * * * *" };
}

/** At most one suggestion for `job`, or none. */
export function suggestTune(job: LoopJob, s: LoopSignal, now: number): Suggestion | undefined {
	if (!job.enabled || !job.stateful || job.schedule.kind === "once" || job.running) return undefined;
	const at = `${job.id}:${formatSchedule(job.schedule)}`;
	let suggestion: Suggestion | undefined;
	if (s.findings >= PAUSE_FINDINGS && s.claimed === 0 && s.dismissed >= PAUSE_DISMISSED) suggestion = { kind: "pause", key: `pause:${at}`, label: "Pause" };
	else if (s.quiet >= QUIET_SUGGEST_AFTER) {
		const period = periodMs(job.schedule, Date.parse(job.createdAt), now);
		if (period !== undefined && period < HOUR_MS) suggestion = { kind: "slower", key: `slower:${at}`, label: "Run hourly instead" };
	}
	return suggestion && job.tuneKept === suggestion.key ? undefined : suggestion;
}

export interface AppliedTune {
	/** Exactly the fields to write, under the store's lock. */
	patch: Partial<LoopJob>;
	/** The `cron_control_plane` state: a schedule change is `set`, a pause is `disable`. */
	op: "set" | "disable";
	changed: string[];
	nextRun: NextRun;
}

/** Apply `suggestion` to `job`, through `applyJobEdit` for a schedule. */
export function applyTune(job: LoopJob, suggestion: Suggestion, ctx: JobEditContext): AppliedTune {
	if (suggestion.kind === "pause") return { patch: { enabled: false, tuneKept: undefined }, op: "disable", changed: ["paused from the page"], nextRun: { kind: "disabled" } };
	const edit = applyJobEdit(job, { schedule: hourly(job.schedule) }, ctx);
	return { patch: { ...edit.patch, tuneKept: undefined }, op: "set", changed: edit.changed, nextRun: edit.nextRun };
}
