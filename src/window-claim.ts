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
}

/** An `append` row that pi was given through `sendMessage`. */
export interface AppendSlot {
	whose: "append";
	mark: RowMark;
}

/** A message that is not ours, from pi's `input` event: the person's, or another extension's. */
export interface OtherSlot {
	whose: "other";
	from: "person" | "extension";
	text: string;
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
 * 1. Exact text chooses the oldest other slot, otherwise an opening turn, otherwise the oldest turn.
 * 2. A matching other slot with words around its text wins; the longest text wins, then the oldest.
 * 3. Any waiting other slot wins before approximate turn matches.
 * 4. A non-refused turn match wins; the longest text wins, then opening, then oldest.
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
	if (exactTurns.length) return turnClaim(exactTurns.find((slot) => slot.phase.is === "opening") ?? exactTurns[0]);

	const otherAround = longest(msg, candidates.filter((slot): slot is OtherSlot => slot.whose === "other"), (slot) => slot.text, () => 0);
	if (otherAround) return namedOther(otherAround);
	const anyOther = candidates.find((slot): slot is OtherSlot => slot.whose === "other");
	if (anyOther) return namedOther(anyOther);

	const turnAround = longest(
		msg,
		candidates.filter((slot): slot is TurnSlot => slot.whose === "turn" && slot.phase.is !== "refused"),
		(slot) => slot.text,
		(slot) => slot.phase.is === "opening" ? 0 : 1,
	);
	return turnAround ? turnClaim(turnAround) : { by: "nobody" };
}

/**
 * Settle slots in their original order. For each turn or append with a landed mark, leave the slot;
 * otherwise pending and refused turns stay, written turns are lost, and opening/queued turns and
 * appends are lost without a stop, dropped on a terminal stop, or kept on a non-terminal stop.
 * Other slots leave without a stop or on a terminal stop and stay on a non-terminal stop. A writing
 * turn is treated as queued. A going turn with `stop: true` is stopped. Dropped or stopped turn
 * prompts from a terminal stop are returned in `editor` order.
 */
export function settleSlots(slots: readonly Slot[], how: { aborted: boolean; terminal: boolean }, landed: (id: string) => boolean): Settled {
	const kept: Slot[] = [];
	const gone = new Map<string, Gone>();
	const editor: OwnPrompt[] = [];
	for (const slot of slots) {
		if (slot.whose === "other") {
			if (how.aborted && !how.terminal) kept.push(slot);
			continue;
		}
		// Pi wrote it: the entry carries its mark, and the slot is done with.
		if (landed(slot.mark.id)) continue;
		if (slot.whose === "append") {
			if (how.aborted && !how.terminal) kept.push(slot);
			else gone.set(slot.mark.id, how.aborted ? "dropped" : "lost");
			continue;
		}
		const phase = slot.phase.is === "writing" ? "queued" : slot.phase.is;
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
	return { slots: kept, gone, editor };
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
