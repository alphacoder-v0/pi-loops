import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEAD_AFTER_ATTEMPTS, failurePause } from "./backoff.ts";
import { landed, plainCollapseKey, plainJobRow, plainRunId } from "./engine.ts";
import { loopLane, type LaneId } from "./lane.ts";
import { openWhere, ownerSession, whereRuns, type OwnerView } from "./job-owner.ts";
import type { LockOptions } from "./lock.ts";
import type { RequestStore, Row, UnclaimedRow } from "./requests.ts";

type CountedRow = Row & { collapsed?: number; collapsed_slot?: string };
import { computeDue, computeNext, formatLocal, formatLocalZoned, isValidSchedule, parseSchedule, stamp } from "./schedule.ts";
import type { Disabled, JobStore, LoopJob, RunRecord } from "./store.ts";
import { jobStatus, runHistory, type JobHistory } from "./job-status.ts";
import { oneShotDoneV3 } from "./settle.ts";
import type { Book } from "./stores.ts";
import type { PathState } from "./gate.ts";

/** A clock decision that was not a run, for the job's status. */
export interface ClockNote { at: string; text: string }
/** The one follow-up a loop set for itself with `wake_me` (design 1.2). */
export interface Followup {
	/** `fu-` and 32 hex of sha256(job | set_by | at): the id of the row it writes. */
	id: string;
	/** The row is written at this time. */
	at: string;
	/** At most 500 characters: what the run wants to look at then. */
	note: string;
	/** The run that set it. */
	set_by: string;
	created_at: string;
}
/** One job's schedule cursor and run floor. */
export interface JobClock {
	slot?: string; fired?: string; runs: number; note?: ClockNote; collapsed?: number; cleared?: string;
	/** When the drain first found the job's `cwd` missing, while it still is. */
	cwdMissing?: string;
	/** At most one: a second `wake_me` replaces the first. */
	followup?: Followup;
	/** The loop asked for no scheduled run before this, and why. */
	quietUntil?: string; quietWhy?: string;
}
/**
 * A rule's gate: how many readings held its wake, and its last reading. A reading that opened a
 * wake is in `events.jsonl`, not here.
 */
export interface GateClock { looks: number; last?: { at: string; state: PathState } }
/** The versioned clock file. Unknown job keys are preserved by writes; `rules` is there once a rule's gate was looked at. */
export interface ClockFile { v: 1; jobs: Record<string, JobClock>; rules?: Record<string, GateClock> }
/** The cursor stamps as this ticker read them. */
export interface CursorRead { readonly slot?: string; readonly fired?: string }
export interface CursorMove {
	readonly job: string;
	readonly read: CursorRead;
	readonly slot?: string;
	readonly fired?: string;
	readonly fires: boolean;
	readonly note?: ClockNote | null;
	readonly collapsed?: true;
}
export type Advance = "moved" | "lost" | "not-holder";

/** Compare both cursor stamps and move one job, without reading or writing a file. */
export function advanceClock(file: ClockFile, move: CursorMove, holds: boolean): { next: ClockFile; result: Advance } {
	if (!holds) return { next: file, result: "not-holder" };
	const current = file.jobs[move.job];
	if (current?.slot !== move.read.slot || current?.fired !== move.read.fired) return { next: file, result: "lost" };
	const entry: JobClock = { ...current, ...(move.slot === undefined ? {} : { slot: move.slot }), runs: (current?.runs ?? 0) + (move.fires ? 1 : 0), ...(move.collapsed ? { collapsed: (current?.collapsed ?? 0) + 1 } : {}) };
	if (move.fired !== undefined) entry.fired = move.fired;
	if (move.note === null) delete entry.note;
	else if (move.note) entry.note = move.note;
	return { next: { ...file, jobs: { ...file.jobs, [move.job]: entry } }, result: "moved" };
}

export interface ClockPaths { readonly file: string; readonly lock: string }
export interface ClockIo {
	readonly locked: <T>(lockPath: string, fn: () => T, opts?: LockOptions) => T;
	readonly write: (file: string, data: string) => void;
}
export interface RunClose {
	readonly ordinal?: number; readonly fired?: string;
	/** The last slot that collapsed onto the run's row (`collapsed_slot`): the cursor moves to it when it stands before it. */
	readonly slot?: string;
	/** The follow-ups the run's row carried (`woken_ids`): one still in the clock goes, as the tick's own take would have taken it. */
	readonly followups?: readonly string[];
}
export interface Clock {
	read(): ClockFile;
	advance(move: CursorMove, holds?: () => boolean): Advance;
	closeRun(job: string, close: RunClose): void;
	reset(job: string, slot?: string): void;
	/** An enable: failures before `at` are no longer the job's last error, and the clock's note goes with them. */
	clear(job: string, at: string): void;
	/** The first look that found the job's `cwd` missing, or none once it is back. */
	cwdMissing(job: string, since: string | undefined): void;
	/** One skipped overlap more, counted where the drain spends a slot that waited beside a going run. */
	countCollapse(job: string): void;
	/**
	 * The tick's last write for a follow-up whose row is written: the follow-up goes, only while it is
	 * still the one the tick read (a `wake_me` meanwhile set a new one), and a quiet whose time has
	 * passed goes with it.
	 */
	takeFollowup(job: string, id: string, now: number): "moved" | "lost";
}
/** Where a rule's gate readings are counted. */
export interface GateClocks {
	/** Record a rule's reading: the last reading always, and one look more when it held the wake. Returns the entry as it was. */
	noteGate(rule: string, last: { at: string; state: PathState }, held: boolean): GateClock | undefined;
	readGate(rule: string): GateClock | undefined;
}
/** The file belongs to a newer version and must not be replaced. */
export class ClockNewer extends Error {}

export function validStamp(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }

