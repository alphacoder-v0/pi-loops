/**
 * A finding as a person reads it: the one place the stored line of `inbox.jsonl` is split into what
 * the terminal's `/inbox`, `pi-loops inbox list` and the page show. Parsed at read time and never
 * written back, so the stored shape (CONTRACT.md 2.2) does not change.
 *
 * A checkpoint is `<the decision> · waits: <what waits on it> · if not: <what happens if nobody
 * acts>` (docs/recipes.md); a card shows the three parts apart, under the page's words "Waiting on"
 * and "If you don't". News is one finding with a headline. What a yes, a no and a cancel say, and
 * what an answer's state reads as, are decided here too, so every surface says the same thing.
 */
import * as path from "node:path";
import { deadLetterParts } from "./engine.ts";
import { loopLabel } from "./job-lines.ts";
import { type StepRefusal, answerStatus, fromScheduledPrompt, scheduledPromptWords } from "./ask.ts";
import type { InboxEntry, InboxStatus } from "./inbox.ts";
import { type LaneId, parseLane } from "./lane.ts";
import { INBOX_TEXT_MAX_CHARS, capChars } from "./protocol.ts";
import { cardText, redact, screenText } from "./redact.ts";
import type { Row } from "./requests.ts";

export interface InboxCard {
	/** `inb-…`: the only thing a button sends. */
	id: string;
	/** `decision` exactly when the stored kind is `checkpoint`; never read again off the text. */
	kind: "decision" | "news";
	status: InboxStatus;
	/** A decision: the text before `· waits:`. News: the first sentence. Never empty. */
	headline: string;
	/** News only: what follows the first sentence. */
	body?: string;
	/** A decision: between `· waits:` and `· if not:`. */
	waits?: string;
	/** A decision: after `· if not:`; undefined when the loop left the clause out. */
	ifNot?: string;
	/**
	 * A question (a finding with an `ask`): its call, from the ask's fields. Its card is drawn from
	 * these and `ask.title`, never cut from the text, which holds the command and could hold a
	 * `· waits:` of the command's own.
	 */
	question?: { tool: string; command?: string; reason: string };
	/** The checker kept it (✓). */
	verified: boolean;
	verifiedReason?: string;
	/** `rule`: a trigger's result. `undelivered`: a prompt that never reached its conversation (a dead letter). */
	origin: "loop" | "rule" | "undelivered";
	/** The loop that filed it, with its name when the loop still exists, and its label (src/job-lines.ts loopLabel). */
	loop?: { id: string; name?: string; label: string };
	/** A rule check's result: the first rule it matched, with its condition while the rule exists. */
	rule?: { id: string; condition?: string };
	source: string;
	cwd: string;
	createdAt: string;
	runId: string;
	/** The conversation that created the loop: where a claim runs (D3). */
	sessionId?: string;
	/** The finding names its run's transcript. The file is not looked at. */
	hasTranscript: boolean;
	/** `sessionId` is the conversation the card is shown in. */
	fromThisConversation: boolean;
	/** The root of the card's thread (`InboxEntry.re`): the page draws the card under the root's card while that is listed. */
	re?: string;
}

export interface CardContext {
	/** The conversation the card is shown in. */
	here?: string;
	/** A loop's name from jobs.json, or undefined when the loop is gone or has none. */
	loopName(jobId: string): string | undefined;
	/** A rule's condition from triggers.json, or undefined when the rule is gone. */
	ruleCondition?(ruleId: string): string | undefined;
}

/** A rule's condition on a card's origin line, clipped so the line stays one line. */
const RULE_CONDITION_CHARS = 80;

/** The mark `findingKind` reads a checkpoint by (CONTRACT.md 2.6), and the clause after it. */
const WAITS = /(^|\s)·\s*waits:/i;
const IF_NOT = /\s·\s*if not:/i;
/** How far into a news finding its first sentence may end and still be a headline. */
const HEADLINE_MAX_CHARS = 200;

/**
 * The parts of a finding's text. A decision splits at the first `· waits:` and then at the first
 * `· if not:`; a decision with no `· waits:` left (cut by the 500-character cap, or written by hand)
 * keeps its whole text as the headline, and so does one whose headline would be empty. News splits
 * after its first sentence, when that ends within 200 characters.
 */
