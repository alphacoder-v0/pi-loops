/**
 * The trigger runtime: takes Trigger envelopes from sources (the periodic dynamic
 * checker, MCP pushes), dedups them, runs the dynamic-rule sub-agent (or delivers a
 * notification straight into the chat), marks fire-once rules, promotes results
 * when asked, and keeps audit + running state for /triggers.
 */
import { previewRedacted } from "./redact.ts";
import { runPiSubagent, type RunnerResult } from "./runner.ts";
import type { JobStore } from "./store.ts";
import {
	DEFAULT_TRIGGER_POLL_INTERVAL_SECS,
	DedupWindow,
	NO_MATCH_SENTINEL,
	type DynamicTriggerRule,
	type Trigger,
	TriggerStore,
	buildPeriodicCheckTrigger,
	extractDynamicRuleIds,
	renderDynamicTriggerPrompt,
} from "./triggers.ts";

export type TriggerDelivery = "sub_agent" | "inject_summary" | "inject_and_run";

export interface RunningTrigger {
	traceId: string;
	sourceLabel: string;
	eventLabel: string;
	startedAt: string;
	promptPreview: string;
	cwd: string;
	ctrl: AbortController;
}

export interface TriggerOutcome {
	trigger: Trigger;
	delivery: TriggerDelivery;
	ok: boolean;
	matchedRules: DynamicTriggerRule[];
	summary: string;
	error?: string;
	durationMs: number;
	cost: number;
	promoted: boolean;
	sessionFile?: string;
}

export interface TriggerRuntimeHooks {
	/** Insert text into the parent chat context (no model turn). Already carries the `[Trigger …]` prefix. */
	onPromote?: (content: string, trigger: Trigger) => void | Promise<void>;
	/** Inject `prompt` into the parent chat and run one model turn. */
	onInjectAndRun?: (prompt: string, trigger: Trigger) => void | Promise<void>;
	onStarted?: (running: RunningTrigger) => void;
	onFinished?: (outcome: TriggerOutcome) => void;
	log?: (message: string) => void;
}

export interface TriggerRuntimeOptions {
	store: TriggerStore;
	jobStore: JobStore;
	getSession: () => { sessionId?: string; cwd: string; model?: string; thinking?: string };
	hooks?: TriggerRuntimeHooks;
	pollIntervalSecs?: number;
	piBin?: string;
	now?: () => number;
}

export const DEFAULT_TRIGGER_RUN_TIMEOUT_MS = 15 * 60_000;

export function promotionBody(trigger: Trigger, summary: string): string {
	return `[Trigger ${trigger.traceId}] ${trigger.sourceLabel} fired ${trigger.eventLabel}.\nResult: ${previewRedacted(summary, 4096)}`;
}

export class TriggerRuntime {
	readonly store: TriggerStore;
	private readonly jobStore: JobStore;
	private readonly getSession: TriggerRuntimeOptions["getSession"];
	private readonly hooks: TriggerRuntimeHooks;
	private readonly piBin?: string;
	private readonly now: () => number;
	private readonly dedup = new DedupWindow();
	private readonly running = new Map<string, RunningTrigger>();
	pollIntervalSecs: number;
	lastCheckAt = 0;
	lastPoll: { at: string; cwd: string; outcome: string } | undefined;
	dedupedCount = 0;

	constructor(opts: TriggerRuntimeOptions) {
		this.store = opts.store;
		this.jobStore = opts.jobStore;
		this.getSession = opts.getSession;
		this.hooks = opts.hooks ?? {};
		this.piBin = opts.piBin;
		this.now = opts.now ?? Date.now;
		this.pollIntervalSecs = opts.pollIntervalSecs ?? DEFAULT_TRIGGER_POLL_INTERVAL_SECS;
	}

	runningList(): RunningTrigger[] {
		return [...this.running.values()];
	}

	abort(traceId: string): boolean {
		const r = this.running.get(traceId);
		if (!r) return false;
		r.ctrl.abort();
		return true;
	}

	abortAll(): number {
		const n = this.running.size;
		for (const r of this.running.values()) r.ctrl.abort();
		return n;
	}

