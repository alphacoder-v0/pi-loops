/**
 * One check of a project's dynamic rules: the sub-agent run, its audit rows, the findings it files,
 * the fire-once rules it disarms, the gate readings it marks as seen, its run record in the project's
 * check lane, and its promotions. What admits a check, and what is kept between checks, is the caller's.
 */
import * as path from "node:path";
import { createHash } from "node:crypto";
import { realpathish } from "./paths.ts";
import { capRedacted, previewRedacted, redact } from "./redact.ts";
import { type RunnerResult, type SubagentRunner, failedRun } from "./runner.ts";
import { type ResolvedCap, resolveCap } from "./ask.ts";
import type { JobStore, RunRecord } from "./store.ts";
import type { Inbox } from "./inbox.ts";
import { checkLane } from "./lane.ts";
import { stamp } from "./schedule.ts";
import type { GateClocks } from "./clock.ts";
import {
	NO_MATCH_SENTINEL,
	SUMMARY_CAP_CHARS,
	type DynamicTriggerRule,
	type Trigger,
	type TriggerStore,
	checkDecidedFinding,
	extractDynamicRuleIds,
	renderDynamicTriggerPrompt,
} from "./triggers.ts";

/** Where a promotion / injection went: the chat of this process, the queue of the conversation that created the rule (src/requests.ts), the inbox, or nowhere because an earlier one with its key is still queued. */
export type PromoteTarget = "chat" | "queued" | "inbox" | "collapsed";

/** What the gates let through to a check: the rules whose path is there, and the stored readings (`events.jsonl` ids) that opened it. */
export interface GateLet {
	prechecked?: string[];
	events?: string[];
	/** The command readings that opened it: each rule's `seen` once the check ends without a failure. */
	seen?: { rule: string; digest: string; at: string }[];
}

/**
 * Transcripts are kept per project, not in one directory for the machine: a shared budget meant
 * three projects polling every ten minutes exhausted it within hours, taking the evidence for
 * "why did this rule not match?" with them.
 *
 * The basename alone was not per project: `~/a/web` and `~/b/web` landed in one directory, back to
 * one shared budget of 40 — and each project's prune deleted the other's evidence. So the readable
 * basename keeps its place and a short digest of the resolved path makes it unique. Resolved the way
 * everything else here compares paths (`realpathish`), so a worktree reached through a symlink is
 * still the same project. The name is the resolved path's too: a project reached through a symlink
 * keeps its checks' transcripts where the checks of its real path keep them.
 */
export function triggerSessionKey(cwd: string): string {
	const real = realpathish(cwd || "unknown");
	const base = path.basename(real).replace(/[^A-Za-z0-9._-]/g, "_") || "unknown";
	const digest = createHash("sha256").update(real).digest("hex").slice(0, 8);
	return `triggers-${base}-${digest}`;
}

/**
 * A project's check session directory: where its checks write their transcripts, and where an answer
 * in its check lane finds them. The one source for both, from the resolved path of `cwd`.
 */
export function checkSessionDir(jobs: Pick<JobStore, "sessionDirFor">, cwd: string): string {
	return jobs.sessionDirFor(triggerSessionKey(cwd));
}

/**
 * The cap of a project's check, the one source for the check's own run and for the run of an answer
 * in its check lane: the longest timeout its rules name, else `runTimeoutMs` (`[triggers]
 * run_timeout_secs`); the model and thinking level of the first rule that pins a model.
 */
export function checkCap(cwd: string, rules: readonly Pick<DynamicTriggerRule, "timeoutMs" | "model" | "thinking">[], runTimeoutMs: number): ResolvedCap {
	// A thinking level belongs to the model it was chosen for: both come from one rule.
	const withModel = rules.find((r) => r.model);
	const timeoutMs = rules.reduce((max, r) => Math.max(max, r.timeoutMs ?? 0), 0) || runTimeoutMs;
	return resolveCap({ cwd, ...(withModel?.model ? { model: withModel.model } : {}), ...(withModel?.thinking ? { thinking: withModel.thinking } : {}), timeoutMs }, runTimeoutMs);
}

/** Check transcripts kept per project, as docs/configuration.md promises. */
export const TRIGGER_SESSIONS_KEPT = 40;

export const DEFAULT_TRIGGER_RUN_TIMEOUT_MS = 15 * 60_000;

/** The engine prefixes `[Trigger <trace>] ` and injects the payload summary itself, capped. */
export function promotionBody(trigger: Trigger, summary: string): string {
	// Capped, never reflowed: a promoted result is often a file, a diff or test output, and rewrapping
	// it is how a diff stops applying and a stack trace stops pointing anywhere. Truncation respects
	// character boundaries, so the cap cannot cut a multi-byte character in half.
	return `[Trigger ${trigger.traceId}] ${capRedacted(summary, SUMMARY_CAP_CHARS)}`;
}

