/**
 * Everything pi-loops in the background does to the queue of a closed conversation: it takes the
 * conversation's lease and gives it back, writes a rule's result into the file, starts a plain
 * job's turn, runs it, and closes it. A turn is a row with a claim (`row.run`): the claim is
 * written before the prompt, the run goes on outside the drain that started it, and its end is
 * the engine's one closing (`closeRun`), whoever holds the conversation by then.
 *
 * A caller cannot start a turn but through `fire`: it holds neither a lease nor an executor.
 */
import { HOLD_FILE } from "./upgrade-hold.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { type ResolvedCap, isAnswerRow, resolveCap } from "./ask.ts";
import { CEILING, type EngineSinks, type Executor, type ExecutorView, type FileMark, type Proof, type QuietMark, DEAD_AFTER_ATTEMPTS, bury, changesSomething, claimAlive, closeRun, conversationHas, decideDrain, drain, jobQueued, laneClaimLive, modeOf, plainRunId, plainJobRow, proofOf, quietMark, sessionFileEntries, stillQuiet } from "./engine.ts";
import { type ConversationId, parseLane } from "./lane.ts";
import { DELIVERY_JOB_ID, type LeaseHolder, type LeaseStore, closedConversation, liveHolderPid } from "./lease.ts";
import { markDetails, markFor } from "./mark.ts";
import { previewRedacted, redact } from "./redact.ts";
import type { ClaimedRow, RequestStore, Row, UnclaimedRow } from "./requests.ts";
import { type RunList, STOPPED_BY_PERSON } from "./run-list.ts";
import { type RunnerResult, type SubagentRunner, failedRun } from "./runner.ts";
import { formatLocal, stamp } from "./schedule.ts";
import { shortSessionId } from "./session-head.ts";
import { oneShotDoneV3 } from "./settle.ts";
import type { SubagentSlot, SubagentSlots } from "./slots.ts";
import type { JobStore, LoopJob, RunRecord } from "./store.ts";
import { FAILING_AFTER } from "./backoff.ts";
import { loopLane, type LaneId } from "./lane.ts";
import { type CheckDeps, type GateLet, envelopeOf, runCheck } from "./check-run.ts";
import type { EventLog } from "./events.ts";
import { withinProject } from "./paths.ts";
import { pushTrigger } from "./push.ts";
import { type DynamicTriggerRule, type Trigger, type TriggerStore, buildPeriodicCheckTrigger } from "./triggers.ts";
import { runLoop, closeLoopRun, type LoopRunDeps } from "./loop-run.ts";
import { budgetState, loopWait } from "./job-status.ts";

/** A closed conversation this process holds: its lease at the epoch it took, and its file. */
export interface Held {
	readonly sessionId: ConversationId;
	readonly epoch: number;
	readonly sessionFile: string;
	readonly cwd?: string;
	/** The file's mtime read just before the lease was taken: a hold that wrote nothing gives back no later one. */
	readonly mtimeMs?: number;
}

/** What the executor is made from. Every store is a parameter. */
export interface BackgroundDeps {
	/** The loops directory: `jobs.json`'s mark for the quiet check. */
	dir: string;
	requests: RequestStore;
	leases: LeaseStore;
	/** jobs.json and the run log. */
	jobs: Pick<JobStore, "load" | "allRuns" | "remove">;
	/** A job's slots the clock has counted (`clock.json`): a plain one-shot is done once one is. */
	runsOf: (jobId: string) => number;
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
	/** The `ans-` rows of a closed conversation, met before its other rows and before a conversation that is gone is buried (src/answer-lanes.ts). */
	answers?: (sessionId: ConversationId) => Promise<unknown>;
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
	/** A closed conversation for an answer's turn there (src/answer-lanes.ts): its lease, taken for one run and given back. */
	readonly conversations: HeldConversations;
}

/** What an answer's turn in a closed conversation holds it by: `take` and `release` of this executor, and what a held turn asks of it. */
export interface HeldConversations {
	/** No window and no page holds it. A conversation whose file is gone is closed too. */
	closed(sessionId: ConversationId): boolean;
	/** Its lease, for the run `runId`; `refused` says why not: a window or the page holds it, it was written a moment ago, or its file is gone. */
	hold(sessionId: ConversationId, runId: string, now: number): Held | { refused: string };
	/** Given back, with the epoch it took. `wrote`: this hold wrote the file, so its mtime as it is now is this process's. */
	release(held: Held, wrote: boolean): void;
	/** This process still holds it at that epoch: false once a window took it back. */
	holds(held: Held): boolean;
	/** pi's saved trust for its directory, read for each turn; no directory, no trust. */
	trusts(held: Held): boolean;
}

