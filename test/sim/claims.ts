/**
 * A simulated lane that pi-loops in the background runs: a loop's queue, its rows claimed by a run
 * (`row.run`), the run ending in every way a run ends, and the process dying at any step, also
 * between two writes of a drain. The real `drain`, `RequestStore` and `Inbox` do the work.
 *
 * What is simulated, because nothing in `src/` does it yet: the executor that starts a run. Its
 * `turn` claims the row with `RequestStore.claim` and remembers the run; a run's end writes the run
 * record and nothing else. The engine closes the run at the next drain. So this holds the engine's
 * rules for a claimed row to their word before an executor is built on them.
 *
 * What is left out: hooks, the run's own findings and notes, the clock's cursor, stops while a run
 * is going (the record of a stopped run is written as the run's end), and a second process alive
 * at the same time (one background process holds the directory).
 */
import assert from "node:assert/strict";
import { CEILING, type EngineSinks, type Executor, DEAD_AFTER_ATTEMPTS, drain, proofOf } from "../../src/engine.ts";
import { Inbox, findingId } from "../../src/inbox.ts";
import { RequestStore, type UnclaimedRow } from "../../src/requests.ts";
import { stamp } from "../../src/schedule.ts";
import type { RunRecord } from "../../src/store.ts";
import { type Random, weighted } from "./prng.ts";

export const LANE = "@cron-0123456789abcdef0123456789abcdef";
const JOB = LANE.slice(1);
export const START = Date.parse("2026-06-01T12:00:00Z");

/** How a simulated run ends. `cut-off` is the process dying with the run going: no record is written. */
export type End = "ok" | "failed" | "stopped" | "aborted";
type Run = { id: string; rowId: string; pid: number; end?: End | "cut-off" };
type Proc = { pid: number; alive: boolean; running?: Run };

class Crash extends Error {}

export interface Outcome {
	steps: string[];
	violation?: string;
	/** What happened at least once: a generator that stopped reaching a thing checks nothing about it. */
	seen: Set<string>;
}

