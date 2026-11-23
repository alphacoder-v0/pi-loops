/**
 * What a push becomes: one row per project in that project's check lane, derived from the raw event
 * (src/events.ts) the push was appended as. The row's id is the event's and the project's, so a
 * second derivation of the same event finds the row, or the run that proves it ended. The identity
 * window (`PUSH_WINDOW_MS`) is read from the event log and the lane, not kept beside them.
 */
import { createHash } from "node:crypto";
import { modeOf } from "./engine.ts";
import type { RawEvent } from "./events.ts";
import { checkLane } from "./lane.ts";
import { realpathish } from "./paths.ts";
import { plainLine, redact } from "./redact.ts";
import type { RequestStore, Row, UnclaimedRow } from "./requests.ts";
import { stamp } from "./schedule.ts";
import type { ReplacementPolicy } from "./triggers.ts";

export const PUSH_WINDOW_MS = 5 * 60_000;
export const MAX_PUSH_ROWS = 32;
const TEXT_CHARS = 200;

/** `evt-` + the first 32 hex of sha256(`${eventId}|${realpathish(project)}`). */
export function pushRowId(eventId: string, project: string): string {
	return `evt-${createHash("sha256").update(`${eventId}|${realpathish(project)}`).digest("hex").slice(0, 32)}`;
}

export interface PushInput {
	/** The push as appended. */
	readonly event: RawEvent;
	/** The trigger's idempotency key. */
	readonly key: string;
	readonly policy: ReplacementPolicy;
	/** `${sourceLabel} / ${eventLabel}`, for the row's text. */
	readonly label: string;
	/** The row's source is `push:${sourceLabel}`. */
	readonly sourceLabel: string;
	/** The project's directory (a rule's cwd). */
	readonly project: string;
	/** Events read from the log. */
	readonly earlier: readonly { readonly id: string; readonly key: string; readonly received_at: string }[];
	/** The run log proves this row's run ended. */
	readonly done: (rowId: string) => boolean;
	readonly createdBy: UnclaimedRow["created_by"];
	readonly now: number;
}

export type PushDecision =
	/** This event's row exists or is proved done. */
	| { readonly kind: "there" }
	| { readonly kind: "queued"; readonly row: UnclaimedRow; readonly drop?: Row }
	/** `of`: the event it replaced; `event`: the event that replaces it, the only one the row is for afterwards. */
	| { readonly kind: "replaced"; readonly rowId: string; readonly of: string; readonly event: string }
	| { readonly kind: "collapsed"; readonly rowId: string; readonly of: string }
	| { readonly kind: "duplicate"; readonly of: string };

function laneOf(project: string): string {
	const lane = checkLane(project);
	if (!lane) throw new Error(`a push needs a project: "${project}" has no check lane`);
	return lane;
}

/** Pure: what this push does to its project's check lane, given that lane's rows. */
export function decidePush(input: PushInput, rows: readonly Row[]): PushDecision {
	const lane = laneOf(input.project);
	const { event, project } = input;
	const id = pushRowId(event.id, project);
	if (input.done(id) || rows.some((r) => r.id === id || r.payload?.events?.includes(event.id))) return { kind: "there" };

	const at = Date.parse(event.received_at);
	const window = input.earlier
		.filter((e) => e.key === input.key && e.id !== event.id && at - Date.parse(e.received_at) >= 0 && at - Date.parse(e.received_at) <= PUSH_WINDOW_MS)
		.sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at));
	for (const e of window) {
		const carrier = rows.find((r) => r.payload?.events?.includes(e.id));
		if (carrier?.run) return { kind: "duplicate", of: e.id };
		if (carrier) return input.policy === "latest_replaces" ? { kind: "replaced", rowId: carrier.id, of: e.id, event: event.id } : { kind: "collapsed", rowId: carrier.id, of: e.id };
		if (input.done(pushRowId(e.id, project))) return { kind: "duplicate", of: e.id };
	}

	const source = `push:${input.sourceLabel}` as const;
	const text = Array.from(plainLine(redact(`push ${input.label}`))).slice(0, TEXT_CHARS).join("");
	const row: UnclaimedRow = { v: 3, id, lane, kind: "input", source, mode: modeOf("check", "input", source, "turn"), wake: "turn", payload: { text, cwd: project, events: [event.id] }, created_at: stamp(input.now), created_by: input.createdBy, attempts: 0 };
	const waiting = rows.filter((r) => r.source.startsWith("push:") && !r.run);
	if (waiting.length < MAX_PUSH_ROWS) return { kind: "queued", row };
	const drop = waiting.reduce((oldest, r) => (Date.parse(r.created_at) < Date.parse(oldest.created_at) ? r : oldest));
	return { kind: "queued", row, drop };
}

/** The decision taken and written under the lane's lock (`RequestStore.writePush`). */
export function writePush(store: RequestStore, input: PushInput): PushDecision {
	return store.writePush(laneOf(input.project), (rows) => decidePush(input, rows));
}
