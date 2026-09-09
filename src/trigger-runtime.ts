/**
 * The trigger runtime: takes Trigger envelopes from sources (the periodic dynamic
 * checker, MCP pushes), dedups them, runs the dynamic-rule sub-agent (or delivers a
 * notification straight into the chat), marks fire-once rules, promotes results
 * when asked, and keeps audit + running state for /triggers.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type PresenceEntry, type PresenceSelf, chooseRuleOwner, isSelf, realProjectPath, withinProject } from "./presence.ts";
import { capRedacted, previewRedacted } from "./redact.ts";
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
	/** How long a push deferred to another process waits for that process to claim it (see `admit`). */
	deferredTakeoverMs?: number;
	/**
	 * Checks and actions in flight at once. pie spawns every accepted trigger concurrently, which is
	 * bounded in practice by a person watching the feed; a headless host has nobody watching, and a
	 * server pushing distinct events would otherwise open one sub-agent per event.
	 */
	maxConcurrent?: number;
	/** Today's automation spend against `[limits] daily_budget_usd`, shared with the scheduler. */
	budget?: () => { spent: number; cap: number; over: boolean };
}

export const DEFAULT_MAX_CONCURRENT_CHECKS = 3;

/**
 * Transcripts are kept per project, not in one directory for the machine: a shared budget meant
 * three projects polling every ten minutes exhausted it within hours, taking the evidence for
 * "why did this rule not match?" with them.
 */
