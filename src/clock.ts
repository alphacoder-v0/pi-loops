import * as fs from "node:fs";
import * as path from "node:path";
import { DEAD_AFTER_ATTEMPTS, failurePause } from "./backoff.ts";
import { plainCollapseKey, plainJobRow, plainRunId } from "./engine.ts";
import type { LaneId } from "./lane.ts";
import type { LockOptions } from "./lock.ts";
import type { RequestStore, Row, UnclaimedRow } from "./requests.ts";

type CountedRow = Row & { collapsed?: number; collapsed_slot?: string };
import { computeDue, formatLocal, isValidSchedule, stamp } from "./schedule.ts";
import type { Disabled, LoopJobV3, RunRecord } from "./store.ts";
import { fromV2, jobStatus, runHistory, type JobHistory } from "./job-status.ts";
import { oneShotDoneV3 } from "./settle.ts";

/** A clock decision that was not a run, for the job's status. */
export interface ClockNote { at: string; text: string }
/** One job's schedule cursor and run floor. */
export interface JobClock { slot?: string; fired?: string; runs: number; note?: ClockNote }
/** The versioned clock file. Unknown job keys are preserved by writes. */
export interface ClockFile { v: 1; jobs: Record<string, JobClock> }
/** The cursor stamps as this ticker read them. */
export interface CursorRead { readonly slot?: string; readonly fired?: string }
export interface CursorMove {
	readonly job: string;
	readonly read: CursorRead;
	readonly slot: string;
	readonly fired?: string;
	readonly fires: boolean;
	readonly note?: ClockNote | null;
}
export type Advance = "moved" | "lost" | "not-holder";

/** Compare both cursor stamps and move one job, without reading or writing a file. */
export function advanceClock(file: ClockFile, move: CursorMove, holds: boolean): { next: ClockFile; result: Advance } {
	if (!holds) return { next: file, result: "not-holder" };
	const current = file.jobs[move.job];
	if (current?.slot !== move.read.slot || current?.fired !== move.read.fired) return { next: file, result: "lost" };
	const entry: JobClock = { ...current, slot: move.slot, runs: (current?.runs ?? 0) + (move.fires ? 1 : 0) };
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
/** The file belongs to a newer version and must not be replaced. */
export class ClockNewer extends Error {}

/** The clock file and its lock. Scheduling and lease decisions stay outside this store. */
export class ClockStore {
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
		return file;
	}
	advance(move: CursorMove, holds?: () => boolean): Advance {
		return this.io.locked(this.paths.lock, () => {
			const file = this.read();
			const result = advanceClock(file, move, holds ? holds() : true);
			if (result.result === "moved") this.io.write(this.paths.file, JSON.stringify(result.next));
			return result.result;
		});
	}
	raiseRuns(job: string, ordinal: number): void {
		this.io.locked(this.paths.lock, () => {
			const file = this.read();
			const current = file.jobs[job];
			if ((current?.runs ?? 0) >= ordinal) return;
			this.io.write(this.paths.file, JSON.stringify({ ...file, jobs: { ...file.jobs, [job]: { ...current, runs: ordinal } } }));
		});
	}
}

