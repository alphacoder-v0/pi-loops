/**
 * The `/cron` listing, as lines.
 *
 * It lives here rather than in `src/pi-loops.ts` — the extension's default export, which nothing can
 * import — because docs/loops.md states these markers and columns as the behaviour, and until this
 * was importable no test could see one go. Everything it reads is a parameter, so a test can hand it
 * a job, a run log and an inbox and read the lines a person reads.
 */
import { projectLabel } from "./conversation-rows.ts";
import { formatWait, queueOrder, queuedPrompt, runningRun } from "./engine.ts";
import { shortSessionId } from "./session-head.ts";
import type { InboxEntry } from "./inbox.ts";
import { asleepNote, runsSomewhere, type OwnerView } from "./job-owner.ts";
import { QUIET_MARK_AFTER, SIGNAL_WINDOW_MS, loopSignal, signalSummary } from "./job-signal.ts";
import { plural } from "./plural.ts";
import { previewRedacted } from "./redact.ts";
import type { ClaimedRow, Row } from "./requests.ts";
import type { JobClock } from "./clock.ts";
import { type ListedJob, listedJob, runHistory } from "./job-status.ts";
import { loopLane } from "./lane.ts";
import { computeNext, formatLocal, formatSchedule, stamp } from "./schedule.ts";
import { failurePause } from "./backoff.ts";
import type { LoopJob, RunRecord } from "./store.ts";
import type { DynamicTriggerRule } from "./triggers.ts";