export function splitFinding(text: string, kind: InboxEntry["kind"]): Pick<InboxCard, "headline" | "body" | "waits" | "ifNot"> {
	if (kind === "checkpoint") {
		const at = WAITS.exec(text);
		if (!at) return { headline: text };
		const headline = text.slice(0, at.index).trim();
		if (!headline) return { headline: text };
		const rest = text.slice(at.index + at[0].length);
		const cut = IF_NOT.exec(rest);
		const waits = (cut ? rest.slice(0, cut.index) : rest).trim();
		const ifNot = cut ? rest.slice(cut.index + cut[0].length).trim() : "";
		return { headline, ...(waits ? { waits } : {}), ...(ifNot ? { ifNot } : {}) };
	}
	const end = /[.!?](?=\s)|[。！？]/.exec(text);
	if (!end || end.index >= HEADLINE_MAX_CHARS) return { headline: text };
	const headline = text.slice(0, end.index + 1).trim();
	const body = text.slice(end.index + 1).trim();
	return body ? { headline, body } : { headline };
}

/**
 * The `matched <rule-id>` a rule check starts what it says with (src/triggers.ts asks for the ids),
 * with more ids after it and the punctuation that ends it. It names the rule, which the card's
 * origin line does already.
 */
const MATCHED_TOKEN = /^\s*`?matched`?\s+`?dyn-[0-9a-f]{32}`?(?:\s*(?:,|and)\s*`?dyn-[0-9a-f]{32}`?)*\s*[.:;,!—–-]*\s*/i;

/** A rule result's text as its card reads it: without the leading `matched <rule-id>`, unless that is all it says. */
export function ruleResultText(text: string): string {
	const rest = text.replace(MATCHED_TOKEN, "");
	return rest || text;
}

/**
 * A question's card parts, from its `ask`: the headline is who asks (`ask.title`), the call's
 * command and reason are fields of their own, and the clauses are the words `questionFinding` of
 * src/ask.ts writes, with who asks as `answerWho` names it. Screened, redacted and on one line, as
 * any card text is.
 */
/** A question's headline, from its `ask`: what a card, the activity strip and a notification show. Never cut from the finding's text. */
export function questionHeadline(ask: NonNullable<InboxEntry["ask"]>): string {
	return cardText(ask.title) || "a run asks";
}

function questionParts(entry: InboxEntry, ask: NonNullable<InboxEntry["ask"]>, ctx: CardContext): Pick<InboxCard, "headline" | "waits" | "ifNot" | "question"> {
	const { tool, command, reason } = ask.call;
	const who = answerWho(entry, ask.lane, ctx.loopName);
	return {
		headline: questionHeadline(ask),
		question: { tool: cardText(tool), ...(command !== undefined ? { command: cardText(command) } : {}), reason: cardText(reason) },
		// A scheduled prompt's question says whose prompt went on (design 6.4), as `questionFinding` wrote it.
		waits: `${fromScheduledPrompt(ask.lane, entry.job_id) ? scheduledPromptWords(who) : who} went on without it`,
		ifNot: "it stays undone",
	};
}

/**
 * One finding as a card, or undefined for a line with no id or no text: `readFinding` turns a
 * line `{}` into an entry with both empty, and a button that sends an empty id names nothing.
 * The text is redacted and capped again, since a line another tool wrote is not bounded. A question
 * is drawn from its `ask` (`questionParts`); `splitFinding` never reads its text.
 */
export function inboxCard(entry: InboxEntry, ctx: CardContext): InboxCard | undefined {
	if (!entry.id || !entry.text) return undefined;
	const text = capChars(cardText(entry.text), INBOX_TEXT_MAX_CHARS);
	const origin = entry.source.startsWith("trigger:") ? "rule" : deadLetterParts(entry) ? "undelivered" : "loop";
	const loopId = origin === "loop" ? entry.job_id : undefined;
	const loopName = loopId ? ctx.loopName(loopId) : undefined;
	// A rule check files its result with the first matched rule's id (src/trigger-runtime.ts); a push
	// with no rule files its source label there, which names no rule.
	const ruleId = origin === "rule" && entry.job_id?.startsWith("dyn-") ? entry.job_id : undefined;
	const condition = ruleId ? ctx.ruleCondition?.(ruleId) : undefined;
	return {
		id: entry.id,
		kind: entry.ask || entry.kind === "checkpoint" ? "decision" : "news",
		status: entry.status,
		...(entry.ask ? questionParts(entry, entry.ask, ctx) : splitFinding(origin === "rule" ? ruleResultText(text) : text, entry.kind)),
		verified: entry.verified === true,
		...(entry.verified_reason ? { verifiedReason: redact(screenText(entry.verified_reason)) } : {}),
		origin,
		...(loopId ? { loop: loopName === undefined ? { id: loopId, label: loopLabel({ id: loopId }) } : { id: loopId, name: loopName, label: loopLabel({ id: loopId, name: loopName }) } } : {}),
		...(ruleId ? { rule: condition ? { id: ruleId, condition: capChars(redact(screenText(condition)).replace(/\s+/g, " "), RULE_CONDITION_CHARS - 1) } : { id: ruleId } } : {}),
		source: entry.source,
		cwd: entry.cwd,
		createdAt: entry.created_at,
		runId: entry.run_id,
		...(entry.session_id ? { sessionId: entry.session_id } : {}),
		hasTranscript: origin !== "rule" && !!entry.transcript,
		fromThisConversation: !!entry.session_id && entry.session_id === ctx.here,
		...(entry.re === undefined ? {} : { re: entry.re }),
	};
}