/** Drop malformed entries while preserving the valid jobs in the clock file. */
export function validEntry(value: unknown): JobClock | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entry = value as Record<string, unknown>;
	if (!Number.isInteger(entry.runs) || (entry.runs as number) < 0) return undefined;
	if (entry.slot !== undefined && !validStamp(entry.slot)) return undefined;
	if (entry.fired !== undefined && !validStamp(entry.fired)) return undefined;
	if (entry.cleared !== undefined && !validStamp(entry.cleared)) return undefined;
	if (entry.cwdMissing !== undefined && !validStamp(entry.cwdMissing)) return undefined;
	if (entry.collapsed !== undefined && (!Number.isInteger(entry.collapsed) || (entry.collapsed as number) < 0)) return undefined;
	if (entry.note !== undefined && (!entry.note || typeof entry.note !== "object" || Array.isArray(entry.note) || !validStamp((entry.note as ClockNote).at) || typeof (entry.note as ClockNote).text !== "string")) return undefined;
	// A wake that is not the shape this build writes is dropped, and the cursor stays.
	const followup = entry.followup as Record<string, unknown> | undefined;
	const badFollowup = followup !== undefined && (!followup || typeof followup !== "object" || typeof followup.id !== "string" || !validStamp(followup.at) || typeof followup.note !== "string" || typeof followup.set_by !== "string" || !validStamp(followup.created_at));
	const badQuiet = (entry.quietUntil !== undefined || entry.quietWhy !== undefined) && (!validStamp(entry.quietUntil) || typeof entry.quietWhy !== "string");
	if (!badFollowup && !badQuiet) return value as JobClock;
	const kept = { ...entry } as unknown as JobClock;
	if (badFollowup) delete kept.followup;
	if (badQuiet) { delete kept.quietUntil; delete kept.quietWhy; }
	return kept;
}

/** The bounds of `wake_me` (design 3.3, decided). */
export const WAKE_MIN_MS = 60_000;
export const WAKE_MAX_MS = 7 * 86_400_000;
export const WAKE_RUNS_PER_DAY = 24;
export const WAKE_NOTE_MAX = 500;

/** A follow-up's id: derived, so a tick that writes its row twice writes one row. */
export function followupId(job: string, setBy: string, at: string): string {
	return `fu-${createHash("sha256").update(`${job}|${setBy}|${at}`).digest("hex").slice(0, 32)}`;
}

/** A time a person or a model reads beside `now`: the clock time on the same day, the weekday and time within a week, else the date and time. */
export function dayTime(at: number, now: number): string {
	const local = formatLocal(at);
	if (local.slice(0, 10) === formatLocal(now).slice(0, 10)) return local.slice(11);
	if (at > now && at - now < 6 * 86_400_000) return `${new Date(at).toLocaleDateString("en-US", { weekday: "short" })} ${local.slice(11)}`;
	return local;
}

/** What `wake_me` asks for: the forms `parseSchedule` reads for one time, a note, and whether scheduled runs before it are skipped. */
export interface WakeAsk { readonly when: string; readonly note: string; readonly quiet?: boolean }
export interface WakeFacts {
	readonly job: LoopJob;
	readonly clock: JobClock | undefined;
	/** The run log, for the follow-ups of the last 24 hours. */
	readonly runs: readonly Pick<RunRecord, "jobId" | "startedAt" | "cause">[];
	readonly now: number;
}
export type WakeAnswer = { readonly refused: string } | { readonly at: string; readonly note: string; readonly quiet: boolean };

/** The first scheduled slot after `now`, and after `quietUntil` while the loop is quiet; undefined when the schedule has none. */
export function nextScheduled(job: Pick<LoopJob, "schedule" | "createdAt">, clock: JobClock | undefined, now: number, quietUntil?: string): number | undefined {
	const quiet = quietUntil === undefined ? undefined : Date.parse(quietUntil);
	try { return computeNext({ schedule: job.schedule, createdAt: Date.parse(job.createdAt), fired: clock?.fired === undefined ? undefined : Date.parse(clock.fired) }, quiet !== undefined && quiet > now ? quiet - 1 : now); }
	catch { return undefined; }
}

function nextScheduledWords(next: number | undefined, now: number): string {
	return next === undefined ? "It has no next scheduled run." : `Its next scheduled run is ${dayTime(next, now)}.`;
}

/** Pure. Whether `wake_me` may set this follow-up, in design 6.6's words when it may not. */
export function decideWake(ask: WakeAsk, facts: WakeFacts): WakeAnswer {
	const { job, clock, now } = facts;
	const quietNow = clock?.quietUntil !== undefined && Date.parse(clock.quietUntil) > now ? clock.quietUntil : undefined;
	const refuse = (why: string): WakeAnswer => ({ refused: `not set: ${why} ${nextScheduledWords(nextScheduled(job, clock, now, quietNow), now)}` });
	let at: number;
	try {
		const parsed = parseSchedule(ask.when, now);
		if (parsed.kind !== "once") return refuse(`when is one time, "in 20m" or "at 2026-11-16T09:00+08:00", not a schedule.`);
		at = parsed.at;
	} catch (error) {
		return refuse(`when is "in <duration>" or "at <ISO time with its offset>" (${error instanceof Error ? error.message : String(error)}).`);
	}
	if (!(at - now >= WAKE_MIN_MS && at - now <= WAKE_MAX_MS)) return refuse("a wake is at least 60 seconds and at most 7 days ahead.");
	const note = ask.note.trim();
	if (!note) return refuse("a wake needs a note: what to look at then.");
	if (Array.from(note).length > WAKE_NOTE_MAX) return refuse(`a note is at most ${WAKE_NOTE_MAX} characters, and this one has ${Array.from(note).length}.`);
	const since = now - 86_400_000;
	const woke = facts.runs.filter((run) => run.jobId === job.id && run.cause === "wake" && Date.parse(run.startedAt) > since).length;
	if (woke >= WAKE_RUNS_PER_DAY) return refuse(`this loop has woken itself ${woke} times in the last 24 hours.`);
	return { at: stamp(at), note, quiet: ask.quiet === true };
}

