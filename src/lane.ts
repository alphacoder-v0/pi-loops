/**
 * Lanes. A lane is one queue of request rows (`requests/<lane id>.jsonl`) and whatever runs its
 * rows one at a time. This file imports nothing, so that `requests`, `inbox`, `engine` and `lease`
 * can all import it, and it is the one source of the grammar of a lane id:
 *
 *   conversation   `<session id>`         `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, and no `..`
 *   loop           `@cron-<rest>`         `@` and the job's id
 *   check          `@check-<rest>`        `@` and a project's key (src/trigger-runtime.ts `checkLane`)
 *
 * After the `@`, the text obeys the rule of a session id and has one character or more after
 * `cron-` or `check-`. A session id cannot start with `@`, so the kinds cannot collide. The only
 * characters a lane id can hold are `[A-Za-z0-9._-]` and one leading `@`: it never names a path
 * outside the directory its files are in.
 */

/**
 * A lane's id as a row, a finding and a file name carry it. A conversation's lane id is its session
 * id, so every caller that has a session id has a lane id.
 */
export type LaneId = string;

declare const conversation: unique symbol;
/**
 * A session id that was checked: the id of a conversation's lane. Only `parseLane` makes one. It is
 * asked for where a lane of another kind would do harm: `bury` (src/engine.ts), which treats every
 * row as a row of a conversation that is gone, and the calls that lead to it. Everywhere else a
 * session id is a string, and a `ConversationId` is one.
 */
export type ConversationId = string & { readonly [conversation]: true };

/** A lane id, parsed: its kind is known. */
export type Lane =
	| { readonly kind: "conversation"; readonly id: ConversationId }
	| { readonly kind: "loop"; readonly id: `@cron-${string}` }
	| { readonly kind: "check"; readonly id: `@check-${string}` };

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The one place that reads a lane's kind from its id. Total: it never throws, and anything that is
 * no lane of this version gives `undefined` (not a string, empty, a separator, `..`, an `@` kind
 * this version does not know). A file named for such an id is nobody's here, and stays on disk for
 * the version that wrote it.
 */
export function parseLane(id: string): Lane | undefined {
	if (typeof id !== "string" || id.includes("..")) return undefined;
	if (!id.startsWith("@")) return SESSION_ID.test(id) ? { kind: "conversation", id: id as ConversationId } : undefined;
	if (!SESSION_ID.test(id.slice(1))) return undefined;
	if (/^@cron-./.test(id)) return { kind: "loop", id: id as `@cron-${string}` };
	if (/^@check-./.test(id)) return { kind: "check", id: id as `@check-${string}` };
	return undefined;
}

/**
 * A lane id as the base name of its files: `<id>.jsonl`, `<id>.lock`, `<id>.<32 hex>.images.json`.
 * It returns the id unchanged and throws for an id that is no lane, so nothing outside the
 * directory can be named.
 */
export function laneFileName(lane: LaneId): string {
	if (!parseLane(lane)) throw new Error(`invalid lane id: ${lane}`);
	return lane;
}

/** A loop's lane: `@` and its job's id. `undefined` for a job whose id makes no lane (an id that is not `cron-…`): what it files then carries no lane. */
export function loopLane(jobId: string): LaneId | undefined {
	const lane = parseLane(`@${jobId}`);
	return lane?.kind === "loop" ? lane.id : undefined;
}
