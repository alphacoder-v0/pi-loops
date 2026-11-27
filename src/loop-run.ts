import * as path from "node:path";
import { askedLines, resolveCap } from "./ask.ts";
import { type EngineSinks, applyFate, plainJobRow, plainRunId } from "./engine.ts";
import { OVERFLOW_FILE, notesFileLines, notesFiles as listNotesFiles, notesWrite, reportedFor } from "./notes.ts";
import { findingKind, composeCheckerPrompt, composeLoopPrompt, gateLines, parseCheckerOutput, parseRunOutput, stripProtocolTags } from "./protocol.ts";
import type { EventLog } from "./events.ts";
import { screenedJobId } from "./inbox.ts";
import { commandReadingOf, readingDigest, type CommandReading } from "./gate.ts";
import type { ClaimedRow, Row, UnclaimedRow } from "./requests.ts";
import { RunList, STOPPED_BY_PERSON } from "./run-list.ts";
import { previewRedacted, redact } from "./redact.ts";
import { type RunnerResult, type SubagentRunner, failedRun } from "./runner.ts";
import { formatLocalZoned, stamp } from "./schedule.ts";
import { type JobHistory, firedBy, runHistory } from "./job-status.ts";
import { type LoopSettlement, INTERRUPTED, loopEnd, oneShotDoneV3, runEnd, settleLoop } from "./settle.ts";
import type { SessionSnapshot } from "./job-owner.ts";
import type { Stores } from "./stores.ts";
import { type Disabled, type LoopJob, type ProcessStop, type RunRecord } from "./store.ts";

export const DEFAULT_RUN_TIMEOUT_MS = 15 * 60_000;

export interface LoopSinks {
	started(job: LoopJob, row: ClaimedRow): void;
	finished(record: RunRecordM4b): void;
	filed?(): void;
	retired?(job: LoopJob, reason: string): void;
	log(message: string, level?: "info" | "warning", job?: Pick<LoopJob, "cwd">): void;
}

export type RunRecordM4b = RunRecord & {
	row?: string;
	stop?: ProcessStop;
	/** Findings the run reported that the repeat rule did not file again: a `new` finding of the loop has the same text. Absent when there were none. */
	repeats?: number;
	/** The notes of the follow-ups that started this run (`cause: "wake"`): `/cron runs` says the first, and `wake_me` counts these runs. */
	woken?: string[];
	/** Their ids, as the row carried them (`woken_ids`). */
	woken_ids?: string[];
};

/** The job a loop lane's row names: the clock's slot, a person's `/cron run`, or the loop's follow-up. */
export function rowJob(source: Row["source"]): string {
	for (const prefix of ["cron-run:", "wake:", "cron:"]) if (source.startsWith(prefix)) return source.slice(prefix.length);
	return source;
}
export type { ProcessStop } from "./store.ts";

export interface LoopRunDeps {
	readonly stores: Pick<Stores, "jobs" | "clock" | "inbox" | "requests" | "book" | "history">;
	readonly runs: RunList;
	readonly runner: SubagentRunner;
	session(): SessionSnapshot;
	readonly hop: number;
	holder(): { readonly pid: number; readonly procStart: string | undefined };
	readonly engine: () => EngineSinks;
	readonly sinks: LoopSinks;
	readonly now?: () => number;
	/** `events.jsonl`: the gate reading a row names (`payload.events`), for the `[gate]` block and for `seen`. */
	readonly events?: Pick<EventLog, "get">;
}

export interface LoopRowPayload extends NonNullable<ClaimedRow["payload"]> {
	slot?: string;
	catch_up?: true;
	requested_by?: string;
	/** The gate reading that opened this run (`events.jsonl` ids, design 3.3): one, from the tick. */
	events?: string[];
}

