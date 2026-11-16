/** Pure decisions about which window slot a pi message belongs to. */
import { stripImageNotes } from "./engine.ts";
import type { RowMark } from "./mark.ts";
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
	/** It came while a run was on: a follow-up, which pi writes after the run's first message. */
	followUp?: true;
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

/** The slot that owns a user message, if any. */
export type Claim = TurnClaim | { by: "other"; slot: OtherSlot } | { by: "nobody" };

/** Why pi no longer has a row it was handed and did not write. */
export type Gone = "stopped" | "dropped" | "lost";

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

function namedOther(slot: OtherSlot): Claim {
	return { by: "other", slot };
}

function textAround(msg: string, text: string): boolean {
	return text !== "" && (msg.startsWith(text) || msg.endsWith(text));
}

/**
 * Between turn slots with the same words, the lower rank claims. A slot a stop or a cancel named comes
 * last: a message given to it is aborted, and a wrong guess must not abort a message that is owed. Then
 * one the engine stopped waiting for (pi held it before anything since), the run's starter (G1: before
 * what pi kept), and the oldest.
 */
function tieRank(slot: TurnSlot): number {
	return (slot.stop ? 3 : 0) + (slot.phase.is === "refused" ? 0 : slot.phase.is === "opening" ? 1 : 2);
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
 * 3. Any waiting other slot wins before approximate turn matches, but for a follow-up when the
 *    matching turn opened the run or was given to pi before it.
 * 4. A turn match wins; the longest text wins, then by `tieRank`.
 * 5. Otherwise the message belongs to nobody.
 *
 * Only pending, opening, queued and refused turns and other slots are candidates. Writing and written
 * turns and append slots never claim. Image notes are stripped before matching.
 */
export function claimOf(text: string, slots: readonly Slot[]): Claim {
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
	// A message that could be someone else's is theirs, but for one order pi keeps (a rewriting
	// extension changes both texts, probe P4): a message they sent during a run is a follow-up, which pi
	// writes after the run's first message and after what was queued before it. So it is not this
	// message when the prompt of ours that the words point at opened the run, or was given to pi first.
	const before = (other: OtherSlot) => turnAround !== undefined && (turnAround.phase.is === "opening" || slots.indexOf(turnAround) < slots.indexOf(other));
	const anyOther = candidates.find((slot): slot is OtherSlot => slot.whose === "other" && !(slot.followUp && before(slot)));
	if (anyOther) return namedOther(anyOther);
	return turnAround ? turnClaim(turnAround) : { by: "nobody" };
}

/**
 * Settle slots in their original order. For each turn or append with a landed mark, leave the slot;
 * otherwise pending turns stay, refused ones stay on a stop in the page's pi (it keeps them), leave
 * with no stop (pi wrote all it held), and leave at a terminal stop with their text to `editor`
 * (pi had it queued, if it held it); written turns are lost, and opening/queued turns and
 * appends are lost without a stop, dropped on a terminal stop, or kept on a non-terminal stop (`stopped` with `stop`).
 * Other slots leave without a stop or on a terminal stop and stay on a non-terminal stop. A writing
 * turn is treated as queued. A going turn with `stop: true` is stopped. Dropped or stopped turn
 * prompts from a terminal stop are returned in `editor` order.
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
