/** Marks a request row on the pi entry that carries it. */
import type { LaneId } from "./lane.ts";
import type { Row } from "./requests.ts";
import type { RowCap } from "./window-executor.ts";

declare const made: unique symbol;

/**
 * A mark identifies one row by its lane, its id and when it was queued (`at`, the row's `created_at`).
 * Only `markFor` makes one.
 */
export interface RowMark {
	readonly lane: LaneId;
	readonly id: string;
	readonly at: string;
	readonly [made]: true;
}

/**
 * A mark read back from a session entry. `aborted`: the window aborted the message as pi began it, so
 * the message answered nothing (a stop or a cancel named its row).
 */
export type MarkRead = { lane: string; id: string; at: string; aborted?: true };

/** Make the mark for a row. */
export function markFor(row: Pick<Row, "lane" | "id" | "created_at">): RowMark {
	return { lane: row.lane, id: row.id, at: row.created_at } as RowMark;
}

/**
 * Whether a mark read back proves this row: the same lane and id. A message that was answered proves
 * a row of its id queued again later too (the clock queues a slot that already ran once more), so
 * that the row is not written twice. A message the window aborted as it began answered nothing: it
 * proves only the row queued at its `at`, so that this row is not offered again, and not a row of the
 * same id queued later (the clock's slot after a stop, a goal's continuation), which then runs.
 */
export function marksRow(mark: MarkRead, lane: string, row: Pick<Row, "id" | "created_at">): boolean {
	return mark.lane === lane && mark.id === row.id && (mark.aborted !== true || mark.at === row.created_at);
}

/** Add a row mark to a message without changing the message; `aborted` when the window aborted the message as pi began it. */
export function withMark<M extends { role: string }>(message: M, mark: RowMark, aborted = false): M & { piLoopsRow: MarkRead } {
	return { ...message, piLoopsRow: { lane: mark.lane, id: mark.id, at: mark.at, ...(aborted ? { aborted: true as const } : {}) } };
}

/** Put a row mark in custom message details. */
export function markDetails(mark: RowMark): { piLoopsRow: MarkRead } {
	return { piLoopsRow: { lane: mark.lane, id: mark.id, at: mark.at } };
}

/** Read a row mark from a user message or custom message entry. */
export function markOn(entry: unknown): MarkRead | undefined {
	try {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
		const value = entry as Record<string, unknown>;
		let field: unknown;
		if (value.type === "message" && value.message && typeof value.message === "object" && !Array.isArray(value.message) && (value.message as Record<string, unknown>).role === "user") {
			field = (value.message as Record<string, unknown>).piLoopsRow;
		} else if (value.type === "custom_message" && value.details && typeof value.details === "object" && !Array.isArray(value.details)) {
			field = (value.details as Record<string, unknown>).piLoopsRow;
		} else {
			return undefined;
		}
		if (!field || typeof field !== "object" || Array.isArray(field)) return undefined;
		const mark = field as Record<string, unknown>;
		if (typeof mark.lane !== "string" || typeof mark.id !== "string" || typeof mark.at !== "string") return undefined;
		return { lane: mark.lane, id: mark.id, at: mark.at, ...(mark.aborted === true ? { aborted: true as const } : {}) };
	} catch {
		return undefined; // pi's session entries can contain unexpected values
	}
}

/** The custom type of a turn row's message. An append row's is `pi-loops:trigger`. */
export const TURN_TYPE = "pi-loops:turn";

/** The details of a turn row's custom message: the window writes them, pi persists them, and no model is sent them. */
export interface TurnDetails {
	piLoopsRow: MarkRead;
	cap: RowCap;
}

/**
 * Which row a message names as pi starts it; undefined unless it is a turn row's custom message.
 * `mark` is undefined when its mark does not read. Its details' cap is a record for readers: any
 * extension can send a message of this type, so no cap is taken from it.
 */
export function turnOn(message: unknown): { mark: MarkRead | undefined } | undefined {
	if (!message || typeof message !== "object") return undefined;
	const value = message as { role?: unknown; customType?: unknown; details?: unknown };
	if (value.role !== "custom" || value.customType !== TURN_TYPE) return undefined;
	return { mark: markOn({ type: "custom_message", details: value.details }) };
}
