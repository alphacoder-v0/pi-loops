/**
 * What a push becomes: one row per project in that project's check lane, derived from the raw event
 * (src/events.ts) the push was appended as. The row's id is the event's and the project's, so a
 * second derivation of the same event finds the row, or the run that proves it ended. The identity
 * window (`PUSH_WINDOW_MS`) is read from the event log and the lane, not kept beside them.
 */
import { createHash } from "node:crypto";
import { modeOf } from "./engine.ts";
import type { EventLog, RawEvent } from "./events.ts";
import { type LaneId, checkLane } from "./lane.ts";
import { type McpNotification, type McpServerConfig, mapNotification } from "./mcp.ts";
import { realpathish } from "./paths.ts";
import { plainLine, redact } from "./redact.ts";
import type { RequestStore, Row, UnclaimedRow } from "./requests.ts";
import { stamp } from "./schedule.ts";
import type { RunRecord } from "./store.ts";
import type { DynamicTriggerRule, ReplacementPolicy, Trigger, TriggerStore } from "./triggers.ts";
import { type PromoteTarget, envelopeOf, promotionBody } from "./check-run.ts";

export const PUSH_WINDOW_MS = 5 * 60_000;
export const MAX_PUSH_ROWS = 32;
const TEXT_CHARS = 200;

/** `evt-` + the first 32 hex of sha256(`${eventId}|${realpathish(project)}`). */
export function pushRowId(eventId: string, project: string): string {
	return `evt-${createHash("sha256").update(`${eventId}|${realpathish(project)}`).digest("hex").slice(0, 32)}`;
}

export interface PushInput {
	/** The push as appended. */
	readonly event: RawEvent;
	/** The trigger's idempotency key. */
	readonly key: string;
	readonly policy: ReplacementPolicy;
	/** `${sourceLabel} / ${eventLabel}`, for the row's text. */
	readonly label: string;
	/** The row's source is `push:${sourceLabel}`. */
	readonly sourceLabel: string;
	/** The project's directory (a rule's cwd). */
	readonly project: string;
	/** Events read from the log. */
	readonly earlier: readonly { readonly id: string; readonly key: string; readonly received_at: string }[];
	/** The run log proves this row's run ended. */
	readonly done: (rowId: string) => boolean;
	readonly createdBy: UnclaimedRow["created_by"];
	readonly now: number;
	/**
	 * `pi-loops events replay`: the row's own id. The push runs again, so no identity window applies,
	 * no `done` test, and a row that already carries the event does not hold it back.
	 */
	readonly replay?: string;
}

export type PushDecision =
	/** This event's row exists or is proved done. */
	| { readonly kind: "there" }
	| { readonly kind: "queued"; readonly row: UnclaimedRow; readonly drop?: Row }
	/** `of`: the event it replaced; `event`: the event that replaces it, the only one the row is for afterwards. */
	| { readonly kind: "replaced"; readonly rowId: string; readonly of: string; readonly event: string }
	| { readonly kind: "collapsed"; readonly rowId: string; readonly of: string }
	| { readonly kind: "duplicate"; readonly of: string };

function laneOf(project: string): string {
	const lane = checkLane(project);
	if (!lane) throw new Error(`a push needs a project: "${project}" has no check lane`);
	return lane;
}