/**
 * A sub-agent result promoted into the chat: `<source> fired <event>.\nResult: …`, so the chat says
 * what fired and not only what came back — a result with no cause reads as the agent talking to
 * itself. The rendered body is then capped at `SUMMARY_CAP_CHARS` characters — the same cap an audit
 * row's summary gets, and characters rather than bytes, so it cannot cut a multi-byte one in half.
 */
export function promotionSummaryBody(trigger: Trigger, summary: string): string {
	return capRedacted(`[Trigger ${trigger.traceId}] ${trigger.sourceLabel} fired ${trigger.eventLabel}.\nResult: ${summary}`, SUMMARY_CAP_CHARS);
}

/**
 * A promoted result no conversation can take, filed in the inbox: what both processes do when the
 * promotion falls back. A rule check decided its finding already (checkDecidedFinding), filed or
 * skipped as a repeat; a push with no rule did not, and is filed once by its run.
 */
export async function promotionToInbox(inbox: Pick<Inbox, "appendOnce">, audit: Pick<TriggerStore, "listAudit">, content: string, trigger: { sourceLabel: string; traceId: string }, where: { cwd: string; sessionId?: string }): Promise<void> {
	if (checkDecidedFinding(audit, trigger.traceId)) return;
	const source = `trigger:${trigger.sourceLabel}`;
	await inbox.appendOnce({ source, text: content.replace(/^\[Trigger [^\]]+\]\s*/, ""), run_id: trigger.traceId, job_id: trigger.sourceLabel, cwd: where.cwd, session_id: where.sessionId, lane: checkLane(where.cwd) }, { run_id: trigger.traceId, source });
}

/** Rules by the conversation that created them: one check's result goes to each of those once. */
export function byCreator(rules: readonly DynamicTriggerRule[]): Map<string | undefined, DynamicTriggerRule[]> {
	const out = new Map<string | undefined, DynamicTriggerRule[]>();
	for (const r of rules) out.set(r.createdBy?.sessionId, [...(out.get(r.createdBy?.sessionId) ?? []), r]);
	return out;
}

/**
 * The envelope fields carried on every audit row, in every state a trigger passes through. Without
 * the idempotency key on each of them, "which pushes collapsed into which" cannot be answered after
 * the fact — and that question is the whole reason the dedup window is allowed to drop anything.
 * Bounded and redacted: a key is caller-supplied text.
 */
export function envelopeOf(trigger: Trigger): Record<string, unknown> {
	return { idempotency_key: capRedacted(trigger.idempotencyKey, 256), replacement_policy: trigger.replacementPolicy, received_at: trigger.receivedAt };
}

export interface CheckDeps {
	readonly runner: SubagentRunner;
	readonly rules: Pick<TriggerStore, "markFired" | "appendAudit">;
	readonly jobs: Pick<JobStore, "sessionDirFor" | "pruneSessions" | "appendRunOnce">;
	readonly inbox?: Pick<Inbox, "appendOnce" | "pinnedTranscripts">;
	readonly clock: GateClocks;
	readonly promote: (content: string, trigger: Trigger, forSession?: string) => PromoteTarget | Promise<PromoteTarget>;
	readonly session: { readonly sessionId?: string; readonly cwd: string; readonly model?: string; readonly thinking?: string };
	readonly hop: number;
	readonly runTimeoutMs: number;
	readonly log: (message: string) => void;
	readonly now: () => number;
}

export interface CheckInput {
	/** Its cwd is the project. */
	readonly trigger: Trigger;
	/** The rules this check evaluates. */
	readonly rules: readonly DynamicTriggerRule[];
	readonly gates?: GateLet;
	readonly signal: AbortSignal;
	readonly run: { readonly id: string; readonly row?: string; readonly cause: "check" | "push" };
	readonly onStarted?: (promptPreview: string) => void;
}

export interface CheckOutcome {
	readonly state: "no_rules" | "completed" | "failed" | "aborted";
	readonly ok: boolean;
	readonly matchedRules: readonly DynamicTriggerRule[];
	readonly summary: string;
	readonly error?: string;
	readonly cost: number;
	readonly promoted: boolean;
	readonly sessionFile?: string;
	/** Absent for `no_rules`, and when the record could not be written. */
	readonly record?: RunRecord;
}

/** Characters of what a check said that its run record keeps. */
const RECORD_SUMMARY_CHARS = 200;

