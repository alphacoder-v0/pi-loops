/** Pure decisions about the window's slots: whose a user message is, what a settled run leaves, and what became of an answer's turn. */
import { type Gone, stripImageNotes } from "./engine.ts";
import type { RowMark } from "./mark.ts";
import type { RowCap } from "./window-executor.ts";

/** Where a person row's prompt is, as far as the window can know. */
export type Phase =
	| { is: "pending"; since: number }
	| { is: "opening" }
	| { is: "queued" }
	| { is: "writing"; claim: PersonClaim }
	| { is: "written" }
	| { is: "refused" };

/**
 * A person row this window was rung for, which pi was given through `sendUserMessage`: the person's
 * own page message. Its text is the text as it was sent. Only the page's pi holds one.
 */
export interface PersonSlot {
	whose: "person";
	mark: RowMark;
	text: string;
	phase: Phase;
	stop?: true;
	echoed: boolean;
	/** Its row left the queue file: kept only for a message pi may still write. No exit is owed for it, so it never goes into `gone`. */
	left?: true;
}

/**
 * A turn row that pi was given as a custom message (`pi-loops:turn`). Its message names its row and
 * carries its cap, so the slot decides neither. `unstarted`: sent to an idle pi, and no run has taken
 * it up; it has the lane. `held`: pi holds it behind a run, or kept it after a stop in the page.
 * `started`: its `message_start` came.
 */
export interface TurnSlot {
	whose: "turn";
	mark: RowMark;
	at: "unstarted" | "held" | "started";
	/** The cap the window gave the row as it sent it, or the one a ring for the row vouched for since. Its message's details say it too, and are not read for it: any extension can send a message of that type. */
	cap: RowCap;
	/**
	 * What the window handed pi, as `canonicalJson` of the message's content. A message that names the
	 * row is this slot's only with this very content too: the mark is in the request file, so a message
	 * that copies the mark alone takes neither this slot nor its cap. One that copies the mark and the
	 * content is not told apart; another extension in this pi is inside the same-user boundary.
	 */
	handed: string;
	/**
	 * The turn of an answer (src/window-executor.ts `answerTurn`): it leaves by its own message only,
	 * the one that started from this slot. A copied mark in the conversation is not its message.
	 */
	answer?: true;
	/** A stop named the row while pi held it: its run is aborted as its message starts, and when it goes unwritten it is `stopped`. */
	stop?: true;
	/** Its row left the queue file. No exit is owed for it, so it never goes into `gone`: the same row may be queued again. */
	left?: true;
}

/** An `append` row that pi was given through `sendMessage`. */
export interface AppendSlot {
	whose: "append";
	mark: RowMark;
	/** A stop named the row while pi held it: when it goes unwritten it is `stopped`, not offered again. An append starts no turn of its own to abort. */
	stop?: true;
}

/** A user message that is not ours, from pi's `input` event: the person's, or another extension's. Kept for a person row's mark only. */
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
}

/** A slot the window is tracking. */
export type Slot = PersonSlot | TurnSlot | AppendSlot | OtherSlot;

declare const byTheRule: unique symbol;

/** A user message that `claimOf` took for one person slot's. Only `claimOf` makes one. */
export interface PersonClaim {
	readonly by: "person";
	readonly slot: PersonSlot;
	readonly [byTheRule]: true;
}

/** The slot that owns a user message, if any. It decides a mark, and, as it takes a waiting input out of the list, whether that input still keeps a cap. */
export type Claim = PersonClaim | { by: "other"; slot: OtherSlot } | { by: "nobody" };

/**
 * What became of an answer's turn when pi settled. `ran`: its message, known by its mark, started in
 * the run that settled, so that run was its turn. `waits`: pi still holds it and has not started it.
 * `unwritten`: pi has it no more and never started it (a stop dropped it, or pi lost it).
 */
export type AnswerTurnEnd = "ran" | "waits" | "unwritten";

/** Pure. `started`: the turn's message started in the run that settled. `held`: its slot is still in flight. */
export function answerTurnEnd(started: boolean, held: boolean): AnswerTurnEnd {
	if (started) return "ran";
	return held ? "waits" : "unwritten";
}

/** The slots left after a run ends, and the rows that went unwritten. */
export interface Settled {
	slots: Slot[];
	gone: ReadonlyMap<string, Gone>;
}

/**
 * Whose a user message is, from its words:
 * 1. The very same words as a waiting input of someone else: theirs, the oldest. Otherwise the very
 *    same words as a person row's prompt: that row's, the oldest.
 * 2. The words of a waiting input or of a person row's prompt at the start of the message: the one
 *    with the longest words; between two as long, someone else's, then the oldest.
 * 3. Otherwise it belongs to nobody, and gets no mark.
 *
 * Only pending, opening, queued and refused person slots and other slots are candidates. A turn row's
 * custom message names its own row and is never asked about here. Image notes are stripped first.
 */
