/**
 * The engine's executor in a window: the pi this extension runs in, holding its conversation's
 * lease. An `append` row goes into the chat through `pi.sendMessage`: inserted at once while idle,
 * with no turn; as a follow-up during a turn, which runs one when the current one ends
 * (docs/design.md decision 9). `handedOver` remembers what pi was given and has not written yet, so
 * a second drain does not hand it over twice; `settled()` forgets what pi dropped (Esc clears its
 * queues), so the next drain offers it again.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Executor, type ExecutorView, conversationHas, modeOf } from "./engine.ts";
import type { LeaseBinding } from "./lease.ts";
import type { SessionRequest } from "./requests.ts";

/**
 * Once pi has settled, a row it was handed and never wrote was dropped: Esc clears pi's queues, a
 * follow-up with them. Forget those, so the next drain offers them again instead of waiting for
 * them for as long as the window lives. Returns the ids forgotten.
 */
export function forgetDropped(handedOver: Set<string>, alreadyDelivered: (id: string) => boolean): string[] {
	const dropped = [...handedOver].filter((id) => !alreadyDelivered(id));
	for (const id of dropped) handedOver.delete(id);
	return dropped;
}

export class WindowExecutor implements Executor {
	private readonly pi: Pick<ExtensionAPI, "sendMessage">;
	private readonly binding: Pick<LeaseBinding, "here">;
	private readonly ctx: () => Pick<ExtensionContext, "isIdle" | "mode" | "sessionManager"> | undefined;
	/** Rows this process has handed pi and pi has not written yet. */
	readonly handedOver = new Set<string>();

	constructor(pi: Pick<ExtensionAPI, "sendMessage">, binding: Pick<LeaseBinding, "here">, ctx: () => Pick<ExtensionContext, "isIdle" | "mode" | "sessionManager"> | undefined) {
		this.pi = pi;
		this.binding = binding;
		this.ctx = ctx;
	}

	/**
	 * This window holds `sessionId`, and is a place a result should land: a one-shot `pi -p` / json
	 * run holds its conversation but would swallow it into a turn that is about to exit, so the
	 * background process delivers it after.
	 */
	holds(sessionId: string): boolean {
		const here = this.binding.here();
		const ctx = this.ctx();
		return !!ctx && here.sessionId === sessionId && here.holds && (ctx.mode === "tui" || ctx.mode === "rpc");
	}

	entries(_sessionId: string): { has(id: string): boolean } {
		const ctx = this.ctx();
		return { has: (id) => !!ctx && conversationHas(ctx.sessionManager.getEntries(), id) };
	}

	view(sessionId: string): ExecutorView {
		const entries = this.entries(sessionId);
		// What pi has written is in the conversation, not in flight any more.
		for (const id of [...this.handedOver]) if (entries.has(id)) this.handedOver.delete(id);
		return {
			kind: "window",
			// A window admits every mode; the row only has to be the mode its source gets.
			admits: (row) => modeOf(row.kind, row.source, row.wake) === row.mode,
			idle: this.ctx()?.isIdle() ?? true,
			inFlight: this.handedOver,
			connected: () => true,
			producerAlive: () => true,
		};
	}

	append(row: SessionRequest, wakeAgent: boolean): void {
		const content = row.payload?.text ?? "";
		if (wakeAgent) this.pi.sendMessage({ customType: "pi-loops:trigger", content, display: true }, { triggerTurn: true, deliverAs: "followUp" });
		else this.pi.sendMessage({ customType: "pi-loops:trigger", content, display: true }, { triggerTurn: false });
		this.handedOver.add(row.id);
	}

	turn(_row: SessionRequest): void {
		throw new Error("a window does not run turn requests yet");
	}

	abort(): void {
		throw new Error("a window does not stop turns through requests yet");
	}

	/** At `agent_settled`: what pi dropped is offered again by the next drain. Returns the ids forgotten. */
	settled(): string[] {
		return forgetDropped(this.handedOver, (id) => this.entries("").has(id));
	}
}
