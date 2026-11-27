/**
 * The lanes whose answer rows pi-loops in the background runs, and the run itself: a person's yes to
 * a finding of a loop, a check or a closed conversation, run once in the run that asked (design
 * 3.1). `Answers.meet` decides each row under the locks; this module is the executor it asks, and
 * the run E4 starts. A conversation's run is a held turn in it, under its lease.
 */
import * as path from "node:path";
import { type AskOrigin, type ResolvedCap, answerPrompt, isAnswerRow, limitNames, narrowCap, resolveCap } from "./ask.ts";
import type { AnswerExecutor, AnswerStart, Answers, MeetOutcome } from "./answers.ts";
import { type Held, type HeldConversations, heldCap } from "./background-executor.ts";
import { answerClaimLive } from "./engine.ts";
import { budgetState, loopWait } from "./job-status.ts";
import type { SessionSnapshot } from "./job-owner.ts";
import { type Lane, parseLane } from "./lane.ts";
import { DEFAULT_RUN_TIMEOUT_MS, type RunRecordM4b } from "./loop-run.ts";
import { findingKind, parseRunOutput, stripProtocolTags } from "./protocol.ts";
import { previewRedacted, redact } from "./redact.ts";
import { shortSessionId } from "./session-head.ts";
import type { ClaimedRow } from "./requests.ts";
import { PAUSED_WHY, type RunList, STOPPED_BY_PERSON } from "./run-list.ts";
import { type RunnerResult, type SubagentRequest, type SubagentRunner, failedRun } from "./runner.ts";
import { stamp } from "./schedule.ts";
import type { SubagentSlot, SubagentSlots } from "./slots.ts";
import type { LoopJob } from "./store.ts";
import type { Stores } from "./stores.ts";

export interface AnswerLaneDeps {
	readonly answers: Answers;
	readonly stores: Pick<Stores, "jobs" | "inbox" | "requests" | "book">;
	readonly runs: RunList;
	readonly runner: SubagentRunner;
	readonly slots: SubagentSlots;
	session(): SessionSnapshot;
	readonly hop: number;
	holder(): { readonly pid: number; readonly procStart: string | undefined };
	budgetCap(): number | undefined;
	cwdExists(cwd: string): boolean;
	/** Whether a live pi has the transcript with this session id open. A transcript that is held is not resumed. */
	transcriptHeld(sessionId: string): boolean;
	/** Where a check lane's transcripts are: `checkSessionDir` of src/check-run.ts. */
	checkSessionDir(cwd: string): string;
	/** The cap of the check of project `cwd`, as its own run has it: `checkCap` of src/check-run.ts. */
	checkCap(cwd: string): ResolvedCap;
	/** A closed conversation, for an answer's turn there: its lease, taken for one run and given back (`conversations` of `createBackgroundExecutor`). */
	readonly conversations: HeldConversations;
	/** `run_start`, for a loop lane (design 2.1: which runs fire hooks). */
	started(job: LoopJob, row: ClaimedRow): void;
	log(message: string, level?: "info" | "warning", job?: Pick<LoopJob, "cwd">): void;
	readonly now?: () => number;
}

/**
 * Where an answer's run sits: its lane's kind, its cap, and the directory of a new transcript or the
 * conversation it holds. `refused`: the cap refuses the run, which runs nothing; a conversation's
 * lease is still given back.
 */
type AnswerSeat =
	| { readonly lane: "loop"; readonly job: LoopJob; readonly cap: ResolvedCap; readonly sessionDir: string }
	| { readonly lane: "check"; readonly cwd: string; readonly cap: ResolvedCap; readonly sessionDir: string }
	| { readonly lane: "conversation"; readonly held: Held; readonly job?: LoopJob; readonly cap: ResolvedCap }
	| { readonly lane: "refused"; readonly job?: LoopJob; readonly why: string };

/** Why a conversation's answer waits when its lease cannot be had. */
const NOT_TAKEN = "its conversation cannot be taken now";

