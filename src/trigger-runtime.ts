/**
 * The trigger runtime: takes Trigger envelopes from sources (the periodic dynamic
 * checker, MCP pushes), dedups them, runs the dynamic-rule sub-agent (or delivers a
 * notification straight into the chat), marks fire-once rules, promotes results
 * when asked, and keeps audit + running state for /triggers.
 */
import * as os from "node:os";
import * as path from "node:path";
import { type PresenceEntry, type PresenceSelf, chooseCwdOwner, isSelf } from "./presence.ts";
import { previewRedacted } from "./redact.ts";
import { type RunnerResult, type SubagentRunner, failedRun } from "./runner.ts";
import type { JobStore } from "./store.ts";
import {
	DEFAULT_TRIGGER_POLL_INTERVAL_SECS,
	DedupWindow,
	NO_MATCH_SENTINEL,
	PollLedger,
	type DynamicTriggerRule,
	type Trigger,
	TriggerStore,
	buildPeriodicCheckTrigger,
	extractDynamicRuleIds,
	renderDynamicTriggerPrompt,
 newTraceId } from "./triggers.ts";

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

/** Where a promotion / injection actually went: the chat of this process, or the inbox (wrong project here). */
export type PromoteTarget = "chat" | "inbox";

export interface TriggerRuntimeHooks {
	/** Insert text into the parent chat context (no model turn). Already carries the `[Trigger …]` prefix. Returns where it went. */
	onPromote?: (content: string, trigger: Trigger) => PromoteTarget | Promise<PromoteTarget>;
	/** Inject `prompt` into the parent chat and run one model turn. Returns where it went. */
	onInjectAndRun?: (prompt: string, trigger: Trigger) => PromoteTarget | Promise<PromoteTarget>;
	onStarted?: (running: RunningTrigger) => void;
	onFinished?: (outcome: TriggerOutcome) => void;
	log?: (message: string) => void;
}

export interface TriggerRuntimeOptions {
	store: TriggerStore;
	jobStore: JobStore;
	getSession: () => { sessionId?: string; cwd: string; model?: string; thinking?: string; trusted?: boolean };
	hooks?: TriggerRuntimeHooks;
	pollIntervalSecs?: number;
	/** Runs check/action sub-agents (in-process through pi's SDK in production; tests inject a fake). */
	runner: SubagentRunner;
	now?: () => number;
	/** Shared dedup file (`<dir>/dedup.json`); omit for an in-memory window. */
	dedupFile?: string;
	/** Trigger hop of this process (0 for the interactive pi); children get hop + 1. */
	hop?: number;
	/**
	 * Presence of every pi on the machine and this process's own identity. With both, a project's
	 * checks and push evaluations are run by a pi open in that project (preferring the session
	 * that created the rules); without them the machine leader does everything (tests).
	 */
	presence?: () => PresenceEntry[];
	self?: PresenceSelf;
	/** Whether this process is the machine leader right now (used outside tick(), e.g. for pushes). */
	isLeader?: () => boolean;
	/** Default cap on a check/action sub-agent (`[triggers] run_timeout_secs`); a rule's `timeoutMs` overrides it. */
	runTimeoutMs?: number;
}

export const DEFAULT_TRIGGER_RUN_TIMEOUT_MS = 15 * 60_000;

/** pie: the engine prefixes `[Trigger <trace>] ` and injects the text itself (summary or result), capped. */
export function promotionBody(trigger: Trigger, summary: string): string {
	return `[Trigger ${trigger.traceId}] ${previewRedacted(summary, 4096)}`;
}

export class TriggerRuntime {
	readonly store: TriggerStore;
	private readonly jobStore: JobStore;
	private readonly getSession: TriggerRuntimeOptions["getSession"];
	private readonly hooks: TriggerRuntimeHooks;
	private readonly runner: SubagentRunner;
	private readonly now: () => number;
	private readonly dedup: DedupWindow;
	/** Pushes that inject into this window are deduplicated here only: every window reacts, like pie's sessions. */
	private readonly localDedup = new DedupWindow();
	private readonly ledger: PollLedger;
	private readonly presence?: () => PresenceEntry[];
	private readonly self?: PresenceSelf;
	private readonly isLeader?: () => boolean;
	private readonly hop: number;
	/** Mutable so a config reload at session start takes effect. */
	runTimeoutMs: number;
	private readonly running = new Map<string, RunningTrigger>();
	pollIntervalSecs: number;
	lastCheckAt = 0;
	/** pie's TriggerPollStatus: bounded, display-only status of the latest periodic check. */
	lastPoll: { at: string; cwd: string; outcome: string; traceId: string; sourceLabel: string; eventLabel: string; summary: string } | undefined;
	dedupedCount = 0;
	cycleSuppressedCount = 0;