/** The gate reading a row names, read back from `events.jsonl`, with when it was stored. Undefined when the row names none or the log no longer has it. */
export function gateReadingOf(row: Pick<Row, "payload">, events: Pick<EventLog, "get"> | undefined): { reading: CommandReading; at: string } | undefined {
	const id = (row.payload as LoopRowPayload | undefined)?.events?.[0];
	const event = id === undefined ? undefined : events?.get(id);
	if (!event || !event.source.startsWith("gate:")) return undefined;
	const reading = commandReadingOf(event.raw);
	return reading && { reading, at: event.received_at };
}

export async function runLoop(row: ClaimedRow, job: LoopJob, deps: LoopRunDeps): Promise<void> {
	const now = deps.now ?? Date.now;
	const started = new Date(row.run.started_at).getTime();
	const payload = row.payload as LoopRowPayload | undefined;
	const runId = row.run.id;
	const session = deps.session();
	const running = deps.runs.get(runId);
	try { deps.sinks.started(job, row); }
	catch (error) { deps.sinks.log(`loop ${job.id}: start notification failed: ${error instanceof Error ? error.message : String(error)}`, undefined, job); }
	try {
		let previousState: string | undefined;
		try { previousState = deps.stores.jobs.readState(job.id); }
		catch (error) { deps.sinks.log(`loop ${job.id}: state read failed: ${error instanceof Error ? error.message : String(error)}`, undefined, job); }
		const notesDir = deps.stores.jobs.notesDir(job.id);
		let notesFiles: string[] = [];
		try { notesFiles = notesFileLines(listNotesFiles(notesDir)); }
		catch (error) { deps.sinks.log(`loop ${job.id}: notes directory read failed: ${error instanceof Error ? error.message : String(error)}`, undefined, job); }
		let reported: string[] = [];
		let asked: string[] = [];
		try {
			// Only what the two blocks read: this loop's own findings and the questions of its lane.
			const findings = deps.stores.inbox.list((f) => screenedJobId(f) === job.id || f.ask?.lane === row.lane);
			reported = reportedFor(findings, job.id, now());
			asked = askedLines(findings, row.lane);
		} catch (error) { deps.sinks.log(`loop ${job.id}: inbox read failed: ${error instanceof Error ? error.message : String(error)}`, undefined, job); }
		// From jobs.json only, as tools and cwd are: a row in the lane file can be written by hand.
		const timeoutMs = job.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
		let gate: string[] | undefined;
		try { const read = gateReadingOf(row, deps.events); gate = read && gateLines(read.reading); }
		catch (error) { deps.sinks.log(`loop ${job.id}: gate reading read failed: ${error instanceof Error ? error.message : String(error)}`, undefined, job); }
		const prompt = composeLoopPrompt(job.prompt, previousState, {
			name: job.name,
			notesDir,
			notesFiles,
			reported,
			asked,
			woken: payload?.woken,
			gate,
			timeoutMs,
			runAt: `${formatLocalZoned(started)}${payload?.catch_up ? " (catching up a missed tick)" : ""}`,
		});
		const model = job.model ?? session.model;
		const thinking = job.thinking ?? session.thinking;
		const abort = running?.ctrl.signal;
		const source = `cron:${job.name ?? job.id.slice(0, "cron-".length + 8)}`;
		// The guard's seat: a dangerous call files a question in this lane. The cap is the job's as jobs.json has it, and the runner runs it.
		const guard = { lane: row.lane, origin: { source, run_id: runId, cwd: job.cwd, job_id: job.id, ...(job.createdBy?.sessionId ? { session_id: job.createdBy.sessionId } : {}), who: job.name ?? job.id }, cap: resolveCap(job, DEFAULT_RUN_TIMEOUT_MS) };
		let result: RunnerResult;
		try {
			result = await deps.runner({
				cwd: job.cwd, prompt, model, thinking, tools: job.tools, builtinTools: job.builtinTools,
				timeoutMs, signal: abort, sessionDir: deps.stores.jobs.sessionDirFor(job.id),
				hop: deps.hop + 1, parentSessionId: session.sessionId, parentCwd: session.cwd,
				kind: "loop", jobId: job.id, runId, guard,
				onSessionFile: (file) => { if (running) running.sessionFile = file; },
			});
		} catch (error) {
			result = failedRun(error instanceof Error ? error.message : String(error));
		}

		let stillThere = true;
		try { stillThere = deps.stores.jobs.load().some((candidate) => candidate.id === job.id); }
		catch (error) { deps.sinks.log(`loop ${job.id}: could not read the store after the run (${error instanceof Error ? error.message : String(error)}); keeping its state and findings`, undefined, job); }
		if (!stillThere) deps.sinks.log(`loop ${job.id}: removed during the run; its state and findings are discarded`, undefined, job);
		const parsed = parseRunOutput(result.text);
		let stateUpdated = false;
		let notesCut: RunRecord["notesCut"];
		// A failed or stopped run leaves the index as it was; files it wrote in its notes directory stay.
		if (stillThere && result.ok && parsed.state !== undefined) {
			const notes = notesWrite(parsed.state);
			try {
				// The whole text first: an index that says "the whole text is in overflow.md" is never on disk without it.
				if (notes.overflow !== undefined) deps.stores.jobs.writeOverflow(job.id, notes.overflow);
				deps.stores.jobs.writeState(job.id, notes.index);
				stateUpdated = true;
				if (notes.cut) {
					notesCut = notes.cut;
					deps.sinks.log(`loop ${job.name ?? job.id}: notes cut ${notes.cut.from}→${notes.cut.to} characters; the whole text is in ${path.join(notesDir, OVERFLOW_FILE)}`, "warning", job);
				}
			} catch (error) { deps.sinks.log(`loop ${job.id}: state write failed: ${error instanceof Error ? error.message : String(error)}`, undefined, job); }
		}
		let checker: RunRecord["checker"];
		let reviewed: Array<{ text: string; verified?: boolean; reason?: string }> = parsed.findings.map((text) => ({ text }));
		if (stillThere && result.ok && job.verify && parsed.findings.length && !abort?.aborted) {
			const outcome = await runChecker(job, runId, parsed.state ?? previousState, parsed.findings, abort, job.checkerModel ?? model, thinking, deps, now);
			checker = outcome.record;
			reviewed = outcome.reviewed;
		}
		const findings: string[] = [];
		let repeats = 0;
		if (stillThere && result.ok) {
			for (const finding of reviewed) {
				try {
					const filed = await deps.stores.inbox.append({
						source,
						text: finding.text, run_id: runId, job_id: job.id, cwd: job.cwd,
						kind: findingKind(finding.text), verified: finding.verified,
						verified_reason: finding.reason, session_id: job.createdBy?.sessionId,
						transcript: result.sessionFile, transcript_id: result.sessionId, lane: row.lane,
					}, { unlessRepeat: true });
					if (filed) findings.push(finding.text);
					else repeats++;
				} catch (error) { deps.sinks.log(`loop ${job.id}: inbox append failed: ${error instanceof Error ? error.message : String(error)}`, undefined, job); }
			}
		}

		const finishedAt = stamp(now());
		const aborted = !result.ok && (result.stopReason === "aborted" || abort?.aborted === true);
		const byPerson = aborted && abort?.reason === STOPPED_BY_PERSON;
		const record: RunRecordM4b = {
			runId, row: row.id, jobId: job.id, jobName: job.name, stateful: true, cwd: job.cwd,
			pid: row.run.pid, startedAt: row.run.started_at, finishedAt, ok: result.ok,
			exitCode: result.exitCode,
			error: result.ok ? undefined : byPerson ? STOPPED_BY_PERSON : redact(result.errorMessage ?? "unknown error"),
			findings: findings.length, droppedFindings: parsed.droppedFindings, stateUpdated,
			...(repeats ? { repeats } : {}),
			...(notesCut ? { notesCut } : {}),
			model: result.model ?? model, usage: result.usage, warning: result.warning,
			retries: result.retries, compactions: result.compactions,
			summary: previewRedacted(findings[0] ?? stripProtocolTags(result.text), 400) || undefined,
			sessionId: result.sessionId, sessionFile: result.sessionFile, checker,
			forSession: job.createdBy?.sessionId, ordinal: nextOrdinal(job.id, deps),
			...(payload?.requested_by ? { requestedBy: { sessionId: payload.requested_by } } : {}),
			...(payload?.woken?.length ? { cause: "wake" as const, woken: payload.woken } : {}),
			...(payload?.woken_ids?.length ? { woken_ids: payload.woken_ids } : {}),
			...(aborted ? { aborted: true as const } : {}),
			...(byPerson ? { stoppedBy: "person" as const, stoppedFrom: running?.stoppedFrom ?? "cli" } : {}),
		};
		// As main, before the record: the newest transcripts are kept, and those a finding points at.
		try { deps.stores.jobs.pruneSessions(job.id, undefined, deps.stores.inbox.pinnedTranscripts({ job: job.id }, deps.stores.jobs.sessionDirFor(job.id))); }
		catch (error) { deps.sinks.log(`loop ${job.id}: transcript pruning failed: ${error instanceof Error ? error.message : String(error)}`, "info", job); }
		await closeLoopRun(row, deps, now(), record);
		if (findings.length) deps.sinks.filed?.();
	} catch (error) {
		deps.sinks.log(`loop ${job.id}: run failed: ${error instanceof Error ? error.message : String(error)}`, undefined, job);
	} finally {
		deps.runs.remove(runId);
		// A closing that threw before it wrote the row: the run happened, so its slot is spent now, as
		// main's end of a run clears its marker whatever failed. The lane's drain does the same for a
		// claim this misses.
		try {
			if (deps.stores.requests.list(row.lane).some((item) => item.id === row.id && item.run?.id === runId)) {
				deps.stores.requests.remove(row.lane, [row.id]);
				deps.sinks.log(`loop ${job.id}: run ${runId.slice(0, 12)} ended without its closing; its slot is spent`, "info", job);
			}
		} catch (error) {
			deps.sinks.log(`loop ${job.id}: run ${runId.slice(0, 12)} could not be closed: ${error instanceof Error ? error.message : String(error)}`, undefined, job);
		}
	}
}

