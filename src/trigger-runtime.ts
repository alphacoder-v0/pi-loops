/**
 * The trigger runtime: takes Trigger envelopes from sources (the periodic dynamic
 * checker, MCP pushes), dedups them, runs the dynamic-rule sub-agent (or delivers a
 * notification straight into the chat), marks fire-once rules, promotes results
 * when asked, and keeps audit + running state for /triggers.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withinProject } from "./paths.ts";
import { previewRedacted } from "./redact.ts";
import type { SubagentRunner } from "./runner.ts";
import type { ResolvedCap } from "./ask.ts";
import { type SubagentSlot, SubagentSlots } from "./slots.ts";
import type { JobStore } from "./store.ts";
import type { Inbox } from "./inbox.ts";
import { type LaneId, checkLane } from "./lane.ts";
import { failurePause, FAILING_AFTER } from "./backoff.ts";
import { stamp } from "./schedule.ts";
import { type CommandGate, GATE_LOOK_EVERY_MS, type GatePolicy, type PathGate, type PathState, PathLooks, gateDecision, gateOf, lookCommand, pathReading } from "./gate.ts";
import type { GateClocks } from "./clock.ts";
import { EventLog } from "./events.ts";
import { clockStore } from "./stores.ts";
import {
	DEFAULT_TRIGGER_POLL_INTERVAL_SECS,
	DedupWindow,
	NO_MATCH_SENTINEL,
	PollLedger,
	type DynamicTriggerRule,
	type Trigger,
	TriggerStore,
	buildPeriodicCheckTrigger,
 newTraceId } from "./triggers.ts";
import { DEFAULT_TRIGGER_RUN_TIMEOUT_MS, type GateLet, type PromoteTarget, checkCap, envelopeOf, runCheck } from "./check-run.ts";

/** Bounded, display-only status of a periodic check. */
export type LastPoll = { at: string; cwd: string; outcome: string; traceId: string; sourceLabel: string; eventLabel: string; summary: string };

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
	/**
	 * Insert text into the parent chat context (no model turn). Already carries the `[Trigger …]` prefix.
	 * `forSession` is the conversation that created the promoting rules, when they agree on one. Returns where it went.
	 */
	onPromote?: (content: string, trigger: Trigger, forSession?: string) => PromoteTarget | Promise<PromoteTarget>;
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
	/** Default cap on a check/action sub-agent (`[triggers] run_timeout_secs`); a rule's `timeoutMs` overrides it. */
	runTimeoutMs?: number;
	/**
	 * Checks and actions in flight at once. Spawning every accepted trigger concurrently is
	 * bounded in practice by a person watching the feed; a headless host has nobody watching, and a
	 * server pushing distinct events would otherwise open one sub-agent per event. Only used to size
	 * a private counter when `slots` is absent.
	 */
	maxConcurrent?: number;
	/**
	 * The process-wide sub-agent admission counter, shared with the scheduler and the /goal evaluator
	 * (src/slots.ts). Omitted, the trigger runtime bounds only its own checks against `maxConcurrent`
	 * — which is the bug this exists to close, so production always passes one.
	 */
	slots?: SubagentSlots;
	/** Today's automation spend against `[limits] daily_budget_usd`, shared with the scheduler. */
	budget?: () => { spent: number; cap: number; over: boolean };
	/**
	 * Where a matched rule's result is filed, whatever `promote_to_chat` says (docs/triggers.md).
	 * Both processes pass the scheduler's inbox; omitted, a result is only audited.
	 */
	inbox?: Pick<Inbox, "appendOnce" | "pinnedTranscripts">;
	/** The `stat` a waiting rule's look uses; tests inject one that hangs. */
	stat?: (p: string) => Promise<unknown>;
	/** Where a gate reading that opens a check is stored before the check runs; omitted, `events.jsonl` beside the rules, written as a window. */
	events?: Pick<EventLog, "append">;
	/** Where a rule's gate readings are counted; omitted, `clock.json` beside the rules. */
	clock?: GateClocks;
	/** What a rule's command gate is judged by; omitted, the loops directory beside the rules with no allowlist. */
	gatePolicy?: () => GatePolicy;
}

