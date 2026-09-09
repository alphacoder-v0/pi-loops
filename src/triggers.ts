/**
 * Dynamic triggers — pie's `triggers/dynamic.rs` + the `Trigger` envelope from its
 * harness, as plain data + pure functions. A rule is a natural-language condition and
 * action; a periodic check (or a pushed notification) hands every enabled rule to a
 * fresh sub-agent that evaluates conditions with tools, executes matching actions and
 * reports the matched `dyn-…` ids, which the runtime marks fired.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { clampFuture } from "./schedule.ts";
import { withFileLock, writeFileAtomic } from "./lock.ts";
import { capRedacted, previewRedacted } from "./redact.ts";

export const DEFAULT_TRIGGER_POLL_INTERVAL_SECS = 10 * 60;
export const DEDUP_WINDOW_MS = 5 * 60_000;
export const SUMMARY_CAP_CHARS = 4096;
export const NO_MATCH_SENTINEL = "no dynamic trigger rule matched";

export interface DynamicTriggerRule {
	id: string;
	condition: string;
	action: string;
	enabled: boolean;
	fireOnce: boolean;
	firedAt?: string;
	promoteToChat: boolean;
	createdAt: string;
	/** Project the rule belongs to; the check sub-agent runs here. */
	cwd: string;
	/** Model / thinking of the session that created the rule; the check sub-agent uses them (pie: same session, so implicit). */
	model?: string;
	thinking?: string;
	/** Per-rule cap on the check/action sub-agent; default `[triggers] run_timeout_secs`. */
	timeoutMs?: number;
	/** Host the rule belongs to (shared $HOME): other hosts ignore it. Missing = any host (pre-0.1.3). */
	host?: string;
	createdBy?: { sessionId?: string };
}

export type SourceKind = "local" | "mcp";
export type ReplacementPolicy = "drop" | "latest_replaces";

/** The boundary type between sources (periodic checker, MCP push) and the runtime. */
export interface Trigger {
	source: { kind: "local"; subkind: string } | { kind: "mcp"; serverName: string; method: string };
	sourceKind: SourceKind;
	sourceLabel: string;
	eventLabel: string;
	payloadSummary?: string;
	idempotencyKey: string;
	replacementPolicy: ReplacementPolicy;
	traceId: string;
	receivedAt: string;
	/** Which project's rules this event is evaluated against (undefined = every project). */
	cwd?: string;
}

export function newTraceId(): string {
	return randomUUID();
}

export function newRuleId(): string {
	return `dyn-${randomBytes(16).toString("hex")}`;
}

/* -------------------------------------------------------------- parsing */

const ZH_WHEN = "当";
const ZH_IF = "如果";
const ZH_TIME_SUFFIX_LONG = "的时候";
const ZH_TIME_SUFFIX_SHORT = "时";
const ZH_EXECUTE = "执行";

const MARKERS: string[] = [
	"的时候，执行", "的时候,执行", "的时候 执行", "的时候执行", "的时候，", "的时候,",
	"时，执行", "时,执行", "时 执行", "时执行", "时，", "时,",
	"，则", ", 则", ",则", " 则 ", "则", "，就", ", 就", ",就", " 就 ",
	"，执行", ", 执行", ",执行", " 执行 ",
	" then ", " then run ", " then execute ", ", run ", ", execute ", ", do ", " run ", " execute ",
];

export interface ParsedTriggerRule {
	condition: string;
	action: string;
}

/** Split "when X, run Y" / "当 X 时，执行 Y" into condition + action. Throws on malformed input. */
export function parseTriggerRule(spec: string): ParsedTriggerRule {
	const text = spec.trim();
	if (!text) throw new Error("usage: /new-trigger <when condition, run action>");
	const lower = text.toLowerCase();
	let split: { idx: number; marker: string } | undefined;
	for (const marker of MARKERS) {
		const haystack = /^[\x00-\x7f]*$/.test(marker) ? lower : text;
		const idx = haystack.indexOf(marker);
		if (idx >= 0) {
			split = { idx, marker };
			break;
		}
	}
	if (!split) throw new Error("could not split the trigger into a condition and action. In normal chat, ask pi to create the trigger so the model can extract them, or use `/new-trigger if condition, then action`.");
	const condition = cleanCondition(text.slice(0, split.idx));
	const action = cleanAction(text.slice(split.idx + split.marker.length));
	if (!condition || !action) throw new Error("condition and action must both be non-empty");
	return { condition, action };
}

