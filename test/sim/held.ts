/**
 * A simulated closed conversation whose plain job pi-loops in the background runs: the clock queues
 * a slot's row, a run claims it, writes its prompt into the conversation or not, and ends in every
 * way a held turn ends; a window takes the conversation at any step and gives it back; the
 * background process dies at any step, also between two writes of a drain or of a closing. The real
 * `drain`, `closeRun`, `settle`, `RunList`, `RequestStore` and `Inbox` do the work.
 *
 * What is simulated: the two executors. The background's `turn` claims the row through the real
 * `RunList`; its run's end builds the record and calls the real closing, with or without the
 * lease. The window's `turn` writes the prompt at once, as an idle pi does.
 *
 * What is left out: the lease file itself (who holds the conversation is one variable), stops
 * that arrive as rows (a stopped run is written as the run's end), a rule's results in the same
 * queue, a one-shot, and a window that dies.
 */
import assert from "node:assert/strict";
import { CEILING, type EngineSinks, type Executor, closeRun, drain, plainRunId, proofOf } from "../../src/engine.ts";
import { Inbox, findingId } from "../../src/inbox.ts";
import { type ClaimedRow, RequestStore, type Row, type UnclaimedRow } from "../../src/requests.ts";
import { RunList } from "../../src/run-list.ts";
import { stamp } from "../../src/schedule.ts";
import { runEnd } from "../../src/settle.ts";
import type { RunRecord } from "../../src/store.ts";
import { type Random, weighted } from "./prng.ts";

export const SESSION = "held-conversation";
const JOB = "cron-0123456789abcdef0123456789abcdef";
export const START = Date.parse("2026-06-01T12:00:00Z");

/** How a simulated run ends in its own process. `cut-off` is the process dying with the run going. */
type End = "ok" | "failed" | "stopped" | "handed-back";
type Run = { rowId: string; pid: number; startedAt: string; wrote: boolean; end?: End | "cut-off" };
type Proc = { pid: number; alive: boolean; running?: Run; list: RunList };

class Crash extends Error {}

export interface Outcome {
	steps: string[];
	violation?: string;
	seen: Set<string>;
}