/** The cards of `entries`, decisions first and each group in the order given (`Inbox.listNew`'s); lines with no id or text are left out. */
export function cardsOf(entries: readonly InboxEntry[], ctx: CardContext): InboxCard[] {
	const cards = entries.flatMap((e) => inboxCard(e, ctx) ?? []);
	return [...cards.filter((c) => c.kind === "decision"), ...cards.filter((c) => c.kind === "news")];
}

/** How far a card's continuation lines are indented under its first line. */
const CLAUSE_INDENT = "       ";

/** What filed a card, as every surface but `inbox --json` names it: a loop's label, else the stored source. */
export function cardOrigin(card: Pick<InboxCard, "loop" | "source">): string {
	return card.loop ? card.loop.label : card.source;
}

/**
 * A card as terminal lines: `head`, the marks, the headline (news: its whole text) and `meta` on
 * the first line; a question's command and reason, then a decision's clauses, on indented lines
 * under it, under the page's words. A clause the loop left out prints nothing: two packaged
 * playbooks leave `if not` out on purpose.
 */
export function cardLines(card: InboxCard, head: string, meta: string): string[] {
	const mark = `${card.kind === "decision" ? "⚑ " : ""}${card.verified ? "✓ " : ""}`;
	const title = card.body === undefined ? card.headline : `${card.headline}${/[。！？]$/.test(card.headline) ? "" : " "}${card.body}`;
	const lines = [`${head}${mark}${title}${meta}`];
	if (card.question?.command !== undefined) lines.push(`${CLAUSE_INDENT}command: ${card.question.command}`);
	if (card.question) lines.push(`${CLAUSE_INDENT}why it asks: ${card.question.reason}`);
	if (card.waits !== undefined) lines.push(`${CLAUSE_INDENT}waiting on: ${card.waits}`);
	if (card.ifNot !== undefined) lines.push(`${CLAUSE_INDENT}if you don't: ${card.ifNot}`);
	return lines;
}

/** The last line `/inbox` gives a new question (design 6.1): the two commands that answer it, by the number on screen. */
export function questionActions(n: number): string {
	return `${CLAUSE_INDENT}/inbox claim ${n} runs it once · /inbox dismiss ${n} [reason] says no`;
}

/** One row of a threaded list. `reply`: drawn under its root. `listed`: one of the list's own entries; a root that is not is shown, unnumbered, only to head its replies. */
export interface ThreadRow<T> {
	entry: T;
	reply: boolean;
	listed: boolean;
}

/**
 * `listed` as threads: each reply (a finding with `re`) right after its root, in list order. A root
 * that is not listed but is in `all` (a question already answered, under its news) heads its
 * replies where the first of them is. A reply whose root is in neither, or whose root is itself a
 * reply, is a row of its own in its place.
 */
