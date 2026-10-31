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
import { type Executor, type ExecutorView, type Producer, conversationHas, modeOf, queuedTriggeredTurn, sameProducer, typedByPerson } from "./engine.ts";
import { type LeaseBinding, type ProcessProbe, systemProbe } from "./lease.ts";
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
	ctx.ui.notify(idle ? `running triggered turn (trace ${runId.slice(0, 8)})` : queuedTriggeredTurn(runId), "info");
}

/**
 * Whether the process that wrote a row is still that process, on that conversation, by the rule a
 * lease holder is judged by (src/lease.ts holderAlive): the pid lives; a known start time that
 * differs is a reused pid; with either start time unknown, a row older than this boot is a
 * previous boot's. A producer that left the conversation said so in `created_by.left`.
 */
export function producerAlive(row: Pick<SessionRequest, "created_by" | "created_at">, probe: ProcessProbe = systemProbe): boolean {
	const by = row.created_by;
	if (by.left !== undefined || !probe.alive(by.pid)) return false;
	const start = probe.startTime(by.pid);
	if (by.procStart !== undefined && start !== undefined && start !== by.procStart) return false;
	if ((by.procStart === undefined || start === undefined) && Date.parse(row.created_at) < probe.bootedAt() - 60_000) return false;
	return true;
}

/**
 * Which turn rows announce themselves with that line: the ones that arrive out of the clock or a
 * server, which the person did not ask for just now. A claim, a recipe hand-off, `/new-trigger` and a
 * goal continuation keep the notices they print themselves.
 */
export function showsTriggeredTurnLine(source: SessionRequest["source"]): boolean {
	return source.startsWith("cron:") || source.startsWith("cron-run:") || source.startsWith("push:");
}

type WindowCtx = Pick<ExtensionContext, "isIdle" | "mode" | "sessionManager" | "hasUI" | "ui" | "abort">;

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
	/**
	 * Rows a stop named while pi held them unstarted: each is aborted at the `message_start` that
	 * begins its turn. One pi dropped instead (Esc) moves to `stopped`, and the next drain removes it
	 * as cancelled rather than offering it again: the stop was for that row.
	 */
	private readonly abortOnStart = new Set<string>();
	private readonly stopped = new Set<string>();
	private readonly self: Producer;
	private readonly alive: (row: SessionRequest) => boolean;

	constructor(pi: Pick<ExtensionAPI, "sendMessage" | "sendUserMessage">, binding: Pick<LeaseBinding, "here">, ctx: () => WindowCtx | undefined, self: Producer, alive: (row: SessionRequest) => boolean = producerAlive) {
		this.pi = pi;
		this.binding = binding;
		this.ctx = ctx;
		this.self = self;
		this.alive = alive;
	}

	/**
	 * This window holds `sessionId`, and is a place a result should land: a one-shot `pi -p` / json
	 * run holds its conversation but would swallow a result into a turn that is about to exit, so the
	 * background process appends it after, and a turn row waits for a window. The rows this process
	 * produced itself (what the person typed here, its goal's continuations) are run here in any
	 * mode, lease or not: `mine`, which `drain` asks beside this.
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
			stopped: this.stopped,
			connected: () => true,
			producerAlive: (row) => this.alive(row),
			mine: (row) => this.binding.here().sessionId === row.session_id && row.created_by.left === undefined && sameProducer(row.created_by, this.self),
		};
	}

	/**
	 * A row this window just produced. One the person typed (`/inbox claim`, a recipe command,
	 * `/new-trigger`) is their input: it ends the hold a stopped run put on queued turns, as pi's
	 * `input` event does for a typed message, which pi does not fire for an extension command.
	 */
	produced(row: SessionRequest): void {
		if (typedByPerson(row.source)) this.personInput();
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
		if (showsTriggeredTurnLine(row.source)) triggeredTurnLine(this.ctx(), row.id, true);
	}

	/** pi's own abort, as Esc is: `agentEnded(now, true)` then puts the hold on queued turns. */
	abort(): void {
		this.ctx()?.abort();
	}

	abortWhenStarted(id: string): void {
		this.abortOnStart.add(id);
	}

	/** At `agent_settled`: what pi dropped is offered again by the next drain, unless a stop named it. Returns the ids forgotten. */
	settled(): string[] {
		const dropped = forgetDropped(this.handedOver, (id) => this.entries("").has(id));
		for (const id of dropped) if (this.abortOnStart.delete(id)) this.stopped.add(id);
		return dropped;
	}

	/** At `agent_start`: a run is on; which row began it is known at its first user message. */
	agentStarted(now: number): void {
		this.running = { startedAt: stamp(now) };
	}

	/**
	 * At `message_start`: a user message that starts with `[Trigger <id>] ` names the row the run is
	 * for. A row a stop named is aborted here; pi still writes the message at `message_end` (its
	 * agent loop emits the two back to back), so the proof lands and the row is done, not offered again.
	 */
	messageStarted(message: unknown): void {
		const id = triggerIdOf(message);
		if (id === undefined) return;
		if (this.running) this.running = { ...this.running, requestId: id };
		if (this.abortOnStart.delete(id)) this.ctx()?.abort();
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
