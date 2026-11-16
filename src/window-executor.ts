/**
 * The engine's executor in a window: the pi this extension runs in, holding its conversation's
 * lease. Every row goes to pi after the lease says a row is held (`LeaseBinding.hold`). An `append`
 * row goes into the chat through `pi.sendMessage`, its mark in the message's details: inserted at
 * once while idle, with no turn; as a follow-up during a turn, which runs one when the current one
 * ends (docs/design.md decision 9). A `turn` row goes the same way, as a custom message of
 * `TURN_TYPE` that asks for a turn, with its mark and its cap in the details: the message names its
 * row, no `input` handler sees it, and no text is read to know it. One row is the exception: the
 * person's own page message (a person row the page's pi was rung for) goes through
 * `pi.sendUserMessage`, as their words, and the window finds its message by its words to write the
 * mark into the entry (`messageEnded`). What it is not sure of there only takes a mark away, and the
 * row goes back to the page once. A turn row's cap is never read from text. One text rule touches a
 * cap: another extension's input that starts with a person row's words is taken for that row's echo
 * (`inputSeen`), and so does not keep a scheduled turn's cap against the user message after it.
 */
import type { ExtensionAPI, ExtensionContext, InputEvent, formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";
import { CEILING, type Executor, type ExecutorView, type Producer, type TurnSent, proofOf, landed, modeOf, queuedTriggeredTurn, requestFingerprint, sameProducer, type Proof, claimAlive , type Gone } from "./engine.ts";
import { type LeaseBinding, type ProcessProbe, systemProbe } from "./lease.ts";
import { TURN_TYPE, type TurnDetails, markDetails, markFor, turnOn, withMark } from "./mark.ts";
import type { ImageContent, RequestMode, Row, UnclaimedRow } from "./requests.ts";
import type { RunRecord } from "./store.ts";
import { stamp } from "./schedule.ts";
import { type PersonSlot, type Slot, type TurnSlot, claimOf, settleSlots } from "./window-claim.ts";

/**
 * Whose turn the agent is in, and under what cap (design §4.4, §6.3): a pi-loops row, with the mode
 * and the declared tools its turn runs under, or a message the person typed or queued, which is
 * theirs and capped by nothing of ours. Known from the message that starts the turn, and in force
 * until the turn settles: pi's retries and follow-ups start runs with no message of their own, and a
 * cap that ended with the run would end at the first provider error. A message the person queues
 * into a scheduled run makes what follows theirs.
 */
export type CurrentTurn = { kind: "row"; id: string; mode: RequestMode; tools?: readonly string[]; builtinTools?: readonly string[] } | { kind: "person" };

/** The cap of a row's turn. */
export type RowCap = CurrentTurn & { kind: "row" };

/** Whether a call made now is a scheduled turn's, which the window caps (`src/window-guard.ts`). */
export function unattendedTurn(current: CurrentTurn | undefined): current is RowCap {
	return current?.kind === "row" && current.mode === "unattended";
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

/** pi's exported image functions, as the window needs them for a turn row's images. */
export interface ImageResizer {
	resizeImage: typeof resizeImage;
	formatDimensionNote: typeof formatDimensionNote;
}

/** The default resizer: a window wired without one cannot send a turn row's images, and says so rather than sending them as they are. */
const noResizer: ImageResizer = {
	resizeImage: () => Promise.reject(new Error("this window has no way to resize a request's images")),
	formatDimensionNote: () => undefined,
};

/**
 * A turn row's text and images as its custom message carries them. pi resizes the images of a user
 * message and not those of a custom message (probe P16), so each one is resized here as pi's user
 * path does it: within pi's limits, with pi's note on the text for one that changed, and left out
 * with pi's note for one that cannot be brought within them.
 */
async function withResizedImages(text: string, images: readonly ImageContent[], resizer: ImageResizer): Promise<TurnContent> {
	const sent: ImageContent[] = [];
	const notes: string[] = [];
	for (const image of images) {
		// The type comes from the request file. pi's user path converts any other type to PNG; that
		// conversion is not exported, so such an image is left out with pi's words for it.
		const mimeType = supportedImageType(image.mimeType);
		if (!mimeType) {
			notes.push("[Image omitted: could not be converted to a supported inline image format.]");
			continue;
		}
		const resized = await resizer.resizeImage(Buffer.from(image.data, "base64"), mimeType);
		if (!resized) {
			notes.push("[Image omitted: could not be resized below the inline image size limit.]");
			continue;
		}
		sent.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
		const note = resizer.formatDimensionNote(resized);
		if (note) notes.push(note);
	}
	return [{ type: "text", text: notes.length ? `${text}\n\n${notes.join("\n")}` : text }, ...sent];
}

/** The image type a provider takes for `mimeType`, as pi's user path reads it; undefined for any other. */
function supportedImageType(mimeType: string): string | undefined {
	const base = mimeType.split(";")[0]?.trim().toLowerCase();
	if (base === "image/jpg") return "image/jpeg";
	return base === "image/png" || base === "image/jpeg" || base === "image/gif" || base === "image/webp" ? base : undefined;
}

/** What a turn row's custom message carries: its text, or its text and its images. */
type TurnContent = string | [{ type: "text"; text: string }, ...ImageContent[]];

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

/** A slot pi holds for a row that is still owed: not a person's prompt the engine stopped waiting for, not a turn whose row left the file. */
const inFlight = (slot: Slot): boolean => slot.whose === "append" || (slot.whose === "turn" && !slot.left) || (slot.whose === "person" && slot.phase.is !== "refused");

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
	/** The rows still in the request file. */
	private readonly rows: () => Row[];
	/**
	 * The rows this instance wrote (`produced`), by id, with what they said. An attended source is
	 * trusted only on one of these, and only while the row in the file still says it: a row somebody
	 * else wrote with `recipe:` or `inbox:` on it, or one of ours a capped turn rewrote in the file,
	 * runs as unattended with no declared tools, so the person is asked before anything dangerous.
	 */
	private readonly producedRows = new Map<string, string>();
	/** Whose turn pi is in now: set as a turn row's message or a user message starts, cleared when the turn settles. */
	private current: CurrentTurn | undefined;
	/**
	 * An input of another extension was seen since the cap in force began. A user message that starts
	 * then does not lift a row's cap: it may be that extension's, sent to carry a scheduled turn on.
	 * One seen before the cap began, whose message pi still holds, is a waiting `other` slot, and
	 * keeps the cap the same way (`messageStarted`).
	 */
	private foreign = false;
	/** pi is compacting the conversation (`session_before_compact` until the compaction ends): no turn is handed over meanwhile. */
	private compacting = false;
	/** The row whose turn message started with its row gone from the file: the message is written with no mark (`messageEnded`). */
	private unmark: string | undefined;
	/** Turn rows whose images are being resized before the send (`resizedTurn`). */
	private readonly resizing = new Set<string>();
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
	private readonly resizer: ImageResizer;

	constructor(pi: Pick<ExtensionAPI, "sendMessage" | "sendUserMessage">, binding: WindowBinding, ctx: () => WindowCtx | undefined, self: Producer, alive: (row: Row) => boolean = producerAlive, rows: () => Row[] = () => [], images: (row: Row) => ImageContent[] = noImages, runs: () => readonly RunRecord[], resizer: ImageResizer = noResizer) {
		this.rows = rows;
		this.runs = runs;
		this.resizer = resizer;
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
		// pi idle, no run on, and no user message held: the user messages that were queued behind a run
		// are gone (the page's "clear queue" empties pi and tells no extension). Only this reading of
		// `hasPendingMessages()` is used: true can be the person's own message (probe g9). It says
		// nothing of a custom message, which it never counts (probe P17).
		const empty = !this.running && (ctx?.isIdle() ?? true) && ctx?.hasPendingMessages?.() === false;
		const next: Slot[] = [];
		for (const slot of this.slots) {
			if (slot.whose === "other") {
				// A message someone sent during a run that pi no longer holds (the page cleared the queue).
				if (!(empty && slot.behind)) next.push(slot);
				continue;
			}
			if (slot.whose === "turn") {
				// A turn row's slot is the window's until its message is written or a run settles without
				// it: pi tells nobody when it drops one, and no API shows one it holds (probes P12, P17).
				// So it leaves here only by its mark in the conversation. One whose row left the file stays
				// for the message pi may still write, which is aborted if a stop named it; a mark it did
				// not write itself is another hand-over's of the same row, queued again.
				if ((slot.at === "started" || !slot.left) && this.delivered(slot.mark.id)) continue;
				next.push(queued.has(slot.mark.id) || slot.left ? slot : { ...slot, left: true });
				continue;
			}
			// What pi wrote is in the conversation, whoever wrote it. A person's prompt pi still holds
			// behind a run stays until the run settles, with no mark (`messageEnded`).
			if (this.delivered(slot.mark.id)) {
				if (slot.whose === "person" && (slot.phase.is === "queued" || slot.phase.is === "opening")) next.push({ ...slot, left: true });
				continue;
			}
			if (slot.whose === "person") {
				// A prompt queued behind a run that pi no longer holds. Not a prompt handed to the idle pi
				// that it has not started (`pending`, or a `refused` one): `hasPendingMessages()` does not count those.
				if (empty && slot.phase.is === "queued") {
					this.gone.set(slot.mark.id, slot.stop ? "stopped" : "dropped");
					continue;
				}
				if (!queued.has(slot.mark.id)) {
					// The row left the file. A prompt a cancel or a stop named stays, to be aborted if pi
					// writes it after all; anything else has nothing left to start.
					if (slot.stop && slot.phase.is !== "written" && slot.phase.is !== "writing") next.push({ ...slot, left: true, ...(slot.phase.is === "opening" ? {} : { phase: { is: "refused" } as const }) });
					// A refused one stays too: pi may still write it, and its mark then proves the row
					// if the same row is queued again.
					else if (slot.phase.is === "refused") next.push({ ...slot, left: true });
					// One pi holds behind a run stays until the run settles: pi still writes it, and it
					// gets no mark (`messageEnded`).
					else if (slot.phase.is === "queued" || slot.phase.is === "opening") next.push({ ...slot, left: true });
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
			blocked: (row) => (row.wake === "turn" && this.compactingNow() ? "pi is compacting the conversation" : undefined),
			claimLive: (row) => claimAlive(row),
			idle: ctx?.isIdle() ?? true,
			running: this.running,
			inFlight: new Set([...handed, ...this.resizing]),
			inFlightSince: new Map(this.slots.flatMap((slot) => (slot.whose === "person" && slot.phase.is === "pending" ? [[slot.mark.id, slot.phase.since] as const] : []))),
			unstarted: new Set([...this.slots.flatMap((slot) => (slot.whose === "turn" && slot.at === "unstarted" && !slot.left ? [slot.mark.id] : [])), ...this.resizing]),
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
		this.slots = this.slots.map((slot) => (slot.whose === "turn" && slot.mark.id === row.id && slot.at !== "started" ? { ...slot, cap: this.capOf(row) } : slot));
		// Only while the cap in force is this row's own.
		if (this.current?.kind === "row" && this.current.id === row.id) this.current = this.capOf(row);
	}

	/**
	 * The cap a row's turn runs under here. The mode is recomputed from the source, never read from
	 * the file; and an attended source is believed only on a row this instance wrote itself. Any other
	 * attended row (one written into the file by hand, or by a capped turn; a local row the holder runs
	 * once its producer left) runs as unattended with nothing declared: the danger check alone, which
	 * asks the person in the window.
	 */
	private capOf(row: Row): RowCap {
		const mode = modeOf("conversation", row.kind, row.source, row.wake);
		// A turn of a source that never asks for one (a rule's result is an append, mode `none`) was written into the file by hand.
		if (mode !== "attended" && mode !== "unattended") return { kind: "row", id: row.id, mode: "unattended" };
		if (mode === "attended" && this.producedRows.get(row.id) !== requestFingerprint(row)) return { kind: "row", id: row.id, mode: "unattended" };
		const tools = row.payload?.tools;
		const builtinTools = row.payload?.builtin_tools;
		return { kind: "row", id: row.id, mode, ...(tools === undefined ? {} : { tools }), ...(builtinTools === undefined ? {} : { builtinTools }) };
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
	 * run began between the engine's look and this call, and pi queues the row behind it. Which way it
	 * goes: the person's own page message, a person row the page's pi was rung for, as a user message
	 * in their words; every other row, as a custom message that names its row and carries its cap. A
	 * terminal is rung by nobody and hands no user message, so a stop there puts nothing of ours into
	 * the editor (probe P12). A row's images are read first: a failure throws before anything is written.
	 */
	turn(row: UnclaimedRow, now = Date.now()): TurnSent | Promise<TurnSent> {
		const text = row.payload?.text ?? "";
		const images = row.payload?.images?.length ? this.images(row) : undefined;
		if (row.source === "person" && this.ctx()?.mode === "rpc" && this.producedRows.get(row.id) === requestFingerprint(row)) return this.personTurn(row, text, images, now);
		if (!images?.length) return this.customTurn(row, text, now);
		return this.resizedTurn(row, text, images);
	}

	/**
	 * A turn row with images: resized first, then sent. Drains overlap, so for the length of the resize
	 * the row is in flight and has the lane (`view`), and no other drain hands it or another turn over.
	 */
	private async resizedTurn(row: UnclaimedRow, text: string, images: readonly ImageContent[]): Promise<TurnSent> {
		this.resizing.add(row.id);
		try {
			const content = await withResizedImages(text, images, this.resizer);
			// The resize took time, and the engine looked before it: a row the page took back meanwhile is
			// not sent, and neither is one that would now run beside a compaction.
			if (!this.rows().some((queued) => queued.id === row.id)) throw new Error(`request ${row.id} left the queue while its images were resized`);
			if (this.compactingNow()) throw new Error("pi began to compact the conversation while the request's images were resized");
			return this.customTurn(row, content, Date.now());
		} finally {
			this.resizing.delete(row.id);
		}
	}

	/**
	 * Whether pi compacts the conversation now: a turn sent then runs beside the compaction (probe
	 * P14). pi is not idle while it compacts, so a flag that no event cleared holds nothing back once
	 * pi says it is idle.
	 */
	private compactingNow(): boolean {
		return this.compacting && this.ctx()?.isIdle() === false;
	}

	/**
	 * The order of the steps is the point of issue 248: the lease says a row is held; the slot is in
	 * the list (the `input` the send emits finds it); then the send. The row goes in its own words, its
	 * images with it, and pi resizes them: nothing is added to its text.
	 */
	private personTurn(row: UnclaimedRow, text: string, images: ImageContent[] | undefined, now: number): TurnSent {
		if (!this.binding.hold(stamp(now))) return "lease-lost";
		const idle = this.ctx()?.isIdle() ?? true;
		const slot: PersonSlot = { whose: "person", mark: markFor(row), text, phase: idle ? { is: "pending", since: now } : { is: "queued" }, echoed: false };
		// An earlier hand-over of the row (a `refused` one pi may still send late) stays if pi throws at
		// this one. One whose row left the file (the same row queued again since) stays beside it.
		const earlier = this.slots.find((s) => s.whose === "person" && s.mark.id === row.id && !s.left);
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
		return "sent";
	}

	/**
	 * The lease says a row is held, the slot is in the list, then the send. Sent to an idle pi, the
	 * slot is `unstarted` and has the lane until a run takes it up: pi starts that run at once, or when
	 * the `agent_settled` handler this was called from returns (probe P17), and never refuses it in
	 * silence, so nothing here waits out a grace.
	 */
	private customTurn(row: UnclaimedRow, content: TurnContent, now: number): TurnSent {
		if (!this.binding.hold(stamp(now))) return "lease-lost";
		const mark = markFor(row);
		const cap = this.capOf(row);
		const details: TurnDetails = { ...markDetails(mark), cap };
		const slot: TurnSlot = { whose: "turn", mark, at: (this.ctx()?.isIdle() ?? true) ? "unstarted" : "held", cap };
		this.slots.push(slot);
		try {
			this.pi.sendMessage({ customType: TURN_TYPE, content, display: true, details }, { triggerTurn: true, deliverAs: "followUp" });
		} catch (err) {
			this.slots = this.slots.filter((s) => s !== slot);
			this.letGoWhenFree();
			throw err;
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
	 * already. Otherwise the grace judged a person row's hand-over refused: pi may still hold the prompt
	 * and send it late, so its slot stays, `refused`: not in flight, and still the row's for a message
	 * with its very text, which then proves it rather than delivering it twice.
	 */
	refused(id: string): void {
		if (this.gone.delete(id)) return;
		this.slots = this.slots.flatMap((slot) => (slot.whose === "other" || slot.whose === "turn" || slot.mark.id !== id ? [slot] : slot.whose === "person" ? [{ ...slot, phase: { is: "refused" } as const }] : []));
		this.letGoWhenFree();
	}

	/** pi began to compact the conversation, or the compaction ended, done or not: no turn is handed over in between (`view().blocked`). */
	compaction(running: boolean): void {
		this.compacting = running;
	}

	/**
	 * At `agent_settled`, with whether the run was aborted: the turn is over, with its retries and
	 * follow-ups, so the cap in force ends here. What is left of the list is `settleSlots`'s. Returns
	 * the ids that are gone.
	 */
	settled(aborted = false): string[] {
		this.current = undefined;
		this.foreign = false;
		// A row that left the file since the last look (an exit in the drain that ran since) owes no exit:
		// what pi did with its prompt must not reach the same row queued again.
		const queued = new Set(this.rows().map((row) => row.id));
		const slots = this.slots.map((slot) => ((slot.whose === "person" || slot.whose === "turn") && !slot.left && !queued.has(slot.mark.id) ? { ...slot, left: true as const } : slot));
		const out = settleSlots(slots, { aborted, terminal: this.ctx()?.mode === "tui" }, (id) => this.delivered(id));
		this.slots = out.slots;
		for (const [id, why] of out.gone) this.gone.set(id, why);
		this.letGoWhenFree();
		return [...out.gone.keys()];
	}

	/** At `agent_start`: a run is on. A turn handed to the idle pi is this run's, or queued behind whatever opened it, and no longer has the lane. */
	agentStarted(now: number): void {
		this.running = { startedAt: stamp(now) };
		this.slots = this.slots.map((slot): Slot => {
			if (slot.whose === "person" && slot.phase.is === "pending") return { ...slot, phase: { is: "opening" } };
			return slot.whose === "turn" && slot.at === "unstarted" ? { ...slot, at: "held" } : slot;
		});
	}

	/**
	 * pi emitted `input`: it is in its pre-run phase for something, so a person row handed over is not
	 * refused yet (the grace counts again from here). No turn row's custom message makes one. An input
	 * with the source `extension` is the echo of a person row's send when it comes inside that send,
	 * or, when another extension's handler ran first (probe P6), when its text starts with the words of
	 * a person row's prompt not yet echoed. Any other input of an extension is someone else's: a user
	 * message that starts from now on does not lift a row's cap (`messageStarted`). And every input
	 * that is not our echo waits as someone else's message until its user message starts (`claimOf`),
	 * so that a person row's mark is not written into it.
	 */
	inputSeen(input: Pick<InputEvent, "source" | "text" | "streamingBehavior">, now: number): void {
		this.slots = this.slots.map((slot) => (slot.whose === "person" && slot.phase.is === "pending" ? { ...slot, phase: { is: "pending", since: now } } : slot));
		if (input.source === "extension") {
			const ours = (slot: Slot): slot is PersonSlot => slot.whose === "person" && !slot.echoed && slot.phase.is !== "refused";
			const echo = this.sending ? this.slots.filter(ours).at(-1) : this.slots.find((slot) => ours(slot) && slot.text !== "" && input.text.startsWith(slot.text));
			if (echo) {
				this.slots = this.slots.map((slot) => (slot === echo ? { ...echo, echoed: true } : slot));
				return;
			}
			this.foreign = true;
		}
		const behind = input.streamingBehavior;
		// During a run, pi refuses a send with no delivery ("Agent is already processing") after its
		// `input` (probe G11): it never becomes a message.
		if (this.running && !behind) return;
		this.slots.push({ whose: "other", from: input.source === "extension" ? "extension" : "person", text: input.text, ...(behind ? { behind } : {}) });
	}

	/**
	 * At `message_start`, the cap of what follows.
	 * - A turn row's custom message: the cap of the row it names (`turnOn`), as its slot holds it; with
	 *   no slot, its row's in the file; with neither, the strictest. The run is that row's, and a row a stop named is
	 *   aborted here; pi still writes the message, with its mark while its row is queued, so the row is done and not offered again.
	 * - A user message: the person's, with no cap. Except while a row's cap is in force and an input of
	 *   another extension was seen since it began, or one seen before waits for its message still (pi
	 *   holds that message, and writes it behind the turn): then the cap stays. That an input waits is
	 *   read from pi's `input` events; whether an input is another extension's, and not our person
	 *   row's echo, is read from its words when it comes outside our send (`inputSeen`). Whose the
	 *   message is (`claimOf`) decides a person row's mark and a stop for it, and never the cap.
	 * - Any other message changes nothing.
	 */
	messageStarted(message: unknown, now = Date.now()): void {
		const turn = turnOn(message);
		if (turn) {
			// Two hand-overs of one row carry the same message: the one no stop named takes it first, so
			// that a stop for a request that left does not abort the message of the same row queued again.
			const held = this.slots.filter((slot): slot is TurnSlot => slot.whose === "turn" && slot.mark.id === turn.id && slot.at !== "started");
			const slot = held.find((s) => !s.stop) ?? held[0];
			this.slots = this.slots.map((s) => (s === slot ? { ...slot, at: "started" } : s));
			if (this.current?.kind !== "row") this.foreign = false;
			// The message names its row; the cap is the one this window gave that row. A message of this
			// type that no slot here sent (pi kept it over a `/reload`, or another extension sent it) runs
			// under the cap of its row in the file, read as any row this instance did not write is.
			const row = turn.id === undefined ? undefined : this.rows().find((r) => r.id === turn.id);
			this.current = slot?.cap ?? (row ? this.capOf(row) : { kind: "row", id: turn.id ?? "unknown", mode: "unattended", tools: [] });
			if (this.running && turn.id !== undefined) this.running = { ...this.running, requestId: turn.id };
			// Its row left the file while pi held it (a stop or a cancel took it out): the message answers no
			// row, and its mark would prove the same row queued again (a goal's continuation keeps its id).
			this.unmark = slot?.left ? turn.id : undefined;
			if (slot?.stop) this.ctx()?.abort();
			return;
		}
		if ((message as { role?: unknown } | undefined)?.role !== "user") return;
		const theirs = this.foreign || this.slots.some((slot) => slot.whose === "other" && slot.from === "extension");
		if (!(this.current?.kind === "row" && theirs)) this.current = { kind: "person" };
		this.slots = this.slots.map((slot) => (slot.whose === "person" && slot.phase.is === "pending" ? { ...slot, phase: { is: "pending", since: now } } : slot));
		const text = userTextOf(message);
		if (text === undefined) return;
		const claim = claimOf(text, this.slots);
		this.slots = this.slots.flatMap((slot): Slot[] => {
			if (claim.by === "person" && slot === claim.slot) return [{ ...slot, phase: { is: "writing", claim } }];
			if (claim.by === "other" && slot === claim.slot) return [];
			return slot.whose === "person" && slot.phase.is === "opening" ? [{ ...slot, phase: { is: "queued" } }] : [slot];
		});
		if (claim.by !== "person") return;
		if (this.running) this.running = { ...this.running, requestId: claim.slot.mark.id };
		if (claim.slot.stop) this.ctx()?.abort();
	}

	/**
	 * At `message_end`, before pi persists the message: a person row's user message with the mark of
	 * the row whose message started (`messageStarted` decided it), which pi persists in the same write
	 * (probe P1), or undefined, and pi persists the message as it is. A turn row's custom message
	 * carries its mark already, and loses it when `messageStarted` found its row gone. It decides nothing.
	 */
	messageEnded<M extends { role: string }>(message: M, _now = Date.now()): { message: M } | undefined {
		const turn = turnOn(message);
		if (turn) {
			const unmark = turn.id !== undefined && turn.id === this.unmark;
			this.unmark = undefined;
			if (!unmark) return undefined;
			const { piLoopsRow: _mark, ...details } = (message as M & { details: TurnDetails }).details;
			return { message: { ...message, details } };
		}
		if (message.role !== "user") return undefined;
		const writing = this.slots.find((slot): slot is PersonSlot => slot.whose === "person" && slot.phase.is === "writing");
		if (!writing || writing.phase.is !== "writing") return undefined;
		const claimed = writing.phase.claim.slot;
		this.slots = this.slots.map((slot) => (slot === writing ? { ...writing, phase: { is: "written" } } : slot));
		// A turn a stop or a cancel named whose row has left already: its message, aborted as it
		// starts, answers no row, and a mark would prove the same row queued again.
		if (claimed.stop && claimed.left) return undefined;
		// A row that left the file while pi held its prompt: its message answers no row that is queued.
		if (claimed.left && claimed.phase.is !== "refused") return undefined;
		return { message: withMark(message, claimed.mark) };
	}

	/** At `agent_end`: no run is on. The cap in force outlives the run (`settled`). */
	agentEnded(): void {
		this.running = undefined;
	}

	/** The lease says no row is held once pi holds none of ours. */
	private letGoWhenFree(): void {
		if (!this.slots.some((slot) => inFlight(slot))) this.binding.letGo();
	}
}
