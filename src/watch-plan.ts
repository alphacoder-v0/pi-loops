/**
 * A watch from one sentence, as a question: what `cron_create` and `new_trigger` ask the person
 * through pi's own `select` before they create anything, in the person's own turn on every surface
 * (docs/design.md decision 24). The plan, the card it is shown as, the dialog's title and options,
 * and the one place an answer becomes the stores' fields (`watchChoice`). Pure, beside tools.ts,
 * the job-edit.ts pattern: the tool asks, maps the answer and creates.
 */
import { dangerousCommandReason } from "./danger.ts";
import { redact } from "./redact.ts";
import { computeNext, formatDuration, formatLocal, formatSchedule, stamp } from "./schedule.ts";
import type { LoopJob } from "./store.ts";
import type { CreateJobInput } from "./tools.ts";

export type WatchWhere = "chat" | "inbox";
/** What the person cannot change on the card. `stateful` and `verify` follow the answer, so nothing holds the same choice twice; `verify` here is only what the model asked for, the first option's default. */
export type JobDraft = Omit<CreateJobInput, "stateful" | "recipe">;
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
/** How long the question waits for the person before pi cancels it and the tool says so. */
export const WATCH_ASK_MS = 30 * 60_000;
export const WATCH_CANCEL = "Cancel";

/** "every 10 minutes": how often the background looks, as the card says it. */
function looksWords(secs: number): string {
	return secs >= 120 ? `every ${Math.round(secs / 60)} minutes` : secs === 60 ? "every minute" : `every ${secs} seconds`;
}

/**
 * The dialog's title: the head line, then the card's rows as `Label: value`, the same text a
 * terminal shows and the page draws its card from. A value's further lines are indented two spaces,
 * so a line inside an action never reads as a row of its own.
 */
export function askTitle(card: WatchCard): string {
	const rows: [string, string][] = [];
	if (card.kind === "rule") {
		rows.push(["Waits for", card.when], ["Looks", looksWords(card.looksEverySecs ?? 600)]);
		rows.push(["Then", card.does]);
	} else {
		rows.push(["Runs", `${card.when}${card.next ? ` · next ${card.next}` : ""}`], ["Does", card.does]);
	}
	if (card.danger) rows.push(["Careful", `When this runs nobody is asked: pi-loops refuses ${card.danger} and does the safe part.`]);
	rows.push(["Command", card.command]);
	return [WATCH_ASK_HEAD, ...rows.map(([label, value]) => `${label}: ${value.replace(/\r?\n/g, "\n  ")}`)].join("\n");
}

/** A yes, as the card's choices: where the result goes, whether a rule fires once, whether a loop's findings are checked. */
export type WatchChoice = { verdict: "cancel" } | { verdict: "set"; where: WatchWhere; once: boolean; checks: boolean };
type SetChoice = Extract<WatchChoice, { verdict: "set" }>;

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
