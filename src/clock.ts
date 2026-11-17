import * as fs from "node:fs";
import * as path from "node:path";
import { DEAD_AFTER_ATTEMPTS, failurePause } from "./backoff.ts";
import { landed, plainCollapseKey, plainJobRow, plainRunId } from "./engine.ts";
import { loopLane, type LaneId } from "./lane.ts";
import { openWhere, ownerSession, whereRuns, type OwnerView } from "./job-owner.ts";
import type { LockOptions } from "./lock.ts";
import type { RequestStore, Row, UnclaimedRow } from "./requests.ts";

type CountedRow = Row & { collapsed?: number; collapsed_slot?: string };
import { computeDue, formatLocal, isValidSchedule, stamp } from "./schedule.ts";
import type { Disabled, JobStore, LoopJob, LoopJobV3, RunRecord } from "./store.ts";
import { fromV2, jobStatus, runHistory, type JobHistory } from "./job-status.ts";
import { oneShotDoneV3 } from "./settle.ts";
import type { Book } from "./stores.ts";

/** A clock decision that was not a run, for the job's status. */
export interface ClockNote { at: string; text: string }
/** One job's schedule cursor and run floor. */
export interface JobClock { slot?: string; fired?: string; runs: number; note?: ClockNote; collapsed?: number; cleared?: string }
/** The versioned clock file. Unknown job keys are preserved by writes. */
export interface ClockFile { v: 1; jobs: Record<string, JobClock> }
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
export interface RunClose { readonly ordinal?: number; readonly fired?: string }
export interface Clock {
	advance(move: CursorMove, holds?: () => boolean): Advance;
	closeRun(job: string, close: RunClose): void;
	reset(job: string, slot?: string): void;
	clear(job: string, at: string): void;
}
/** The file belongs to a newer version and must not be replaced. */
export class ClockNewer extends Error {}

function validStamp(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }

/** Drop malformed entries while preserving the valid jobs in the clock file. */
export function validEntry(value: unknown): JobClock | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entry = value as Record<string, unknown>;
	if (!Number.isInteger(entry.runs) || (entry.runs as number) < 0) return undefined;
	if (entry.slot !== undefined && !validStamp(entry.slot)) return undefined;
	if (entry.fired !== undefined && !validStamp(entry.fired)) return undefined;
	if (entry.cleared !== undefined && !validStamp(entry.cleared)) return undefined;
	if (entry.collapsed !== undefined && (!Number.isInteger(entry.collapsed) || (entry.collapsed as number) < 0)) return undefined;
	if (entry.note !== undefined && (!entry.note || typeof entry.note !== "object" || Array.isArray(entry.note) || !validStamp((entry.note as ClockNote).at) || typeof (entry.note as ClockNote).text !== "string")) return undefined;
	return value as JobClock;
}

/** The clock file and its lock. Scheduling and lease decisions stay outside this store. */
export class ClockStore implements Clock {
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
		return { v: 1, jobs };
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
			const next = { ...current, ...(close.ordinal === undefined ? {} : { runs: Math.max(current.runs, close.ordinal) }), ...(close.fired === undefined || (current.fired && Date.parse(current.fired) >= Date.parse(close.fired)) ? {} : { fired: close.fired }) };
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
			const next = { ...(current ?? { runs: 0 }), cleared: at };
			this.io.write(this.paths.file, JSON.stringify({ ...file, jobs: { ...file.jobs, [job]: next } }));
		});
	}
	seed(entries: Readonly<Record<string, JobClock>>): void {
		this.io.locked(this.paths.lock, () => {
			const file = this.read();
			this.io.write(this.paths.file, JSON.stringify({ ...file, jobs: { ...file.jobs, ...entries } }));
		});
	}
}