export interface AnswerLanes {
	/** The `answers` rider: `answers.repair` (H1, for closed conversations too) first, then `drain` for every loop and check lane with an `ans-` row, whether or not its job is still in `jobs.json` (E2 needs the drain of a removed loop's lane). A closed conversation's lane is drained by `deliverSession`; in an open one only this process's claims whose run left the list are met (F1 to F3), and nothing starts. */
	tick(now: number): Promise<void>;
	/**
	 * Every `ans-` row of one lane, oldest first, through `answers.meet`. E4 starts the run, and the
	 * drain goes on without waiting for it. A conversation's rows are met only while it is closed
	 * (`deliverSession` calls this before `bury`): `answers.foresee` first, and only for E4 is its
	 * lease taken before `meet`, which decides again under the lock; a lease that cannot be had is
	 * `blocked`, and a `meet` that starts no run gives it back at once.
	 */
	drain(lane: Lane, now: number): Promise<MeetOutcome[]>;
	/** Abort the answer runs that are going and wait up to `drainMs` for their closings. */
	stop(drainMs: number): Promise<void>;
	/** Wait up to `ms` for the answer runs that are going to close, without aborting them. */
	settle(ms: number): Promise<void>;
}

/** The loop of a lane as `jobs.json` has it now. */
const loopOf = (jobs: readonly LoopJob[], lane: Lane): LoopJob | undefined => (lane.kind === "loop" ? jobs.find((job) => job.stateful && `@${job.id}` === lane.id) : undefined);
/** The plain job of a conversation's finding, as `jobs.json` has it now. A window's answer turn finds its job the same way. */
export const plainOf = (jobs: readonly LoopJob[], lane: Lane, jobId: string | undefined): LoopJob | undefined => (lane.kind === "conversation" && jobId !== undefined ? jobs.find((job) => !job.stateful && job.id === jobId && job.sessionId === lane.id) : undefined);

