/**
 * A project's periodic check, as a row (design 3.4): at each tick, for each project with enabled rules,
 * the poll interval, the rules' gates, and then one `check:` row in the project's check lane, which
 * the background's check lanes run with `runCheck` (src/background-executor.ts `createCheckLanes`). A
 * queued or running check of the lane collapses the new one: "the previous check is still active".
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { failurePause } from "./backoff.ts";
import type { ClockStore, GateClocks } from "./clock.ts";
import { modeOf } from "./engine.ts";
import type { EventLog } from "./events.ts";
import { type CommandGate, GATE_LOOK_EVERY_MS, type GatePolicy, type PathGate, type PathState, PathLooks, gateDecision, gateOf, lookCommand, pathReading } from "./gate.ts";
import type { JobHistory } from "./job-status.ts";
import { type LaneId, checkLane } from "./lane.ts";
import { plainLine, redact } from "./redact.ts";
import type { RequestStore, UnclaimedRow } from "./requests.ts";
import { stamp } from "./schedule.ts";
import { type DynamicTriggerRule, type TriggerStore, newTraceId } from "./triggers.ts";

/** The ticker's interval (src/ticker.ts, 30 s): no poll comes sooner. */
export const POLL_TICK_MS = 30_000;

/** The source of a periodic check's row, and of `/triggers run`'s. */
export const CHECK_SOURCE = "check:local:dynamic";

export interface CheckTickDeps {
	readonly rules: Pick<TriggerStore, "load" | "setEnabled" | "appendAudit">;
	readonly requests: Pick<RequestStore, "appendIfAbsent">;
	/** The gates' readings, and each project's poll (`clock.json` `checks`). */
	readonly clock: GateClocks & Pick<ClockStore, "claimCheck">;
	readonly events: Pick<EventLog, "append">;
	readonly gatePolicy: () => GatePolicy;
	readonly pollIntervalSecs: () => number;
	/** The run log folded per job: a project's checks are under its lane (src/check-run.ts). */
	readonly history: () => ReadonlyMap<string, JobHistory>;
	readonly createdBy: () => UnclaimedRow["created_by"];
	/** The `stat` a path gate's look uses; tests give one that hangs. */
	readonly stat?: (p: string) => Promise<unknown>;
	readonly log: (message: string) => void;
}

/** One gated rule's look this poll: whether it opens the check, the event that stored it, and what `seen` becomes when the check does not fail. */
interface RuleLook {
	readonly decision: "wake" | "hold";
	readonly state?: PathState;
	readonly event?: string;
	readonly seen?: { rule: string; digest: string; at: string };
}

/** The row of one check of `cwd`'s rules `ids`: what the check lane runs. `gates` are what the gates let through. */
export function checkRow(cwd: string, ids: readonly string[], createdBy: UnclaimedRow["created_by"], now: number, gates: { prechecked?: string[]; events?: string[]; seen?: { rule: string; digest: string; at: string }[] } = {}): UnclaimedRow {
	const lane = checkLane(cwd);
	if (!lane) throw new Error(`a check needs a project: "${cwd}" has no check lane`);
	const id = `chk-${createHash("sha256").update(`${lane}|${stamp(now)}|${ids.join(",")}`).digest("hex").slice(0, 32)}`;
	const text = Array.from(plainLine(redact(`check of ${path.basename(cwd) || cwd}: ${ids.length} rule(s)`))).slice(0, 200).join("");
	return {
		v: 3, id, lane, kind: "input", source: CHECK_SOURCE, mode: modeOf("check", "input", CHECK_SOURCE, "turn"), wake: "turn",
		payload: { text, cwd, rules: [...ids], ...(gates.prechecked?.length ? { prechecked: gates.prechecked } : {}), ...(gates.events?.length ? { events: gates.events } : {}), ...(gates.seen?.length ? { seen: gates.seen } : {}) },
		collapse_key: `check:${lane}`, created_at: stamp(now), created_by: createdBy, attempts: 0,
	};
}

export interface CheckTick {
	/** One poll of every project: the rows of the checks that are due. */
	tick(now: number): Promise<void>;
}