export type Mine = { readonly kind: "loop" } | { readonly kind: "plain"; readonly epoch: number };
export interface TickProbe { readonly jobs: readonly LoopJobV3[]; readonly clock: ClockFile; readonly now: number; readonly mine: ReadonlySet<string> }
/** Name only jobs whose lane and run history this tick must read. */
export function wanted(probe: TickProbe): ReadonlyMap<string, LaneId> {
	const result = new Map<string, LaneId>();
	for (const job of probe.jobs) {
		if (!probe.mine.has(job.id)) continue;
		const lane = job.stateful ? `@${job.id}` : job.sessionId;
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
	readonly mine: ReadonlyMap<string, Mine>; readonly read: ReadonlyMap<string, JobRead>;
}
export interface TickInput { readonly jobs: readonly LoopJobV3[]; readonly clock: ClockFile; readonly view: TickView }
interface SlotSpend { readonly job: string; readonly lane: LaneId; readonly slot: string; readonly read: CursorRead; readonly at: string; readonly owner: { readonly kind: "loop" } | { readonly kind: "plain"; readonly session: string; readonly epoch: number } }
export type SpendDecision =
	| (SlotSpend & { readonly do: "row"; readonly row: UnclaimedRow; readonly replaces?: string })
	| (SlotSpend & { readonly do: "collapse"; readonly onto: string })
	| (SlotSpend & { readonly do: "cursor"; readonly why: "own-row" | "spent" })
	| (SlotSpend & { readonly do: "skip"; readonly note: string });
export type Pass = "not-mine" | "disabled" | "proposed" | "no-lane" | "not-due" | "unread" | "running";
export type TickDecision = SpendDecision | { readonly do: "disable"; readonly job: string; readonly disabled: Disabled } | { readonly do: "retire"; readonly job: string } | { readonly do: "pass"; readonly job: string; readonly why: Pass };

const T3_WRITES: Record<SpendDecision["do"], Record<"loop" | "plain", { readonly fired: boolean; readonly fires: boolean }>> = {
	row: { loop: { fired: true, fires: false }, plain: { fired: true, fires: true } },
	cursor: { loop: { fired: true, fires: false }, plain: { fired: true, fires: true } },
	collapse: { loop: { fired: false, fires: false }, plain: { fired: true, fires: false } },
	skip: { loop: { fired: false, fires: false }, plain: { fired: false, fires: false } },
};
/** Derive T3's cursor update from the chosen T2 arm and job kind. */
export function cursorMove(decision: SpendDecision): CursorMove {
	const write = T3_WRITES[decision.do][decision.owner.kind];
	return { job: decision.job, read: decision.read, slot: decision.slot, ...(write.fired ? { fired: decision.at } : {}), fires: write.fires, ...(decision.do === "skip" ? { note: { at: decision.at, text: decision.note } } : decision.do === "row" || decision.do === "cursor" ? { note: null } : {}) };
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
		if (job.proposed) return { do: "pass", job: job.id, why: "proposed" };
		if (!job.enabled) return { do: "pass", job: job.id, why: "disabled" };
		if (!isValidSchedule(job.schedule)) return { do: "disable", job: job.id, disabled: { code: "schedule", why: "disabled: unusable schedule", at: stamp(view.now) } };
		const lane = job.stateful ? `@${job.id}` : job.sessionId;
		if (!lane) return { do: "pass", job: job.id, why: "no-lane" };
		let slot: number | undefined;
		try { slot = computeDue({ schedule: job.schedule, createdAt: Date.parse(job.createdAt), lastDueAt: entry?.slot === undefined ? undefined : Date.parse(entry.slot), lastFiredAt: entry?.fired === undefined ? undefined : Date.parse(entry.fired) }, view.now); }
		catch (error) { return { do: "disable", job: job.id, disabled: { code: "schedule", why: `disabled: ${error instanceof Error ? error.message : String(error)}`, at: stamp(view.now) } }; }
		// An every schedule counts from `fired`, which a loop's collapse and a skip leave as they were: the same slot comes back, and the cursor already stands on it.
		if (slot === undefined || (entry?.slot !== undefined && slot <= Date.parse(entry.slot))) return { do: "pass", job: job.id, why: "not-due" };
		if (!data) return { do: "pass", job: job.id, why: "unread" };
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
		const missed = slot < view.startedAt - view.tickMs && !(view.catchUp && job.catchUp);
		for (const rule of AFTER_OWN_ROW[mineKind]) {
			if (rule === "missed" && missed) return { ...spend, do: "skip", note: `missed ${formatLocal(slot)} while ${view.kind === "background" ? "pi-loops was not running" : "no pi was running"} (catch-up disabled)` };
			if (rule === "collapse" && collapseTarget) return { ...spend, do: "collapse", onto: collapseTarget.id };
		}
		const streak = data.history?.streak ?? 0;
		const wait = job.stateful || view.kind === "background" ? failurePause(streak) : 0;
		const not_before = wait ? stamp(Date.parse(data.history!.failed!.at) + wait) : undefined;
		const row: UnclaimedRow = { ...plainJobRow(job, id, `cron:${job.id}`, "", view.self, view.now), lane, ...(not_before ? { not_before } : {}) };
		return { ...spend, do: "row", row, ...(refused ? { replaces: refused.id } : {}) };
	});
}

export interface TickStores { readonly requests: Pick<RequestStore, "appendIfAbsent" | "remove"> & { collapse(lane: LaneId, id: string, slot: string): "counted" | "counted-before" | "missing" }; readonly clock: ClockStore; heldEpoch(sessionId: string): number | undefined }
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