/** The version 2 jobs file as the cursor store for this transition. */
export function v2Clock(jobs: Pick<JobStore, "load" | "mutateSync">): Clock {
	const read = (job: LoopJob): JobClock => ({
		...(job.lastDueAt === undefined ? {} : { slot: job.lastDueAt }),
		...(job.lastFiredAt === undefined ? {} : { fired: job.lastFiredAt }),
		runs: job.runCount,
		...(job.lastError && job.enabled ? { note: { at: job.lastDueAt ?? job.createdAt, text: job.lastError } } : {}),
		...(job.skippedOverlap ? { collapsed: job.skippedOverlap } : {}),
		...("clearedAt" in job && typeof job.clearedAt === "string" ? { cleared: job.clearedAt } : {}),
	});
	return {
		advance(move, holds) {
			if (holds && !holds()) return "not-holder";
			return jobs.mutateSync((all) => {
				const job = all.find((item) => item.id === move.job);
				if (!job) return { jobs: all, result: "lost" as const };
				const current = read(job);
				if (current.slot !== move.read.slot || current.fired !== move.read.fired) return { jobs: all, result: "lost" as const };
				if (move.slot !== undefined) job.lastDueAt = move.slot;
				job.runCount += move.fires ? 1 : 0;
				if (move.collapsed) job.skippedOverlap++;
				if (move.fired !== undefined) job.lastFiredAt = move.fired;
				if (move.note === null) delete job.lastError;
				else if (move.note) job.lastError = move.note.text;
				return { jobs: all, result: "moved" as const };
			});
		},
		closeRun(id, close) {
			jobs.mutateSync((all) => {
				const job = all.find((item) => item.id === id);
				if (!job) return { jobs: all, result: undefined };
				if (close.ordinal !== undefined) job.runCount = Math.max(job.runCount, close.ordinal);
				if (close.fired !== undefined && (!job.lastFiredAt || Date.parse(job.lastFiredAt) < Date.parse(close.fired))) job.lastFiredAt = close.fired;
				return { jobs: all, result: undefined };
			});
		},
		reset(id, slot) {
			jobs.mutateSync((all) => {
				const job = all.find((item) => item.id === id);
				if (!job) return { jobs: all, result: undefined };
				if (slot === undefined) delete job.lastDueAt; else job.lastDueAt = slot;
				return { jobs: all, result: undefined };
			});
		},
		clear(id, at) {
			jobs.mutateSync((all) => {
				const job = all.find((item) => item.id === id);
				if (!job) return { jobs: all, result: undefined };
				(job as LoopJob & { clearedAt?: string }).clearedAt = at;
				delete job.lastError;
				return { jobs: all, result: undefined };
			});
		},
	};
}

export interface SimClockSubject { readonly name: "clock.json" | "jobs.json v2"; readonly clock: Clock; read(): ClockFile; forget?(): void; newer?(): void }

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
export interface TickProbe { readonly jobs: readonly LoopJobV3[]; readonly clock: ClockFile; readonly now: number; readonly mine: ReadonlySet<string> }
/** Name only jobs whose lane and run history this tick must read. */
export function wanted(probe: TickProbe): ReadonlyMap<string, LaneId> {
	const result = new Map<string, LaneId>();
	for (const job of probe.jobs) {
		if (!probe.mine.has(job.id)) continue;
		const lane = job.stateful ? loopLane(job.id) : job.sessionId;
		if (!lane || !isValidSchedule(job.schedule)) continue;
		const clock = probe.clock.jobs[job.id];
		let due: number | undefined;
		try { due = computeDue({ schedule: job.schedule, createdAt: Date.parse(job.createdAt), lastDueAt: clock?.slot === undefined ? undefined : Date.parse(clock.slot), lastFiredAt: clock?.fired === undefined ? undefined : Date.parse(clock.fired) }, probe.now); } catch { continue; }
		const maybeDone = job.schedule.kind === "once" && (clock?.slot !== undefined || clock?.fired !== undefined) && !(job.stateful && !job.enabled && (clock?.runs ?? 0) === 0);
		if ((job.enabled && !job.proposed && due !== undefined) || maybeDone) result.set(job.id, lane);
	}
	return result;
}

export interface JobRead { readonly rows: readonly CountedRow[]; readonly history: JobHistory | undefined; readonly cwdMissing: boolean }
export interface TickView {
	readonly now: number; readonly startedAt: number; readonly tickMs: number; readonly catchUp: boolean; readonly kind: "background" | "window"; readonly self: Row["created_by"];
	readonly budgetOver: boolean; readonly mine: ReadonlyMap<string, Mine>; readonly read: ReadonlyMap<string, JobRead>;
}
export interface TickInput { readonly jobs: readonly LoopJobV3[]; readonly clock: ClockFile; readonly view: TickView }
interface SlotSpend { readonly job: string; readonly lane: LaneId; readonly slot: string; readonly read: CursorRead; readonly at: string; readonly owner: { readonly kind: "loop" } | { readonly kind: "plain"; readonly session: string; readonly epoch: number } }
export type SpendDecision =
	| (SlotSpend & { readonly do: "row"; readonly row: UnclaimedRow; readonly replaces?: string; readonly missed?: string })
	| (SlotSpend & { readonly do: "collapse"; readonly onto: string; readonly overlap: boolean })
	| (SlotSpend & { readonly do: "cursor"; readonly why: "own-row" | "spent" })
	| (SlotSpend & { readonly do: "skip"; readonly note: string });
export type Pass = "not-mine" | "disabled" | "proposed" | "no-lane" | "not-due" | "unread" | "running" | "budget" | "not-a-loop-id";
export type TickDecision = SpendDecision | { readonly do: "disable"; readonly job: string; readonly disabled: Disabled } | { readonly do: "retire"; readonly job: string } | { readonly do: "pass"; readonly job: string; readonly why: Pass };

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
/** Make one total, pure decision for every job in input order. */
export function decideTick(input: TickInput): TickDecision[] {
	const { view, clock } = input;
	return input.jobs.map((job): TickDecision => {
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
		try { slot = computeDue({ schedule: job.schedule, createdAt: Date.parse(job.createdAt), lastDueAt: entry?.slot === undefined ? undefined : Date.parse(entry.slot), lastFiredAt: liveFired === undefined ? undefined : Date.parse(liveFired) }, view.now); }
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
	});
}

