/**
 * A seeded simulation of the schedule clock: tickers decide slots, interleave T2 and T3, crash,
 * and drain rows through claims and loop settlement. The real clock, request store, proof, history,
 * status and settlement rules do the work.
 *
 * What is simulated: time, ticker processes, one conversation lease and the run of a claimed row.
 *
 * What is left out: hooks, findings, budgets, slot caps, gates and a window's pi. A window delivers
 * a plain row by writing its mark at once.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { claimable, landed, plainRunId, proofOf } from "../../src/engine.ts";
import { advanceClock, ClockNewer, ClockStore, decideTick, wanted, writeSlot, commitSlot, type ClockFile, type SlotWritten, type SpendDecision, type TickDecision, type TickStores } from "../../src/clock.ts";
import { loopLane, type LaneId } from "../../src/lane.ts";
import { withFileLockSync, writeFileAtomic } from "../../src/lock.ts";
import { RequestStore, type ClaimedRow, type Row, type UnclaimedRow } from "../../src/requests.ts";
import { stamp, type Schedule } from "../../src/schedule.ts";
import { loopEnd, runEnd, settleLoop, type RunEnd } from "../../src/settle.ts";
import { jobStatus, runHistory, type JobHistory } from "../../src/job-status.ts";
import type { LoopJobV3, RunRecord } from "../../src/store.ts";
import { type Random, weighted } from "./prng.ts";

type CountedRow = Row & { collapsed?: number; collapsed_slot?: string };
export interface Ticker { readonly pid: number; readonly kind: "background" | "window"; alive: boolean; startedAt: number; pending: Array<{ decision: SpendDecision; written?: SlotWritten }> }
export interface SlotLedger { ids: Set<string>; appends: number; spent: number; commits: number; fires: number; collapses: number; exit?: "delivered" | "stopped" | "dead" | "cancelled" }
export interface ClockWorld { now: number; readonly jobs: readonly LoopJobV3[]; readonly tickers: Ticker[]; lease: { holder?: number; epoch: number }; readonly records: RunRecord[]; readonly entries: unknown[]; readonly ledger: Map<string, SlotLedger> }
export type ClockStep = { readonly do: "tick"; readonly ticker: number } | { readonly do: "write"; readonly ticker: number } | { readonly do: "die" | "start"; readonly ticker: number } | { readonly do: "drain"; readonly lane: LaneId } | { readonly do: "end"; readonly lane: LaneId; readonly how: RunEnd["how"]; readonly dies?: number } | { readonly do: "deliver" } | { readonly do: "lease"; readonly to: number | undefined } | { readonly do: "cancel"; readonly lane: LaneId } | { readonly do: "forget" } | { readonly do: "newer" } | { readonly do: "advance"; readonly ms: number };
export interface ClockOutcome { steps: string[]; violation?: string; seen: Set<string> }

const JOBS: readonly LoopJobV3[] = [
	{ id: "cron-repeat-loop", name: "repeat", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "go", cwd: "/p", enabled: true, catchUp: true, createdAt: stamp(Date.parse("2026-06-01T12:00:00Z")), runCount: 0, skippedOverlap: 0 },
	{ id: "cron-cron-loop", name: "cron", schedule: { kind: "cron", expr: "* * * * *" }, stateful: true, prompt: "go", cwd: "/p", enabled: true, catchUp: true, createdAt: stamp(Date.parse("2026-06-01T12:00:00Z")), runCount: 0, skippedOverlap: 0 },
	{ id: "plain-clock", name: "plain", schedule: { kind: "every", ms: 60_000 }, stateful: false, sessionId: "clock-conversation", prompt: "go", cwd: "/p", enabled: true, catchUp: true, createdAt: stamp(Date.parse("2026-06-01T12:00:00Z")), runCount: 0, skippedOverlap: 0 },
	{ id: "cron-once-loop", name: "once", schedule: { kind: "once", at: Date.parse("2026-06-01T12:01:00Z") }, stateful: true, prompt: "go", cwd: "/p", enabled: true, catchUp: true, createdAt: stamp(Date.parse("2026-06-01T12:00:00Z")), runCount: 0, skippedOverlap: 0 },
];
const lanes = JOBS.map((job) => job.stateful ? loopLane(job.id) : job.sessionId!) as LaneId[];
const keyOf = (job: string, slot: string): string => `${job}|${slot}`;

/** Return the first violated I1 sentence, naming its job and slot. */
export function checkI1(world: ClockWorld, queues: ReadonlyMap<LaneId, readonly CountedRow[]>): string | undefined {
	const allRows = [...queues.values()].flat();
	const internal = world as ClockWorld & { clock: ClockStore; forgotten: boolean; newer: boolean };
	for (const [key, entry] of world.ledger) {
		const [job, slot] = key.split("|");
		const say = (what: string): string => `${what} for job ${job}, slot ${slot}`;
		if (entry.ids.size > 1) return say("more than one row id was appended");
		if (entry.spent > 1) return `${say("the slot was spent more than once")}: ${entry.spent} spends; ${world.records.filter((record) => record.jobId === job && record.runId === plainRunId(job, slot)).map((record) => `${runEnd(record).how}@${record.startedAt}`).join(", ")}`;
		if (!internal.forgotten && entry.commits > 1) return say("the cursor committed more than once");
		if (entry.collapses > 1) return say("the collapse was counted more than once");
		// After clock.json was deleted a slot may be decided and fired again (CONTRACT check 4).
		if (!internal.forgotten && entry.fires > 1) return say("the plain job fired more than once");
		const rowId = plainRunId(job, slot);
		const row = allRows.find((item) => item.id === rowId);
		const hasClaim = !!row?.run;
		if (entry.commits && entry.ids.size > 0 && !entry.exit && !row && !hasClaim && entry.spent === 0) return say("the committed slot has no row, run or exit");
		if (entry.spent && allRows.some((item) => item.id === rowId && item.run && !world.records.some((record) => record.runId === rowId && record.startedAt === item.run!.started_at))) return say("a spent slot's copy was claimed again");
		if (entry.spent && entry.appends > 1 && entry.ids.size > 1) return say("a spent slot was copied into a second row");
	}
	for (const job of world.jobs) {
		const queue = queues.get(job.stateful ? loopLane(job.id) : job.sessionId!) ?? [];
		const clock = readClock(internal, job.id);
		const history = runHistory(world.records).get(job.id);
		const status = jobStatus(job, clock, queue, history, world.now);
		const fired = [...world.ledger].filter(([key, value]) => key.startsWith(`${job.id}|`) && value.fires === 1).length;
		const expectedRuns = job.stateful ? world.records.filter((record) => record.jobId === job.id && ["succeeded", "failed"].includes(runEnd(record).how)).length : fired;
		if (status.runs !== expectedRuns && !internal.forgotten && !internal.newer) return `job ${job.id}, slot ${clock?.slot ?? "none"}: status shows ${status.runs} runs, expected ${expectedRuns}`;
		const expectedStreak = history?.streak ?? 0;
		if ((status.error?.streak ?? 0) !== expectedStreak) return `job ${job.id}, slot ${clock?.slot ?? "none"}: status streak disagrees with its records`;
	}
	return undefined;
}