/**
 * The ordinal of the run that ends now: one more than the count so far, which is the highest of the
 * run log's ordinals and the cursor's count (a directory 0.24.2 left brings its count in the cursor,
 * and its run log may be gone). A run log that cannot be read leaves it out; the closing counts the
 * run from what it can read.
 */
function nextOrdinal(jobId: string, deps: Pick<LoopRunDeps, "stores" | "sinks">): number | undefined {
	try { return Math.max(deps.stores.history().get(jobId)?.ordinal ?? 0, deps.stores.clock.read().jobs[jobId]?.runs ?? 0) + 1; }
	catch (error) {
		deps.sinks.log(`loop ${jobId}: run history read failed: ${error instanceof Error ? error.message : String(error)}`, "info");
		return undefined;
	}
}

function runChecker(job: LoopJob, runId: string, makerState: string | undefined, findings: string[], signal: AbortSignal | undefined, model: string | undefined, thinking: string | undefined, deps: LoopRunDeps, now: () => number): Promise<{ record: NonNullable<RunRecord["checker"]>; reviewed: Array<{ text: string; verified?: boolean; reason?: string }> }> {
	return (async () => {
		const started = now();
		let result: RunnerResult;
		try {
			const session = deps.session();
			result = await deps.runner({ cwd: job.cwd, prompt: composeCheckerPrompt(job.prompt, makerState, findings, { name: job.name }), model, thinking, tools: job.tools, builtinTools: job.builtinTools, timeoutMs: job.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, signal, sessionDir: deps.stores.jobs.sessionDirFor(job.id), hop: deps.hop + 1, parentSessionId: session.sessionId, parentCwd: session.cwd, kind: "checker", jobId: job.id, runId });
		} catch (error) { result = failedRun(error instanceof Error ? error.message : String(error)); }
		const verdicts = result.ok ? parseCheckerOutput(result.text) : new Map();
		const reviewed: Array<{ text: string; verified?: boolean; reason?: string }> = [];
		const dropped: NonNullable<RunRecord["checker"]>["dropped"] = [];
		let unreviewed = 0;
		findings.forEach((text, index) => {
			const verdict = verdicts.get(index + 1);
			if (!verdict) { unreviewed++; reviewed.push({ text, reason: result.ok ? "checker gave no verdict" : `checker failed: ${result.errorMessage ?? "unknown error"}` }); }
			else if (verdict.verdict === "keep") reviewed.push({ text: verdict.rewrite ?? text, verified: true, reason: verdict.reason || undefined });
			else dropped.push({ text: previewRedacted(text, 500), reason: previewRedacted(verdict.reason || "no reason given", 300) });
		});
		const record = { ok: result.ok, error: result.ok ? undefined : redact(result.errorMessage ?? "unknown error"), kept: reviewed.filter((item) => item.verified).length, dropped, unreviewed, durationMs: now() - started, cost: result.usage.cost, model: result.model ?? model, sessionFile: result.sessionFile };
		if (!result.ok) deps.sinks.log(`loop ${job.name ?? job.id}: checker failed (${record.error}); findings enter the inbox unverified`, undefined, job);
		return { record, reviewed };
	})();
}

