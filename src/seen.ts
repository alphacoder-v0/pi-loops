import * as fs from "node:fs";
import * as path from "node:path";
import { withFileLockSync, writeFileAtomic } from "./lock.ts";
import { Inbox, type InboxEntry } from "./inbox.ts";
import { stamp } from "./schedule.ts";
import { JobStore, type RunRecord } from "./store.ts";
import { realpathish, sameProject } from "./paths.ts";
import { plural } from "./plural.ts";

/**
 * When `/inbox` was last looked at, per project: the terminal's `/inbox`, and the page's Mark all
 * seen. `"*"` is `/inbox --all`, which looks at every project. `sessions` holds the per-conversation
 * cursors a v1 file had: read when folding, never written to, and pruned by the sweep.
 */
export interface SeenFile {
	v: 2;
	projects: Record<string, string>;
	sessions: Record<string, string>;
}

/** The key `/inbox --all` marks: it looked at every project. */
export const ALL_PROJECTS = "*";
/** With no cursor (nobody looked yet, or an upgrade from a version without one), what is counted. */
export const FIRST_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A cursor this far ahead of the clock is a clock that moved, not a look: it counts as none. */
export const SKEW_MS = 5 * 60 * 1000;

const fileIn = (dir: string): string => path.join(dir, "seen.json");
const lockIn = (dir: string): string => path.join(dir, "seen.lock");
const empty = (): SeenFile => ({ v: 2, projects: {}, sessions: {} });

function stringsOf(value: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (!value || typeof value !== "object" || Array.isArray(value)) return out;
	for (const [k, at] of Object.entries(value)) if (typeof at === "string" && Number.isFinite(Date.parse(at))) out[k] = at;
	return out;
}

/** The file as v2: a v1 file's per-conversation cursors become `sessions`; anything else is empty. */
export function readSeen(dir: string): SeenFile {
	let value: any;
	try {
		value = JSON.parse(fs.readFileSync(fileIn(dir), "utf8"));
	} catch {
		return empty(); // not written yet, or torn: the first window, never a flood
	}
	if (!value || typeof value !== "object") return empty();
	if (value.v === 1) return { v: 2, projects: {}, sessions: stringsOf(value.seen) };
	if (value.v === 2) return { v: 2, projects: stringsOf(value.projects), sessions: stringsOf(value.sessions) };
	return empty();
}

const write = (dir: string, seen: SeenFile) => writeFileAtomic(fileIn(dir), `${JSON.stringify(seen, null, 2)}\n`);
const later = (a: string | undefined, b: string) => (a !== undefined && Date.parse(a) >= Date.parse(b) ? a : b);

/**
 * Record a look at `cwd`'s project (or every project, `"*"`) at `at`. A cursor only moves forward,
 * so two writers end in the same state whatever their order; `at` is never later than `now`, and a
 * stored cursor in the future (a clock that moved) is replaced. Returns what is stored.
 */
export function markProjectSeen(dir: string, cwd: string, at: string, now = Date.now()): string {
	const key = cwd === ALL_PROJECTS ? cwd : realpathish(cwd) || cwd;
	const capped = Date.parse(at) > now ? stamp(now) : at;
	return withFileLockSync(lockIn(dir), () => {
		const seen = readSeen(dir);
		const prev = seen.projects[key];
		const stored = later(prev !== undefined && Date.parse(prev) <= now + SKEW_MS ? prev : undefined, capped);
		if (stored !== prev) {
			seen.projects[key] = stored;
			write(dir, seen);
		}
		return stored;
	});
}

/**
 * The sweep: forget v1 cursors of conversations nothing refers to any more, and project cursors
 * whose directory is gone. Returns how many were forgotten.
 */
export function pruneSeen(dir: string, keepSession: (sessionId: string) => boolean, exists: (p: string) => boolean = fs.existsSync): number {
	return withFileLockSync(lockIn(dir), () => {
		const seen = readSeen(dir);
		const sessions = Object.keys(seen.sessions).filter((id) => !keepSession(id));
		const projects = Object.keys(seen.projects).filter((k) => k !== ALL_PROJECTS && !exists(k));
		if (!sessions.length && !projects.length) return 0;
		for (const id of sessions) delete seen.sessions[id];
		for (const k of projects) delete seen.projects[k];
		write(dir, seen);
		return sessions.length + projects.length;
	});
}

/** Where "since" starts for a project; `looked: false` is the first window. */
export interface Cursor {
	sinceMs: number;
	looked: boolean;
}

/**
 * The latest look at `cwd`'s project: every project key `inProject` matches (a project's
 * subdirectory is a key of its own), `"*"`, and the v1 cursor of every conversation whose records
 * are in the project. A cursor in the future is ignored; none at all is the first window.
 */