function triggerSessionKey(cwd: string): string {
	return `triggers-${path.basename(cwd || "unknown").replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

export const DEFAULT_TRIGGER_RUN_TIMEOUT_MS = 15 * 60_000;
/**
 * A push handed to the presence-chosen owner is only really handled if that process has the MCP
 * server connected — it authenticates per process, so it may not. The receiving process waits this
 * long for the owner to claim the machine-wide dedup key and takes the push back if it does not.
 */
export const DEFAULT_DEFERRED_TAKEOVER_MS = 5_000;

/** pie: the engine prefixes `[Trigger <trace>] ` and injects the payload summary itself, capped. */
export function promotionBody(trigger: Trigger, summary: string): string {
	// Capped, never reflowed: a promoted result is often a file, a diff or test output, and pie
	// embeds it verbatim (agent_harness.rs:2945 + a char-boundary truncate).
	return `[Trigger ${trigger.traceId}] ${capRedacted(summary, 4096)}`;
}

/**
 * A sub-agent result promoted into the chat. pie renders it through
 * DEFAULT_PROMOTE_SUMMARY_TEMPLATE (agent_harness.rs:2945) — `<source> fired <event>.\nResult: …`
 * — so the chat says what fired and not only what came back; the rendered body is then capped
 * (PROMOTION_BODY_CAP_BYTES).
 */
export function promotionSummaryBody(trigger: Trigger, summary: string): string {
	return capRedacted(`[Trigger ${trigger.traceId}] ${trigger.sourceLabel} fired ${trigger.eventLabel}.\nResult: ${summary}`, 4096);
}

/**
 * The envelope fields pie's `TriggerRecord` persists on *every* state
 * (crates/agent/src/harness/trigger.rs:229-260), carried on every audit row here for the same
 * reason: without the idempotency key "which pushes collapsed into which" cannot be answered
 * afterwards. Bounded and redacted — a key is caller-supplied text.
 */
function envelopeOf(trigger: Trigger): Record<string, unknown> {
	return { idempotency_key: capRedacted(trigger.idempotencyKey, 256), replacement_policy: trigger.replacementPolicy, received_at: trigger.receivedAt };
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
	private readonly deferredTakeoverMs: number;
	private readonly running = new Map<string, RunningTrigger>();
	private readonly maxConcurrent: number;
	private readonly budget: () => { spent: number; cap: number; over: boolean };
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
		this.deferredTakeoverMs = opts.deferredTakeoverMs ?? DEFAULT_DEFERRED_TAKEOVER_MS;
		this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_CHECKS;
		this.budget = opts.budget ?? (() => ({ spent: 0, cap: 0, over: false }));
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

	/** The process that must evaluate `rule`; `undefined` when nobody owns it and the leader steps in. */
	private ownerOf(rule: DynamicTriggerRule): PresenceEntry | undefined {
		if (!this.self) return undefined;
		return chooseRuleOwner(this.presence?.() ?? [], rule.cwd, this.self.host, rule.createdBy?.sessionId);
	}

	/**
	 * Whether this process evaluates `rule`. A rule belongs to the session that created it, not to
	 * its directory — pie keeps the registry in that session's own sidecar (session/mod.rs:26) — so
	 * two pi windows in one repo each check their own rules and a result can only be promoted into
	 * the chat that asked for it. `fallback` decides the rules whose creating session has closed and
	 * whose project has no pi open (the machine leader covers those, into the inbox).
	 */
	ownsRule(rule: DynamicTriggerRule, fallback: boolean): boolean {
		if (!this.self) return fallback;
		const owner = this.ownerOf(rule);
		return owner ? isSelf(owner, this.self) : fallback;
	}

	/**
	 * The slot a rule's work occupies machine-wide (poll ledger, push dedup): its creating session
	 * while that session is open — nobody else may take it — else the project's shared slot, so a
	 * hand-over between processes still never double-checks.
	 */
	private slotOf(rule: DynamicTriggerRule): string {
		const sid = rule.createdBy?.sessionId;
		return sid && this.ownerOf(rule)?.sessionId === sid ? sid : "";
	}

	/**
	 * This host's enabled rules that govern `cwd`, split into the ones this process owns. A rule
	 * created at `~/proj` still governs a pi opened at `~/proj/src` or through a symlink to it:
	 * comparing the cwd strings silently diverted those promotions to the inbox.
	 */
	private rulesFor(cwd: string | undefined, fallback: boolean): { applicable: DynamicTriggerRule[]; owned: DynamicTriggerRule[] } {
		const host = this.self?.host ?? os.hostname();
		const all = this.store.load().filter((r) => r.enabled && (!r.host || r.host === host));
		const applicable = cwd ? all.filter((r) => withinProject(r.cwd, cwd)) : all;
		return { applicable, owned: applicable.filter((r) => this.ownsRule(r, fallback)) };
	}

	/**
	 * Scheduler tick (every process): emit one periodic check per project whose rules this process
	 * owns, at most once per poll interval machine-wide. The ledger is claimed per ownership slot,
	 * not per project, so two windows in one repo each check their own rules once per interval while
	 * a hand-over of the project's own rules still never double-checks.
	 */
	async tick(now: number, leader: boolean): Promise<void> {
		const host = this.self?.host ?? os.hostname();
		const rules = this.store.load().filter((r) => r.enabled && (!r.host || r.host === host) && this.ownsRule(r, leader));
		if (!rules.length) return;
		const byCwd = new Map<string, DynamicTriggerRule[]>();
		for (const r of rules) byCwd.set(r.cwd, [...(byCwd.get(r.cwd) ?? []), r]);
		for (const [cwd, group] of byCwd) {
			// A checkout that is gone cannot be checked. The scheduler disables such a cron job with
			// an actionable message; without the same guard here the rules poll — and bill — forever.
			if (cwd && !fs.existsSync(cwd)) {
				for (const rule of group) {
					await this.store.setEnabled(rule.id, false).catch(() => undefined);
					this.store.appendAudit({ cwd, type: "trigger", traceId: newTraceId(), state: "disabled", sourceLabel: "local:dynamic", eventLabel: rule.id, summary: `cwd ${cwd} no longer exists`, details: { reason: "cwd missing" } });
				}
				this.log(`disabled ${group.length} rule(s): cwd ${cwd} no longer exists (re-enable after restoring it)`);
				continue;
			}
			if ([...this.running.values()].some((r) => r.cwd === cwd && r.sourceLabel === "local:dynamic")) continue; // previous check still active
			const bySlot = new Map<string, DynamicTriggerRule[]>();
			for (const r of group) {
				const slot = this.slotOf(r);
				bySlot.set(slot, [...(bySlot.get(slot) ?? []), r]);
			}
			const claimed: DynamicTriggerRule[] = [];
			for (const [slot, owned] of bySlot) {
				if (await this.ledger.claim(`${host}:${cwd}${slot ? `#${slot}` : ""}`, now, this.pollIntervalSecs * 1000)) claimed.push(...owned);
			}
			if (!claimed.length) continue;
			this.lastCheckAt = now;
			void this.handle(buildPeriodicCheckTrigger(cwd, claimed.length, new Date(now), this.self ? `${this.self.pid}-${this.self.instance}` : ""), "sub_agent", claimed);
		}
	}

	/**
	 * Admit one trigger: dedup, audit, deliver. Resolves when the delivery has finished and
	 * never rejects: persistence or runner failures are audited (best effort) and logged.
	 */
	async handle(trigger: Trigger, delivery: TriggerDelivery, rules?: DynamicTriggerRule[]): Promise<TriggerOutcome | undefined> {
		// pie: sub-agents register no notification hooks and run no dynamic checker, so only the
		// interactive process (hop 0) ever handles a trigger. Anything reaching a deeper hop is a
		// cycle and is suppressed, audited like pie's EvaluationOutcome::CycleSuppressed.
		if (this.hop > 0) {
			this.cycleSuppressedCount++;
			this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger", traceId: trigger.traceId, state: "cycle_suppressed", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { hop_count: this.hop, delivery, ...envelopeOf(trigger) } });
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
			return await this.admit(trigger, delivery, rules);
		} catch (err: any) {
			const message = err?.message ?? String(err);
			this.running.delete(trigger.traceId);
			this.log(`trigger ${trigger.traceId.slice(0, 8)} failed: ${message}`);
			this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger_result", traceId: trigger.traceId, state: "failed", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: message, details: { delivery, error: message, ...envelopeOf(trigger) } });
			return undefined;
		}
	}

	private async admit(trigger: Trigger, delivery: TriggerDelivery, rules?: DynamicTriggerRule[]): Promise<TriggerOutcome | undefined> {
		// A sub-agent costs money and a process slot. Both bounds are checked before the dedup claim,
		// so a refused push can be retried by whoever sends it next rather than being marked handled.
		const budget = this.budget();
		if (budget.over) {
			this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger", traceId: trigger.traceId, state: "budget_exceeded", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { ...envelopeOf(trigger), delivery, spent_usd: budget.spent, cap_usd: budget.cap } });
			this.log(`trigger ${trigger.traceId.slice(0, 8)} not run: today's automation has cost $${budget.spent.toFixed(2)} of the $${budget.cap.toFixed(2)} budget`);
			return undefined;
		}
		if (delivery === "sub_agent" && this.running.size >= this.maxConcurrent) {
			this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger", traceId: trigger.traceId, state: "deferred", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { ...envelopeOf(trigger), delivery, reason: `${this.running.size} checks already running (max ${this.maxConcurrent})` } });
			this.log(`trigger ${trigger.traceId.slice(0, 8)} deferred: ${this.running.size} checks already running`);
			return undefined;
		}
		let prev: Awaited<ReturnType<DedupWindow["check"]>>;
		if (trigger.source.kind === "mcp" && delivery === "sub_agent") {
			// A push evaluated against dynamic rules: by the process that owns them (pie: each session
			// evaluates its own registry), and once per ownership slot machine-wide.
			const cwd = trigger.cwd ?? this.getSession().cwd;
			const scope = this.rulesFor(cwd, this.isLeader?.() ?? true);
			rules = scope.owned;
			if (scope.applicable.length && !scope.owned.length) {
				// The owner may not have this MCP server connected at all — servers authenticate per
				// process — and a push nobody handles is simply lost. Record the hand-off, then take the
				// push back if the owner has not claimed the slot below inside the takeover window; the
				// claim is machine-wide, so at most one process ever evaluates it.
				this.store.appendAudit({ cwd, type: "trigger", traceId: trigger.traceId, state: "deferred", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { delivery, reason: "another pi in this project owns rule evaluation", takeover_after_ms: this.deferredTakeoverMs, ...envelopeOf(trigger) } });
				await new Promise((r) => setTimeout(r, this.deferredTakeoverMs));
				rules = scope.applicable;
			}
			prev = await this.dedup.check(this.pushClaimKey(trigger, cwd, rules), trigger.traceId, this.now(), trigger.replacementPolicy);
			if (!prev && !scope.owned.length && scope.applicable.length) {
				this.store.appendAudit({ cwd, type: "trigger", traceId: trigger.traceId, state: "taken_over", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { delivery, reason: "the owning pi did not claim the push", ...envelopeOf(trigger) } });
			}
		} else if (trigger.source.kind === "mcp") {
			// A push injected into the chat: every window that has the server reacts (pie: every
			// session), so the dedup window is this process's own.
			prev = await this.localDedup.check(trigger.idempotencyKey, trigger.traceId, this.now(), trigger.replacementPolicy);
		} else {
			prev = await this.dedup.check(trigger.idempotencyKey, trigger.traceId, this.now(), trigger.replacementPolicy);
		}
		if (prev) {
			this.dedupedCount++;
			this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger", traceId: trigger.traceId, state: "deduped", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { previous_trace_id: prev.traceId, ...envelopeOf(trigger), replacement_policy: prev.replacementPolicy ?? trigger.replacementPolicy } });
			// pie renders `[trigger deduped]` as a feed line; here the only trace was an audit row, so
			// "my webhook fired and nothing happened" had no answer short of reading the JSONL.
			this.log(`trigger ${trigger.traceId.slice(0, 8)} deduped (${trigger.sourceLabel} / ${trigger.eventLabel}): an identical event arrived within the dedup window`);
			return undefined;
		}
		this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger", traceId: trigger.traceId, state: "accepted", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { delivery, evaluator_decision: { outcome: "accept", permission: "allow" }, ...envelopeOf(trigger) } });
		if (delivery === "inject_summary") return this.deliverInjectSummary(trigger);
		if (delivery === "inject_and_run") return this.deliverInjectAndRun(trigger);
		return this.deliverSubAgent(trigger, rules);
	}

	/**
	 * The machine-wide claim a pushed evaluation takes. Keyed by the project (realpath, so two
	 * windows reaching it by different paths agree) and by the ownership slots of the rules being
	 * evaluated, so windows checking *different* rules of one project both react while a deferred
	 * push and its owner still contend for the same key.
	 */
	private pushClaimKey(trigger: Trigger, cwd: string, rules: DynamicTriggerRule[]): string {
		const slots = [...new Set(rules.map((r) => this.slotOf(r)))].sort().join(",");
		return `${trigger.idempotencyKey}@${this.self?.host ?? os.hostname()}:${realProjectPath(cwd)}${slots ? `#${slots}` : ""}`;
	}

	private async deliverInjectSummary(trigger: Trigger): Promise<TriggerOutcome> {
		const start = this.now();
		const summary = trigger.payloadSummary ?? "";
		let promoted = false;
		if (summary) {
			const target = (await this.hooks.onPromote?.(promotionBody(trigger, summary), trigger)) ?? "chat";
			promoted = target === "chat";
			this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger_promotion", traceId: trigger.traceId, state: target === "chat" ? "promoted" : "redirected", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary, details: { prefix_injected: true, delivery: "inject_summary", to: target, ...envelopeOf(trigger) } });
		}
		this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger_result", traceId: trigger.traceId, state: "completed", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary, details: { delivery: "inject_summary", cost_usd: 0, ...envelopeOf(trigger) } });
		const outcome: TriggerOutcome = { trigger, delivery: "inject_summary", ok: true, matchedRules: [], summary, durationMs: this.now() - start, cost: 0, promoted };
		this.hooks.onFinished?.(outcome);
		return outcome;
	}

	private async deliverInjectAndRun(trigger: Trigger): Promise<TriggerOutcome> {
		const start = this.now();
		const prompt = `[Trigger ${trigger.traceId}] ${trigger.payloadSummary ?? `${trigger.sourceLabel} fired: ${trigger.eventLabel}`}`;
		const target = (await this.hooks.onInjectAndRun?.(prompt, trigger)) ?? "chat";
		this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger_result", traceId: trigger.traceId, state: "completed", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { delivery: "inject_and_run", prefix_injected: true, cost_usd: 0, to: target, ...envelopeOf(trigger) } });
		const outcome: TriggerOutcome = { trigger, delivery: "inject_and_run", ok: true, matchedRules: [], summary: trigger.payloadSummary ?? "", durationMs: this.now() - start, cost: 0, promoted: target === "chat" };
		this.hooks.onFinished?.(outcome);
		return outcome;
	}

	private async deliverSubAgent(trigger: Trigger, evaluate?: DynamicTriggerRule[]): Promise<TriggerOutcome> {
		const start = this.now();
		const session = this.getSession();
		const cwd = trigger.cwd ?? session.cwd;
		// `evaluate` is what the caller already resolved (the tick's claimed rules, a taken-over
		// push); otherwise this is a direct handle() and we take the rules of this project we own.
		const rules = evaluate ?? this.rulesFor(trigger.cwd, this.isLeader?.() ?? true).owned;
		if (!rules.length) {
			this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger_result", traceId: trigger.traceId, state: "no_rules", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { delivery: "sub_agent", ...envelopeOf(trigger) } });
			const outcome: TriggerOutcome = { trigger, delivery: "sub_agent", ok: true, matchedRules: [], summary: "no enabled dynamic trigger rules", durationMs: 0, cost: 0, promoted: false };
			this.hooks.onFinished?.(outcome);
			return outcome;
		}
		const prompt = renderDynamicTriggerPrompt(trigger, rules);
		const ctrl = new AbortController();
		const running: RunningTrigger = { traceId: trigger.traceId, sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, startedAt: new Date(start).toISOString(), promptPreview: previewRedacted(prompt, 80), cwd, ctrl }; // pie: preview_for_banner(action.prompt, 80)
		this.running.set(trigger.traceId, running);
		this.hooks.onStarted?.(running);
		this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger_result", traceId: trigger.traceId, state: "running", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, details: { rule_count: rules.length, cwd, ...envelopeOf(trigger) } });

		// The check runs with the model the rules were created under (first rule that recorded one),
		// not whatever the process that happens to own the timer is using.
		const model = rules.find((r) => r.model)?.model ?? session.model;
		const thinking = rules.find((r) => r.model)?.thinking ?? session.thinking;
		let result: RunnerResult;
		try {
			// A check runs every rule of the project, so the longest per-rule cap wins (pie: unbounded).
			const timeoutMs = rules.reduce((max, r) => Math.max(max, r.timeoutMs ?? 0), 0) || this.runTimeoutMs;
			result = await this.runner({ cwd, prompt, model, thinking, timeoutMs, signal: ctrl.signal, sessionDir: this.jobStore.sessionDirFor(triggerSessionKey(cwd)), hop: this.hop + 1, parentSessionId: session.sessionId, parentCwd: session.cwd, kind: "trigger", traceId: trigger.traceId });
		} catch (err: any) {
			result = failedRun(err?.message ?? String(err));
		} finally {
			this.running.delete(trigger.traceId);
		}
		// Per project, not one budget for the machine: three projects polling every ten minutes used
		// to exhaust a shared 40 within a couple of hours, taking the evidence with them.
		this.jobStore.pruneSessions(`triggers/${path.basename(cwd || "unknown")}`, 20);

		const summary = result.text.trim();
		// A check killed by the run timeout (or aborted) has usually already *executed* the matching
		// rule's action — posting the comment, kicking the deploy — so the matched ids in whatever it
		// managed to say still have to disarm a fire-once rule; otherwise the next poll does it again.
		const matchedIds = extractDynamicRuleIds(summary);
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
			details: { delivery: "sub_agent", matched_rule_ids: matchedIds, quiet, cost_usd: result.usage.cost, exit_code: result.exitCode, session_file: result.sessionFile, ...envelopeOf(trigger) },
		});

		let promoted = false;
		const promoteRules = matchedRules.filter((r) => r.promoteToChat);
		if (result.ok && promoteRules.length) {
			const target = (await this.hooks.onPromote?.(promotionSummaryBody(trigger, summary), trigger)) ?? "chat";
			promoted = target === "chat";
			this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger_promotion", traceId: trigger.traceId, state: target === "chat" ? "promoted" : "redirected", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary, details: { prefix_injected: true, rule_ids: promoteRules.map((r) => r.id), to: target, template_name: "default", ...envelopeOf(trigger) } });
		} else if (result.ok && matchedRules.length) {
			this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger_promotion", traceId: trigger.traceId, state: "skipped", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, details: { reason: "no matched rule has promote_to_chat", ...envelopeOf(trigger) } });
		}
		if (trigger.sourceLabel === "local:dynamic") this.lastPoll = { at: new Date(this.now()).toISOString(), cwd, outcome: state === "completed" ? (quiet ? "no match" : `matched ${matchedRules.length}`) : state, traceId: trigger.traceId, sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: previewRedacted(result.ok ? summary || NO_MATCH_SENTINEL : (result.errorMessage ?? ""), 160) };
		const outcome: TriggerOutcome = { trigger, delivery: "sub_agent", ok: result.ok, matchedRules, summary, error: result.ok ? undefined : result.errorMessage, durationMs: this.now() - start, cost: result.usage.cost, promoted, sessionFile: result.sessionFile };
		this.hooks.onFinished?.(outcome);
		return outcome;
	}
}
