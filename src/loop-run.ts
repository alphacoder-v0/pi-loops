import { type EngineSinks, applyFate, plainJobRow, plainRunId } from "./engine.ts";
import { findingKind, composeCheckerPrompt, composeLoopPrompt, parseCheckerOutput, parseRunOutput, stripProtocolTags } from "./protocol.ts";
import type { ClaimedRow, Row, UnclaimedRow } from "./requests.ts";
import { RunList, STOPPED_BY_PERSON } from "./run-list.ts";
import { previewRedacted, redact } from "./redact.ts";
import { type RunnerResult, type SubagentRunner, failedRun } from "./runner.ts";
import { formatLocalZoned, stamp } from "./schedule.ts";
import { type JobHistory, runHistory } from "./job-status.ts";
import { type LoopSettlement, INTERRUPTED, loopEnd, oneShotDoneV3, runEnd, settleLoop } from "./settle.ts";
import type { SessionSnapshot } from "./scheduler.ts";
import type { Stores } from "./stores.ts";
import { type Disabled, type LoopJobV3, type ProcessStop, type RunRecord } from "./store.ts";

export const DEFAULT_RUN_TIMEOUT_MS = 15 * 60_000;

export interface LoopSinks {
	started(job: LoopJobV3, row: ClaimedRow): void;
	finished(record: RunRecordM4b): void;
	filed?(): void;
	retired?(job: LoopJobV3, reason: string): void;
	log(message: string, level?: "info" | "warning", job?: Pick<LoopJobV3, "cwd">): void;
}

export type RunRecordM4b = RunRecord & { row?: string; stop?: ProcessStop };
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
}

export interface LoopRowPayload extends NonNullable<ClaimedRow["payload"]> {
	slot?: string;
	catch_up?: true;
	requested_by?: string;
}

