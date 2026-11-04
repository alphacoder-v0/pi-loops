/**
 * A finding as a person reads it: the one place the stored line of `inbox.jsonl` is split into what
 * the terminal's `/inbox`, `pi-loops inbox list` and the page show. Parsed at read time and never
 * written back, so the stored shape (CONTRACT.md 2.2) does not change.
 *
 * A checkpoint is `<the decision> · waits: <what waits on it> · if not: <what happens if nobody
 * acts>` (docs/recipes.md); a card shows the three parts apart, under the page's words "Waiting on"
 * and "If you don't". News is one finding with a headline. What a claim says to the agent and what a
 * dismiss tells the loop are decided here too, so every surface says the same thing.
 */
import { deadLetterParts } from "./engine.ts";
import type { InboxEntry, InboxStatus } from "./inbox.ts";
import { INBOX_TEXT_MAX_CHARS, capChars } from "./protocol.ts";
import { redact } from "./redact.ts";

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
	/** The checker kept it (✓). */
	verified: boolean;
	verifiedReason?: string;
	/** `rule`: a trigger's result. `undelivered`: a prompt that never reached its conversation (a dead letter). */
	origin: "loop" | "rule" | "undelivered";
	/** The loop that filed it, with its name when the loop still exists. */
	loop?: { id: string; name?: string };
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
	/** A claim from the page is queued for it and has not marked it claimed yet: Yes is not offered again. */
	claiming: boolean;
}

export interface CardContext {
	/** The conversation the card is shown in. */
	here?: string;
	/** A loop's name from jobs.json, or undefined when the loop is gone or has none. */
	loopName(jobId: string): string | undefined;
	/** Whether a page claim row for this finding is queued. */
	claiming?(id: string): boolean;
}

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
 * One finding as a card, or undefined for a line with no id or no text: `readFinding` turns a
 * line `{}` into an entry with both empty, and a button that sends an empty id names nothing.
 * The text is redacted and capped again, since a line another tool wrote is not bounded.
 */
export function inboxCard(entry: InboxEntry, ctx: CardContext): InboxCard | undefined {
	if (!entry.id || !entry.text) return undefined;
	const text = capChars(redact(entry.text).replace(/\s+/g, " "), INBOX_TEXT_MAX_CHARS);
	const origin = entry.source.startsWith("trigger:") ? "rule" : deadLetterParts(entry.text) ? "undelivered" : "loop";
	const loopId = origin === "loop" ? entry.job_id : undefined;
	const loopName = loopId ? ctx.loopName(loopId) : undefined;
	return {
		id: entry.id,
		kind: entry.kind === "checkpoint" ? "decision" : "news",
		status: entry.status,
		...splitFinding(text, entry.kind),
		verified: entry.verified === true,
		...(entry.verified_reason ? { verifiedReason: redact(entry.verified_reason) } : {}),
		origin,
		...(loopId ? { loop: loopName === undefined ? { id: loopId } : { id: loopId, name: loopName } } : {}),
		source: entry.source,
		cwd: entry.cwd,
		createdAt: entry.created_at,
		runId: entry.run_id,
		...(entry.session_id ? { sessionId: entry.session_id } : {}),
		hasTranscript: origin !== "rule" && !!entry.transcript,
		fromThisConversation: !!entry.session_id && entry.session_id === ctx.here,
		claiming: entry.status === "new" && (ctx.claiming?.(entry.id) ?? false),
	};
}

/** The cards of `entries`, decisions first and each group in the order given (`Inbox.listNew`'s); lines with no id or text are left out. */
export function cardsOf(entries: readonly InboxEntry[], ctx: CardContext): InboxCard[] {
	const cards = entries.flatMap((e) => inboxCard(e, ctx) ?? []);
	return [...cards.filter((c) => c.kind === "decision"), ...cards.filter((c) => c.kind === "news")];
}

/** How far a card's continuation lines are indented under its first line. */
const CLAUSE_INDENT = "       ";

/**
 * A card as terminal lines: `head`, the marks, the headline (news: its whole text) and `meta` on
 * the first line; a decision's clauses on indented lines under it, under the page's words. A clause
 * the loop left out prints nothing: two packaged playbooks leave `if not` out on purpose.
 */
export function cardLines(card: InboxCard, head: string, meta: string): string[] {
	const mark = `${card.kind === "decision" ? "⚑ " : ""}${card.verified ? "✓ " : ""}`;
	const title = card.body === undefined ? card.headline : `${card.headline}${/[。！？]$/.test(card.headline) ? "" : " "}${card.body}`;
	const lines = [`${head}${mark}${title}${meta}`];
	if (card.waits !== undefined) lines.push(`${CLAUSE_INDENT}waiting on: ${card.waits}`);
	if (card.ifNot !== undefined) lines.push(`${CLAUSE_INDENT}if you don't: ${card.ifNot}`);
	return lines;
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
	if (loop) return { told: "loop", loop: loop.name ?? loop.id };
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

/** The turn a claim runs: the finding, where it came from, and what a claim of a checkpoint means. */
export function claimPrompt(e: InboxEntry): string {
	const verified = e.verified ? `\n(An independent checker reviewed and kept this finding${e.verified_reason ? `: ${e.verified_reason}` : ""}.)` : "";
	// A checkpoint is a decision the loop prepared and left to a person; the claim is that
	// person's yes, so the turn carries the decision out rather than re-investigating it.
	const checkpoint = e.kind === "checkpoint" ? "\nThis finding is a checkpoint: claiming it is the person's approval of the decision it recommends — carry that decision out, and stop where the finding says a person acts." : "";
	// A prompt that never reached the chat: claiming it is asking for it now, not investigating why it was late.
	const late = deadLetterParts(e.text);
	if (late) return `This prompt (${e.source}, for ${e.cwd}) could not be delivered earlier (${late.why}). Do what it asks now:\n${late.prompt}`;
	return `A recurring loop (${e.source}, running in ${e.cwd}) reported this finding — investigate and address it:\n${e.text}${verified}${checkpoint}`;
}