function cleanCondition(raw: string): string {
	let s = raw.trim();
	if (s.startsWith(ZH_WHEN)) s = s.slice(ZH_WHEN.length).trim();
	if (s.startsWith(ZH_IF)) s = s.slice(ZH_IF.length).trim();
	const lower = s.toLowerCase();
	if (lower.startsWith("when ")) s = s.slice(5).trim();
	else if (lower.startsWith("if ")) s = s.slice(3).trim();
	if (s.endsWith(ZH_TIME_SUFFIX_LONG)) s = s.slice(0, -ZH_TIME_SUFFIX_LONG.length);
	else if (s.endsWith(ZH_TIME_SUFFIX_SHORT)) s = s.slice(0, -ZH_TIME_SUFFIX_SHORT.length);
	return s.trim();
}

function cleanAction(raw: string): string {
	let s = raw.trim();
	if (s.startsWith(ZH_EXECUTE)) s = s.slice(ZH_EXECUTE.length).trim();
	const lower = s.toLowerCase();
	if (lower.startsWith("run ")) s = s.slice(4).trim();
	else if (lower.startsWith("execute ")) s = s.slice(8).trim();
	return s;
}

/** pie routes these to NewCronJob instead of NewTrigger. */
export function looksLikeFixedScheduleRequest(text: string): boolean {
	const lower = text.toLowerCase();
	const english = ["every hour", "hourly", "every day", "daily", "every week", "weekly", "scheduled job", "cron", "crontab"];
	if (english.some((n) => lower.includes(n))) return true;
	return ["定时任务", "定時任務", "每小时", "每小時", "每天", "每日", "每周", "每週"].some((n) => text.includes(n));
}

/* --------------------------------------------------------------- prompt */

export function renderDynamicTriggerPrompt(trigger: Trigger, rules: DynamicTriggerRule[]): string {
	const rulesJson = JSON.stringify(
		rules.map((r) => ({ id: r.id, condition: r.condition, action: r.action, enabled: r.enabled, fire_once: r.fireOnce, fired_at: r.firedAt ?? null, promote_to_chat: r.promoteToChat, created_at: r.createdAt })),
		null,
		2,
	);
	const triggerJson = JSON.stringify(
		{
			source_kind: trigger.sourceKind,
			source: trigger.source,
			source_label: trigger.sourceLabel,
			event_label: trigger.eventLabel,
			payload_visibility: "local",
			payload_summary: trigger.payloadSummary ?? null,
			payload: null,
			received_at: trigger.receivedAt,
			idempotency_key: trigger.idempotencyKey,
			trace_id: trigger.traceId,
			authority: { principal_id: trigger.sourceLabel, principal_label: trigger.sourceLabel, credential_scope: "user" },
		},
		null,
		2,
	);
	return (
		`A trigger check event arrived.\n\nEvent:\n${triggerJson}\n\nDynamic trigger rules:\n${rulesJson}\n\n` +
		"Evaluate each rule's natural-language condition. For source-specific events, compare the rule against the event. For `local:dynamic` periodic checks, inspect current local or remote state with the available tools whenever the condition depends on filesystem state, paths, environment variables, shell expansion, command output, clock time, network/API state, or any fact not already present in the Event JSON. Do not report no match for those conditions until after the needed inspection. " +
		`If no enabled rule matches after any required inspection, reply with exactly: ${NO_MATCH_SENTINEL}.\n\n` +
		"If one or more rules match, execute each matching rule's action. Treat the action as an instruction from the user. If it asks to read or print a file, use the read tool or a safe shell command, then include the requested file contents in your final response. If it asks to run a local program or shell command, use the bash tool. Keep the final response concise and include the exact matched rule id(s), for example `matched dyn-...`."
	);
}

