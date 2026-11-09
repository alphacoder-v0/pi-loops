/**
 * What `/triggers` prints, out of the unimportable extension so a test can read the lines a person
 * reads: the rule rows and the status block. Everything it reads is a parameter.
 */
import { projectLabel } from "./conversation-rows.ts";
import { ruleFailureMark } from "./job-health.ts";
import { previewRedacted } from "./redact.ts";
import { formatLocal } from "./schedule.ts";
import { shortSessionId } from "./session-head.ts";
import type { DynamicTriggerRule } from "./triggers.ts";

export interface RuleLinesOptions {
	/** `/triggers rules` numbers this project's rules; `--all` lists every project's with a dash. */
	numbered: boolean;
	/** The conversation listing them: a rule another conversation created says which. */
	sessionId?: string;
	cwd: string;
	home: string;
	sameProject: (a: string, b: string) => boolean;
}

/**
 * One row a rule. The marks say only where the rule differs from the Watch card's first answers
 * (shown here, once): `disabled`, `every time`, `to inbox`, and when it fired.
 */
export function ruleLines(rules: readonly DynamicTriggerRule[], opts: RuleLinesOptions): string[] {
	return rules.map((r, i) => {
		const marks = [r.enabled ? "" : "disabled", r.fireOnce ? "" : "every time", r.promoteToChat ? "" : "to inbox", r.firedAt ? `fired ${formatLocal(Date.parse(r.firedAt))}` : ""].filter(Boolean).join(", ");
		const head = opts.numbered ? `${String(i + 1).padStart(2)}. ` : "  - ";
		const failing = ruleFailureMark(r);
		const elsewhere = opts.sameProject(r.cwd, opts.cwd) ? "" : `  (${projectLabel(r.cwd, opts.home)})`;
		const other = r.createdBy?.sessionId && r.createdBy.sessionId !== opts.sessionId ? `  (session ${shortSessionId(r.createdBy.sessionId)})` : "";
		return `${head}${r.id}${marks ? ` [${marks}]` : ""}${failing ? ` ${failing}` : ""} when ${previewRedacted(r.condition, 80)} -> ${previewRedacted(r.action, 80)}${elsewhere}${other}`;
	});
}

export interface TriggerStatusInput {
	rules: readonly Pick<DynamicTriggerRule, "enabled">[];
	pollIntervalSecs: number;
	/** Whether pi-loops runs in the background: it is what checks the rules. */
	running: boolean;
	lastCheck?: { at: string; cwd: string; outcome: string };
	home: string;
	pushSources: number;
	configError?: string;
	sources: { total: number; connected: number; attention: number };
	runningCount: number;
	deduplicated: number;
	cyclesStopped: number;
	rulesFile: string;
	auditFile: string;
	persistenceError?: string;
}

/** `/triggers status`, in plain words. */
export function triggerStatusLines(i: TriggerStatusInput): string[] {
	const disabled = i.rules.filter((r) => !r.enabled).length;
	return [
		`Rules: ${i.rules.length}${disabled ? `, ${disabled} disabled` : ""}`,
		`Checks: every ${i.pollIntervalSecs}s while a rule is on, by pi-loops in the background${i.running ? "" : " — not running"}`,
		i.lastCheck ? `Last check: ${formatLocal(Date.parse(i.lastCheck.at)).slice(11)} in ${projectLabel(i.lastCheck.cwd, i.home)} — ${i.lastCheck.outcome}` : "Last check: none yet",
		`MCP push sources: ${i.pushSources}${i.configError ? ` (config error: ${i.configError})` : ""}`,
		`Sources: ${i.sources.total}, ${i.sources.connected} connected${i.sources.attention ? `, ${i.sources.attention} need attention` : ""}`,
		`Running ${i.runningCount} · deduplicated ${i.deduplicated} · cycles stopped ${i.cyclesStopped}`,
		`Files: ${projectLabel(i.rulesFile, i.home)}, ${projectLabel(i.auditFile, i.home)} (/triggers audit [N])`,
		...(i.persistenceError ? [`  ! ${i.persistenceError}`] : []),
	];
}
