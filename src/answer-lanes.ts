/**
 * The lanes whose answer rows pi-loops in the background runs, and the run itself: a person's yes to
 * a finding of a loop or a check, run once in the run that asked (design 3.1). `Answers.meet`
 * decides each row under the locks; this module is the executor it asks, and the run E4 starts.
 * A conversation's `ans-` rows wait here: its executor comes with the conversation's lease (M5a.9).
 */
import * as path from "node:path";
import { type AskOrigin, type ResolvedCap, answerPrompt, isAnswerRow, limitNames, narrowCap, resolveCap } from "./ask.ts";
import type { AnswerExecutor, AnswerStart, Answers, MeetOutcome } from "./answers.ts";
import { answerClaimLive } from "./engine.ts";
import { budgetState, loopWait } from "./job-status.ts";
import type { SessionSnapshot } from "./job-owner.ts";
import { type Lane, parseLane } from "./lane.ts";
import { DEFAULT_RUN_TIMEOUT_MS } from "./loop-run.ts";
import { findingKind, parseRunOutput, stripProtocolTags } from "./protocol.ts";
import { previewRedacted, redact } from "./redact.ts";
import type { ClaimedRow } from "./requests.ts";
import { type RunList, STOPPED_BY_PERSON } from "./run-list.ts";
import { type RunnerResult, type SubagentRunner, failedRun } from "./runner.ts";
import { stamp } from "./schedule.ts";
import type { SubagentSlot, SubagentSlots } from "./slots.ts";
import type { LoopJob, RunRecord } from "./store.ts";
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
	/** Where a check lane's transcripts are: `checkSessionDir` of src/trigger-runtime.ts. */
	checkSessionDir(cwd: string): string;
	/** The cap of the check of project `cwd`, as its own run has it: `checkCap` of src/trigger-runtime.ts. */
	checkCap(cwd: string): ResolvedCap;
	/** `run_start`, for a loop lane (design 2.1: which runs fire hooks). */
	started(job: LoopJob, row: ClaimedRow): void;
	log(message: string, level?: "info" | "warning", job?: Pick<LoopJob, "cwd">): void;
	readonly now?: () => number;
}

/** Where an answer's run sits: its lane's kind, its cap, and the directory of a new transcript. `refused`: the cap refuses the run, which runs nothing. */
type AnswerSeat =
	| { readonly lane: "loop"; readonly job: LoopJob; readonly cap: ResolvedCap; readonly sessionDir: string }
	| { readonly lane: "check"; readonly cwd: string; readonly cap: ResolvedCap; readonly sessionDir: string }
	| { readonly lane: "refused"; readonly job?: LoopJob; readonly why: string };

/** The lanes this module runs: a loop's and a project's checks. */
type RunLane = Extract<Lane, { kind: "loop" | "check" }>;

export interface AnswerLanes {
	/** The `answers` rider: `answers.repair` (H1) first, then `drain` for every loop and check lane with an `ans-` row, whether or not its job is still in `jobs.json` (E2 needs the drain of a removed loop's lane). */
	tick(now: number): Promise<void>;
	/** Every `ans-` row of one lane, oldest first, through `answers.meet`. E4 starts the run, and the drain goes on without waiting for it. A conversation's rows wait. */
	drain(lane: Lane, now: number): Promise<MeetOutcome[]>;
	/** Abort the answer runs that are going and wait up to `drainMs` for their closings. */
	stop(drainMs: number): Promise<void>;
	/** Wait up to `ms` for the answer runs that are going to close, without aborting them. */
	settle(ms: number): Promise<void>;
}

/** The loop of a lane as `jobs.json` has it now. */
const loopOf = (jobs: readonly LoopJob[], lane: RunLane): LoopJob | undefined => (lane.kind === "loop" ? jobs.find((job) => job.stateful && `@${job.id}` === lane.id) : undefined);

