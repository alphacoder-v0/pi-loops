/**
 * The `/cron` listing, as lines.
 *
 * It lives here rather than in `src/pi-loops.ts` — the extension's default export, which nothing can
 * import — because docs/loops.md states these markers and columns as the behaviour, and until this
 * was importable no test could see one go. Everything it reads is a parameter, so a test can hand it
 * a job, a run log and an inbox and read the lines a person reads.
 */
import { formatWait, queueOrder, queuedPrompt } from "./engine.ts";
import type { InboxEntry } from "./inbox.ts";
import { asleepNote, runsSomewhere, type OwnerView } from "./job-owner.ts";
import { QUIET_MARK_AFTER, SIGNAL_WINDOW_MS, loopSignal, signalSummary } from "./job-signal.ts";
import { previewRedacted } from "./redact.ts";
import type { SessionRequest } from "./requests.ts";
import { computeNext, formatLocal, formatSchedule } from "./schedule.ts";
import type { LoopJob, RunRecord } from "./store.ts";

export interface JobLinesInput {
	/** The whole run log, read once by the caller; only this listing's loops are filtered out of it. */
	runs: RunRecord[];
	/** The whole inbox, read once by the caller. */
	inbox: InboxEntry[];
	/** A conversation's queued rows (`RequestStore.list`): a plain job whose prompt waits there is marked `[queued …]`. */
	requests: (sessionId: string) => SessionRequest[];
	/** Who holds which session, as the instance reading the list sees it: a plain job of a session nobody holds has no next run. */
	view: OwnerView;
	now: number;
	/** `$HOME`, for `~` shortening; passed rather than read so a test's paths are its own. */
	home: string;
	/** Injected because the answer decides `[orphan: cwd missing]`, and a test should not make directories. */
	cwdExists: (cwd: string) => boolean;
}

/**
 * What a person calls a loop on every surface but the lists that take its id (`/cron`, `cron_list`,
 * `inbox --json`): its name, else the first 13 characters of its id (`cron-` and 8 hex digits).
 */
export function loopLabel(job: { id: string; name?: string }): string {
	return job.name || job.id.slice(0, 13);
}

/** A loop's generated id (`src/store.ts` newId): what the snapshot carries for a loop with no name. */
const LOOP_ID = /^cron-[0-9a-f]{32}$/;

/** A snapshot's `job` field (its name, else its id) as every surface labels the loop. */
export function snapshotLoopLabel(job: string): string {
	return LOOP_ID.test(job) ? loopLabel({ id: job }) : job;
}

/** The caller's `homeRel`, with `home` passed in: this module has no `process.env`. */
const homeRel = (p: string, home: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);

/** What a queued row's source is called in `/cron queue`, the words the browser page uses for the same row. */
export function queueSourceLabel(source: SessionRequest["source"], jobName: (id: string) => string | undefined): string {
	const at = source.indexOf(":");
	const [kind, arg] = at < 0 ? [source, ""] : [source.slice(0, at), source.slice(at + 1)];
	if (source === "person") return "you";
	if (kind === "cron") return `cron ${jobName(arg) ?? arg}`;
	if (kind === "cron-run") return `/cron run ${jobName(arg) ?? arg}`;
	if (kind === "rule" || kind === "inbox") return `${kind === "inbox" ? "claim" : kind} ${arg.slice(0, 8)}`;
	if (kind === "push" || kind === "recipe") return `${kind} ${arg}`;
	return source;
}

export interface QueueLinesInput {
	now: number;
	/** A plain job's name by id, for the clock's rows. */
	jobName: (id: string) => string | undefined;
	/** Rows pi was handed and has not written yet: listed, numbered, and said to be pi's already. */
	inFlight: ReadonlySet<string>;
}

/**
 * `/cron queue`: what waits for this conversation, in the order the engine offers it, one numbered
 * line each with its source, how long it has waited and the start of its text. The numbers are what
 * `/cron queue cancel <n>` takes, so they are the listing's and nothing else's.
 */
export function queueLines(rows: readonly SessionRequest[], opts: QueueLinesInput): string[] {
	const inputs = queueOrder(rows);
	if (!inputs.length) return ["(nothing is queued for this conversation)"];
	return inputs.map((row, i) => {
		const created = Date.parse(row.created_at);
		const age = Number.isFinite(created) ? formatWait(opts.now - created) : "?";
		const state = opts.inFlight.has(row.id) ? "handed to pi" : row.not_before && Date.parse(row.not_before) > opts.now ? `backing off${row.last_error ? `: ${previewRedacted(row.last_error, 80)}` : ""}` : row.wake === "append" ? "lands without a turn" : "waits for pi to be idle";
		const text = previewRedacted(String(row.payload?.text ?? "").replace(/^\[Trigger [^\]]+\]\s*/, ""), 100) || (row.payload?.images?.length ? `[${plural(row.payload.images.length, "image")}]` : "");
		return `${String(i + 1).padStart(2)}. ${queueSourceLabel(row.source, opts.jobName)} · ${age} · ${state} · ${row.id}\n    ${text}`;
	});
}

/**
 * Which queued row `ref` names, for `/cron queue cancel`: its number in the listing, its id, or a
 * prefix of its id that names one row. Undefined when nothing matches; a prefix of several is nobody.
 */
