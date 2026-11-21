/**
 * The cap on a scheduled turn in an open window (design §6.3, owner decision O1). A plain job's
 * prompt runs under the job's declared tools and the dangerous-command policy wherever it runs, as
 * `judgeCall` of src/guard.ts decides it: in the background the question goes to the inbox; in a
 * window the person is there, so the same call asks them, with a countdown, and is refused when
 * nobody answers. `windowTurn` is the turn the window gives the decider; `windowGuard` is the
 * `tool_call` handler that asks, built here so a test can drive it without the extension.
 */
import type { ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { type GuardPolicy, type GuardTurn, judgeCall, unhandledAsk } from "./guard.ts";
import { capRedacted } from "./redact.ts";
import { defaultLoopsDir } from "./store.ts";
import { type CurrentTurn, unattendedTurn } from "./window-executor.ts";

/** How long the person has to answer before an unanswered question refuses the call. */
export const WINDOW_GUARD_CONFIRM_MS = 60_000;

/**
 * The two answers to the guard's question, the refusing one first: pi's selector starts on the
 * first option and Enter picks it, so a reflexive Enter refuses. pi's confirm starts on Yes.
 */
export const GUARD_CHOICES = { refuse: "No, refuse it", allow: "Yes, run it once" } as const;

/** Pure. Only the allowing answer allows: no answer (the timeout), Escape and anything else refuse. */
export function allows(choice: string | undefined): boolean {
	return choice === GUARD_CHOICES.allow;
}

/** What the question came to: the allowing answer, the person's refusal, or no answer (the timeout, Escape, no UI). */
export type GuardAnswer = "yes" | "no" | "none";
/** How close to its timeout a false confirm counts as the timeout: timers fire slightly early. */
const TIMEOUT_SLACK_MS = 50;

/**
 * The question, put so that the reflexive answer refuses. In a terminal pi draws a confirm with the
 * cursor on Yes, so it is a select with the refusal first. The browser draws a select's title as one
 * heading line, and its confirm already puts cancel first, so there it stays a confirm. No answer
 * within `timeout` is a refusal either way; the model is told which it was, so a person's No is not
 * reported as nobody being there. pi's confirm resolves false for both, so over rpc the clock tells
 * them apart.
 */
export async function askRefusingFirst(ctx: Pick<ExtensionContext, "ui" | "mode">, title: string, body: string, timeout: number): Promise<GuardAnswer> {
	if (ctx.mode === "rpc") {
		const asked = Date.now();
		if (await ctx.ui.confirm(title, body, { timeout })) return "yes";
		// Timers fire a millisecond or so early against Date.now(); a No in the last instants of the
		// countdown cannot be told from the countdown anyway.
		return Date.now() - asked >= timeout - Math.min(TIMEOUT_SLACK_MS, timeout / 10) ? "none" : "no";
	}
	const choice = await ctx.ui.select(`${title}\n${body}`, [GUARD_CHOICES.refuse, GUARD_CHOICES.allow], { timeout });
	return allows(choice) ? "yes" : choice === GUARD_CHOICES.refuse ? "no" : "none";
}

export interface GuardConfig extends GuardPolicy {
	/** `[engine] window_guard`; false is 0.23's uncapped window. */
	windowGuard: boolean;
}

/**
 * Pure. The turn `judgeCall` judges a window's call in, or undefined when nothing is judged: the
 * guard is off, or the turn is not a scheduled row's (the person's own turn, an attended row, or
 * nothing of ours in force). Its questions go to a dialog, and it carries the row's declared tools.
 */
export function windowTurn(current: CurrentTurn | undefined, windowGuard: boolean): GuardTurn | undefined {
	if (!windowGuard || !unattendedTurn(current)) return undefined;
	const declared = { ...(current.tools ? { tools: current.tools } : {}), ...(current.builtinTools ? { builtinTools: current.builtinTools } : {}) };
	return { asksThrough: "dialog", resumable: false, open: new Map(), refused: new Map(), asked: 0, declared };
}

/**
 * What the model is told: the sub-agent guard's wording, with who refused. `nobody` is the default:
 * the question timed out, was escaped, or there was no UI to ask; `person` is a No the person gave;
 * `blind` is a call nobody was asked about, since a person could not see it.
 */
export function refusal(reason: string, by: "nobody" | "person" | "blind" = "nobody"): string {
	const who = by === "person" ? "The person at the window refused it" : by === "blind" ? "Nobody was asked, since a person could not see what this call would read or write" : "This scheduled turn ran with nobody answering";
	return `refused by pi-loops: ${reason}. ${who}; commands that can destroy data or the machine, and tools the job did not declare, are not allowed; do the safe part and report what you would need a human for.`;
}

/**
 * How much of the command the question shows. Cut in characters and marked with `…`, so a person
 * asked to say yes can tell when they have not seen all of it: a code-unit cut with no marker showed
 * a 300-character command as if it ended at 200, and could end it on half of an emoji.
 */
export const WINDOW_GUARD_COMMAND_CHARS = 200;

export interface WindowGuardDeps {
	current(): CurrentTurn | undefined;
	config(): GuardConfig;
	log(line: string): void;
	/** WINDOW_GUARD_CONFIRM_MS unless a test shortens it. */
	confirmTimeoutMs?: number;
}

/**
 * The `tool_call` handler: judge, ask when the verdict is a question, refuse when the answer is not
 * the allowing one or never comes. pi resolves an unanswered or escaped select to undefined, at the
 * timeout in the terminal and over rpc alike, so the countdown is pi's and the refusal is ours. The
 * question has no body of its own, so the body rides in the title. This is a boundary that fails closed:
 * with no UI to ask, or with anything in here throwing, a scheduled turn's call is refused. The
 * person's own turn goes on as if the guard were not there, and so does a turn with no row in force
 * (nothing of ours is running: between settle cycles), the one unknown that is allowed. Whose turn
 * it is comes first, and a failure to learn even that refuses.
 */
export function windowGuard(deps: WindowGuardDeps): (event: { toolName: string; toolCallId?: string; input?: unknown }, ctx: (Pick<ExtensionContext, "hasUI" | "ui" | "mode"> & { cwd?: string }) | undefined) => Promise<ToolCallEventResult | undefined> {
	const timeout = deps.confirmTimeoutMs ?? WINDOW_GUARD_CONFIRM_MS;
	return async (event, ctx) => {
		let current: CurrentTurn | undefined;
		try {
			current = deps.current();
		} catch (err: any) {
			deps.log(`window guard failed on ${event.toolName}: ${err?.message ?? err}`);
			return { block: true, reason: refusal("the guard could not decide") };
		}
		try {
			const cfg = deps.config();
			const turn = windowTurn(current, cfg.windowGuard);
			if (turn === undefined || !unattendedTurn(current)) return undefined;
			const call = { toolName: event.toolName, toolCallId: event.toolCallId ?? "", input: event.input, ...(ctx?.cwd ? { cwd: ctx.cwd } : {}) };
			const verdict = judgeCall(call, turn, { allowCommands: cfg.allowCommands, loopsDir: cfg.loopsDir ?? defaultLoopsDir() });
			const trace = current.id.slice(0, 8);
			switch (verdict.kind) {
				case "allow":
					return undefined;
				case "refuse": {
					// A dialog refuses only what it cannot show (`not-shown`): a window turn has no grant, no open question and no no.
					const blind = verdict.whyNot.why === "not-shown";
					deps.log(`refused ${event.toolName} in scheduled turn ${trace}: ${verdict.reason}${blind ? " (nobody asked: it cannot be shown)" : ""}`);
					return { block: true, reason: refusal(verdict.reason, blind ? "blind" : "nobody") };
				}
				case "question": {
					const ask = verdict.ask;
					switch (ask.kind) {
						case "call": {
							const { reason, command } = ask.call;
							const body = [`A scheduled prompt (trace ${trace}) wants to run ${event.toolName}: ${reason}.`, ...(command === undefined ? [] : [capRedacted(command, WINDOW_GUARD_COMMAND_CHARS)]), `Yes runs it this once. No, or no answer in ${Math.round(timeout / 1000)} s, refuses it and tells the model why.`].join("\n");
							const answer = ctx?.hasUI ? await askRefusingFirst(ctx, "Allow this in a scheduled turn?", body, timeout) : "none";
							deps.log(`${answer === "yes" ? "allowed" : "refused"} ${event.toolName} in scheduled turn ${trace}: ${reason}${ctx?.hasUI ? (answer === "no" ? " (the person said no)" : "") : " (no UI to ask)"}`);
							return answer === "yes" ? undefined : { block: true, reason: refusal(reason, answer === "no" ? "person" : "nobody") };
						}
						default:
							return unhandledAsk(ask.kind);
					}
				}
				case "asked":
				case "granted":
					throw new Error(`a window's turn has no open question and no grant, yet the verdict is ${verdict.kind}`);
			}
		} catch (err: any) {
			deps.log(`window guard failed on ${event.toolName}: ${err?.message ?? err}`);
			return unattendedTurn(current) ? { block: true, reason: refusal("the guard could not decide") } : undefined;
		}
	};
}