export function stoppedTogether(claim: ClaimedRow["run"], claims: readonly ClaimedRow[], records: readonly RunRecordM4b[]): ProcessStop {
	const same = (run: ClaimedRow["run"]): boolean => run.pid === claim.pid && run.procStart === claim.procStart;
	const namesClaim = (record: RunRecordM4b, run: ClaimedRow["run"]): boolean => record.runId === run.id && Date.parse(record.startedAt) >= Date.parse(run.started_at);
	const runs = new Set<string>([claim.id]);
	for (const row of claims) if (same(row.run) && !records.some((record) => namesClaim(record, row.run))) runs.add(row.id);
	for (const record of records) if (record.interrupted && record.stop?.pid === claim.pid && record.stop.procStart === claim.procStart) for (const id of record.stop.runs) runs.add(id);
	return { pid: claim.pid, ...(claim.procStart === undefined ? {} : { procStart: claim.procStart }), runs: [...runs].sort() };
}

export function aloneIn(record: RunRecordM4b): boolean {
	return record.stop === undefined || record.stop.runs.length <= 1;
}

export function ensureRecord(row: ClaimedRow, deps: Pick<LoopRunDeps, "stores" | "holder">, now: number, ended?: RunRecordM4b): RunRecordM4b {
	const self = deps.holder();
	const own = row.run.pid === self.pid && row.run.procStart === self.procStart;
	const claims = own ? [] : deps.stores.requests.lanes().filter((lane) => lane.kind === "loop").flatMap((lane) => deps.stores.requests.list(lane.id).flatMap((candidate) => candidate.run ? [candidate as ClaimedRow] : []));
	let existing: RunRecordM4b | undefined;
	deps.stores.jobs.appendRunOnce((records) => {
		existing = records.find((record) => record.runId === row.run.id && Date.parse(record.startedAt) >= Date.parse(row.run.started_at)) as RunRecordM4b | undefined;
		if (existing) return undefined;
		return ended ?? {
			runId: row.run.id, row: row.id, jobId: rowJob(row.source),
			jobName: undefined, stateful: true, cwd: row.payload?.cwd ?? "", pid: row.run.pid,
			startedAt: row.run.started_at, finishedAt: stamp(now), ok: false, error: INTERRUPTED,
			findings: 0, droppedFindings: 0, stateUpdated: false, interrupted: true,
			...(row.payload?.woken?.length ? { cause: "wake" as const, woken: row.payload.woken } : {}),
			...(row.payload?.woken_ids?.length ? { woken_ids: row.payload.woken_ids } : {}),
			...(own ? {} : { stop: stoppedTogether(row.run, claims, records as RunRecordM4b[]) }),
		};
	});
	return existing ?? (deps.stores.jobs.listRuns().find((record) => record.runId === row.run.id && Date.parse(record.startedAt) >= Date.parse(row.run.started_at)) as RunRecordM4b);
}