export function pickQueued(rows: readonly SessionRequest[], ref: string): SessionRequest | undefined {
	const inputs = queueOrder(rows);
	const trimmed = ref.trim();
	if (/^\d+$/.test(trimmed)) return inputs[Number(trimmed) - 1];
	const exact = inputs.find((row) => row.id === trimmed);
	if (exact) return exact;
	const prefixed = trimmed ? inputs.filter((row) => row.id.startsWith(trimmed)) : [];
	return prefixed.length === 1 ? prefixed[0] : undefined;
}

/** `1 loop`, `2 loops`: a count a person reads, never `loop(s)`. */
export function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

/**
 * The one-time line a session start says when plain jobs carry `--tools`: 0.22.8 stored the list
 * and never used it, and since 0.23 a turn in a window asks before a tool outside it. Undefined when
 * no enabled plain job has one. `names` are what `/cron set` takes.
 */
export function toolsCapNotice(jobs: readonly LoopJob[]): string | undefined {
	const capped = jobs.filter((j) => j.enabled && !j.stateful && j.tools?.length);
	if (!capped.length) return undefined;
	const names = capped.map((j) => j.name ?? j.id);
	const one = capped.length === 1;
	return `[cron] ${plural(capped.length, "plain job")} ${one ? "has" : "have"} --tools, which now limit ${one ? "its" : "their"} turns (a tool outside the list asks you first in a window, and is refused in the background): ${names.join(", ")} — /cron set <ref> --tools - clears it`;
}

/**
 * The one-time line a session start says about plain jobs running in the background: every enabled
 * plain job of every conversation, since each runs there once its conversation has been opened in
 * this pi-loops and closed again. 0.22.8 slept them while their conversation was closed, and closing
 * it was how people stopped one. Undefined when there is none.
 */
export function heldJobsNotice(jobs: readonly LoopJob[]): string | undefined {
	const plain = jobs.filter((j) => j.enabled && !j.stateful && j.sessionId);
	if (!plain.length) return undefined;
	const conversations = new Set(plain.map((j) => j.sessionId)).size;
	const one = plain.length === 1;
	return `[cron] ${plural(plain.length, "plain job")} in ${plural(conversations, "conversation")} ${one ? "runs" : "run"} in the background while ${one ? "its" : "their"} conversation is closed (once it has been opened in this pi-loops), and each run is a model turn — /cron all lists them`;
}

/**
 * What a window says when it leaves a conversation (`/new`, `/resume`) that has plain jobs: in 0.22.8
 * that stopped them; now they run in the background, or, with `[host] auto = false`, stop with the
 * last window. Undefined when the conversation has none.
 */
export function leftConversationLine(sessionId: string, plainJobs: number, hostAuto: boolean): string | undefined {
	if (!plainJobs) return undefined;
	const run = plainJobs === 1 ? "runs" : "run";
	const where = hostAuto ? `${run} in the background now, each run a model turn` : `${run} in the background while a pi window is open ([host] auto = false), each run a model turn`;
	return `[cron] the conversation you left (${sessionId.slice(0, 8)}) has ${plural(plainJobs, "plain job")} that ${where} — /cron all lists them, /cron disable <ref> stops one`;
}

export function jobLines(jobs: LoopJob[], opts: JobLinesInput): string[] {
	const { runs, inbox, requests, view, now, home, cwdExists } = opts;
	return jobs
		.map((job, i) => {
			// A next run is shown when it will happen somewhere: a plain job of a session nobody holds has none.
			const next =
				job.enabled && runsSomewhere(job, view)
					? computeNext(
							{
								schedule: job.schedule,
								createdAt: Date.parse(job.createdAt),
								lastFiredAt: job.lastFiredAt ? Date.parse(job.lastFiredAt) : undefined,
							},
							now,
						)
					: undefined;
			const asleepMark = asleepNote(job, view);
			const dormant = asleepMark ? `[${asleepMark}]` : undefined;
			const orphan = job.stateful && !cwdExists(job.cwd) ? "[orphan: cwd missing]" : undefined;
			// What the loop's runs came to (src/job-signal.ts): `quiet ×N` in the marks once N empty
			// runs are the newest, and the findings line — filed, claimed, dismissed — over 30 days.
			// A loop was, until now, judged by whether it ran; this is whether it was worth running.
			const signal = job.stateful ? loopSignal(job.id, runs, inbox, now - SIGNAL_WINDOW_MS) : undefined;
			const quiet = signal && signal.quiet >= QUIET_MARK_AFTER ? `[quiet ×${signal.quiet}]` : undefined;
			// A plain job's prompt waiting in its conversation's queue (for pi to be idle, after Esc,
			// behind another turn): without this mark it looked exactly like one that is not queued.
			const waiting = !job.stateful && job.sessionId ? queuedPrompt(job, requests(job.sessionId), now) : undefined;
			const queued = waiting ? `[queued ${formatWait(now - Date.parse(waiting.since))}${waiting.reason ? ` — ${waiting.reason}` : ""}]` : undefined;
			const marks = [job.stateful ? "[stateful]" : undefined, job.verify ? "[verify]" : undefined, dormant, orphan, quiet, queued, job.running ? `running ${job.running.runId}` : undefined, job.catchUp ? undefined : "[no-catchup]"]
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
