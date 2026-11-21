/**
 * What a terminal window offers when a turn settles (design stage 5d, 6.3, 6.4): each open question
 * of its conversation and each proposal of its conversation, one at a time, through pi's selector.
 * `settleOffers` decides what to offer; `offerAtSettle` asks, with every effect injected, and writes
 * nothing itself: a question's answer goes through `PersonAnswers.say`, a proposal's through
 * `askProposal`.
 */
import type { StepRefusal } from "./ask.ts";
import type { SayOutcome } from "./answers.ts";
import { settleNoLine, settleQuestion, settleYesLine, SETTLE_YES, SETTLE_NO, yesTerminalLine } from "./inbox-card.ts";
import type { InboxEntry as Finding } from "./inbox.ts";
import { redact } from "./redact.ts";
import { type AnswerContext, type Proposal, type ProposalStores, askProposal, proposalLabel } from "./watch-plan.ts";

export type Offer = { kind: "question"; finding: Finding } | { kind: "proposal"; proposal: Proposal };

/** Whether the window may put a selector in front of the person now (design 5d). */
export interface SettleState {
	/** The conversation this window is on; undefined before pi saved one. */
	sessionId: string | undefined;
	/** This window holds the conversation's lease. */
	held: boolean;
	/** pi runs no turn. */
	idle: boolean;
	/** Rows of this conversation that wait or are handed to pi and not yet in it. */
	queued: number;
	/** `ctx.mode`: the page's pi is `rpc`, and the page draws its own cards. */
	mode: string;
	hasUI: boolean;
}

export interface SettleInput extends SettleState {
	findings: readonly Finding[];
	proposals: readonly Proposal[];
	/** The ids this process has shown already: a question's finding id, a job's or a rule's id. */
	offered: ReadonlySet<string>;
}

/** Design 5d's conditions: held, idle, nothing queued, a terminal with a UI. */
export function settleReady(state: SettleState): boolean {
	return state.sessionId !== undefined && state.held && state.idle && state.queued === 0 && state.mode !== "rpc" && state.hasUI;
}

const offerId = (offer: Offer): string => (offer.kind === "question" ? offer.finding.id : offer.proposal.kind === "schedule" ? offer.proposal.job.id : offer.proposal.rule.id);
const proposedAt = (p: Proposal): string => (p.kind === "schedule" ? p.job.proposed?.at : p.rule.proposed?.at) ?? "";
const proposedIn = (p: Proposal): string | undefined => (p.kind === "schedule" ? p.job.proposed?.session : p.rule.proposed?.session);
const byTime = <T>(at: (x: T) => string) => (a: T, b: T) => Date.parse(at(a)) - Date.parse(at(b));

/**
 * What to offer at this settle, in order: this conversation's open questions, oldest first, then
 * its proposals, oldest `proposed.at` first. A question of a loop (an `@cron-` lane) is the inbox's,
 * never this window's. Nothing when the window may not ask now.
 */
export function settleOffers(input: SettleInput): Offer[] {
	if (!settleReady(input)) return [];
	const here = input.sessionId;
	const questions = input.findings
		.filter((f) => f.status === "new" && f.ask !== undefined && f.ask.lane === here && !input.offered.has(f.id))
		.sort(byTime((f) => f.created_at))
		.map((finding): Offer => ({ kind: "question", finding }));
	const proposals = input.proposals
		.filter((p) => proposedIn(p) === here && !input.offered.has(offerId({ kind: "proposal", proposal: p })))
		.sort(byTime(proposedAt))
		.map((proposal): Offer => ({ kind: "proposal", proposal }));
	return [...questions, ...proposals];
}

export interface OfferDeps {
	select(title: string, options: string[]): Promise<string | undefined>;
	/** This window's `PersonAnswers.say`, from the terminal and this conversation. */
	say(id: string, word: "yes" | "no"): Promise<SayOutcome>;
	/** What `askProposal` writes through, and its context. */
	proposals: { stores: ProposalStores; ctx: AnswerContext & { pollSecs: number; home?: string } };
	/** A loop's or a job's name from jobs.json, for who a question names. */
	loopName(jobId: string): string | undefined;
	/** The window's line for a `say` that found the question answered on another surface first. */
	refused(id: string, refusal: StepRefusal): string;
	/** Design 5d's conditions, read again before each selector. */
	stillOk(): boolean;
	/** Marked when a selector shows an offer, whatever the answer. */
	offered: Set<string>;
	/** A `warning` notice: an info line is redrawn away (test/settle-probe.test.ts). */
	print(line: string): void;
}

export type OfferResult =
	| { kind: "question"; id: string; said: SayOutcome["said"] | "esc" }
	| { kind: "proposal"; id: string; outcome: "set" | "cancelled" | "already" | "still" };

/** The line Esc leaves a proposal with (design 6.3): which command asks it again. */
function staysProposed(p: Proposal): string {
	const label = redact(proposalLabel(p));
	return `the watch stays proposed: ${p.kind === "schedule" ? "/cron enable" : "/triggers enable"} ${label} asks again`;
}

async function offerQuestion(finding: Finding & { ask: NonNullable<Finding["ask"]> }, deps: OfferDeps): Promise<OfferResult> {
	const { title, options } = settleQuestion(finding, deps.loopName);
	const answer = await deps.select(title, options);
	if (answer !== SETTLE_YES && answer !== SETTLE_NO) return { kind: "question", id: finding.id, said: "esc" };
	const said = await deps.say(finding.id, answer === SETTLE_YES ? "yes" : "no");
	const lane = finding.ask.lane;
	if (said.said === "nothing") deps.print(deps.refused(finding.id, said.refusal));
	else if (said.said === "Y1") deps.print(settleYesLine(finding, lane, deps.loopName));
	else if (said.said === "N1") deps.print(settleNoLine(finding, lane, deps.loopName));
	else if (said.said === "Y2") deps.print(yesTerminalLine(said, "", true));
	return { kind: "question", id: finding.id, said: said.said };
}

async function offerProposal(p: Proposal, deps: OfferDeps): Promise<OfferResult> {
	const answered = await askProposal(p, deps.select, deps.proposals.stores, deps.proposals.ctx);
	deps.print(answered.outcome === "still" ? staysProposed(p) : answered.line);
	return { kind: "proposal", id: offerId({ kind: "proposal", proposal: p }), outcome: answered.outcome };
}

/** The offers, one selector at a time, while `stillOk` holds before each. Returns what each shown offer came to. */
export async function offerAtSettle(offers: readonly Offer[], deps: OfferDeps): Promise<OfferResult[]> {
	const results: OfferResult[] = [];
	for (const offer of offers) {
		if (!deps.stillOk()) break;
		deps.offered.add(offerId(offer));
		if (offer.kind === "question" && offer.finding.ask) results.push(await offerQuestion({ ...offer.finding, ask: offer.finding.ask }, deps));
		else if (offer.kind === "proposal") results.push(await offerProposal(offer.proposal, deps));
	}
	return results;
}

/**
 * One run of offers at a time: a settle while one is open starts nothing (it returns undefined),
 * since its selector would open over the first one's.
 */
export function oneRunAtATime<A, T>(run: (arg: A) => Promise<T>): (arg: A) => Promise<T> | undefined {
	let open = false;
	return (arg) => {
		if (open) return undefined;
		open = true;
		return run(arg).finally(() => {
			open = false;
		});
	};
}
