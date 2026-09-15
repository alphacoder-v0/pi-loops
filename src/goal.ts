import { stamp } from "./schedule.ts";
/**
 * `/goal`: a stop condition the agent is held to.
 *
 * Everything pi-loops otherwise schedules is time- or event-driven. A goal is the one mechanism
 * that asks "am I done yet" — after every settled turn an evaluator (a model call with no tools and
 * only a bounded transcript) judges the user's condition. `{ok:false}` sends the agent back to work
 * with what is missing, up to a continuation budget; `{ok:true}` stops; an evaluator that itself
 * fails pauses rather than looping — an evaluator that cannot answer must not become a machine
 * that keeps paying for turns.
 */

/** Each state change is appended to the session, so `--resume` finds it. */
export const GOAL_ENTRY = "goal_state";
/** How many times the agent may be sent back to work before the goal pauses itself. */
export const MAX_CONTINUATIONS = 8;
/** How much of the transcript the evaluator is shown. */
export const TRANSCRIPT_CHAR_LIMIT = 40_000;

export type GoalStatus = "pursuing" | "paused" | "achieved" | "budget_limited" | "cleared";

export interface GoalState {
	condition: string;
	status: GoalStatus;
	iterations: number;
	lastReason?: string;
	updatedAt: string;
}

/** A cleared or achieved goal no longer holds the session. */
export function goalActive(state: GoalState): boolean {
	return state.status === "pursuing" || state.status === "paused" || state.status === "budget_limited";
}

export interface EvaluatorDecision {
	ok: boolean;
	reason: string;
}

export function newGoal(condition: string, now = new Date()): GoalState {
	return { condition, status: "pursuing", iterations: 0, updatedAt: stamp(now.getTime()) };
}

/** The newest state in a session's entries, or undefined when the goal was cleared or never set. */
export function latestGoal(entries: Array<{ type?: string; customType?: string; data?: unknown }>): GoalState | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as any;
		if (e?.customType !== GOAL_ENTRY) continue;
		const data = e.data as GoalState | undefined;
		if (!data || typeof data.condition !== "string" || typeof data.status !== "string") continue;
		if (data.status === "cleared") return undefined;
		// `iterations` is the continuation budget. A session entry is only as trustworthy as what
		// wrote it (an imported archive carries these verbatim), and a non-number would make
		// `iterations + 1 >= MAX_CONTINUATIONS` false forever — an unbounded self-prompting loop.
		return { ...data, iterations: Number.isInteger(data.iterations) && data.iterations >= 0 ? data.iterations : 0 };
	}
	return undefined;
}

/**
 * The transcript the evaluator sees: `role: text` per message, truncated from the front so the most
 * recent evidence always survives the cap.
 */
export function transcriptFromMessages(messages: Array<{ role?: string; content?: unknown }>, limit = TRANSCRIPT_CHAR_LIMIT): string {
	const lines: string[] = [];
	for (const m of messages) {
		const role = typeof m?.role === "string" ? m.role : "unknown";
		const text = renderContent(m?.content);
		if (text) lines.push(`${role}: ${text}`);
	}
	const joined = lines.join("\n");
	return joined.length <= limit ? joined : `…\n${joined.slice(joined.length - limit)}`;
}

function renderContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		const b = block as any;
		if (typeof b?.text === "string") parts.push(b.text);
		else if (b?.type === "toolCall") parts.push(`<tool_call ${b.name ?? "?"}>`);
		else if (b?.type === "thinking") parts.push("<thinking>");
	}
	return parts.join(" ").trim();
}

/** The evaluator's system and user prompts, joined: pi-loops has one prompt channel. */
export function evaluatorPrompt(condition: string, transcript: string): string {
	return [
		"You are evaluating a stop-condition hook in pi-loops.",
		"Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.",
		"You cannot call tools. Only use explicit evidence in the transcript.",
		"Your response must be a JSON object with one of these shapes:",
		'{"ok": true, "reason": "<quote evidence from the transcript that satisfies the condition>"}',
		'{"ok": false, "reason": "<quote what is missing or what blocks the condition>"}',
		"Always include a reason field, quoting specific text from the transcript whenever possible.",
		'If the transcript does not contain clear evidence that the condition is satisfied, return {"ok": false, "reason": "insufficient evidence in transcript"}.',
		"",
		`Goal condition:\n${condition}`,
		"",
		`Conversation transcript:\n${transcript}`,
	].join("\n");
}

