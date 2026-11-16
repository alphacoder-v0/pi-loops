/** Marks a request row on the pi entry that carries it. */
import type { LaneId } from "./lane.ts";
import type { Row } from "./requests.ts";
import type { RowCap } from "./window-executor.ts";

declare const made: unique symbol;

/** A mark identifies one row by its lane and id. Only `markFor` makes one. */
export interface RowMark {
	readonly lane: LaneId;
	readonly id: string;
	readonly [made]: true;
}

/** A mark read back from a session entry. */
export type MarkRead = { lane: string; id: string };

/** Make the mark for a row. */
export function markFor(row: Pick<Row, "lane" | "id">): RowMark {
	return { lane: row.lane, id: row.id } as RowMark;
}

/** Add a row mark to a message without changing the message. */
export function withMark<M extends { role: string }>(message: M, mark: RowMark): M & { piLoopsRow: MarkRead } {
	return { ...message, piLoopsRow: { lane: mark.lane, id: mark.id } };
}

/** Put a row mark in custom message details. */
export function markDetails(mark: RowMark): { piLoopsRow: MarkRead } {
	return { piLoopsRow: { lane: mark.lane, id: mark.id } };
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
		return typeof mark.lane === "string" && typeof mark.id === "string" ? { lane: mark.lane, id: mark.id } : undefined;
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
 * Which row a message names as pi starts it; undefined unless it is a turn row's custom message. `id`
 * is undefined when its mark does not read. Its details' cap is a record for readers: any extension
 * can send a message of this type, so no cap is taken from it.
 */
export function turnOn(message: unknown): { id: string | undefined } | undefined {
	if (!message || typeof message !== "object") return undefined;
	const value = message as { role?: unknown; customType?: unknown; details?: unknown };
	if (value.role !== "custom" || value.customType !== TURN_TYPE) return undefined;
	return { id: markOn({ type: "custom_message", details: value.details })?.id };
}
