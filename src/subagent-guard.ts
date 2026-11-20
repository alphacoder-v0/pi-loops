/**
 * The tool-call gate every sub-session runs under: `guardCall` of src/guard.ts, applied to each call
 * a loop run, checker or trigger action makes.
 *
 * pi-loops' own extension is deliberately not loaded in a sub-session (nothing may nest), so there
 * is no extension there to hang a `tool_call` handler on. The gate is injected as a hidden
 * synthetic extension instead — the one place where nobody is watching is the place that needs it.
 * One extension serves every run of a loaded set: it finds the run by the run's own session manager.
 */
import { createSyntheticSourceInfo, type Extension } from "@earendil-works/pi-coding-agent";
import { type GuardDeps, type GuardSeats, guardCall } from "./guard.ts";

export const GUARD_PATH = "<pi-loops sub-agent guard>";

/**
 * A hidden extension that applies the guard. `block` + `reason` is pi's documented way to refuse a
 * call and tell the model why (ToolCallEventResult).
 */
export function subagentGuardExtension(seats: GuardSeats, deps: GuardDeps): Extension {
	const handler = async (...args: unknown[]) => {
		const event = args[0] as { toolName: string; toolCallId: string; parentToolCallId?: string; input?: unknown };
		const ctx = args[1] as { sessionManager?: object } | undefined;
		return guardCall({ toolName: event.toolName, toolCallId: event.toolCallId, parentToolCallId: event.parentToolCallId, input: event.input }, seats.of(ctx?.sessionManager), deps);
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
