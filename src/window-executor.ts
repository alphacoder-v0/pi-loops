/**
 * The engine's executor in a window: the pi this extension runs in, holding its conversation's
 * lease. An `append` row goes into the chat through `pi.sendMessage`: inserted at once while idle,
 * with no turn; as a follow-up during a turn, which runs one when the current one ends
 * (docs/design.md decision 9). A `turn` row goes through `pi.sendUserMessage`, and only while pi is
 * idle (the engine decides that), so Esc has nothing of ours to drop. `handedOver` remembers what
 * pi was given and has not written yet, so a second drain does not hand it over twice; `settled()`
 * forgets what pi dropped (Esc clears its queues), so the next drain offers it again.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Executor, type ExecutorView, conversationHas, modeOf } from "./engine.ts";
import type { LeaseBinding } from "./lease.ts";
import type { SessionRequest } from "./requests.ts";
import { stamp } from "./schedule.ts";

/** After an aborted run, `turn` rows wait this long for the person's next input before one is handed over. */
export const ABORT_HOLD_MS = 60_000;

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

/** The `[Trigger <id>] ` id a message starts with, when it does. */
export function triggerIdOf(message: unknown): string | undefined {
	const value = message as { role?: unknown; content?: unknown } | undefined;
	if (!value || value.role !== "user") return undefined;
	const content = value.content;
	const text = typeof content === "string" ? content : Array.isArray(content) ? (content.find((part) => part?.type === "text") as { text?: string } | undefined)?.text : undefined;
	const match = text?.match(/^\[Trigger ([^\]]+)\] /);
	return match?.[1];
}

/**
 * The system line when a triggered turn starts (or is queued behind the current one). The id is a
 * rule's trace for a trigger and a run id for a plain job, which has no trace; the line calls it a
 * trace either way, because that is the word people have learned to look for.
 */
export function triggeredTurnLine(ctx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined, runId: string, idle: boolean): void {
	if (!ctx?.hasUI) return;
	ctx.ui.notify(idle ? `running triggered turn (trace ${runId.slice(0, 8)})` : `queued triggered turn (trace ${runId.slice(0, 8)}) after the current one`, "info");
}

type WindowCtx = Pick<ExtensionContext, "isIdle" | "mode" | "sessionManager" | "hasUI" | "ui">;

export class WindowExecutor implements Executor {
	private readonly pi: Pick<ExtensionAPI, "sendMessage" | "sendUserMessage">;
	private readonly binding: Pick<LeaseBinding, "here">;
	private readonly ctx: () => WindowCtx | undefined;
	/** Rows this process has handed pi and pi has not written yet. */
	readonly handedOver = new Set<string>();
	/** The run pi is in, and the row it started from when a `[Trigger <id>]` message began it. */
	private running: ExecutorView["running"];
	/** Until when `turn` rows wait after an aborted run (ABORT_HOLD_MS, or the person's next input). */
	private heldUntil: number | undefined;

	constructor(pi: Pick<ExtensionAPI, "sendMessage" | "sendUserMessage">, binding: Pick<LeaseBinding, "here">, ctx: () => WindowCtx | undefined) {
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
			heldUntil: this.heldUntil,
			running: this.running,
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

	/**
	 * Handed over only while pi is idle, so `followUp` matters in one case: the person started a run
	 * between the engine's idle check and this call, and pi then queues the row behind that run.
	 */
	turn(row: SessionRequest): void {
		this.pi.sendUserMessage(row.payload?.text ?? "", { deliverAs: "followUp" });
		this.handedOver.add(row.id);
		triggeredTurnLine(this.ctx(), row.id, true);
	}

	abort(): void {
		throw new Error("a window does not stop turns through requests yet");
	}

	/** At `agent_settled`: what pi dropped is offered again by the next drain. Returns the ids forgotten. */
	settled(): string[] {
		return forgetDropped(this.handedOver, (id) => this.entries("").has(id));
	}

	/** At `agent_start`: a run is on; which row began it is known at its first user message. */
	agentStarted(now: number): void {
		this.running = { startedAt: stamp(now) };
	}

	/** At `message_start`: a user message that starts with `[Trigger <id>] ` names the row the run is for. */
	messageStarted(message: unknown): void {
		const id = triggerIdOf(message);
		if (id !== undefined && this.running) this.running = { ...this.running, requestId: id };
	}

	/** At `agent_end`. An aborted run holds `turn` rows until the person's next input, or ABORT_HOLD_MS. */
	agentEnded(now: number, aborted: boolean): void {
		this.running = undefined;
		if (aborted) this.heldUntil = now + ABORT_HOLD_MS;
	}

	/** The person typed (pi's `input` event, not from an extension): the hold after an abort is over. */
	personInput(): void {
		this.heldUntil = undefined;
	}
}