export function createAnswerLanes(deps: AnswerLaneDeps): AnswerLanes {
	const { answers, stores, runs, slots } = deps;
	const now = deps.now ?? Date.now;
	let stopped = false;
	/** The runs this process started, by run id, until their closing ends. */
	const inFlight = new Map<string, Promise<void>>();
	/** The slot each claimed run holds, given back when it leaves the list. */
	const permits = new Map<string, SubagentSlot>();
	const listed = (runId: string): boolean => runs.get(runId) !== undefined;

	function executorFor(lane: RunLane): AnswerExecutor {
		const self = deps.holder();
		const live = (row: ClaimedRow): boolean => answerClaimLive(row, self, listed);
		return {
			blocked: (_lane, finding, transcript) => {
				if (stopped) return "pi-loops is stopping";
				const job = loopOf(stores.book().jobs, lane);
				// A removed loop is E2's, before any hold.
				if (lane.kind === "loop" && !job) return undefined;
				if (job && !job.enabled) return "its job is disabled";
				const cwd = job?.cwd ?? finding?.cwd ?? "";
				const gate = loopWait({ cwd }, undefined, { cwdExists: deps.cwdExists, budget: () => budgetState(stores.jobs, deps.budgetCap(), now()), slots: () => ({ inUse: slots.inUseCount, free: slots.free, limit: slots.limit }) }, now());
				if (gate !== undefined) return gate;
				const going = runs.all().some((run) => (job !== undefined && run.jobId === job.id) || run.answer?.lane === lane.id) || stores.requests.list(lane.id).some((row) => row.run !== undefined && live(row as ClaimedRow));
				if (going) return lane.kind === "loop" ? "another run of the loop is going" : "another answer of this project is running";
				if (transcript !== undefined && deps.transcriptHeld(transcript)) return "a pi has its transcript open";
				return undefined;
			},
			live,
			claim: (row, finding, lock, at) => {
				if (stopped) return undefined;
				const permit = slots.acquire();
				if (!permit) return undefined;
				const job = loopOf(stores.book().jobs, lane);
				let claimed: ClaimedRow | undefined;
				try {
					claimed = runs.claim(stores.requests, row, self, { jobId: job?.id ?? lane.id, label: job ? (job.name ?? job.id) : `the check of ${path.basename(finding.cwd) || finding.cwd}`, promptPreview: previewRedacted(finding.text, 120), ctrl: new AbortController(), answer: { lane: lane.id, finding: finding.id } }, at, lock);
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
	 * The seat of a run E4 started: its loop as `jobs.json` has it now, or the finding's project, with
	 * the cap `resolveCap` makes of it, narrowed by the cap the question recorded. undefined: the loop
	 * was removed since.
	 */
	function seatOf(lane: RunLane, start: AnswerStart): AnswerSeat | undefined {
		const asked = start.finding.ask?.run;
		const job = lane.kind === "loop" ? loopOf(stores.book().jobs, lane) : undefined;
		if (lane.kind === "loop" && !job) return undefined;
		const cwd = job?.cwd ?? start.finding.cwd;
		const cap = narrowCap(job ? resolveCap(job, DEFAULT_RUN_TIMEOUT_MS) : deps.checkCap(cwd), asked);
		if ("refused" in cap) return { lane: "refused", ...(job ? { job } : {}), why: `the question was asked in ${cap.asked}, and this run would be in ${cap.cwd}` };
		return job ? { lane: "loop", job, cap, sessionDir: stores.jobs.sessionDirFor(job.id) } : { lane: "check", cwd, cap, sessionDir: deps.checkSessionDir(cwd) };
	}

	async function drain(lane: Lane, at: number): Promise<MeetOutcome[]> {
		if (lane.kind === "conversation") return [];
		const executor = executorFor(lane);
		const rows = stores.requests.list(lane.id).filter(isAnswerRow).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
		const out: MeetOutcome[] = [];
		for (const row of rows) {
			let met: MeetOutcome;
			try {
				met = await answers.meet(lane, row.id, executor, at);
			} catch (error) {
				deps.log(`answer ${row.id.slice(0, 12)} in ${lane.id}: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			out.push(met);
			if (met.met !== "E4") continue;
			const runId = met.start.row.run.id;
			const task = runAnswer(met.start, seatOf(lane, met.start), deps).finally(() => {
				permits.get(runId)?.release();
				permits.delete(runId);
				inFlight.delete(runId);
			});
			inFlight.set(runId, task);
		}
		return out;
	}

	const wait = async (ms: number): Promise<void> => {
		const deadline = Date.now() + ms;
		while (inFlight.size && Date.now() < deadline) await Promise.race([Promise.allSettled([...inFlight.values()]), new Promise((resolve) => setTimeout(resolve, 25))]);
	};

	return {
		async tick(at) {
			try {
				await answers.repair((lane) => lane.kind === "loop" || lane.kind === "check", at);
			} catch (error) {
				deps.log(`answers: the rows of open answers could not be checked: ${error instanceof Error ? error.message : String(error)}`);
			}
			for (const lane of stores.requests.lanes()) {
				try {
					if (stores.requests.list(lane.id).some(isAnswerRow)) await drain(lane, at);
				} catch (error) {
					deps.log(`answers in ${lane.id}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
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

/**
 * One run of an answer row, from E4b to C4. It never rejects. A seat that is gone (the loop was
 * removed since E4) runs nothing: the record says `aborted`, and the closing writes `unfinished`.
 * A loop disabled since E4 is not gone: E4 is spent, and the run goes on.
 */
async function runAnswer(start: AnswerStart, seat: AnswerSeat | undefined, deps: AnswerLaneDeps): Promise<void> {
	const now = deps.now ?? Date.now;
	const { row, finding } = start;
	const runId = row.run.id;
	const running = deps.runs.get(runId);
	const signal = running?.ctrl.signal ?? AbortSignal.abort();
	const job = seat?.lane === "loop" || seat?.lane === "refused" ? seat.job : undefined;
	const capOf = seat && seat.lane !== "refused" ? seat.cap : undefined;
	try {
		let result: RunnerResult;
		if (seat?.lane === "refused") {
			result = failedRun(`refused: ${seat.why}`);
		} else if (!seat || signal.aborted) {
			result = failedRun("aborted", { stopReason: "aborted" });
		} else {
			if (job) {
				try { deps.started(job, row); }
				catch (error) { deps.log(`loop ${job.id}: start notification failed: ${error instanceof Error ? error.message : String(error)}`, undefined, job); }
			}
			const session = deps.session();
			const cap = seat.cap;
			const origin: AskOrigin = job
				? { source: `cron:${job.name ?? job.id.slice(0, "cron-".length + 8)}`, run_id: runId, cwd: job.cwd, job_id: job.id, ...(job.createdBy?.sessionId ? { session_id: job.createdBy.sessionId } : {}), who: job.name ?? job.id }
				: { source: finding.source, run_id: runId, cwd: cap.cwd, who: `the check of ${path.basename(cap.cwd) || cap.cwd}` };
			// The runner runs the cap: a resumed transcript keeps its own model unless the job pins one; a new one starts on the process's.
			try {
				result = await deps.runner({
					cwd: cap.cwd, prompt: answerPrompt(finding, row.id, now()), model: cap.model ?? session.model, thinking: cap.thinking ?? session.thinking,
					...(limitNames(cap.tools) ? { tools: [...limitNames(cap.tools)!] } : {}), ...(limitNames(cap.builtinTools) ? { builtinTools: [...limitNames(cap.builtinTools)!] } : {}),
					timeoutMs: cap.timeoutMs, signal, hop: deps.hop + 1, parentSessionId: session.sessionId, parentCwd: session.cwd,
					kind: job ? "loop" : "trigger", jobId: start.jobId, runId,
					...(start.resume !== undefined ? { resume: start.resume } : { sessionDir: seat.sessionDir }),
					guard: { lane: row.lane, origin, cap, ...(start.grant ? { grant: start.grant } : {}) },
					onSessionFile: (file) => { if (running) running.sessionFile = file; },
				});
			} catch (error) {
				result = failedRun(error instanceof Error ? error.message : String(error));
			}
		}

		// The `<inbox>` findings are filed as the lane's runs file them; `<loop-state>` is not written:
		// the loop's notes stay those of its last scheduled run.
		const parsed = parseRunOutput(result.text);
		const stillThere = !job || deps.stores.book().jobs.some((candidate) => candidate.id === job.id);
		const filed: string[] = [];
		if (result.ok && stillThere && capOf) {
			for (const text of parsed.findings) {
				try {
					await deps.stores.inbox.append({
						source: job ? `cron:${job.name ?? job.id.slice(0, "cron-".length + 8)}` : finding.source,
						text, run_id: runId, job_id: job?.id ?? finding.job_id, cwd: capOf.cwd, kind: findingKind(text),
						session_id: job ? job.createdBy?.sessionId : finding.session_id, transcript: result.sessionFile, transcript_id: result.sessionId, lane: row.lane,
					});
					filed.push(text);
				} catch (error) { deps.log(`answer ${runId.slice(0, 12)}: inbox append failed: ${error instanceof Error ? error.message : String(error)}`, undefined, job); }
			}
		}
		const aborted = !result.ok && (result.stopReason === "aborted" || signal.aborted);
		const byPerson = aborted && signal.reason === STOPPED_BY_PERSON;
		const requestedBy = row.payload?.requested_by ?? finding.claimed_by;
		const record: RunRecord = {
			runId, row: row.id, jobId: start.jobId, jobName: job?.name, stateful: parseLane(row.lane)?.kind === "loop", cwd: capOf?.cwd ?? finding.cwd,
			pid: row.run.pid, startedAt: row.run.started_at, finishedAt: stamp(now()), ok: result.ok, exitCode: result.exitCode,
			error: result.ok ? undefined : byPerson ? STOPPED_BY_PERSON : redact(result.errorMessage ?? "unknown error"),
			findings: filed.length, droppedFindings: parsed.droppedFindings, stateUpdated: false,
			model: result.model ?? capOf?.model ?? undefined, usage: result.usage, warning: result.warning, retries: result.retries, compactions: result.compactions,
			summary: previewRedacted(filed[0] ?? stripProtocolTags(result.text), 400) || undefined,
			sessionId: result.sessionId, sessionFile: result.sessionFile,
			forSession: job ? job.createdBy?.sessionId : finding.session_id,
			cause: "answer",
			...(start.resume !== undefined ? { resumed: start.resume.file } : {}),
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
}