export function threads<T extends { id: string; re?: string }>(listed: readonly T[], all: readonly T[] = []): ThreadRow<T>[] {
	const ids = new Set(listed.map((e) => e.id));
	const known = new Map([...all, ...listed].map((e) => [e.id, e]));
	const rootOf = (e: T): string | undefined => {
		const root = e.re === undefined || e.re === e.id ? undefined : known.get(e.re);
		return root && root.re === undefined ? root.id : undefined;
	};
	const replies = new Map<string, T[]>();
	for (const e of listed) {
		const root = rootOf(e);
		if (root) replies.set(root, [...(replies.get(root) ?? []), e]);
	}
	const rows: ThreadRow<T>[] = [];
	const shown = new Set<string>();
	const thread = (root: T, listedRoot: boolean): void => {
		shown.add(root.id);
		rows.push({ entry: root, reply: false, listed: listedRoot });
		for (const reply of replies.get(root.id) ?? []) rows.push({ entry: reply, reply: true, listed: true });
	};
	for (const e of listed) {
		const root = rootOf(e);
		if (root === undefined) thread(e, true);
		else if (!ids.has(root) && !shown.has(root)) thread(known.get(root)!, false);
	}
	return rows;
}

/** The listed entries in the order `threads` shows them: what a number on screen resolves to. */
export function threadOrder<T extends { id: string; re?: string }>(listed: readonly T[], all: readonly T[] = []): T[] {
	return threads(listed, all).flatMap((row) => (row.listed ? [row.entry] : []));
}

/** How far a reply's lines are set in under its root's. */
const REPLY_INDENT = "    ";

/** Terminal lines of threaded rows: `line` draws one entry, with its number when it is listed; a reply's lines are set in. */
export function threadedLines<T>(rows: readonly ThreadRow<T>[], line: (entry: T, n: number | undefined) => string[]): string[] {
	let n = 0;
	return rows.flatMap((row) => {
		const lines = line(row.entry, row.listed ? ++n : undefined);
		return row.reply ? lines.map((l) => `${REPLY_INDENT}${l}`) : lines;
	});
}

/**
 * A card as one line, for a shell: `pi-loops inbox list` prints one line per finding (docs/cli.md),
 * so a script that reads the ids with `awk '{print $1}'` keeps working. The clauses follow the
 * headline on the same line, under the page's words.
 */
export function cardLine(card: InboxCard, head: string, meta: string): string {
	const [first, ...clauses] = cardLines(card, "", "");
	return `${head}${first}${clauses.map((c) => ` · ${c.trim()}`).join("")}${meta}`;
}

/** The reasons a page offers for a dismiss, beside a typed one. Each goes to the loop as said. */
export const DISMISS_CHIPS = ["Not a bug", "Already fixed", "Duplicate", "Too noisy", "Not now"] as const;

/** Whom a dismiss tells: the loop's next run, nobody (and why), or nobody because no reason was given. */
export type DismissOutcome = { told: "loop"; loop: string } | { told: "nobody"; why: "loop-gone" | "rule" } | { told: "silent" };

/**
 * Whom a dismiss with `reason` tells. A loop's finding carries its job id; a trigger's carries the
 * rule's label there, and a rule keeps no notes and has no next run to tell. `loop` is the job
 * that filed it, when it still exists.
 */
export function dismissOutcome(entry: Pick<InboxEntry, "job_id">, loop: { id: string; name?: string } | undefined, reason?: string): DismissOutcome {
	if (!reason?.trim()) return { told: "silent" };
	if (loop) return { told: "loop", loop: loopLabel(loop) };
	return { told: "nobody", why: entry.job_id?.startsWith("cron-") ? "loop-gone" : "rule" };
}

/** What the terminal adds after `dismissed: <finding>`. */
export function dismissTail(outcome: DismissOutcome): string {
	if (outcome.told === "loop") return ` — ${outcome.loop} is told why on its next run`;
	if (outcome.told === "nobody") return outcome.why === "loop-gone" ? " — the loop that reported it is gone, so nobody is told" : " — a trigger reported it, and a trigger keeps no notes, so nobody is told";
	return "";
}

/** What a card says once it is dismissed from the page. */
export function dismissLine(outcome: DismissOutcome): string {
	if (outcome.told === "loop") return `Dismissed. Your reason goes to ${outcome.loop}'s next run.`;
	if (outcome.told === "nobody") return outcome.why === "loop-gone" ? "Dismissed. The loop that reported it is gone, so nobody is told." : "Dismissed. A rule reported it and keeps no notes, so nobody is told.";
	return "Dismissed.";
}

/**
 * Who picks up a yes to a finding, as a person reads it: the loop the lane names, by its name; the
 * check of the finding's project; for a conversation's finding, the job that filed it, else the
 * conversation. `loopName` reads jobs.json; a name is screened, since it is drawn in a terminal.
 */
