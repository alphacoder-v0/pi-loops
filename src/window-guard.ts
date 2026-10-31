/**
 * The cap on a scheduled turn in an open window (design §6.3, owner decision O1). A plain job's
 * prompt runs under the job's declared tools and the dangerous-command policy wherever it runs: in
 * the background the sub-agent guard (src/subagent-guard.ts) refuses outright, since nobody is there;
 * in a window the person is, so the same call asks them, with a countdown, and is refused when
 * nobody answers. `guardDecision` is the whole decision as a function; `windowGuard` is the
 * `tool_call` handler that applies it, built here so a test can drive it without the extension.
 */
import type { ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { dangerousCommandReason } from "./danger.ts";
import { PI_BUILTIN_TOOL_NAMES } from "./mcp.ts";
import { redact } from "./redact.ts";
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
		return Date.now() - asked >= timeout ? "none" : "no";
	}
	const choice = await ctx.ui.select(`${title}\n${body}`, [GUARD_CHOICES.refuse, GUARD_CHOICES.allow], { timeout });
	return allows(choice) ? "yes" : choice === GUARD_CHOICES.refuse ? "no" : "none";
}

export interface GuardConfig {
	/** `[engine] window_guard`; false is 0.23's uncapped window. */
	windowGuard: boolean;
	/** `[danger] allow`: commands the dangerous-command policy lets through, as in the background. */
	allowCommands: readonly string[];
}

/**
 * The pi-loops tools a declared tool list lets through undeclared, as the background does (they are
 * every run's `customTools`): the ones that only read (src/tools.ts), and the ones that carry their
 * own gate. A job made in a capped turn is capped to that turn's tools (src/pi-loops.ts `toolHost`,
 * as src/host-runtime.ts scopes a run's), so `cron_create` widens nothing; the rest ask through
 * `confirmTool` exactly where the background's preflight refuses, and the guard asking as well made
 * two questions of one call.
 */
export const READ_ONLY_AUTOMATION_TOOLS: readonly string[] = ["cron_list", "list_triggers"];
/** The pi-loops tools whose gate is their own (`confirmTool`, or the cap on what they create): the guard adds no question. */
export const SELF_GATED_AUTOMATION_TOOLS: readonly string[] = ["cron_create", "cron_remove", "set_cron_job_state", "new_trigger", "remove_trigger", "set_trigger_state"];
const AUTOMATION_TOOLS: readonly string[] = [...READ_ONLY_AUTOMATION_TOOLS, ...SELF_GATED_AUTOMATION_TOOLS];

export type GuardDecision = { kind: "allow" } | { kind: "ask"; reason: string };

/** The shell command a call carries, for the tools that run one. */
function commandOf(call: { toolName: string; input?: unknown }): string | undefined {
	if (call.toolName !== "bash" && call.toolName !== "powershell") return undefined;
	const command = (call.input as { command?: unknown } | undefined)?.command;
	return typeof command === "string" ? command : undefined;
}

/**
 * Pure. Everything is allowed unless the turn is a scheduled row's and the guard is on. Then a call
 * asks when the tool is outside what the row declared (`--tools` names the whole set; a built-in
 * list caps only pi's built-ins, so extension and MCP tools pass; neither declares nothing), or when
 * the command is one the background would refuse.
 */
export function guardDecision(call: { toolName: string; input?: unknown }, current: CurrentTurn | undefined, cfg: GuardConfig): GuardDecision {
	if (!cfg.windowGuard || !unattendedTurn(current)) return { kind: "allow" };
	if (current.tools) {
		if (!current.tools.includes(call.toolName) && !AUTOMATION_TOOLS.includes(call.toolName)) return { kind: "ask", reason: `${call.toolName} is not among the tools the job declared (${current.tools.join(", ") || "none"})` };
	} else if (current.builtinTools && PI_BUILTIN_TOOL_NAMES.includes(call.toolName) && !current.builtinTools.includes(call.toolName)) {
		return { kind: "ask", reason: `${call.toolName} is not among the built-in tools the job declared (${current.builtinTools.join(", ") || "none"})` };
	}
	const command = commandOf(call);
	const danger = command === undefined ? undefined : dangerousCommandReason(command, undefined, cfg.allowCommands);
	return danger === undefined ? { kind: "allow" } : { kind: "ask", reason: danger };
}

/**
 * What the model is told: the sub-agent guard's wording, with who refused. `nobody` is the default:
 * the question timed out, was escaped, or there was no UI to ask; `person` is a No the person gave.
 */
export function refusal(reason: string, by: "nobody" | "person" = "nobody"): string {
	const who = by === "person" ? "The person at the window refused it" : "This scheduled turn ran with nobody answering";
	return `refused by pi-loops: ${reason}. ${who}; commands that can destroy data or the machine, and tools the job did not declare, are not allowed; do the safe part and report what you would need a human for.`;
}

export interface WindowGuardDeps {
	current(): CurrentTurn | undefined;
	config(): GuardConfig;
	log(line: string): void;
	/** WINDOW_GUARD_CONFIRM_MS unless a test shortens it. */
	confirmTimeoutMs?: number;
}

/**
 * The `tool_call` handler: decide, ask when the decision says so, refuse when the answer is not the
 * allowing one or never comes. pi resolves an unanswered or escaped select to undefined, at the
 * timeout in the terminal and over rpc alike, so the countdown is pi's and the refusal is ours. The
 * question has no body of its own, so the body rides in the title. This is a boundary that fails closed:
 * with no UI to ask, or with anything in here throwing, a scheduled turn's call is refused. The
 * person's own turn goes on as if the guard were not there, and so does a turn with no row in force
 * (nothing of ours is running: between settle cycles), the one unknown that is allowed. Whose turn
 * it is comes first, and a failure to learn even that refuses.
 */
export function windowGuard(deps: WindowGuardDeps): (event: { toolName: string; input?: unknown }, ctx: Pick<ExtensionContext, "hasUI" | "ui" | "mode"> | undefined) => Promise<ToolCallEventResult | undefined> {
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
			const decision = guardDecision(event, current, deps.config());
			if (decision.kind === "allow" || !unattendedTurn(current)) return undefined;
			const command = commandOf(event);
			const body = [`A scheduled prompt (trace ${current.id.slice(0, 8)}) wants to run ${event.toolName}: ${decision.reason}.`, ...(command === undefined ? [] : [redact(command).slice(0, 200)]), `Yes runs it this once. No, or no answer in ${Math.round(timeout / 1000)} s, refuses it and tells the model why.`].join("\n");
			const answer = ctx?.hasUI ? await askRefusingFirst(ctx, "Allow this in a scheduled turn?", body, timeout) : "none";
			deps.log(`${answer === "yes" ? "allowed" : "refused"} ${event.toolName} in scheduled turn ${current.id.slice(0, 8)}: ${decision.reason}${ctx?.hasUI ? (answer === "no" ? " (the person said no)" : "") : " (no UI to ask)"}`);
			return answer === "yes" ? undefined : { block: true, reason: refusal(decision.reason, answer === "no" ? "person" : "nobody") };
		} catch (err: any) {
			deps.log(`window guard failed on ${event.toolName}: ${err?.message ?? err}`);
			return unattendedTurn(current) ? { block: true, reason: refusal("the guard could not decide") } : undefined;
		}
	};
}
