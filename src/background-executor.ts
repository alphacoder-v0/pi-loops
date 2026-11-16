/**
 * Everything pi-loops in the background does to the queue of a closed conversation: it takes the
 * conversation's lease and gives it back, writes a rule's result into the file, starts a plain
 * job's turn, runs it, and closes it. A turn is a row with a claim (`row.run`): the claim is
 * written before the prompt, the run goes on outside the drain that started it, and its end is
 * the engine's one closing (`closeRun`), whoever holds the conversation by then.
 *
 * A caller cannot start a turn but through `fire`: it holds neither a lease nor an executor.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CEILING, type EngineSinks, type Executor, type ExecutorView, type FileMark, type Proof, type QuietMark, DEAD_AFTER_ATTEMPTS, bury, changesSomething, claimAlive, closeRun, conversationHas, decideDrain, drain, jobQueued, plainRunId, proofOf, quietMark, sessionFileEntries, stillQuiet } from "./engine.ts";
import { type ConversationId, parseLane } from "./lane.ts";
import { DELIVERY_JOB_ID, type LeaseHolder, type LeaseStore, closedConversation, liveHolderPid } from "./lease.ts";
import { markDetails, markFor } from "./mark.ts";
import { previewRedacted, redact } from "./redact.ts";
import type { ClaimedRow, RequestStore, Row, UnclaimedRow } from "./requests.ts";
import { type RunList, STOPPED_BY_PERSON } from "./run-list.ts";
import { type RunnerResult, type SubagentRunner, failedRun } from "./runner.ts";
import { stamp } from "./schedule.ts";
import { shortSessionId } from "./session-head.ts";
import { oneShotDone } from "./settle.ts";
import type { SubagentSlot } from "./slots.ts";
import type { JobStore, LoopJob, RunRecord } from "./store.ts";
import { FAILING_AFTER } from "./backoff.ts";

/** A closed conversation this process holds: its lease at the epoch it took, and its file. */
export interface Held {
	readonly sessionId: ConversationId;
	readonly epoch: number;
	readonly sessionFile: string;
	readonly cwd?: string;
}

/** What the executor is made from. Every store is a parameter. */
export interface BackgroundDeps {
	/** The loops directory: `jobs.json`'s mark for the quiet check. */
	dir: string;
	requests: RequestStore;
	leases: LeaseStore;
	/** jobs.json and the run log. */
	jobs: Pick<JobStore, "load" | "allRuns" | "remove">;
	/** The process's list of the runs that are going. A held turn is in it from its claim to its closing. */
	runs: RunList;
	runner: SubagentRunner;
	sinks: () => EngineSinks;
	/** This process as a lease holder. Its `pid` and `procStart` are a claim's too. */
	holder: (busy?: LeaseHolder["busy"]) => LeaseHolder;
	/** The browser page has this conversation open: its pi writes the file, and this process never holds it. */
	pageHolds?: (sessionId: string) => boolean;
	/** pi's saved trust for a conversation's directory, read for each turn. */
	ownerTrusts?: (cwd: string) => boolean;
	/** How long a turn may run when its job does not say. */
	turnTimeoutMs: number;
	/** An append row was written into a closed conversation: its audit line and its notice. */
	appended: (row: UnclaimedRow, into: Held) => void;
	/** A delivery threw: the conversation is not rung again before the next tick. */
	deliveryFailed: (sessionId: string) => void;
	/** A job reached `FAILING_AFTER` failures in a row at the end of a turn here. */
	failing?: (message: string, job: LoopJob) => void;
	log: (message: string, level?: "info" | "warning") => void;
}