/** What `wake_me` tells the model it set (design 6.6). `replaced` is the follow-up the call replaced. */
export function wakeSetText(job: Pick<LoopJob, "schedule" | "createdAt">, clock: JobClock | undefined, set: { at: string; note: string; quiet: boolean }, replaced: Followup | undefined, now: number): string {
	const at = Date.parse(set.at);
	const replaces = replaced ? ` This replaces the wake you set for ${dayTime(Date.parse(replaced.at), now)}.` : "";
	return `set: this loop wakes at ${formatLocalZoned(at)} ("${set.note}").${replaces} ${nextScheduledWords(nextScheduled(job, clock, now, set.quiet ? set.at : undefined), now)}`;
}

const PATH_STATES: readonly string[] = ["present", "absent", "unknown"];

/** A rule's gate entry, or undefined when it is not one this build wrote. */
export function validGate(value: unknown): GateClock | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entry = value as Record<string, unknown>;
	if (!Number.isInteger(entry.looks) || (entry.looks as number) < 0) return undefined;
	const last = entry.last as Record<string, unknown> | undefined;
	if (last !== undefined && (!last || typeof last !== "object" || !validStamp(last.at) || !PATH_STATES.includes(last.state as string))) return undefined;
	return value as GateClock;
}

/** The follow-up goes, and a quiet whose time is not after `at` goes with it. */
function dropFollowup(entry: JobClock, at: number): void {
	delete entry.followup;
	if (entry.quietUntil !== undefined && Date.parse(entry.quietUntil) <= at) { delete entry.quietUntil; delete entry.quietWhy; }
}

/** The clock file and its lock. Scheduling and lease decisions stay outside this store. */
export class ClockStore implements Clock, GateClocks {
	readonly paths: ClockPaths;
	private readonly io: ClockIo;
	constructor(paths: ClockPaths, io: ClockIo) { this.paths = paths; this.io = io; }
	/** Return the parsed file, or an empty v1 clock when it is missing, torn or has no numeric version. */
	read(): ClockFile {
		let parsed: unknown;
		try { parsed = JSON.parse(fs.readFileSync(this.paths.file, "utf8")); } catch { return { v: 1, jobs: {} }; }
		if (!parsed || typeof parsed !== "object" || typeof (parsed as { v?: unknown }).v !== "number") return { v: 1, jobs: {} };
		const file = parsed as ClockFile;
		if (file.v > 1) throw new ClockNewer(`clock file version ${file.v} is newer than 1`);
		if (file.v !== 1 || !file.jobs || typeof file.jobs !== "object" || Array.isArray(file.jobs)) return { v: 1, jobs: {} };
		const jobs: Record<string, JobClock> = {};
		for (const [job, value] of Object.entries(file.jobs)) {
			const entry = validEntry(value);
			if (entry) jobs[job] = entry;
		}
		if (!file.rules || typeof file.rules !== "object" || Array.isArray(file.rules)) return { v: 1, jobs };
		const rules: Record<string, GateClock> = {};
		for (const [rule, value] of Object.entries(file.rules)) {
			const entry = validGate(value);
			if (entry) rules[rule] = entry;
		}
		return { v: 1, jobs, rules };
	}
	noteGate(rule: string, last: { at: string; state: PathState }, held: boolean): GateClock | undefined {
		return this.io.locked(this.paths.lock, () => {
			const file = this.read();
			const before = file.rules?.[rule];
			const next: GateClock = { looks: (before?.looks ?? 0) + (held ? 1 : 0), last };
			this.io.write(this.paths.file, JSON.stringify({ ...file, rules: { ...file.rules, [rule]: next } }));
			return before;
		});
	}
	readGate(rule: string): GateClock | undefined {
		return this.read().rules?.[rule];
	}
	advance(move: CursorMove, holds?: () => boolean): Advance {
		return this.io.locked(this.paths.lock, () => {
			const file = this.read();
			const result = advanceClock(file, move, holds ? holds() : true);
			if (result.result === "moved") this.io.write(this.paths.file, JSON.stringify(result.next));
			return result.result;
		});
	}
	closeRun(job: string, close: RunClose): void {
		this.io.locked(this.paths.lock, () => {
			const file = this.read();
			const current = file.jobs[job] ?? { runs: 0 };
			const next: JobClock = { ...current, ...(close.ordinal === undefined ? {} : { runs: Math.max(current.runs, close.ordinal) }), ...(close.fired === undefined || (current.fired && Date.parse(current.fired) >= Date.parse(close.fired)) ? {} : { fired: close.fired }) };
			// A tick that collapsed a slot onto this row and did not move the cursor (it died, or its T3 lost to
			// this closing's `fired`): once the row leaves, nothing else holds that the slot was decided.
			if (close.slot !== undefined && (current.slot === undefined || Date.parse(close.slot) > Date.parse(current.slot))) next.slot = close.slot;
			// A tick that joined the follow-up to this row and died before it took it: the run took its place.
			if (current.followup && close.followups?.includes(current.followup.id)) dropFollowup(next, Date.parse(current.followup.at));
			if (JSON.stringify(next) !== JSON.stringify(current)) this.io.write(this.paths.file, JSON.stringify({ ...file, jobs: { ...file.jobs, [job]: next } }));
		});
	}
	reset(job: string, slot?: string): void {
		this.io.locked(this.paths.lock, () => {
			const file = this.read();
			const current = file.jobs[job];
			if (!current && slot === undefined) return;
			const next = { ...(current ?? { runs: 0 }), ...(slot === undefined ? {} : { slot }) };
			if (slot === undefined) delete next.slot;
			this.io.write(this.paths.file, JSON.stringify({ ...file, jobs: { ...file.jobs, [job]: next } }));
		});
	}
	clear(job: string, at: string): void {
		this.io.locked(this.paths.lock, () => {
			const file = this.read();
			const current = file.jobs[job];
			const next: JobClock = { ...(current ?? { runs: 0 }), cleared: at };
			delete next.note;
			this.io.write(this.paths.file, JSON.stringify({ ...file, jobs: { ...file.jobs, [job]: next } }));
		});
	}
	countCollapse(job: string): void {
		this.io.locked(this.paths.lock, () => {
			const file = this.read();
			const current = file.jobs[job] ?? { runs: 0 };
			this.io.write(this.paths.file, JSON.stringify({ ...file, jobs: { ...file.jobs, [job]: { ...current, collapsed: (current.collapsed ?? 0) + 1 } } }));
		});
	}
	cwdMissing(job: string, since: string | undefined): void {
		this.io.locked(this.paths.lock, () => {
			const file = this.read();
			const current = file.jobs[job];
			if (current?.cwdMissing === since) return;
			const next: JobClock = { ...(current ?? { runs: 0 }) };
			if (since === undefined) delete next.cwdMissing; else next.cwdMissing = since;
			this.io.write(this.paths.file, JSON.stringify({ ...file, jobs: { ...file.jobs, [job]: next } }));
		});
	}
	/**
	 * `wake_me`'s one write: the job's follow-up, and its quiet when `quiet` (cleared when not), so a
	 * second call replaces everything the first set. Returns the follow-up it replaced.
	 */
	setFollowup(job: string, wake: { readonly at: string; readonly note: string; readonly set_by: string }, quiet: boolean, now: number): Followup | undefined {
		return this.io.locked(this.paths.lock, () => {
			const file = this.read();
			const current = file.jobs[job] ?? { runs: 0 };
			const followup: Followup = { id: followupId(job, wake.set_by, wake.at), at: wake.at, note: wake.note, set_by: wake.set_by, created_at: stamp(now) };
			const next: JobClock = { ...current, followup };
			if (quiet) { next.quietUntil = wake.at; next.quietWhy = wake.note; }
			else { delete next.quietUntil; delete next.quietWhy; }
			this.io.write(this.paths.file, JSON.stringify({ ...file, jobs: { ...file.jobs, [job]: next } }));
			return current.followup;
		});
	}
	/** `/cron set <job> --wake -` and the page's ✕: what the loop set goes. Returns whether there was anything. */
	clearWake(job: string): boolean {
		return this.io.locked(this.paths.lock, () => {
			const file = this.read();
			const current = file.jobs[job];
			if (!current || (current.followup === undefined && current.quietUntil === undefined)) return false;
			const next: JobClock = { ...current };
			delete next.followup; delete next.quietUntil; delete next.quietWhy;
			this.io.write(this.paths.file, JSON.stringify({ ...file, jobs: { ...file.jobs, [job]: next } }));
			return true;
		});
	}
	takeFollowup(job: string, id: string, now: number): "moved" | "lost" {
		return this.io.locked(this.paths.lock, () => {
			const file = this.read();
			const current = file.jobs[job];
			if (current?.followup?.id !== id) return "lost";
			const next: JobClock = { ...current };
			dropFollowup(next, now);
			this.io.write(this.paths.file, JSON.stringify({ ...file, jobs: { ...file.jobs, [job]: next } }));
			return "moved";
		});
	}
	seed(entries: Readonly<Record<string, JobClock>>): void {
		this.io.locked(this.paths.lock, () => {
			const file = this.read();
			this.io.write(this.paths.file, JSON.stringify({ ...file, jobs: { ...file.jobs, ...entries } }));
		});
	}
}