	async stop(): Promise<void> {
		this.abortAll();
	}

	/**
	 * Scheduler tick: while at least one enabled rule exists and the poll interval has
	 * elapsed, emit one periodic check per project that has enabled rules. Only the
	 * leader process calls this with `leader = true`.
	 */
	async tick(now: number, leader: boolean): Promise<void> {
		if (!leader) return;
		if (now - this.lastCheckAt < this.pollIntervalSecs * 1000) return;
		const rules = this.store.load().filter((r) => r.enabled);
		if (!rules.length) return;
		this.lastCheckAt = now;
		const byCwd = new Map<string, DynamicTriggerRule[]>();
		for (const r of rules) byCwd.set(r.cwd, [...(byCwd.get(r.cwd) ?? []), r]);
		for (const [cwd, group] of byCwd) {
			if ([...this.running.values()].some((r) => r.cwd === cwd && r.sourceLabel === "local:dynamic")) continue; // previous check still active
			void this.handle(buildPeriodicCheckTrigger(cwd, group.length, new Date(now)), "sub_agent");
		}
	}

	/** Admit one trigger: dedup, audit, deliver. Resolves when the delivery has finished. */
	async handle(trigger: Trigger, delivery: TriggerDelivery): Promise<TriggerOutcome | undefined> {
		const prev = this.dedup.check(trigger.idempotencyKey, trigger.traceId, this.now());
		if (prev) {
			this.dedupedCount++;
			this.store.appendAudit({ type: "trigger", traceId: trigger.traceId, state: "deduped", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { previous_trace_id: prev, replacement_policy: trigger.replacementPolicy } });
			return undefined;
		}
		this.store.appendAudit({ type: "trigger", traceId: trigger.traceId, state: "accepted", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { delivery, evaluator_decision: { outcome: "accept", permission: "allow" } } });
		if (delivery === "inject_summary") return this.deliverInjectSummary(trigger);
		if (delivery === "inject_and_run") return this.deliverInjectAndRun(trigger);
		return this.deliverSubAgent(trigger);
	}

	private async deliverInjectSummary(trigger: Trigger): Promise<TriggerOutcome> {
		const start = this.now();
		const summary = trigger.payloadSummary ?? "";
		let promoted = false;
		if (summary) {
			await this.hooks.onPromote?.(promotionBody(trigger, summary), trigger);
			promoted = true;
			this.store.appendAudit({ type: "trigger_promotion", traceId: trigger.traceId, state: "promoted", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary, details: { prefix_injected: true, delivery: "inject_summary" } });
		}
		this.store.appendAudit({ type: "trigger_result", traceId: trigger.traceId, state: "completed", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary, details: { delivery: "inject_summary", cost_usd: 0 } });
		const outcome: TriggerOutcome = { trigger, delivery: "inject_summary", ok: true, matchedRules: [], summary, durationMs: this.now() - start, cost: 0, promoted };
		this.hooks.onFinished?.(outcome);
		return outcome;
	}

	private async deliverInjectAndRun(trigger: Trigger): Promise<TriggerOutcome> {
		const start = this.now();
		const prompt = `[Trigger ${trigger.traceId}] ${trigger.payloadSummary ?? `${trigger.sourceLabel} fired: ${trigger.eventLabel}`}`;
		await this.hooks.onInjectAndRun?.(prompt, trigger);
		this.store.appendAudit({ type: "trigger_result", traceId: trigger.traceId, state: "completed", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { delivery: "inject_and_run", prefix_injected: true, cost_usd: 0 } });
		const outcome: TriggerOutcome = { trigger, delivery: "inject_and_run", ok: true, matchedRules: [], summary: trigger.payloadSummary ?? "", durationMs: this.now() - start, cost: 0, promoted: true };
		this.hooks.onFinished?.(outcome);
		return outcome;
	}