	constructor(opts: TriggerRuntimeOptions) {
		this.store = opts.store;
		this.jobStore = opts.jobStore;
		this.getSession = opts.getSession;
		this.hooks = opts.hooks ?? {};
		this.runner = opts.runner;
		this.now = opts.now ?? Date.now;
		this.pollIntervalSecs = opts.pollIntervalSecs ?? DEFAULT_TRIGGER_POLL_INTERVAL_SECS;
		this.dedup = new DedupWindow(undefined, opts.dedupFile);
		this.ledger = new PollLedger(opts.dedupFile ? path.join(path.dirname(opts.dedupFile), "polls.json") : undefined);
		this.presence = opts.presence;
		this.self = opts.self;
		this.isLeader = opts.isLeader;
		this.hop = opts.hop ?? 0;
		this.runTimeoutMs = opts.runTimeoutMs ?? DEFAULT_TRIGGER_RUN_TIMEOUT_MS;
		// Audit writes are best-effort (pie: PersistenceError never fails a trigger); say so once per distinct error.
		let lastReported: string | undefined;
		this.store.onPersistenceError ??= (message) => {
			if (message === lastReported) return;
			lastReported = message;
			this.log(message);
		};
	}

	/** The log hook is the UI's notifier in pi-loops; it must never turn into a rejection here. */
	private log(message: string): void {
		try {
			this.hooks.log?.(message);
		} catch {
			/* nothing left to report to */
		}
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
	 * Who acts for `cwd`: the pi open in that project (preferring the session that created its
	 * rules, lowest pid otherwise), so promotions land in the right chat like pie's session-scoped
	 * runtime; the machine leader only where no pi is open (results then go to the inbox).
	 */
	ownsCwd(cwd: string, rules: DynamicTriggerRule[], fallback: boolean): boolean {
		if (!this.self) return fallback;
		const owner = chooseCwdOwner(this.presence?.() ?? [], cwd, this.self.host, rules.map((r) => r.createdBy?.sessionId).filter((s): s is string => !!s));
		if (!owner) return fallback;
		return isSelf(owner, this.self);
	}

	/**
	 * Scheduler tick (every process): emit one periodic check per project that has enabled
	 * rules, run by that project's owner, at most once per poll interval machine-wide (shared
	 * ledger, so a hand-over between processes never double-checks).
	 */
	async tick(now: number, leader: boolean): Promise<void> {
		const host = this.self?.host ?? os.hostname();
		const rules = this.store.load().filter((r) => r.enabled && (!r.host || r.host === host));
		if (!rules.length) return;
		const byCwd = new Map<string, DynamicTriggerRule[]>();
		for (const r of rules) byCwd.set(r.cwd, [...(byCwd.get(r.cwd) ?? []), r]);
		for (const [cwd, group] of byCwd) {
			if (!this.ownsCwd(cwd, group, leader)) continue;
			if ([...this.running.values()].some((r) => r.cwd === cwd && r.sourceLabel === "local:dynamic")) continue; // previous check still active
			if (!(await this.ledger.claim(`${host}:${cwd}`, now, this.pollIntervalSecs * 1000))) continue;
			this.lastCheckAt = now;
			void this.handle(buildPeriodicCheckTrigger(cwd, group.length, new Date(now)), "sub_agent");
		}
	}

	/**
	 * Admit one trigger: dedup, audit, deliver. Resolves when the delivery has finished and
	 * never rejects: persistence or runner failures are audited (best effort) and logged.
	 */
	async handle(trigger: Trigger, delivery: TriggerDelivery): Promise<TriggerOutcome | undefined> {
		// pie: sub-agents register no notification hooks and run no dynamic checker, so only the
		// interactive process (hop 0) ever handles a trigger. Anything reaching a deeper hop is a
		// cycle and is suppressed, audited like pie's EvaluationOutcome::CycleSuppressed.
		if (this.hop > 0) {
			this.cycleSuppressedCount++;
			this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger", traceId: trigger.traceId, state: "cycle_suppressed", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { hop_count: this.hop, delivery } });
			this.log(`trigger ${trigger.traceId.slice(0, 8)} cycle_suppressed at hop ${this.hop} (${trigger.sourceLabel} / ${trigger.eventLabel})`);
			return undefined;
		}
		try {
			if (trigger.source.kind === "mcp" && delivery === "sub_agent" && !trigger.cwd && !this.getSession().cwd) {
				// No project of our own (the headless host): evaluate the push once per project that has
				// rules, each in that project, as tick() does — never all rules at once in $HOME.
				const host = this.self?.host ?? os.hostname();
				const cwds = [...new Set(this.store.load().filter((r) => r.enabled && (!r.host || r.host === host)).map((r) => r.cwd))];
				if (!cwds.length) return await this.admit(trigger, delivery); // audited as no_rules
				const outcomes = await Promise.all(cwds.map((cwd, i) => this.admit({ ...trigger, cwd, traceId: i ? newTraceId() : trigger.traceId }, delivery)));
				return outcomes.find(Boolean);
			}
			return await this.admit(trigger, delivery);
		} catch (err: any) {
			const message = err?.message ?? String(err);
			this.running.delete(trigger.traceId);
			this.log(`trigger ${trigger.traceId.slice(0, 8)} failed: ${message}`);
			this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger_result", traceId: trigger.traceId, state: "failed", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: message, details: { delivery, error: message } });
			return undefined;
		}
	}

	private async admit(trigger: Trigger, delivery: TriggerDelivery): Promise<TriggerOutcome | undefined> {
		let prev: Awaited<ReturnType<DedupWindow["check"]>>;
		if (trigger.source.kind === "mcp" && delivery === "sub_agent") {
			// A push evaluated against dynamic rules: once per project, by the project's owner
			// (pie: each session evaluates its own rules).
			const cwd = trigger.cwd ?? this.getSession().cwd;
			const rules = this.store.load().filter((r) => r.enabled && r.cwd === cwd);
			// No pi registered for this project (first tick not done, or a non-host process)? Then the
			// process that received the push handles it; nobody else will.
			if (!this.ownsCwd(cwd, rules, true)) {
				this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger", traceId: trigger.traceId, state: "deferred", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { delivery, reason: "another pi in this project owns rule evaluation" } });
				return undefined;
			}
			prev = await this.dedup.check(`${trigger.idempotencyKey}@${this.self?.host ?? os.hostname()}:${cwd}`, trigger.traceId, this.now(), trigger.replacementPolicy);
		} else if (trigger.source.kind === "mcp") {
			// A push injected into the chat: every window that has the server reacts (pie: every
			// session), so the dedup window is this process's own.
			prev = await this.localDedup.check(trigger.idempotencyKey, trigger.traceId, this.now(), trigger.replacementPolicy);
		} else {
			prev = await this.dedup.check(trigger.idempotencyKey, trigger.traceId, this.now(), trigger.replacementPolicy);
		}
		if (prev) {
			this.dedupedCount++;
			this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger", traceId: trigger.traceId, state: "deduped", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { previous_trace_id: prev.traceId, replacement_policy: prev.replacementPolicy ?? trigger.replacementPolicy } });
			return undefined;
		}
		this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger", traceId: trigger.traceId, state: "accepted", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { delivery, evaluator_decision: { outcome: "accept", permission: "allow" } } });
		if (delivery === "inject_summary") return this.deliverInjectSummary(trigger);
		if (delivery === "inject_and_run") return this.deliverInjectAndRun(trigger);
		return this.deliverSubAgent(trigger);
	}

	private async deliverInjectSummary(trigger: Trigger): Promise<TriggerOutcome> {
		const start = this.now();
		const summary = trigger.payloadSummary ?? "";
		let promoted = false;
		if (summary) {
			const target = (await this.hooks.onPromote?.(promotionBody(trigger, summary), trigger)) ?? "chat";
			promoted = target === "chat";
			this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger_promotion", traceId: trigger.traceId, state: target === "chat" ? "promoted" : "redirected", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary, details: { prefix_injected: true, delivery: "inject_summary", to: target } });
		}
		this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger_result", traceId: trigger.traceId, state: "completed", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary, details: { delivery: "inject_summary", cost_usd: 0 } });
		const outcome: TriggerOutcome = { trigger, delivery: "inject_summary", ok: true, matchedRules: [], summary, durationMs: this.now() - start, cost: 0, promoted };
		this.hooks.onFinished?.(outcome);
		return outcome;
	}

	private async deliverInjectAndRun(trigger: Trigger): Promise<TriggerOutcome> {
		const start = this.now();
		const prompt = `[Trigger ${trigger.traceId}] ${trigger.payloadSummary ?? `${trigger.sourceLabel} fired: ${trigger.eventLabel}`}`;
		const target = (await this.hooks.onInjectAndRun?.(prompt, trigger)) ?? "chat";
		this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger_result", traceId: trigger.traceId, state: "completed", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { delivery: "inject_and_run", prefix_injected: true, cost_usd: 0, to: target } });
		const outcome: TriggerOutcome = { trigger, delivery: "inject_and_run", ok: true, matchedRules: [], summary: trigger.payloadSummary ?? "", durationMs: this.now() - start, cost: 0, promoted: target === "chat" };
		this.hooks.onFinished?.(outcome);
		return outcome;
	}

	private async deliverSubAgent(trigger: Trigger): Promise<TriggerOutcome> {
		const start = this.now();
		const host = this.self?.host ?? os.hostname();
		const all = this.store.load().filter((r) => r.enabled && (!r.host || r.host === host));
		const rules = trigger.cwd ? all.filter((r) => r.cwd === trigger.cwd) : all;
		const session = this.getSession();
		const cwd = trigger.cwd ?? session.cwd;
		if (!rules.length) {
			this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger_result", traceId: trigger.traceId, state: "no_rules", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { delivery: "sub_agent" } });
			const outcome: TriggerOutcome = { trigger, delivery: "sub_agent", ok: true, matchedRules: [], summary: "no enabled dynamic trigger rules", durationMs: 0, cost: 0, promoted: false };
			this.hooks.onFinished?.(outcome);
			return outcome;
		}
		const prompt = renderDynamicTriggerPrompt(trigger, rules);
		const ctrl = new AbortController();
		const running: RunningTrigger = { traceId: trigger.traceId, sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, startedAt: new Date(start).toISOString(), promptPreview: previewRedacted(prompt, 80), cwd, ctrl }; // pie: preview_for_banner(action.prompt, 80)
		this.running.set(trigger.traceId, running);
		this.hooks.onStarted?.(running);
		this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger_result", traceId: trigger.traceId, state: "running", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, details: { rule_count: rules.length, cwd } });

		// The check runs with the model the rules were created under (first rule that recorded one),
		// not whatever the process that happens to own the timer is using.
		const model = rules.find((r) => r.model)?.model ?? session.model;
		const thinking = rules.find((r) => r.model)?.thinking ?? session.thinking;
		let result: RunnerResult;
		try {
			// A check runs every rule of the project, so the longest per-rule cap wins (pie: unbounded).
			const timeoutMs = rules.reduce((max, r) => Math.max(max, r.timeoutMs ?? 0), 0) || this.runTimeoutMs;
			result = await this.runner({ cwd, prompt, model, thinking, timeoutMs, signal: ctrl.signal, sessionDir: this.jobStore.sessionDirFor("triggers"), hop: this.hop + 1, parentSessionId: session.sessionId, parentCwd: session.cwd, kind: "trigger", traceId: trigger.traceId });
		} catch (err: any) {
			result = failedRun(err?.message ?? String(err));
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
			cwd,
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
			const target = (await this.hooks.onPromote?.(promotionBody(trigger, summary), trigger)) ?? "chat";
			promoted = target === "chat";
			this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger_promotion", traceId: trigger.traceId, state: target === "chat" ? "promoted" : "redirected", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary, details: { prefix_injected: true, rule_ids: promoteRules.map((r) => r.id), to: target } });
		} else if (result.ok && matchedRules.length) {
			this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger_promotion", traceId: trigger.traceId, state: "skipped", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, details: { reason: "no matched rule has promote_to_chat" } });
		}
		if (trigger.sourceLabel === "local:dynamic") this.lastPoll = { at: new Date(this.now()).toISOString(), cwd, outcome: state === "completed" ? (quiet ? "no match" : `matched ${matchedRules.length}`) : state, traceId: trigger.traceId, sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: previewRedacted(result.ok ? summary || NO_MATCH_SENTINEL : (result.errorMessage ?? ""), 160) };
		const outcome: TriggerOutcome = { trigger, delivery: "sub_agent", ok: result.ok, matchedRules, summary, error: result.ok ? undefined : result.errorMessage, durationMs: this.now() - start, cost: result.usage.cost, promoted, sessionFile: result.sessionFile };
		this.hooks.onFinished?.(outcome);
		return outcome;
	}
}