export const DEFAULT_MAX_CONCURRENT_CHECKS = 3;

/** One gated rule's look this poll: whether it opens the check, the event that stored it, and what `seen` becomes when the check does not fail. */
interface RuleLook {
	decision: "wake" | "hold";
	state?: PathState;
	event?: string;
	seen?: { rule: string; digest: string; at: string };
}

/** The ticker's interval, which `tick` here runs on (src/ticker.ts, 30 s): no poll comes sooner. */
const POLL_TICK_MS = 30_000;

export class TriggerRuntime {
	readonly store: TriggerStore;
	private readonly jobStore: JobStore;
	private readonly getSession: TriggerRuntimeOptions["getSession"];
	private readonly hooks: TriggerRuntimeHooks;
	private readonly runner: SubagentRunner;
	private readonly now: () => number;
	private readonly dedup: DedupWindow;
	/** Pushes that inject into this window are deduplicated here only: every window reacts. */
	private readonly ledger: PollLedger;
	private readonly hop: number;
	/** Mutable so a config reload at session start takes effect. */
	runTimeoutMs: number;
	private readonly running = new Map<string, RunningTrigger>();
	/** Every sub-agent this process starts takes a slot from here, loop runs included. */
	readonly slots: SubagentSlots;
	private readonly budget: () => { spent: number; cap: number; over: boolean };
	private readonly inbox: Pick<Inbox, "appendOnce" | "pinnedTranscripts"> | undefined;
	pollIntervalSecs: number;
	lastCheckAt = 0;
	/** Bounded, display-only status of the latest periodic check. */
	lastPoll: LastPoll | undefined;
	/** The same, per project: the host checks every project's rules, and a window shows its own. */
	readonly lastPolls = new Map<string, LastPoll>();
	dedupedCount = 0;
	cycleSuppressedCount = 0;
	/** The `stat`s of rules that wait for a path (src/gate.ts): one in flight per rule. */
	private readonly looks: PathLooks;
	private readonly events: Pick<EventLog, "append">;
	/** Each gated rule's last reading and its look count (`clock.json`): the audit row is written on a change only. */
	private readonly clock: GateClocks;
	private readonly gatePolicy: () => GatePolicy;
	/**
	 * When this process last looked at each rule's command gate. `clock.json` holds the same time,
	 * but a read or a write of it can fail; the minute is kept whatever the file says (design 3.3).
	 */
	private readonly commandLooks = new Map<string, number>();

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
		this.hop = opts.hop ?? 0;
		this.runTimeoutMs = opts.runTimeoutMs ?? DEFAULT_TRIGGER_RUN_TIMEOUT_MS;
		this.slots = opts.slots ?? new SubagentSlots(opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_CHECKS);
		this.budget = opts.budget ?? (() => ({ spent: 0, cap: 0, over: false }));
		this.inbox = opts.inbox;
		this.looks = new PathLooks({ stat: opts.stat });
		this.events = opts.events ?? new EventLog(this.store.dir, "window");
		this.clock = opts.clock ?? clockStore(this.store.dir);
		this.gatePolicy = opts.gatePolicy ?? (() => ({ loopsDir: this.store.dir }));
		// Audit writes are best-effort — a failed write never fails a trigger; say so once per distinct error.
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

	/** Whether a check of the project whose check lane is `lane` runs now: an answer of that lane does not resume a transcript beside it. */
	checkRunningIn(lane: LaneId): boolean {
		return [...this.running.values()].some((r) => checkLane(r.cwd) === lane);
	}

