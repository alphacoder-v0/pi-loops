/**
 * The activity strip's items and the attention counts, computed when the page asks: runs from
 * `runs.jsonl`, rule results from `triggers-audit.jsonl` joined to their findings in `inbox.jsonl`.
 * There is no store of its own, so nothing here has to be kept in step with the files it reads.
 * Pure: the caller reads the files, and this decides what they say.
 */
import type { InboxEntry } from "./inbox.ts";
import { ruleResultText, splitFinding } from "./inbox-card.ts";
import { failingJobs } from "./job-health.ts";
import { redact } from "./redact.ts";
import { runCardFor, runCardsHere } from "./run-card.ts";
import type { LoopJob, RunRecord } from "./store.ts";
import type { AuditRecord } from "./triggers.ts";

/** Items the strip is given at most; `more` counts the rest of the window. */
export const ACTIVITY_LIMIT = 100;
/** How far back the strip looks. */
export const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Machine-wide new decisions the page is told about, newest first, for its notification. */
export const NEW_DECISIONS_LIMIT = 20;
/** A strip row's text, clipped so a row stays one line. */
const ACTIVITY_TEXT_CHARS = 160;

export interface ActivityItem {
	/** The run id, or the rule check's trace id. */
	id: string;
	kind: "run" | "rule";
	/** The loop, or the first matched rule (`name` is its condition); `gone` when it is no longer there. */
	source: { id: string; name?: string; gone: boolean };
	finishedAt: string;
	ok: boolean;
	/** The run was stopped (a person, a quit, a restart): no failure, no card. */
	stopped: boolean;
	/** Set when a person stopped it, which the strip says as "stopped by you". */
	stoppedBy?: "person";
	/** A run: the findings it filed. A rule check: the findings its result is. */
	findings: number;
	seconds: number;
	costUsd?: number;
	/** Redacted and clipped. */
	error?: string;
	/** A rule check: the start of what it said, redacted and clipped. */
	text?: string;
	/** The run wrote a card into its conversation (src/run-card.ts). */
	carded: boolean;
	/** A rule check: its findings, so a row can point at the card. */
	inboxIds: string[];
	/** A rule check: the result also went to a conversation (`promote_to_chat`). A run: its card is in this conversation. */
	inChat: boolean;
	/** The run's loop or the rule was made in the conversation asking. */
	fromThisConversation: boolean;
}

export interface Attention {
	/** New decisions and new news in the project asked about (the whole machine when none is). */
	decisions: number;
	news: number;
	/** New decisions on the whole machine, newest first. */
	newDecisions: Array<{ id: string; cwd: string; headline: string }>;
	/** Loops failing three or more times in a row; `key` is the same for the whole streak. */
	failing: Array<{ jobId: string; name?: string; streak: number; key: string }>;
	/** Only when today's spend has reached the cap. */
	budget?: { day: string; spent: number; cap: number };
}

export interface ActivityInput {
	runs: readonly RunRecord[];
	audit: readonly AuditRecord[];
	findings: readonly InboxEntry[];
	jobs: ReadonlyMap<string, { name?: string; createdBy?: { sessionId?: string } }>;
	rules: ReadonlyMap<string, { condition: string; createdBy?: { sessionId?: string } }>;
	/** The project asked about, and how a path is matched to it; no cwd is the whole machine. */
	cwd?: string;
	inProject: (entryCwd: string, cwd: string) => boolean;
	sessionId?: string;
	sinceMs: number;
	limit?: number;
}