	private async deliverSubAgent(trigger: Trigger): Promise<TriggerOutcome> {
		const start = this.now();
		const all = this.store.load().filter((r) => r.enabled);
		const rules = trigger.cwd ? all.filter((r) => r.cwd === trigger.cwd) : all;
		const session = this.getSession();
		const cwd = trigger.cwd ?? session.cwd;
		if (!rules.length) {
			this.store.appendAudit({ type: "trigger_result", traceId: trigger.traceId, state: "no_rules", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { delivery: "sub_agent" } });
			const outcome: TriggerOutcome = { trigger, delivery: "sub_agent", ok: true, matchedRules: [], summary: "no enabled dynamic trigger rules", durationMs: 0, cost: 0, promoted: false };
			this.hooks.onFinished?.(outcome);
			return outcome;
		}
		const prompt = renderDynamicTriggerPrompt(trigger, rules);
		const ctrl = new AbortController();
		const running: RunningTrigger = { traceId: trigger.traceId, sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, startedAt: new Date(start).toISOString(), promptPreview: previewRedacted(trigger.payloadSummary ?? prompt, 120), cwd, ctrl };
		this.running.set(trigger.traceId, running);
		this.hooks.onStarted?.(running);
		this.store.appendAudit({ type: "trigger_result", traceId: trigger.traceId, state: "running", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, details: { rule_count: rules.length, cwd } });

		let result: RunnerResult;
		try {
			result = await runPiSubagent({ cwd, prompt, model: session.model, thinking: session.thinking, timeoutMs: DEFAULT_TRIGGER_RUN_TIMEOUT_MS, signal: ctrl.signal, piBin: this.piBin, sessionDir: this.jobStore.sessionDirFor("triggers"), env: { PI_LOOPS_TRACE_ID: trigger.traceId } });
		} catch (err: any) {
			result = { ok: false, exitCode: 1, timedOut: false, text: "", stderr: "", errorMessage: err?.message ?? String(err), usage: { input: 0, output: 0, cost: 0, turns: 0 } };
		} finally {
			this.running.delete(trigger.traceId);
		}
		this.jobStore.pruneSessions("triggers", 40);

		const summary = result.text.trim();
		const matchedIds = result.ok ? extractDynamicRuleIds(summary) : [];
		const matchedRules = rules.filter((r) => matchedIds.includes(r.id));
		if (matchedRules.length) await this.store.markFired(matchedRules.map((r) => r.id));
		const quiet = result.ok && matchedRules.length === 0;
		const state = ctrl.signal.aborted ? "aborted" : result.ok ? "completed" : "failed";
		this.store.appendAudit({
			type: "trigger_result",
			traceId: trigger.traceId,
			state,
			sourceLabel: trigger.sourceLabel,
			eventLabel: trigger.eventLabel,
			summary: result.ok ? summary || NO_MATCH_SENTINEL : result.errorMessage,
			details: { delivery: "sub_agent", matched_rule_ids: matchedIds, quiet, cost_usd: result.usage.cost, exit_code: result.exitCode, session_file: result.sessionFile },
		});

		let promoted = false;
		const promoteRules = matchedRules.filter((r) => r.promoteToChat);
		if (result.ok && promoteRules.length) {
			await this.hooks.onPromote?.(promotionBody(trigger, summary), trigger);
			promoted = true;
			this.store.appendAudit({ type: "trigger_promotion", traceId: trigger.traceId, state: "promoted", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary, details: { prefix_injected: true, rule_ids: promoteRules.map((r) => r.id) } });
		} else if (result.ok && matchedRules.length) {
			this.store.appendAudit({ type: "trigger_promotion", traceId: trigger.traceId, state: "skipped", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, details: { reason: "no matched rule has promote_to_chat" } });
		}
		if (trigger.sourceLabel === "local:dynamic") this.lastPoll = { at: new Date(this.now()).toISOString(), cwd, outcome: state === "completed" ? (quiet ? "no match" : `matched ${matchedRules.length}`) : state };
		const outcome: TriggerOutcome = { trigger, delivery: "sub_agent", ok: result.ok, matchedRules, summary, error: result.ok ? undefined : result.errorMessage, durationMs: this.now() - start, cost: result.usage.cost, promoted, sessionFile: result.sessionFile };
		this.hooks.onFinished?.(outcome);
		return outcome;
	}
}