	/** Pushes waiting for a free slot: work that is late, not work that was lost. */
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
	 * The enabled rules that govern `cwd`. A rule created at `~/proj` still governs a push received
	 * at `~/proj/src` or through a symlink to it: comparing the cwd strings silently diverted those
	 * promotions to the inbox.
	 */
	/** The cap of the check of project `cwd` as its enabled rules have it now: what an answer in its check lane runs under (`checkCap`). */
	checkCapOf(cwd: string): ResolvedCap {
		return checkCap(cwd, this.rulesFor(cwd), this.runTimeoutMs);
	}

	private rulesFor(cwd: string | undefined): DynamicTriggerRule[] {
		const all = this.store.load().filter((r) => r.enabled);
		return cwd ? all.filter((r) => withinProject(r.cwd, cwd)) : all;
	}

	/**
	 * Scheduler tick of the host, the one process that checks rules: one periodic check per project,
	 * at most once per poll interval.
	 *
	 * The poll ledger's keys are `<host>:<cwd>` for a project's unowned rules and
	 * `<host>:<cwd>#<session>` for the rules of one session: a project another process has just
	 * checked is skipped.
	 */
	async tick(now: number): Promise<void> {
		// Before raising new work: the pushes this process refused while it was busy.
		const host = os.hostname();
		const rules = this.store.load().filter((r) => r.enabled && !this.inBackoff(r, now));
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
			const interval = this.pollIntervalSecs * 1000;
			if (!(await this.ledger.claim(`${host}:${cwd}`, now, interval))) continue;
			const claimed: DynamicTriggerRule[] = [];
			const bySession = new Map<string, DynamicTriggerRule[]>();
			for (const r of group) {
				const sid = r.createdBy?.sessionId;
				if (sid) bySession.set(sid, [...(bySession.get(sid) ?? []), r]);
				else claimed.push(r);
			}
			for (const [sid, own] of bySession) {
				if (await this.ledger.claim(`${host}:${cwd}#${sid}`, now, interval)) claimed.push(...own);
			}
			if (!claimed.length) continue;
			this.lastCheckAt = now;
			// After the claim, so a rule that waits for a path is looked at once per poll, as a model
			// check would be. A path that is absent keeps its rule out of the prompt; an `unknown` look
			// (no permission, a hung mount) asks the model, as before there was a pre-check.
			const gated = await Promise.all(claimed.map((r) => this.lookGate(cwd, r, now)));
			const due = claimed.filter((_, i) => gated[i]?.decision !== "hold");
			if (!due.length) continue;
			const prechecked = claimed.filter((_, i) => gated[i]?.decision === "wake" && gated[i]?.state === "present").map((r) => r.id);
			const events = gated.flatMap((g) => (g?.event ? [g.event] : []));
			const seen = gated.flatMap((g) => (g?.seen ? [g.seen] : []));
			// `handle` is documented not to reject; the catch is what makes that true rather than
			// merely intended, since nothing above this would survive one.
			void this.handle(buildPeriodicCheckTrigger(cwd, due.length, new Date(now), String(process.pid)), "sub_agent", due, { ...(prechecked.length ? { prechecked } : {}), ...(events.length ? { events } : {}), ...(seen.length ? { seen } : {}) }).catch((err: any) =>
				this.log(`check failed: ${err?.message ?? err}`),
			);
		}
	}

	/**
	 * A gated rule's look, or undefined for a rule the model checks as it always did. A reading that
	 * opens the check is stored raw in `events.jsonl` first, and the check's `running` row names it; a
	 * reading that holds adds one to the rule's look count in `clock.json` and stores nothing. A
	 * reading that cannot be stored holds the rule until the next poll: nothing runs on a reading that
	 * is not stored.
	 *
	 * One `trigger` audit row on a change only: `waiting` at the first look and when the path goes
	 * away, `appeared` when it comes back. A rule whose path stays absent writes nothing more, which
	 * is the point: no `running` row and no model call either.
	 */
	private async lookGate(cwd: string, rule: DynamicTriggerRule, now: number): Promise<RuleLook | undefined> {
		const gate = gateOf(rule);
		if (!gate) return undefined;
		return gate.kind === "command" ? this.lookCommandGate(rule, gate, now) : this.lookPathGate(cwd, rule, gate, now);
	}

	/**
	 * A rule's command gate (from a proposal the person said yes to): run in the rule's project, at
	 * most once a minute, the policy first. A reading the last check that did not fail saw holds the
	 * rule; any other reading, and a look that failed, opens the check, stored first. A poll inside the
	 * minute holds the rule without a look and counts nothing.
	 */
	private async lookCommandGate(rule: DynamicTriggerRule, gate: CommandGate, now: number): Promise<RuleLook> {
		let before: ReturnType<GateClocks["readGate"]>;
		try {
			before = this.clock.readGate(rule.id);
		} catch (err: any) {
			this.log(`rule ${rule.id}: its gate state was not read: ${err?.message ?? err}`);
		}
		const last = Math.max(before?.last ? Date.parse(before.last.at) : -Infinity, this.commandLooks.get(rule.id) ?? -Infinity);
		if (now - last < GATE_LOOK_EVERY_MS) return { decision: "hold" };
		// Before the look, so no failure after it (the event, the look time) lets the next poll look again.
		this.commandLooks.set(rule.id, now);
		const reading = await lookCommand(gate.command, { cwd: rule.cwd, policy: this.gatePolicy() });
		const decision = gateDecision(before?.seen?.digest, reading.look);
		let event: { id: string; received_at: string } | undefined;
		if (decision === "wake") {
			try {
				event = this.events.append(`gate:${rule.id}`, reading.raw);
			} catch (err: any) {
				this.log(`rule ${rule.id}: its gate reading was not stored, so it is not checked this poll: ${err?.message ?? err}`);
				return { decision: "hold" };
			}
		}
		const at = stamp(now);
		try {
			this.clock.noteGate(rule.id, reading.look.kind === "command" ? { at, digest: reading.look.digest } : { at, failed: reading.look.kind === "failed" ? reading.look.why : "not a command reading" }, decision === "hold");
		} catch (err: any) {
			this.log(`rule ${rule.id}: its gate reading was not counted: ${err?.message ?? err}`);
		}
		if (reading.look.kind === "failed") this.log(`rule ${rule.id}: gate failing: ${reading.look.why}; the model checks the rule until it works`);
		return { decision, ...(event ? { event: event.id } : {}), ...(event && reading.look.kind === "command" ? { seen: { rule: rule.id, digest: reading.look.digest, at: event.received_at } } : {}) };
	}

	private async lookPathGate(cwd: string, rule: DynamicTriggerRule, gate: PathGate, now: number): Promise<RuleLook> {
		const state = await this.looks.look(rule.id, gate);
		const reading = pathReading(gate, state);
		const decision = gateDecision(undefined, reading.look);
		let event: string | undefined;
		if (decision === "wake") {
			try {
				event = this.events.append(`gate:${rule.id}`, reading.raw).id;
			} catch (err: any) {
				this.log(`rule ${rule.id}: its gate reading was not stored, so it is not checked this poll: ${err?.message ?? err}`);
				return { state, decision: "hold" };
			}
		}
		let before: PathState | undefined;
		try {
			before = this.clock.noteGate(rule.id, { at: stamp(now), state }, decision === "hold")?.last?.state;
		} catch (err: any) {
			this.log(`rule ${rule.id}: its gate reading was not counted: ${err?.message ?? err}`);
		}
		const row = (auditState: string, summary: string) =>
			this.store.appendAudit({ cwd, type: "trigger", traceId: newTraceId(), state: auditState, sourceLabel: "local:dynamic", eventLabel: rule.id, summary, details: { rule_id: rule.id, path: gate.raw, resolved: gate.resolved } });
		if (state === "absent" && before !== "absent") row("waiting", `no model call until ${gate.raw} exists`);
		else if (state === "present" && before === "absent") row("appeared", `${gate.raw} exists; the model checks the rule`);
		return { state, decision, ...(event ? { event } : {}) };
	}

	/**
	 * What the page's rule row says about a rule that waits for a path: its last look (`clock.json`),
	 * and when the next one is. Polls ride the scheduler's 30-second tick, so no look comes sooner than that.
	 */
	ruleLook(ruleId: string): { look: PathState; nextAt: number } | undefined {
		const last = this.clock.readGate(ruleId)?.last;
		return last?.state && { look: last.state, nextAt: Date.parse(last.at) + Math.max(this.pollIntervalSecs * 1000, POLL_TICK_MS) };
	}

	/**
	 * Admit one trigger: dedup, audit, deliver. Resolves when the delivery has finished and
	 * never rejects: persistence or runner failures are audited (best effort) and logged.
	 */
	async handle(trigger: Trigger, delivery: TriggerDelivery, rules?: DynamicTriggerRule[], opts?: GateLet): Promise<TriggerOutcome | undefined> {
		// Sub-agents register no notification hooks and run no dynamic checker, so only the
		// interactive process (hop 0) ever handles a trigger. Anything reaching a deeper hop is a
		// cycle and is suppressed, audited as cycle-suppressed.
		if (this.hop > 0) {
			this.cycleSuppressedCount++;
			this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger", traceId: trigger.traceId, state: "cycle_suppressed", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { hop_count: this.hop, delivery, ...envelopeOf(trigger) } });
			this.log(`trigger ${trigger.traceId.slice(0, 8)} cycle_suppressed at hop ${this.hop} (${trigger.sourceLabel} / ${trigger.eventLabel})`);
			return undefined;
		}
		try {
			return await this.admit(trigger, delivery, rules, opts);
		} catch (err: any) {
			const message = err?.message ?? String(err);
			this.running.delete(trigger.traceId);
			this.log(`trigger ${trigger.traceId.slice(0, 8)} failed: ${message}`);
			this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger_result", traceId: trigger.traceId, state: "failed", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: message, details: { delivery, error: message, ...envelopeOf(trigger) } });
			return undefined;
		}
	}

	private async admit(trigger: Trigger, delivery: TriggerDelivery, rules?: DynamicTriggerRule[], opts?: GateLet): Promise<TriggerOutcome | undefined> {
		// A sub-agent costs money and a process slot. Both bounds are checked before the dedup claim,
		// so a refused trigger is never marked handled — a periodic check is simply raised again by the
		// next poll, and a push (an event that happened once, which no server repeats) is held below.
		// `inject_summary` puts the push's own text into the chat and runs no model call — its audit
		// row records `cost_usd: 0`. Refusing a free delivery for want of budget is backwards, and
		// the day the cap trips is the day you still want to be told what is arriving.
		const gate = this.budget();
		if (gate.over) {
			// Not held: being too busy clears in minutes, but the daily cap can last until midnight,
			// and acting on this morning's deploy event at 23:59 is worse than not acting at all.
			this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger", traceId: trigger.traceId, state: "budget_exceeded", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { ...envelopeOf(trigger), delivery, spent_usd: gate.spent, cap_usd: gate.cap } });
			this.log(`trigger ${trigger.traceId.slice(0, 8)} not run: today's automation has cost $${gate.spent.toFixed(2)} of the $${gate.cap.toFixed(2)} budget`);
			return undefined;
		}
		// The counter is shared with loop runs and the /goal evaluator (src/slots.ts): the cap is on
		// sub-agents, not on checks, so a machine full of loop runs refuses a check too. The slot is
		// reserved here, before the dedup claim below, so the claim cannot outlive its admission.
		let slot: SubagentSlot | undefined;
		if (delivery === "sub_agent") {
			slot = this.slots.acquire();
			if (!slot) {
				// Not re-queued: the next poll evaluates every rule against the world as it is then, so a
				// held check could only run the same check twice. A push waits as a row (src/push.ts).
				const { inUseCount, limit } = this.slots;
				this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger", traceId: trigger.traceId, state: "deferred", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { ...envelopeOf(trigger), delivery, reason: `${inUseCount} sub-agent(s) already in flight (max ${limit})` } });
				this.log(`trigger ${trigger.traceId.slice(0, 8)} deferred: ${inUseCount} sub-agent(s) already in flight`);
				return undefined;
			}
		}
		try {
			const prev = await this.dedup.check(trigger.idempotencyKey, trigger.traceId, this.now(), trigger.replacementPolicy);
			if (prev) {
				this.dedupedCount++;
				this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger", traceId: trigger.traceId, state: "deduped", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { previous_trace_id: prev.traceId, ...envelopeOf(trigger), replacement_policy: prev.replacementPolicy ?? trigger.replacementPolicy } });
				// `[trigger deduped]` is a feed line; here the only trace was an audit row, so
				// "my webhook fired and nothing happened" had no answer short of reading the JSONL.
				this.log(`trigger ${trigger.traceId.slice(0, 8)} deduped (${trigger.sourceLabel} / ${trigger.eventLabel}): an identical event arrived within the dedup window`);
				return undefined;
			}
			this.store.appendAudit({ cwd: trigger.cwd ?? this.getSession().cwd, type: "trigger", traceId: trigger.traceId, state: "accepted", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { delivery, evaluator_decision: { outcome: "accept", permission: "allow" }, ...envelopeOf(trigger) } });
			// `return await`, not `return`: a bare return inside a try/finally hands the promise back and
			// runs the finally at once, which would release the slot the moment the sub-agent started.
			return await this.deliverSubAgent(trigger, rules, opts);
		} finally {
			// Held for the whole delivery, `deliverSubAgent` included, and released on every path out of
			// it — a torn dedup file, a runner that rejects, an abort — or the pool leaks a slot.
			slot?.release();
		}
	}

	/**
	 * Whether `rule`'s next poll is still inside its failure backoff. A check that has failed three
	 * times in a row is failing for a reason the next poll will not fix, and every attempt bills a
	 * sub-agent; pushes still reach the rule, because an event is worth one attempt. The wait is in
	 * `src/backoff.ts`.
	 */
	private inBackoff(rule: DynamicTriggerRule, now: number): boolean {
		const failures = rule.consecutiveFailures ?? 0;
		if (failures < FAILING_AFTER || !rule.lastCheckFailedAt) return false;
		const wait = failurePause(failures);
		return now - Date.parse(rule.lastCheckFailedAt) < wait;
	}

	/** Record a check's outcome on the rules it evaluated, and say in the audit when that starts holding a poll back. */
	private async recordCheckOutcome(rules: DynamicTriggerRule[], ok: boolean, cwd: string): Promise<void> {
		const ids = rules.map((r) => r.id);
		if (ok && !rules.some((r) => r.consecutiveFailures)) return; // nothing to clear: no lock, no write
		const nowIso = stamp(this.now());
		const failed = await this.store.mutate((all) => {
			const out: DynamicTriggerRule[] = [];
			for (const rule of all) {
				if (!ids.includes(rule.id)) continue;
				if (ok) {
					rule.consecutiveFailures = undefined;
					rule.lastCheckFailedAt = undefined;
					continue;
				}
				rule.consecutiveFailures = (rule.consecutiveFailures ?? 0) + 1;
				rule.lastCheckFailedAt = nowIso;
				out.push(rule);
			}
			return out;
		});
		const backing = failed.filter((r) => (r.consecutiveFailures ?? 0) >= FAILING_AFTER);
		if (!backing.length) return;
		const worst = Math.max(...backing.map((r) => r.consecutiveFailures ?? 0));
		this.store.appendAudit({ cwd, type: "trigger", traceId: newTraceId(), state: "backoff", sourceLabel: "local:dynamic", eventLabel: backing.map((r) => r.id).join(" "), summary: `${backing.length} rule(s) checked with a widening gap after ${worst} failed check(s) in a row`, details: { rule_ids: backing.map((r) => r.id), consecutive_failures: worst } });
		this.log(`${backing.length} trigger rule(s) failed ${worst} checks in a row; polling them with a widening gap`);
	}

	/**
	 * The project an audit row of this trigger belongs to. Resolved once per delivery: a check takes
	 * minutes, and the session's cwd can move under it (`/resume`, a project switch), which used to
	 * split one trace across two projects in `/triggers audit`.
	 */
	private cwdOf(trigger: Trigger): string {
		return trigger.cwd ?? this.getSession().cwd;
	}

	private async deliverSubAgent(trigger: Trigger, evaluate?: DynamicTriggerRule[], gates?: GateLet): Promise<TriggerOutcome> {
		const start = this.now();
		const session = this.getSession();
		const cwd = this.cwdOf(trigger);
		// `evaluate` is what the caller already resolved (the tick's claimed rules, a taken-over
		// push); otherwise this is a direct handle() and we take the rules of this project we own.
		const rules = evaluate ?? this.rulesFor(trigger.cwd);
		const ctrl = new AbortController();
		let check: Awaited<ReturnType<typeof runCheck>>;
		try {
			check = await runCheck(
				{
					runner: this.runner,
					rules: this.store,
					jobs: this.jobStore,
					inbox: this.inbox,
					clock: this.clock,
					// The hook is handed the trigger as it arrived, as it always was.
					promote: async (content, _withCwd, forSession) => (await this.hooks.onPromote?.(content, trigger, forSession)) ?? "chat",
					session,
					hop: this.hop,
					runTimeoutMs: this.runTimeoutMs,
					log: (message) => this.log(message),
					now: this.now,
				},
				{
					trigger: { ...trigger, cwd },
					rules,
					gates,
					signal: ctrl.signal,
					run: { id: trigger.traceId, cause: trigger.source.kind === "mcp" ? "push" : "check" },
					onStarted: (promptPreview) => {
						const running: RunningTrigger = { traceId: trigger.traceId, sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, startedAt: stamp(start), promptPreview, cwd, ctrl };
						this.running.set(trigger.traceId, running);
						this.hooks.onStarted?.(running);
					},
				},
			);
		} finally {
			this.running.delete(trigger.traceId);
		}
		if (check.state === "no_rules") {
			const outcome: TriggerOutcome = { trigger, delivery: "sub_agent", ok: true, matchedRules: [], summary: check.summary, durationMs: 0, cost: 0, promoted: false };
			this.hooks.onFinished?.(outcome);
			return outcome;
		}
		// An abort is the user's decision about this run, not evidence that the rule's check is broken,
		// so it neither counts against the rule nor clears what earlier failures recorded.
		if (check.state !== "aborted") await this.recordCheckOutcome(rules, check.ok, cwd);
		if (trigger.sourceLabel === "local:dynamic") {
			const quiet = check.ok && check.matchedRules.length === 0;
			this.lastPoll = { at: stamp(this.now()), cwd, outcome: check.state === "completed" ? (quiet ? "no match" : `matched ${check.matchedRules.length}`) : check.state, traceId: trigger.traceId, sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: previewRedacted(check.ok ? check.summary || NO_MATCH_SENTINEL : (check.error ?? ""), 160) };
			this.lastPolls.set(cwd, this.lastPoll);
		}
		const outcome: TriggerOutcome = { trigger, delivery: "sub_agent", ok: check.ok, matchedRules: [...check.matchedRules], summary: check.summary, error: check.error, durationMs: this.now() - start, cost: check.cost, promoted: check.promoted, sessionFile: check.sessionFile };
		this.hooks.onFinished?.(outcome);
		return outcome;
	}
}
