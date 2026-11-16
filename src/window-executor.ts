/**
 * The engine's executor in a window: the pi this extension runs in, holding its conversation's
 * lease. An `append` row goes into the chat through `pi.sendMessage`, its mark in the message's
 * details: inserted at once while idle, with no turn; as a follow-up during a turn, which runs one
 * when the current one ends (docs/design.md decision 9). A `turn` row goes through
 * `pi.sendUserMessage`, only while pi is idle (the engine decides that), and after the lease says a
 * row is held (`LeaseBinding.hold`). The window keeps one list of what it gave pi and of the
 * messages that are not ours (src/window-claim.ts); at each user message it decides once whose the
 * message is, and writes the row's mark into the entry pi writes for it (`messageEnded`). What it is
 * not sure of only takes a mark away: a message of ours with no mark costs one more delivery at
 * most, and a mark on another row's message is never written.
 */
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { CEILING, type Executor, type ExecutorView, type Producer, type TurnSent, carriesPrefix, proofOf, landed, modeOf, queuedTriggeredTurn, requestFingerprint, sameProducer, type Proof, claimAlive , type Gone } from "./engine.ts";
import { type LeaseBinding, type ProcessProbe, systemProbe } from "./lease.ts";
import { markDetails, markFor, withMark } from "./mark.ts";
import type { ImageContent, RequestMode, Row, UnclaimedRow } from "./requests.ts";
import type { RunRecord } from "./store.ts";
import { stamp } from "./schedule.ts";
import { type Slot, type TurnSlot, claimOf, cleanEditor, narrowestCap, settleSlots } from "./window-claim.ts";

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
export function producerAlive(row: Pick<Row, "created_by" | "created_at">, probe: ProcessProbe = systemProbe): boolean {
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
export function showsTriggeredTurnLine(source: Row["source"]): boolean {
	return source.startsWith("cron:") || source.startsWith("cron-run:") || source.startsWith("push:");
}

type WindowCtx = Pick<ExtensionContext, "isIdle" | "mode" | "sessionManager" | "hasUI" | "ui" | "abort" | "hasPendingMessages">;

/** What the executor asks the lease binding: the session bound and whether it is held, the hold of a row before it is sent, and whether another process holding it delivers person rows. */
type WindowBinding = Pick<LeaseBinding, "here" | "hold" | "letGo"> & Partial<Pick<LeaseBinding, "otherHolderDelivers">>;

/** The default image reader: a window wired without one cannot send a row's images, and says so rather than sending the text without them. */
const noImages = (row: Row): ImageContent[] => {
	throw new Error(`request ${row.id} has images and this window has no way to read them`);
};

/** The text of a user message, as pi starts it; undefined for any other role. */
function userTextOf(message: unknown): string | undefined {
	const value = message as { role?: unknown; content?: unknown } | undefined;
	if (!value || value.role !== "user") return undefined;
	const content = value.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const text = (content.find((part) => part?.type === "text") as { text?: unknown } | undefined)?.text;
	return typeof text === "string" ? text : "";
}

/** A slot pi holds for a row and has not begun to write: in flight, not a message under way, not one the engine stopped waiting for. */
const inFlight = (slot: Slot): boolean => slot.whose === "append" || (slot.whose === "turn" && slot.phase.is !== "refused");

export class WindowExecutor implements Executor {
	private readonly pi: Pick<ExtensionAPI, "sendMessage" | "sendUserMessage">;
	private readonly binding: WindowBinding;
	private readonly ctx: () => WindowCtx | undefined;
	/**
	 * What pi was given and has not written (rows of ours), and the messages that are not ours that
	 * pi announced and has not started (src/window-claim.ts). All the state there is about hand-overs.
	 */
	private slots: Slot[] = [];
	/** Rows that left `slots` unwritten, with the reason (`ExecutorView.gone`), until the engine acts on one or it leaves the file. */
	private readonly gone = new Map<string, Gone>();
	/** The run pi is in, and the row whose message it last began. */
	private running: ExecutorView["running"];
	/** No user message of the run that is on has started yet. */
	private firstOfRun = false;
	/** The rows still in the request file: the cap of a turn this instance did not hand over itself. */
	private readonly rows: () => Row[];
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
	 * True for the length of this window's own `sendUserMessage` call. When no other extension's
	 * `input` handler runs before ours, pi's `input` for our send reaches us inside the call (probe P6);
	 * otherwise it comes after, and the text tells it.
	 */
	private sending = false;
	private readonly self: Producer;
	private readonly alive: (row: Row) => boolean;
	/** The bytes of a person row's images (`RequestStore.images`): read as the row is handed over, not kept with the row. */
	private readonly images: (row: Row) => ImageContent[];
	/** The run log, read only when a row with a claim is asked about. */
	private readonly runs: () => readonly RunRecord[];

	constructor(pi: Pick<ExtensionAPI, "sendMessage" | "sendUserMessage">, binding: WindowBinding, ctx: () => WindowCtx | undefined, self: Producer, alive: (row: Row) => boolean = producerAlive, rows: () => Row[] = () => [], images: (row: Row) => ImageContent[] = noImages, runs: () => readonly RunRecord[]) {
		this.rows = rows;
		this.runs = runs;
		this.pi = pi;
		this.binding = binding;
		this.ctx = ctx;
		this.self = self;
		this.alive = alive;
		this.images = images;
	}

	/** The rows pi holds for this window and has not written: the derived claims. */
	get handedOver(): ReadonlySet<string> {
		return new Set(this.slots.flatMap((slot) => (slot.whose !== "other" && inFlight(slot) ? [slot.mark.id] : [])));
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

	proof(lane: string): Proof {
		const ctx = this.ctx();
		// A window writes no run record for a turn it runs. It reads the run log for a row a background
		// run claimed and left: what that run came to decides the row, here as anywhere.
		return proofOf(lane, () => ctx?.sessionManager.getEntries() ?? [], this.runs);
	}

	/** Whether row `id`'s delivery is in this conversation (src/engine.ts `landed`), read off the row in the request file, or by its mark alone once the row left the file. */
	delivered(id: string): boolean {
		const proof = this.proof(this.binding.here().sessionId ?? "");
		const row = this.rows().find((r) => r.id === id);
		return row ? landed(row, proof) : proof.has(id);
	}

	view(sessionId: string): ExecutorView {
		const queued = new Set(this.rows().map((row) => row.id));
		const ctx = this.ctx();
		// pi idle, no run on, and no user message held: what was queued behind a run is gone (the
		// page's "clear queue" empties pi and tells no extension). Only this reading of
		// `hasPendingMessages()` is used: true can be the person's own message (probe g9).
		const empty = !this.running && (ctx?.isIdle() ?? true) && ctx?.hasPendingMessages?.() === false;
		const next: Slot[] = [];
		for (const slot of this.slots) {
			if (slot.whose === "other") {
				// A message someone sent during a run that pi no longer holds (the page cleared the queue).
				if (!(empty && slot.behind)) next.push(slot);
				continue;
			}
			// What pi wrote is in the conversation, whoever wrote it.
			if (this.delivered(slot.mark.id)) continue;
			if (slot.whose === "turn") {
				// A prompt queued behind a run that pi no longer holds. Not a prompt handed to the idle pi
				// that it has not started (`pending`, or a `refused` one): `hasPendingMessages()` does not count those.
				if (empty && slot.phase.is === "queued") {
					this.gone.set(slot.mark.id, slot.stop ? "stopped" : "dropped");
					continue;
				}
				if (!queued.has(slot.mark.id)) {
					// The row left the file. A prompt a cancel or a stop named stays, to be aborted if pi
					// writes it after all; anything else has nothing left to start. One that opened the run
					// stays `opening`: its message is the run's first, before any follow-up.
					if (slot.stop && slot.phase.is !== "written" && slot.phase.is !== "writing") next.push({ ...slot, left: true, ...(slot.phase.is === "opening" ? {} : { phase: { is: "refused" } as const }) });
					// A refused one stays too: pi may still write it, and its mark then proves the row
					// if the same row is queued again (a loop's slot after a dead letter).
					else if (slot.phase.is === "refused") next.push({ ...slot, left: true });
					continue;
				}
			} else if (!queued.has(slot.mark.id)) continue;
			next.push(slot);
		}
		this.slots = next;
		for (const id of [...this.gone.keys()]) if (!queued.has(id)) this.gone.delete(id);
		// What this window produced is remembered for as long as the row can still start a turn: a
		// window open for weeks produces a row per slot, and the file is where the rows that matter are.
		const handed = this.handedOver;
		for (const id of [...this.producedRows.keys()]) if (!queued.has(id) && !handed.has(id)) this.producedRows.delete(id);
		this.letGoWhenFree();
		return {
			kind: "window",
			ceiling: CEILING.window,
			blocked: () => undefined,
			claimLive: (row) => claimAlive(row),
			idle: ctx?.isIdle() ?? true,
			running: this.running,
			inFlight: handed,
			inFlightSince: new Map(this.slots.flatMap((slot) => (slot.whose === "turn" && slot.phase.is === "pending" ? [[slot.mark.id, slot.phase.since] as const] : []))),
			gone: this.gone,
			believed: (row) => this.producedRows.get(row.id) === requestFingerprint(row),
			connected: () => true,
			producerAlive: (row) => this.alive(row),
			// A page's row this window was rung for is this window's as a local row is: the ring that
			// makes it the person's also names the pi it was typed into.
			mine: (row) => this.binding.here().sessionId === row.lane && row.created_by.left === undefined && (sameProducer(row.created_by, this.self) || (row.source === "person" && this.producedRows.get(row.id) === requestFingerprint(row))),
			holderDelivers: this.binding.otherHolderDelivers?.(),
		};
	}

	/** A row this window just produced: remembered, so its source is believed when its turn starts. */
	produced(row: Row): void {
		this.producedRows.set(row.id, requestFingerprint(row));
		// A ring that arrives after the hand-over (the page rang while pi was emitting agent_settled,
		// and the drain in that handler went first): the row is the page's all the same, so its turn,
		// started or not, runs under the cap the ring vouches for.
		this.slots = this.slots.map((slot) => (slot.whose === "turn" && slot.mark.id === row.id ? { ...slot, cap: this.capOf(row) } : slot));
		if (this.current?.kind === "row" && this.current.id === row.id) this.current = this.capOf(row);
	}

	/**
	 * The cap a row's turn runs under here. The mode is recomputed from the source, never read from
	 * the file; and an attended source is believed only on a row this instance wrote itself. Any other
	 * attended row (one written into the file by hand, or by a capped turn; a local row the holder runs
	 * once its producer left) runs as unattended with nothing declared: the danger check alone, which
	 * asks the person in the window.
	 */
	private capOf(row: Row): CurrentTurn & { kind: "row" } {
		const mode = modeOf("conversation", row.kind, row.source, row.wake);
		if (mode === "attended" && this.producedRows.get(row.id) !== requestFingerprint(row)) return { kind: "row", id: row.id, mode: "unattended" };
		return { kind: "row", id: row.id, mode, tools: row.payload?.tools, builtinTools: row.payload?.builtin_tools };
	}

	/**
	 * An `append` row, its mark in the custom message's details: no rule has to find its message. Into
	 * an idle pi it is written at once, and the next `view` finds it. As a follow-up during a run it is
	 * held on the lease first, as a turn is: pi keeps it after a stop in the page (probe G1).
	 */
	append(row: UnclaimedRow, wakeAgent: boolean): TurnSent {
		const mark = markFor(row);
		const message = { customType: "pi-loops:trigger", content: row.payload?.text ?? "", display: true, details: markDetails(mark) };
		if (wakeAgent && !this.binding.hold(stamp(Date.now()))) return "lease-lost";
		this.slots.push({ whose: "append", mark });
		try {
			if (wakeAgent) this.pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
			else this.pi.sendMessage(message, { triggerTurn: false });
		} catch (err) {
			this.slots = this.slots.filter((slot) => slot.whose !== "append" || slot.mark.id !== row.id);
			this.letGoWhenFree();
			throw err;
		}
		return "sent";
	}

	/**
	 * A turn row, handed to an idle pi (the engine decides that), so `followUp` matters in one case: a
	 * run began between the engine's look and this call, and pi queues the row behind it. The order of
	 * the steps is the point of issue 248: the images are read (a failure throws before anything is
	 * written); the lease says a row is held; the slot is in the list (the `input` the send emits
	 * finds it); then the send. Every row goes in its own words, a person's images with it: nothing is
	 * added to its text. A person row this window was not rung for (`produced`) is capped as unattended
	 * by `capOf`, so the window asks before a dangerous command.
	 */
	turn(row: UnclaimedRow, now = Date.now()): TurnSent {
		const text = row.payload?.text ?? "";
		const images = row.payload?.images?.length ? this.images(row) : undefined;
		if (!this.binding.hold(stamp(now))) return "lease-lost";
		const idle = this.ctx()?.isIdle() ?? true;
		const slot: TurnSlot = { whose: "turn", mark: markFor(row), text, ...(carriesPrefix(row.source) ? { prefix: `[Trigger ${row.id}] ` } : {}), cap: this.capOf(row), phase: idle ? { is: "pending", since: now } : { is: "queued" }, echoed: false };
		// An earlier hand-over of the row (a `refused` one pi may still send late) stays if pi throws at
		// this one. One whose row left the file (the same row queued again since) stays beside it.
		const earlier = this.slots.find((s) => s.whose === "turn" && s.mark.id === row.id && !s.left);
		this.slots = [...this.slots.filter((s) => s !== earlier), slot];
		this.sending = true;
		try {
			this.pi.sendUserMessage(images?.length ? [{ type: "text", text }, ...images] : text, { deliverAs: "followUp" });
		} catch (err) {
			this.slots = [...this.slots.filter((s) => s !== slot), ...(earlier ? [earlier] : [])];
			this.letGoWhenFree();
			throw err;
		} finally {
			this.sending = false;
		}
		if (showsTriggeredTurnLine(row.source)) triggeredTurnLine(this.ctx(), row.id, true);
		return "sent";
	}

	/** Whose turn pi is in now, for the `tool_call` cap: a row's, the person's, or none. */
	currentTurn(): CurrentTurn | undefined {
		return this.current;
	}

	/** pi's own abort, as Esc is: it stops the current turn and nothing else. */
	abort(): void {
		this.ctx()?.abort();
	}

	/** A stop named row `id` while pi holds it, or a cancel took it out: its turn is aborted as its message starts, and it is `stopped` when it goes unwritten. */
	abortWhenStarted(id: string): void {
		this.slots = this.slots.map((slot) => (slot.whose !== "other" && slot.mark.id === id ? { ...slot, stop: true } : slot));
	}

	/**
	 * The engine failed row `id` (a `fail` action). One it failed for a `gone` reason is out of the list
	 * already. Otherwise the grace judged the hand-over refused: pi may still hold the prompt and send it
	 * late, so its slot stays, `refused`: not in flight, and still the row's for a message with its
	 * very text, which then proves it rather than delivering it twice.
	 */
	refused(id: string): void {
		if (this.gone.delete(id)) return;
		this.slots = this.slots.flatMap((slot) => (slot.whose === "other" || slot.mark.id !== id ? [slot] : slot.whose === "turn" ? [{ ...slot, phase: { is: "refused" } as const }] : []));
		this.letGoWhenFree();
	}

	/**
	 * At `agent_settled`, with whether the run was aborted: the turn is over, with its retries and
	 * follow-ups, so the cap in force ends here. What is left of the list is `settleSlots`'s; in a
	 * terminal a stop put the queued prompts into the editor, and the ones of this window's rows are
	 * taken out of it again, the person's own words left. Returns the ids that are gone.
	 */
	settled(aborted = false): string[] {
		this.current = undefined;
		const ctx = this.ctx();
		const terminal = ctx?.mode === "tui";
		// A row that left the file since the last look (an exit in the drain that ran since) owes no exit:
		// what pi did with its prompt must not reach the same row queued again.
		const queued = new Set(this.rows().map((row) => row.id));
		const slots = this.slots.map((slot) => (slot.whose === "turn" && !slot.left && !queued.has(slot.mark.id) ? { ...slot, left: true as const } : slot));
		const out = settleSlots(slots, { aborted, terminal }, (id) => this.delivered(id));
		this.slots = out.slots;
		for (const [id, why] of out.gone) this.gone.set(id, why);
		if (out.editor.length && terminal && ctx?.hasUI) {
			const text = ctx.ui.getEditorText();
			const cleaned = cleanEditor(text, out.editor);
			if (cleaned !== text) ctx.ui.setEditorText(cleaned);
		}
		this.letGoWhenFree();
		return [...out.gone.keys()];
	}

	/** At `agent_start`: a run is on, and a prompt handed to the idle pi is opening it, or queued behind whatever does. */
	agentStarted(now: number): void {
		this.running = { startedAt: stamp(now) };
		this.firstOfRun = true;
		this.slots = this.slots.map((slot) => (slot.whose === "turn" && slot.phase.is === "pending" ? { ...slot, phase: { is: "opening" } } : slot));
	}

	/**
	 * pi emitted `input`: it is in its pre-run phase for something, so what was handed over is not
	 * refused yet (the grace counts again from here). And the input is ours or not. Ours: the source
	 * `extension`, and the event comes inside our own send, or its text is the text of a prompt of ours
	 * not yet echoed, or starts or ends with it (another extension's handler ran first: probe P6).
	 * Anything else is a message that is not ours, from the person or from another extension, until its
	 * user message starts (`claimOf`). An input the window cannot place is filed as not ours: that can
	 * only take a mark away.
	 */
	inputSeen(input: Pick<InputEvent, "source" | "text" | "streamingBehavior">, now: number): void {
		this.slots = this.slots.map((slot) => (slot.whose === "turn" && slot.phase.is === "pending" ? { ...slot, phase: { is: "pending", since: now } } : slot));
		if (input.source === "extension") {
			const ours = (slot: Slot): slot is TurnSlot => slot.whose === "turn" && !slot.echoed && slot.phase.is !== "refused";
			const echo = this.sending ? this.slots.filter(ours).at(-1) : this.slots.find((slot) => ours(slot) && slot.text !== "" && (input.text === slot.text || input.text.startsWith(slot.text) || input.text.endsWith(slot.text)));
			if (echo) {
				this.slots = this.slots.map((slot) => (slot === echo ? { ...echo, echoed: true } : slot));
				return;
			}
		}
		const behind = input.streamingBehavior;
		// During a run, pi refuses a send with no delivery ("Agent is already processing") after its
		// `input` (probe G11): it never becomes a message.
		if (this.running && !behind) return;
		this.slots.push({ whose: "other", from: input.source === "extension" ? "extension" : "person", text: input.text, ...(behind ? { behind } : {}), ...(input.source === "interactive" ? { typed: true as const } : {}), ...(this.running ? { run: this.running.startedAt } : {}) });
	}

	/**
	 * At `message_start`, for a user message (a custom one changes nothing): whose it is, decided once
	 * (`claimOf`). A prompt of ours: its turn runs under the row's cap, and a row a stop named is
	 * aborted here; pi still writes the message at `message_end` (its agent loop emits the two back to
	 * back), with the mark, so the row is done and not offered again. A message that is not ours: the
	 * person's runs uncapped, another extension's leaves a row's cap in force. A message nobody
	 * claims is marked as nobody's; a `[Trigger <id>] ` of a row still in the file (a prompt pi sent
	 * late, or the person sent from the editor) narrows its cap to that row's, and proves nothing.
	 */
	messageStarted(message: unknown, now = Date.now()): void {
		const text = userTextOf(message);
		if (text === undefined) return;
		this.slots = this.slots.map((slot) => (slot.whose === "turn" && slot.phase.is === "pending" ? { ...slot, phase: { is: "pending", since: now } } : slot));
		const first = this.firstOfRun;
		this.firstOfRun = false;
		const claim = claimOf(text, this.slots, first ? this.running?.startedAt : undefined);
		this.slots = this.slots.flatMap((slot): Slot[] => {
			if (claim.by === "turn" && slot === claim.slot) return [{ ...slot, phase: { is: "writing", claim } }];
			if (claim.by === "other" && slot === claim.slot) return [];
			// What the person typed into an idle terminal is the first message of the run it starts, or
			// never a message (another extension's input handler took it): a later message is not theirs.
			// Not the page's: pi decides its delivery before the handlers run, and a run can begin meanwhile.
			if (first && slot.whose === "other" && slot.typed && !slot.behind) return [];
			return slot.whose === "turn" && slot.phase.is === "opening" ? [{ ...slot, phase: { is: "queued" } }] : [slot];
		});
		if (claim.by === "turn") {
			if (this.running) this.running = { ...this.running, requestId: claim.slot.mark.id };
			this.current = claim.slot.cap;
			if (claim.slot.stop) this.ctx()?.abort();
			return;
		}
		// The person's words, by their text: their turn, uncapped.
		if (claim.by === "other" && claim.byText && claim.slot.from === "person") {
			this.current = { kind: "person" };
			return;
		}
		if (this.current?.kind === "row") return;
		const id = claim.by === "nobody" ? triggerIdOf(message) : undefined;
		const row = id === undefined ? undefined : this.rows().find((r) => r.id === id);
		if (row) {
			if (this.running) this.running = { ...this.running, requestId: row.id };
			this.current = this.capOf(row);
			return;
		}
		// A message the window cannot place, or one it gave a waiting input for want of a better: while
		// pi holds a prompt of ours unwritten (a refused one too: pi may send it late) it may be that
		// prompt, rewritten, so the narrowest of their caps (with no mark: the cost is a second delivery
		// at most). Otherwise it is the person's, or nobody's, and uncapped.
		const held = this.slots.filter((slot): slot is TurnSlot => slot.whose === "turn" && slot.phase.is !== "writing" && slot.phase.is !== "written");
		this.current = narrowestCap(held.map((slot) => slot.cap)) ?? { kind: "person" };
	}

	/**
	 * At `message_end`, before pi persists the message: the message with the mark of the row whose
	 * message started (`messageStarted` decided it), which pi persists in the same write (probe P1),
	 * or undefined, and pi persists the message as it is. It decides nothing.
	 */
	messageEnded<M extends { role: string }>(message: M, _now = Date.now()): { message: M } | undefined {
		if (message.role !== "user") return undefined;
		const writing = this.slots.find((slot): slot is TurnSlot => slot.whose === "turn" && slot.phase.is === "writing");
		if (!writing || writing.phase.is !== "writing") return undefined;
		const claimed = writing.phase.claim.slot;
		this.slots = this.slots.map((slot) => (slot === writing ? { ...writing, phase: { is: "written" } } : slot));
		// A turn a stop or a cancel named whose row has left already: its message, aborted as it
		// starts, answers no row, and a mark would prove the same row queued again.
		if (claimed.stop && claimed.left) return undefined;
		return { message: withMark(message, claimed.mark) };
	}

	/** At `agent_end`: no run is on. The cap in force outlives the run (`settled`). */
	agentEnded(): void {
		this.running = undefined;
	}

	/** The lease says no row is held once pi holds none of ours. */
	private letGoWhenFree(): void {
		if (!this.slots.some((slot) => slot.whose !== "other" && inFlight(slot))) this.binding.letGo();
	}
}