/** Text from a file another process wrote, as one redacted line: a field of the wrong type is no text. */
const clip = (text: unknown, n = ACTIVITY_TEXT_CHARS) => {
	const one = redact(typeof text === "string" ? text : "").replace(/\s+/g, " ").trim();
	return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const secondsBetween = (from: string | undefined, to: string) => {
	const s = from ? Math.round((Date.parse(to) - Date.parse(from)) / 1000) : 0;
	return Number.isFinite(s) && s > 0 ? s : 0;
};

/** Whether a path is in `cwd`'s project (always, with no cwd), asked once per distinct path. */
function projectMatch(cwd: string | undefined, inProject: (entryCwd: string, cwd: string) => boolean): (entryCwd: unknown) => boolean {
	const known = new Map<string, boolean>();
	return (entryCwd) => {
		if (cwd === undefined) return true;
		if (typeof entryCwd !== "string") return false;
		let yes = known.get(entryCwd);
		if (yes === undefined) known.set(entryCwd, (yes = inProject(entryCwd, cwd)));
		return yes;
	};
}

/** The strip's items, newest first, at most `limit`; `more` counts the rest, `failed` the failures among all. */
export function activityFrom(input: ActivityInput): { items: ActivityItem[]; more: number; failed: number } {
	// Matching a project resolves paths on disk, and this runs on every page's poll: once per distinct
	// cwd, and only for a record inside the window.
	const here = projectMatch(input.cwd, input.inProject);
	const recent = (at: string | undefined) => typeof at === "string" && Date.parse(at) >= input.sinceMs;
	const items: ActivityItem[] = [];
	for (const r of input.runs) {
		if (!r.stateful || typeof r.runId !== "string" || !recent(r.finishedAt) || !here(r.cwd)) continue;
		const job = input.jobs.get(r.jobId);
		items.push({
			id: r.runId,
			kind: "run",
			source: { id: String(r.jobId), name: job?.name ?? (typeof r.jobName === "string" ? r.jobName : undefined), gone: !job },
			finishedAt: r.finishedAt,
			ok: r.ok === true,
			stopped: !!r.aborted,
			...(r.stoppedBy === "person" ? { stoppedBy: "person" as const } : {}),
			findings: typeof r.findings === "number" ? r.findings : 0,
			seconds: secondsBetween(r.startedAt, r.finishedAt),
			...(typeof r.usage?.cost === "number" && r.usage.cost ? { costUsd: r.usage.cost } : {}),
			...(!r.ok && r.error ? { error: clip(r.error) } : {}),
			carded: runCardFor(r) === "card",
			inboxIds: [],
			// Where its card is: a run someone asked for cards where they asked, not where its loop was made.
			inChat: runCardFor(r) === "card" && runCardsHere([r], { sessionId: input.sessionId, inProject: here }).length > 0,
			fromThisConversation: !!input.sessionId && r.forSession === input.sessionId,
		});
	}
	// A rule check is the `running` row and its result; a result that matched nothing is not news.
	const started = new Map<string, string>();
	const inChat = new Set<string>();
	for (const a of input.audit) {
		if (a.type === "trigger_result" && a.state === "running") started.set(a.traceId, a.ts);
		if (a.type === "trigger_promotion" && (a.state === "promoted" || a.state === "appended")) inChat.add(a.traceId);
	}
	const filed = new Map<string, InboxEntry[]>();
	for (const f of input.findings) if (typeof f.source === "string" && f.source.startsWith("trigger:")) filed.set(f.run_id, [...(filed.get(f.run_id) ?? []), f]);
	for (const a of input.audit) {
		if (a.type !== "trigger_result" || a.sourceLabel !== "local:dynamic" || typeof a.traceId !== "string" || !recent(a.ts) || !here(a.cwd)) continue;
		// This project's rules the check named (src/trigger-runtime.ts), not every id it wrote.
		const matched = Array.isArray(a.details?.matched_rule_ids) ? (a.details.matched_rule_ids as unknown[]).filter((id): id is string => typeof id === "string") : [];
		if (!(a.state === "failed" || (a.state === "completed" && matched.length))) continue;
		const ruleId = matched[0] ?? "";
		const rule = ruleId ? input.rules.get(ruleId) : undefined;
		const findings = filed.get(a.traceId) ?? [];
		const cost = typeof a.details?.cost_usd === "number" ? a.details.cost_usd : 0;
		items.push({
			id: a.traceId,
			kind: "rule",
			source: { id: ruleId, ...(rule ? { name: clip(rule.condition, 80) } : {}), gone: !!ruleId && !rule },
			finishedAt: a.ts,
			ok: a.state === "completed",
			stopped: false,
			findings: findings.length,
			seconds: secondsBetween(started.get(a.traceId), a.ts),
			...(cost ? { costUsd: cost } : {}),
			...(a.state === "failed" ? { error: clip(a.summary) || "the check failed" } : { text: clip(ruleResultText(typeof a.summary === "string" ? a.summary : "")) }),
			carded: false,
			inboxIds: findings.map((f) => f.id),
			inChat: inChat.has(a.traceId),
			fromThisConversation: !!input.sessionId && rule?.createdBy?.sessionId === input.sessionId,
		});
	}
	items.sort((x, y) => y.finishedAt.localeCompare(x.finishedAt));
	const limit = input.limit ?? ACTIVITY_LIMIT;
	return { items: items.slice(0, limit), more: Math.max(0, items.length - limit), failed: items.filter((i) => !i.ok && !i.stopped).length };
}

/** The title's counts, the hidden tab's notifications and the budget line, from the same files. */
export function attentionFrom(input: {
	findings: readonly InboxEntry[];
	jobs: readonly LoopJob[];
	cwd?: string;
	inProject: (entryCwd: string, cwd: string) => boolean;
	budget?: { spent: number; cap: number; over: boolean };
	day: string;
}): Attention {
	const fresh = input.findings.filter((f) => f.status === "new");
	const inHere = projectMatch(input.cwd, input.inProject);
	// A finding with no cwd is in every project, as `/inbox` lists it (inbox.ts belongsToProject).
	const here = fresh.filter((f) => !f.cwd || inHere(f.cwd));
	const decisions = fresh.filter((f) => f.kind === "checkpoint");
	return {
		decisions: here.filter((f) => f.kind === "checkpoint").length,
		news: here.filter((f) => f.kind !== "checkpoint").length,
		newDecisions: decisions
			.slice(-NEW_DECISIONS_LIMIT)
			.reverse()
			.map((f) => ({ id: f.id, cwd: f.cwd, headline: clip(splitFinding(clip(f.text, 500), "checkpoint").headline, 120) })),
		failing: failingJobs([...input.jobs]).map((j) => ({ jobId: j.id, ...(j.name ? { name: j.name } : {}), streak: j.consecutiveFailures ?? 0, key: `${j.id}:${(j.runCount ?? 0) - (j.consecutiveFailures ?? 0)}` })),
		...(input.budget?.over ? { budget: { day: input.day, spent: input.budget.spent, cap: input.budget.cap } } : {}),
	};
}

/** The attention block for a conversation in no project known: what is said of the whole machine, and no project's counts. */
export function machineWide(a: Attention): Pick<Attention, "newDecisions" | "failing" | "budget"> {
	return { newDecisions: a.newDecisions, failing: a.failing, ...(a.budget ? { budget: a.budget } : {}) };
}