/** Parsing a decision: bare JSON, or the first `{`…`}` in the reply. An empty reason is an error. */
export function parseDecision(text: string): EvaluatorDecision {
	const trimmed = text.trim();
	const candidates = [trimmed];
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
	for (const candidate of candidates) {
		let parsed: any;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed.ok !== "boolean" || typeof parsed.reason !== "string") continue;
		if (!parsed.reason.trim()) throw new Error("goal evaluator returned an empty reason");
		return { ok: parsed.ok, reason: parsed.reason };
	}
	throw new Error(`goal evaluator returned invalid JSON: ${tailChars(trimmed, 300)}`);
}

function tailChars(text: string, maxChars: number): string {
	const chars = Array.from(text);
	return chars.length <= maxChars ? text : chars.slice(chars.length - maxChars).join("");
}

/** What the agent is sent back to work with. */
export function continuationPrompt(condition: string, reason: string): string {
	return `The current /goal is not satisfied yet.\n\nGoal condition:\n${condition}\n\nGoal evaluator says what is missing or blocking completion:\n${reason}\n\nContinue working toward the goal. Do not claim completion until the transcript contains explicit evidence that satisfies the condition.`;
}

export type GoalAction = { kind: "stop" } | { kind: "continue"; prompt: string } | { kind: "pause"; reason: string };

/** What a decision does to the state, and what happens next. */
export function applyDecision(state: GoalState, decision: EvaluatorDecision, now = new Date()): { state: GoalState; action: GoalAction } {
	const next: GoalState = { ...state, iterations: state.iterations + 1, lastReason: decision.reason, updatedAt: stamp(now.getTime()) };
	if (decision.ok) return { state: { ...next, status: "achieved" }, action: { kind: "stop" } };
	if (next.iterations >= MAX_CONTINUATIONS) {
		return { state: { ...next, status: "budget_limited" }, action: { kind: "pause", reason: `goal continuation limit reached (${MAX_CONTINUATIONS}); resume with /goal resume` } };
	}
	return { state: next, action: { kind: "continue", prompt: continuationPrompt(next.condition, decision.reason) } };
}

/**
 * Whether the session has moved off the point the goal was judged at, so a continuation would be
 * delivered as a follow-up on somebody else's turn. The evaluator reads for up to two minutes and
 * the session takes input the whole time: a question typed meanwhile would be answered under the
 * goal's continuation prompt instead of its own.
 *
 * `entries` is the current branch root-first (pi's `sessionManager.getBranch()`), `at` the leaf id
 * captured before the evaluation started. A moved leaf is not enough on its own: run cards, panel
 * snapshots and the goal's own state entries all append there and mean nothing here — only a user
 * message the goal did not send. The goal's own previous continuation is never one of them; the
 * turn that carried it had settled before this evaluation began, so it is already behind `at`.
 */
export function branchMovedSince(entries: Array<{ id: string; type: string; message?: { role?: string } }>, at: string | null): boolean {
	if (at === null) return false; // nothing to compare against (an empty session): behave as before
	const from = entries.findIndex((e) => e.id === at);
	// Rewound, forked or edited: the branch the goal was judged on is not the one we are on.
	if (from < 0) return true;
	return entries.slice(from + 1).some((e) => e.type === "message" && e.message?.role === "user");
}

/** An evaluator that could not decide never loops the agent: it pauses and says why. */
export function pauseFor(state: GoalState, reason: string, now = new Date()): { state: GoalState; action: GoalAction } {
	return { state: { ...state, status: "paused", lastReason: reason, updatedAt: stamp(now.getTime()) }, action: { kind: "pause", reason } };
}

/**
 * Esc on a turn is a person saying stop. The goal it was pursuing pauses — appended to the session,
 * so a `--resume` finds it paused — until `/goal resume`. Without this the turn was merely not
 * judged, and the next message the person sent brought the evaluator back to send them to work.
 * Only a pursued goal changes; a paused, achieved or budget-limited one has nothing to stop.
 */
export function abortedTurn(state: GoalState, now = new Date()): { state: GoalState; action: GoalAction } | undefined {
	if (state.status !== "pursuing") return undefined;
	return pauseFor(state, "you stopped the turn (Esc); /goal resume to continue", now);
}

/** One line for `/goal` and the panel. */
export function goalLine(state: GoalState): string {
	const iter = `${state.iterations}/${MAX_CONTINUATIONS}`;
	return `${state.status} (${iter} continuations)${state.lastReason ? `: ${state.lastReason}` : ""}`;
}
