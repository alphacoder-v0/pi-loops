/**
 * What `/cron set` decides, as a function instead of a closure.
 *
 * The command handler lives inside the extension's default export, where nothing can import it, so
 * everything it decided was covered by reading rather than by tests — and what it decides is not
 * obvious: which stamp to anchor when a schedule changes, whether the job is now due at once,
 * whether an expression that parses will ever match. This module holds those decisions; the
 * handler is left with reading arguments, writing the store and printing.
 *
 * It returns a *patch*, not a whole job, on purpose. `JobStore.update` re-reads the job under a
 * lock, so a tick that started a run between the read and the write has already set `running` —
 * assigning a whole job built from a stale copy would erase it.
 */
import { computeDue, computeNext, formatSchedule, type Schedule } from "./schedule.ts";
import type { LoopJob } from "./store.ts";

export interface JobEdit {
	model?: string | null;
	thinking?: string | null;
	timeoutMs?: number | null;
	name?: string | null;
	/** "here" pins the job to this machine; null lets any machine run it. */
	host?: string | null;
	prompt?: string;
	schedule?: Schedule;
}

/** When the job runs next, for the confirmation. `due` means the next tick will fire it. */
export type NextRun = { kind: "disabled" } | { kind: "due" } | { kind: "at"; at: number } | { kind: "none" };

export interface AppliedJobEdit {
	/** Exactly the fields to write. Anything absent must keep whatever the store has. */
	patch: Partial<LoopJob>;
	/** One line per field a person would not otherwise be able to recover, for the log. */
	changed: string[];
	nextRun: NextRun;
}

export interface JobEditContext {
	now: number;
	hostName: string;
	maxPromptBytes: number;
	/** Called with the requested name and the other jobs; throws if it is not usable as a reference. */
	checkName: (name: string, others: LoopJob[]) => void;
	/** Every other job, for the name check. The job being edited must not be in here. */
	others: LoopJob[];
}

/**
 * Apply `edit` to `job`. Throws — leaving the caller nothing to write — when the result would be a
 * job that cannot run or cannot be referred to.
 */
export function applyJobEdit(job: LoopJob, edit: JobEdit, ctx: JobEditContext): AppliedJobEdit {
	if (edit.prompt !== undefined) {
		if (!edit.prompt.trim()) throw new Error("cron action cannot be empty");
		if (Buffer.byteLength(edit.prompt, "utf8") > ctx.maxPromptBytes) throw new Error(`cron action exceeds ${ctx.maxPromptBytes} bytes`);
	}
	if (edit.name) ctx.checkName(edit.name, ctx.others);
	// A one-shot is spent by running, and the scheduler deletes it afterwards — which would take the
	// loop's notes with it. That is the opposite of why editing in place exists.
	if (edit.schedule?.kind === "once") throw new Error("a job cannot be changed to a one-shot schedule; /cron run <id> runs it now instead");

	const patch: Partial<LoopJob> = {};
	const changed: string[] = [];
	if (edit.model !== undefined) patch.model = edit.model ?? undefined;
	if (edit.thinking !== undefined) patch.thinking = edit.thinking ?? undefined;
	if (edit.timeoutMs !== undefined) patch.timeoutMs = edit.timeoutMs ?? undefined;
	if (edit.name !== undefined) patch.name = edit.name ?? undefined;
	if (edit.host !== undefined) patch.host = edit.host === "here" ? ctx.hostName : undefined;
	if (edit.prompt !== undefined) {
		patch.prompt = edit.prompt;
		// The old wording is otherwise unrecoverable, and it is what ties "this loop started
		// behaving differently" to the edit that caused it. Only when it actually changed.
		if (edit.prompt !== job.prompt) changed.push(`prompt changed from ${JSON.stringify(job.prompt)} to ${JSON.stringify(edit.prompt)}`);
	}

	const schedule = edit.schedule ?? job.schedule;
	const createdAt = Date.parse(job.createdAt);
	const lastFiredAt = job.lastFiredAt ? Date.parse(job.lastFiredAt) : undefined;
	if (edit.schedule !== undefined) {
		// An expression can parse and still never match ("0 0 30 2 *"): the job would go quiet with
		// nothing to see. Refuse it, so the caller writes nothing.
		if (computeNext({ schedule, createdAt, lastFiredAt }, ctx.now) === undefined) {
			throw new Error(`${formatSchedule(edit.schedule)} has no next run; the job is unchanged`);
		}
		patch.schedule = edit.schedule;
		// A cron job owes every slot its expression matched since `lastDueAt`, so moving a daily job
		// to "*/5 * * * *" at noon would owe a run at once — for a slot that only existed
		// retroactively. Restart the clock at the edit; the first run under the new expression is its
		// next one. An `every <dur>` job is measured from `lastFiredAt`, which is real bookkeeping and
		// is left alone: "every 30m" means at most 30 minutes apart, so one that last ran an hour ago
		// is genuinely overdue and should fire on the next tick.
		patch.lastDueAt = new Date(ctx.now).toISOString();
		changed.push(`schedule changed from ${formatSchedule(job.schedule)} to ${formatSchedule(edit.schedule)}`);
	}

	const merged = { ...job, ...patch };
	return { patch, changed, nextRun: nextRunOf(merged, ctx.now) };
}

/** Read the job back exactly as the scheduler will, so the confirmation cannot promise a fiction. */
export function nextRunOf(job: LoopJob, now: number): NextRun {
	if (!job.enabled) return { kind: "disabled" };
	const input = {
		schedule: job.schedule,
		createdAt: Date.parse(job.createdAt),
		lastDueAt: job.lastDueAt ? Date.parse(job.lastDueAt) : undefined,
		lastFiredAt: job.lastFiredAt ? Date.parse(job.lastFiredAt) : undefined,
	};
	if (computeDue(input, now) !== undefined) return { kind: "due" };
	const at = computeNext(input, now);
	return at === undefined ? { kind: "none" } : { kind: "at", at };
}