/**
 * The cap of a turn in a closed conversation, as its job is in `jobs.json` now: the conversation's
 * directory, the job's tools and time limit, and no model or thinking level of its own: the turn runs
 * on what the conversation is on. With no job (it was removed), the conversation's tools and the
 * default time limit.
 */
export function heldCap(job: Pick<LoopJob, "tools" | "builtinTools" | "timeoutMs"> | undefined, cwd: string, defaultTimeoutMs: number): ResolvedCap {
	return resolveCap({ cwd, tools: job?.tools, builtinTools: job?.builtinTools, timeoutMs: job?.timeoutMs }, defaultTimeoutMs);
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
	/** No window and no page holds it, whether or not its file is there. */
	const closed = (sessionId: ConversationId): boolean => !deps.pageHolds?.(sessionId) && liveHolderPid(leases, sessionId) === undefined;

	/** Take a closed conversation for one piece of work, or undefined: the page has it open, a window holds it, or it was written a moment ago. */
	function take(sessionId: ConversationId, busy: NonNullable<LeaseHolder["busy"]>): Held | undefined {
		const got = takeOrWhy(sessionId, busy);
		return "refused" in got ? undefined : got;
	}

	function takeOrWhy(sessionId: ConversationId, busy: NonNullable<LeaseHolder["busy"]>): Held | { refused: string } {
		if (deps.pageHolds?.(sessionId)) return { refused: "the page has it open" };
		// Before the lease: a write that lands between this read and the release is never taken for ours.
		const before = leases.read(sessionId)?.sessionFile;
		const mtimeMs = before === undefined ? undefined : fileMark(before)?.mtimeMs;
		const got = leases.acquireForHost(sessionId, deps.holder(busy));
		if (!("lease" in got)) return got;
		if (!got.lease.sessionFile) return { refused: "no known session file" };
		return { sessionId, epoch: got.lease.epoch, sessionFile: got.lease.sessionFile, cwd: got.lease.cwd, ...(got.lease.sessionFile === before && mtimeMs !== undefined ? { mtimeMs } : {}) };
	}

	/**
	 * Give it back, with the epoch it took. The file's mtime is left for the quiet guard only when it
	 * is this process's: this hold wrote the file, or nobody wrote it since the lease was taken. A write
	 * by someone else during a hold that wrote nothing keeps the guard's two minutes. A window that took
	 * the conversation keeps it: the epoch moved.
	 */
	function release(held: Held, wrote: boolean): void {
		const now = fileMark(held.sessionFile)?.mtimeMs; // gone: nothing for the quiet guard to remember
		const fileMtimeMs = wrote || (now !== undefined && now === held.mtimeMs) ? now : undefined;
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
	function executorFor(held: Held, job: LoopJob | undefined): Executor & { started(): Promise<void> | undefined; wrote(): boolean } {
		let sm: SessionManager | undefined;
		let started: Promise<void> | undefined;
		let wrote = false;
		const proof = fileProof(held.sessionId, held.sessionFile);
		return {
			holds: (sessionId) => leases.holds(sessionId, deps.holder(), held.epoch),
			proof: () => proof,
			view: () => viewOf(held.sessionId, job),
			append: (row) => {
				wrote = true;
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
				wrote = true;
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
			wrote: () => wrote,
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
				// The guard's seat: a dangerous call files a question in this conversation's lane, as a loop's run does in its own.
				const guard = { lane: held.sessionId, origin: { source: `cron:${name}`, run_id: runId, cwd, job_id: job.id, session_id: held.sessionId, who: name }, cap: heldCap(job, cwd, deps.turnTimeoutMs) };
				result = await deps.runner({ cwd, prompt: row.payload?.text ?? "", tools: job.tools, builtinTools: job.builtinTools, trusted: held.cwd ? !!deps.ownerTrusts?.(held.cwd) : false, timeoutMs: job.timeoutMs ?? deps.turnTimeoutMs, signal, hop: 1, kind: "held", jobId: job.id, runId, sessionFile: held.sessionFile, sessionId: held.sessionId, stillHolds, parentSessionId: held.sessionId, parentCwd: cwd, guard });
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
			row: row.id,
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
			const streak = closed.job ? deps.sinks().counts(closed.job.id).streak : 0;
			if (closed.job && closed.end.how === "failed" && streak >= FAILING_AFTER) deps.failing?.(`${closed.job.name ?? closed.job.id} has failed ${streak} times in a row; backing off (last: ${record.error ?? "unknown"})`, closed.job);
			// The one-shot rule, asked at once; the tick asks it again after a crash.
			if (closed.job && oneShotDoneV3(closed.job, { queued: jobQueued(closed.job.id, requests.list(held.sessionId)) || undefined, runs: deps.runsOf(closed.job.id), ...(streak ? { error: { streak } } : {}) })) await deps.jobs.remove(closed.job.id);
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
			let executor: ReturnType<typeof executorFor> | undefined;
			try {
				if (due !== undefined && (await clock()) === "lost") return;
				executor = executorFor(held, job);
				await drain(lane.id, requests, executor, now, deps.sinks());
				// The run and its closing: the lease is this function's until then.
				await executor.started();
			} finally {
				release(held, executor?.wrote() ?? false);
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
		const executor = executorFor(held, undefined);
		try {
			await drain(sessionId, requests, executor, Date.now(), deps.sinks());
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
			release(held, executor.wrote());
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
		// The answers first, while nobody holds the conversation: one that is gone is met as gone
		// (the finding says so) before `bury` below sees its lane.
		if (deps.answers && closed(conversation.id) && rows.some(isAnswerRow)) {
			try {
				await deps.answers(conversation.id);
			} catch (err: any) {
				log(`answers in session ${shortSessionId(sessionId)}: ${err?.message ?? err}`);
			}
		}
		const lease = leases.read(sessionId);
		// A claim of this process with no run in the list: its closing threw. Closed here, with or
		// without the lease, so that a window that took the conversation is not held by it for ever.
		// An `ans-` row's claim is the answer protocol's to close (F1 to F3).
		const self = deps.holder();
		if (lease?.sessionFile) {
			for (const row of rows) {
				if (row.run && !isAnswerRow(row) && row.run.pid === self.pid && row.run.procStart === self.procStart && runs.get(row.run.id) === undefined) await closeRun(requests, deps.sinks(), row, fileProof(sessionId, lease.sessionFile), Date.now());
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
		// The upgrade's pause is part of the decision (src/engine.ts): its end is a change, as jobs.json's is.
		const files = [fileMark(file), fileMark(path.join(deps.dir, "jobs.json")), fileMark(path.join(deps.dir, HOLD_FILE))];
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
		conversations: {
			closed,
			hold: (sessionId, runId, now) => takeOrWhy(sessionId, { runId, since: stamp(now) }),
			release,
			holds: (held) => leases.holds(held.sessionId, deps.holder(), held.epoch),
			trusts: (held) => (held.cwd ? !!deps.ownerTrusts?.(held.cwd) : false),
		},
	};
}

export interface LoopLaneDeps extends LoopRunDeps {
	slots: SubagentSlots;
	budgetCap(): number | undefined;
	cwdExists(cwd: string): boolean;
}

/** How long a loop waits for a missing checkout before its job is disabled: main's grace (a mount often comes up after pi-loops). */
const CWD_GRACE_MS = 30 * 60_000;


export interface LoopLanes {
	drainAll(now: number): Promise<void>;
	drain(lane: Extract<ReturnType<typeof parseLane>, { kind: "loop" }>, now: number): ReturnType<typeof drain>;
	runNow(jobId: string, requestedBy?: { sessionId: string }): Promise<true | string>;
	stop(drainMs: number): Promise<void>;
	/** Wait up to `ms` for the runs this drain started to close, without aborting them. */
	settle(ms: number): Promise<void>;
}

/**
 * Stop each run whose job is not in `jobs.json`. A run of an answer row whose lane is not a loop lane
 * is left: a check lane and a conversation are in no `jobs.json`, and a person's yes there is not a
 * run of a removed job. An answer's run in a removed loop's lane is stopped.
 */
export function abortRemovedJobs(runs: Pick<RunList, "all">, exists: (jobId: string) => boolean, log: (line: string) => void): number {
	let aborted = 0;
	for (const run of runs.all()) {
		if (run.answer && parseLane(run.answer.lane)?.kind !== "loop") continue;
		// A check lane's own run (a push, a periodic check) names its lane, which is no job either.
		if (parseLane(run.jobId)?.kind === "check") continue;
		if (exists(run.jobId) || run.ctrl.signal.aborted) continue;
		run.ctrl.abort();
		log(`cron ${run.label}: removed while it ran; stopped run ${run.runId}`);
		aborted++;
	}
	return aborted;
}

/**
 * The test of the drain's pre-pass: a claim of this process whose run left the list. Its run ended
 * here and its closing threw before it wrote the row, so the slot is spent. An `ans-` row is passed
 * over: the answer lane (src/answer-lanes.ts) finds that claim not live (`answerClaimLive`), and
 * counts it (F1) or closes it (F2, F3). The loop lane's drain reads its liveness the same way, so the
 * claim does not hold the lane meanwhile.
 */
export function spentOwnClaim(row: Row, self: { readonly pid: number; readonly procStart: string | undefined }, listed: (runId: string) => boolean): boolean {
	return !isAnswerRow(row) && row.run !== undefined && row.run.pid === self.pid && row.run.procStart === self.procStart && !listed(row.run.id);
}

export function createLoopLanes(deps: LoopLaneDeps): LoopLanes {
	const { stores, runs, slots } = deps;
	let stopped = false;
	const inFlight = new Set<Promise<void>>();
	const baseSinks = deps.engine;
	const proof = (lane: LaneId): Proof => proofOf(lane, () => [], () => stores.jobs.allRuns());
	/** When a loop's checkout was first found missing: its clock entry keeps it while it is. */
	const missingSince = (jobId: string): string | undefined => stores.clock.read().jobs[jobId]?.cwdMissing;
	const laneJobs = (): Map<string, LoopJob> => {
		const result = new Map<string, LoopJob>();
		for (const job of stores.book().jobs) {
			const lane = job.stateful ? loopLane(job.id) : undefined;
			if (lane) result.set(lane, job);
		}
		return result;
	};

	async function drainLane(lane: Extract<ReturnType<typeof parseLane>, { kind: "loop" }>, now: number): ReturnType<typeof drain> {
		const jobId = lane.id.slice("@".length);
		const current = laneJobs().get(lane.id);
		const jobs = stores.book().jobs;
		const sinks = baseSinks();
		const self = deps.holder();
		const live = (row: ClaimedRow): boolean => laneClaimLive(row, self, (runId) => runs.get(runId) !== undefined);
		/** Why a scheduled row of this loop waits for its gates: a missing directory, the budget, the slots. */
		const gateOf = (row: UnclaimedRow): string | undefined => {
			const job = jobs.find((item) => item.id === jobId);
			if (!job || !job.enabled || row.source.startsWith("cron-run:")) return undefined;
			// Main's order: the directory, the budget, a failure's backoff, then the slots. A row in its
			// backoff is not "deferred": the backoff writes no reason of its own.
			const backingOff = row.not_before !== undefined && Date.parse(row.not_before) > now;
			return loopWait({ cwd: job.cwd }, missingSince(jobId), {
				cwdExists: deps.cwdExists,
				budget: () => budgetState(stores.jobs, deps.budgetCap(), now),
				...(backingOff ? {} : { slots: () => ({ inUse: slots.inUseCount, free: slots.free, limit: slots.limit }) }),
			}, now);
		};
		const executor: Executor = {
			holds: () => true,
			proof: () => proof(lane.id),
			view: () => ({
				kind: "held", ceiling: CEILING.held, idle: !runs.all().some((run) => run.jobId === jobId),
				running: undefined, inFlight: new Set(), connected: () => true, producerAlive: () => true,
				mine: () => false, claimLive: live,
				blocked: (row) => {
					if (row.source.startsWith("cron-run:")) return undefined;
					const job = jobs.find((item) => item.id === jobId);
					if (!job) return undefined;
					if (!job.enabled) return "its job is disabled";
					return gateOf(row);
				},
			}),
			turn: (row) => {
				if (stopped) return "no-slot";
				const permit = row.source.startsWith("cron-run:") ? slots.occupy() : slots.acquire();
				if (!permit) return "no-slot";
				const job = laneJobs().get(lane.id);
				if (!job) { permit.release(); return "sent"; }
				const claimed = runs.claim(stores.requests, row, deps.holder(), { jobId, label: job.name ?? job.id, promptPreview: previewRedacted(row.payload?.text ?? job.prompt, 120), ctrl: new AbortController() }, now);
				if (!claimed) { permit.release(); return "sent"; }
				const task = runLoop(claimed, job, deps).finally(() => { permit.release(); inFlight.delete(task); }).catch((error) => deps.sinks.log(`loop ${jobId}: ${error instanceof Error ? error.message : String(error)}`));
				inFlight.add(task);
				return "sent";
			},
			append: () => "sent", abort: () => { const run = runs.all().find((item) => item.jobId === jobId); if (run) runs.stop(run.runId); },
			abortWhenStarted: () => undefined, refused: () => undefined,
			close: (row, at) => closeLoopRun(row, deps, at),
		};
		// A claim of this process whose run is no longer in the list: the run ended here, and its closing
		// threw before it wrote the row. The run happened, so its slot is spent, as main spends it when the
		// end of a run fails: it does not run again, here or after a restart.
		for (const row of stores.requests.list(lane.id)) {
			if (!spentOwnClaim(row, self, (runId) => runs.get(runId) !== undefined)) continue;
			stores.requests.remove(lane.id, [row.id]);
			deps.sinks.log(`loop ${jobId}: run ${row.run!.id.slice(0, 12)} ended without its closing; its slot is spent`, "info", current);
		}
		if (current) {
			// Main's rule: the grace counts from the first look that found the checkout missing (a mount
			// that comes up after pi-loops is the common case), not from when the row was queued.
			const row = stores.requests.list(lane.id).find((item) => item.kind === "input" && !item.run && (item.source.startsWith("cron:") || item.source.startsWith("wake:")));
			if (row && current.enabled && !deps.cwdExists(current.cwd)) {
				const marked = missingSince(current.id);
				const since = Date.parse(marked ?? "") || now;
				if (now - since >= CWD_GRACE_MS) {
					await stores.jobs.disable(current.id, { code: "cwd-missing", at: stamp(now), why: `disabled: cwd ${current.cwd} has been missing since ${formatLocal(since)} (re-enable after /cron add --cwd or restoring it)` });
					stores.requests.remove(lane.id, [row.id]); // the slot is spent; a re-enabled job does not run the stale row
					deps.sinks.log(`cron ${current.name ?? current.id}: disabled, cwd ${current.cwd} missing since ${formatLocal(since)}`, undefined, current);
				} else if (!marked) stores.clock.cwdMissing(current.id, stamp(since));
			} else if (missingSince(current.id) && deps.cwdExists(current.cwd)) stores.clock.cwdMissing(current.id, undefined);
		}
		const result = await drain(lane.id, stores.requests, executor, now, sinks);
		// Main's overlap rule, at each tick of an enabled job (a disabled one was passed over before it): a
		// slot due while the loop's run goes is skipped. A scheduled row that waited (for a slot, the
		// budget, a backoff) while another run of the same loop started before this drain (a person's
		// /cron run) is that skip: it is counted on the running row and spent.
		try {
			const rows = stores.requests.list(lane.id);
			// An answer's run is never one this drain started, so one the answer lane started in this tick counts too.
			const going = rows.find((row): row is ClaimedRow => row.run !== undefined && live(row as ClaimedRow) && (isAnswerRow(row) || Date.parse(row.run.started_at) < now));
			const overlapped = going && current?.enabled ? rows.filter((row) => !row.run && row.kind === "input" && row.source === `cron:${jobId}`) : [];
			for (const row of overlapped) {
				const slot = row.collapsed_slot ?? row.payload?.slot ?? row.created_at;
				if (stores.requests.collapse(lane.id, going!.id, slot, true) === "counted") stores.clock.countCollapse(jobId);
				stores.requests.remove(lane.id, [row.id]);
				deps.sinks.log(`cron ${current?.name ?? jobId}: skipped: previous run still active (its ${slot} slot)`, "info", current);
			}
		} catch (error) {
			deps.sinks.log(`loop ${jobId}: could not count an overlap: ${error instanceof Error ? error.message : String(error)}`, undefined, current);
		}
		// The lists cannot ask the gates (a window does not know the slots or the budget): the reason
		// this drain saw is written on each row that still waits, when it changed, as main wrote lastError.
		// An `ans-` row's reason has one writer, the answer lane (`Answers.meet`'s hold).
		try {
			for (const row of stores.requests.list(lane.id)) {
				if (row.run || row.kind !== "input" || isAnswerRow(row)) continue;
				const why = gateOf(row);
				if (why !== row.waiting) stores.requests.update(lane.id, row.id, { waiting: why });
			}
		} catch (error) {
			deps.sinks.log(`loop ${jobId}: could not note why its row waits: ${error instanceof Error ? error.message : String(error)}`, undefined, current);
		}
		return result;
	}

	return {
		async drainAll(now) {
			for (const lane of stores.requests.lanes()) if (lane.kind === "loop") {
				const jobId = lane.id.slice("@".length);
				if (!stores.book().jobs.some((job) => job.id === jobId && job.stateful)) {
					// A removed job's rows still need the drain that takes them out as `job-removed`; any other row in such a lane is not this executor's.
					const removed = stores.requests.list(lane.id).some((row) => row.source.startsWith("cron:") || row.source.startsWith("cron-run:") || row.source.startsWith("wake:"));
					if (!removed) continue;
				}
				try { await drainLane(lane, now); }
				catch (error) { deps.sinks.log(`loop lane ${lane.id}: ${error instanceof Error ? error.message : String(error)}`); }
			}
		},
		drain: drainLane,
		async runNow(jobId, requestedBy) {
			const job = stores.book().jobs.find((item) => item.id === jobId);
			if (!job) return "is no longer in the store";
			if (!job.stateful) return "cannot run: its id is not a loop id";
			// A proposal runs only after the person sets it up, whoever asks for a run (design 2.5).
			if (job.proposed) return `is proposed and waits for your yes: /cron enable ${job.name ?? job.id} asks again`;
			const lane = loopLane(job.id);
			if (runs.all().some((run) => run.jobId === jobId) || (lane !== undefined && stores.requests.list(lane).some((row) => !!row.run))) return "is already running";
			if (stopped) return "cannot run: pi-loops is stopping";
			if (!lane) return "cannot run: its id is not a loop id";
			const id = plainRunId(job.id, stamp());
			const base = plainJobRow({ ...job, sessionId: lane }, id, `cron-run:${job.id}`, "", deps.engine().self(), Date.now());
			const row: UnclaimedRow = { ...base, lane, mode: modeOf("loop", "input", `cron-run:${job.id}`, "turn"), payload: { ...base.payload!, ...(requestedBy ? { requested_by: requestedBy.sessionId } : {}) } };
			stores.requests.appendIfAbsent(row);
			// Main's run moved the last fire to now, so for an every or a one-shot schedule a slot that waited
			// (for a slot, the budget, a backoff) was not run after it: that slot's row is spent by this run.
			// A cron expression's slot stayed due; it runs after, unless a drain finds this run still going
			// (main's overlap at its next tick, `drainLane`).
			if (job.schedule.kind === "every" || job.schedule.kind === "once") {
				const owed = stores.requests.list(lane).filter((item) => !item.run && item.kind === "input" && item.source === `cron:${job.id}`);
				if (owed.length) {
					stores.requests.remove(lane, owed.map((item) => item.id));
					deps.sinks.log(`cron ${job.name ?? job.id}: /cron run spends its waiting slot${owed.length === 1 ? "" : "s"} (${owed.map((item) => item.payload?.slot ?? item.created_at).join(", ")})`, "info", job as LoopJob);
				}
			}
			try { await drainLane(parseLane(lane) as Extract<ReturnType<typeof parseLane>, { kind: "loop" }>, Date.now()); }
			catch (error) { deps.sinks.log(`loop lane ${lane}: ${error instanceof Error ? error.message : String(error)}`); }
			return true;
		},
		async stop(drainMs) {
			stopped = true;
			for (const run of runs.all()) if (!run.turn) run.ctrl.abort();
			const deadline = Date.now() + drainMs;
			while (inFlight.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
		},
		async settle(ms) {
			const deadline = Date.now() + ms;
			while (inFlight.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
		},
	};
}

/** What the check lanes run with: the stores, the slots and today's budget, and the deps of one check (src/check-run.ts). */
export interface CheckLaneDeps {
	readonly requests: RequestStore;
	readonly runs: RunList;
	readonly slots: SubagentSlots;
	readonly allRuns: () => readonly RunRecord[];
	readonly events: Pick<EventLog, "get">;
	readonly rules: Pick<TriggerStore, "load" | "appendAudit">;
	readonly budget: () => { spent: number; cap: number; over: boolean };
	readonly check: () => CheckDeps;
	readonly engine: () => EngineSinks;
	readonly holder: () => { readonly pid: number; readonly procStart: string | undefined };
	readonly log: (message: string) => void;
}

export interface CheckLanes {
	drainAll(now: number): Promise<void>;
	drain(lane: LaneId, now: number): ReturnType<typeof drain>;
	stop(drainMs: number): Promise<void>;
	settle(ms: number): Promise<void>;
}

/** A check lane's own rows: a push's and a periodic check's. An `ans-` row is the answer lane's (src/answer-lanes.ts). */
const checkRow = (row: Row): boolean => !isAnswerRow(row) && (row.source.startsWith("push:") || row.source.startsWith("check:"));

/**
 * The rows of a project's check lane that are not answers: each one is one check, run unattended by
 * this process with `runCheck`. A row waits on disk for a free slot and while another run of the lane
 * goes; over today's budget it leaves with `budget_exceeded`, because acting on this morning's event at
 * midnight is worse than not acting.
 */
export function createCheckLanes(deps: CheckLaneDeps): CheckLanes {
	const { requests, runs, slots } = deps;
	let stopped = false;
	const inFlight = new Set<Promise<void>>();
	const rulesOf = (cwd: string): DynamicTriggerRule[] => deps.rules.load().filter((r) => r.enabled && !r.proposed && withinProject(r.cwd, cwd));

	async function drainLane(lane: LaneId, now: number): ReturnType<typeof drain> {
		const sinks = deps.engine();
		const self = deps.holder();
		const live = (row: ClaimedRow): boolean => laneClaimLive(row, self, (runId) => runs.get(runId) !== undefined);
		const proof = proofOf(lane, () => [], deps.allRuns);
		const leave = (row: UnclaimedRow, state: string, why: string, details: Record<string, unknown> = {}): "sent" => {
			requests.remove(lane, [row.id]);
			deps.rules.appendAudit({ cwd: row.payload?.cwd ?? "", type: "trigger", traceId: row.id, state, sourceLabel: row.source.slice(row.source.indexOf(":") + 1), summary: row.payload?.text, details: { row: row.id, reason: why, ...details } });
			deps.log(`trigger ${row.id.slice(0, 12)} ${state}: ${why}`);
			return "sent";
		};
		const executor: Executor = {
			holds: () => true,
			proof: () => proof,
			view: () => ({
				kind: "held", ceiling: CEILING.held, idle: true,
				running: undefined, inFlight: new Set(), connected: () => true, producerAlive: () => true,
				mine: () => false, claimLive: live,
				blocked: (row) => {
					if (stopped) return "pi-loops is stopping";
					// Another run of the lane holds the row already: the engine starts nothing beside a live claim.
					if (deps.budget().over) return undefined; // the turn takes it out, with its audit row
					if (slots.free <= 0) return `${slots.inUseCount} sub-agent(s) already in flight (max ${slots.limit})`;
					return undefined;
				},
			}),
			turn: (row) => {
				if (stopped) return "no-slot";
				const budget = deps.budget();
				if (budget.over) return leave(row, "budget_exceeded", `today's automation has cost $${budget.spent.toFixed(2)} of the $${budget.cap.toFixed(2)} budget`, { spent_usd: budget.spent, cap_usd: budget.cap });
				const cwd = row.payload?.cwd ?? "";
				const periodic = row.source.startsWith("check:");
				let trigger: Trigger;
				let rules: DynamicTriggerRule[];
				let gates: GateLet | undefined;
				if (periodic) {
					// A periodic check, or `/triggers run`: the rules it names that are still enabled, as the gates let them through.
					const named = new Set(row.payload?.rules ?? []);
					rules = rulesOf(cwd).filter((r) => named.has(r.id));
					trigger = { ...buildPeriodicCheckTrigger(cwd, rules.length, new Date(Date.parse(row.created_at) || now), String(process.pid)), traceId: row.id };
					const p = row.payload;
					gates = { ...(p?.prechecked?.length ? { prechecked: p.prechecked } : {}), ...(p?.events?.length ? { events: p.events } : {}), ...(p?.seen?.length ? { seen: p.seen } : {}) };
				} else {
					const eventId = row.payload?.events?.[0];
					const event = eventId === undefined ? undefined : deps.events.get(eventId);
					const stored = event === undefined ? undefined : pushTrigger(event);
					if (!stored) return leave(row, "dead", eventId === undefined ? "the row names no stored event" : `its stored event ${eventId} is gone or is not a push`);
					// Held past one tick: the model is told the event is not now (src/triggers.ts `deferredMs`).
					const waited = now - Date.parse(event!.received_at);
					trigger = { ...stored, traceId: row.id, cwd, ...(waited >= 30_000 ? { deferredMs: waited } : {}) };
					rules = rulesOf(cwd);
				}
				if (!rules.length) {
					// Nothing left to evaluate (the rules were disabled, removed or proposed since): the row leaves, with the audit row a check writes for this, and no run.
					requests.remove(lane, [row.id]);
					deps.rules.appendAudit({ cwd, type: "trigger_result", traceId: row.id, state: "no_rules", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { delivery: "sub_agent", row: row.id, ...envelopeOf(trigger) } });
					return "sent";
				}
				const permit = slots.acquire();
				if (!permit) return "no-slot";
				const claimed = runs.claim(requests, row, self, { jobId: lane, label: `the check of ${path.basename(cwd) || cwd}`, promptPreview: previewRedacted(row.payload?.text ?? "", 120), ctrl: new AbortController(), check: { cwd, sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel } }, now);
				if (!claimed) { permit.release(); return "sent"; }
				// A push's row was audited `accepted` when it was derived (src/push.ts); a periodic check is accepted as it starts.
				if (periodic) deps.rules.appendAudit({ cwd, type: "trigger", traceId: row.id, state: "accepted", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { delivery: "sub_agent", evaluator_decision: { outcome: "accept", permission: "allow" }, row: row.id, ...envelopeOf(trigger) } });
				const signal = runs.get(claimed.run.id)?.ctrl.signal ?? new AbortController().signal;
				const task = runCheck(deps.check(), { trigger, rules, ...(gates ? { gates } : {}), signal, run: { id: claimed.run.id, row: row.id, cause: periodic ? "check" : "push", since: claimed.run.started_at } })
					.then(async () => { await closeRun(requests, deps.engine(), claimed, proofOf(lane, () => [], deps.allRuns), Date.now()); })
					.finally(() => { runs.remove(claimed.run.id); permit.release(); inFlight.delete(task); })
					.catch((error) => deps.log(`check lane ${lane}: ${error instanceof Error ? error.message : String(error)}`));
				inFlight.add(task);
				return "sent";
			},
			append: () => "sent",
			abort: () => { for (const run of runs.all()) if (run.jobId === lane) runs.stop(run.runId); },
			abortWhenStarted: () => undefined, refused: () => undefined,
			close: async (row, at) => {
				const closed = await closeRun(requests, sinks, row, proof, at);
				return { end: closed.end, outcome: closed.outcome };
			},
		};
		return drain(lane, requests, executor, now, sinks);
	}

	return {
		async drainAll(now) {
			for (const lane of requests.lanes()) if (lane.kind === "check") {
				if (!requests.list(lane.id).some(checkRow)) continue;
				try { await drainLane(lane.id, now); }
				catch (error) { deps.log(`check lane ${lane.id}: ${error instanceof Error ? error.message : String(error)}`); }
			}
		},
		drain: drainLane,
		async stop(drainMs) {
			stopped = true;
			for (const run of runs.all()) if (parseLane(run.jobId)?.kind === "check") run.ctrl.abort();
			const deadline = Date.now() + drainMs;
			while (inFlight.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
		},
		async settle(ms) {
			const deadline = Date.now() + ms;
			while (inFlight.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
		},
	};
}