/** Pure: what this push does to its project's check lane, given that lane's rows. */
export function decidePush(input: PushInput, rows: readonly Row[]): PushDecision {
	const lane = laneOf(input.project);
	const { event, project } = input;
	const id = input.replay ?? pushRowId(event.id, project);
	if (rows.some((r) => r.id === id)) return { kind: "there" };
	if (input.replay === undefined && (input.done(id) || rows.some((r) => r.payload?.events?.includes(event.id)))) return { kind: "there" };

	const at = Date.parse(event.received_at);
	const window = input.replay !== undefined ? [] : input.earlier
		.filter((e) => e.key === input.key && e.id !== event.id && at - Date.parse(e.received_at) >= 0 && at - Date.parse(e.received_at) <= PUSH_WINDOW_MS)
		.sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at));
	for (const e of window) {
		const carrier = rows.find((r) => r.payload?.events?.includes(e.id));
		if (carrier?.run) return { kind: "duplicate", of: e.id };
		if (carrier) return input.policy === "latest_replaces" ? { kind: "replaced", rowId: carrier.id, of: e.id, event: event.id } : { kind: "collapsed", rowId: carrier.id, of: e.id };
		if (input.done(pushRowId(e.id, project))) return { kind: "duplicate", of: e.id };
	}

	const source = `push:${input.sourceLabel}` as const;
	const text = `[Trigger ${id}] ${Array.from(plainLine(redact(`push ${input.label}`))).slice(0, TEXT_CHARS).join("")}`;
	const row: UnclaimedRow = { v: 3, id, lane, kind: "input", source, mode: modeOf("check", "input", source, "turn"), wake: "turn", payload: { text, cwd: project, events: [event.id] }, created_at: stamp(input.now), created_by: input.createdBy, attempts: 0 };
	const waiting = rows.filter((r) => r.source.startsWith("push:") && !r.run);
	if (waiting.length < MAX_PUSH_ROWS) return { kind: "queued", row };
	const drop = waiting.reduce((oldest, r) => (Date.parse(r.created_at) < Date.parse(oldest.created_at) ? r : oldest));
	return { kind: "queued", row, drop };
}

/** The decision taken and written under the lane's lock (`RequestStore.writePush`). */
export function writePush(store: RequestStore, input: PushInput): PushDecision {
	return store.writePush(laneOf(input.project), (rows) => decidePush(input, rows));
}

export type PushDelivery = "sub_agent" | "inject_summary" | "inject_and_run";

/** What one delivery of a push came to, for the window's card and the logs. */
export interface TriggerOutcome {
	trigger: Trigger;
	delivery: PushDelivery;
	ok: boolean;
	matchedRules: DynamicTriggerRule[];
	summary: string;
	error?: string;
	durationMs: number;
	cost: number;
	promoted: boolean;
	sessionFile?: string;
}

/** What a server's pushes do, from its config: run one turn, inject the summary, or be checked against the rules. */
export function deliveryOf(cfg: Pick<McpServerConfig, "injectAndRun" | "injectSummary">): PushDelivery {
	return cfg.injectAndRun ? "inject_and_run" : cfg.injectSummary ? "inject_summary" : "sub_agent";
}

/** The notification as received, as `events.jsonl` keeps it. */
export function rawPush(n: McpNotification): string {
	return JSON.stringify({ method: n.method, params: n.params });
}

/**
 * A stored push read back as its trigger: the server from the event's source, the notification from
 * its raw text. Its trace is the event's id and its time the event's. Undefined for an event that is
 * not a push, whose text does not parse, or that maps to no trigger (no idempotency key).
 */
export function pushTrigger(event: RawEvent): Trigger | undefined {
	if (!event.source.startsWith("mcp:")) return undefined;
	let n: unknown;
	try {
		n = JSON.parse(event.raw);
	} catch {
		return undefined; // a line edited by hand: the event stays in the log, and nothing acts on it
	}
	if (!n || typeof n !== "object" || typeof (n as { method?: unknown }).method !== "string") return undefined;
	const { method, params } = n as { method: string; params?: unknown };
	const trigger = mapNotification(event.source.slice("mcp:".length), { method, params });
	// A project's own server pushed for that project only (`project`, stored with the event).
	return trigger && { ...trigger, traceId: event.id, receivedAt: event.received_at, ...(event.project !== undefined ? { cwd: event.project } : {}) };
}

/** The pushes among `events` with their keys, for `PushInput.earlier`: an event that maps to no trigger is left out. */
function keyed(events: readonly RawEvent[]): PushInput["earlier"] {
	return events.flatMap((e) => {
		const key = pushTrigger(e)?.idempotencyKey;
		return key === undefined ? [] : [{ id: e.id, key, received_at: e.received_at }];
	});
}