export interface BackgroundExecutor {
	/**
	 * A plain job's tick in a closed conversation, after the budget line, the failure pause and the
	 * sub-agent slot. `permit` is that slot: a caller without one cannot call this, and the caller
	 * releases it when the promise settles.
	 *
	 * In order: the lease (its `busy` names the row that is expected to run); `clock`, when a slot
	 * is due, which writes the slot's row and counts the slot under that lease's epoch; one drain,
	 * which may start one turn of this job; the turn and its closing; the lease given back. A lease
	 * that is refused, or a clock that answers `lost`, starts nothing, and the slot stays owed. It
	 * resolves when the lease is given back, and never rejects.
	 */
	fire(job: LoopJob, due: string | undefined, permit: SubagentSlot, clock: () => Promise<"fired" | "collapsed" | "lost">, now: number): Promise<void>;
	/** Whether a row of `job` is queued that `fire` would start now. The tick asks it for a job with nothing due. */
	owes(job: Pick<LoopJob, "id" | "sessionId" | "stateful">, now: number): boolean;
	/**
	 * What is queued for one conversation nobody has open: delivered by this process, not left waiting
	 * for a resume. It starts no turn: it has no slot. A conversation whose file is gone can never take
	 * its rows, so they become dead letters. Writes nothing when a drain would change nothing: taking
	 * the lease is itself a write, and this process hears its own writes as rings.
	 */
	deliverSession(sessionId: string): Promise<void>;
	/** Take a closed conversation for one write and deliver what is queued for it. True when `traceId` (if given) is in the conversation after it. */
	deliverQueued(sessionId: string, traceId?: string): Promise<boolean>;
}

/** The job a plain job's row names. */
const jobOf = (row: Row): string | undefined => (row.source.startsWith("cron:") ? row.source.slice("cron:".length) : undefined);

/** The job's row that `fire` would start now: unclaimed, not dead, its backoff over. */
function turnOwed(rows: readonly Row[], jobId: string, now: number): UnclaimedRow | undefined {
	return rows.find((r): r is UnclaimedRow => r.kind === "input" && r.wake === "turn" && jobOf(r) === jobId && !r.run && r.attempts < DEAD_AFTER_ATTEMPTS && !(r.not_before !== undefined && Date.parse(r.not_before) > now));
}

