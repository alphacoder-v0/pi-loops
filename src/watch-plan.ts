/**
 * A watch from one sentence, as a question: the plan, the card it is shown as, the dialog's title and
 * options, and the one place an answer becomes the stores' fields (`watchChoice`). `cron_create` and
 * `new_trigger` in a person's own turn write a proposal (design 2.5); every surface draws this
 * question from the record (`planOf`), and `answerProposal` is the one way an answer lands: P2 sets
 * it up, P3 removes it, each only while it is still proposed.
 */
import { createHash } from "node:crypto";
import { dangerousCommandReason } from "./danger.ts";
import { previewRedacted, redact } from "./redact.ts";
import type { RequestStore, Row, UnclaimedRow } from "./requests.ts";
import { computeNext, formatDuration, formatLocal, formatSchedule, stamp } from "./schedule.ts";
import type { JobStore, LoopJob } from "./store.ts";
import type { CreateJobInput } from "./tools.ts";
import { type DynamicTriggerRule, type TriggerStore, auditRule } from "./triggers.ts";

export type WatchWhere = "chat" | "inbox";
/** What the person cannot change on the card. `stateful` and `verify` follow the answer, so nothing holds the same choice twice; `verify` here is only what the model asked for, the first option's default. */
export type JobDraft = Omit<CreateJobInput, "stateful" | "recipe" | "proposed">;
export interface RuleDraft {
	condition: string;
	action: string;
	cwd: string;
	sessionId?: string;
	model?: string;
	thinking?: string;
}
export type WatchPlan =
	| { kind: "schedule"; job: JobDraft; where: WatchWhere }
	| { kind: "rule"; rule: RuleDraft; where: WatchWhere; once: boolean };