export function createCheckTick(deps: CheckTickDeps): CheckTick {
	const looks = new PathLooks({ stat: deps.stat });
	/** When this process last looked at each rule's command gate: `clock.json` holds the same time, but a read or write of it can fail, and the minute is kept whatever the file says (design 3.3). */
	const commandLooks = new Map<string, number>();
	/** The failure each lane's `backoff` audit row was written for. */
	const backoffSaid = new Map<LaneId, string>();

	/** A project whose checks failed three times in a row waits its pause after the last failure (src/backoff.ts), from the run log. */
	const backingOff = (lane: LaneId, now: number): boolean => {
		const history = deps.history().get(lane);
		if (!history?.failed) return false;
		return now - Date.parse(history.failed.at) < failurePause(history.streak);
	};

	async function lookCommandGate(rule: DynamicTriggerRule, gate: CommandGate, now: number): Promise<RuleLook> {
		let before: ReturnType<GateClocks["readGate"]>;
		try {
			before = deps.clock.readGate(rule.id);
		} catch (err) {
			deps.log(`rule ${rule.id}: its gate state was not read: ${err instanceof Error ? err.message : String(err)}`);
		}
		const last = Math.max(before?.last ? Date.parse(before.last.at) : -Infinity, commandLooks.get(rule.id) ?? -Infinity);
		if (now - last < GATE_LOOK_EVERY_MS) return { decision: "hold" };
		// Before the look, so no failure after it (the event, the look time) lets the next poll look again.
		commandLooks.set(rule.id, now);
		const reading = await lookCommand(gate.command, { cwd: rule.cwd, policy: deps.gatePolicy() });
		const decision = gateDecision(before?.seen?.digest, reading.look);
		let event: { id: string; received_at: string } | undefined;
		if (decision === "wake") {
			try {
				event = deps.events.append(`gate:${rule.id}`, reading.raw);
			} catch (err) {
				deps.log(`rule ${rule.id}: its gate reading was not stored, so it is not checked this poll: ${err instanceof Error ? err.message : String(err)}`);
				return { decision: "hold" };
			}
		}
		const at = stamp(now);
		try {
			deps.clock.noteGate(rule.id, reading.look.kind === "command" ? { at, digest: reading.look.digest } : { at, failed: reading.look.kind === "failed" ? reading.look.why : "not a command reading" }, decision === "hold");
		} catch (err) {
			deps.log(`rule ${rule.id}: its gate reading was not counted: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (reading.look.kind === "failed") deps.log(`rule ${rule.id}: gate failing: ${reading.look.why}; the model checks the rule until it works`);
		return { decision, ...(event ? { event: event.id } : {}), ...(event && reading.look.kind === "command" ? { seen: { rule: rule.id, digest: reading.look.digest, at: event.received_at } } : {}) };
	}

	async function lookPathGate(cwd: string, rule: DynamicTriggerRule, gate: PathGate, now: number): Promise<RuleLook> {
		const state = await looks.look(rule.id, gate);
		const reading = pathReading(gate, state);
		const decision = gateDecision(undefined, reading.look);
		let event: string | undefined;
		if (decision === "wake") {
			try {
				event = deps.events.append(`gate:${rule.id}`, reading.raw).id;
			} catch (err) {
				deps.log(`rule ${rule.id}: its gate reading was not stored, so it is not checked this poll: ${err instanceof Error ? err.message : String(err)}`);
				return { state, decision: "hold" };
			}
		}
		let before: PathState | undefined;
		try {
			before = deps.clock.noteGate(rule.id, { at: stamp(now), state }, decision === "hold")?.last?.state;
		} catch (err) {
			deps.log(`rule ${rule.id}: its gate reading was not counted: ${err instanceof Error ? err.message : String(err)}`);
		}
		const row = (auditState: string, summary: string) =>
			deps.rules.appendAudit({ cwd, type: "trigger", traceId: newTraceId(), state: auditState, sourceLabel: "local:dynamic", eventLabel: rule.id, summary, details: { rule_id: rule.id, path: gate.raw, resolved: gate.resolved } });
		if (state === "absent" && before !== "absent") row("waiting", `no model call until ${gate.raw} exists`);
		else if (state === "present" && before === "absent") row("appeared", `${gate.raw} exists; the model checks the rule`);
		return { state, decision, ...(event ? { event } : {}) };
	}

	/** A gated rule's look, or undefined for a rule the model checks as it always did. A reading that opens the check is stored raw first; one that cannot be stored holds the rule. */
	async function lookGate(cwd: string, rule: DynamicTriggerRule, now: number): Promise<RuleLook | undefined> {
		const gate = gateOf(rule);
		if (!gate) return undefined;
		return gate.kind === "command" ? lookCommandGate(rule, gate, now) : lookPathGate(cwd, rule, gate, now);
	}

	return {
		async tick(now) {
			const rules = deps.rules.load().filter((r) => r.enabled && !r.proposed);
			if (!rules.length) return;
			const byCwd = new Map<string, DynamicTriggerRule[]>();
			for (const r of rules) byCwd.set(r.cwd, [...(byCwd.get(r.cwd) ?? []), r]);
			for (const [cwd, group] of byCwd) {
				// A checkout that is gone cannot be checked: without this guard the rules poll, and bill, forever.
				if (cwd && !fs.existsSync(cwd)) {
					for (const rule of group) {
						await deps.rules.setEnabled(rule.id, false).catch((err: unknown) => deps.log(`rule ${rule.id}: not disabled: ${err instanceof Error ? err.message : String(err)}`));
						deps.rules.appendAudit({ cwd, type: "trigger", traceId: newTraceId(), state: "disabled", sourceLabel: "local:dynamic", eventLabel: rule.id, summary: `cwd ${cwd} no longer exists`, details: { reason: "cwd missing" } });
					}
					deps.log(`disabled ${group.length} rule(s): cwd ${cwd} no longer exists (re-enable after restoring it)`);
					continue;
				}
				const lane = checkLane(cwd);
				if (!lane) continue;
				if (backingOff(lane, now)) {
					// Said once per failure: entering the backoff is audited as `backoff` (docs/triggers.md).
					const history = deps.history().get(lane)!;
					if (backoffSaid.get(lane) !== history.failed!.at) {
						backoffSaid.set(lane, history.failed!.at);
						const ids = group.map((r) => r.id);
						deps.rules.appendAudit({ cwd, type: "trigger", traceId: newTraceId(), state: "backoff", sourceLabel: "local:dynamic", eventLabel: ids.join(" "), summary: `${ids.length} rule(s) checked with a widening gap after ${history.streak} failed check(s) in a row`, details: { rule_ids: ids, consecutive_failures: history.streak } });
						deps.log(`${ids.length} trigger rule(s) failed ${history.streak} checks in a row; polling them with a widening gap`);
					}
					continue;
				}
				if (!deps.clock.claimCheck(lane, now, deps.pollIntervalSecs() * 1000)) continue;
				// After the claim, so a gated rule is looked at once per poll, as a model check would be.
				const gated = await Promise.all(group.map((r) => lookGate(cwd, r, now)));
				const due = group.filter((_, i) => gated[i]?.decision !== "hold");
				if (!due.length) continue;
				const prechecked = group.filter((_, i) => gated[i]?.decision === "wake" && gated[i]?.state === "present").map((r) => r.id);
				const events = gated.flatMap((g) => (g?.event ? [g.event] : []));
				const seen = gated.flatMap((g) => (g?.seen ? [g.seen] : []));
				deps.requests.appendIfAbsent(checkRow(cwd, due.map((r) => r.id), deps.createdBy(), now, { prechecked, events, seen }), { collapse: true });
			}
		},
	};
}

/** What the page's rule row says about a rule that waits for a path: its last look (`clock.json`), and when the next one is. */
export function ruleLook(clock: Pick<GateClocks, "readGate">, ruleId: string, pollIntervalSecs: number): { look: PathState; nextAt: number } | undefined {
	const last = clock.readGate(ruleId)?.last;
	return last?.state && { look: last.state, nextAt: Date.parse(last.at) + Math.max(pollIntervalSecs * 1000, POLL_TICK_MS) };
}