export async function runCheck(deps: CheckDeps, input: CheckInput): Promise<CheckOutcome> {
	const { trigger, rules, gates, signal } = input;
	const cwd = trigger.cwd ?? deps.session.cwd;
	if (!rules.length) {
		deps.rules.appendAudit({ cwd, type: "trigger_result", traceId: trigger.traceId, state: "no_rules", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { delivery: "sub_agent", ...envelopeOf(trigger) } });
		return { state: "no_rules", ok: true, matchedRules: [], summary: "no enabled dynamic trigger rules", cost: 0, promoted: false };
	}
	const startedAt = stamp(deps.now());
	const prompt = renderDynamicTriggerPrompt(trigger, [...rules]);
	input.onStarted?.(previewRedacted(prompt, 80)); // 80 characters is a banner, not a prompt
	deps.rules.appendAudit({ cwd, type: "trigger_result", traceId: trigger.traceId, state: "running", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, details: { rule_count: rules.length, cwd, ...(gates?.prechecked?.length ? { prechecked: gates.prechecked } : {}), ...(gates?.events?.length ? { events: gates.events } : {}), ...envelopeOf(trigger) } });

	// The check runs with the model the rules were created under, not whatever the process that
	// happens to own the timer is using (`checkCap`), and with the longest per-rule timeout.
	const cap = checkCap(cwd, rules, deps.runTimeoutMs);
	const model = cap.model ?? deps.session.model;
	const thinking = cap.thinking ?? deps.session.thinking;
	const lane = checkLane(cwd);
	let result: RunnerResult;
	try {
		// The guard's seat: a dangerous call files a question in the project's check lane.
		const guard = lane === undefined ? undefined : { lane, origin: { source: `trigger:${trigger.sourceLabel}`, run_id: trigger.traceId, cwd, who: `the check of ${path.basename(cwd) || cwd}` }, cap };
		result = await deps.runner({ cwd, prompt, model, thinking, timeoutMs: cap.timeoutMs, signal, sessionDir: checkSessionDir(deps.jobs, cwd), hop: deps.hop + 1, parentSessionId: deps.session.sessionId, parentCwd: deps.session.cwd, kind: "trigger", traceId: trigger.traceId, ...(guard ? { guard } : {}) });
	} catch (err: any) {
		result = failedRun(err?.message ?? String(err));
	}
	// Per project, not one budget for the machine: three projects polling every ten minutes used
	// to exhaust a shared 40 within a couple of hours, taking the evidence with them. The key has
	// to be the one the transcripts were written under, or the prune looks in a directory that
	// does not exist and silently keeps everything.
	// A transcript a finding points at, or an open answer resumes, is kept.
	deps.jobs.pruneSessions(triggerSessionKey(cwd), TRIGGER_SESSIONS_KEPT, lane === undefined ? undefined : deps.inbox?.pinnedTranscripts({ lane }, checkSessionDir(deps.jobs, cwd)));

	const summary = result.text.trim();
	// A check killed by the run timeout (or aborted) has usually already *executed* the matching
	// rule's action — posting the comment, kicking the deploy — so the matched ids in whatever it
	// managed to say still have to disarm a fire-once rule; otherwise the next poll does it again.
	const matchedIds = extractDynamicRuleIds(summary);
	const matchedRules = rules.filter((r) => matchedIds.includes(r.id));
	if (matchedRules.length) await deps.rules.markFired(matchedRules.map((r) => r.id));
	const quiet = result.ok && matchedRules.length === 0;
	const aborted = signal.aborted;
	const state = aborted ? "aborted" : result.ok ? "completed" : "failed";
	// Every match is a finding, before any promotion and before the result's row, which records what
	// was decided (`details.inbox`): the promotion's inbox fallback and the row's dead letter read it
	// and file nothing more (checkDecidedFinding). The text is what the check said, unedited. It is
	// news: what a check says comes from outside, and `· waits:` in it must not make it a decision.
	// A repeating rule that says again what its latest new finding says files nothing.
	let inboxDecision: "filed" | "repeat" | undefined;
	let filed = 0;
	if (result.ok && matchedRules.length && deps.inbox) {
		const source = `trigger:${trigger.sourceLabel}`;
		for (const [forSession, group] of byCreator(matchedRules)) {
			try {
				const there = await deps.inbox.appendOnce({ source, text: summary, run_id: trigger.traceId, job_id: group[0].id, cwd, session_id: forSession, lane, transcript: result.sessionFile, transcript_id: result.sessionId }, { run_id: trigger.traceId, source, session_id: forSession }, { unlessRepeat: true });
				if (there.run_id === trigger.traceId) filed++;
				inboxDecision = there.run_id === trigger.traceId ? "filed" : (inboxDecision ?? "repeat");
			} catch (err: any) {
				deps.log(`trigger ${trigger.traceId.slice(0, 8)}: inbox append failed: ${err?.message ?? err}`);
			}
		}
	}
	deps.rules.appendAudit({
		cwd,
		type: "trigger_result",
		traceId: trigger.traceId,
		state,
		sourceLabel: trigger.sourceLabel,
		eventLabel: trigger.eventLabel,
		summary: result.ok ? summary || NO_MATCH_SENTINEL : result.errorMessage,
		// `matched_rule_ids` are this project's rules the check named; `named_rule_ids` is every id it
		// wrote, a made-up one or another project's included, which only `/triggers audit` shows.
		details: { delivery: "sub_agent", matched_rule_ids: matchedRules.map((r) => r.id), named_rule_ids: matchedIds, quiet, cost_usd: result.usage.cost, exit_code: result.exitCode, session_file: result.sessionFile, ...(inboxDecision ? { inbox: inboxDecision } : {}), ...envelopeOf(trigger) },
	});
	const record = lane === undefined ? undefined : writeRecord(deps, input, { lane, cwd, startedAt, result, model, aborted, filed, said: summary });
	// A command gate's reading is `seen` only after a check that did not fail: a failed one leaves
	// it, so the same change opens the next check again.
	if (result.ok && !aborted)
		for (const seen of gates?.seen ?? []) {
			try {
				deps.clock.seeGate(seen.rule, { digest: seen.digest, at: seen.at });
			} catch (err: any) {
				deps.log(`rule ${seen.rule}: its gate's seen reading was not written: ${err?.message ?? err}`);
			}
		}

	let promoted = false;
	const promoteRules = matchedRules.filter((r) => r.promoteToChat);
	if (result.ok && promoteRules.length) {
		// One check covers every rule of the project, and two conversations in one repo each get the
		// result of their own rules: one promotion per creating conversation.
		for (const [forSession, group] of byCreator(promoteRules)) {
			const target = await deps.promote(promotionSummaryBody(trigger, summary), trigger, forSession);
			promoted ||= target !== "inbox";
			deps.rules.appendAudit({ cwd, type: "trigger_promotion", traceId: trigger.traceId, state: target === "inbox" ? "redirected" : "promoted", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary, details: { prefix_injected: true, rule_ids: group.map((r) => r.id), to: target, template_name: "default", ...envelopeOf(trigger) } });
		}
	} else if (result.ok && matchedRules.length) {
		deps.rules.appendAudit({ cwd, type: "trigger_promotion", traceId: trigger.traceId, state: "skipped", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, details: { reason: "no matched rule has promote_to_chat", ...envelopeOf(trigger) } });
	}
	return { state, ok: result.ok, matchedRules, summary, ...(result.ok ? {} : { error: result.errorMessage }), cost: result.usage.cost, promoted, sessionFile: result.sessionFile, ...(record ? { record } : {}) };
}