export function answerWho(finding: Pick<InboxEntry, "cwd" | "job_id">, lane: LaneId | undefined, loopName: (jobId: string) => string | undefined): string {
	const parsed = lane === undefined ? undefined : parseLane(lane);
	const jobId = parsed?.kind === "loop" ? parsed.id.slice(1) : parsed?.kind === "check" ? undefined : finding.job_id;
	if (parsed?.kind === "check") return `the check of ${screenText(path.basename(finding.cwd) || finding.cwd)}`;
	if (jobId) return screenText(loopName(jobId) ?? jobId);
	return "its conversation";
}

/** The sentence a question's unfinished answer ends with when it names none: the cautious one (C3). */
const MAY_HAVE_RUN = "The command may or may not have run.";

/**
 * What a card, `/inbox all` and the CLI say of a finding's answer (design 6.1), or undefined when
 * there is nothing to say: a finding that is not claimed, or an answer this version cannot read.
 * `row` is the answer's `ans-` row, for why a pending one waits; `summary` is the run's summary
 * while the run log has its record. What came from a run is redacted and screened.
 */
export function answerLine(finding: InboxEntry, row?: Row, summary?: string): string | undefined {
	if (finding.status === "claimed" && finding.answer === undefined && finding.answered_by === undefined) return "Claimed before the upgrade.";
	const status = answerStatus(finding, row);
	if (!status) return undefined;
	const why = cardText(status.why ?? "");
	switch (status.status) {
		case "pending":
			return why ? `Waiting to run: ${why}` : "Waiting to run";
		case "started":
			return "Running";
		case "done": {
			const first = cardText(summary?.split("\n").find((line) => line.trim()) ?? "").trim();
			return first ? `Done · ${first}` : "Done";
		}
		case "unfinished":
			return `Started and did not finish (${why}).${finding.ask ? ` ${status.ending ?? MAY_HAVE_RUN}` : ""}`;
		case "not_run":
			return `Not run (${why})`;
		case "cli":
			return "Claimed from the command line. Nothing ran";
	}
}

/** What a successful cancel says (V1): the finding is `new` again, under its own id. */
export const CANCELLED_LINE = "Cancelled. The question is open again";

/** Why a cancel was refused, in a person's words (design 6.2). `missing` is the caller's to say: a page answers 404. */
export function cancelRefusal(refusal: StepRefusal): string {
	if (refusal.refused === "missing") return "there is no such finding";
	if (refusal.refused === "state" && refusal.state === "started") return "it has already started: stop it instead";
	if (refusal.refused === "state" && (refusal.state === "done" || refusal.state === "unfinished" || refusal.state === "not_run")) return "it has already ended";
	return "it has no queued answer to cancel";
}

/** What a Y1 adds when pi-loops is not running in the background: only that process runs a yes. */
export const YES_WAITS_FOR_BACKGROUND = "It runs when pi-loops runs in the background.";

/**
 * What a terminal prints after a yes (design 6.1, 6.2). Y1 on a question: the run that asked
 * resumes with the one call allowed. Y1 on any other finding: the run that reported it picks it up.
 * Y2: why nothing runs. `background`: pi-loops runs in the background now; when it does not, a Y1
 * says that the yes runs once it does.
 */
export function yesTerminalLine(said: { said: "Y1"; finding: InboxEntry } | { said: "Y2"; finding: InboxEntry; why: string }, who: string, background: boolean): string {
	if (said.said === "Y2") return `${said.why}; nothing runs`;
	const waits = background ? "" : ` ${YES_WAITS_FOR_BACKGROUND}`;
	if (said.finding.ask) return `approved: ${who} resumes the run that asked, with this one command allowed.${waits} A card comes here when it ends.`;
	return `claimed: ${who} picks this up in the run that reported it, in the background.${waits} A card comes here when it ends.`;
}

/** What `/inbox clear` adds when it left questions: a clear is no answer to a question, so each waits for its own yes or no. */
export function clearLeftTail(questions: number): string {
	if (!questions) return "";
	return `; left ${questions} question${questions === 1 ? "" : "s"} for you to answer: /inbox claim <n> or /inbox dismiss <n>`;
}

/**
 * What a card says after a yes from the page (design 6.1, 6.2). A question shows its state at once;
 * any other finding says that it runs in the background, and from what when its transcript is gone.
 * `queued` is false when the yes was written and its row was not: nothing runs until the next tick
 * puts the row back (H1), and the card says that.
 */