/** Every well-formed `dyn-<32 hex>` id in the text, in order, de-duplicated. */
export function extractDynamicRuleIds(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(/dyn-[0-9a-f]{32}/g)) if (!out.includes(m[0])) out.push(m[0]);
	return out;
}

/**
 * `evaluator` distinguishes the processes that check one project: a rule belongs to the session
 * that created it, so two pi windows in one repo each raise their own check and must not collapse
 * into one another in the shared dedup window when they land in the same millisecond.
 */
export function buildPeriodicCheckTrigger(cwd: string, ruleCount: number, now = new Date(), evaluator = ""): Trigger {
	const local = now.toLocaleString("sv-SE", { timeZoneName: "short" });
	return {
		source: { kind: "local", subkind: "dynamic" },
		sourceKind: "local",
		sourceLabel: "local:dynamic",
		eventLabel: "dynamic periodic check",
		payloadSummary: `Periodic dynamic trigger check at local time ${local} / UTC ${now.toISOString()} with ${ruleCount} enabled rule(s); cwd: ${cwd}`,
		idempotencyKey: `local:dynamic:${cwd}${evaluator ? `#${evaluator}` : ""}:${now.getTime()}`,
		replacementPolicy: "drop",
		traceId: newTraceId(),
		receivedAt: now.toISOString(),
		cwd,
	};
}

/* ---------------------------------------------------------------- store */

interface RulesFile {
	version: 1;
	rules: DynamicTriggerRule[];
}

export type AuditType = "trigger" | "trigger_result" | "trigger_promotion" | "cron_control_plane";

export interface AuditRecord {
	ts: string;
	type: AuditType;
	traceId: string;
	/** Project the trigger belonged to; `/triggers audit` shows this project's rows by default. */
	cwd?: string;
	/** accepted | deduped | running | completed | failed | aborted | promoted | skipped | no_rules */
	state: string;
	sourceLabel?: string;
	eventLabel?: string;
	summary?: string;
	details?: Record<string, unknown>;
}

export class TriggerStore {
	readonly dir: string;
	readonly rulesFile: string;
	readonly auditFile: string;
	private readonly lockPath: string;
	/** Last audit write that failed (pie's PersistenceError): the trigger still ran. */
	lastPersistenceError: string | undefined;
	onPersistenceError: ((message: string) => void) | undefined;
	/** Second sink: pie keeps trigger audit as session entries, so it resumes and exports with the session. */
	onAudit: ((record: AuditRecord) => void) | undefined;

	constructor(dir: string) {
		this.dir = dir;
		this.rulesFile = path.join(dir, "triggers.json");
		this.auditFile = path.join(dir, "triggers-audit.jsonl");
		this.lockPath = path.join(dir, "triggers.lock");
	}

	load(): DynamicTriggerRule[] {
		let text: string;
		try {
			text = fs.readFileSync(this.rulesFile, "utf8");
		} catch (err: any) {
			if (err?.code === "ENOENT") return [];
			throw err;
		}
		if (!text.trim()) return [];
		const parsed = JSON.parse(text) as RulesFile;
		if (!Array.isArray(parsed?.rules)) throw new Error(`${this.rulesFile}: missing "rules" array`);
		return parsed.rules;
	}

	async mutate<T>(fn: (rules: DynamicTriggerRule[]) => T): Promise<T> {
		return withFileLock(this.lockPath, () => {
			const rules = this.load();
			const result = fn(rules);
			writeFileAtomic(this.rulesFile, `${JSON.stringify({ version: 1, rules } satisfies RulesFile, null, 2)}\n`);
			return result;
		});
	}

	async add(input: { condition: string; action: string; fireOnce?: boolean; promoteToChat?: boolean; cwd: string; sessionId?: string; model?: string; thinking?: string; host?: string }): Promise<DynamicTriggerRule> {
		const condition = input.condition.trim();
		const action = input.action.trim();
		if (!condition || !action) throw new Error("trigger rule needs both a condition and an action");
		const rule: DynamicTriggerRule = {
			id: newRuleId(),
			condition,
			action,
			enabled: true,
			fireOnce: input.fireOnce ?? true,
			promoteToChat: input.promoteToChat ?? false,
			createdAt: new Date().toISOString(),
			cwd: input.cwd,
			model: input.model,
			thinking: input.thinking,
			host: input.host,
			createdBy: { sessionId: input.sessionId },
		};
		await this.mutate((rules) => rules.push(rule));
		return rule;
	}

