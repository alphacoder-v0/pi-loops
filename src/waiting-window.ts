/**
 * A pi window of this version while a window or terminal of an older pi-loops is open in the same
 * loops directory (src/older.ts; owner decision of 2026-11-26: one version at a time, and the window
 * does not start at all while it waits). In place of the extension it registers only this: each
 * pi-loops command, which answers with the line; the conversation's lease, so nothing else writes into
 * the conversation it has open; and one word once the older one is gone, to run /reload. No tool, no
 * MCP connection, no timer of the clock, and no handler of pi's turns: nothing here writes the stores.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LeaseBinding, LeaseStore, procStart } from "./lease.ts";
import { olderLine, olderPiLoops, untilAlone } from "./older.ts";

/** The commands the extension registers (src/pi-loops.ts); each answers with the line while it waits. */
export const WAITING_COMMANDS = ["cron", "crontab", "loop", "goal", "inbox", "triggers", "pi-loops", "recipe", "session-share", "session-export", "session-import", "new-trigger"] as const;

/** What a waiting window says once the older pi-loops is gone. */
export const GONE_LINE = "the older pi-loops is gone: run /reload to start pi-loops here";

export interface WaitingWindowDeps {
	dir: string;
	self: string;
	instance: string;
	log: (line: string) => void;
}

export function registerWaitingWindow(pi: Pick<ExtensionAPI, "registerCommand" | "on">, deps: WaitingWindowDeps): void {
	const line = (): string => {
		const now = olderLine(olderPiLoops(deps.dir, Date.now()), deps.self);
		return now === undefined ? GONE_LINE : `${now} Then run /reload in this window.`;
	};
	for (const name of WAITING_COMMANDS) {
		pi.registerCommand(name, {
			description: "pi-loops waits while an older pi-loops is open here",
			handler: async (_args, ctx) => {
				ctx.ui.notify(`[pi-loops] ${line()}`, "warning");
			},
		});
	}
	const ownStart = procStart(process.pid);
	const binding = new LeaseBinding(new LeaseStore(deps.dir), deps.instance, () => ({ kind: "terminal", pid: process.pid, procStart: ownStart, pushServers: [] }));
	let watching = false;
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		const sessionId = ctx.sessionManager.getSessionId();
		// The lease keeps pi-loops in the background, once it runs, from writing into this conversation.
		if (sessionId) {
			try { binding.bind(sessionId, { sessionFile: ctx.sessionManager.getSessionFile(), cwd: ctx.cwd }); }
			catch (err: any) { deps.log(`lease: ${err?.message ?? err}`); }
		}
		const said = line();
		deps.log(said);
		if (ctx.hasUI) ctx.ui.notify(`[pi-loops] ${said}`, "warning");
		else process.stderr.write(`[pi-loops] ${said}\n`);
		if (watching) return;
		watching = true;
		untilAlone(deps.dir, { say: () => undefined, self: deps.self, unref: true })
			.then(() => {
				deps.log(GONE_LINE);
				if (ctx.hasUI) ctx.ui.notify(`[pi-loops] ${GONE_LINE}`, "info");
			})
			.catch((err: any) => deps.log(`waiting for an older pi-loops: ${err?.message ?? err}`));
	});
	pi.on("session_shutdown", async () => {
		try { binding.release(); }
		catch (err: any) { deps.log(`lease: ${err?.message ?? err}`); }
	});
}
