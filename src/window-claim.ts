/** Pure decisions about which window slot a pi message belongs to. */
import { type Gone, stripImageNotes } from "./engine.ts";
import type { RowMark } from "./mark.ts";
import { PI_BUILTIN_TOOL_NAMES } from "./mcp.ts";
import type { CurrentTurn } from "./window-executor.ts";

/** Where a turn's prompt is, as far as the window can know. */
export type Phase =
	| { is: "pending"; since: number }
	| { is: "opening" }
	| { is: "queued" }
	| { is: "writing"; claim: TurnClaim }
	| { is: "written" }
	| { is: "refused" };

/** A turn row that pi was given through `sendUserMessage`. Its text is the text as it was sent. */
export interface TurnSlot {
	whose: "turn";
	mark: RowMark;
	text: string;
	prefix?: string;
	cap: CurrentTurn & { kind: "row" };
	phase: Phase;
	stop?: true;
	echoed: boolean;
	/** Its row left the queue file: kept only for a message pi may still write. No exit is owed for it, so it never goes into `gone`. */
	left?: true;
}

/** An `append` row that pi was given through `sendMessage`. */
export interface AppendSlot {
	whose: "append";
	mark: RowMark;
	/** A stop named the row while pi held it: when it goes unwritten it is `stopped`, not offered again. A custom message has no start to abort. */
	stop?: true;
}

/** A message that is not ours, from pi's `input` event: the person's, or another extension's. */
export interface OtherSlot {
	whose: "other";
	from: "person" | "extension";
	text: string;
	/**
	 * How pi delivers it during a run, as pi's `input` event says (`streamingBehavior`): a follow-up,
	 * written after what pi was given before, in that order (probes P6, g9), or a steer, written right
	 * after the message under way, before the follow-ups (g13, g16). None when pi was idle.
	 */
	behind?: "followUp" | "steer";
	/** The person typed it in a terminal (pi's `input` source `interactive`). */
	typed?: true;
	/** The run it came during (the run's start stamp): a steer is never that run's first user message. */
	run?: string;
}

/** A slot the window is tracking. */
export type Slot = TurnSlot | AppendSlot | OtherSlot;

declare const byTheRule: unique symbol;

/** A user message that `claimOf` took for one turn slot's. Only `claimOf` makes one. */
export interface TurnClaim {
	readonly by: "turn";
	readonly slot: TurnSlot;
	readonly [byTheRule]: true;
}

/** The slot that owns a user message, if any. `byText`: its words are the slot's, or around them (steps 1 and 2), not only a slot that waits (step 3). */
export type Claim = TurnClaim | { by: "other"; slot: OtherSlot; byText: boolean } | { by: "nobody" };


/** The slots and prompts left after a run ends. */
export interface Settled {
	slots: Slot[];
	gone: ReadonlyMap<string, Gone>;
	editor: readonly OwnPrompt[];
}

/** A prompt of ours that a terminal stop removed from the editor. */
export interface OwnPrompt {
	text: string;
	prefix?: string;
}

function turnClaim(slot: TurnSlot): TurnClaim {
	return { by: "turn", slot } as TurnClaim;
}

function namedOther(slot: OtherSlot, byText = true): Claim {
	return { by: "other", slot, byText };
}

function textAround(msg: string, text: string): boolean {
	return text !== "" && (msg.startsWith(text) || msg.endsWith(text));
}

/**
 * Between turn slots with the same words, the lower rank claims. A slot a stop or a cancel named comes
 * last: a message given to it is aborted, and a wrong guess must not abort a message that is owed. Then
 * the run's starter (G1: before what pi kept), the oldest of those pi holds, and last one the engine
 * stopped waiting for (pi may have dropped it). Two rows with the very same words are told apart by
 * nobody: whichever the mark names, each message answers one of them.
 */
function tieRank(slot: TurnSlot): number {
	return (slot.stop ? 3 : 0) + (slot.phase.is === "opening" ? 0 : slot.phase.is === "refused" ? 2 : 1);
}

function longest<T>(msg: string, slots: readonly T[], textOf: (slot: T) => string, preferred: (slot: T) => number): T | undefined {
	let winner: T | undefined;
	for (const slot of slots) {
		const text = textOf(slot);
		if (!textAround(msg, text)) continue;
		if (!winner || text.length > textOf(winner).length || (text.length === textOf(winner).length && preferred(slot) < preferred(winner))) winner = slot;
	}
	return winner;
}