	async remove(id: string): Promise<DynamicTriggerRule | undefined> {
		return this.mutate((rules) => {
			const idx = rules.findIndex((r) => r.id === id.trim());
			return idx < 0 ? undefined : rules.splice(idx, 1)[0];
		});
	}

	/** `cwd` clears that project's rules (a worktree or subdirectory counts as the same project). */
	async clear(cwd?: string, sameProject: (a: string, b: string) => boolean = (a, b) => a === b): Promise<number> {
		return this.mutate((rules) => {
			const keep = cwd ? rules.filter((r) => !sameProject(r.cwd, cwd)) : [];
			const removed = rules.length - keep.length;
			rules.splice(0, rules.length, ...keep);
			return removed;
		});
	}

	/** Patch one rule in place under the lock; undefined when it no longer exists. */
	async update(id: string, patch: (rule: DynamicTriggerRule) => void): Promise<DynamicTriggerRule | undefined> {
		return this.mutate((rules) => {
			const rule = rules.find((r) => r.id === id.trim());
			if (rule) patch(rule);
			return rule;
		});
	}

	async setEnabled(id: string, enabled: boolean): Promise<DynamicTriggerRule | undefined> {
		return this.mutate((rules) => {
			const rule = rules.find((r) => r.id === id.trim());
			if (!rule) return undefined;
			rule.enabled = enabled;
			if (enabled) rule.firedAt = undefined;
			return rule;
		});
	}

	/** fire-once rules in `ids` become disabled with `firedAt`; returns the changed rules. */
	async markFired(ids: string[]): Promise<DynamicTriggerRule[]> {
		if (!ids.length) return [];
		return this.mutate((rules) => {
			const now = new Date().toISOString();
			const changed: DynamicTriggerRule[] = [];
			for (const rule of rules) {
				if (!rule.enabled || !ids.includes(rule.id)) continue;
				rule.firedAt = now;
				if (rule.fireOnce) {
					rule.enabled = false;
					changed.push(rule);
				}
			}
			return changed;
		});
	}

	/** Best effort, like pie: a failed audit write is remembered and reported, never thrown. */
	appendAudit(record: Omit<AuditRecord, "ts">): AuditRecord {
		// Capped like pie's SUMMARY_CAP_BYTES, but the text keeps its lines: this row is the only
		// durable copy of what a check produced (`/triggers audit`, session entries, exports).
		const full: AuditRecord = { ts: new Date().toISOString(), ...record, summary: record.summary ? capRedacted(record.summary, SUMMARY_CAP_CHARS) : undefined };
		try {
			fs.mkdirSync(this.dir, { recursive: true });
			fs.appendFileSync(this.auditFile, `${JSON.stringify(full)}\n`, "utf8");
		} catch (err: any) {
			const message = `trigger audit write failed: ${err?.message ?? err}`;
			this.lastPersistenceError = message;
			this.onPersistenceError?.(message);
		}
		try {
			this.onAudit?.(full);
		} catch {
			/* the session sink is best effort too */
		}
		try {
			if (fs.statSync(this.auditFile).size > 2_000_000) {
				const lines = fs.readFileSync(this.auditFile, "utf8").split("\n").filter(Boolean);
				writeFileAtomic(this.auditFile, `${lines.slice(-Math.floor(lines.length / 2)).join("\n")}\n`);
			}
		} catch {
			/* best effort */
		}
		return full;
	}