export interface SimClockSubject { readonly name: "clock.json"; readonly clock: Clock; read(): ClockFile; forget?(): void; newer?(): void }

/** When a job last fired: a live claim's start wins over the cursor's last closed run. */
export function firedOf(clock: JobClock | undefined, rows: readonly Row[]): string | undefined {
	let latest = clock?.fired;
	for (const row of rows) {
		const at = row.run?.started_at;
		if (at !== undefined && (latest === undefined || Date.parse(at) > Date.parse(latest))) latest = at;
	}
	return latest;
}

export type Mine = { readonly kind: "loop" } | { readonly kind: "plain"; readonly epoch: number };
export interface TickProbe { readonly jobs: readonly LoopJob[]; readonly clock: ClockFile; readonly now: number; readonly mine: ReadonlySet<string> }
/** Name only jobs whose lane and run history this tick must read. */
export function wanted(probe: TickProbe): ReadonlyMap<string, LaneId> {
	const result = new Map<string, LaneId>();
	for (const job of probe.jobs) {
		if (!probe.mine.has(job.id)) continue;
		const lane = job.stateful ? loopLane(job.id) : job.sessionId;
		if (!lane || !isValidSchedule(job.schedule)) continue;
		const clock = probe.clock.jobs[job.id];
		let due: number | undefined;
		try { due = computeDue({ schedule: job.schedule, createdAt: Date.parse(job.createdAt), due: clock?.slot === undefined ? undefined : Date.parse(clock.slot), fired: clock?.fired === undefined ? undefined : Date.parse(clock.fired) }, probe.now); } catch { continue; }
		const maybeDone = job.schedule.kind === "once" && (clock?.slot !== undefined || clock?.fired !== undefined) && !(job.stateful && !job.enabled && (clock?.runs ?? 0) === 0);
		const woken = job.stateful && clock?.followup !== undefined && Date.parse(clock.followup.at) <= probe.now;
		if ((job.enabled && !job.proposed && (due !== undefined || woken)) || maybeDone) result.set(job.id, lane);
	}
	return result;
}

