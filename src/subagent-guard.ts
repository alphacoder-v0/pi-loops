/**
 * The tool-call gate every sub-session runs under: `src/danger.ts`'s policy, applied to each
 * command a loop run, checker or trigger action tries to execute.
 *
 * pi-loops' own extension is deliberately not loaded in a sub-session (nothing may nest), so there
 * is no extension there to hang a `tool_call` handler on. The gate is injected as a hidden
 * synthetic extension instead — the one place where nobody is watching is the place that needs it.
 */
import { createSyntheticSourceInfo, type Extension } from "@earendil-works/pi-coding-agent";
import { dangerousCommandReason } from "./danger.ts";

export const GUARD_PATH = "<pi-loops sub-agent guard>";

/** The shell command an event carries, for the tools that run one. */
function commandOf(event: any): string | undefined {
	if (event?.toolName === "bash" || event?.toolName === "powershell") return typeof event.input?.command === "string" ? event.input.command : undefined;
	return undefined;
}

/**
 * A hidden extension that blocks the dangerous-command corpus. `block` + `reason` is pi's
 * documented way to refuse a call and tell the model why (ToolCallEventResult).
 */
export function subagentGuardExtension(log?: (message: string) => void, allow: readonly string[] = []): Extension {
	const handler = async (...args: unknown[]) => {
		const event: any = args[0];
		const command = commandOf(event);
		if (!command) return undefined;
		const reason = dangerousCommandReason(command, undefined, allow);
		if (!reason) return undefined;
		log?.(`blocked a ${event.toolName} call: ${reason}`);
		return { block: true, reason: `refused by pi-loops: ${reason}. This run is unattended, so commands that can destroy data or the machine are not allowed; do the safe part and report what you would need a human for.` };
	};
	return {
		path: GUARD_PATH,
		resolvedPath: GUARD_PATH,
		hidden: true,
		sourceInfo: createSyntheticSourceInfo(GUARD_PATH, { source: "pi-loops" }),
		handlers: new Map([["tool_call", [handler]]]),
		tools: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	} as unknown as Extension;
}