	/** Newest first. */
	listAudit(limit = 10, filter?: (r: AuditRecord) => boolean): AuditRecord[] {
		let text: string;
		try {
			text = fs.readFileSync(this.auditFile, "utf8");
		} catch (err: any) {
			if (err?.code !== "ENOENT") {
				// Unreadable (permissions, a directory in the way): empty audit, but say why in /triggers status.
				const message = `trigger audit read failed: ${err?.message ?? err}`;
				this.lastPersistenceError = message;
				this.onPersistenceError?.(message);
			}
			return [];
		}
		const out: AuditRecord[] = [];
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const rec = JSON.parse(line) as AuditRecord;
				if (!filter || filter(rec)) out.push(rec);
			} catch {
				/* skip */
			}
		}
		return out.slice(-limit).reverse();
	}
}

/**
 * pie's control-plane prompt gate, pre-flight part. Prompt-class tool calls (create or remove
 * a trigger, re-enable a trigger or a cron job) need a human. Sub-agents have no prompt channel
 * and are denied fail-closed (pie's agent_loop: "control-plane prompt required but no
 * on_control_plane_prompt hook configured"); a UI-less interactive process is refused; an
 * interactive UI gets to ask. Returns the denial text, or undefined when the caller should ask.
 */
export function controlPlanePreflight(proc: { hop: number; hasUI: boolean }, reason: string): string | undefined {
	if (proc.hop > 0) return `${reason} requires user confirmation; sub-agents have no control-plane prompt channel (fail-closed deny, like pie)`;
	if (!proc.hasUI) return `${reason} requires interactive confirmation; use the slash command instead`;
	return undefined;
}

/** Resolve an id, a unique id prefix, or "<n>" in `rules`. */
/**
 * The audit rows a cron run leaves. Both the interactive extension and the headless host call these
 * — the host used to only write to `host.log`, so `/triggers audit` was blank for exactly the hours
 * nobody was watching, which is when a user most wants to know what ran.
 */
export function auditCronStart(store: TriggerStore, job: { id: string; name?: string; cwd: string; prompt: string; stateful: boolean; lastDueAt?: string; lastFiredAt?: string }, runId: string): void {
	const summary = `cron \`${job.id}\`${job.name ? ` "${job.name}"` : ""} due at ${job.lastDueAt ?? job.lastFiredAt ?? new Date().toISOString()}: ${previewRedacted(job.prompt, 120)}`;
	store.appendAudit({ cwd: job.cwd, type: "trigger", traceId: runId, state: "accepted", sourceLabel: "Cron", eventLabel: job.id, summary, details: { delivery: job.stateful ? "sub_agent" : "inject_and_run", evaluator_decision: { outcome: "accept", permission: "allow" } } });
	store.appendAudit({ cwd: job.cwd, type: "trigger_result", traceId: runId, state: "running", sourceLabel: "Cron", eventLabel: job.id, details: { cwd: job.cwd } });
}

export function auditCronFinish(store: TriggerStore, job: { id: string; cwd: string }, record: { runId: string; ok: boolean; summary?: string; error?: string; findings: number; stateUpdated: boolean; exitCode?: number; sessionFile?: string; usage?: { cost: number }; checker?: { ok: boolean; kept: number; dropped: unknown[] } }, aborted: boolean): void {
	store.appendAudit({
		cwd: job.cwd,
		type: "trigger_result",
		traceId: record.runId,
		state: aborted ? "aborted" : record.ok ? "completed" : "failed",
		sourceLabel: "Cron",
		eventLabel: job.id,
		summary: record.ok ? record.summary : record.error,
		details: { findings: record.findings, state_updated: record.stateUpdated, cost_usd: record.usage?.cost ?? 0, exit_code: record.exitCode, session_file: record.sessionFile, checker: record.checker ? { ok: record.checker.ok, kept: record.checker.kept, dropped: record.checker.dropped.length } : undefined },
	});
}

export function resolveRuleRef(rules: DynamicTriggerRule[], ref: string): DynamicTriggerRule | undefined {
	const t = ref.trim();
	if (!t) return undefined;
	if (/^\d+$/.test(t)) return rules[Number(t) - 1];
	const exact = rules.find((r) => r.id === t);
	if (exact) return exact;
	const hits = rules.filter((r) => r.id.startsWith(t));
	return hits.length === 1 ? hits[0] : undefined;
}