export function claimOf(text: string, slots: readonly Slot[]): Claim {
	const msg = stripImageNotes(text);
	const candidates = slots.filter((slot): slot is PersonSlot | OtherSlot => slot.whose === "other" || (slot.whose === "person" && (slot.phase.is === "pending" || slot.phase.is === "opening" || slot.phase.is === "queued" || slot.phase.is === "refused")));
	const claim = (slot: PersonSlot | OtherSlot): Claim => (slot.whose === "other" ? { by: "other", slot } : ({ by: "person", slot } as PersonClaim));
	const exact = candidates.filter((slot) => slot.text === msg);
	const same = exact.find((slot) => slot.whose === "other") ?? exact[0];
	if (same) return claim(same);
	let longest: PersonSlot | OtherSlot | undefined;
	for (const slot of candidates) {
		if (slot.text === "" || !msg.startsWith(slot.text)) continue;
		if (!longest || slot.text.length > longest.text.length || (slot.text.length === longest.text.length && slot.whose === "other" && longest.whose !== "other")) longest = slot;
	}
	return longest ? claim(longest) : { by: "nobody" };
}

/**
 * Settle slots in their original order, at the end of a run (`how`: whether a stop ended it, and in a terminal).
 * - A slot whose mark landed leaves. Not a turn slot whose row left the file and whose message has
 *   not started: the mark is then another hand-over's, and pi may still write this one.
 * - A turn slot that is unstarted stays: its run has not begun. One pi holds stays on a stop in the
 *   page's pi (pi keeps it) and goes `dropped` on a stop in a terminal. Any other goes `lost`: its
 *   message started and no entry carries its mark, or the run ended with no stop and did not write it.
 * - An append goes the same way as a turn slot that pi holds.
 * - A pending person slot stays. A refused one leaves with no stop (pi wrote all it held) and on a
 *   stop in a terminal, and stays on a stop in the page's pi (pi keeps it).
 * - A written person slot (its mark given, no entry) goes, `lost`.
 * - An opening, queued or writing person slot goes: `lost` with no stop, `dropped` on a stop in a
 *   terminal; on a stop in the page's pi it stays (a writing one as queued).
 * - A slot that a stop named goes as `stopped` instead of `lost` or `dropped`.
 * - A slot whose row left the file (`left`) never goes into `gone`.
 * - Other slots leave with no stop or on a stop in a terminal, and stay on a stop in the page's pi.
 */
export function settleSlots(slots: readonly Slot[], how: { aborted: boolean; terminal: boolean }, landed: (mark: RowMark) => boolean): Settled {
	const kept: Slot[] = [];
	const goneOf = new Map<string, Gone>();
	const keeps = how.aborted && !how.terminal;
	for (const slot of slots) {
		if (slot.whose === "other") {
			if (keeps) kept.push(slot);
			continue;
		}
		const gone = slot.whose !== "append" && slot.left ? new Map<string, Gone>() : goneOf;
		const unwritten = slot.stop ? "stopped" : how.aborted ? "dropped" : "lost";
		if (slot.whose === "turn") {
			if ((slot.at === "started" || (!slot.left && !slot.answer)) && landed(slot.mark)) continue;
			if (slot.at === "unstarted" || (slot.at === "held" && keeps)) kept.push(slot);
			else gone.set(slot.mark.id, slot.at === "started" && !slot.stop ? "lost" : unwritten);
			continue;
		}
		// Pi wrote it: the entry carries its mark, and the slot is done with.
		if (landed(slot.mark)) continue;
		if (slot.whose === "append") {
			if (keeps) kept.push(slot);
			else gone.set(slot.mark.id, unwritten);
			continue;
		}
		const phase = slot.phase.is === "writing" ? "queued" : slot.phase.is;
		// A refused prompt that a run with no stop did not write is not coming; a stop in a terminal cleared it out of pi.
		if (phase === "refused" && !keeps) continue;
		if (phase === "pending" || phase === "refused") {
			kept.push(slot);
			continue;
		}
		if (phase === "written") {
			gone.set(slot.mark.id, slot.stop ? "stopped" : "lost");
			continue;
		}
		if (keeps) {
			kept.push(slot.phase.is === "writing" ? { ...slot, phase: { is: "queued" } } : slot);
			continue;
		}
		gone.set(slot.mark.id, unwritten);
	}
	return { slots: kept, gone: goneOf };
}