/** The check's run record in its project's check lane, once per run id. A record that cannot be written is logged: the check itself has happened. */
function writeRecord(deps: CheckDeps, input: CheckInput, done: { lane: string; cwd: string; startedAt: string; result: RunnerResult; model: string | undefined; aborted: boolean; filed: number; said: string }): RunRecord | undefined {
	const { result, aborted } = done;
	const ok = result.ok && !aborted;
	const fresh: RunRecord = {
		runId: input.run.id,
		jobId: done.lane,
		stateful: false,
		cwd: done.cwd,
		pid: process.pid,
		startedAt: done.startedAt,
		finishedAt: stamp(deps.now()),
		ok,
		...(ok || aborted ? {} : { error: redact(result.errorMessage ?? "unknown error") }),
		findings: done.filed,
		droppedFindings: 0,
		stateUpdated: false,
		model: result.model ?? done.model,
		usage: result.usage,
		...(done.said ? { summary: Array.from(redact(done.said)).slice(0, RECORD_SUMMARY_CHARS).join("") } : {}),
		sessionId: result.sessionId,
		sessionFile: result.sessionFile,
		cause: input.run.cause,
		...(input.run.row ? { row: input.run.row } : {}),
		...(aborted ? { aborted: true as const } : {}),
	};
	let found: RunRecord | undefined;
	try {
		const written = deps.jobs.appendRunOnce((records) => {
			found = records.find((r) => r.runId === fresh.runId);
			return found ? undefined : fresh;
		});
		return written ?? found;
	} catch (err: any) {
		deps.log(`trigger ${input.trigger.traceId.slice(0, 8)}: its run record was not written: ${err?.message ?? err}`);
		return undefined;
	}
}