/** What the card shows, computed once here: the page parses no schedule. */
export interface WatchCard {
	kind: WatchPlan["kind"];
	/** "every day at 09:00" for a schedule; the condition for a rule. */
	when: string;
	/** A schedule's next run, in local time. */
	next?: string;
	/** A rule: how often the background looks (`[triggers] poll_interval_secs`). */
	looksEverySecs?: number;
	/** The action, whole, redacted: the card is the consent, so it shows all of what would run. */
	does: string;
	/** A loop that asks for a checker: each finding is reviewed before it enters the inbox. */
	verify?: boolean;
	/** Why the unattended policy would refuse the action's command, when it would. */
	danger?: string;
	/** The terminal line that would do the same, whole and redacted. */
	command: string;
}
/** A schedule in words, for the card's first row; an expression with no short reading is shown as it is. */
export function scheduleWords(schedule: LoopJob["schedule"]): string {
	if (schedule.kind !== "cron") return formatSchedule(schedule);
	const f = schedule.expr.trim().split(/\s+/);
	if (f.length !== 5) return schedule.expr;
	const [minute, hour, dom, month, dow] = f;
	const plain = (v: string) => /^\d{1,2}$/.test(v);
	const hhmm = () => `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
	if (plain(minute) && plain(hour) && dom === "*" && month === "*") {
		if (dow === "*") return `every day at ${hhmm()}`;
		if (dow === "1-5" || dow === "mon-fri") return `weekdays at ${hhmm()}`;
		if (dow === "1" || dow === "mon") return `every Monday at ${hhmm()}`;
	}
	const step = /^\*\/(\d+)$/.exec(minute);
	if (step && hour === "*" && dom === "*" && month === "*" && dow === "*") return `every ${step[1]} minutes`;
	if (minute === "0" && hour === "*" && dom === "*" && month === "*" && dow === "*") return "every hour";
	return schedule.expr;
}

const BACKTICK = String.fromCharCode(96);
const CODE_SPAN = new RegExp(`${BACKTICK}([^${BACKTICK}]+)${BACKTICK}`, "g");

/** The unattended policy's reason over the action and each `code span` in it, when there is one. */
export function actionDanger(action: string, home?: string): string | undefined {
	const candidates = [action, ...[...action.matchAll(CODE_SPAN)].map((m) => m[1])];
	for (const c of candidates) {
		const reason = dangerousCommandReason(c, home);
		if (reason) return reason;
	}
	return undefined;
}

/** The terminal line that would do the same, whole and redacted: one line, since that is how it would be typed. */
const oneLine = (text: string) => redact(text).replace(/\s+/g, " ").trim();

/** What the card says, from the plan: the schedule in words and its next run, or the condition and how often the background looks. */
export function planCard(plan: WatchPlan, ctx: { now: number; pollSecs: number; home?: string }): WatchCard {
	if (plan.kind === "schedule") {
		const next = computeNext({ schedule: plan.job.schedule, createdAt: ctx.now }, ctx.now);
		const spec = plan.job.schedule.kind === "cron" ? plan.job.schedule.expr : plan.job.schedule.kind === "every" ? `every ${formatDuration(plan.job.schedule.ms)}` : `at ${stamp(plan.job.schedule.at).slice(0, 16)}`;
		return {
			kind: "schedule",
			when: scheduleWords(plan.job.schedule),
			next: next === undefined ? undefined : formatLocal(next),
			does: redact(plan.job.prompt),
			verify: plan.job.verify || undefined,
			danger: actionDanger(plan.job.prompt, ctx.home),
			command: oneLine(`/cron add${plan.where === "inbox" ? " --stateful" : ""}${plan.job.name ? ` --name ${plan.job.name}` : ""} "${spec}" ${plan.job.prompt}`),
		};
	}
	return {
		kind: "rule",
		when: redact(plan.rule.condition),
		looksEverySecs: ctx.pollSecs,
		does: redact(plan.rule.action),
		danger: actionDanger(plan.rule.action, ctx.home),
		command: oneLine(`/new-trigger when ${plan.rule.condition}, ${plan.rule.action}`),
	};
}

/** The dialog's first line: how the page tells a watch question from any other select. */
export const WATCH_ASK_HEAD = "Set up this watch?";
export const WATCH_CANCEL = "Cancel";

/** "every 10 minutes": how often the background looks, as the card says it. */
function looksWords(secs: number): string {
	return secs >= 120 ? `every ${Math.round(secs / 60)} minutes` : secs === 60 ? "every minute" : `every ${secs} seconds`;
}

/** The card's rows, as label and value: what a terminal's question and the page's card both show. */
function cardRows(card: WatchCard): [string, string][] {
	const rows: [string, string][] = [];
	if (card.kind === "rule") {
		rows.push(["Waits for", card.when], ["Looks", looksWords(card.looksEverySecs ?? 600)]);
		rows.push(["Then", card.does]);
	} else {
		rows.push(["Runs", `${card.when}${card.next ? ` · next ${card.next}` : ""}`], ["Does", card.does]);
	}
	if (card.danger) rows.push(["Careful", `When this runs and reaches ${card.danger}, pi-loops does not run it: it asks you in the inbox and goes on without it.`]);
	rows.push(["Command", card.command]);
	return rows;
}

/**
 * The dialog's title: the head line, then the card's rows as `Label: value`, the same text a
 * terminal shows. A value's further lines are indented two spaces, so a line inside an action never
 * reads as a row of its own.
 */
export function askTitle(card: WatchCard): string {
	return [WATCH_ASK_HEAD, ...cardRows(card).map(([label, value]) => `${label}: ${value.replace(/\r?\n/g, "\n  ")}`)].join("\n");
}

/** A yes, as the card's choices: where the result goes, whether a rule fires once, whether a loop's findings are checked. */
export type WatchChoice = { verdict: "cancel" } | { verdict: "set"; where: WatchWhere; once: boolean; checks: boolean };
export type SetChoice = Extract<WatchChoice, { verdict: "set" }>;

const WHERE_WORDS: Record<WatchWhere, string> = { chat: "this conversation", inbox: "inbox" };
const SCHEDULE_CHOICES: SetChoice[] = [
	{ verdict: "set", where: "inbox", once: true, checks: false },
	{ verdict: "set", where: "inbox", once: true, checks: true },
	{ verdict: "set", where: "chat", once: true, checks: false },
];
const RULE_CHOICES: SetChoice[] = [
	{ verdict: "set", where: "chat", once: true, checks: false },
	{ verdict: "set", where: "chat", once: false, checks: false },
	{ verdict: "set", where: "inbox", once: true, checks: false },
	{ verdict: "set", where: "inbox", once: false, checks: false },
];
function optionText(kind: WatchPlan["kind"], c: SetChoice): string {
	const extra = kind === "rule" ? (c.once ? " · once" : " · every time") : c.checks ? " · with checks" : "";
	return `Set it up · ${WHERE_WORDS[c.where]}${extra}`;
}
/** Every answer that sets a watch up, and what it means: the whole vocabulary, so nothing else parses. */
const VOCABULARY = new Map<string, SetChoice>([...SCHEDULE_CHOICES.map((c) => [optionText("schedule", c), c] as const), ...RULE_CHOICES.map((c) => [optionText("rule", c), c] as const)]);

/**
 * The dialog's options: one per combination of the card's choices, so the page's chips are the axes
 * of this set and Set it up sends the one option they name. The same strings every time; the plan's
 * own defaults come first, which is what a terminal's selector highlights and the page's chips start on.
 */
export function watchOptions(plan: WatchPlan): string[] {
	const all = plan.kind === "rule" ? RULE_CHOICES : SCHEDULE_CHOICES;
	const first = plan.kind === "rule" ? all.find((c) => c.where === plan.where && c.once === plan.once)! : all.find((c) => c.where === plan.where && c.checks === (plan.where === "inbox" && plan.job.verify === true))!;
	return [first, ...all.filter((c) => c !== first)].map((c) => optionText(plan.kind, c)).concat(WATCH_CANCEL);
}

/** The answer pi's select gave (`undefined` for Esc, an abort or the timeout), as the card's choices. Anything outside the vocabulary is a cancel. */
export function watchChoice(answer: string | undefined): WatchChoice {
	return (answer !== undefined && VOCABULARY.get(answer)) || { verdict: "cancel" };
}

/** A proposed job or rule: the record its question is drawn from. */
export type Proposal = { kind: "schedule"; job: LoopJob } | { kind: "rule"; rule: DynamicTriggerRule };

/** What the question names a proposal by: a job's name, else its id; a rule's id. */
export function proposalLabel(p: Proposal): string {
	return p.kind === "schedule" ? (p.job.name ?? p.job.id) : p.rule.id;
}

/** The question a proposal asks, from its record alone, so it is the same on every surface, after a reload and after a restart. */
export function planOf(p: Proposal): WatchPlan {
	if (p.kind === "rule") {
		const r = p.rule;
		return { kind: "rule", rule: { condition: r.condition, action: r.action, cwd: r.cwd, sessionId: r.createdBy?.sessionId, model: r.model, thinking: r.thinking }, where: r.promoteToChat ? "chat" : "inbox", once: r.fireOnce };
	}
	const j = p.job;
	return { kind: "schedule", job: { schedule: j.schedule, prompt: j.prompt, name: j.name, cwd: j.cwd, verify: j.verify, catchUp: j.catchUp, model: j.model, thinking: j.thinking, tools: j.tools, timeoutMs: j.timeoutMs, checkerModel: j.checkerModel }, where: j.stateful ? "inbox" : "chat" };
}

/** A proposal as the page draws it (`GET /watch`): the terminal's rows without its Command line, and the options in the order the terminal offers them. */
export interface ProposalCard {
	kind: Proposal["kind"];
	id: string;
	/** The conversation it was proposed in, where its card is drawn and its receipt lands. */
	session: string;
	at: string;
	label: string;
	rows: [string, string][];
	options: string[];
}

/** The card of a record that is still proposed; undefined for one that is not. Every text is redacted as `askTitle`'s. */
export function proposalCard(p: Proposal, ctx: { now: number; pollSecs: number; home?: string }): ProposalCard | undefined {
	const record = p.kind === "schedule" ? p.job : p.rule;
	if (!record.proposed) return undefined;
	const plan = planOf(p);
	const rows = cardRows(planCard(plan, ctx)).filter(([label]) => label !== "Command");
	return { kind: p.kind, id: record.id, session: record.proposed.session, at: record.proposed.at, label: redact(proposalLabel(p)), rows, options: watchOptions(plan) };
}

/**
 * P2's one patch, applied to the record under its store's lock while `proposed` is set: the fields
 * the choice names, `enabled`, and no `proposed`. A job that becomes a loop belongs to no
 * conversation and keeps the model captured when it was proposed; one that becomes a plain job
 * belongs to the conversation it was proposed in and runs on that conversation's model. A job's
 * schedule counts from the answer, so a slot that passed while it waited is not owed.
 */
export function proposalPatch(p: Proposal, choice: SetChoice, now: number): void {
	if (p.kind === "rule") {
		p.rule.fireOnce = choice.once;
		p.rule.promoteToChat = choice.where === "chat";
		p.rule.enabled = true;
		delete p.rule.proposed;
		return;
	}
	const job = p.job;
	const stateful = choice.where === "inbox";
	if (stateful !== job.stateful) job.catchUp = stateful;
	job.stateful = stateful;
	if (stateful) delete job.sessionId;
	else {
		job.sessionId = job.proposed?.session;
		delete job.model;
		delete job.thinking;
	}
	if (stateful && choice.checks) job.verify = true;
	else {
		delete job.verify;
		delete job.checkerModel;
	}
	job.createdAt = stamp(now);
	job.enabled = true;
	delete job.disabled;
	delete job.proposed;
}

/** The receipt's id: one per proposal, so a second writer finds it there (`appendIfAbsent`). */
export function receiptRowId(id: string): `rcp-${string}` {
	return `rcp-${createHash("sha256").update(`proposal | ${id}`).digest("hex").slice(0, 32)}`;
}

/** What the model reads at its next turn in the conversation the watch was proposed in. */
function receiptText(id: string, p: Proposal, choice: WatchChoice, now: number): string {
	const head = `[Trigger ${id}] The person answered "${WATCH_ASK_HEAD}": `;
	if (choice.verdict === "cancel") return `${head}${WATCH_CANCEL}.\nThe watch was removed and nothing runs. Do not do the action now.`;
	const answered = `${head}${optionText(p.kind, choice)}.`;
	if (p.kind === "rule") {
		const r = p.rule;
		return `${answered}\ndynamic trigger ${r.id} is set up: it waits for ${previewRedacted(r.condition, 200)}, ${r.fireOnce ? "once" : "every time"}. ${r.promoteToChat ? "Its result appears in this conversation." : "Results go to /inbox."}`;
	}
	const j = p.job;
	const next = computeNext({ schedule: j.schedule, createdAt: Date.parse(j.createdAt) }, now);
	const outlet = j.stateful ? `Findings go to /inbox${j.verify ? " after a checker reviews them" : ""}.` : "Its result appears in this conversation.";
	return `${answered}\ncron job ${j.id}${j.name ? ` "${j.name}"` : ""} is set up: ${scheduleWords(j.schedule)}, next run ${next === undefined ? "—" : formatLocal(next)}. ${outlet}`;
}

/** The receipt row (design 2.5): an append to the proposal's conversation, with no finding and no turn. */
export function receiptRow(p: Proposal, session: string, choice: WatchChoice, now: number, by: Row["created_by"]): UnclaimedRow {
	const record = p.kind === "schedule" ? p.job : p.rule;
	const id = receiptRowId(record.id);
	return { v: 3, id, lane: session, kind: "input", source: "answer", mode: "none", wake: "append", payload: { text: receiptText(id, p, choice, now), cwd: record.cwd }, created_at: stamp(now), created_by: by, attempts: 0 };
}

export type WatchAnswered =
	| { outcome: "set"; proposal: Proposal; line: string }
	| { outcome: "cancelled"; proposal: Proposal; line: string }
	| { outcome: "already"; was: "set up" | "cancelled"; line: string };

export interface ProposalStores {
	jobs: Pick<JobStore, "mutate">;
	rules: Pick<TriggerStore, "mutate" | "appendAudit">;
	requests: Pick<RequestStore, "appendIfAbsent">;
}

export interface AnswerContext {
	now(): number;
	by: Row["created_by"];
	/** Who answered, for the audit: `slash` in a terminal, `page` on the page. */
	actor: "slash" | "page";
	/** A job's audit line where this process writes it (a window's session entry, the background's audit). */
	auditJob(op: "enable" | "remove", before: LoopJob, after: LoopJob | undefined): void;
}

const ALREADY = (was: "set up" | "cancelled"): WatchAnswered => ({ outcome: "already", was, line: `already answered: ${was}` });

/**
 * P2 (a yes) or P3 (Cancel), in design 2.5's order: (a) the one write under the store's lock, which
 * applies only while `proposed` is set, then the audit line; (b) the receipt, by this process only
 * when its write applied. A second answer finds `proposed` gone (set up) or the record gone
 * (cancelled), changes nothing and writes no receipt.
 */
export async function answerProposal(stores: ProposalStores, ref: { kind: Proposal["kind"]; id: string }, choice: WatchChoice, ctx: AnswerContext): Promise<WatchAnswered> {
	const now = ctx.now();
	type Applied = { before: Proposal; after?: Proposal } | "set up" | "cancelled";
	const applied: Applied =
		ref.kind === "schedule"
			? await stores.jobs.mutate<Applied>((jobs) => {
					const job = jobs.find((j) => j.id === ref.id);
					if (!job) return { jobs, result: "cancelled" };
					if (!job.proposed) return { jobs, result: "set up" };
					const before: Proposal = { kind: "schedule", job: structuredClone(job) };
					if (choice.verdict === "cancel") return { jobs: jobs.filter((j) => j !== job), result: { before } };
					proposalPatch({ kind: "schedule", job }, choice, now);
					return { jobs, result: { before, after: { kind: "schedule", job } } };
				})
			: await stores.rules.mutate((rules): Applied => {
					const rule = rules.find((r) => r.id === ref.id);
					if (!rule) return "cancelled";
					if (!rule.proposed) return "set up";
					const before: Proposal = { kind: "rule", rule: structuredClone(rule) };
					if (choice.verdict === "cancel") {
						rules.splice(rules.indexOf(rule), 1);
						return { before };
					}
					proposalPatch({ kind: "rule", rule }, choice, now);
					return { before, after: { kind: "rule", rule } };
				});
	if (typeof applied === "string") return ALREADY(applied);
	const { before, after } = applied;
	const op = after ? "enable" : "remove";
	if (before.kind === "schedule") ctx.auditJob(op, before.job, after?.kind === "schedule" ? after.job : undefined);
	else auditRule(stores.rules, op, ctx.actor, after?.kind === "rule" ? after.rule : before.rule);
	const session = before.kind === "schedule" ? before.job.proposed!.session : before.rule.proposed!.session;
	stores.requests.appendIfAbsent(receiptRow(after ?? before, session, choice, now, ctx.by));
	const label = redact(proposalLabel(before));
	if (!after || choice.verdict === "cancel") return { outcome: "cancelled", proposal: before, line: `cancelled: ${label} is removed and nothing ran` };
	const when = after.kind === "schedule" ? scheduleWords(after.job.schedule) : `waits for ${previewRedacted(after.rule.condition, 60)}`;
	return { outcome: "set", proposal: after, line: `set up: ${label} · ${when} · ${optionText(after.kind, choice).slice("Set it up · ".length)}` };
}

/**
 * `/cron enable` and `/triggers enable` on a proposal: the same question, through pi's selector, and
 * its answer. Esc, or an answer the question did not offer, leaves it proposed.
 */
export async function askProposal(p: Proposal, select: (title: string, options: string[]) => Promise<string | undefined>, stores: ProposalStores, ctx: AnswerContext & { pollSecs: number; home?: string }): Promise<WatchAnswered | { outcome: "still"; line: string }> {
	const plan = planOf(p);
	const options = watchOptions(plan);
	const answer = await select(askTitle(planCard(plan, { now: ctx.now(), pollSecs: ctx.pollSecs, home: ctx.home })), options);
	if (answer === undefined || !options.includes(answer)) return { outcome: "still", line: `${proposalLabel(p)} is still proposed` };
	const ref = { kind: p.kind, id: p.kind === "schedule" ? p.job.id : p.rule.id };
	return answerProposal(stores, ref, watchChoice(answer), ctx);
}