export function cursorFor(seen: SeenFile, cwd: string, ctx: { inProject: (entryCwd: string, cwd: string) => boolean; sessionsHere: ReadonlySet<string>; now: number }): Cursor {
	const times: string[] = [];
	for (const [k, at] of Object.entries(seen.projects)) if (k === ALL_PROJECTS || ctx.inProject(k, cwd)) times.push(at);
	for (const [id, at] of Object.entries(seen.sessions)) if (ctx.sessionsHere.has(id)) times.push(at);
	const valid = times.map((t) => Date.parse(t)).filter((ms) => Number.isFinite(ms) && ms <= ctx.now + SKEW_MS);
	// A loop, not Math.max(...valid): a hand-made file with many keys would overflow the stack.
	const latest = valid.reduce((a, b) => (b > a ? b : a), Number.NEGATIVE_INFINITY);
	return valid.length ? { sinceMs: latest, looked: true } : { sinceMs: ctx.now - FIRST_WINDOW_MS, looked: false };
}

/**
 * What happened in one project while nobody looked: the page's away card and the terminal's
 * session-start line both say this (docs/loops.md).
 */
export interface AwaySummary {
	cwd: string;
	/** The cursor as an ISO time; null for the first window ("In the last day"). */
	since: string | null;
	/** When this was counted, the end of its window: what Mark all seen sends back. */
	asOf: string;
	runs: number;
	failedRuns: number;
	/** New findings, a rule check's once; `decisions` of them are checkpoints. */
	findings: number;
	decisions: number;
	fromThisConversation: number;
	costUsd: number;
}

export interface AwayInput {
	seen: SeenFile;
	runs: readonly RunRecord[];
	findings: readonly InboxEntry[];
	cwd: string;
	sessionId?: string;
	now: number;
	inProject: (entryCwd: string, cwd: string) => boolean;
}

/** Whether a path is in `cwd`'s project, asked once per distinct path: matching resolves paths on disk. */
function matcher(cwd: string, inProject: (entryCwd: string, cwd: string) => boolean): (entryCwd: unknown) => boolean {
	const known = new Map<string, boolean>();
	return (entryCwd) => {
		if (typeof entryCwd !== "string") return false;
		let yes = known.get(entryCwd);
		if (yes === undefined) known.set(entryCwd, (yes = inProject(entryCwd, cwd)));
		return yes;
	};
}

/** The one function behind the away card and the session-start line. Pure: the caller reads the files. */
export function awayFor(input: AwayInput): AwaySummary {
	const here = matcher(input.cwd, input.inProject);
	// A finding with no cwd is in every project, as `/inbox` lists it (inbox.ts belongsToProject).
	const findingHere = (f: InboxEntry) => !f.cwd || here(f.cwd);
	// Lines another process wrote: one that is not an object (`null`, a number) is no record.
	const runs = input.runs.filter((r) => !!r && typeof r === "object");
	const findings = input.findings.filter((f) => !!f && typeof f === "object");
	// The v1 fold: a conversation's old cursor counts for the project its records are in.
	const sessionsHere = new Set<string>();
	if (Object.keys(input.seen.sessions).length) {
		for (const r of runs) if (typeof r.forSession === "string" && here(r.cwd)) sessionsHere.add(r.forSession);
		for (const f of findings) if (typeof f.session_id === "string" && f.cwd && here(f.cwd)) sessionsHere.add(f.session_id);
	}
	const cursor = cursorFor(input.seen, input.cwd, { inProject: input.inProject, sessionsHere, now: input.now });
	// The window is (cursor, now]: Mark all seen sends `now` back as asOf, and the page refuses a time
	// ahead of its clock, so a record stamped a little ahead is counted once its time has come.
	const after = (at: unknown) => {
		const ms = typeof at === "string" ? Date.parse(at) : NaN;
		return ms > cursor.sinceMs && ms <= input.now;
	};
	let runCount = 0;
	let failedRuns = 0;
	let costUsd = 0;
	for (const r of runs) {
		if (!r.stateful || !here(r.cwd) || !after(r.finishedAt)) continue;
		runCount++;
		if (!r.ok && !r.aborted) failedRuns++;
		costUsd += (typeof r.usage?.cost === "number" ? r.usage.cost : 0) + (typeof r.checker?.cost === "number" ? r.checker.cost : 0);
	}
	// A rule check files one finding per conversation it was for (src/trigger-runtime.ts): one result.
	const groups = new Map<string, InboxEntry[]>();
	for (const f of findings) {
		if (f.status !== "new" || !findingHere(f) || !after(f.created_at)) continue;
		const key = typeof f.source === "string" && f.source.startsWith("trigger:") && f.run_id ? `rule:${f.run_id}` : `id:${f.id}`;
		groups.set(key, [...(groups.get(key) ?? []), f]);
	}
	const results = [...groups.values()];
	return {
		cwd: input.cwd,
		since: cursor.looked ? stamp(cursor.sinceMs) : null,
		asOf: stamp(input.now),
		runs: runCount,
		failedRuns,
		findings: results.length,
		decisions: results.filter((g) => g.some((f) => f.kind === "checkpoint")).length,
		fromThisConversation: input.sessionId ? results.filter((g) => g.some((f) => f.session_id === input.sessionId)).length : 0,
		costUsd: Math.round(costUsd * 100) / 100,
	};
}