export async function runLoop(row: ClaimedRow, job: LoopJobV3, deps: LoopRunDeps): Promise<void> {
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
		let dismissed: Array<{ text: string; reason: string }> = [];
		try { dismissed = deps.stores.inbox.feedbackFor(job.id, deps.stores.book().clock.jobs[job.id]?.fired).map((entry) => ({ text: entry.text, reason: entry.dismiss_reason ?? "" })); }
		catch (error) { deps.sinks.log(`loop ${job.id}: feedback read failed: ${error instanceof Error ? error.message : String(error)}`, undefined, job); }
		const timeoutMs = payload?.timeout_ms ?? job.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
		const prompt = composeLoopPrompt(job.prompt, previousState, {
			name: job.name,
			dismissed,
			timeoutMs,
			runAt: `${formatLocalZoned(started)}${payload?.catch_up ? " (catching up a missed tick)" : ""}`,
		});
		const model = job.model ?? session.model;
		const thinking = job.thinking ?? session.thinking;
		const abort = running?.ctrl.signal;
		let result: RunnerResult;
		try {
			result = await deps.runner({
				cwd: job.cwd, prompt, model, thinking, tools: job.tools, builtinTools: job.builtinTools,
				timeoutMs, signal: abort, sessionDir: deps.stores.jobs.sessionDirFor(job.id),
				hop: deps.hop + 1, parentSessionId: session.sessionId, parentCwd: session.cwd,
				kind: "loop", jobId: job.id, runId,
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
		if (stillThere && result.ok && parsed.state !== undefined) {
			try { deps.stores.jobs.writeState(job.id, parsed.state); stateUpdated = true; }
			catch (error) { deps.sinks.log(`loop ${job.id}: state write failed: ${error instanceof Error ? error.message : String(error)}`, undefined, job); }
		}
		let checker: RunRecord["checker"];
		let reviewed: Array<{ text: string; verified?: boolean; reason?: string }> = parsed.findings.map((text) => ({ text }));
		if (stillThere && result.ok && job.verify && parsed.findings.length && !abort?.aborted) {
			const outcome = await runChecker(job, runId, parsed.state ?? previousState, parsed.findings, abort, job.checkerModel ?? model, thinking, deps, now);
			checker = outcome.record;
			reviewed = outcome.reviewed;
		}
		const findings: string[] = [];
		if (stillThere && result.ok) {
			for (const finding of reviewed) {
				try {
					await deps.stores.inbox.append({
						source: `cron:${job.name ?? job.id.slice(0, "cron-".length + 8)}`,
						text: finding.text, run_id: runId, job_id: job.id, cwd: job.cwd,
						kind: findingKind(finding.text), verified: finding.verified,
						verified_reason: finding.reason, session_id: job.createdBy?.sessionId,
						transcript: result.sessionFile, lane: row.lane,
					});
					findings.push(finding.text);
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
			model: result.model ?? model, usage: result.usage, warning: result.warning,
			retries: result.retries, compactions: result.compactions,
			summary: previewRedacted(findings[0] ?? stripProtocolTags(result.text), 400) || undefined,
			sessionId: result.sessionId, sessionFile: result.sessionFile, checker,
			forSession: job.createdBy?.sessionId, ordinal: (deps.stores.history().get(job.id)?.ordinal ?? 0) + 1,
			...(payload?.requested_by ? { requestedBy: { sessionId: payload.requested_by } } : {}),
			...(aborted ? { aborted: true as const } : {}),
			...(byPerson ? { stoppedBy: "person" as const, stoppedFrom: running?.stoppedFrom ?? "cli" } : {}),
		};
		await closeLoopRun(row, deps, now(), record);
		if (findings.length) deps.sinks.filed?.();
	} catch (error) {
		deps.sinks.log(`loop ${job.id}: run failed: ${error instanceof Error ? error.message : String(error)}`, undefined, job);
	} finally {
		deps.runs.remove(runId);
	}
}

function runChecker(job: LoopJobV3, runId: string, makerState: string | undefined, findings: string[], signal: AbortSignal | undefined, model: string | undefined, thinking: string | undefined, deps: LoopRunDeps, now: () => number): Promise<{ record: NonNullable<RunRecord["checker"]>; reviewed: Array<{ text: string; verified?: boolean; reason?: string }> }> {
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
			runId: row.run.id, row: row.id, jobId: row.source.startsWith("cron-run:") ? row.source.slice("cron-run:".length) : row.source.slice("cron:".length),
			jobName: undefined, stateful: true, cwd: row.payload?.cwd ?? "", pid: row.run.pid,
			startedAt: row.run.started_at, finishedAt: stamp(now), ok: false, error: INTERRUPTED,
			findings: 0, droppedFindings: 0, stateUpdated: false, interrupted: true,
			...(own ? {} : { stop: stoppedTogether(row.run, claims, records as RunRecordM4b[]) }),
		};
	});
	return existing ?? (deps.stores.jobs.listRuns().find((record) => record.runId === row.run.id && Date.parse(record.startedAt) >= Date.parse(row.run.started_at)) as RunRecordM4b);
}

export interface RunClose { readonly ordinal?: number; readonly fired?: string }
export type Fate =
	| { readonly do: "leave"; readonly exit: "delivered" | "stopped" }
	| { readonly do: "owed" }
	| { readonly do: "retry"; readonly attempts: number; readonly why: string }
	| { readonly do: "dead"; readonly attempts: number; readonly why: string };
export type ClosedM4b = { readonly end: ReturnType<typeof runEnd>; readonly outcome: "removed" | "waiting" | "failed" | "dead"; readonly job?: LoopJobV3 };
export type CloseStep =
	| { readonly write: "run-end"; readonly record: RunRecordM4b }
	| { readonly write: "clock"; readonly job: string; readonly close: RunClose }
	| { readonly write: "disable"; readonly job: string; readonly disabled: Disabled }
	| { readonly write: "successor"; readonly row: UnclaimedRow };
export type RowStep = { readonly write: "row"; readonly fate: Fate };
export type ClosePlan = readonly [...CloseStep[], RowStep];
export interface CloseInput { readonly row: ClaimedRow; readonly job: LoopJobV3 | undefined; readonly record: RunRecordM4b; readonly history: JobHistory; readonly self: Row["created_by"]; readonly now: number }

export function closeSteps(input: CloseInput): ClosePlan {
	const { row, job, record, history, self, now } = input;
	const settled: LoopSettlement = settleLoop(row, job, loopEnd(record, history), aloneIn(record));
	const end = runEnd(record);
	const close: RunClose = {
		...(end.how === "succeeded" || end.how === "failed" ? { ordinal: history.ordinal } : {}),
		...(end.how === "succeeded" || end.how === "failed" || end.how === "stopped" ? { fired: row.run.started_at } : {}),
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

export async function closeLoopRun(row: ClaimedRow, deps: Pick<LoopRunDeps, "stores" | "engine" | "sinks" | "holder">, now: number, ended?: RunRecordM4b): Promise<ClosedM4b> {
	const record = ensureRecord(row, deps, now, ended);
	const jobId = record.jobId;
	const book = deps.stores.book();
	const job = book.jobs.find((candidate) => candidate.id === jobId);
	const history = deps.stores.history().get(jobId) ?? { ordinal: 0, streak: 0, spent: new Set<string>() };
	let outcome: ClosedM4b["outcome"] = "waiting";
	let closedJob = job;
	for (const step of closeSteps({ row, job, record, history, self: deps.engine().self(), now })) {
		switch (step.write) {
			case "run-end": deps.sinks.finished(step.record); break;
			case "clock": deps.stores.clock.closeRun(step.job, step.close); break;
			case "disable": closedJob = (await deps.stores.jobs.disable(step.job, step.disabled)) as LoopJobV3 | undefined; break;
			case "successor": deps.stores.requests.appendIfAbsent(step.row); break;
			case "row": outcome = await applyFate(deps.stores.requests, deps.engine(), row, step.fate, now); break;
		}
	}
	if (job?.schedule.kind === "once") {
		const current = deps.stores.book().jobs.find((candidate) => candidate.id === jobId);
		if (current) {
			const history = deps.stores.history().get(jobId) ?? { ordinal: 0, streak: 0, spent: new Set<string>() };
			const queued = deps.stores.requests.list(row.lane).some((candidate) => candidate.source === `cron:${jobId}` || candidate.source === `cron-run:${jobId}`);
			if (oneShotDoneV3(current, { running: undefined, queued: queued || undefined, runs: history.ordinal, ...(history.streak ? { error: { streak: history.streak } } : {}) })) {
				await deps.stores.jobs.remove(jobId);
				deps.sinks.retired?.(current, history.streak >= 2 ? "one-shot failed twice" : "one-shot finished");
				closedJob = undefined;
			}
		}
	}
	return { end: runEnd(record), outcome, ...(closedJob ? { job: closedJob } : {}) };
}