export interface TickStores { readonly requests: Pick<RequestStore, "appendIfAbsent" | "remove"> & { collapse(lane: LaneId, id: string, slot: string): "counted" | "counted-before" | "missing" }; readonly clock: Clock; heldEpoch(sessionId: string): number | undefined }
export type T2 = "wrote" | "there" | "counted" | "counted-before" | "missing" | "nothing";
const written: unique symbol = Symbol("written");
export interface SlotWritten { readonly decision: SpendDecision; readonly t2: T2; readonly [written]: true }
export type TickOutcome =
	| { readonly job: string; readonly slot: string; readonly t2: T2; readonly t3: "moved" }
	| { readonly job: string; readonly slot: string; readonly t2: T2; readonly t3: "lost" | "not-holder" | "not-written" }
	| { readonly job: string; readonly decided: "disable" | "retire" | "pass" }
	| { readonly job: string; readonly failed: string };
/** Apply T2 under the request store's lane lock. */
export function writeSlot(decision: SpendDecision, stores: Pick<TickStores, "requests">): SlotWritten {
	let t2: T2 = "nothing";
	if (decision.do === "row") {
		if (decision.replaces) stores.requests.remove(decision.lane, [decision.replaces]);
		t2 = stores.requests.appendIfAbsent(decision.row) ? "wrote" : "there";
	}
	else if (decision.do === "collapse") t2 = stores.requests.collapse(decision.lane, decision.onto, decision.slot);
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
/** Apply each job's T2 and T3 in order. A failed job does not stop the others. */
export function applyTick(decisions: readonly TickDecision[], stores: TickStores): TickOutcome[] {
	return decisions.map((decision) => {
		if (decision.do === "pass" || decision.do === "disable" || decision.do === "retire") return { job: decision.job, decided: decision.do };
		try { return commitSlot(writeSlot(decision, stores), stores); }
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
	mine(job: LoopJobV3): Mine | undefined;
}
export interface TickSources {
	book(): Book;
	history(): ReadonlyMap<string, JobHistory>;
	readonly requests: Pick<RequestStore, "list" | "appendIfAbsent" | "remove" | "collapse">;
	readonly clock: Clock;
	proof(lane: LaneId): import("./engine.ts").Proof;
	cwdExists(cwd: string): boolean;
	heldEpoch(sessionId: string): number | undefined;
}
export interface Ticked { readonly decision: TickDecision; readonly outcome: TickOutcome }

/** Read the due lanes, decide each job, then apply its row and cursor writes synchronously. */
function clockPass(scope: TickScope, sources: TickSources, now: number): { readonly ticked: Ticked[]; readonly jobs: ReadonlyMap<string, LoopJobV3> } {
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
		read.set(id, { rows: rowsByLane.get(lane) ?? [], history: history.get(id), cwdMissing: job.stateful && !sources.cwdExists(job.cwd) });
	}
	const decisions = decideTick({ jobs, clock, view: { now, startedAt: scope.startedAt, tickMs: scope.tickMs, catchUp: scope.catchUp, kind: scope.kind, self: scope.self, budgetOver: scope.budgetOver, mine, read } });
	const outcomes = applyTick(decisions, { requests: sources.requests, clock: sources.clock, heldEpoch: sources.heldEpoch });
	return { ticked: decisions.map((decision, i) => ({ decision, outcome: outcomes[i] })), jobs: byId };
}

export function tickClock(scope: TickScope, sources: TickSources, now: number): Ticked[] {
	return clockPass(scope, sources, now).ticked;
}

export interface TickSinks {
	readonly jobs: Pick<JobStore, "remove"> & { disable(id: string, disabled: Disabled): Promise<unknown> };
	rowWritten?(row: UnclaimedRow, job: LoopJobV3): void;
	caughtUp?(job: LoopJobV3, slot: string): void;
	retired?(job: LoopJobV3, reason: string): void;
	budgetHeld?(job: LoopJobV3): void;
	log(message: string, level?: "info" | "warning", job?: Pick<LoopJobV3, "cwd">): void;
}

/** Apply the tick's non-clock side effects, continuing after each job's failure. */
export async function runClockTick(scope: TickScope, sources: TickSources, sinks: TickSinks, now: number): Promise<void> {
	const { ticked, jobs } = clockPass(scope, sources, now);
	for (const { decision, outcome } of ticked) {
		const job = jobs.get(decision.job);
		if (!job) continue;
		try {
			if (decision.do === "row" && "t2" in outcome && outcome.t2 === "wrote") sinks.rowWritten?.(decision.row, job);
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
export function decideRunNow(job: LoopJobV3 | undefined, clock: JobClock | undefined, rows: readonly Row[], scope: Pick<TickScope, "kind" | "self"> & { readonly view: OwnerView; readonly epoch: number | undefined }, now: number): RunNow {
	if (!job) return { refused: "is no longer in the store" };
	if (rows.some((row) => row.kind === "input" && row.collapse_key === plainCollapseKey(job.id) && row.run)) return { refused: "is already running" };
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