/**
 * Assign a user message to the first matching slot under these rules:
 * 1. Exact text chooses the oldest other slot, otherwise a turn by `tieRank` (one no stop named
 *    first; then refused, opening, the oldest).
 * 2. A matching other slot with words around its text wins; the longest text wins, then the oldest.
 * 3. A matching turn whose `[Trigger <id>] ` is in the message wins. Otherwise any waiting other
 *    slot wins before approximate turn matches, but for a follow-up or a steer when the matching turn
 *    opened the run, a follow-up given to pi after the matching turn, and a steer when the message is
 *    the first user message of the run the steer came during (`firstOfRun`, that run's start stamp).
 * 4. A turn match wins; the longest text wins, then by `tieRank`.
 * 5. Otherwise the message belongs to nobody.
 *
 * Only pending, opening, queued and refused turns and other slots are candidates. Writing and written
 * turns and append slots never claim. Image notes are stripped before matching.
 */
export function claimOf(text: string, slots: readonly Slot[], firstOfRun?: string): Claim {
	const msg = stripImageNotes(text);
	const candidates = slots.filter((slot): slot is TurnSlot | OtherSlot => slot.whose === "other" || (slot.whose === "turn" && (slot.phase.is === "pending" || slot.phase.is === "opening" || slot.phase.is === "queued" || slot.phase.is === "refused")));
	const exact = candidates.filter((slot) => slot.text === msg);
	const exactOther = exact.find((slot): slot is OtherSlot => slot.whose === "other");
	if (exactOther) return namedOther(exactOther);
	const exactTurns = exact.filter((slot): slot is TurnSlot => slot.whose === "turn");
	if (exactTurns.length) return turnClaim(exactTurns.reduce((best, slot) => (tieRank(slot) < tieRank(best) ? slot : best)));

	const otherAround = longest(msg, candidates.filter((slot): slot is OtherSlot => slot.whose === "other"), (slot) => slot.text, () => 0);
	if (otherAround) return namedOther(otherAround);
	const turnAround = longest(
		msg,
		candidates.filter((slot): slot is TurnSlot => slot.whose === "turn"),
		(slot) => slot.text,
		tieRank,
	);
	// The words of a prompt of ours around the message, with its `[Trigger <id>] `: no one else's
	// message carries that, so it is ours whatever else waits (a refused send of another extension
	// leaves an input that never becomes a message: probe G11).
	if (turnAround?.prefix !== undefined && msg.includes(turnAround.prefix)) return turnClaim(turnAround);
	// A message that could be someone else's is theirs, but for the orders pi keeps (a rewriting
	// extension changes both texts, probe P4). A prompt given to an idle pi is the first user message
	// of the run it starts, before what pi kept after a stop (G1) and before any steer, which pi writes
	// right after the message under way (g13, g16); follow-ups are written in the order pi was given
	// them (P6, g9). So when the prompt of ours that the words point at opened the run, no follow-up
	// and no steer is this message, and a follow-up given after it is not either. (Another extension's
	// message sent to the idle pi first is the run's first message instead, G11: it came with no run
	// on, so it is neither a follow-up nor a steer, and nothing here sets it aside.)
	const notThis = (other: OtherSlot) =>
		(other.behind === "steer" && firstOfRun !== undefined && other.run === firstOfRun) ||
		(turnAround !== undefined && other.behind !== undefined && (turnAround.phase.is === "opening" || (other.behind === "followUp" && slots.indexOf(turnAround) < slots.indexOf(other))));
	const anyOther = candidates.find((slot): slot is OtherSlot => slot.whose === "other" && !notThis(slot));
	if (anyOther) return namedOther(anyOther, false);
	return turnAround ? turnClaim(turnAround) : { by: "nobody" };
}

/**
 * Settle slots in their original order, at the end of a run (`how`: whether a stop ended it, and in a terminal).
 * - A turn or an append whose mark landed leaves.
 * - A pending turn stays.
 * - A refused turn leaves with no stop (pi wrote all it held), stays on a stop in the page's pi (pi
 *   keeps it), and leaves on a stop in a terminal with its text to `editor` (pi had it queued, if it held it).
 * - A written turn (its mark given, no entry) goes, `lost`.
 * - An opening, queued or writing turn, and an append, go: `lost` with no stop, `dropped` on a stop in
 *   a terminal (a turn's text to `editor`); on a stop in the page's pi they stay (a writing one as queued).
 * - A turn or append that a stop named goes as `stopped` instead of `lost` or `dropped`.
 * - A turn whose row left the file (`left`) never goes into `gone`.
 * - Other slots leave with no stop or on a stop in a terminal, and stay on a stop in the page's pi.
 */