export interface JobRead { readonly rows: readonly CountedRow[]; readonly history: JobHistory | undefined; readonly cwdMissing: boolean }
export interface TickView {
	readonly now: number; readonly startedAt: number; readonly tickMs: number; readonly catchUp: boolean; readonly kind: "background" | "window"; readonly self: Row["created_by"];
	readonly budgetOver: boolean; readonly mine: ReadonlyMap<string, Mine>; readonly read: ReadonlyMap<string, JobRead>;
}
export interface TickInput { readonly jobs: readonly LoopJob[]; readonly clock: ClockFile; readonly view: TickView }
interface SlotSpend { readonly job: string; readonly lane: LaneId; readonly slot: string; readonly read: CursorRead; readonly at: string; readonly owner: { readonly kind: "loop" } | { readonly kind: "plain"; readonly session: string; readonly epoch: number } }
export type SpendDecision =
	| (SlotSpend & { readonly do: "row"; readonly row: UnclaimedRow; readonly replaces?: string; readonly missed?: string })
	| (SlotSpend & { readonly do: "collapse"; readonly onto: string; readonly overlap: boolean })
	| (SlotSpend & { readonly do: "cursor"; readonly why: "own-row" | "spent" })
	| (SlotSpend & { readonly do: "skip"; readonly note: string });
/**
 * A loop's follow-up that came due: its row, its note added to the loop's queued row (the slot's row
 * this tick writes, or one that waits), or nothing to write when its row is queued or ran already (a
 * tick that crashed before it took the follow-up). Then the follow-up goes (`Clock.takeFollowup`).
 */
export type FollowupDecision = { readonly do: "followup"; readonly job: string; readonly lane: LaneId; readonly followup: Followup } & (
	| { readonly write: "row"; readonly row: UnclaimedRow }
	| { readonly write: "onto"; readonly onto: string }
	| { readonly write: "none"; readonly why: "own-row" | "spent" });
export type Pass = "not-mine" | "disabled" | "proposed" | "no-lane" | "not-due" | "unread" | "running" | "budget" | "not-a-loop-id";
export type TickDecision = SpendDecision | FollowupDecision | { readonly do: "disable"; readonly job: string; readonly disabled: Disabled } | { readonly do: "retire"; readonly job: string } | { readonly do: "pass"; readonly job: string; readonly why: Pass };

const T3_WRITES: Record<SpendDecision["do"], Record<"loop" | "plain", { readonly fired: boolean; readonly fires: boolean }>> = {
	row: { loop: { fired: false, fires: false }, plain: { fired: true, fires: true } },
	cursor: { loop: { fired: false, fires: false }, plain: { fired: true, fires: true } },
	collapse: { loop: { fired: false, fires: false }, plain: { fired: true, fires: false } },
	skip: { loop: { fired: false, fires: false }, plain: { fired: false, fires: false } },
};
/** Derive T3's cursor update from the chosen T2 arm and job kind. */
export function cursorMove(decision: SpendDecision): CursorMove {
	const write = T3_WRITES[decision.do][decision.owner.kind];
	return { job: decision.job, read: decision.read, slot: decision.slot, ...(write.fired ? { fired: decision.at } : {}), fires: write.fires, ...(decision.do === "collapse" && decision.overlap ? { collapsed: true } : {}), ...(decision.do === "skip" ? { note: { at: decision.at, text: decision.note } } : decision.do === "row" || decision.do === "cursor" ? { note: null } : {}) };
}

const AFTER_OWN_ROW = { loop: ["collapse", "missed"], plain: ["missed", "collapse"] } as const;
/** Make one total, pure decision for every job in input order, and after it the job's follow-up when one came due. */
export function decideTick(input: TickInput): TickDecision[] {
	return input.jobs.flatMap((job): TickDecision[] => {
		const slot = decideSlot(job, input);
		const woken = decideFollowup(job, input, slot);
		return woken ? [slot, woken] : [slot];
	});
}

/** A loop's follow-up whose time came, or undefined. The tick passes over it as over the loop's slot: a disabled or proposed loop's follow-up waits. */
function decideFollowup(job: LoopJob, input: TickInput, slot: TickDecision): FollowupDecision | undefined {
	const { view, clock } = input;
	const followup = clock.jobs[job.id]?.followup;
	if (!followup || Date.parse(followup.at) > view.now) return undefined;
	if (!job.stateful || view.mine.get(job.id)?.kind !== "loop" || job.proposed || !job.enabled) return undefined;
	const lane = loopLane(job.id);
	const data = view.read.get(job.id);
	if (!lane || !data) return undefined;
	const at = { do: "followup" as const, job: job.id, lane, followup };
	// Its row, or the row it joined, is queued or running, or its own row ran and left: the tick before
	// wrote it and died before it took the follow-up (T2). A joined row's closing takes it (`closeRun`).
	if (data.rows.some((row) => row.id === followup.id || row.payload?.woken_ids?.includes(followup.id))) return { ...at, write: "none", why: "own-row" };
	if (data.history?.spent.has(followup.id)) return { ...at, write: "none", why: "spent" };
	// The slot's collapse key: one run then has both reasons. A run that started already read its prompt.
	if (slot.do === "row") return { ...at, write: "onto", onto: slot.row.id };
	const queued = data.rows.find((row) => row.kind === "input" && !row.run && row.lane === lane && row.collapse_key === plainCollapseKey(job.id));
	if (queued) return { ...at, write: "onto", onto: queued.id };
	const history = data.history;
	const wait = failurePause(history?.streak ?? 0);
	const base = plainJobRow(job, followup.id, `cron:${job.id}`, "", view.self, view.now);
	const row: UnclaimedRow = { ...base, lane, source: `wake:${job.id}`, mode: "unattended", payload: { ...base.payload!, woken: [followup.note], woken_ids: [followup.id] }, ...(wait && history?.failed ? { not_before: stamp(Date.parse(history.failed.at) + wait) } : {}) };
	return { ...at, write: "row", row };
}