export interface DeriveDeps {
	readonly requests: RequestStore;
	readonly events: Pick<EventLog, "since">;
	readonly rules: Pick<TriggerStore, "load" | "appendAudit">;
	/** The run log: a row whose run has a record is done. */
	readonly runs: () => readonly RunRecord[];
	readonly createdBy: () => UnclaimedRow["created_by"];
	/** Whether a row of this id was written once (its `accepted` audit row): a start's derivation leaves it, however it left its lane. */
	readonly written?: (rowId: string) => boolean;
}

/** The projects a push is checked in: `cwd` for a project's own server, else every project with an enabled rule. */
function pushProjects(rules: readonly DynamicTriggerRule[], cwd: string | undefined): string[] {
	if (cwd !== undefined) return [cwd];
	return [...new Set(rules.filter((r) => r.enabled && !r.proposed).map((r) => r.cwd))];
}

/**
 * The rows of one stored push, one per project, each decided under its lane's lock and audited in
 * the words of earlier versions. `again`: the derivation at start, which writes no `deduped` row a
 * first derivation already wrote. Returns the lanes it queued a row in.
 */
export function derivePush(deps: DeriveDeps, event: RawEvent, trigger: Trigger, now: number, again = false): LaneId[] {
	const projects = pushProjects(deps.rules.load(), trigger.cwd);
	const audit = (cwd: string, traceId: string, state: string, details: Record<string, unknown>) =>
		deps.rules.appendAudit({ cwd, type: "trigger", traceId, state, sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { ...details, ...envelopeOf(trigger) } });
	if (!projects.length) {
		if (!again) deps.rules.appendAudit({ cwd: "", type: "trigger_result", traceId: trigger.traceId, state: "no_rules", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { delivery: "sub_agent", ...envelopeOf(trigger) } });
		return [];
	}
	const at = Date.parse(event.received_at);
	const earlier = keyed(deps.events.since(at - PUSH_WINDOW_MS).filter((e) => e.receiver.kind === "background"));
	let records: readonly RunRecord[] | undefined;
	const done = (rowId: string): boolean => (records ??= deps.runs()).some((r) => r.runId === rowId);
	const lanes: LaneId[] = [];
	for (const project of projects) {
		// Again at start: a row that was written once is not written twice. It may have left refused
		// (over budget, dropped, dead) with no run record to prove it.
		if (again && deps.written?.(pushRowId(event.id, project))) continue;
		const decision = writePush(deps.requests, { event, key: trigger.idempotencyKey, policy: trigger.replacementPolicy, label: `${trigger.sourceLabel} / ${trigger.eventLabel}`, sourceLabel: trigger.sourceLabel, project, earlier, done, createdBy: deps.createdBy(), now });
		const accepted = { delivery: "sub_agent", evaluator_decision: { outcome: "accept", permission: "allow" } };
		switch (decision.kind) {
			case "there":
				break;
			case "queued": {
				if (decision.drop) auditDrop(deps.rules, project, decision.drop);
				audit(project, decision.row.id, "accepted", { ...accepted, row: decision.row.id });
				lanes.push(decision.row.lane);
				break;
			}
			case "replaced":
				audit(project, decision.rowId, "accepted", { ...accepted, row: decision.rowId, replaces: decision.of });
				lanes.push(laneOf(project));
				break;
			case "collapsed":
				if (!again) audit(project, pushRowId(event.id, project), "deduped", { previous_trace_id: decision.rowId, row: decision.rowId });
				break;
			case "duplicate":
				if (!again) audit(project, pushRowId(event.id, project), "deduped", { previous_trace_id: pushRowId(decision.of, project) });
				break;
		}
	}
	return lanes;
}

function auditDrop(rules: Pick<TriggerStore, "appendAudit">, project: string, lost: Row): void {
	rules.appendAudit({ cwd: project, type: "trigger", traceId: lost.id, state: "dropped", sourceLabel: lost.source.slice("push:".length), summary: lost.payload?.text, details: { delivery: "sub_agent", row: lost.id, reason: `${MAX_PUSH_ROWS} pushes already waiting for a free slot` } });
}