export function settleSlots(slots: readonly Slot[], how: { aborted: boolean; terminal: boolean }, landed: (id: string) => boolean): Settled {
	const kept: Slot[] = [];
	const goneOf = new Map<string, Gone>();
	const editor: OwnPrompt[] = [];
	for (const slot of slots) {
		if (slot.whose === "other") {
			if (how.aborted && !how.terminal) kept.push(slot);
			continue;
		}
		const gone = slot.whose === "turn" && slot.left ? new Map<string, Gone>() : goneOf;
		// Pi wrote it: the entry carries its mark, and the slot is done with.
		if (landed(slot.mark.id)) continue;
		if (slot.whose === "append") {
			if (how.aborted && !how.terminal) kept.push(slot);
			else gone.set(slot.mark.id, slot.stop ? "stopped" : how.aborted ? "dropped" : "lost");
			continue;
		}
		const phase = slot.phase.is === "writing" ? "queued" : slot.phase.is;
		// A refused prompt pi may still hold: a stop in a terminal moved it into the editor if pi did.
		if (phase === "refused" && how.aborted && how.terminal) {
			editor.push({ text: slot.text, ...(slot.prefix === undefined ? {} : { prefix: slot.prefix }) });
			continue;
		}
		// A run that ended with no stop wrote all that pi held: a refused prompt it did not write is not coming.
		if (phase === "refused" && !how.aborted) continue;
		if (phase === "pending" || phase === "refused") {
			kept.push(slot);
			continue;
		}
		if (phase === "written") {
			gone.set(slot.mark.id, slot.stop ? "stopped" : "lost");
			continue;
		}
		if (how.aborted && !how.terminal) {
			kept.push(slot.phase.is === "writing" ? { ...slot, phase: { is: "queued" } } : slot);
			continue;
		}
		gone.set(slot.mark.id, slot.stop ? "stopped" : how.aborted ? "dropped" : "lost");
		if (how.aborted && how.terminal) editor.push({ text: slot.text, ...(slot.prefix === undefined ? {} : { prefix: slot.prefix }) });
	}
	return { slots: kept, gone: goneOf, editor };
}

/** Remove at most one matching block of whole paragraphs for each prompt, in prompt order. */
export function cleanEditor(editor: string, own: readonly OwnPrompt[]): string {
	let paragraphs = editor.split("\n\n");
	let changed = false;
	for (const prompt of own) {
		const count = prompt.text.split("\n\n").length;
		let start = -1;
		for (let i = 0; i < paragraphs.length; i++) {
			if (prompt.prefix !== undefined) {
				if (paragraphs[i].includes(prompt.prefix)) { start = i; break; }
			} else if (prompt.text !== "" && paragraphs.slice(i, i + count).join("\n\n").endsWith(prompt.text)) {
				start = i;
				break;
			}
		}
		if (start >= 0) {
			paragraphs.splice(start, count);
			changed = true;
		}
	}
	return changed ? paragraphs.join("\n\n") : editor;
}

/**
 * The narrowest cap of several prompts of ours pi holds, for a message the window cannot place: it
 * may be any of them. Unattended when any is; then only the tools every unattended one declared (a
 * prompt that declares none caps nothing beyond the dangerous-command policy, so it narrows nothing),
 * and of pi's built-in tools only those every built-in list allows. Undefined for no prompt.
 */
export function narrowestCap(caps: ReadonlyArray<CurrentTurn & { kind: "row" }>): (CurrentTurn & { kind: "row" }) | undefined {
	const unattended = caps.filter((cap) => cap.mode === "unattended");
	if (!unattended.length) return caps[0];
	const meet = (lists: ReadonlyArray<readonly string[]>): string[] | undefined => (lists.length ? lists.reduce<string[]>((acc, list) => acc.filter((tool) => list.includes(tool)), [...lists[0]]) : undefined);
	const builtinTools = meet(unattended.flatMap((cap) => (cap.builtinTools ? [cap.builtinTools] : [])));
	const declared = meet(unattended.flatMap((cap) => (cap.tools ? [cap.tools] : [])));
	// A built-in list caps a declared list too: the guard reads `tools` first.
	const tools = declared && builtinTools ? declared.filter((tool) => !PI_BUILTIN_TOOL_NAMES.includes(tool) || builtinTools.includes(tool)) : declared;
	return { ...unattended[0], ...(tools ? { tools } : {}), ...(builtinTools ? { builtinTools } : {}) };
}
