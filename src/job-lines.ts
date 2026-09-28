/**
 * The `/cron` listing, as lines.
 *
 * It lives here rather than in `src/pi-loops.ts` — the extension's default export, which nothing can
 * import — because docs/loops.md states these markers and columns as the behaviour, and until this
 * was importable no test could see one go. Everything it reads is a parameter, so a test can hand it
 * a job, a run log and an inbox and read the lines a person reads.
 */
import type { InboxEntry } from "./inbox.ts";
import { asleepNote, runsIn } from "./job-owner.ts";
import { QUIET_MARK_AFTER, SIGNAL_WINDOW_MS, loopSignal, signalSummary } from "./job-signal.ts";
import { previewRedacted } from "./redact.ts";
import { computeNext, formatLocal, formatSchedule } from "./schedule.ts";
import type { LoopJob, RunRecord } from "./store.ts";

export interface JobLinesInput {
	/** The whole run log, read once by the caller; only this listing's loops are filtered out of it. */
	runs: RunRecord[];
	/** The whole inbox, read once by the caller. */
	inbox: InboxEntry[];
	/** The session reading the list: a plain job of another session has no next run where it is. */
	sessionId?: string;
	now: number;
	/** `$HOME`, for `~` shortening; passed rather than read so a test's paths are its own. */
	home: string;
	/** Injected because the answer decides `[orphan: cwd missing]`, and a test should not make directories. */
	cwdExists: (cwd: string) => boolean;
}

/** The caller's `homeRel`, with `home` passed in: this module has no `process.env`. */
const homeRel = (p: string, home: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);

export function jobLines(jobs: LoopJob[], opts: JobLinesInput): string[] {
	const { runs, inbox, sessionId, now, home, cwdExists } = opts;
	return jobs
		.map((job, i) => {
			// A next run is shown where it will happen: a plain job of a session not open here has none.
			const next =
				job.enabled && runsIn(job, sessionId)
					? computeNext(
							{
								schedule: job.schedule,
								createdAt: Date.parse(job.createdAt),
								lastFiredAt: job.lastFiredAt ? Date.parse(job.lastFiredAt) : undefined,
							},
							now,
						)
					: undefined;
			const asleepMark = asleepNote(job, sessionId);
			const dormant = asleepMark ? `[${asleepMark}]` : undefined;
			const orphan = job.stateful && !cwdExists(job.cwd) ? "[orphan: cwd missing]" : undefined;
			// What the loop's runs came to (src/job-signal.ts): `quiet ×N` in the marks once N empty
			// runs are the newest, and the findings line — filed, claimed, dismissed — over 30 days.
			// A loop was, until now, judged by whether it ran; this is whether it was worth running.
			const signal = job.stateful ? loopSignal(job.id, runs, inbox, now - SIGNAL_WINDOW_MS) : undefined;
			const quiet = signal && signal.quiet >= QUIET_MARK_AFTER ? `[quiet ×${signal.quiet}]` : undefined;
			const marks = [job.stateful ? "[stateful]" : undefined, job.verify ? "[verify]" : undefined, dormant, orphan, quiet, job.running ? `running ${job.running.runId}` : undefined, job.catchUp ? undefined : "[no-catchup]"]
				.filter(Boolean)
				.join("  ");
			const head = `${String(i + 1).padStart(2)}. ${job.id}${job.name ? ` "${job.name}"` : ""}  ${job.enabled ? "enabled" : "disabled"}  ${formatSchedule(job.schedule)}${marks ? `  ${marks}` : ""}`;
			const action = `    action: ${previewRedacted(job.prompt, 120)}`;
			const worth = signal ? signalSummary(signal) : undefined;
			const meta = `    next ${next ? formatLocal(next) : "—"} · runs ${job.runCount}${job.skippedOverlap ? ` · skipped overlaps ${job.skippedOverlap}` : ""}${worth ? ` · 30d: ${worth}` : ""} · ${homeRel(job.cwd, home)}`;
			const err = job.lastError ? `    last error: ${previewRedacted(job.lastError, 100)}` : job.lastFiredAt ? `    last fired: ${job.lastFiredAt}` : undefined;
			return [head, action, meta, err].filter((l): l is string => !!l);
		})
		.flat();
}