export interface RunClose { readonly ordinal?: number; readonly fired?: string; readonly slot?: string; readonly seen?: { readonly digest: string; readonly at: string } }
export type Fate =
	| { readonly do: "leave"; readonly exit: "delivered" | "stopped" | "parked" }
	| { readonly do: "owed" }
	| { readonly do: "retry"; readonly attempts: number; readonly why: string; readonly wait?: false }
	| { readonly do: "dead"; readonly attempts: number; readonly why: string };
export type ClosedM4b = { readonly end: ReturnType<typeof runEnd>; readonly outcome: "removed" | "waiting" | "failed" | "dead"; readonly job?: LoopJob };
export type CloseStep =
	| { readonly write: "run-end"; readonly record: RunRecordM4b }
	| { readonly write: "clock"; readonly job: string; readonly close: RunClose }
	| { readonly write: "disable"; readonly job: string; readonly disabled: Disabled }
	| { readonly write: "successor"; readonly row: UnclaimedRow };
export type RowStep = { readonly write: "row"; readonly fate: Fate };
export type ClosePlan = readonly [...CloseStep[], RowStep];
export interface CloseInput {
	readonly row: ClaimedRow; readonly job: LoopJob | undefined; readonly record: RunRecordM4b; readonly history: JobHistory; readonly self: Row["created_by"]; readonly now: number;
	/** The gate reading the row named (`gateReadingOf`): `seen` when the run succeeded and the reading is of the job's gate as it is now. */
	readonly gate?: { readonly reading: CommandReading; readonly at: string };
}