function decideSlot(job: LoopJob, input: TickInput): TickDecision {
	const { view, clock } = input;
	const mine = view.mine.get(job.id);
	if (!mine) return { do: "pass", job: job.id, why: "not-mine" };
	const entry = clock.jobs[job.id];
	const readCursor = { ...(entry?.slot === undefined ? {} : { slot: entry.slot }), ...(entry?.fired === undefined ? {} : { fired: entry.fired }) };
	const data = view.read.get(job.id);
	if (job.schedule.kind === "once" && (entry?.slot !== undefined || entry?.fired !== undefined)) {
		if (!data) return { do: "pass", job: job.id, why: "unread" };
		const status = jobStatus(job, entry, data.rows, data.history, view.now);
		if (oneShotDoneV3(job, status)) return { do: "retire", job: job.id };
	}
	if (job.stateful && !loopLane(job.id)) return { do: "pass", job: job.id, why: "not-a-loop-id" };
	if (job.proposed) return { do: "pass", job: job.id, why: "proposed" };
	if (!job.enabled) return { do: "pass", job: job.id, why: "disabled" };
	if (!isValidSchedule(job.schedule)) return { do: "disable", job: job.id, disabled: { code: "schedule", why: "disabled: unusable schedule", at: stamp(view.now) } };
	const lane = job.stateful ? loopLane(job.id) : job.sessionId;
	if (!lane) return { do: "pass", job: job.id, why: "no-lane" };
	if (!data) return { do: "pass", job: job.id, why: "unread" };
	const jobRows = data.rows.filter((row) => job.stateful ? row.lane === lane : row.collapse_key === plainCollapseKey(job.id));
	const liveFired = firedOf(entry, jobRows);
	let slot: number | undefined;
	try { slot = computeDue({ schedule: job.schedule, createdAt: Date.parse(job.createdAt), due: entry?.slot === undefined ? undefined : Date.parse(entry.slot), fired: liveFired === undefined ? undefined : Date.parse(liveFired) }, view.now); }
	catch (error) { return { do: "disable", job: job.id, disabled: { code: "schedule", why: `disabled: ${error instanceof Error ? error.message : String(error)}`, at: stamp(view.now) } }; }
	// An every schedule counts from `fired`, which a loop's collapse and a skip leave as they were: the same slot comes back, and the cursor already stands on it.
	if (slot === undefined || (entry?.slot !== undefined && slot <= Date.parse(entry.slot))) return { do: "pass", job: job.id, why: "not-due" };
	const mineKind = mine.kind;
	const owner = mineKind === "loop" ? mine : { kind: "plain" as const, session: job.sessionId!, epoch: mine.epoch };
	const spend: SlotSpend = { job: job.id, lane, slot: stamp(slot), read: readCursor, at: stamp(view.now), owner };
	if (mineKind === "plain" && data.rows.some((row) => row.kind === "input" && row.collapse_key === plainCollapseKey(job.id) && row.run)) return { do: "pass", job: job.id, why: "running" };
	const id = plainRunId(job.id, spend.slot);
	if (data.rows.some((row) => row.id === id)) return { ...spend, do: "cursor", why: "own-row" };
	if (data.history?.spent.has(id)) return { ...spend, do: "cursor", why: "spent" };
	// The loop asked for no scheduled run before this time (`wake_me` with quiet): the slot is decided, and nothing runs.
	if (mineKind === "loop" && entry?.quietUntil !== undefined && slot < Date.parse(entry.quietUntil)) return { ...spend, do: "skip", note: `quiet until ${formatLocal(Date.parse(entry.quietUntil))}, asked by the loop: "${entry.quietWhy ?? ""}"` };
	const queued = data.rows.filter((row) => row.kind === "input" && row.collapse_key === plainCollapseKey(job.id));
	const refused = view.kind === "window" ? queued.find((row) => row.id !== id && row.attempts > 0 && row.source.startsWith("cron:")) : undefined;
	const collapseTarget = queued.find((row) => row !== refused && !(view.kind === "background" && row.mode === "attended"));
	const missed = slot < view.startedAt - view.tickMs ? stamp(slot) : undefined;
	for (const rule of AFTER_OWN_ROW[mineKind]) {
		if (rule === "missed" && missed && !(view.catchUp && job.catchUp)) return { ...spend, do: "skip", note: `missed ${formatLocal(slot)} while ${view.kind === "background" ? "pi-loops was not running" : "no pi was running"} (catch-up disabled)` };
		if (rule === "missed" && missed && mineKind === "plain" && view.budgetOver) return { do: "pass", job: job.id, why: "budget" };
		if (rule === "collapse" && mineKind === "plain" && view.budgetOver) return { do: "pass", job: job.id, why: "budget" };
		if (rule === "collapse" && collapseTarget) return { ...spend, do: "collapse", onto: collapseTarget.id, overlap: mineKind === "plain" || !!collapseTarget.run };
	}
	const streak = data.history?.streak ?? 0;
	const wait = job.stateful || view.kind === "background" ? failurePause(streak) : 0;
	const not_before = wait ? stamp(Date.parse(data.history!.failed!.at) + wait) : undefined;
	const base = plainJobRow(job, id, `cron:${job.id}`, missed && mineKind === "plain" ? `\n(catching up a run due ${formatLocal(slot)})` : "", view.self, view.now);
	const row: UnclaimedRow = { ...base, lane, payload: { ...base.payload!, slot: spend.slot, ...(missed && mineKind === "loop" ? { catch_up: true } : {}) } as UnclaimedRow["payload"], ...(not_before ? { not_before } : {}) };
	return { ...spend, do: "row", row, ...(refused ? { replaces: refused.id } : {}), ...(missed && view.catchUp && job.catchUp ? { missed } : {}) };
}

export interface TickStores { readonly requests: Pick<RequestStore, "appendIfAbsent" | "remove" | "addFollowup"> & { collapse(lane: LaneId, id: string, slot: string, overlap?: boolean): "counted" | "counted-before" | "missing" }; readonly clock: Clock; heldEpoch(sessionId: string): number | undefined }
export type T2 = "wrote" | "there" | "counted" | "counted-before" | "missing" | "nothing";
const written: unique symbol = Symbol("written");
export interface SlotWritten { readonly decision: SpendDecision; readonly t2: T2; readonly [written]: true }
export type TickOutcome =
	| { readonly job: string; readonly slot: string; readonly t2: T2; readonly t3: Advance | "not-written" }
	| { readonly job: string; readonly followup: string; readonly t2: FollowupT2; readonly t3: "moved" | "lost" | "not-written" }
	| { readonly job: string; readonly decided: "disable" | "retire" | "pass" }
	| { readonly job: string; readonly failed: string };
