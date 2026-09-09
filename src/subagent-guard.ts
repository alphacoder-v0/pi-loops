/**
 * The tool-call gate a sub-session runs under. pie clones the parent's `before_tool_call`
 * permission policy into every trigger/loop sub-agent (`agent_harness.rs:1279, 2650`); pi-loops'
 * own extension is deliberately not loaded in a sub-session, so the gate is injected here as a
 * synthetic extension instead — the one place where nobody is watching needs it most.
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
 * A hidden extension that blocks pie's dangerous-command corpus. `block` + `reason` is pi's
 * documented way to refuse a call and tell the model why (ToolCallEventResult).
 */
export function subagentGuardExtension(log?: (message: string) => void): Extension {
	const handler = async (...args: unknown[]) => {
		const event: any = args[0];
		const command = commandOf(event);
		if (!command) return undefined;
		const reason = dangerousCommandReason(command);
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