export function closeSteps(input: CloseInput): ClosePlan {
	const { row, job, record, history, self, now } = input;
	const settled: LoopSettlement = settleLoop(row, job, loopEnd(record, history), aloneIn(record));
	const end = runEnd(record);
	// `seen` only after a run that did not fail (design 3.3): a failed one leaves it, and the same change wakes the loop again.
	const digest = input.gate && end.how === "succeeded" && input.gate.reading.command === job?.gate?.command ? readingDigest(input.gate.reading) : undefined;
	const close: RunClose = {
		...(end.how === "succeeded" || end.how === "failed" ? { ordinal: history.ordinal } : {}),
		...((end.how === "succeeded" || end.how === "failed" || end.how === "stopped") && firedBy(row) !== undefined ? { fired: firedBy(row) } : {}),
		...(row.payload?.woken_ids?.length ? { followups: row.payload.woken_ids } : {}),
		...(row.collapsed_slot === undefined ? {} : { slot: row.collapsed_slot }),
		...(digest === undefined ? {} : { seen: { digest, at: input.gate!.at } }),
	};
	const steps: CloseStep[] = [{ write: "run-end", record }];
	if (job && Object.keys(close).length) steps.push({ write: "clock", job: job.id, close });
	if (job && settled.job) steps.push({ write: "disable", job: job.id, disabled: settled.job.disabled });
	if (job && settled.row.do === "leave" && settled.row.exit === "delivered" && settled.row.successor) {
		const successor = plainJobRow(job, plainRunId(job.id, `after ${row.id}`), `cron:${job.id}`, "", self, now);
		steps.push({ write: "successor", row: { ...successor, lane: row.lane, ...(job.stateful ? { mode: "unattended" as const } : {}) } });
	}
	return [...steps, { write: "row", fate: settled.row }] as ClosePlan;
}