export async function play(dir: string, random: Random, steps: number): Promise<Outcome> {
	const real = new RequestStore(dir);
	const inbox = new Inbox(dir);
	const audits: Array<Parameters<EngineSinks["audit"]["appendAudit"]>[0]> = [];
	const records: RunRecord[] = [];
	const entries: unknown[] = [];
	const runs: Run[] = [];
	/** Every row the clock or a closing queued, in order. */
	const known: string[] = [];
	const gone = new Map<string, string>();
	const job: Record<string, any> = { id: JOB, sessionId: SESSION, prompt: "go", cwd: "/p", schedule: { kind: "every", ms: 60_000 }, enabled: true, stateful: false, runCount: 0 };
	const out: Outcome = { steps: [], seen: new Set() };
	const fail = (what: string): void => void (out.violation ??= what);
	let now = START;
	let pids = 100;
	let proc: Proc = { pid: ++pids, alive: true, list: new RunList() };
	/** Who holds the conversation: the background takes it when nobody does, a window takes it from anybody. */
	let holder: "background" | "window" | undefined;
	let fuse = Infinity;
	let crashed = false;
	const alive = (): void => {
		if (crashed) throw new Crash();
	};
	const wrote = (): void => {
		if (--fuse > 0) return;
		fuse = Infinity;
		crashed = true;
		die("in the middle of its writes");
		throw new Crash();
	};
	function die(when: string): void {
		if (proc.running && proc.running.end === undefined) proc.running.end = "cut-off";
		proc = { ...proc, alive: false, running: undefined };
		if (holder === "background") holder = undefined;
		out.seen.add(`dies ${when}`);
	}
	const prompts = (id: string): number => entries.filter((e: any) => e.message.content.startsWith(`[Trigger ${id}] `)).length;
	const runsOf = (rowId: string): Run[] => runs.filter((r) => r.rowId === rowId);
	const liveClaims = (): string[] => real.list(SESSION).flatMap((row) => (row.run && proc.alive && proc.running?.rowId === row.id ? [row.id] : []));
	const write = (id: string): void => void entries.push({ type: "message", timestamp: stamp(now), message: { role: "user", content: `[Trigger ${id}] go` } });
	const proof = () => proofOf(() => entries, () => records);

	/** Why row `id` may leave now, read before it is removed; a violation when nothing accounts for it. */
	function account(id: string): string {
		const audited = (state: string) => audits.some((a) => a.traceId === id && a.state === state);
		if (prompts(id) > 0) return "delivered";
		const last = runsOf(id).at(-1);
		if (last?.end === "stopped" && audited("stopped")) return "stopped";
		const letter = inbox.list().filter((e) => e.run_id === id);
		if (letter.length === 1 && letter[0].id === findingId(`dead | ${SESSION} | ${id}`) && letter[0].session_id === SESSION && audited("dead")) return "dead";
		fail(`${id} left its queue with nothing to account for it: no prompt in the conversation, its last run is ${last?.end ?? "none"}, ${letter.length} finding(s)`);
		return "unaccounted";
	}

	/** The store, with or without the fuse: each write of the background can be the last thing its process does. */
	const storeFor = (fused: boolean): RequestStore => {
		const before = () => void (fused && alive());
		const after = () => void (fused && wrote());
		const store: RequestStore = Object.create(real);
		store.update = (lane, id, patch) => {
			before();
			const did = real.update(lane, id, patch);
			after();
			return did;
		};
		store.remove = (lane, ids) => {
			before();
			for (const id of ids) if (real.list(lane).some((r) => r.id === id)) gone.set(id, account(id));
			real.remove(lane, ids);
			after();
		};
		store.removeIf = (lane, id, when) => {
			const row = real.list(lane).find((r) => r.id === id);
			if (!row) return { outcome: "missing" };
			if (!when(row)) return { outcome: "kept", row };
			store.remove(lane, [id]);
			return { outcome: "removed", row };
		};
		store.appendIfAbsent = (row, opts, lock) => {
			before();
			const did = real.appendIfAbsent(row, opts, lock);
			if (did) known.push(row.id);
			after();
			return did;
		};
		store.claim = (lane, id, run) => {
			before();
			const did = real.claim(lane, id, run);
			after();
			return did;
		};
		return store;
	};
	const sinksFor = (fused: boolean): EngineSinks => {
		const before = () => void (fused && alive());
		const after = () => void (fused && wrote());
		return {
			jobs: { exists: () => true, enabled: () => true, goalActive: () => false },
			inbox: {
				appendOnce: (entry, key, opts) => inbox.appendOnce(entry, key, opts),
				fileOnce: async (entry, id) => {
					before();
					const filed = await inbox.fileOnce(entry, id);
					after();
					return filed;
				},
			},
			audit: {
				appendAudit: (record) => {
					before();
					audits.push(record);
					after();
				},
				listAudit: () => [],
			},
			ledger: {
				load: () => [job as any],
				update: async (_id, patch) => {
					before();
					patch(job as any);
					after();
					return job as any;
				},
				appendRun: (record) => {
					before();
					records.push(record);
					after();
				},
			},
			self: () => ({ pid: fused ? proc.pid : 1, instance: fused ? "background" : "window", version: "sim" }),
		};
	};
	const background = { store: storeFor(true), sinks: sinksFor(true) };
	const window = { store: storeFor(false), sinks: sinksFor(false) };

	const backgroundExecutor = (me: Proc): Executor => ({
		holds: () => me.alive && holder === "background",
		proof,
		view: () => ({ kind: "held", ceiling: CEILING.held, blocked: () => (me.running ? "a turn of pi-loops is writing this conversation" : undefined), claimLive: (row) => me.alive && me.list.get(row.run.id) !== undefined, idle: !me.running, inFlight: new Set(), connected: () => true, producerAlive: () => true, mine: () => false }),
		turn: (row, at) => {
			const live = liveClaims();
			if (live.length) fail(`${row.id} was started while ${live.join(", ")} was running`);
			if (row.not_before !== undefined && Date.parse(row.not_before) > now) fail(`${row.id} was started before its backoff ended`);
			if (prompts(row.id) > 0) fail(`${row.id} was started though its prompt is in the conversation`);
			let claimed: ClaimedRow | undefined;
			try {
				claimed = me.list.claim(background.store, row, { pid: me.pid, procStart: undefined }, { jobId: JOB, label: "held", promptPreview: "go", ctrl: new AbortController() }, at);
			} catch (err) {
				// The process died as it wrote the claim: the claim is on disk, and it is a run that was cut off before it began.
				const left = real.list(SESSION).find((r) => r.id === row.id)?.run;
				if (err instanceof Crash && left) runs.push({ rowId: row.id, pid: me.pid, startedAt: left.started_at, wrote: false, end: "cut-off" });
				throw err;
			}
			if (!claimed) return;
			const run: Run = { rowId: row.id, pid: me.pid, startedAt: claimed.run.started_at, wrote: false };
			runs.push(run);
			me.running = run;
		},
		append: (row) => fail(`${row.id} was appended: this queue has turn rows only`),
		abort: () => undefined,
		abortWhenStarted: () => undefined,
		refused: () => undefined,
	});
	const windowExecutor: Executor = {
		holds: () => holder === "window",
		proof,
		// The rule of a lease's holder: a claim is live while the process that made it is.
		view: () => ({ kind: "window", ceiling: () => true, blocked: () => undefined, claimLive: (row) => proc.alive && proc.pid === row.run.pid, idle: true, inFlight: new Set(), connected: () => true, producerAlive: () => true, mine: () => true }),
		turn: (row) => {
			const live = liveClaims();
			if (live.length) fail(`the window ran ${row.id} beside the run of ${live.join(", ")}`);
			if (prompts(row.id) > 0) fail(`the window ran ${row.id} though its prompt is in the conversation`);
			write(row.id);
		},
		append: (row) => fail(`${row.id} was appended: this queue has turn rows only`),
		abort: () => undefined,
		abortWhenStarted: () => undefined,
		refused: () => undefined,
	};

	const said = (r: { delivered: string[]; removed: string[]; failed: string[]; dead: string[] }): string => [r.delivered.length && `started ${r.delivered.join(" ")}`, r.removed.length && `removed ${r.removed.join(" ")}`, r.failed.length && `failed ${r.failed.join(" ")}`, r.dead.length && `dead ${r.dead.join(" ")}`].filter(Boolean).join("; ") || "nothing to do";

	/** One piece of the background's work that can be cut off by its death. */
	async function guarded(work: () => Promise<string>): Promise<string> {
		crashed = false;
		try {
			return await work();
		} catch (err) {
			if (err instanceof Crash) return "the process dies in the middle";
			throw err;
		} finally {
			if (crashed) return "the process dies in the middle";
		}
	}
	const backgroundDrain = (): Promise<string> => {
		const me = proc;
		if (holder === undefined) holder = "background";
		return guarded(async () => said(await drain(SESSION, background.store, backgroundExecutor(me), now, background.sinks, { tick: true })));
	};
	/** The end of a run in the process that ran it: its record, handed to the closing, with or without the lease. */
	const endRun = (end: End): Promise<string> => {
		const me = proc;
		const run = me.running!;
		run.end = end;
		const row = real.list(SESSION).find((r): r is ClaimedRow => r.id === run.rowId && r.run !== undefined);
		const record = { runId: run.rowId, jobId: JOB, stateful: false, cwd: "/p", pid: me.pid, startedAt: run.startedAt, finishedAt: stamp(now), ok: end === "ok", ...(end === "failed" ? { error: "boom" } : {}), findings: 0, droppedFindings: 0, stateUpdated: false, ...(end === "stopped" ? { aborted: true, stoppedBy: "person" } : end === "handed-back" ? { aborted: true } : {}) } as RunRecord;
		return guarded(async () => {
			if (!row) {
				fail(`the run of ${run.rowId} ended and its row has no claim`);
				return "no row";
			}
			const closed = await closeRun(background.store, background.sinks, row, proof(), now, record);
			me.list.remove(run.rowId);
			me.running = undefined;
			if (holder === "background") holder = undefined;
			return `closed: ${closed.outcome}`;
		});
	};

	/** The streak the job must show once every closing is through: each failed record raises it, each success clears it. */
	const streak = (upTo = records.length): number => {
		let n = 0;
		for (const record of records.slice(0, upTo)) {
			const how = runEnd(record).how;
			if (how === "succeeded") n = 0;
			else if (how === "failed") n++;
		}
		return n;
	};

	function check(final = false): void {
		const rows = real.list(SESSION);
		if (liveClaims().length > 1) fail(`two rows have a run going: ${liveClaims().join(", ")}`);
		for (const id of known) if (prompts(id) > 1) fail(`the prompt of ${id} is in the conversation ${prompts(id)} times: it was answered twice`);
		// I4: a run has one record, also after its process was killed.
		const byClaim = new Map<string, number>();
		for (const record of records) byClaim.set(`${record.runId} ${record.startedAt}`, (byClaim.get(`${record.runId} ${record.startedAt}`) ?? 0) + 1);
		for (const [claim, n] of byClaim) if (n > 1) fail(`the run ${claim} has ${n} records`);
		if (records.length > runs.length) fail(`${records.length} records for ${runs.length} runs`);
		// I8: attempts count only a run that left no prompt and failed or was cut off.
		for (const row of rows) {
			const unwritten = runsOf(row.id).filter((r) => !r.wrote && (r.end === "failed" || r.end === "cut-off")).length;
			if (row.attempts > unwritten) fail(`${row.id} has ${row.attempts} attempt(s) and only ${unwritten} of its runs failed or were cut off before the prompt: a stop or a hand-back counted`);
		}
		// The job's patch is applied once per record, also when a closing runs twice. A process that
		// died between a record and the job's write leaves that one record's patch for the next closing.
		const streakNow = job.consecutiveFailures ?? 0;
		if (streakNow !== streak() && streakNow !== streak(records.length - 1)) fail(`the job's streak is ${streakNow}, and the run log says ${streak()} (${streak(records.length - 1)} before its last record): a failure was counted twice, or not at all`);
		if (job.runCount !== known.filter((id) => id.startsWith("slot-")).length) fail(`the closing changed the job's run count to ${job.runCount}`);
		// A successor follows a run that was handed back with its prompt written, and nothing else; one each.
		for (const id of known) {
			if (id.startsWith("slot-")) continue;
			const before = known.find((k) => plainRunId(JOB, `after ${k}`) === id);
			const handedBack = before !== undefined && records.some((r) => r.runId === before && r.aborted && !r.stoppedBy);
			if (!handedBack || prompts(before!) === 0) fail(`${id} was queued and no run that was handed back with its prompt written is before it`);
		}
		if (new Set(known).size !== known.length) fail("a row was queued twice under one id");
		const queued = new Set(rows.map((row) => row.id));
		for (const id of known) if (!queued.has(id) && !gone.has(id)) fail(`${id} is gone from its queue and nothing removed it`);
		const letters = new Map<string, number>();
		for (const entry of inbox.list()) letters.set(entry.run_id, (letters.get(entry.run_id) ?? 0) + 1);
		for (const [id, n] of letters) if (n > 1) fail(`${id} has ${n} dead letters`);
		if (!final) return;
		if (rows.length) fail(`${rows.map((r) => r.id).join(", ")} still queued after every run was let to end: a row is stuck`);
		for (const id of known) if (!gone.has(id)) fail(`${id} never left`);
		if (records.length !== runs.length) fail(`${runs.length} runs and ${records.length} records: a run has no record`);
		if ((job.consecutiveFailures ?? 0) !== streak()) fail(`the job's streak is ${job.consecutiveFailures ?? 0} and the run log says ${streak()}`);
	}

	for (let i = 0; i < steps && !out.violation; i++) {
		now += 1_000;
		const running = proc.alive && proc.running !== undefined;
		const kind = !proc.alive
			? weighted([["start", 6], ["slot", 2], ["take", 1], ["leave", 1], ["window drains", 2], ["advance", 2]], random())
			: weighted([["slot", 4], ["drain", 8], ["crash", 3], ["write", running && !proc.running!.wrote ? 6 : 0], ["end", running ? 8 : 0], ["end and crash", running ? 2 : 0], ["die", 2], ["take", 2], ["leave", holder === "window" ? 3 : 0], ["window drains", holder === "window" ? 5 : 0], ["advance", 4]], random());
		switch (kind) {
			case "slot": {
				const id = `slot-${known.filter((k) => k.startsWith("slot-")).length + 1}`;
				const row: UnclaimedRow = { v: 3, id, lane: SESSION, kind: "input", source: `cron:${JOB}`, mode: "unattended", wake: "turn", payload: { text: `[Trigger ${id}] go`, cwd: "/p" }, collapse_key: `cron:${JOB}`, created_at: stamp(now), created_by: { pid: proc.pid, instance: "background", version: "sim" }, attempts: 0 };
				real.appendIfAbsent(row);
				known.push(id);
				job.runCount++;
				out.steps.push(`the clock queues ${id}`);
				break;
			}
			case "drain":
				out.steps.push(`the background drains: ${await backgroundDrain()}`);
				break;
			case "crash": {
				fuse = 1 + (random() % 4);
				const what = await backgroundDrain();
				out.steps.push(`the background drains and may die at one of its writes: ${what}`);
				fuse = Infinity;
				break;
			}
			case "write": {
				const run = proc.running!;
				if (holder !== "background") {
					out.steps.push(`the run of ${run.rowId} cannot write: a window has the conversation`);
					break;
				}
				write(run.rowId);
				run.wrote = true;
				out.seen.add("a prompt is written");
				out.steps.push(`the run of ${run.rowId} writes its prompt`);
				break;
			}
			case "end":
			case "end and crash": {
				const run = proc.running!;
				// A turn whose conversation was taken ends as handed back; a turn that succeeds has written its prompt.
				let end: End = holder !== "background" ? "handed-back" : weighted<End>([["ok", 4], ["failed", 3], ["stopped", 2], ["handed-back", 2]], random());
				if (end === "ok" && !run.wrote) {
					write(run.rowId);
					run.wrote = true;
				}
				if (kind === "end and crash") fuse = 1 + (random() % 5);
				const what = await endRun(end);
				fuse = Infinity;
				out.seen.add(`a run ${end}${run.wrote ? ", written" : ", not written"}`);
				out.steps.push(`the run of ${run.rowId} ends ${end}${run.wrote ? "" : " with no prompt written"}${kind === "end and crash" ? ", and the process may die in its closing" : ""}: ${what}`);
				break;
			}
			case "die":
				out.steps.push(`the background process dies${proc.running ? ` while ${proc.running.rowId} runs` : ""}`);
				die(proc.running ? "with a run going" : "idle");
				break;
			case "start":
				proc = { pid: ++pids, alive: true, list: new RunList() };
				out.steps.push("a background process starts");
				break;
			case "take":
				holder = "window";
				out.seen.add(proc.alive && proc.running ? "a window takes the conversation during a turn" : "a window takes the conversation");
				out.steps.push(`a window takes the conversation${proc.alive && proc.running ? ` while ${proc.running.rowId} runs` : ""}`);
				break;
			case "leave":
				if (holder === "window") holder = undefined;
				out.steps.push("the window leaves the conversation");
				break;
			case "window drains": {
				if (holder !== "window") {
					out.steps.push("no window holds the conversation");
					break;
				}
				const r = await drain(SESSION, window.store, windowExecutor, now, window.sinks, { tick: true });
				out.steps.push(`the window drains: ${said(r)}`);
				break;
			}
			case "advance": {
				const ms = [60_000, 5 * 60_000, 30 * 60_000][random() % 3];
				now += ms;
				out.steps.push(`the clock advances ${ms / 60_000} min`);
				break;
			}
		}
		check();
	}
	// The end of the schedule: the window leaves, a process lives, every run is let to end, and time passes for every backoff.
	if (holder === "window") holder = undefined;
	for (let i = 0; i < 6 * known.length + 16 && !out.violation && (i < 2 || real.list(SESSION).length > 0 || proc.running); i++) {
		now += 6 * 3_600_000;
		if (!proc.alive) proc = { pid: ++pids, alive: true, list: new RunList() };
		if (proc.running) {
			if (!proc.running.wrote) {
				write(proc.running.rowId);
				proc.running.wrote = true;
			}
			await endRun("ok");
		}
		await backgroundDrain();
		check();
	}
	if (!out.violation) check(true);
	for (const exit of gone.values()) out.seen.add(`exit ${exit}`);
	if (known.some((id) => !id.startsWith("slot-"))) out.seen.add("a successor is queued");
	assert.ok(out.steps.length > 0);
	return out;
}