// The simulator keeps an in-memory mirror only to make checkI1 inspect actual store writes.
function readClock(world: ClockWorld & { clock: ClockStore }, job: string) { try { return world.clock.read().jobs[job]; } catch (error) { if (error instanceof ClockNewer) return undefined; throw error; } }

export async function play(dir: string, random: Random, steps: number): Promise<ClockOutcome> {
	fs.mkdirSync(dir, { recursive: true });
	const requests = new RequestStore(dir);
	const clockFile = path.join(dir, "clock.json");
	const clock = new ClockStore({ file: clockFile, lock: path.join(dir, "clock.lock") }, { locked: withFileLockSync, write: writeFileAtomic });
	const world = { now: Date.parse("2026-06-01T12:00:00Z"), jobs: JOBS, tickers: [], lease: { epoch: 1 }, records: [], entries: [], ledger: new Map(), clock, forgotten: false, newer: false } as ClockWorld & { clock: ClockStore; forgotten: boolean; newer: boolean };
	const out: ClockOutcome = { steps: [], seen: new Set() };
	let nextPid = 100;
	// In one world in three a second process ticks the loops too: pi-loops in the background that stalled and resumed beside the one that took its place (design, the table T1 to T3: two processes that tick at once).
	const twoBackgrounds = random() % 3 === 0;
	// The person's catch-up setting: off in half the worlds, so a slot missed while no ticker ran is skipped.
	const catchUp = random() % 2 === 0;
	for (let i = 0; i < 3; i++) world.tickers.push({ pid: ++nextPid, kind: i === 0 || (i === 1 && twoBackgrounds) ? "background" : "window", alive: true, startedAt: world.now, pending: [] });
	world.lease.holder = world.tickers[1].pid;
	const queuesNow = (): Map<LaneId, CountedRow[]> => new Map(lanes.map((lane) => [lane, requests.list(lane) as CountedRow[]]));
	const orphans = new Set<string>();
	const spentWhenRead = new WeakSet<object>();
	const ledger = (job: string, slot: string): SlotLedger => {
		const key = keyOf(job, slot);
		let value = world.ledger.get(key);
		if (!value) world.ledger.set(key, value = { ids: new Set(), appends: 0, spent: 0, commits: 0, fires: 0, collapses: 0 });
		return value;
	};
	const store: TickStores = { requests, clock, heldEpoch: () => world.lease.holder === undefined ? undefined : world.lease.epoch };
	const prove = (lane: LaneId) => proofOf(lane, () => world.entries, () => world.records);
	const fail = (message: string): void => { out.violation ??= message; };
	const tick = (ticker: Ticker): void => {
		if (!ticker.alive) return;
		const file = clock.read();
		const mine = new Map(JOBS.flatMap((job) => {
			if (job.stateful && ticker.kind === "background") return [[job.id, { kind: "loop" as const }] as const];
			if (!job.stateful && world.lease.holder === ticker.pid) return [[job.id, { kind: "plain" as const, epoch: world.lease.epoch }] as const];
			return [];
		}));
		const selected = wanted({ jobs: JOBS, clock: file, now: world.now, mine: new Set(mine.keys()) });
		const read = new Map<string, { rows: CountedRow[]; history: JobHistory | undefined; cwdMissing: boolean }>();
		const histories = runHistory(world.records);
		for (const [jobId, lane] of selected) read.set(jobId, { rows: requests.list(lane) as CountedRow[], history: histories.get(jobId), cwdMissing: false });
		const decisions = decideTick({ jobs: JOBS, clock: file, view: { now: world.now, startedAt: ticker.startedAt, tickMs: 60_000, catchUp, kind: ticker.kind, self: { pid: ticker.pid, instance: String(ticker.pid), version: "sim" }, mine, read } });
		ticker.pending = decisions.flatMap((decision) => {
			if (!(decision.do === "row" || decision.do === "collapse" || decision.do === "cursor" || decision.do === "skip")) return [];
			const history = read.get(decision.job)?.history;
			if (history?.spent.has(plainRunId(decision.job, decision.slot))) spentWhenRead.add(decision);
			return [{ decision }];
		});
		out.steps.push(`ticker ${ticker.pid} reads ${selected.size} due job(s)`);
	};
	// In half the worlds one ticker is slow: it read and decided, and its writes come late, as a process that stalls between its read and its writes does. A copy of a slot that ran meanwhile comes only from such a read.
	const slow = random() % 2 === 0 ? 0 : -1;
	const cursorOf = new Map<string, string>();
	const draw = (): ClockStep => {
		const live = world.tickers.filter((ticker) => ticker.alive);
		const ticker = world.tickers[random() % world.tickers.length];
		const stalls = world.tickers.indexOf(ticker) === slow && ticker.pending.length > 0;
		// A drain runs when a lane has rows, and a run ends where one has a claim: most steps go to such a lane, a few to any.
		const busy = lanes.filter((l) => requests.list(l).length > 0);
		const claimed = lanes.slice(0, 2).filter((l) => requests.list(l).some((row) => row.run));
		const lane = busy.length && random() % 4 !== 0 ? busy[random() % busy.length] : lanes[random() % lanes.length];
		const loop = claimed.length && random() % 4 !== 0 ? claimed[random() % claimed.length] : lanes.slice(0, 2)[random() % 2];
		const choices: Array<readonly [ClockStep["do"], number]> = [["tick", stalls ? 0 : 5], ["write", stalls ? 1 : ticker.pending.length ? 8 : 1], ["die", !ticker.alive ? 0 : ticker.pending.some((item) => item.written) ? 6 : 2], ["start", !ticker.alive ? 3 : 0], ["drain", 3], ["end", 2], ["deliver", 2], ["lease", 2], ["cancel", 1], ["forget", 1], ["newer", 1], ["advance", 4]];
		const action = weighted(choices, random());
		switch (action) {
			case "tick": return { do: "tick", ticker: world.tickers.indexOf(ticker) };
			case "write": return { do: "write", ticker: world.tickers.indexOf(ticker) };
			case "die": return { do: "die", ticker: world.tickers.indexOf(ticker) };
			case "start": return { do: "start", ticker: world.tickers.indexOf(ticker) };
			case "drain": return { do: "drain", lane };
			case "end": return { do: "end", lane: loop, how: weighted([["succeeded", 4], ["failed", 3], ["stopped", 1], ["handed-back", 2], ["interrupted", 2]], random()), ...(random() % 8 === 0 ? { dies: 1 + random() % 4 } : {}) };
			case "deliver": return { do: "deliver" };
			case "lease": return { do: "lease", to: live.length ? live[random() % live.length].pid : undefined };
			case "cancel": return { do: "cancel", lane };
			case "forget": return { do: "forget" };
			case "newer": return { do: "newer" };
			default: return { do: "advance", ms: [60_000, 5 * 60_000, 30 * 60_000][random() % 3] };
		}
	};
	const applyStep = (step: ClockStep): void => {
		try {
			switch (step.do) {
				case "tick": tick(world.tickers[step.ticker]); break;
				case "write": {
					const ticker = world.tickers[step.ticker]; const next = ticker.pending[0];
					if (!ticker.alive || !next) break;
					if (!next.written) {
						if (world.tickers.some((other) => other !== ticker && other.alive && other.pending.some((item) => item.written))) out.seen.add("two tickers cross T2 and T3");
						next.written = writeSlot(next.decision, store);
						if (next.decision.do === "row" && next.written.t2 === "wrote") { const item = ledger(next.decision.job, next.decision.slot); if (spentWhenRead.has(next.decision)) fail(`job ${next.decision.job}, slot ${next.decision.slot}: a ticker appended after reading the run that spent the slot`); item.ids.add(next.decision.row.id); item.appends++; }
						if (next.decision.do === "collapse") { const answer = next.written.t2; if (answer === "counted") { ledger(next.decision.job, next.decision.slot).collapses++; out.seen.add("collapse counted"); if (next.decision.owner.kind === "loop") out.seen.add("loop collapse leaves fired"); } else if (answer === "counted-before") out.seen.add("collapse counted-before"); }
						out.steps.push(`ticker ${ticker.pid} T2 ${next.decision.do} ${next.decision.job} ${next.decision.slot}`);
					} else {
						const result = commitSlot(next.written, store);
						const item = ledger(next.decision.job, next.decision.slot);
						if (result.t3 === "moved") {
							// The cursor only goes forward: a move back would decide a spent slot again (unless clock.json was deleted).
							const before = cursorOf.get(next.decision.job);
							if (before !== undefined && Date.parse(next.decision.slot) < Date.parse(before) && !world.forgotten) fail(`job ${next.decision.job}, slot ${next.decision.slot}: the cursor moved back from ${before}`);
							cursorOf.set(next.decision.job, next.decision.slot);
						}
						if (result.t3 === "moved") { item.commits++; if (next.decision.owner.kind === "plain" && (next.decision.do === "row" || next.decision.do === "cursor")) item.fires++; if (next.written.t2 === "missing") fail(`job ${next.decision.job}, slot ${next.decision.slot}: T3 moved after collapse found no row`); if (next.decision.owner.kind === "plain" && store.heldEpoch(next.decision.owner.session) !== next.decision.owner.epoch) fail(`job ${next.decision.job}, slot ${next.decision.slot}: T3 moved without its lease epoch`); }
						if (result.t3 === "lost") { out.seen.add("lost T3"); if (next.decision.do === "row" && next.written.t2 === "wrote") { orphans.add(next.decision.row.id); out.seen.add("lost T3 leaves orphan"); } }
						if (result.t3 === "not-holder") out.seen.add("not-holder T3");
						if (next.decision.do === "cursor" && next.decision.why === "spent") out.seen.add("cursor spent");
						if (next.decision.do === "skip" && result.t3 === "moved") out.seen.add("skip leaves fired");
						out.steps.push(`ticker ${ticker.pid} T3 ${result.t3} ${next.decision.do} ${next.decision.job} ${next.decision.slot} read=${next.decision.read.slot ?? "-"}/${next.decision.read.fired ?? "-"} now=${world.now}`);
						ticker.pending.shift();
					}
					break;
				}
				case "die": { const ticker = world.tickers[step.ticker]; if (ticker.alive) { if (ticker.pending.some((item) => item.written)) out.seen.add("dies between T2 and T3"); ticker.alive = false; ticker.pending = []; out.steps.push(`ticker ${ticker.pid} dies`); } break; }
				case "start": { const ticker = world.tickers[step.ticker]; world.tickers[step.ticker] = { ...ticker, pid: ++nextPid, alive: true, startedAt: world.now, pending: [] }; out.steps.push(`ticker restarts as ${world.tickers[step.ticker].pid}`); break; }
				case "drain": { if (!step.lane.startsWith("@cron-")) break; const row = requests.list(step.lane).find((item): item is UnclaimedRow => item.kind === "input" && !item.run); if (!row) break; if (landed(row, prove(step.lane))) { const proofRun = world.records.filter((record) => record.runId === row.id).at(-1); if (proofRun && !["succeeded", "failed", "stopped"].includes(runEnd(proofRun).how)) fail(`job ${JOBS.find((job) => loopLane(job.id) === row.lane)?.id}, slot ${slotFromId(row.id)}: an owed copy left without a run`); requests.remove(step.lane, [row.id]); markExit(row.id, "delivered"); if (proofRun) out.seen.add("spent copy leaves without a run"); out.steps.push(`proved ${row.id} leaves`); break; } const run = { id: row.id, pid: 900, started_at: stamp(world.now) } as ClaimedRow["run"] & { [key: string]: unknown }; if (requests.claim(step.lane, row.id, run as never)) { if (orphans.has(row.id)) { out.seen.add("orphan runs once"); orphans.delete(row.id); } const abandoned = world.records.find((record) => record.runId === row.id && !["succeeded", "failed", "stopped"].includes(runEnd(record).how)); if (abandoned) out.seen.add("owed copy runs"); out.steps.push(`claims ${row.id}`); } break; }
				case "end": { const claimed = requests.list(step.lane).find((row): row is ClaimedRow => !!row.run); if (!claimed) break; out.steps.push(`end action ${step.how} for ${claimed.id} at ${claimed.run.started_at}`); close(claimed, step.how, step.dies); break; }
				case "deliver": { const row = requests.list("clock-conversation").find((item) => item.kind === "input" && !item.run); if (row) { world.entries.push({ type: "message", timestamp: stamp(world.now), message: { role: "user", content: `[Trigger ${row.id}] go`, piLoopsRow: { lane: row.lane, id: row.id, at: row.created_at } } }); requests.remove(row.lane, [row.id]); markExit(row.id, "delivered"); out.seen.add("window delivers"); } break; }
				case "lease": world.lease.holder = step.to; world.lease.epoch++; break;
				case "cancel": { const row = requests.list(step.lane).find((item) => !item.run); if (row) { requests.remove(step.lane, [row.id]); markExit(row.id, "cancelled"); } break; }
				case "forget": fs.rmSync(clockFile, { force: true }); out.steps.push("clock.json is deleted"); world.forgotten = true; world.newer = false; out.seen.add("clock forgotten"); break;
				case "newer": fs.writeFileSync(clockFile, JSON.stringify({ v: 2, jobs: {} })); out.steps.push("clock.json is replaced by a newer version"); world.newer = true; out.seen.add("clock newer"); break;
				case "advance": world.now += step.ms; break;
			}
		} catch (error) {
			if (!(error instanceof ClockNewer)) throw error;
		}
	};
	function markExit(id: string, exit: NonNullable<SlotLedger["exit"]>): void { for (const entry of world.ledger.values()) if (entry.ids.has(id)) entry.exit = exit; }
	function close(row: ClaimedRow, how: RunEnd["how"], dies?: number): void {
		const job = JOBS.find((item) => item.id === row.id.split("-")[0]) ?? JOBS.find((item) => loopLane(item.id) === row.lane)!;
		const previous = world.records.find((record) => record.runId === row.id && record.startedAt === row.run.started_at);
		const record: RunRecord = previous ?? { runId: row.id, jobId: job.id, stateful: job.stateful, cwd: job.cwd, pid: row.run.pid, startedAt: row.run.started_at, finishedAt: stamp(world.now), ok: how === "succeeded", ...(how === "failed" ? { error: "failed" } : {}), ...(how === "stopped" ? { aborted: true as const, stoppedBy: "person" as const } : how === "handed-back" ? { aborted: true as const } : how === "interrupted" ? { interrupted: true as const } : {}), findings: 0, droppedFindings: 0, stateUpdated: false, ordinal: world.records.filter((r) => r.jobId === job.id && (r.ok || !!r.error)).length + 1 };
		const item = ledger(job.id, slotFromId(row.id));
		const closeWrites = 4;
		if (!previous) { world.records.push(record); item.spent += ["succeeded", "failed", "stopped"].includes(runEnd(record).how) ? 1 : 0; }
		const history = runHistory(world.records).get(job.id)!;
		const settlement = settleLoop(row, job, loopEnd(record, history), true);
		if (dies === 1) { out.seen.add("closing cut after record"); return; }
		if (settlement.job) out.steps.push("job disabled by closing");
		if (dies === 2) { out.seen.add("closing cut after job patch"); return; }
		if (settlement.runs !== undefined) {
			try { clock.raiseRuns(job.id, settlement.runs); } catch (error) { if (!(error instanceof ClockNewer)) throw error; }
		}
		if (dies === 3) { out.seen.add("closing cut after successor"); return; }
		if (settlement.row.do === "leave") {
			requests.remove(row.lane, [row.id]); markExit(row.id, settlement.row.exit);
			if (settlement.row.successor) { const id = plainRunId(job.id, `after ${row.id}`); requests.appendIfAbsent({ ...row, id, run: undefined, created_at: stamp(world.now), attempts: 0 }); out.seen.add("successor queued"); }
		} else requests.update(row.lane, row.id, { run: undefined });
		if (dies === closeWrites) out.seen.add("closing cut after row");
		out.seen.add(`end ${how}`);
		out.steps.push(`closing ${row.id} as ${how}`);
	}
	function slotFromId(id: string): string { return [...world.ledger].find(([, value]) => value.ids.has(id))?.[0].split("|").slice(1).join("|") ?? id; }
	for (let i = 0; i < steps && !out.violation; i++) {
		world.now += 1_000;
		const step = draw();
		applyStep(step);
		const violation = checkI1(world, queuesNow());
		if (violation) fail(violation);
	}
	for (const item of world.ledger.values()) if (item.exit) out.seen.add(`exit ${item.exit}`);
	return out;
}