export async function closeLoopRun(row: ClaimedRow, deps: Pick<LoopRunDeps, "stores" | "engine" | "sinks" | "holder" | "events">, now: number, ended?: RunRecordM4b): Promise<ClosedM4b> {
	const fail = (what: string, error: unknown): void => deps.sinks.log(`loop run ${row.id}: ${what} failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
	// A run that ended here closes on what it holds, as main's end of a run does: a store that cannot be
	// read or written now is logged, and the row is still written last. Whatever still throws before the
	// row is written, the loop lane's drain spends the slot of a claim of this process whose run has left
	// the list (src/background-executor.ts), so the lane does not stay "running" and the slot runs once.
	let record: RunRecordM4b;
	let recorded = true;
	try {
		record = ensureRecord(row, deps, now, ended);
	} catch (error) {
		if (!ended) throw error; // a closing for a process that is gone writes nothing it cannot record
		fail("run log append", error);
		record = ended;
		recorded = false;
	}
	const jobId = record.jobId;
	let job: LoopJob | undefined;
	try { job = deps.stores.book().jobs.find((candidate) => candidate.id === jobId); }
	catch (error) { fail("jobs read", error); }
	let history: JobHistory = { ordinal: 0, streak: 0, interrupted: [], spent: new Set<string>() };
	// A run whose record could not be written still counts, as main counts it in its own field.
	try { history = (recorded ? deps.stores.history() : runHistory([...deps.stores.jobs.allRuns(), record])).get(jobId) ?? history; }
	catch (error) { fail("run history read", error); }
	// The row as the lane holds it now: a slot that collapsed onto it while it ran is on this copy only.
	let current = row;
	try { current = (deps.stores.requests.list(row.lane).find((item) => item.id === row.id && item.run?.started_at === row.run.started_at) as ClaimedRow | undefined) ?? row; }
	catch (error) { fail("row read", error); }
	let gate: CloseInput["gate"];
	try { gate = job?.gate ? gateReadingOf(current, deps.events) : undefined; }
	catch (error) { fail("gate reading read", error); }
	let outcome: ClosedM4b["outcome"] = "waiting";
	let closedJob = job;
	for (const step of closeSteps({ row: current, job, record, history, self: deps.engine().self(), now, ...(gate ? { gate } : {}) })) {
		if (step.write === "row") {
			outcome = await applyFate(deps.stores.requests, deps.engine(), row, step.fate, now);
			continue;
		}
		try {
			switch (step.write) {
				case "run-end": deps.sinks.finished(step.record); break;
				case "clock": deps.stores.clock.closeRun(step.job, step.close); break;
				case "disable":
					closedJob = (await deps.stores.jobs.disable(step.job, step.disabled)) as LoopJob | undefined;
					if (step.disabled.code === "interrupted" && job) deps.sinks.log(`cron ${job.name ?? job.id}: parked after ${row.attempts + 1} interrupted runs`, undefined, job);
					break;
				case "successor": deps.stores.requests.appendIfAbsent(step.row); break;
			}
		} catch (error) {
			fail(step.write, error);
		}
	}
	if (job?.schedule.kind === "once") {
		let current: LoopJob | undefined;
		try { current = deps.stores.book().jobs.find((candidate) => candidate.id === jobId); }
		catch (error) { fail("jobs read", error); }
		if (current) {
			const history = deps.stores.history().get(jobId) ?? { ordinal: 0, streak: 0, spent: new Set<string>() };
			const queued = deps.stores.requests.list(row.lane).some((candidate) => candidate.source === `cron:${jobId}` || candidate.source === `cron-run:${jobId}` || candidate.source === `wake:${jobId}`);
			if (oneShotDoneV3(current, { running: undefined, queued: queued || undefined, runs: history.ordinal, ...(history.streak ? { error: { streak: history.streak } } : {}) })) {
				await deps.stores.jobs.remove(jobId);
				deps.sinks.retired?.(current, history.streak >= 2 ? "one-shot failed twice" : "one-shot finished");
				closedJob = undefined;
			}
		}
	}
	return { end: runEnd(record), outcome, ...(closedJob ? { job: closedJob } : {}) };
}