export function yesPageLine(said: { said: "Y1"; finding: InboxEntry; queued?: boolean } | { said: "Y2"; finding: InboxEntry; why: string }, who: string, transcriptKept: boolean): string {
	if (said.said === "Y2") return `Not run (${said.why})`;
	// A conversation's question runs there, as a turn after the current one (design 6.4).
	if (said.finding.ask && parseLane(said.finding.ask.lane)?.kind === "conversation" && said.finding.answer?.state === "pending") return "Approved. It runs in this conversation after the current turn.";
	if (said.finding.ask) return answerLine(said.finding) ?? "Waiting to run";
	if (said.queued === false) return "Your yes is saved, but its run could not be queued. pi-loops queues it again on its next tick.";
	return transcriptKept ? "Running in the background, in the run that reported it." : `Running in the background. The run's transcript is gone, so ${who} starts from the finding's text.`;
}

/** What a no to a question says (design 6.1): the run that asked is told, and the call is refused for 14 days. */
export function noQuestionLine(surface: "terminal" | "page", who: string, lane?: LaneId): string {
	// A conversation's question (design 6.4): the no is a message in that conversation, not a loop's next run.
	if (lane !== undefined && parseLane(lane)?.kind === "conversation") return surface === "terminal" ? `said no: ${who} is told in this conversation; the same command is refused for 14 days` : `You said no. ${who} is told in this conversation, and the same command is refused for 14 days.`;
	return surface === "terminal" ? `said no: ${who} is told why on its next run; the same command is refused for 14 days` : `You said no. ${who} is told on its next run, and the same command is refused for 14 days.`;
}

/** A terminal's selector at the end of a turn on a question of its conversation (design 6.4): the refusing answer first. */
export const SETTLE_NO = "No, do not run it";
export const SETTLE_YES = "Yes, run it once";

/**
 * Who a question of a conversation names on its selector and in the lines after it: a scheduled
 * prompt by its job's name in quotes, else `answerWho`'s words.
 */
function settleAsker(entry: Pick<InboxEntry, "cwd" | "job_id">, lane: LaneId, loopName: (jobId: string) => string | undefined): string {
	const who = answerWho(entry, lane, loopName);
	return fromScheduledPrompt(lane, entry.job_id) ? `"${cardText(who)}"` : cardText(who);
}

/**
 * The selector a terminal opens on a question when a turn settles (design 6.4): `Allow this once?`,
 * who asked for which tool and why, the command, and what Yes and Esc do. Drawn from the ask's
 * fields as `questionParts` draws a card, redacted and on one line each.
 */
export function settleQuestion(entry: InboxEntry & { ask: NonNullable<InboxEntry["ask"]> }, loopName: (jobId: string) => string | undefined): { title: string; options: [string, string] } {
	const { tool, command, reason } = entry.ask.call;
	const asker = settleAsker(entry, entry.ask.lane, loopName);
	const who = fromScheduledPrompt(entry.ask.lane, entry.job_id) ? `The scheduled prompt ${asker}` : asker.charAt(0).toUpperCase() + asker.slice(1);
	const lines = ["Allow this once?", `${who} asked to run ${cardText(tool)}: ${cardText(reason).replace(/\.$/, "")}.`];
	if (command !== undefined) lines.push(cardText(command));
	lines.push("It went on without it. Yes runs it once in a new turn. Esc leaves the question open (/inbox).");
	return { title: lines.join("\n"), options: [SETTLE_NO, SETTLE_YES] };
}

/** What a terminal prints after the selector's Yes (design 6.4): the yes is a row of this conversation, run after the current turn. */
export function settleYesLine(entry: Pick<InboxEntry, "cwd" | "job_id">, lane: LaneId, loopName: (jobId: string) => string | undefined): string {
	return `queued: your yes to ${settleAsker(entry, lane, loopName)} runs after the current turn`;
}

/** What a terminal prints after the selector's No (design 6.4). */
export function settleNoLine(entry: Pick<InboxEntry, "cwd" | "job_id">, lane: LaneId, loopName: (jobId: string) => string | undefined): string {
	return `said no: ${settleAsker(entry, lane, loopName)} is told in this conversation`;
}

/** Why the CLI refuses a claim of a question (design 6.1): a claim from a shell allows no command, so the question stays open for a person to answer where a yes can run it. */
export function shellClaimOfQuestion(id: string, who: string): string {
	return `inbox entry ${id} is a question from ${who}, and a claim from a shell allows no command: answer it on the page or in pi with /inbox`;
}
