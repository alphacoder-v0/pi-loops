/**
 * Where a job runs, as one question the scheduler, the lists and `/cron run` all ask the same way.
 *
 * A stateful loop belongs to the machine: the host runs it. A plain job
 * belongs to the session that created it — its result is a message in that conversation, so it
 * fires in the instance holding that session's lease (src/lease.ts), and in the host while no window
 * holds it. Another window on the same session is a viewer and fires nothing. A session the host
 * cannot hold (a file pi-loops never saw) is asleep; it is not broken, and
 * nothing here promises it a next run it will not get.
 */
import { shortSessionId } from "./session-head.ts";
import type { LoopJob } from "./store.ts";

/** What the instance asking knows about sessions. */
export interface OwnerView {
	/** The session this instance has open. */
	sessionId?: string;
	/** Whether it holds that session's lease. A second window on the same conversation does not. */
	holdsOwn: boolean;
	/** The pid of the live holder of a session's lease, when there is one. */
	holderOf?: (sessionId: string) => number | undefined;
	/** It holds that session's lease but stands aside: its copy of the conversation is behind the file (src/lease.ts). */
	standsAside?: boolean;
	/**
	 * Why no host will run anything right now, when that is so: stopped by hand, `[host] auto = false`,
	 * `PI_LOOPS_HOST=off`, paused after crashes. Every loop, and every plain job only the host would
	 * fire, is then paused: no next run is promised for a run that will not happen.
	 */
	hostPaused?: string;
	/** The kind of that live holder: the host holding a conversation is running a turn in it; `page` is the page's pi. */
	holderKind?: (sessionId: string) => "terminal" | "page" | "host" | undefined;
	/** Whether the host fires a closed session's plain jobs: it is running and knows the session's file. */
	hostRuns?: (sessionId: string) => boolean;
}

/** `terminal` is any window that holds the conversation; `page` says it is the page's pi. */
export type Where = { kind: "machine" } | { kind: "here" } | { kind: "aside"; pid: number } | { kind: "terminal"; pid: number; page?: true } | { kind: "host" } | { kind: "paused"; reason: string } | { kind: "asleep" };

type Owned = Pick<LoopJob, "stateful" | "sessionId">;

export function whereRuns(job: Owned, view: OwnerView): Where {
	if (job.stateful) return view.hostPaused ? { kind: "paused", reason: view.hostPaused } : { kind: "machine" };
	if (!job.sessionId) return { kind: "asleep" };
	if (job.sessionId === view.sessionId && view.holdsOwn) return { kind: "here" };
	const pid = view.holderOf?.(job.sessionId);
	const holder = pid === undefined ? undefined : view.holderKind?.(job.sessionId);
	if (pid !== undefined && holder === "host") return { kind: "host" };
	if (pid !== undefined && job.sessionId === view.sessionId && view.standsAside) return { kind: "aside", pid };
	if (pid !== undefined) return holder === "page" ? { kind: "terminal", pid, page: true } : { kind: "terminal", pid };
	if (!view.hostRuns?.(job.sessionId)) return { kind: "asleep" };
	return view.hostPaused ? { kind: "paused", reason: view.hostPaused } : { kind: "host" };
}

/** Would this instance dispatch the job? (Only the host's scheduler is given loops.) */
export function runsHere(job: Owned, view: OwnerView): boolean {
	const where = whereRuns(job, view).kind;
	return where === "machine" || where === "here";
}

/** Whether the job has a next run anywhere: a list shows it, wherever that is. */
export function runsSomewhere(job: Owned, view: OwnerView): boolean {
	const kind = whereRuns(job, view).kind;
	return kind !== "asleep" && kind !== "paused";
}

/** The short form of the session a plain job belongs to. */
export function ownerSession(job: Owned): string | undefined {
	return job.stateful ? undefined : shortSessionId(job.sessionId ?? "?");
}

/** Where a conversation is open, in the words every list and notice uses: never a pid. */
export function openWhere(holder: "terminal" | "page" | "host" | undefined): string {
	if (holder === "page") return "in the page";
	if (holder === "host") return "in the background";
	return "open in a terminal";
}

/**
 * The mark a list shows for a plain job that will not run here — worded as what to do, because
 * "not open here" was read as an error. Undefined when the job runs here.
 */
export function asleepNote(job: Owned, view: OwnerView): string | undefined {
	const where = whereRuns(job, view);
	if (where.kind === "terminal") return `session ${ownerSession(job)} — ${openWhere(where.page ? "page" : "terminal")}`;
	if (where.kind === "aside") return `session ${ownerSession(job)} — this window shows an older copy; /resume it to run here`;
	if (where.kind === "host") return `session ${ownerSession(job)} — ${openWhere("host")}`;
	if (where.kind === "paused") return job.stateful ? `paused: ${where.reason}` : `session ${ownerSession(job)} — paused: ${where.reason}`;
	if (where.kind === "asleep") return `session ${ownerSession(job)} — resume it to run`;
	return undefined;
}