/** Apply T2 under the request store's lane lock. */
export function writeSlot(decision: SpendDecision, stores: Pick<TickStores, "requests">): SlotWritten {
	let t2: T2 = "nothing";
	if (decision.do === "row") {
		if (decision.replaces) stores.requests.remove(decision.lane, [decision.replaces]);
		t2 = stores.requests.appendIfAbsent(decision.row) ? "wrote" : "there";
	}
	else if (decision.do === "collapse") t2 = stores.requests.collapse(decision.lane, decision.onto, decision.slot, decision.overlap);
	return { decision, t2, [written]: true };
}
/** Apply T3 after T2. A lost move leaves every T2 row in place. */
export function commitSlot(slot: SlotWritten, stores: Pick<TickStores, "clock" | "heldEpoch">): TickOutcome {
	const { decision, t2 } = slot;
	// The row the slot collapsed onto left before T2: nothing holds the slot, so the cursor stays and the next tick decides it again.
	if (t2 === "missing") return { job: decision.job, slot: decision.slot, t2, t3: "not-written" };
	const owner = decision.owner;
	const holds = owner.kind === "plain" ? () => stores.heldEpoch(owner.session) === owner.epoch : undefined;
	const t3 = stores.clock.advance(cursorMove(decision), holds);
	return { job: decision.job, slot: decision.slot, t2, t3 };
}
export type FollowupT2 = "wrote" | "there" | "added" | "gone" | "missing" | "nothing";
/**
 * A follow-up's two writes: its row (or its note and id on the loop's queued row) under the lane's
 * lock, then the follow-up taken out of `clock.json`. A crash between leaves the follow-up, and the
 * next tick finds its id on a row, or its own row's run in the log, and only takes it (the T2 case).
 */
export function writeFollowup(decision: FollowupDecision, stores: Pick<TickStores, "requests" | "clock">): FollowupT2 {
	if (decision.write === "none") return "nothing";
	const { job, followup } = decision;
	// Checked under the lane's lock: a tick that read before another tick or a closing took the follow-up writes nothing.
	return stores.requests.addFollowup(decision.lane, followup, decision.write === "row" ? { row: decision.row } : { onto: decision.onto }, () => stores.clock.read().jobs[job]?.followup?.id === followup.id);
}
export function commitFollowup(decision: FollowupDecision, t2: FollowupT2, stores: Pick<TickStores, "clock">, now: number): TickOutcome {
	// The row it was to join left before T2: the follow-up stays, and the next tick decides it again. A follow-up that is gone has nothing to take.
	if (t2 === "missing" || t2 === "gone") return { job: decision.job, followup: decision.followup.id, t2, t3: "not-written" };
	return { job: decision.job, followup: decision.followup.id, t2, t3: stores.clock.takeFollowup(decision.job, decision.followup.id, now) };
}
export function applyFollowup(decision: FollowupDecision, stores: Pick<TickStores, "requests" | "clock">, now: number): TickOutcome {
	return commitFollowup(decision, writeFollowup(decision, stores), stores, now);
}
/** Apply each job's T2 and T3 in order. A failed job does not stop the others. */
export function applyTick(decisions: readonly TickDecision[], stores: TickStores, now = Date.now()): TickOutcome[] {
	return decisions.map((decision) => {
		if (decision.do === "pass" || decision.do === "disable" || decision.do === "retire") return { job: decision.job, decided: decision.do };
		try { return decision.do === "followup" ? applyFollowup(decision, stores, now) : commitSlot(writeSlot(decision, stores), stores); }
		catch (error) { return { job: decision.job, failed: error instanceof Error ? error.message : String(error) }; }
	});
}

export interface TickScope {
	readonly kind: "background" | "window";
	readonly self: Row["created_by"];
	readonly startedAt: number;
	readonly tickMs: number;
	readonly catchUp: boolean;
	readonly budgetOver: boolean;
	mine(job: LoopJob): Mine | undefined;
}
export interface TickSources {
	book(): Book;
	history(): ReadonlyMap<string, JobHistory>;
	readonly requests: Pick<RequestStore, "list" | "appendIfAbsent" | "remove" | "collapse" | "addFollowup">;
	readonly clock: Clock;
	proof(lane: LaneId): import("./engine.ts").Proof;
	cwdExists(cwd: string): boolean;
	heldEpoch(sessionId: string): number | undefined;
	/**
	 * Whether the process that claimed a row still runs it. Absent: every claim is live. A loop's row whose
	 * claim is dead is owed again, so a slot that comes due beside it collapses onto it as onto a queued
	 * row, and counts no skipped overlap: main clears a dead run's marker before it decides the tick.
	 */
	claimLive?(row: import("./requests.ts").ClaimedRow): boolean;
}
export interface Ticked { readonly decision: TickDecision; readonly outcome: TickOutcome }