/** One schedule of `steps` steps from `random`, in the loops directory `dir`. Stops at the first violation. */
export async function play(dir: string, random: Random, steps: number): Promise<Outcome> {
	const real = new RequestStore(dir);
	const inbox = new Inbox(dir);
	const audits: Array<Parameters<EngineSinks["audit"]["appendAudit"]>[0]> = [];
	const records: RunRecord[] = [];
	const runs: Run[] = [];
	const slots: string[] = [];
	const gone = new Map<string, string>();
	const out: Outcome = { steps: [], seen: new Set() };
	const fail = (what: string): void => void (out.violation ??= what);
	let now = START;
	let pids = 100;
	let proc: Proc = { pid: ++pids, alive: true };
	/** Durable writes left before the process dies; Infinity when no crash is planned. */
	let fuse = Infinity;
	/** The process died during this drain: a dead process writes nothing more, whatever its code goes on to try. */
	let crashed = false;
	const alive = (): void => {
		if (crashed) throw new Crash();
	};
	const wrote = (): void => {
		if (--fuse > 0) return;
		fuse = Infinity;
		crashed = true;
		die("in the middle of a drain");
		throw new Crash();
	};
	function die(when: string): void {
		if (proc.running) proc.running.end = "cut-off";
		proc = { ...proc, alive: false, running: undefined };
		out.seen.add(`dies ${when}`);
	}
	const runsOf = (rowId: string): Run[] => runs.filter((r) => r.rowId === rowId);
	const liveClaims = (): string[] => real.list(LANE).flatMap((row) => (row.run && proc.alive && proc.running?.id === row.run.id ? [row.id] : []));

	// The store the engine writes through: each write can be the last thing the process does.
	const store: RequestStore = Object.create(real);
	store.update = (lane, id, patch) => {
		alive();
		const did = real.update(lane, id, patch);
		wrote();
		return did;
	};
	store.remove = (lane, ids) => {
		alive();
		for (const id of ids) {
			const row = real.list(lane).find((r) => r.id === id);
			if (row) gone.set(id, account(id));
		}
		real.remove(lane, ids);
		wrote();
	};
	/** Why row `id` may leave now, read before it is removed; a violation when nothing accounts for it. */
	function account(id: string): string {
		const last = runsOf(id).at(-1);
		const audited = (state: string) => audits.some((a) => a.traceId === id && a.state === state);
		if (last?.end === "ok" || last?.end === "failed") return "delivered";
		if (last?.end === "stopped") {
			if (!audited("stopped")) fail(`${id} left as stopped with no audit line`);
			return "stopped";
		}
		const letter = inbox.list().filter((e) => e.run_id === id);
		const cutOff = runsOf(id).filter((r) => r.end === "cut-off").length;
		if (letter.length === 1 && letter[0].id === findingId(`dead | ${LANE} | ${id}`) && letter[0].lane === LANE && letter[0].session_id === undefined && audited("dead") && cutOff >= DEAD_AFTER_ATTEMPTS) return "dead";
		fail(`${id} left its queue with nothing to account for it: its last run is ${last?.end ?? "none"}, ${letter.length} finding(s), ${cutOff} run(s) cut off`);
		return "unaccounted";
	}
	const sinks: EngineSinks = {
		jobs: { exists: () => true, enabled: () => true, goalActive: () => false },
		inbox: {
			appendOnce: (entry, key, opts) => inbox.appendOnce(entry, key, opts),
			fileOnce: async (entry, id) => {
				alive();
				const filed = await inbox.fileOnce(entry, id);
				wrote();
				return filed;
			},
		},
		audit: {
			appendAudit: (record) => {
				alive();
				audits.push(record);
				wrote();
			},
			listAudit: () => [],
		},
	};
	const executorOf = (me: Proc): Executor => ({
		holds: () => me.alive,
		proof: () => proofOf(() => [], () => records),
		view: () => ({ kind: "held", ceiling: CEILING.held, blocked: () => undefined, claimLive: (row) => me.alive && me.running?.id === row.run.id, idle: true, inFlight: new Set(), connected: () => true, producerAlive: () => true, mine: () => false }),
		turn: (row) => {
			if ((row as { run?: unknown }).run !== undefined) fail(`${row.id} was handed over with a claim on it`);
			const live = liveClaims();
			if (live.length) fail(`${row.id} was started while ${live.join(", ")} was running`);
			if (row.not_before !== undefined && Date.parse(row.not_before) > now) fail(`${row.id} was started before its backoff ended`);
			const before = runsOf(row.id).at(-1);
			if (before?.end === "ok" || before?.end === "failed" || before?.end === "stopped") fail(`${row.id} was started again after its run ${before.end}`);
			alive();
			const run: Run = { id: `run-${runs.length + 1}`, rowId: row.id, pid: me.pid };
			if (!real.claim(LANE, row.id, { id: run.id, pid: me.pid, started_at: stamp(now) })) return;
			runs.push(run);
			me.running = run;
			wrote();
		},
		append: (row) => fail(`${row.id} was appended: this lane has no session to append to`),
		abort: () => undefined,
		abortWhenStarted: () => undefined,
		refused: () => undefined,
	});

	async function drainNow(): Promise<string> {
		const me = proc;
		crashed = false;
		try {
			const r = await drain(LANE, store, executorOf(me), now, sinks, { tick: true });
			return [r.delivered.length && `started ${r.delivered.join(" ")}`, r.removed.length && `removed ${r.removed.join(" ")}`, r.failed.length && `failed ${r.failed.join(" ")}`, r.dead.length && `dead ${r.dead.join(" ")}`].filter(Boolean).join("; ") || "nothing to do";
		} catch (err) {
			if (err instanceof Crash) return "the process dies in the middle";
			throw err;
		} finally {
			// The engine catches what a hand-over throws and goes on; a process that died did not.
			if (crashed) return "the process dies in the middle";
		}
	}

	/** After every step: what is true of the queue whatever happened. */
	function check(): void {
		const rows = real.list(LANE);
		const claimed = rows.filter((row) => row.run);
		if (liveClaims().length > 1) fail(`two rows have a run going: ${liveClaims().join(", ")}`);
		for (const row of claimed) if (!runs.some((r) => r.id === row.run!.id)) fail(`${row.id} carries a claim no run made`);
		for (const row of rows) {
			const cutOff = runsOf(row.id).filter((r) => r.end === "cut-off").length;
			if (row.attempts > cutOff) fail(`${row.id} has ${row.attempts} attempt(s) and only ${cutOff} run(s) were cut off: a stop or an abort counted as a failure`);
		}
		const queued = new Set(rows.map((row) => row.id));
		for (const id of slots) if (!queued.has(id) && !gone.has(id)) fail(`${id} is gone from its queue and nothing removed it`);
		const letters = new Map<string, number>();
		for (const entry of inbox.list()) letters.set(entry.run_id, (letters.get(entry.run_id) ?? 0) + 1);
		for (const [id, n] of letters) if (n > 1) fail(`${id} has ${n} dead letters`);
	}

	for (let i = 0; i < steps && !out.violation; i++) {
		const kind = !proc.alive
			? weighted([["start", 6], ["slot", 2], ["advance", 2]], random())
			: weighted([["slot", 4], ["drain", 8], ["crash", 3], ["end", proc.running ? 8 : 0], ["die", 2], ["advance", 4]], random());
		switch (kind) {
			case "slot": {
				const id = `slot-${slots.length + 1}`;
				const row: UnclaimedRow = { v: 3, id, lane: LANE, kind: "input", source: `cron:${JOB}`, mode: "unattended", wake: "turn", payload: { text: `[Trigger ${id}] go`, cwd: "/p" }, created_at: stamp(now), created_by: { pid: proc.pid, instance: "background", version: "sim" }, attempts: 0 };
				real.appendIfAbsent(row);
				slots.push(id);
				out.steps.push(`the clock queues ${id}`);
				break;
			}
			case "drain":
				out.steps.push(`the background drains: ${await drainNow()}`);
				break;
			case "crash": {
				fuse = 1 + (random() % 4);
				const said = await drainNow();
				out.steps.push(`the background drains and may die after write ${fuse === Infinity ? "(it did)" : "(it did not)"}: ${said}`);
				fuse = Infinity;
				break;
			}
			case "end": {
				const run = proc.running!;
				const end = weighted<End>([["ok", 4], ["failed", 2], ["stopped", 2], ["aborted", 3]], random());
				run.end = end;
				records.push({ runId: run.id, jobId: JOB, stateful: true, cwd: "/p", pid: proc.pid, startedAt: stamp(now), finishedAt: stamp(now), ok: end === "ok", findings: 0, ...(end === "stopped" ? { aborted: true, stoppedBy: "person" } : end === "aborted" ? { aborted: true } : {}) } as RunRecord);
				proc.running = undefined;
				out.seen.add(`a run ${end}`);
				out.steps.push(`the run of ${run.rowId} ends: ${end}`);
				break;
			}
			case "die":
				out.steps.push(`the background process dies${proc.running ? ` while ${proc.running.rowId} runs` : ""}`);
				die(proc.running ? "with a run going" : "idle");
				break;
			case "start":
				proc = { pid: ++pids, alive: true };
				out.steps.push("a background process starts");
				break;
			case "advance": {
				const ms = [60_000, 5 * 60_000, 30 * 60_000][random() % 3];
				now += ms;
				out.steps.push(`the clock advances ${ms / 60_000} min`);
				break;
			}
		}
		check();
	}
	// The end of the schedule: a process that lives, and time enough for every backoff, settle the queue.
	// One run at a time: each row needs a drain to start and one to leave, and a backoff may come between.
	for (let i = 0; i < 4 * slots.length + 12 && !out.violation && (i < 2 || real.list(LANE).length > 0); i++) {
		if (!proc.alive) proc = { pid: ++pids, alive: true };
		if (proc.running) {
			records.push({ runId: proc.running.id, jobId: JOB, stateful: true, cwd: "/p", pid: proc.pid, startedAt: stamp(now), finishedAt: stamp(now), ok: true, findings: 0 } as RunRecord);
			proc.running.end = "ok";
			proc.running = undefined;
		}
		now += 6 * 3_600_000;
		await drainNow();
		check();
	}
	if (!out.violation) {
		const left = real.list(LANE);
		if (left.length) fail(`${left.map((r) => r.id).join(", ")} still queued after every run was let to end: a row is stuck`);
		for (const id of slots) if (!gone.has(id)) fail(`${id} never left`);
	}
	for (const exit of gone.values()) out.seen.add(`exit ${exit}`);
	for (const run of runs) if (run.end === "aborted") out.seen.add("a row stays owed");
	assert.ok(out.steps.length > 0);
	return out;
}