/**
 * The summary from the loops directory's files: the whole run log (halved past 1 MB, so it is
 * bounded), the inbox and `seen.json`. What the terminal's session-start line and the page's
 * `GET /inbox` both call, so the two cannot count differently.
 */
export function awayIn(dir: string, cwd: string, sessionId?: string, now = Date.now()): AwaySummary {
	return awayFor({ seen: readSeen(dir), runs: new JobStore(dir).allRuns(), findings: new Inbox(dir).list(), cwd, sessionId, now, inProject: sameProject });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * When `sinceMs` was, said from `nowMs`, in local time: "09:14", "yesterday 23:10", "Mon 23:10",
 * "Oct 28 23:10", "Oct 28 2025 23:10". Days are calendar dates, not 24-hour steps, so a night with
 * a clock change is still one day. The page has a copy of this (src/web/page.js `sinceWords`).
 */
export function sinceWords(sinceMs: number, nowMs: number): string {
	const a = new Date(sinceMs);
	const b = new Date(nowMs);
	const day = (d: Date) => Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
	const days = day(b) - day(a);
	const time = `${pad(a.getHours())}:${pad(a.getMinutes())}`;
	if (days <= 0) return time;
	if (days === 1) return `yesterday ${time}`;
	if (days < 7) return `${DAYS[a.getDay()]} ${time}`;
	const date = `${MONTHS[a.getMonth()]} ${a.getDate()}`;
	return a.getFullYear() === b.getFullYear() ? `${date} ${time}` : `${date} ${a.getFullYear()} ${time}`;
}


/** How many findings came from this conversation, worth saying only when that is not all of them. */
const fromHere = (s: AwaySummary): number => (s.fromThisConversation !== s.findings ? s.fromThisConversation : 0);

/** Nothing to say: no run and no finding since the cursor. */
export const awayEmpty = (s: AwaySummary): boolean => s.runs === 0 && s.findings === 0;

/**
 * The away card's sentence (the page draws it from its own copy, part by part, and
 * test/web-page.test.ts holds the two to one sentence); runs are the
 * activity strip's to count, so a card is about findings:
 * "Since yesterday 23:10 · 3 findings, 1 from this conversation · 1 needs you · $0.41".
 */
export function awaySentence(s: AwaySummary): string | undefined {
	if (!s.findings) return undefined;
	const parts = [s.since === null ? "In the last day" : `Since ${sinceWords(Date.parse(s.since), Date.parse(s.asOf))}`];
	if (s.findings) parts.push(`${plural(s.findings, "finding")}${fromHere(s) ? `, ${fromHere(s)} from this conversation` : ""}`);
	if (s.decisions) parts.push(`${s.decisions} need${s.decisions === 1 ? "s" : ""} you`);
	if (s.costUsd > 0) parts.push(`$${s.costUsd.toFixed(2)}`);
	return parts.join(" · ");
}

/**
 * The terminal's session-start line, from the same summary:
 * "[inbox] since you last looked (yesterday 23:10): 41 loop runs (3 failed), 3 new findings (1 from this conversation) — /inbox".
 */
export function awayLine(s: AwaySummary): string | undefined {
	if (awayEmpty(s)) return undefined;
	const when = s.since === null ? "in the last day" : sinceWords(Date.parse(s.since), Date.parse(s.asOf));
	const parts: string[] = [];
	if (s.runs) parts.push(`${plural(s.runs, "loop run")}${s.failedRuns ? ` (${s.failedRuns} failed)` : ""}`);
	if (s.findings) parts.push(`${plural(s.findings, "new finding")}${fromHere(s) ? ` (${fromHere(s)} from this conversation)` : ""}`);
	return `[inbox] since you last looked (${when}): ${parts.join(", ")} — /inbox`;
}

/** The Background view's column for one conversation: its project's counts. */
export interface SinceYouLooked {
	runs: number;
	failed: number;
	findings: number;
	mine: number;
}
export const sinceCounts = (s: AwaySummary): SinceYouLooked => ({ runs: s.runs, failed: s.failedRuns, findings: s.findings, mine: s.fromThisConversation });
