/**
 * What a finished loop run writes into the conversation (docs/loops.md "Run cards"). A loop's first
 * three runs, every failed run and every run a person asked for get a compact card; every other run
 * is a line in the panel above the editor only. A run that was stopped is not a failure and gets no
 * card.
 */
import { screenText } from "./inbox-card.ts";
import { loopLabel } from "./job-lines.ts";
import { plural } from "./plural.ts";
import { previewRedacted } from "./redact.ts";
import type { RunRecord } from "./store.ts";

/** The runs of a loop that card in the conversation: enough to see that it works and what it reports. */
export const CARDED_FIRST_RUNS = 3;
/** Cards shown for one look at the run log; the rest of a burst is one line. */
export const CARDS_PER_TICK = 5;
/** Run log records a window reads at each look: the cards of a burst are placed from these, not from the last 20. */
export const FRESH_RUNS_READ = 500;
/** A run line's error, and a card's reply line, clipped so each stays one line. */
const ERROR_CHARS = 120;

export function runCardFor(r: Pick<RunRecord, "ok" | "ordinal" | "aborted" | "requestedBy">): "card" | "quiet" {
	if (r.aborted) return "quiet";
	if (!r.ok || r.requestedBy) return "card";
	return r.ordinal !== undefined && r.ordinal <= CARDED_FIRST_RUNS ? "card" : "quiet";
}

/**
 * The fresh runs whose card belongs to this conversation. A run a person asked for cards where they
 * asked, whichever loop or project it was; any other run cards in the conversation that created its
 * loop, and a loop nobody's conversation made (imported, made from a shell) in any window of its
 * project.
 */
export function runCardsHere<R extends Pick<RunRecord, "cwd" | "forSession" | "requestedBy">>(fresh: readonly R[], here: { sessionId: string | undefined; inProject: (cwd: string) => boolean }): R[] {
	return fresh.filter((r) => (r.requestedBy ? r.requestedBy.sessionId === here.sessionId : here.inProject(r.cwd) && (!r.forSession || r.forSession === here.sessionId)));
}

/** The lines under a card's title: for a run someone asked for that finished, the first line of its reply. */
export function runCardLines(r: Pick<RunRecord, "ok" | "requestedBy" | "summary">): string[] {
	if (!r.requestedBy || !r.ok || !r.summary) return [];
	const first = screenText(r.summary.split("\n").find((line) => line.trim()) ?? "").trim();
	return first ? [first.length > ERROR_CHARS ? `${first.slice(0, ERROR_CHARS - 1)}…` : first] : [];
}

/** One line for a run: the card's title, the panel's row and the burst line say it the same way. `name` is the loop's, when it has one. */
export function runLine(r: RunRecord, name?: string): string {
	const label = loopLabel({ id: r.jobId, name: name ?? r.jobName });
	const secs = Math.max(0, Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000)) || 0;
	if (r.aborted) return `${label} stopped · ${secs}s`;
	if (!r.ok) return `${label} FAILED · ${secs}s · ${previewRedacted(r.error ?? "unknown error", ERROR_CHARS)}`;
	const cost = r.usage?.cost ? ` · $${r.usage.cost.toFixed(3)}` : "";
	return `${label} · ${secs}s${cost} · ${plural(r.findings, "finding")}`;
}

/** The one line a burst's carded rest is folded into. */
export function burstLine(placed: { more: number; failed: number }): string {
	return `+${plural(placed.more, "more run")} finished${placed.failed ? ` (${placed.failed} failed)` : ""} — /cron runs`;
}

/** The carded runs of `fresh`, oldest first, at most `max`; `more` counts the carded rest and `failed` the failures among them. */
export function placeRunCards(fresh: readonly RunRecord[], max = CARDS_PER_TICK): { cards: RunRecord[]; more: number; failed: number } {
	const carded = fresh.filter((r) => runCardFor(r) === "card").sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));
	const rest = carded.slice(max);
	return { cards: carded.slice(0, max), more: rest.length, failed: rest.filter((r) => !r.ok).length };
}

/**
 * Where a finished run's card goes. A window that holds its conversation saves the card in it, a
 * terminal and the page's pi alike (pi writes the entry, and the page draws it as it lands and when
 * it reads the conversation again); a terminal also says a failure, for when the card has scrolled
 * by. The page draws a notice as a line of the conversation, so there a notice would be the card
 * twice. A window that does not hold the conversation, or has nowhere to save it, only says it.
 */
export function runCardDelivery(r: Pick<RunRecord, "ok" | "ordinal" | "aborted" | "requestedBy">, where: { mode: string; mayAppend: boolean }): { save: boolean; notify?: "info" | "warning" } {
	if (runCardFor(r) !== "card") return { save: false };
	if (where.mayAppend && where.mode === "tui") return r.ok ? { save: true } : { save: true, notify: "warning" };
	if (where.mayAppend && where.mode === "rpc") return { save: true };
	return { save: false, notify: r.ok ? "info" : "warning" };
}

/** The runs the panel above the editor lists: the project's latest loop runs, and one more so it can say there are others. A plain job's turn and a `/goal` evaluator's are not loop runs. */
export function panelRuns(all: readonly RunRecord[], inProject: (cwd: string) => boolean, limit: number): RunRecord[] {
	return all.filter((r) => r.stateful && inProject(r.cwd)).slice(-(limit + 1));
}

/**
 * The loop runs a window has not carded yet: those that finished after `after`, the stamp of the
 * last look, and the stamp to look after next time (the latest of theirs, else `after`). Times are
 * compared as instants: a record written in another offset (UTC, or either side of a
 * daylight-saving change) sorts wrongly as text, and was carded again on every restart. A record
 * whose time does not parse is skipped.
 */
export function freshRuns<R extends Pick<RunRecord, "stateful" | "finishedAt">>(records: readonly R[], after: string): { fresh: R[]; cursor: string } {
	let cursor = after;
	let latest = Date.parse(after);
	const fresh = records.filter((r) => {
		const at = Date.parse(r.finishedAt);
		if (!r.stateful || !Number.isFinite(at) || !(at > Date.parse(after))) return false;
		if (!(at <= latest)) {
			latest = at;
			cursor = r.finishedAt;
		}
		return true;
	});
	return { fresh, cursor };
}