/* ------------------------------------------------------------- polls */

/**
 * When each project was last checked, shared by every pi process on the machine so a check
 * runs once per poll interval no matter which process owns the project at that moment.
 */
/** A slot nobody has claimed for a day is a session that is gone; drop it on the next write. */
export const POLL_LEDGER_TTL_MS = 24 * 60 * 60_000;

export class PollLedger {
	private readonly file?: string;
	private readonly mem = new Map<string, number>();
	constructor(file?: string) {
		this.file = file;
	}

	/** True (and the slot is taken) when `cwd` has not been checked inside `intervalMs`. */
	async claim(cwd: string, now: number, intervalMs: number): Promise<boolean> {
		if (!this.file) return this.claimMap(this.mem, cwd, now, intervalMs);
		const file = this.file;
		return withFileLock(`${file}.lock`, () => {
			let map = new Map<string, number>();
			try {
				map = new Map(Object.entries(JSON.parse(fs.readFileSync(file, "utf8"))).map(([k, v]) => [k, Number(v)]));
			} catch {
				/* fresh */
			}
			const ok = this.claimMap(map, cwd, now, intervalMs);
			if (ok) {
				// Slots embed the creating session id, so every session that ever owned a rule left a
				// permanent entry in a file that is read, parsed and rewritten on every tick.
				for (const [k, v] of map) if (now - v > POLL_LEDGER_TTL_MS) map.delete(k);
				writeFileAtomic(file, JSON.stringify(Object.fromEntries(map)));
			}
			return ok;
		});
	}

	private claimMap(map: Map<string, number>, cwd: string, now: number, intervalMs: number): boolean {
		// A stamp from the future (a corrected clock, another machine on a synced $HOME) would block
		// every future poll; treat it as "just now" so the next interval is honoured and no more.
		const last = clampFuture(map.get(cwd), now);
		if (last !== undefined && now - last < intervalMs) return false;
		map.set(cwd, now);
		return true;
	}
}

/* ------------------------------------------------------------- dedup */

/**
 * Dedup window (pie: 5 minutes per harness). With a `file`, the window is shared by every pi
 * process on the machine, so a push that several processes receive is handled exactly once.
 */
export interface DedupHit {
	traceId: string;
	/** The FIRST arrival's policy (pie: audit reports what the winning entry declared). */
	replacementPolicy?: ReplacementPolicy;
}

export class DedupWindow {
	private readonly seen = new Map<string, { at: number; traceId: string; policy?: ReplacementPolicy }>();
	private readonly windowMs: number;
	private readonly file?: string;
	constructor(windowMs: number = DEDUP_WINDOW_MS, file?: string) {
		this.windowMs = windowMs;
		this.file = file;
	}

	/** Returns the previous arrival when `key` was seen inside the window, else records this one. */
	async check(key: string, traceId: string, now = Date.now(), policy?: ReplacementPolicy): Promise<DedupHit | undefined> {
		if (!this.file) return this.checkMap(this.seen, key, traceId, now, policy);
		const file = this.file;
		return withFileLock(`${file}.lock`, () => {
			let map = new Map<string, { at: number; traceId: string; policy?: ReplacementPolicy }>();
			try {
				map = new Map(Object.entries(JSON.parse(fs.readFileSync(file, "utf8"))));
			} catch {
				/* fresh */
			}
			const prev = this.checkMap(map, key, traceId, now, policy);
			writeFileAtomic(file, JSON.stringify(Object.fromEntries(map)));
			return prev;
		});
	}

	private checkMap(map: Map<string, { at: number; traceId: string; policy?: ReplacementPolicy }>, key: string, traceId: string, now: number, policy?: ReplacementPolicy): DedupHit | undefined {
		// A future stamp never ages out of the window on its own, so it would dedup its key forever.
		for (const [k, v] of map) if (clampFuture(v.at, now) === undefined || now - v.at > this.windowMs) map.delete(k);
		const prev = map.get(key);
		if (prev) return { traceId: prev.traceId, replacementPolicy: prev.policy };
		map.set(key, { at: now, traceId, policy });
		return undefined;
	}
}