export function createBackgroundExecutor(deps: BackgroundDeps): BackgroundExecutor {
	const { requests, leases, runs, log } = deps;
	/** Per closed conversation, the quiet mark of its last "nothing to do" (src/engine.ts quietMark). */
	const quiet = new Map<string, QuietMark>();
	const fileMark = (file: string): FileMark => {
		try {
			const { size, mtimeMs } = fs.statSync(file);
			return { size, mtimeMs };
		} catch {
			return undefined; // not there: a mark of its own, so its appearance is a change
		}
	};
	const canHold = (sessionId: string): boolean => !deps.pageHolds?.(sessionId) && closedConversation(leases, sessionId);

	/** Take a closed conversation for one piece of work, or undefined: the page has it open, a window holds it, or it was written a moment ago. */
	function take(sessionId: ConversationId, busy: NonNullable<LeaseHolder["busy"]>): Held | undefined {
		if (deps.pageHolds?.(sessionId)) return undefined;
		const got = leases.acquireForHost(sessionId, deps.holder(busy));
		if (!("lease" in got) || !got.lease.sessionFile) return undefined;
		return { sessionId, epoch: got.lease.epoch, sessionFile: got.lease.sessionFile, cwd: got.lease.cwd };
	}

	/** Give it back, with the epoch it took and the file's mtime as it left it. A window that took the conversation keeps it: the epoch moved. */
	function release(held: Held): void {
		let fileMtimeMs: number | undefined;
		try {
			fileMtimeMs = fs.statSync(held.sessionFile).mtimeMs;
		} catch {
			fileMtimeMs = undefined; // gone: nothing for the quiet guard to remember
		}
		try {
			leases.release(held.sessionId, deps.holder(), { epoch: held.epoch, fileMtimeMs });
		} catch (err: any) {
			log(`lease ${shortSessionId(held.sessionId)}: ${err?.message ?? err}`);
		}
	}

	/**
	 * A proof that reads the conversation as a plain file, and the run log. Nothing here opens the
	 * conversation with pi's session manager but an append under the lease: an open can write, and
	 * a closing runs with or without the lease. The entries are kept while the file stands as it was.
	 */
	function fileProof(lane: string, sessionFile: string): Proof {
		let read: { mark: string; entries: unknown[] } | undefined;
		const entries = (): unknown[] => {
			const mark = JSON.stringify(fileMark(sessionFile) ?? null);
			if (read?.mark !== mark) read = { mark, entries: sessionFileEntries(sessionFile) };
			return read.entries;
		};
		return proofOf(lane, entries, () => deps.jobs.allRuns());
	}

	/**
	 * The view of a conversation's lane. `job` is the job whose turn this drain may start; a drain
	 * with none (a delivery: it has no sub-agent slot) starts no turn.
	 */
	function viewOf(sessionId: string, job: LoopJob | undefined): ExecutorView {
		const turn = runs.turnIn(sessionId);
		return {
			kind: "held",
			ceiling: CEILING.held,
			// While a turn of this process runs in the conversation its runner is writing the file, so
			// nothing is appended beside it: only a stop or a cancel acts, and the inputs wait.
			blocked: (row) => {
				if (runs.turnIn(sessionId)) return "a turn of pi-loops is writing this conversation";
				if (row.wake !== "turn") return undefined;
				// A rule's push that asks for a turn waits for a window, as it always has.
				if (jobOf(row) === undefined) return "turn rows wait for a window";
				return job !== undefined && jobOf(row) === job.id ? undefined : "its turn starts at its job's next tick";
			},
			// The rule of a lease's holder. A claim of this process whose run is not in the list (its
			// closing threw) is closed by `deliverSession`, at every tick, before this is asked.
			claimLive: (row) => claimAlive(row),
			idle: turn === undefined,
			running: turn && { requestId: turn.runId, startedAt: turn.startedAt },
			inFlight: new Set(),
			connected: () => true,
			producerAlive: () => true,
			mine: () => false,
		};
	}

	/**
	 * The engine's executor for one drain, under one lease. An `append` row is written into the file
	 * at once. No attended row runs here (`CEILING.held`). `turn` claims a row and starts its run.
	 */
	function executorFor(held: Held, job: LoopJob | undefined): Executor & { started(): Promise<void> | undefined } {
		let sm: SessionManager | undefined;
		let started: Promise<void> | undefined;
		const proof = fileProof(held.sessionId, held.sessionFile);
		return {
			holds: (sessionId) => leases.holds(sessionId, deps.holder(), held.epoch),
			proof: () => proof,
			view: () => viewOf(held.sessionId, job),
			append: (row) => {
				sm ??= SessionManager.open(held.sessionFile);
				// The mark rides in the entry's details: the one proof of an append row, read by `landed` (src/mark.ts).
				sm.appendCustomMessageEntry("pi-loops:trigger", row.payload?.text ?? "", true, markDetails(markFor(row)));
				deps.appended(row, held);
				return "sent";
			},
			// The engine calls it only for a row `blocked` let through, so `job` is there and is the row's.
			turn: (row, now) => {
				if (!job) throw new Error("a delivery starts no turn");
				const { pid, procStart } = deps.holder();
				// What the page's waiting line calls it: a job's id is 32 characters no person typed.
				const label = job.name ?? row.id.slice(0, 12);
				// The claim, and the run in the list, in one step. A throw here wrote no claim.
				const claimed = runs.claim(requests, row, { pid, procStart }, { jobId: job.id, label: job.name ?? job.id, promptPreview: previewRedacted(job.prompt, 120), ctrl: new AbortController(), turn: { ...held, label } }, now);
				if (!claimed) return "sent"; // the row left meanwhile: nothing to send, and the lease is as it was
				// From here nothing throws: a failure to start goes through the closing. The lease names
				// this run already: `fire` took it for the row it owed, or for the slot's own row.
				started = runTurn(claimed, held, job);
				return "sent";
			},
			// As `/triggers abort` does: the run's AbortController.
			abort: () => {
				const turn = runs.turnIn(held.sessionId);
				if (turn) runs.stop(turn.runId);
			},
			// Never asked: nothing is in flight here (the view's set is empty), a row is in the file or not.
			abortWhenStarted: () => undefined,
			// Never asked either: a person row is attended, above this executor's ceiling.
			refused: () => undefined,
			started: () => started,
		};
	}

	/** One held turn, from its claim to its closing. It never rejects. */
	async function runTurn(row: ClaimedRow, held: Held, job: LoopJob): Promise<void> {
		const runId = row.run.id;
		const name = job.name ?? job.id;
		const run = runs.get(runId);
		const signal = run?.ctrl.signal ?? AbortSignal.abort();
		const stillHolds = () => leases.holds(held.sessionId, deps.holder(), held.epoch);
		log(`cron ${name}: turn ${runId.slice(0, 12)} in session ${shortSessionId(held.sessionId)}`);
		let result: RunnerResult;
		try {
			// A stop that was queued before the model is asked names this run already: read it now, under
			// the turn's own lease. The inputs wait (`blocked`); only a stop or a cancel acts.
			try {
				await drain(held.sessionId, requests, executorFor(held, undefined), Date.now(), deps.sinks());
			} catch (err: any) {
				log(`requests for session ${shortSessionId(held.sessionId)}: ${err?.message ?? err}`);
			}
			if (signal.aborted || !stillHolds()) {
				// Stopped or taken back before it began: nothing to run, and no model call to start.
				log(`cron ${name}: turn ${runId.slice(0, 12)} stopped before it began`);
				result = failedRun("aborted", { stopReason: "aborted" });
			} else {
				// As the conversation's owner: pi's own trust for its directory, read now, and the job's
				// declared tools. Without the conversation's own directory (an older lease), the job's cwd
				// could be one a model chose: no owner trust then. No model or thinking level: the turn is
				// the conversation's own and runs on what the conversation is on, as its window turn does.
				const cwd = held.cwd ?? job.cwd;
				result = await deps.runner({ cwd, prompt: row.payload?.text ?? "", tools: job.tools, builtinTools: job.builtinTools, trusted: held.cwd ? !!deps.ownerTrusts?.(held.cwd) : false, timeoutMs: job.timeoutMs ?? deps.turnTimeoutMs, signal, hop: 1, kind: "held", jobId: job.id, runId, sessionFile: held.sessionFile, stillHolds, parentSessionId: held.sessionId, parentCwd: cwd });
			}
		} catch (err: any) {
			result = failedRun(err?.message ?? String(err));
		}
		// Taken back only if the turn did not complete: a window that arrives as the answer is saved
		// has nothing to run again.
		const preempted = !result.ok && !stillHolds();
		const budgetStopped = !result.ok && (result.errorMessage ?? "").startsWith("stopped by today's");
		// A person stopped this turn: it is done, whatever landed.
		const stopped = !result.ok && signal.aborted && signal.reason === STOPPED_BY_PERSON;
		// Handed back unrun: a window took the conversation, or this process stopped the turn itself
		// (a quit, an upgrade, a removed job, the daily budget).
		const handedBack = !result.ok && !stopped && (preempted || signal.aborted || budgetStopped);
		const stoppedFrom = run?.stoppedFrom ?? "cli";
		log(`cron ${name}: ${preempted ? "a window took the session back; its turn stopped" : result.ok ? "turn done" : stopped ? `turn stopped by you (from ${stoppedFrom === "page" ? "the page" : "a terminal"})` : `turn FAILED (${redact(result.errorMessage ?? "unknown error")})`}`);
		// The record of this run, written by its closing. `startedAt` is the claim's stamp, so the
		// closing finds the record by the claim.
		const record: RunRecord = {
			runId,
			jobId: job.id,
			jobName: job.name,
			stateful: false,
			cwd: held.cwd ?? job.cwd,
			pid: process.pid,
			startedAt: row.run.started_at,
			finishedAt: stamp(),
			ok: result.ok,
			exitCode: result.exitCode,
			error: result.ok ? undefined : stopped ? STOPPED_BY_PERSON : redact(result.errorMessage ?? "unknown error"),
			findings: 0,
			droppedFindings: 0,
			stateUpdated: false,
			model: result.model ?? job.model,
			usage: result.usage,
			warning: result.warning,
			retries: result.retries,
			compactions: result.compactions,
			summary: previewRedacted(result.text, 400) || undefined,
			sessionId: held.sessionId,
			sessionFile: held.sessionFile,
			forSession: job.createdBy?.sessionId ?? held.sessionId,
			...(stopped || handedBack ? { aborted: true as const } : {}),
			...(stopped ? { stoppedBy: "person" as const, stoppedFrom } : {}),
		};
		try {
			// The closing asks for no lease and opens no conversation: after a window took it back, the
			// claim is still cleared, and the window is not held by it.
			const closed = await closeRun(requests, deps.sinks(), row, fileProof(held.sessionId, held.sessionFile), Date.now(), record);
			const fate = closed.settlement.row;
			if (handedBack) log(`cron ${name}: ${preempted ? `a window opened session ${shortSessionId(held.sessionId)} during its turn; that window runs it` : `turn stopped (${record.error}); ${fate.do === "leave" ? "a fresh prompt is queued for it" : "its slot is owed"}`}`);
			if (stopped) log(`cron ${name}: turn stopped; it is done`, "info");
			if (closed.job && closed.end.how === "failed" && (closed.job.consecutiveFailures ?? 0) >= FAILING_AFTER) deps.failing?.(`${closed.job.name ?? closed.job.id} has failed ${closed.job.consecutiveFailures} times in a row; backing off (last: ${record.error ?? "unknown"})`, closed.job);
			// The one-shot rule, asked at once; the tick asks it again after a crash.
			if (closed.job && oneShotDone(closed.job, jobQueued(closed.job.id, requests.list(held.sessionId)))) await deps.jobs.remove(closed.job.id);
		} catch (err: any) {
			// The claim stays, and the run leaves the list below: the next delivery closes it.
			log(`cron ${job.id}: could not close its turn (${err?.message ?? err})`);
		} finally {
			runs.remove(runId);
		}
	}

	async function fire(job: LoopJob, due: string | undefined, _permit: SubagentSlot, clock: () => Promise<"fired" | "collapsed" | "lost">, now: number): Promise<void> {
		const lane = parseLane(job.sessionId ?? "");
		if (lane?.kind !== "conversation") return;
		try {
			const rows = requests.list(lane.id);
			const owed = turnOwed(rows, job.id, now);
			// A row of this job that cannot start yet (it backs off, or it is at its last attempt and
			// waits for its dead letter): the slot waits behind it, as it waits behind a turn that is going.
			if (!owed && (due === undefined || rows.some((r) => r.kind === "input" && r.wake === "turn" && jobOf(r) === job.id && !r.run))) return;
			const held = take(lane.id, { runId: owed?.id ?? plainRunId(job.id, due ?? ""), jobId: job.id, since: stamp(now) });
			if (!held) return; // busy, open, or written a moment ago: the slot stays owed
			try {
				if (due !== undefined && (await clock()) === "lost") return;
				const executor = executorFor(held, job);
				await drain(lane.id, requests, executor, now, deps.sinks());
				// The run and its closing: the lease is this function's until then.
				await executor.started();
			} finally {
				release(held);
			}
		} catch (err: any) {
			log(`cron ${job.name ?? job.id}: ${err?.message ?? err}`);
		}
	}

	async function deliverQueued(sessionId: string, traceId?: string): Promise<boolean> {
		const lane = parseLane(sessionId);
		if (lane?.kind !== "conversation") return false;
		const held = take(lane.id, { runId: traceId ?? "requests", jobId: DELIVERY_JOB_ID, since: stamp() });
		if (!held) return false;
		try {
			await drain(sessionId, requests, executorFor(held, undefined), Date.now(), deps.sinks());
			if (traceId === undefined) return true;
			const delivered = conversationHas(sessionFileEntries(held.sessionFile), traceId);
			if (delivered) log(`trigger ${traceId.slice(0, 8)}: appended to session ${shortSessionId(sessionId)}`);
			return delivered;
		} catch (err: any) {
			log(`requests for session ${shortSessionId(sessionId)}: ${err?.message ?? err}`);
			// Giving the lease back below rings this process again; with the same failure waiting
			// (an inbox it cannot write), that ring would fail the same way, for ever.
			deps.deliveryFailed(sessionId);
			return false;
		} finally {
			release(held);
		}
	}

	async function deliverSession(sessionId: string): Promise<void> {
		// Only a conversation is delivered to here, or buried as one that is gone: a lane of another kind has no session file.
		const conversation = parseLane(sessionId);
		if (conversation?.kind !== "conversation") return;
		const rows = requests.list(sessionId);
		if (!rows.length) {
			quiet.delete(sessionId);
			return;
		}
		// A turn of this process's own is running there: the conversation is held already, for that
		// turn, so a stop or cancel is applied through that lease, with the epoch it took, and nothing
		// is taken a second time. The view holds every input back while the runner has the file.
		const turn = runs.turnIn(sessionId);
		const own = turn && runs.get(turn.runId)?.turn;
		if (own) {
			await drain(sessionId, requests, executorFor(own, undefined), Date.now(), deps.sinks());
			return;
		}
		const lease = leases.read(sessionId);
		// A claim of this process with no run in the list: its closing threw. Closed here, with or
		// without the lease, so that a window that took the conversation is not held by it for ever.
		const self = deps.holder();
		if (lease?.sessionFile) {
			for (const row of rows) {
				if (row.run && row.run.pid === self.pid && row.run.procStart === self.procStart && runs.get(row.run.id) === undefined) await closeRun(requests, deps.sinks(), row, fileProof(sessionId, lease.sessionFile), Date.now());
			}
		}
		if (!canHold(sessionId)) {
			if (liveHolderPid(leases, sessionId) !== undefined || deps.pageHolds?.(sessionId)) return; // its holder drains it
			const file = lease?.sessionFile;
			if (file && fs.existsSync(file)) return; // there, only busy or recently written: a later tick
			const buried = await bury(conversation.id, requests, deps.sinks(), "its conversation is gone");
			if (buried.length) log(`${buried.length} queued request(s) for session ${shortSessionId(sessionId)} went to the inbox: its conversation is gone`);
			return;
		}
		// The same decision the drain makes, read without the lease (a read needs none). Marked before
		// the read, so a write that lands during it shows as a change on the next tick, not a miss.
		const file = lease?.sessionFile;
		if (!file) return;
		const files = [fileMark(file), fileMark(path.join(deps.dir, "jobs.json"))];
		const now = Date.now();
		const queued = requests.list(sessionId);
		if (stillQuiet(quiet.get(sessionId), files, queued, now)) return;
		quiet.delete(sessionId);
		if (!changesSomething(decideDrain("conversation", queued, fileProof(sessionId, file), deps.sinks().jobs, viewOf(sessionId, undefined), now))) {
			quiet.set(sessionId, quietMark(files, queued, now));
			return;
		}
		await deliverQueued(sessionId);
	}

	return {
		fire,
		owes: (job, now) => !job.stateful && job.sessionId !== undefined && turnOwed(requests.list(job.sessionId), job.id, now) !== undefined,
		deliverSession,
		deliverQueued,
	};
}