/**
 * `pi-loops events replay`: the rows of one stored push again, in the projects `derivePush` checks it
 * in, each with an id of its own (`tag` makes it), so they run although the first ones ran. Each is
 * audited `accepted` with the event it replays. Returns the lanes it wrote a row in.
 */
export function replayPush(deps: Pick<DeriveDeps, "requests" | "rules" | "createdBy">, event: RawEvent, trigger: Trigger, now: number, tag: string): LaneId[] {
	const lanes: LaneId[] = [];
	for (const project of pushProjects(deps.rules.load(), trigger.cwd)) {
		const replay = pushRowId(`${event.id}#replay-${tag}`, project);
		const decision = writePush(deps.requests, { event, key: trigger.idempotencyKey, policy: trigger.replacementPolicy, label: `${trigger.sourceLabel} / ${trigger.eventLabel}`, sourceLabel: trigger.sourceLabel, project, earlier: [], done: () => false, createdBy: deps.createdBy(), now, replay });
		if (decision.kind !== "queued") continue;
		if (decision.drop) auditDrop(deps.rules, project, decision.drop);
		deps.rules.appendAudit({ cwd: project, type: "trigger", traceId: replay, state: "accepted", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { delivery: "sub_agent", evaluator_decision: { outcome: "accept", permission: "allow" }, row: replay, replays: event.id, ...envelopeOf(trigger) } });
		lanes.push(decision.row.lane);
	}
	return lanes;
}

/**
 * A push that injects into a chat repeats one that this process received, with the same key, inside
 * `PUSH_WINDOW_MS`: every window that has the server reacts once, so the window is this process's own.
 */
export function injectRepeats(event: RawEvent, key: string, events: readonly RawEvent[]): RawEvent | undefined {
	const at = Date.parse(event.received_at);
	let previous: RawEvent | undefined;
	for (const e of events) {
		if (e.id === event.id) break;
		const ago = at - Date.parse(e.received_at);
		if (e.receiver.pid !== event.receiver.pid || ago < 0 || ago > PUSH_WINDOW_MS) continue;
		if (pushTrigger(e)?.idempotencyKey === key) previous = e;
	}
	return previous;
}

export interface InjectDeps {
	readonly events: Pick<EventLog, "since">;
	readonly audit: Pick<TriggerStore, "appendAudit">;
	readonly budget: () => { spent: number; cap: number; over: boolean };
	/** `inject_summary`: the push's own text into the chat, with no turn. Returns where it went. */
	readonly promote: (content: string, trigger: Trigger) => PromoteTarget | Promise<PromoteTarget>;
	/** `inject_and_run`: the prompt into the chat, and one turn. Returns where it went. */
	readonly injectAndRun: (prompt: string, trigger: Trigger) => PromoteTarget | Promise<PromoteTarget>;
	readonly log: (message: string) => void;
	readonly now: () => number;
}

/**
 * A stored push that injects into a chat: refused over budget when it runs a turn, deduplicated
 * against this process's own pushes in the log, audited, and delivered. Undefined when it was not
 * delivered.
 */