export function createAnswerLanes(deps: AnswerLaneDeps): AnswerLanes {
	const { answers, stores, runs, slots } = deps;
	const now = deps.now ?? Date.now;
	let stopped = false;
	/** The runs this process started, by run id, until their closing ends. */
	const inFlight = new Map<string, Promise<void>>();
	/** The slot each claimed run holds, given back when it leaves the list. */
	const permits = new Map<string, SubagentSlot>();
	const listed = (runId: string): boolean => runs.get(runId) !== undefined;

	/**
	 * The executor `meet` asks for one lane. For a conversation, `held` is its lease, taken for this
	 * row: without it no run is claimed, and `notTaken` says why the row waits when nothing else does.
	 */
	function executorFor(lane: Lane, held?: Held, notTaken?: string): AnswerExecutor {
		const self = deps.holder();
		const live = (row: ClaimedRow): boolean => answerClaimLive(row, self, listed);
		/** Why a run of the lane that is going holds this one: a run in this process's list, a live claim on a row of the lane, or a rule check of the project. */
		const busy = (job: LoopJob | undefined): string | undefined => {
			const rows = stores.requests.list(lane.id);
			// A push or a periodic check of the project is a claimed row of its check lane (src/background-executor.ts `createCheckLanes`).
			if (lane.kind === "check" && rows.some((row) => row.run !== undefined && !isAnswerRow(row) && live(row as ClaimedRow))) return "a check of this project is running";
			const going = runs.all().some((run) => (job !== undefined && run.jobId === job.id) || run.answer?.lane === lane.id || run.turn?.sessionId === lane.id) || rows.some((row) => row.run !== undefined && live(row as ClaimedRow));
			if (going) return lane.kind === "loop" ? "another run of the loop is going" : lane.kind === "conversation" ? "another run of pi-loops is writing the conversation" : "another answer of this project is running";
			return undefined;
		};
		return {
			blocked: (_lane, finding, transcript) => {
				if (stopped) return "pi-loops is stopping";
				// Before any lease is taken: the run list would refuse the claim (src/run-list.ts).
				if (runs.held()) return PAUSED_WHY;
				const job = loopOf(stores.book().jobs, lane);
				// A removed loop is E2's, before any hold.
				if (lane.kind === "loop" && !job) return undefined;
				if (job && !job.enabled) return "its job is disabled";
				if (lane.kind === "conversation" && !held && !deps.conversations.closed(lane.id)) return "a window holds the conversation";
				const cwd = job?.cwd ?? finding?.cwd ?? "";
				const gate = loopWait({ cwd }, undefined, { cwdExists: deps.cwdExists, budget: () => budgetState(stores.jobs, deps.budgetCap(), now()), slots: () => ({ inUse: slots.inUseCount, free: slots.free, limit: slots.limit }) }, now());
				if (gate !== undefined) return gate;
				const busyWhy = busy(job);
				if (busyWhy !== undefined) return busyWhy;
				if (transcript !== undefined && deps.transcriptHeld(transcript)) return "a pi has its transcript open";
				return notTaken;
			},
			live,
			claim: (row, finding, lock, at) => {
				if (stopped) return undefined;
				// A conversation's run is claimed only under its lease.
				if (lane.kind === "conversation" && !held) return undefined;
				// `blocked` was read before the locks, and a run of the lane may have started since. From here
				// to `runs.claim` nothing awaits, so no run of this process starts between this look and the claim.
				const jobs = stores.book().jobs;
				if (busy(loopOf(jobs, lane)) !== undefined) return undefined;
				const permit = slots.acquire();
				if (!permit) return undefined;
				const job = loopOf(jobs, lane) ?? plainOf(jobs, lane, finding.job_id);
				const label = job ? (job.name ?? job.id) : lane.kind === "conversation" ? `an answer in conversation ${shortSessionId(lane.id)}` : `the check of ${path.basename(finding.cwd) || finding.cwd}`;
				let claimed: ClaimedRow | undefined;
				try {
					claimed = runs.claim(stores.requests, row, self, { jobId: job?.id ?? lane.id, label, promptPreview: previewRedacted(finding.text, 120), ctrl: new AbortController(), answer: { lane: lane.id, finding: finding.id }, ...(held ? { turn: { ...held, label } } : {}) }, at, lock);
				} finally {
					if (!claimed) permit.release();
				}
				if (claimed) permits.set(claimed.run.id, permit);
				return claimed;
			},
			release: (runId) => {
				runs.remove(runId);
				permits.get(runId)?.release();
				permits.delete(runId);
			},
		};
	}

	/**
	 * The seat of a run E4 started: its loop as `jobs.json` has it now, or the finding's project, or
	 * the conversation it holds, with the cap made of it, narrowed by the cap the question recorded.
	 * undefined: the loop was removed since.
	 */
	function seatOf(lane: Lane, start: AnswerStart, held: Held | undefined): AnswerSeat | undefined {
		const asked = start.finding.ask?.run;
		if (lane.kind === "conversation") {
			if (!held) return undefined;
			const plain = plainOf(stores.book().jobs, lane, start.finding.job_id);
			// A turn in the conversation, as its job's turn is there: `heldCap`, the cap the question recorded too.
			const capped = narrowCap(heldCap(plain, held.cwd ?? plain?.cwd ?? start.finding.cwd, DEFAULT_RUN_TIMEOUT_MS), asked);
			if ("refused" in capped) return { lane: "refused", ...(plain ? { job: plain } : {}), why: `the question was asked in ${capped.asked}, and this run would be in ${capped.cwd}` };
			return { lane: "conversation", held, ...(plain ? { job: plain } : {}), cap: capped };
		}
		const job = lane.kind === "loop" ? loopOf(stores.book().jobs, lane) : undefined;
		if (lane.kind === "loop" && !job) return undefined;
		const cwd = job?.cwd ?? start.finding.cwd;
		const cap = narrowCap(job ? resolveCap(job, DEFAULT_RUN_TIMEOUT_MS) : deps.checkCap(cwd), asked);
		if ("refused" in cap) return { lane: "refused", ...(job ? { job } : {}), why: `the question was asked in ${cap.asked}, and this run would be in ${cap.cwd}` };
		return job ? { lane: "loop", job, cap, sessionDir: stores.jobs.sessionDirFor(job.id) } : { lane: "check", cwd, cap, sessionDir: deps.checkSessionDir(cwd) };
	}

	/** The lanes a drain is going in: a ring and the tick can ask for one conversation at once. */
	const draining = new Set<string>();

	async function drain(lane: Lane, at: number): Promise<MeetOutcome[]> {
		if (lane.kind === "conversation" && !deps.conversations.closed(lane.id)) return [];
		if (draining.has(lane.id)) return [];
		draining.add(lane.id);
		try {
			return await drainRows(lane, at);
		} finally {
			draining.delete(lane.id);
		}
	}

	async function drainRows(lane: Lane, at: number): Promise<MeetOutcome[]> {
		const rows = stores.requests.list(lane.id).filter(isAnswerRow).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
		const out: MeetOutcome[] = [];
		for (const row of rows) {
			let met: MeetOutcome;
			let held: Held | undefined;
			try {
				// A conversation's lease is a lock of its own, taken before `inbox.lock` and only for a row
				// the read without the lock finds ready to start. Without it, no meet can start a run.
				let executor = lane.kind === "conversation" ? executorFor(lane, undefined, NOT_TAKEN) : executorFor(lane);
				if (lane.kind === "conversation" && answers.foresee(lane, row.id, executorFor(lane), at) === "E4") {
					const got = deps.conversations.hold(lane.id, row.id, at);
					if ("refused" in got) executor = executorFor(lane, undefined, `${NOT_TAKEN} (${got.refused})`);
					else {
						held = got;
						executor = executorFor(lane, held);
					}
				}
				met = await answers.meet(lane, row.id, executor, at);
			} catch (error) {
				if (held) deps.conversations.release(held, false);
				deps.log(`answer ${row.id.slice(0, 12)} in ${lane.id}: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			out.push(met);
			if (met.met !== "E4") {
				if (held) deps.conversations.release(held, false);
				continue;
			}
			const runId = met.start.row.run.id;
			const lease = held;
			// The closing, then the run leaves the list (in runAnswer), then the slot and the lease.
			let asked = false;
			const task = runAnswer(met.start, seatOf(lane, met.start, lease), deps)
				.then((ran) => {
					asked = ran;
				})
				.finally(() => {
					permits.get(runId)?.release();
					permits.delete(runId);
					if (lease) deps.conversations.release(lease, asked);
					inFlight.delete(runId);
				});
			inFlight.set(runId, task);
		}
		return out;
	}

	/**
	 * An open conversation's `ans-` rows that carry a claim of this process whose run left the list
	 * (its closing threw, or a window took the conversation back and the closing failed): each is met
	 * with no lease, so F1 to F3 close it and nothing can start. The window that holds the conversation
	 * reads such a claim as live and waits on it, so nobody else closes it while this process lives.
	 */
	async function meetOrphans(at: number): Promise<void> {
		const self = deps.holder();
		for (const sessionId of stores.requests.sessions()) {
			const lane = parseLane(sessionId);
			if (lane?.kind !== "conversation" || deps.conversations.closed(lane.id)) continue;
			const orphans = stores.requests.list(lane.id).filter((row) => isAnswerRow(row) && row.run !== undefined && row.run.pid === self.pid && row.run.procStart === self.procStart && !listed(row.run.id));
			for (const row of orphans) {
				try {
					await answers.meet(lane, row.id, executorFor(lane), at);
				} catch (error) {
					deps.log(`answer ${row.id.slice(0, 12)} in ${lane.id}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
	}

	const wait = async (ms: number): Promise<void> => {
		const deadline = Date.now() + ms;
		while (inFlight.size && Date.now() < deadline) await Promise.race([Promise.allSettled([...inFlight.values()]), new Promise((resolve) => setTimeout(resolve, 25))]);
	};

	return {
		async tick(at) {
			try {
				await answers.repair((lane) => lane.kind === "loop" || lane.kind === "check" || deps.conversations.closed(lane.id), at);
			} catch (error) {
				deps.log(`answers: the rows of open answers could not be checked: ${error instanceof Error ? error.message : String(error)}`);
			}
			// The loop and check lanes; a closed conversation's answers are met where its queue is delivered (`deliverSession`), before `bury`.
			for (const lane of stores.requests.lanes()) {
				try {
					if (stores.requests.list(lane.id).some(isAnswerRow)) await drain(lane, at);
				} catch (error) {
					deps.log(`answers in ${lane.id}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			await meetOrphans(at);
		},
		drain,
		async stop(drainMs) {
			stopped = true;
			for (const runId of inFlight.keys()) runs.get(runId)?.ctrl.abort();
			await wait(drainMs);
		},
		settle: wait,
	};
}

/** The runner's request of an answer's run in its seat: a held turn in a conversation, else a new or resumed transcript of a loop or a check. */
function requestOf(start: AnswerStart, seat: Extract<AnswerSeat, { lane: "loop" | "check" | "conversation" }>, origin: AskOrigin, signal: AbortSignal, onSessionFile: (file: string) => void, deps: AnswerLaneDeps): SubagentRequest {
	const now = deps.now ?? Date.now;
	const { row, finding } = start;
	const cap = seat.cap;
	const tools = { ...(limitNames(cap.tools) ? { tools: [...limitNames(cap.tools)!] } : {}), ...(limitNames(cap.builtinTools) ? { builtinTools: [...limitNames(cap.builtinTools)!] } : {}) };
	const guard = { lane: row.lane, origin, cap, ...(start.grant ? { grant: start.grant } : {}) };
	const prompt = answerPrompt(finding, row.id, now());
	if (seat.lane === "conversation") {
		const { held } = seat;
		// The conversation's own turn, as its job's turn there: the model it is on, pi's trust for its directory, given back if a window takes it.
		return {
			cwd: cap.cwd, prompt, ...tools, trusted: deps.conversations.trusts(held), timeoutMs: cap.timeoutMs, signal, hop: 1,
			parentSessionId: held.sessionId, parentCwd: cap.cwd, kind: "held", jobId: start.jobId, runId: row.run.id,
			sessionFile: held.sessionFile, sessionId: held.sessionId, stillHolds: () => deps.conversations.holds(held), guard, onSessionFile,
		};
	}
	const session = deps.session();
	// The runner runs the cap: a resumed transcript keeps its own model unless the job pins one; a new one starts on the process's.
	return {
		cwd: cap.cwd, prompt, model: cap.model ?? session.model, thinking: cap.thinking ?? session.thinking, ...tools,
		timeoutMs: cap.timeoutMs, signal, hop: deps.hop + 1, parentSessionId: session.sessionId, parentCwd: session.cwd,
		kind: seat.lane === "loop" ? "loop" : "trigger", jobId: start.jobId, runId: row.run.id,
		...(start.resume !== undefined ? { resume: start.resume } : { sessionDir: seat.sessionDir }),
		guard, onSessionFile,
	};
}

/** Who asked, for a question the answer's run opens in turn. */
function originOf(start: AnswerStart, seat: Extract<AnswerSeat, { lane: "loop" | "check" | "conversation" }>): AskOrigin {
	const runId = start.row.run.id;
	const cwd = seat.cap.cwd;
	if (seat.lane === "loop") {
		const job = seat.job;
		return { source: `cron:${job.name ?? job.id.slice(0, "cron-".length + 8)}`, run_id: runId, cwd: job.cwd, job_id: job.id, ...(job.createdBy?.sessionId ? { session_id: job.createdBy.sessionId } : {}), who: job.name ?? job.id };
	}
	if (seat.lane === "conversation") return conversationOrigin(start, seat.held.sessionId, cwd, seat.job);
	return { source: start.finding.source, run_id: runId, cwd, who: `the check of ${path.basename(cwd) || cwd}` };
}

/** Who asks, for a question an answer's turn in conversation `sessionId` opens: its plain job, else the conversation. A window's answer turn names it the same way. */
export function conversationOrigin(start: AnswerStart, sessionId: string, cwd: string, job: LoopJob | undefined): AskOrigin {
	const runId = start.row.run.id;
	return job ? { source: `cron:${job.name ?? job.id}`, run_id: runId, cwd, job_id: job.id, session_id: sessionId, who: job.name ?? job.id } : { source: start.finding.source, run_id: runId, cwd, session_id: sessionId, who: `conversation ${shortSessionId(sessionId)}` };
}
/**
 * One run of an answer row, from E4b to C4. It never rejects. A seat that is gone (the loop was
 * removed since E4, a window took the conversation) runs nothing: the record says `aborted`, and the
 * closing writes `unfinished`. A loop disabled since E4 is not gone: E4 is spent, and the run goes on.
 * Resolves to whether the runner was asked: only then can the run have written its transcript.
 */
async function runAnswer(start: AnswerStart, seat: AnswerSeat | undefined, deps: AnswerLaneDeps): Promise<boolean> {
	const now = deps.now ?? Date.now;
	const { row, finding } = start;
	const runId = row.run.id;
	const running = deps.runs.get(runId);
	const signal = running?.ctrl.signal ?? AbortSignal.abort();
	const lane = parseLane(row.lane);
	/** The lane's job: its loop, or the plain job of a conversation's finding. */
	const job = seat && "job" in seat ? seat.job : undefined;
	const loop = lane?.kind === "loop" ? job : undefined;
	const held = seat?.lane === "conversation" ? seat.held : undefined;
	const capOf = seat && seat.lane !== "refused" ? seat.cap : undefined;
	/** A window took the conversation back from this run. */
	const takenBack = (): boolean => held !== undefined && !deps.conversations.holds(held);
	let asked = false;
	try {
		let result: RunnerResult;
		if (seat?.lane === "refused") {
			result = failedRun(`refused: ${seat.why}`);
		} else if (!seat || signal.aborted || takenBack()) {
			result = failedRun("aborted", { stopReason: "aborted" });
		} else if (held && start.resume !== undefined && path.resolve(start.resume.file) !== path.resolve(held.sessionFile)) {
			// The transcript the question was checked in is not the file this lease names: nothing runs in either.
			result = failedRun(`refused: the question's transcript ${start.resume.file} is not the conversation's file ${held.sessionFile}`);
		} else {
			if (loop) {
				try { deps.started(loop, row); }
				catch (error) { deps.log(`loop ${loop.id}: start notification failed: ${error instanceof Error ? error.message : String(error)}`, undefined, loop); }
			}
			try {
				asked = true;
				result = await deps.runner(requestOf(start, seat, originOf(start, seat), signal, (file) => { if (running) running.sessionFile = file; }, deps));
			} catch (error) {
				result = failedRun(error instanceof Error ? error.message : String(error));
			}
		}

		// The `<inbox>` findings are filed as the lane's runs file them; `<loop-state>` is not written:
		// the loop's notes stay those of its last scheduled run. A turn in a conversation files none, as
		// its job's turn there files none: its reply is in the conversation.
		const parsed = parseRunOutput(result.text);
		const stillThere = !job || deps.stores.book().jobs.some((candidate) => candidate.id === job.id);
		const filed: string[] = [];
		let repeats = 0;
		if (result.ok && stillThere && capOf && !held) {
			for (const text of parsed.findings) {
				try {
					const entry = {
						source: loop ? `cron:${loop.name ?? loop.id.slice(0, "cron-".length + 8)}` : finding.source,
						text, run_id: runId, job_id: loop?.id ?? finding.job_id, cwd: capOf.cwd, kind: findingKind(text),
						session_id: loop ? loop.createdBy?.sessionId : finding.session_id, transcript: result.sessionFile, transcript_id: result.sessionId, lane: row.lane,
					};
					// A loop's run files as its scheduled runs do: the repeat rule holds for a resumed run too.
					const added = loop ? await deps.stores.inbox.append(entry, { unlessRepeat: true }) : await deps.stores.inbox.append(entry);
					if (added) filed.push(text);
					else repeats++;
				} catch (error) { deps.log(`answer ${runId.slice(0, 12)}: inbox append failed: ${error instanceof Error ? error.message : String(error)}`, undefined, job); }
			}
		}
		const aborted = !result.ok && (result.stopReason === "aborted" || signal.aborted || takenBack());
		const byPerson = aborted && signal.reason === STOPPED_BY_PERSON;
		const requestedBy = row.payload?.requested_by ?? finding.claimed_by;
		const record: RunRecordM4b = {
			runId, row: row.id, jobId: start.jobId, jobName: job?.name, stateful: lane?.kind === "loop", cwd: capOf?.cwd ?? finding.cwd,
			pid: row.run.pid, startedAt: row.run.started_at, finishedAt: stamp(now()), ok: result.ok, exitCode: result.exitCode,
			error: result.ok ? undefined : byPerson ? STOPPED_BY_PERSON : redact(result.errorMessage ?? "unknown error"),
			findings: filed.length, droppedFindings: parsed.droppedFindings, stateUpdated: false,
			...(repeats ? { repeats } : {}),
			model: result.model ?? capOf?.model ?? undefined, usage: result.usage, warning: result.warning, retries: result.retries, compactions: result.compactions,
			summary: previewRedacted(filed[0] ?? stripProtocolTags(result.text), 400) || undefined,
			sessionId: result.sessionId ?? held?.sessionId, sessionFile: result.sessionFile ?? held?.sessionFile,
			forSession: held ? (job?.createdBy?.sessionId ?? held.sessionId) : loop ? loop.createdBy?.sessionId : finding.session_id,
			cause: "answer",
			...(held ? { resumed: held.sessionFile } : start.resume !== undefined ? { resumed: start.resume.file } : {}),
			...(result.guard?.grant_used !== undefined ? { grant_used: result.guard.grant_used } : {}),
			...(requestedBy ? { requestedBy: { sessionId: requestedBy } } : {}),
			...(aborted ? { aborted: true as const } : {}),
			...(byPerson ? { stoppedBy: "person" as const, stoppedFrom: running?.stoppedFrom ?? "cli" } : {}),
		};
		const closed = await deps.answers.close(row, now(), record);
		deps.log(`answer ${runId.slice(0, 12)} in ${row.lane}: ${closed.state}${result.ok ? "" : ` (${record.error})`}`, "info", job);
	} catch (error) {
		// The claim stays on the row and the run leaves the list below: the next meet finds it not live (F2).
		deps.log(`answer ${runId.slice(0, 12)} in ${row.lane}: could not close (${error instanceof Error ? error.message : String(error)})`, undefined, job);
	} finally {
		deps.runs.remove(runId);
	}
	return asked;
}