/** Read the due lanes, decide each job, then apply its row and cursor writes synchronously. */
function clockPass(scope: TickScope, sources: TickSources, now: number): { readonly ticked: Ticked[]; readonly jobs: ReadonlyMap<string, LoopJob> } {
	const { jobs, clock } = sources.book();
	const mine = new Map<string, Mine>();
	for (const job of jobs) {
		const owner = scope.mine(job);
		if (owner) mine.set(job.id, owner);
	}
	const byId = new Map(jobs.map((job) => [job.id, job]));
	const lanes = wanted({ jobs, clock, now, mine: new Set(mine.keys()) });
	if (!lanes.size) return { ticked: [], jobs: byId };
	const rowsByLane = new Map<LaneId, readonly CountedRow[]>();
	for (const lane of lanes.values()) {
		if (!rowsByLane.has(lane)) {
			const proof = sources.proof(lane);
			rowsByLane.set(lane, sources.requests.list(lane).filter((row) => !landed(row, proof)) as CountedRow[]);
		}
	}
	const history = sources.history();
	const read = new Map<string, JobRead>();
	for (const [id, lane] of lanes) {
		const job = jobs.find((item) => item.id === id)!;
		const rows = rowsByLane.get(lane) ?? [];
		const live = sources.claimLive;
		read.set(id, { rows: job.stateful && live ? rows.map((row) => row.run && !live(row as import("./requests.ts").ClaimedRow) ? { ...row, run: undefined } : row) : rows, history: history.get(id), cwdMissing: job.stateful && !sources.cwdExists(job.cwd) });
	}
	const decisions = decideTick({ jobs, clock, view: { now, startedAt: scope.startedAt, tickMs: scope.tickMs, catchUp: scope.catchUp, kind: scope.kind, self: scope.self, budgetOver: scope.budgetOver, mine, read } });
	const outcomes = applyTick(decisions, { requests: sources.requests, clock: sources.clock, heldEpoch: sources.heldEpoch }, now);
	return { ticked: decisions.map((decision, i) => ({ decision, outcome: outcomes[i] })), jobs: byId };
}

export function tickClock(scope: TickScope, sources: TickSources, now: number): Ticked[] {
	return clockPass(scope, sources, now).ticked;
}

export interface TickSinks {
	readonly jobs: Pick<JobStore, "remove"> & { disable(id: string, disabled: Disabled): Promise<unknown> };
	rowWritten?(row: UnclaimedRow, job: LoopJob): void;
	caughtUp?(job: LoopJob, slot: string): void;
	retired?(job: LoopJob, reason: string): void;
	budgetHeld?(job: LoopJob): void;
	log(message: string, level?: "info" | "warning", job?: Pick<LoopJob, "cwd">): void;
}

/** Apply the tick's non-clock side effects, continuing after each job's failure. */
export async function runClockTick(scope: TickScope, sources: TickSources, sinks: TickSinks, now: number): Promise<void> {
	const { ticked, jobs } = clockPass(scope, sources, now);
	for (const { decision, outcome } of ticked) {
		const job = jobs.get(decision.job);
		if (!job) continue;
		try {
			if ((decision.do === "row" || (decision.do === "followup" && decision.write === "row")) && "t2" in outcome && outcome.t2 === "wrote") sinks.rowWritten?.(decision.row, job);
			if (decision.do === "row" && decision.missed && "t3" in outcome && outcome.t3 === "moved" && scope.kind === "background") sinks.caughtUp?.(job, decision.missed);
		} catch (error) {
			sinks.log(`clock ${job.name ?? job.id} sink failed: ${error instanceof Error ? error.message : String(error)}`, "warning", job);
		}
	}
	for (const { decision, outcome } of ticked) {
		const job = jobs.get(decision.job);
		if (!job) continue;
		try {
			if (decision.do === "retire") {
				await sinks.jobs.remove(job.id);
				sinks.retired?.(job, "one-shot finished");
			} else if (decision.do === "disable") {
				await sinks.jobs.disable(job.id, decision.disabled);
				sinks.log(`${job.name ?? job.id}: ${decision.disabled.why}`, "warning", job);
			} else if (decision.do === "pass" && decision.why === "budget") sinks.budgetHeld?.(job);
			if ("failed" in outcome) sinks.log(`clock ${job.name ?? job.id}: ${outcome.failed}`, "warning", job);
		} catch (error) {
			sinks.log(`clock ${job.name ?? job.id} failed: ${error instanceof Error ? error.message : String(error)}`, "warning", job);
		}
	}
}

export type RunNow = { readonly refused: string } | { readonly row: UnclaimedRow; readonly move: CursorMove; readonly session: string; readonly epoch: number };

/** Decide a plain job's immediate run without changing its scheduled slot. */
export function decideRunNow(job: LoopJob | undefined, clock: JobClock | undefined, rows: readonly Row[], scope: Pick<TickScope, "kind" | "self"> & { readonly view: OwnerView; readonly epoch: number | undefined }, now: number): RunNow {
	if (!job) return { refused: "is no longer in the store" };
	if (rows.some((row) => row.kind === "input" && row.collapse_key === plainCollapseKey(job.id) && row.run)) return { refused: "is already running" };
	if (job.proposed) return { refused: `is proposed and waits for your yes: /cron enable ${job.name ?? job.id} asks again` };
	if (!job.enabled) return { refused: "is disabled (/cron enable it first)" };
	const where = whereRuns(job, scope.view);
	if (where.kind === "aside") return { refused: "belongs to this conversation, but this window shows an older copy of it — /resume this session to run it" };
	if (where.kind === "terminal") return { refused: `belongs to session ${ownerSession(job)}, which is ${openWhere(where.page ? "page" : "terminal")} — run it there` };
	if (where.kind === "host") return { refused: `belongs to session ${ownerSession(job)}, which is closed: it runs in the background when due — resume that session to run it now` };
	if (where.kind !== "here") return { refused: `belongs to session ${ownerSession(job)}, which is not open here — resume it, or /cron add the job again in this chat` };
	const session = scope.view.sessionId;
	if (!session || scope.epoch === undefined) return { refused: "has no chat to run in (pi-loops in the background has no session)" };
	if (rows.some((row) => row.kind === "input" && row.collapse_key === plainCollapseKey(job.id) && !row.run)) return { refused: "already has its prompt queued in this conversation" };
	const at = stamp(now);
	const id = plainRunId(job.id, at);
	const row = plainJobRow(job, id, `cron-run:${job.id}`, "", scope.self, now);
	return { row, session, epoch: scope.epoch, move: { job: job.id, read: { ...(clock?.slot === undefined ? {} : { slot: clock.slot }), ...(clock?.fired === undefined ? {} : { fired: clock.fired }) }, fired: at, fires: true, note: null } };
}
