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
import { CEILING, type ConversationView, type Executor, type ExecutorView, type Producer, conversationView, landed, modeOf, personTextMatches, queuedTriggeredTurn, requestFingerprint, sameProducer, typedByPerson } from "./engine.ts";
import { type LeaseBinding, type ProcessProbe, systemProbe } from "./lease.ts";
import type { ImageContent, RequestMode, SessionRequest } from "./requests.ts";
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

/**
 * Whose turn the agent is in, and under what cap (design §4.4, §6.3): a pi-loops row, with the mode
 * and the declared tools its turn runs under, or a message the person typed or queued, which is
 * theirs and capped by nothing of ours. Known from the user message that starts the turn, and in
 * force until the turn settles: pi's retries and follow-ups start runs with no user message, and a
 * cap that ended with the run would end at the first provider error. A message the person queues
 * into a scheduled run makes what follows theirs.
 */
export type CurrentTurn = { kind: "row"; id: string; mode: RequestMode; tools?: readonly string[]; builtinTools?: readonly string[] } | { kind: "person" };

/** Whether a call made now is a scheduled turn's, which the window caps (`src/window-guard.ts`). */
export function unattendedTurn(current: CurrentTurn | undefined): current is CurrentTurn & { kind: "row" } {
	return current?.kind === "row" && current.mode === "unattended";
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

/** What the executor asks the lease binding: the session bound and whether it is held, and whether another process holding it delivers person rows. */
type WindowBinding = Pick<LeaseBinding, "here"> & Partial<Pick<LeaseBinding, "otherHolderDelivers">>;

/** The default image reader: a window wired without one cannot send a row's images, and says so rather than sending the text without them. */
const noImages = (row: SessionRequest): ImageContent[] => {
	throw new Error(`request ${row.id} has images and this window has no way to read them`);
};

/** The text of a user message, as `landed` matches a person row against it. */
function userTextOf(message: unknown): string | undefined {
	const value = message as { role?: unknown; content?: unknown } | undefined;
	if (!value || value.role !== "user") return undefined;
	const content = value.content;
	return typeof content === "string" ? content : Array.isArray(content) ? ((content.find((part) => part?.type === "text") as { text?: string } | undefined)?.text ?? "") : undefined;
}

export class WindowExecutor implements Executor {
	private readonly pi: Pick<ExtensionAPI, "sendMessage" | "sendUserMessage">;
	private readonly binding: WindowBinding;
	private readonly ctx: () => WindowCtx | undefined;
	/** Rows this process has handed pi and pi has not written yet. */
	readonly handedOver = new Set<string>();
	/** What the turn rows in `handedOver` run under, until each one's turn starts and takes it as `current`. */
	private readonly caps = new Map<string, CurrentTurn & { kind: "row" }>();
	/**
	 * The person rows in `handedOver`, oldest first, with the text each one's user message will carry:
	 * a person row has no `[Trigger]` prefix, so its turn is known by its text at `message_start`.
	 */
	private readonly personCaps: Array<{ cap: CurrentTurn & { kind: "row" }; text: string }> = [];
	/**
	 * Caps of person rows pi was judged to have refused, moved aside when the next person row is
	 * handed over: a message that is one of these, sent late by pi, still runs under it. Claimed only
	 * when no row handed over since matches, so "fix" cannot take the turn of "fix it and push".
	 */
	private readonly lateCaps: Array<{ cap: CurrentTurn & { kind: "row" }; text: string }> = [];
	/** When each turn row in `handedOver` was handed to pi, while pi has started no run since (`ExecutorView.inFlightSince`). */
	private readonly handedIdle = new Map<string, number>();
	/** Rows pi was handed and had not written when it settled (`ExecutorView.dropped`), until the engine counts the attempt or hands them over again. */
	private readonly dropped = new Set<string>();
	/** The run pi is in, and the row it started from when a `[Trigger <id>]` message began it. */
	private running: ExecutorView["running"];
	/** The rows still in the request file: the cap of a turn this instance did not hand over itself, and the person rows a proof is matched among. */
	private readonly rows: () => SessionRequest[];
	/**
	 * The rows this instance wrote (`produced`), by id, with what they said. An attended source is
	 * trusted only on one of these, and only while the row in the file still says it: a row somebody
	 * else wrote with `recipe:` or `inbox:` on it, or one of ours a capped turn rewrote in the file,
	 * runs as unattended with no declared tools, so the person is asked before anything dangerous.
	 */
	private readonly producedRows = new Map<string, string>();
	/** Whose turn pi is in now: set at a user `message_start`, cleared when the turn settles. */
	private current: CurrentTurn | undefined;
	/**
	 * Submissions the person made (pi's `input` event) whose user message has not started yet. A user
	 * message without a row of ours behind it is the person's only while one of these is pending;
	 * otherwise it is another extension's, and the cap in force stays.
	 */
	private personPending = 0;
	/** Until when pi-loops `turn` rows wait after an aborted run (ABORT_HOLD_MS, or the person's next input). */
	private heldUntil: number | undefined;
	/** When the hold on the person's own rows began after an aborted run (`ExecutorView.personHeldSince`): they wait until they act, never on a clock. */
	private personHeldSince: number | undefined;
	/**
	 * Rows a stop named while pi held them unstarted: each is aborted at the `message_start` that
	 * begins its turn. One pi dropped instead (Esc) moves to `stopped`, and the next drain removes it
	 * as cancelled rather than offering it again: the stop was for that row.
	 */
	private readonly abortOnStart = new Set<string>();
	private readonly stopped = new Set<string>();
	/**
	 * Rows whose turn started with a message that does not carry their prefix (another extension
	 * rewrote it): they ran, so they are done, though the file will never prove it. Offered again they
	 * would run a second time, which 0.22 never did.
	 */
	private readonly ranUnproved = new Set<string>();
	private readonly self: Producer;
	private readonly alive: (row: SessionRequest) => boolean;
	/** The bytes of a person row's images (`RequestStore.images`): read as the row is handed over, not kept with the row. */
	private readonly images: (row: SessionRequest) => ImageContent[];

	constructor(pi: Pick<ExtensionAPI, "sendMessage" | "sendUserMessage">, binding: WindowBinding, ctx: () => WindowCtx | undefined, self: Producer, alive: (row: SessionRequest) => boolean = producerAlive, rows: () => SessionRequest[] = () => [], images: (row: SessionRequest) => ImageContent[] = noImages) {
		this.rows = rows;
		this.pi = pi;
		this.binding = binding;
		this.ctx = ctx;
		this.self = self;
		this.alive = alive;
		this.images = images;
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

	entries(_sessionId: string): ConversationView {
		const ctx = this.ctx();
		return conversationView(() => ctx?.sessionManager.getEntries() ?? []);
	}

	/** Whether a row this window handed over is in the conversation: by its prefix, or, for a person row, by its text since its stamp (`landed`). A row gone from the file is nobody's to wait for. */
	private landedHere(id: string): boolean {
		const row = this.rows().find((r) => r.id === id);
		return row ? landed(row, this.entries("")) : this.entries("").has(id);
	}

	view(sessionId: string): ExecutorView {
		// What pi has written is in the conversation, not in flight any more.
		for (const id of [...this.handedOver]) {
			if (!this.landedHere(id)) continue;
			this.handedOver.delete(id);
			this.handedIdle.delete(id);
		}
		// A person row's cap lives as long as the row: one pi refused keeps it, since pi may yet run
		// the send late (see `refused`); one gone from the file has nothing left to start.
		const queued = new Set(this.rows().map((row) => row.id));
		for (let at = this.personCaps.length - 1; at >= 0; at--) if (!queued.has(this.personCaps[at].cap.id) && !this.handedOver.has(this.personCaps[at].cap.id)) this.personCaps.splice(at, 1);
		for (let at = this.lateCaps.length - 1; at >= 0; at--) if (!queued.has(this.lateCaps[at].cap.id)) this.lateCaps.splice(at, 1);
		// What this window produced is remembered for as long as the row can still start a turn: a
		// window open for weeks produces a row per slot, and the file is where the rows that matter are.
		for (const id of [...this.producedRows.keys()]) if (!queued.has(id) && !this.handedOver.has(id)) this.producedRows.delete(id);
		for (const id of [...this.dropped]) if (!queued.has(id)) this.dropped.delete(id);
		for (const id of [...this.ranUnproved]) if (!queued.has(id)) this.ranUnproved.delete(id);
		return {
			kind: "window",
			ceiling: CEILING.window,
			admits: () => true,
			idle: this.ctx()?.isIdle() ?? true,
			heldUntil: this.heldUntil,
			personHeldSince: this.personHeldSince,
			running: this.running,
			inFlight: this.handedOver,
			stopped: this.stopped,
			ran: this.ranUnproved,
			inFlightSince: this.handedIdle,
			dropped: this.dropped,
			believed: (row) => this.producedRows.get(row.id) === requestFingerprint(row),
			connected: () => true,
			producerAlive: (row) => this.alive(row),
			// A page's row this window was rung for is this window's as a local row is: the ring that
			// makes it the person's also names the pi it was typed into.
			mine: (row) => this.binding.here().sessionId === row.session_id && row.created_by.left === undefined && (sameProducer(row.created_by, this.self) || (row.source === "person" && this.producedRows.get(row.id) === requestFingerprint(row))),
			holderDelivers: this.binding.otherHolderDelivers?.(),
		};
	}

	/**
	 * A row this window just produced: remembered, so its source is believed when its turn starts.
	 * One the person typed (`/inbox claim`, a recipe command, `/new-trigger`) is their input: it ends
	 * the hold a stopped run put on queued turns, as pi's `input` event does for a typed message,
	 * which pi does not fire for an extension command.
	 */
	produced(row: SessionRequest): void {
		this.producedRows.set(row.id, requestFingerprint(row));
		if (typedByPerson(row.source)) {
			this.heldUntil = undefined;
			this.personHeldSince = undefined;
		}
		// A ring that arrives after the hand-over (the page rang while pi was emitting agent_settled,
		// and the drain in that handler went first): the row is the page's all the same, so its turn,
		// started or not, runs under the cap the ring vouches for.
		const pending = this.personCaps.find((p) => p.cap.id === row.id);
		if (pending) pending.cap = this.capOf(row);
		if (this.current?.kind === "row" && this.current.id === row.id) this.current = this.capOf(row);
	}

	/**
	 * The cap a row's turn runs under here. The mode is recomputed from the source, never read from
	 * the file; and an attended source is believed only on a row this instance wrote itself. Any other
	 * attended row (one written into the file by hand, or by a capped turn; a local row the holder runs
	 * once its producer left) runs as unattended with nothing declared: the danger check alone, which
	 * asks the person in the window.
	 */
	private capOf(row: SessionRequest): CurrentTurn & { kind: "row" } {
		const mode = modeOf(row.kind, row.source, row.wake);
		if (mode === "attended" && this.producedRows.get(row.id) !== requestFingerprint(row)) return { kind: "row", id: row.id, mode: "unattended" };
		return { kind: "row", id: row.id, mode, tools: row.payload?.tools, builtinTools: row.payload?.builtin_tools };
	}

	append(row: SessionRequest, wakeAgent: boolean): void {
		const content = row.payload?.text ?? "";
		if (wakeAgent) this.pi.sendMessage({ customType: "pi-loops:trigger", content, display: true }, { triggerTurn: true, deliverAs: "followUp" });
		else this.pi.sendMessage({ customType: "pi-loops:trigger", content, display: true }, { triggerTurn: false });
		this.handedOver.add(row.id);
	}

	/**
	 * Handed over only while pi is idle, so `followUp` matters in one case: the person started a run
	 * between the engine's idle check and this call, and pi then queues the row behind that run. A
	 * person row goes as the person's own message would, images with it; its cap is taken by the next
	 * user message with its text (`messageStarted`), there being no prefix to name it by. A person row
	 * this window was not rung for (`produced`), one a terminal runs for a page or a forged one, is
	 * capped as unattended by `capOf`, so the window asks before a dangerous command.
	 */
	turn(row: SessionRequest, now = Date.now()): void {
		const text = row.payload?.text ?? "";
		// Read before anything is handed over: images that cannot be read, or are not the row's, fail
		// the hand-over (the engine records the error on the row) instead of sending the text alone.
		const images = row.payload?.images?.length ? this.images(row) : undefined;
		if (row.source === "person") {
			// A cap kept for a row pi refused (`refused`) ends here: a later person row is handed over,
			// and a message that starts with the refused row's words is more likely that one's.
			for (let at = this.personCaps.length - 1; at >= 0; at--) if (!this.handedOver.has(this.personCaps[at].cap.id)) this.lateCaps.push(...this.personCaps.splice(at, 1));
			this.pi.sendUserMessage(images?.length ? [{ type: "text", text }, ...images] : text, { deliverAs: "followUp" });
			this.personCaps.push({ cap: this.capOf(row), text });
		} else {
			this.pi.sendUserMessage(text, { deliverAs: "followUp" });
			this.caps.set(row.id, this.capOf(row));
		}
		this.handedOver.add(row.id);
		this.handedIdle.set(row.id, now);
		this.dropped.delete(row.id);
		if (showsTriggeredTurnLine(row.source)) triggeredTurnLine(this.ctx(), row.id, true);
	}

	/** Whose turn pi is in now, for the `tool_call` cap: a row's, the person's, or none. */
	currentTurn(): CurrentTurn | undefined {
		return this.current;
	}

	/** pi's own abort, as Esc is: `agentEnded(now, true)` then puts the hold on queued turns. */
	abort(): void {
		this.ctx()?.abort();
	}

	abortWhenStarted(id: string): void {
		this.abortOnStart.add(id);
	}

	/**
	 * pi did not write the row (a `fail` action): not in flight any more, and the attempt is counted.
	 * A person row's cap stays (`view` drops it with the row): a send pi runs late still runs under
	 * it. A pi-loops row's turn, started late, takes its cap from the row in the file (`messageStarted`).
	 */
	refused(id: string): void {
		this.handedOver.delete(id);
		this.handedIdle.delete(id);
		this.caps.delete(id);
		this.dropped.delete(id);
	}

	private forgetPersonCap(id: string): void {
		const at = this.personCaps.findIndex((p) => p.cap.id === id);
		if (at >= 0) this.personCaps.splice(at, 1);
	}

	/**
	 * At `agent_settled`: the turn is over, with its retries and follow-ups, so the cap in force ends
	 * here and nowhere earlier. What pi dropped is offered again by the next drain, unless a stop
	 * named it. A person submission still pending was dropped with pi's queue. Returns the ids forgotten.
	 */
	settled(): string[] {
		this.current = undefined;
		this.personPending = 0;
		const dropped = forgetDropped(this.handedOver, (id) => this.landedHere(id));
		for (const id of dropped) {
			this.caps.delete(id);
			this.handedIdle.delete(id);
			this.forgetPersonCap(id);
			if (this.abortOnStart.delete(id)) this.stopped.add(id);
			else this.dropped.add(id);
		}
		return dropped;
	}

	/**
	 * At `agent_start`: a run is on; which row began it is known at its first user message. A retry
	 * starts one too, under the cap in force. Whatever rows were handed over, pi took something since:
	 * none of them was refused, and a dropped one is found at `settled`.
	 */
	agentStarted(now: number): void {
		this.running = { startedAt: stamp(now) };
		this.handedIdle.clear();
	}

	/**
	 * pi emitted `input` (ours or anyone's) or began a message: it is in its pre-run phase for
	 * something, so what was handed over is not refused yet. The grace counts again from here.
	 */
	inputSeen(now: number): void {
		for (const id of this.handedIdle.keys()) this.handedIdle.set(id, now);
	}

	/**
	 * At `message_start`, for a user message (a custom one changes nothing). One that starts with
	 * `[Trigger <id>] ` names a row: the one this instance handed over, else the one still in the
	 * request file (an earlier instance in this process handed it over, before a /reload), and that
	 * row's cap is the turn's from here. Any other user message is the person's when they submitted
	 * one that has not started yet (pi's `input` event, counted in `personInput`); otherwise it is
	 * another extension's and changes nothing while a row's cap is in force; with none in force it is
	 * the person's, or nobody's, and uncapped. A row a stop named is aborted here; pi still writes the
	 * message at `message_end` (its agent loop emits the two back to back), so the proof lands and the
	 * row is done, not offered again.
	 */
	messageStarted(message: unknown, now = Date.now()): void {
		const text = userTextOf(message);
		if (text === undefined) return;
		this.inputSeen(now);
		const id = triggerIdOf(message);
		if (id !== undefined) {
			if (this.running) this.running = { ...this.running, requestId: id };
			if (this.abortOnStart.delete(id)) this.ctx()?.abort();
			const cap = this.caps.get(id);
			this.caps.delete(id);
			const row = cap ? undefined : this.rows().find((r) => r.id === id);
			if (cap || row) {
				// A row's turn starting: a submission counted before it that never became a message (an
				// input another extension handled, a prompt pi refused) is not what follows. Reset
				// whatever cycle this is: at worst the person's next message is asked about once.
				this.personPending = 0;
				this.current = cap ?? this.capOf(row!);
				return;
			}
		}
		// A person row's turn: of the rows handed over whose text this message is (`personTextMatches`:
		// pi appends a note when it resizes or converts an image), the one with the longest text, the
		// most recently handed over on a tie, so "fix" does not take the turn of "fix it and push
		// --force". Before a submission pending from the terminal, since the row was handed over first.
		const claim = (caps: typeof this.personCaps) => {
			let person = -1;
			for (let at = 0; at < caps.length; at++) {
				if (!personTextMatches(text, caps[at].text)) continue;
				if (person < 0 || caps[at].text.length >= caps[person].text.length) person = at;
			}
			return person < 0 ? undefined : caps.splice(person, 1)[0];
		};
		// What the person submitted comes before a refused row's kept cap; a send pi runs late is
		// claimed only by a message nobody else accounts for.
		const claimed = claim(this.personCaps) ?? (this.personPending > 0 ? undefined : claim(this.lateCaps));
		if (claimed) {
			const { cap } = claimed;
			if (this.running) this.running = { ...this.running, requestId: cap.id };
			if (this.abortOnStart.delete(cap.id)) this.ctx()?.abort();
			this.personPending = 0;
			this.current = cap;
			return;
		}
		// A message with no prefix at all while a pi-loops row is handed over and unstarted: another
		// extension's `input` handler rewrote the text. pi runs what it was given in order, so the
		// oldest handed over is the turn starting now, and it runs under its cap. The person's own
		// pending submission wins; a message with a prefix that names no row of ours is somebody else's.
		const oldest = this.caps.entries().next();
		if (id === undefined && this.personPending === 0 && !oldest.done) {
			const [handedId, cap] = oldest.value;
			this.caps.delete(handedId);
			this.handedOver.delete(handedId);
			this.handedIdle.delete(handedId);
			this.ranUnproved.add(handedId);
			if (this.running) this.running = { ...this.running, requestId: handedId };
			if (this.abortOnStart.delete(handedId)) this.ctx()?.abort();
			this.current = cap;
			return;
		}
		if (this.personPending > 0) {
			this.personPending--;
			this.current = { kind: "person" };
		} else if (this.current?.kind !== "row") this.current = { kind: "person" };
	}

	/**
	 * At `agent_end`. An aborted run holds pi-loops `turn` rows until the person's next input, or
	 * ABORT_HOLD_MS; the person's own rows until they act (`personInput`, or `produced` for a row they
	 * sent or chose to send), with no clock: a timer must never send words a person stopped. The cap
	 * in force outlives the run (`settled`).
	 */
	agentEnded(now: number, aborted: boolean): void {
		this.running = undefined;
		if (aborted) {
			this.heldUntil = now + ABORT_HOLD_MS;
			this.personHeldSince = now;
		}
	}

	/** The person submitted something (pi's `input` event, not from an extension): the hold after an abort is over, and the next user message is theirs. */
	personInput(): void {
		this.heldUntil = undefined;
		this.personHeldSince = undefined;
		this.personPending++;
	}
}