export async function injectPush(deps: InjectDeps, event: RawEvent, trigger: Trigger, delivery: Exclude<PushDelivery, "sub_agent">): Promise<TriggerOutcome | undefined> {
	const cwd = trigger.cwd ?? "";
	const budget = deps.budget();
	// `inject_summary` runs no model call: refusing it for want of budget is backwards, and the day the
	// cap trips is the day you still want to be told what is arriving. Said, so that "why did this one
	// arrive when everything else stopped" has an answer.
	if (delivery === "inject_summary" && budget.over) deps.log(`trigger ${trigger.traceId.slice(0, 8)} injected despite today's $${budget.cap.toFixed(2)} budget: an injected summary runs no model call`);
	if (delivery === "inject_and_run" && budget.over) {
		deps.audit.appendAudit({ cwd, type: "trigger", traceId: trigger.traceId, state: "budget_exceeded", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { ...envelopeOf(trigger), delivery, spent_usd: budget.spent, cap_usd: budget.cap } });
		deps.log(`trigger ${trigger.traceId.slice(0, 8)} not run: today's automation has cost $${budget.spent.toFixed(2)} of the $${budget.cap.toFixed(2)} budget`);
		return undefined;
	}
	const at = Date.parse(event.received_at);
	const previous = injectRepeats(event, trigger.idempotencyKey, deps.events.since(at - PUSH_WINDOW_MS));
	if (previous) {
		deps.audit.appendAudit({ cwd, type: "trigger", traceId: trigger.traceId, state: "deduped", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { previous_trace_id: previous.id, ...envelopeOf(trigger) } });
		deps.log(`trigger ${trigger.traceId.slice(0, 8)} deduped (${trigger.sourceLabel} / ${trigger.eventLabel}): an identical event arrived within the dedup window`);
		return undefined;
	}
	deps.audit.appendAudit({ cwd, type: "trigger", traceId: trigger.traceId, state: "accepted", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { delivery, evaluator_decision: { outcome: "accept", permission: "allow" }, ...envelopeOf(trigger) } });
	return delivery === "inject_summary" ? deliverInjectSummary(deps, trigger) : deliverInjectAndRun(deps, trigger);
}

export async function deliverInjectSummary(deps: Pick<InjectDeps, "audit" | "budget" | "promote" | "now">, trigger: Trigger): Promise<TriggerOutcome> {
	const start = deps.now();
	const cwd = trigger.cwd ?? "";
	const summary = trigger.payloadSummary ?? "";
	let promoted = false;
	if (summary) {
		const target = await deps.promote(promotionBody(trigger, summary), trigger);
		promoted = target !== "inbox";
		deps.audit.appendAudit({ cwd, type: "trigger_promotion", traceId: trigger.traceId, state: target === "inbox" ? "redirected" : "promoted", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary, details: { prefix_injected: true, delivery: "inject_summary", to: target, ...envelopeOf(trigger) } });
	}
	// `over_budget` on a completed row is the audit's answer to "everything else stopped today, why
	// did this run": because it cost nothing.
	const spend = deps.budget();
	deps.audit.appendAudit({ cwd, type: "trigger_result", traceId: trigger.traceId, state: "completed", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary, details: { delivery: "inject_summary", cost_usd: 0, ...(spend.over ? { over_budget: true } : {}), ...envelopeOf(trigger) } });
	return { trigger, delivery: "inject_summary", ok: true, matchedRules: [], summary, durationMs: deps.now() - start, cost: 0, promoted };
}

export async function deliverInjectAndRun(deps: Pick<InjectDeps, "audit" | "injectAndRun" | "now">, trigger: Trigger): Promise<TriggerOutcome> {
	const start = deps.now();
	const prompt = `[Trigger ${trigger.traceId}] ${trigger.payloadSummary ?? `${trigger.sourceLabel} fired: ${trigger.eventLabel}`}`;
	const target = await deps.injectAndRun(prompt, trigger);
	deps.audit.appendAudit({ cwd: trigger.cwd ?? "", type: "trigger_result", traceId: trigger.traceId, state: "completed", sourceLabel: trigger.sourceLabel, eventLabel: trigger.eventLabel, summary: trigger.payloadSummary, details: { delivery: "inject_and_run", prefix_injected: true, cost_usd: 0, to: target, ...envelopeOf(trigger) } });
	return { trigger, delivery: "inject_and_run", ok: true, matchedRules: [], summary: trigger.payloadSummary ?? "", durationMs: deps.now() - start, cost: 0, promoted: target !== "inbox" };
}

/** The ids of the stored events a row of any lane still names (`payload.events`): what a rotation of `events.jsonl` keeps. */
export function eventsInRows(requests: Pick<RequestStore, "lanes" | "list">): ReadonlySet<string> {
	const ids = new Set<string>();
	for (const lane of requests.lanes()) for (const row of requests.list(lane.id)) for (const id of row.payload?.events ?? []) ids.add(id);
	return ids;
}