export interface JobLinesInput {
	/** The whole run log, read once by the caller; only this listing's loops are filtered out of it. */
	runs: RunRecord[];
	/** The whole inbox, read once by the caller. */
	inbox: InboxEntry[];
	/** Every job's cursor (`clock.json`), read once by the caller. */
	clock: Readonly<Record<string, JobClock>>;
	/** A conversation's queued rows (`RequestStore.list`): a plain job whose prompt waits there is marked `[queued …]`. */
	requests: (sessionId: string) => Row[];
	/** Who holds which session, as the instance reading the list sees it: a plain job of a session nobody holds has no next run. */
	view: OwnerView;
	now: number;
	/** `$HOME`, for `~` shortening; passed rather than read so a test's paths are its own. */
	home: string;
	/** Injected because the answer decides `[orphan: cwd missing]`, and a test should not make directories. */
	cwdExists: (cwd: string) => boolean;
	/** Whether each job's path is printed: only `/cron all` lists more than one project. */
	showCwd: boolean;
	/** Whether a claim's process is alive; absent, `claimAlive` asks the system. */
	live?: (row: ClaimedRow) => boolean;
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


/** What a queued row's source is called in `/cron queue`, the words the browser page uses for the same row. */
export function queueSourceLabel(source: Row["source"], jobName: (id: string) => string | undefined): string {
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
export function queueLines(rows: readonly Row[], opts: QueueLinesInput): string[] {
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
export function pickQueued(rows: readonly Row[], ref: string): Row | undefined {
	const inputs = queueOrder(rows);
	const trimmed = ref.trim();
	if (/^\d+$/.test(trimmed)) return inputs[Number(trimmed) - 1];
	const exact = inputs.find((row) => row.id === trimmed);
	if (exact) return exact;
	const prefixed = trimmed ? inputs.filter((row) => row.id.startsWith(trimmed)) : [];
	return prefixed.length === 1 ? prefixed[0] : undefined;
}

/**
 * The one-time line a session start says when plain jobs carry `--tools`: 0.22.8 stored the list
 * and never used it; now a command outside it is not run, and pi-loops asks the person; another tool outside it is refused. Undefined when
 * no enabled plain job has one. `names` are what `/cron set` takes.
 */
export function toolsCapNotice(jobs: readonly LoopJob[]): string | undefined {
	const capped = jobs.filter((j) => j.enabled && !j.stateful && j.tools?.length);
	if (!capped.length) return undefined;
	const names = capped.map((j) => j.name ?? j.id);
	const one = capped.length === 1;
	return `[cron] ${plural(capped.length, "plain job")} ${one ? "has" : "have"} --tools, which now limit ${one ? "its" : "their"} turns (a command outside the list is not run: pi-loops asks you, in the conversation and in /inbox; another tool outside it is refused): ${names.join(", ")} — /cron set <ref> --tools - clears it`;
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
 * The line a session start says while a watch proposed in this conversation waits for its answer
 * (design 6.3), with the command that asks again. Undefined when none waits.
 */
export function proposalsNotice(jobs: readonly LoopJob[], rules: readonly DynamicTriggerRule[], sessionId: string | undefined): string | undefined {
	if (!sessionId) return undefined;
	const asks = [...jobs.filter((j) => j.proposed?.session === sessionId).map((j) => `/cron enable ${j.name ?? j.id}`), ...rules.filter((r) => r.proposed?.session === sessionId).map((r) => `/triggers enable ${r.id}`)];
	if (!asks.length) return undefined;
	const one = asks.length === 1;
	return `[cron] ${plural(asks.length, "watch", "watches")} ${one ? "waits" : "wait"} for your yes: ${asks.join(" · ")} ${one ? "asks" : "ask"} again`;
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
	return `[cron] the conversation you left (${shortSessionId(sessionId)}) has ${plural(plainJobs, "plain job")} that ${where} — /cron all lists them, /cron disable <ref> stops one`;
}

/**
 * The fact a list says under a job (design 6.8), from `status.error` and what it is: the last run's
 * failure with its count and, while a pause after it holds the loop back, its next try; the
 * clock's note; why a queued run waits, since when; or another word, said as `last error`.
 */
export type StatusWord =
	| { readonly kind: "failed"; readonly error: string; readonly streak: number; readonly nextTry?: number }
	| { readonly kind: "note"; readonly text: string }
	| { readonly kind: "waiting"; readonly since: number; readonly why: string }
	| { readonly kind: "other"; readonly text: string };

/** What `job`'s list line says of it, or undefined when its status has no word. `next` is its next slot, when it has one. */
export function statusWord(job: ListedJob, now: number, next: number | undefined): StatusWord | undefined {
	const { error, errorIs, streak } = job.status;
	if (!error) return undefined;
	if (errorIs?.kind === "failed") {
		// The background holds a failing loop back after its last failure (src/backoff.ts): its next row waits until then.
		const pause = job.stateful ? failurePause(streak) : 0;
		const until = pause ? Date.parse(errorIs.at) + pause : undefined;
		const nextTry = until !== undefined && until > now ? Math.max(until, next ?? until) : undefined;
		return { kind: "failed", error, streak, ...(nextTry === undefined ? {} : { nextTry }) };
	}
	if (errorIs?.kind === "note") return { kind: "note", text: error };
	if (errorIs?.kind === "waiting") return { kind: "waiting", since: Date.parse(errorIs.since), why: error };
	return { kind: "other", text: error };
}

/** A time on a list line: the clock time on the day of `now`, else the local date and time. */
function timeWords(at: number, now: number): string {
	const [day, time] = [formatLocal(at), formatLocal(now)].map((s) => s.slice(0, 10));
	return day === time ? formatLocal(at).slice(11) : formatLocal(at);
}

/** The `/cron` line of a word (design 6.8). */
export function statusLine(word: StatusWord, now: number): string {
	if (word.kind === "failed") {
		const tail = [word.streak > 1 ? `${word.streak} in a row` : "", word.nextTry !== undefined ? `next try ${timeWords(word.nextTry, now)}` : ""].filter(Boolean).join("; ");
		return `    last run failed: ${previewRedacted(word.error, 100)}${tail ? ` (${tail})` : ""}`;
	}
	if (word.kind === "note") return `    note: ${previewRedacted(word.text, 100)}`;
	if (word.kind === "waiting") return `    queued since ${timeWords(word.since, now)}: ${previewRedacted(word.why, 100)}`;
	return `    last error: ${previewRedacted(word.text, 100)}`;
}

/** The `cron_list` field of a word: `last_error`, `note` or `queued`, the same facts the `/cron` line says, with stamps. */
export function statusField(word: StatusWord, now: number): string {
	if (word.kind === "failed") {
		const tail = [word.streak > 1 ? `${word.streak} in a row` : "", word.nextTry !== undefined ? `next try ${stamp(word.nextTry)}` : ""].filter(Boolean).join("; ");
		return `last_error: ${previewRedacted(word.error, 120)}${tail ? ` (${tail})` : ""}`;
	}
	if (word.kind === "note") return `note: ${previewRedacted(word.text, 120)}`;
	if (word.kind === "waiting") return `queued: ${formatWait(now - word.since)} (since ${stamp(word.since)}) — ${previewRedacted(word.why, 120)}`;
	return `last_error: ${previewRedacted(word.text, 120)}`;
}

/** A catch-up setting that differs from the default (loops catch up, plain jobs do not), in the flag's own spelling. */
function catchUpMark(job: Pick<LoopJob, "stateful" | "catchUp">): string | undefined {
	if (job.stateful) return job.catchUp ? undefined : "[no-catchup]";
	return job.catchUp ? "[catchup]" : undefined;
}

export function jobLines(stored: LoopJob[], opts: JobLinesInput): string[] {
	const { runs, inbox, requests, view, now, home, cwdExists, showCwd } = opts;
	// A loop's run, failures and last error, from its rows and the run log (src/job-status.ts `listedJob`).
	const histories = runHistory(runs);
	const jobs = stored.map((job) => {
		const lane = job.stateful ? loopLane(job.id) : undefined;
		let rows: Row[] = [];
		try { if (lane) rows = requests(lane); }
		catch { /* an unreadable lane lists as one with no rows */ }
		return listedJob(job, opts.clock[job.id], rows, histories.get(job.id), opts.live);
	});
	return jobs
		.map((job, i) => {
			// A next run is shown when it will happen somewhere: a plain job of a session nobody holds has none.
			const next =
				job.enabled && runsSomewhere(job, view)
					? computeNext(
							{
								schedule: job.schedule,
								createdAt: Date.parse(job.createdAt),
								fired: job.status.fired ? Date.parse(job.status.fired) : undefined,
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
			// A loop's run is its marker; a plain job's turn in a closed conversation is the claim on its row.
			const run = runningRun(job, !job.stateful && job.sessionId ? requests(job.sessionId) : []);
			const marks = [job.stateful ? "[stateful]" : undefined, job.verify ? "[verify]" : undefined, dormant, orphan, quiet, queued, run ? `running ${run}` : undefined, catchUpMark(job)]
				.filter(Boolean)
				.join("  ");
			const head = `${String(i + 1).padStart(2)}. ${job.id}${job.name ? ` "${job.name}"` : ""}${job.proposed ? "  proposed: waits for your yes" : job.enabled ? "" : "  disabled"}  ${formatSchedule(job.schedule)}${marks ? `  ${marks}` : ""}`;
			const action = `    action: ${previewRedacted(job.prompt, 120)}`;
			const worth = signal ? signalSummary(signal) : undefined;
			const meta = `    next ${next ? formatLocal(next) : "—"} · runs ${job.status.runs}${job.status.collapsed ? ` · skipped overlaps ${job.status.collapsed}` : ""}${worth ? ` · 30d: ${worth}` : ""}${showCwd ? ` · ${projectLabel(job.cwd, home)}` : ""}`;
			const word = statusWord(job, now, next);
			const err = word ? statusLine(word, now) : job.status.fired ? `    last fired: ${formatLocal(Date.parse(job.status.fired))}` : undefined;
			const ref = job.name ?? job.id;
			const answer = job.proposed ? `    /cron enable ${ref} asks again · /cron remove ${ref} cancels it` : undefined;
			return [head, action, meta, answer, err].filter((l): l is string => !!l);
		})
		.flat();
}

/** More than five rules or loops is a list, not a panel: `/triggers` and `/cron` have the rest. */
const PANEL_ROW_LIMIT = 5;
/** The latest runs; `/cron runs` has the rest. */
export const PANEL_RUN_LIMIT = 3;

export type PanelTone = "head" | "ok" | "dim" | "warn";

/** What the widget shows for one project. The run line and a rule's failure mark come in made, as the run card and `/triggers` make them. */
export interface PanelInput {
	rules: (Pick<DynamicTriggerRule, "condition" | "action" | "enabled" | "fireOnce" | "proposed"> & { failureMark?: string })[];
	/** The last rule check here; only an outcome other than `no match` or `matched N` is shown. */
	poll?: { at: string; outcome: string };
	jobs: ListedJob[];
	runs: RunRecord[];
	runText: (r: RunRecord, name?: string) => string;
	sources: { name: string; state: string; tools: number }[];
	hookEvents: string[];
}

/**
 * The widget's lines, each with the tone the theme colours it in; none when there is nothing to
 * show. A row carries a mark only where it differs (`[disabled]`, `[every time]`): the inbox count
 * is the footer badge's, and the trace of a check is `/triggers audit`'s.
 */
export function panelLines(i: PanelInput): { text: string; tone: PanelTone }[] {
	if (!i.rules.length && !i.jobs.length && !i.sources.length && !i.runs.length) return [];
	const clip = (x: string, n: number) => previewRedacted(x, n);
	const lines: { text: string; tone: PanelTone }[] = [];
	const more = (n: number) => n > PANEL_ROW_LIMIT && lines.push({ text: `… ${n - PANEL_ROW_LIMIT} more`, tone: "dim" });
	if (i.rules.length) {
		lines.push({ text: "Rules", tone: "head" });
		for (const r of i.rules.slice(0, PANEL_ROW_LIMIT)) {
			const marks = [r.proposed ? "[proposed]" : r.enabled ? "" : "[disabled]", r.fireOnce ? "" : "[every time]", r.failureMark ?? ""].filter(Boolean);
			lines.push({ text: `${clip(r.condition, 40)} → ${clip(r.action, 40)}${marks.map((m) => `  ${m}`).join("")}`, tone: r.failureMark ? "warn" : r.enabled ? "ok" : "dim" });
		}
		more(i.rules.length);
	}
	if (i.poll && i.poll.outcome !== "no match" && !/^matched \d+$/.test(i.poll.outcome)) lines.push({ text: `Last check  ${formatLocal(Date.parse(i.poll.at)).slice(11)} · ${i.poll.outcome}`, tone: "warn" });
	if (i.jobs.length) {
		// A proposal waits for its yes (design 6.3): it is counted as proposed, not as disabled.
		const proposed = i.jobs.filter((j) => j.proposed).length;
		const disabled = i.jobs.filter((j) => !j.enabled && !j.proposed).length;
		lines.push({ text: `Loops  ${i.jobs.length}${disabled ? ` · ${disabled} disabled` : ""}${proposed ? ` · ${proposed} proposed` : ""}`, tone: "head" });
		for (const j of i.jobs.slice(0, PANEL_ROW_LIMIT))
			lines.push({ text: `${loopLabel(j)}  ${formatSchedule(j.schedule)}  ${clip(j.prompt, 48)}${j.proposed ? "  [proposed]" : j.enabled ? "" : "  [disabled]"}${j.status.collapsed ? `  skipped overlaps ${j.status.collapsed}` : ""}`, tone: j.status.collapsed ? "warn" : j.enabled ? "ok" : "dim" });
		more(i.jobs.length);
	}
	if (i.runs.length) {
		lines.push({ text: "Runs", tone: "head" });
		const names = new Map(i.jobs.map((j) => [j.id, j.name]));
		for (const r of i.runs.slice(-PANEL_RUN_LIMIT).reverse()) lines.push({ text: `${formatLocal(Date.parse(r.finishedAt)).slice(11)} ${i.runText(r, names.get(r.jobId))}`, tone: r.ok ? "ok" : r.aborted ? "dim" : "warn" });
		if (i.runs.length > PANEL_RUN_LIMIT) lines.push({ text: "… /cron runs", tone: "dim" });
	}
	if (i.sources.length) {
		lines.push({ text: `MCP  servers ${i.sources.length} · tools ${i.sources.reduce((n, s) => n + s.tools, 0)}`, tone: "head" });
		const tone: PanelTone = i.sources.some((s) => s.state !== "connected" && s.state !== "disabled") ? "warn" : i.sources.some((s) => s.state === "connected") ? "ok" : "dim";
		lines.push({ text: `  ${i.sources.map((s) => `${s.name} ${s.state}${s.tools ? ` · ${plural(s.tools, "tool")}` : ""}`).join("  ")}`, tone });
	}
	if (i.hookEvents.length) lines.push({ text: `Hooks  cli_hooks ${plural(i.hookEvents.length, "rule")} (${[...new Set(i.hookEvents)].join(", ")})`, tone: "head" });
	return lines;
}
