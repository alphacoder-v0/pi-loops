/**
 * The one engine that delivers a session's requests (src/requests.ts). `decideDrain` is pure: the
 * rows, what the conversation already holds, the jobs and the executor's view in, the actions out.
 * `drain` applies them through an executor: the window that holds the conversation
 * (src/window-executor.ts), or the background process for a closed one (src/host-runtime.ts). A
 * local row (what the person typed, a goal's continuation) is run by the window that produced it,
 * lease or not, for as long as that window is on the conversation.
 *
 * Delivery is at least once; the proof already in the conversation (the row's lane and id, which the
 * window that handed it over writes into the entry pi writes for it: `landed`, src/mark.ts) is what
 * makes a second delivery a no-op, and a row leaves the file only once that proof is in the file. A row that fails
 * waits out a backoff and blocks nothing behind it; at three failures it is a dead letter: an inbox
 * finding first, then an audit line, then the removal, so a crash in between loses no row.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { type Inbox, findingId } from "./inbox.ts";
import { type ConversationId, type Lane, type LaneId, parseLane } from "./lane.ts";
import { redact } from "./redact.ts";
import { type LeaseHolder, type LeaseStore, type ProcessProbe, type SessionLease, holderAlive, holderDelivers, systemProbe } from "./lease.ts";
import { withinProject } from "./paths.ts";
import { type ImageContent, type RequestMode, type RequestStore, type Row, imageRef, type UnclaimedRow, type ClaimedRow } from "./requests.ts";
import type { LockOptions } from "./lock.ts";
import { markOn, marksRow } from "./mark.ts";
/** Why pi no longer has a row it was handed and did not write (the window's `settleSlots`). */
export type Gone = "stopped" | "dropped" | "lost";
import { backoffFor, DEAD_AFTER_ATTEMPTS } from "./backoff.ts";
export { DEAD_AFTER_ATTEMPTS } from "./backoff.ts";
import { stamp } from "./schedule.ts";
import { INTERRUPTED, type RunEnd, type Settlement, runEnd, settle } from "./settle.ts";
import { type JobStore, type LoopJob, type RunRecord, newId } from "./store.ts";
import { type TriggerStore, checkDecidedFinding } from "./triggers.ts";

/** How much of a dead row's text the finding carries. */
export const DEAD_LETTER_CHARS = 400;

/**
 * The mode a source gets (design §6.2): the producer writes it, the executor recomputes it. Attended
 * rows run as the person's own turns; unattended ones under the row's declared tools and the guard;
 * `none` asks for no model call of its own (a chat busy with a turn is still woken to see it, as a
 * follow-up is: docs/design.md decision 9).
 */
export function modeOf(lane: Lane["kind"], kind: Row["kind"], source: Row["source"], wake?: Row["wake"]): RequestMode {
	if (kind !== "input") return "none";
	// A loop's lane and a check's lane are run by pi-loops in the background, whatever asked for the run.
	if (lane !== "conversation") return "unattended";
	if (source.startsWith("rule:")) return "none";
	if (source.startsWith("push:")) return wake === "turn" ? "unattended" : "none";
	if (source.startsWith("cron:")) return "unattended";
	return "attended";
}

/** A rule's result as the row its creating conversation gets: an `append` with no model call, its trace id the proof of delivery. */
export function ruleResultRow(sessionId: string, content: string, trigger: { traceId: string; sourceLabel: string; cwd?: string }, createdBy: Row["created_by"], now = Date.now()): UnclaimedRow {
	const source = `rule:${trigger.sourceLabel}` as const;
	return { v: 3, id: trigger.traceId, lane: sessionId, kind: "input", source, mode: modeOf("conversation", "input", source, "append"), wake: "append", payload: { text: content, cwd: trigger.cwd ?? "" }, created_at: stamp(now), created_by: createdBy, attempts: 0 };
}

/**
 * The run id of a plain job's slot: `run-` plus 32 hex of a hash of `jobId|slot`, where the slot is
 * the due time the schedule owes, or the moment `/cron run` asked. Derived, not minted, so every
 * producer of one slot (a window's clock, the same clock after a crash between the row and the
 * stamps) writes the same id, and `appendIfAbsent` makes the second a no-op.
 */
export function plainRunId(jobId: string, slot: string): string {
	return `run-${createHash("sha256").update(`${jobId}|${slot}`).digest("hex").slice(0, 32)}`;
}

/** The collapse key a plain job's rows share: while one is queued, a later slot is spent without a new row. */
export const plainCollapseKey = (jobId: string): `cron:${string}` => `cron:${jobId}`;

/**
 * A plain job's prompt as the row its conversation runs as a turn: the job's declaration (tools,
 * model, thinking) rides along, so the executor runs it as the job asked, not as the chat is set.
 * `source` is `cron:` for the clock and `cron-run:` for `/cron run` typed in the conversation.
 */
export function plainJobRow(job: Pick<LoopJob, "id" | "sessionId" | "prompt" | "cwd" | "model" | "thinking" | "tools" | "builtinTools">, id: string, source: `cron:${string}` | `cron-run:${string}`, note: string, createdBy: Row["created_by"], now = Date.now()): UnclaimedRow {
	return {
		v: 3,
		id,
		lane: job.sessionId ?? "",
		kind: "input",
		source,
		mode: modeOf("conversation", "input", source, "turn"),
		wake: "turn",
		payload: { text: `[Trigger ${id}] ${job.prompt}${note}`, cwd: job.cwd, model: job.model, thinking: job.thinking, tools: job.tools, builtin_tools: job.builtinTools },
		collapse_key: plainCollapseKey(job.id),
		created_at: stamp(now),
		created_by: createdBy,
		attempts: 0,
	};
}

/** What every builder below takes from the session the row is addressed to. */
export interface RowAddress {
	sessionId: string;
	cwd: string;
	createdBy: Row["created_by"];
}

/**
 * The sources whose text must start with `[Trigger <id>] `, the proof of delivery an older version
 * reads by that prefix: the clock's prompt, `/cron run`, a rule's result, a push. A claim, a recipe
 * hand-off, `/new-trigger` and a goal's continuation carry it too since 0.24.3 (`prefixed`), as
 * words for the person and the model: this version knows no message by its prefix, since a window
 * hands every such row as a custom message that names it (src/window-executor.ts). Only the
 * person's own message goes in their words alone.
 */
export function carriesPrefix(source: Row["source"]): boolean {
	return source.startsWith("cron:") || source.startsWith("cron-run:") || source.startsWith("rule:") || source.startsWith("push:");
}

/** The words pi-loops wrote for a turn, after the row's `[Trigger <id>] `. */
function prefixed(id: string, prompt: string): string {
	return `[Trigger ${id}] ${prompt}`;
}

/** A turn row of one of a window's sources; `text` carries the prefix when `carriesPrefix(source)`. */
function turnRow(id: string, source: Row["source"], text: string, to: RowAddress, collapseKey: string | undefined, now: number): UnclaimedRow {
	return {
		v: 3,
		id,
		lane: to.sessionId,
		kind: "input",
		source,
		mode: modeOf("conversation", "input", source, "turn"),
		wake: "turn",
		payload: { text, cwd: to.cwd },
		...(collapseKey === undefined ? {} : { collapse_key: collapseKey }),
		created_at: stamp(now),
		created_by: to.createdBy,
		attempts: 0,
	};
}

/**
 * An MCP push a server delivers as `inject_and_run`: one turn in the window that has the server.
 * `prompt` already starts with `[Trigger <traceId>] ` (src/trigger-runtime.ts), so the trace id is
 * the row id and no second prefix is added. Pushes of one event kind collapse on the trigger's own
 * idempotency key, without the `mcp:<server>:` the key repeats from the source.
 */
export function pushRunRow(prompt: string, trigger: { traceId: string; idempotencyKey: string; source: { kind: "mcp"; serverName: string } | { kind: "local"; subkind: string } }, to: RowAddress, now = Date.now()): UnclaimedRow {
	const server = trigger.source.kind === "mcp" ? trigger.source.serverName : trigger.source.subkind;
	const ownPrefix = `mcp:${server}:`;
	const key = trigger.idempotencyKey.startsWith(ownPrefix) ? trigger.idempotencyKey.slice(ownPrefix.length) : trigger.idempotencyKey;
	return turnRow(trigger.traceId, `push:${server}`, prompt, to, `push:${server}:${key}`, now);
}

/**
 * The id of a goal's continuation: `goal-` plus 32 hex of a hash of the goal's condition, the
 * iteration the continuation is and the stamp of the decision that asked for it. Derived, so the
 * same continuation written twice is one row; the stamp keeps a goal set again with the same
 * condition from taking its predecessor's continuation, and its mark, for its own.
 */
export function goalRunId(goal: { condition: string; iterations: number; updatedAt: string }): string {
	return `goal-${createHash("sha256").update(`${goal.condition}|${goal.iterations}|${goal.updatedAt}`).digest("hex").slice(0, 32)}`;
}

/** A `/goal` continuation as the row its session runs as a turn: attended, the person's own goal (design O3), in the evaluator's words. */
export function goalRow(prompt: string, goal: { condition: string; iterations: number; updatedAt: string }, to: RowAddress, now = Date.now()): UnclaimedRow {
	const id = goalRunId(goal);
	return turnRow(id, "goal", prefixed(id, prompt), to, "goal", now);
}

/** `/inbox claim`: the finding as the turn that addresses it. A fresh id per claim; one queued hand-off per finding. */
export function inboxClaimRow(prompt: string, entryId: string, to: RowAddress, now = Date.now()): UnclaimedRow {
	const id = newId("claim");
	return turnRow(id, `inbox:${entryId}`, prefixed(id, prompt), to, `inbox:${entryId}`, now);
}

/**
 * A claim from the browser page: the row `/inbox claim` writes, signed by the page server and born
 * left (`created_by.left`). The server lives on and never runs a turn, so a row it signed and stayed
 * with would wait for it for ever; left at birth, the row is the holder's to run, as a terminal's
 * claim is once its window moves on (`releaseLocalRows`), and nobody's `mine`, so a pi that only
 * views the conversation never runs it beside the holder. Its mode stays attended: a holder believes
 * that only once the page rings it for the row, and otherwise runs it capped as unattended.
 */
export function pageClaimRow(prompt: string, entryId: string, to: RowAddress, now = Date.now()): UnclaimedRow {
	const row = inboxClaimRow(prompt, entryId, to, now);
	return { ...row, created_by: { ...to.createdBy, left: stamp(now) } };
}

/** Whether `row` is a claim the page queued (`pageClaimRow`) and no holder has handed over yet. */
export function isPageClaim(row: Row): boolean {
	return row.kind === "input" && row.source.startsWith("inbox:") && row.created_by.instance === PAGE_INSTANCE && row.created_by.left !== undefined && row.handed_at === undefined;
}

/** The `created_by.instance` the page server signs its claims with. */
export const PAGE_INSTANCE = "page";

/** What a recipe hands to the chat: the tracker description `/recipe add` needs, or a merge conflict `/recipe update` left. */
export type RecipeHandOff = "tracker" | "merge";

/**
 * A recipe's hand-off to the chat: one queued at a time per recipe and per kind, so a merge conflict
 * is not swallowed by the tracker description still waiting, which says nothing about it.
 */
export function recipeRow(prompt: string, recipe: string, kind: RecipeHandOff, to: RowAddress, now = Date.now()): UnclaimedRow {
	const id = newId("recipe");
	return turnRow(id, `recipe:${recipe}`, prefixed(id, prompt), to, `recipe:${recipe}:${kind}`, now);
}

/** `/new-trigger <request>`: the turn that turns the request into a rule. Every one is its own. */
export function newTriggerRow(prompt: string, to: RowAddress, now = Date.now()): UnclaimedRow {
	const id = newId("nt");
	return turnRow(id, "new-trigger", prefixed(id, prompt), to, undefined, now);
}

/**
 * What the person typed into the browser page (design §5): a turn in their own words, with no
 * `[Trigger]` prefix, so the text itself is the proof of delivery (`landed`). The id is the page's
 * UUID for that send, so a retried send is one message. `created_by` is the page's web.mjs: the row
 * is sent only while that process lives (`decideDrain`), and offered by the next page otherwise.
 * The row names its images by digest; the bytes go beside the queue (`RequestStore.append`).
 */
export function personRow(id: string, text: string, images: ImageContent[] | undefined, to: RowAddress, now = Date.now()): UnclaimedRow {
	return {
		v: 3,
		id,
		lane: to.sessionId,
		kind: "input",
		source: "person",
		mode: modeOf("conversation", "input", "person", "turn"),
		wake: "turn",
		payload: { text, ...(images?.length ? { images: images.map(imageRef) } : {}), cwd: to.cwd },
		created_at: stamp(now),
		created_by: to.createdBy,
		attempts: 0,
	};
}

/**
 * What a produced row said that decides its cap, as a hex digest: a change to any of it in the file
 * is not the producer's. The text, the images (type and the digest of the bytes: a swapped image is
 * another message, and `RequestStore.images` refuses bytes that do not match the digest), the
 * declared tools. The page sends it with `/pi-loops ring <id> <fingerprint>` over pi's rpc stdin, a
 * channel no model tool can write to, so the window believes the row's attended mode only when the
 * row in the file still has this fingerprint (`ringProduced`).
 */
export function requestFingerprint(row: Row): string {
	const images = row.payload?.images?.map((image) => [image.mimeType, image.sha256]) ?? null;
	return createHash("sha256").update(JSON.stringify([row.kind, row.source, row.wake ?? null, row.payload?.text ?? "", images, row.payload?.tools ?? null, row.payload?.builtin_tools ?? null])).digest("hex").slice(0, 32);
}

/**
 * `/pi-loops ring <id> <fingerprint>`: the queued row with that id is recorded as produced by this
 * window (`produced`) only when the row now in the file has exactly that fingerprint. Returns whether
 * it was; a ring for a row that is gone, or that says something else now, records nothing.
 */
export function ringProduced(rows: readonly Row[], id: string, fingerprint: string, produced: (row: Row) => void): boolean {
	const row = rows.find((r) => r.id === id);
	if (!row || requestFingerprint(row) !== fingerprint) return false;
	produced(row);
	return true;
}

/**
 * `pi-loops abort` (`cli`), `/triggers abort` (`window`) or the page's Stop this run (`person`): stop
 * the turn `target` names, in whichever process holds the conversation. A row, so it outlives a
 * socket that does not answer; no payload, the target is the whole request. `{id}` names a row's
 * turn; `{current, started_before}` names the turn running when the stop was asked for, so a late one
 * never stops the next turn.
 */
export function stopRow(sessionId: string, target: NonNullable<Row["target"]>, source: Row["source"], createdBy: Row["created_by"], now = Date.now()): UnclaimedRow {
	return { v: 3, id: newId("stop"), lane: sessionId, kind: "stop", source, mode: modeOf("conversation", "stop", source), target, created_at: stamp(now), created_by: createdBy, attempts: 0 };
}

/** Take a queued row out before it runs. One pi already holds is not cancelled: a stop aborts it as it starts. */
export function cancelRow(sessionId: string, target: { id: string }, source: Row["source"], createdBy: Row["created_by"], now = Date.now()): UnclaimedRow {
	return { v: 3, id: newId("cancel"), lane: sessionId, kind: "cancel", source, mode: modeOf("conversation", "cancel", source), target, created_at: stamp(now), created_by: createdBy, attempts: 0 };
}

export type HeldTurnMatch = { kind: "turn"; sessionId: string; runId: string } | { kind: "ambiguous"; matches: string[] };

/**
 * The held turn `ref` names, a run id or a prefix of one: the conversation the background process
 * holds for it and the run's full id, read from the leases. A dead process's lease names no turn,
 * nor does one held for a write (`busy` is a promotion's, not a `run-` id). A prefix of more than
 * one turn names none: the matches, for the person to pick from.
 */
export function heldTurnFor(leases: readonly SessionLease[], ref: string, probe?: ProcessProbe): HeldTurnMatch | undefined {
	const turns = leases.flatMap((lease) => {
		const holder = lease.holder;
		const runId = holder?.busy?.runId;
		if (!holder || runId === undefined || !runId.startsWith("run-") || holder.kind !== "host" || !holderAlive(holder, probe)) return [];
		return [{ sessionId: lease.sessionId, runId }];
	});
	const exact = turns.find((t) => t.runId === ref);
	if (exact) return { kind: "turn", ...exact };
	const matches = turns.filter((t) => t.runId.startsWith(ref));
	if (matches.length === 1) return { kind: "turn", ...matches[0] };
	if (matches.length > 1) return { kind: "ambiguous", matches: matches.map((t) => t.runId).sort() };
	return undefined;
}

/** The sources a person types into the window itself: `/inbox claim`, a recipe command, `/new-trigger`. */
function typedInWindow(source: Row["source"]): boolean {
	return source.startsWith("inbox:") || source.startsWith("recipe:") || source === "new-trigger";
}

/**
 * The sources a person types themselves, in the window the row is for or in the browser page: among
 * the turn rows, these take the lane first, as the person's own message would. `/cron run` is typed
 * too, in the job's own words with the prefix the clock's prompt has.
 */
export function typedByPerson(source: Row["source"]): boolean {
	return source === "person" || source.startsWith("cron-run:") || typedInWindow(source);
}

/**
 * A row that runs in the process that produced it, whatever that process holds: what the person
 * typed into the window (`typedInWindow`) and a goal's continuation. Their turn belongs in the window
 * the person is looking at, and the goal's state is that window's; another executor runs one only
 * once its producer is gone. The background process never does (src/host-runtime.ts runs no
 * attended row). A `person` row is not local: its producer is the page's web.mjs, which runs nothing;
 * the holder runs it (design §5, O2).
 */
export function isLocal(row: Row): boolean {
	return row.kind === "input" && (typedInWindow(row.source) || row.source === "goal");
}

/** The process a row was written by, as `created_by` names it: the pid, and its start time when the writer had one. */
export interface Producer {
	pid: number;
	procStart?: string;
}

/** Whether `by` is the process `self`, started when `self` was: a reused pid is not the producer. */
export function sameProducer(by: Producer, self: Producer): boolean {
	return by.pid === self.pid && (by.procStart === undefined || self.procStart === undefined || by.procStart === self.procStart);
}

/**
 * The continuations `/goal clear` and a new `/goal` drop, since they belong to the condition being
 * replaced: every queued `goal` row of this instance, and every one whose producer is gone (a window
 * that quit mid-goal), which would otherwise be the new goal's first turn and, through the shared
 * collapse key, swallow its own continuations. A live other window's rows are its goal's, not ours.
 */
export function dropContinuations(store: RequestStore, sessionId: string, self: Producer, alive: (row: Row) => boolean): string[] {
	const stale = store.list(sessionId).filter((row) => row.kind === "input" && row.source === "goal" && (sameProducer(row.created_by, self) || !alive(row)));
	if (stale.length) store.remove(sessionId, stale.map((row) => row.id));
	return stale.map((row) => row.id);
}

/**
 * A window leaving a conversation (`/new`, `/resume`, quitting) with local rows of its own still
 * queued marks them left, so the holder runs them: the pid stays alive, bound elsewhere, and the
 * pid check alone would have them wait on it for as long as pi runs. A row whose proof is already in
 * this window's conversation ran here and is removed instead: a holder reads its own copy of the
 * conversation, which need not show what this window wrote, and would run it a second time.
 * Returns the ids marked.
 */
export function releaseLocalRows(store: RequestStore, sessionId: string, self: Producer, deliveredHere: (row: Row) => boolean, now = Date.now()): string[] {
	const mine = store.list(sessionId).filter((row) => isLocal(row) && row.created_by.left === undefined && sameProducer(row.created_by, self));
	const ran = mine.filter((row) => deliveredHere(row));
	if (ran.length) store.remove(sessionId, ran.map((row) => row.id));
	const left = mine.filter((row) => !deliveredHere(row));
	for (const row of left) store.update(sessionId, row.id, { created_by: { ...row.created_by, left: stamp(now) } });
	return left.map((row) => row.id);
}

/**
 * Queue `row` unless a row with its id, or with its collapse key, is already queued: collapse, never
 * replay (docs/design.md decision 6). A queued row whose proof `delivered` already finds in the
 * conversation is done, not queued: the goal's next continuation is written while the last one is
 * still in the file, waiting for the drain that removes it. Returns whether it was written.
 */
export function enqueue(store: RequestStore, row: UnclaimedRow, delivered: (row: Row) => boolean = () => false, lock?: LockOptions): boolean {
	return store.appendIfAbsent(row, { collapse: true, done: (queued) => delivered(queued) }, lock);
}

/**
 * How long a claim waits for a queue's lock while it holds the inbox's (`Inbox.decide`'s `before`):
 * well inside the inbox lock's ten-second stale point, so a stuck queue lock makes the claim fail
 * instead of letting another process break the inbox lock and lose its write under this rewrite.
 */
export const CLAIM_QUEUE_LOCK: LockOptions = { timeoutMs: 5_000 };

/** Where a producer's hand-over went, for the trigger audit: not written at all, in the chat already, or waiting in the file. */
export function handOverTarget(written: boolean, result: Pick<DrainResult, "delivered"> | undefined, id: string): "collapsed" | "chat" | "queued" {
	if (!written) return "collapsed";
	return result?.delivered.includes(id) ? "chat" : "queued";
}

export const queuedTriggeredTurn = (runId: string): string => `queued triggered turn (trace ${runId.slice(0, 8)}) after the current one`;

/**
 * What the window says when a turn row is queued while pi is busy: one line naming the row and its
 * source, so a prompt waiting in the file is as visible as one pi used to queue under the editor. A
 * push keeps the line it had; a goal continuation says nothing more than its own notice did. `name`
 * is the plain job's, when the caller has it (the row names the job by id).
 */
export function waitingLine(source: Row["source"], id: string, name?: string): string | undefined {
	if (source.startsWith("push:")) return queuedTriggeredTurn(id);
	const job = jobOf(source);
	if (job !== undefined) return `queued: cron ${name ?? job} runs after the current turn`;
	if (source.startsWith("inbox:")) return "queued: /inbox claim runs after the current turn";
	if (source.startsWith("recipe:")) return `queued: recipe ${source.slice("recipe:".length)} runs after the current turn`;
	if (source === "new-trigger") return "queued: /new-trigger runs after the current turn";
	return undefined;
}

/** What a window's hand-over needs: its store, whether a row's proof is in its conversation, its executor's `produced`, and its drain. */
export interface HandOverDeps {
	store: RequestStore;
	delivered(row: Row): boolean;
	produced(row: Row): void;
	drain(): Promise<DrainResult | undefined>;
}

export interface HandOverOutcome {
	/** False: a row with its id or its collapse key was already queued. */
	written: boolean;
	result: DrainResult | undefined;
	/** The line to show when the row was written and waits, or when the claim it carried was already decided. */
	line?: string;
}

/**
 * A prompt one of a window's sources has for the chat: queued as a row (collapsed when one with its
 * key is already there), then delivered now when pi is idle; otherwise it waits in the file for the
 * tick, the bell or `agent_settled`, and `line` says so once. For `/inbox claim`, the hand-off is
 * queued under the inbox lock once the finding is found new, and the finding marked claimed after:
 * a crash between the two leaves the finding `new` with its hand-off queued, where the reverse order
 * left it claimed with nobody told.
 */
export async function handOver(deps: HandOverDeps, row: UnclaimedRow, claim?: { inbox: Pick<Inbox, "decide">; entryId: string }): Promise<HandOverOutcome> {
	let written = false;
	if (claim) {
		// Queued under the inbox lock, after the finding is found still new (`Inbox.decide`): a claim
		// decided elsewhere between the list and here (another window, the page, `pi-loops inbox`)
		// queues nothing, so no holder can run a hand-off for a claim that lost.
		const decided = await claim.inbox.decide(claim.entryId, "claimed", { by: row.lane, before: () => void (written = enqueue(deps.store, row, deps.delivered, CLAIM_QUEUE_LOCK)) });
		if (!("ok" in decided)) {
			const ref = claim.entryId.slice(0, 12);
			return { written: false, result: undefined, line: "missing" in decided ? `inbox: ${ref} is gone; nothing was sent` : `inbox: ${ref} was already ${decided.already}; nothing was sent` };
		}
	} else written = enqueue(deps.store, row, deps.delivered);
	deps.produced(row);
	const result = await deps.drain();
	const waits = written && result !== undefined && !result.delivered.includes(row.id);
	return { written, result, line: waits ? waitingLine(row.source, row.id) : undefined };
}

/**
 * One drain for when a wait ends on its own (`DrainResult.retryAt`): a timer per session, replaced
 * and never stacked, so a terminal that holds a page's row drains it the moment the ring wait is
 * over instead of at the next tick. `delayMs` at or below zero drains on the next turn of the loop.
 */
export function armRetry(timers: Map<string, ReturnType<typeof setTimeout>>, sessionId: string, delayMs: number, fn: () => void): void {
	const old = timers.get(sessionId);
	if (old !== undefined) clearTimeout(old);
	const timer = setTimeout(() => {
		timers.delete(sessionId);
		fn();
	}, Math.max(0, delayMs));
	timer.unref?.();
	timers.set(sessionId, timer);
}

/**
 * One `run` at a time, and at most one more after it: a burst of calls while one runs is one rerun,
 * which reads what the running one read too early to see. The window's request watcher fires once
 * per rewrite of the file, and every removal is a rewrite, so thirty rows used to be ninety drains,
 * each a read of the file; nothing is lost by running fewer, since each drain reads the file afresh.
 * `run` must not reject: it reports its own errors, as the drains do.
 */
export function coalesced(run: () => Promise<unknown>): () => void {
	let running = false;
	let again = false;
	const go = (): void => {
		if (running) {
			again = true;
			return;
		}
		running = true;
		run()
			.then(() => {
				running = false;
				if (again) {
					again = false;
					go();
				}
			})
			.catch(() => undefined); // `run` reports its own errors; nothing is left to reject here
	};
	return go;
}

/** A file as a quiet mark reads it: its size and mtime, or undefined for one that is not there. */
export type FileMark = { size: number; mtimeMs: number } | undefined;

/**
 * What a closed conversation's queue was last found to need nothing for: the files the decision read
 * (the conversation, jobs.json) as they were, the rows as they were, and until when the decision
 * holds on its own (the earliest backoff that ends; Infinity when none does). While `stillQuiet`,
 * the conversation is not read again: a row the background process cannot run (an attended row)
 * used to cost a full parse of the conversation on every tick, for as long as it waited there. A
 * queue that holds a claim is never quiet: whether its run is still going is asked at every tick,
 * so a claim whose process died is closed and does not stay.
 */
export interface QuietMark {
	key: string;
	until: number;
}

export function quietMark(files: readonly FileMark[], rows: readonly Row[], now: number): QuietMark {
	const ends = rows.map((row) => (row.not_before === undefined ? NaN : Date.parse(row.not_before))).filter((at) => Number.isFinite(at) && at > now);
	return { key: JSON.stringify([files, rows]), until: ends.length ? Math.min(...ends) : Infinity };
}

export function stillQuiet(mark: QuietMark | undefined, files: readonly FileMark[], rows: readonly Row[], now: number): boolean {
	return !rows.some((row) => row.run) && mark !== undefined && now < mark.until && mark.key === JSON.stringify([files, rows]);
}

export type PromotionTarget = { to: "row"; sessionId: string } | { to: "inbox"; sessionId?: string };

/** What `promotionTarget` asks about the conversations a rule's result could go to; `promotionView` reads it off the leases. */
export interface PromotionView {
	/** A live window that delivers (src/lease.ts holderDelivers) holds it: the result lands in front of the person. */
	open(sessionId: string): boolean;
	/** pi-loops knows its file and the file is there: a row for it is appended by the background process. */
	known(sessionId: string): boolean;
	/** The conversations live windows hold in the rule's project, each with its holder's pid. */
	openInProject(): Array<{ sessionId: string; pid: number }>;
}

/**
 * Where a rule's result goes, decided the same way by a window and by the background process
 * (owner decision, 2026-11-02): the conversation that created the rule while a live window holds it;
 * else the conversation a live window holds in the rule's project, lowest pid first so every process
 * computes the same answer (0.22.8's cwd owner); else the creating conversation, closed, which the
 * background process appends to; else the inbox, marked for the creating conversation when there is
 * one. A rule with no creating conversation (imported, or made by a loop's run) starts at the
 * project's open window.
 */
export function promotionTarget(forSession: string | undefined, view: PromotionView): PromotionTarget {
	if (forSession !== undefined && view.open(forSession)) return { to: "row", sessionId: forSession };
	const window = view
		.openInProject()
		.sort((a, b) => a.pid - b.pid || a.sessionId.localeCompare(b.sessionId))[0];
	if (window) return { to: "row", sessionId: window.sessionId };
	if (forSession !== undefined && view.known(forSession)) return { to: "row", sessionId: forSession };
	return { to: "inbox", ...(forSession === undefined ? {} : { sessionId: forSession }) };
}

/**
 * The view `promotionTarget` decides on, read from the leases: a live `terminal` holder that delivers
 * is an open window; a lease whose `cwd` is `cwd` or inside it is in the rule's project. No `cwd`, no project: only the creating conversation can take it.
 */
export function promotionView(leases: Pick<LeaseStore, "read" | "list">, cwd: string | undefined, probe: ProcessProbe = systemProbe): PromotionView {
	const windowOf = (lease: SessionLease | undefined): LeaseHolder | undefined => {
		const holder = lease?.holder;
		return holder && holder.kind === "terminal" && holderAlive(holder, probe) && holderDelivers(holder) ? holder : undefined;
	};
	return {
		open: (id) => windowOf(leases.read(id)) !== undefined,
		known: (id) => {
			const file = leases.read(id)?.sessionFile;
			return !!file && fs.existsSync(file);
		},
		openInProject: () => {
			if (cwd === undefined) return [];
			return leases.list().flatMap((lease) => {
				const holder = windowOf(lease);
				return holder && lease.cwd && withinProject(cwd, lease.cwd) ? [{ sessionId: lease.sessionId, pid: holder.pid }] : [];
			});
		},
	};
}

/** What a row's proof of delivery is read from: the conversation, as `landed` asks it. */
export interface Proof {
	/** Whether an entry of the session the row writes into carries a mark that proves this row (src/mark.ts `marksRow`): this lane and id, and, for a message the window aborted, this `created_at`. False when that session has no file. */
	has(row: Pick<Row, "id" | "created_at">): boolean;
	/** The proof of a version before marks, for a row of a version 2 line only (`OlderRow`): its prefix, or its words after its hand-over stamp, in an entry with no mark. */
	older(row: OlderRow): boolean;
	/**
	 * Whether the held turn that claimed `row` wrote its prompt: `[Trigger <id>] ` at the start of a
	 * user message. The held turn writes its prompt with no extension of ours loaded, so it carries no
	 * mark; the milestone that gives a loop its lane gives that prompt its mark and deletes this.
	 */
	heldRunWrote(row: ClaimedRow): boolean;
	/**
	 * The end of the run that claimed `row`, as its run record states it: the newest record whose
	 * `runId` is `row.run.id` and whose `startedAt` is at or after `row.run.started_at`. Undefined
	 * for a row with no claim, and when no such record is there. Every writer of a record for a
	 * claim copies `startedAt` from the claim, so the record of a row's first run is older than the
	 * claim of its second, and does not close it. Whether the run is still going is the executor's
	 * question (`ExecutorView.claimLive`).
	 */
	ran(row: Row): RunEnd | undefined;
}

/**
 * Whether `row`'s delivery is in the conversation: an entry carries a mark that proves it
 * (src/mark.ts `marksRow`): its lane and id, and, for a message the window aborted as it began, also
 * when it was queued, so that such a message does not prove a row of the same id queued later. One rule for every
 * row, whoever produced it and whatever its words. Two fenced rules beside it, each reached only by
 * the row's type: a claimed row's held turn (its prefix: `Proof.heldRunWrote`), and a row of a version
 * 2 line, which an older version may have delivered unmarked (`Proof.older`). No words prove a row
 * of this version.
 */
export function landed(row: Row, proof: Proof): boolean {
	if (proof.has(row)) return true;
	if (row.run) return proof.heldRunWrote(row);
	const old = olderRow(row);
	return old !== undefined && proof.older(old);
}

declare const older: unique symbol;

/**
 * A row read from a version 2 line: one that an older version wrote (src/requests.ts sets `line`).
 * Only such a row can have been delivered by a version that writes no mark: 0.24.2 reads and writes
 * version 2 lines only. Only `olderRow` makes one.
 */
export type OlderRow = UnclaimedRow & { readonly line: 2; readonly [older]: true };

/** `row` as a row of a version 2 line, or undefined for any other row. */
export function olderRow(row: Row): OlderRow | undefined {
	return row.run === undefined && row.line === 2 ? (row as OlderRow) : undefined;
}

/**
 * The proof an older version gives `row`, over the entries that carry no mark: a message this
 * version wrote has a mark that names its own row, so it never proves an older one by its words. A
 * row of a `carriesPrefix` source: a message that starts with `[Trigger <id>] `. Any other row: a
 * user message whose text starts with the row's, written at or after its hand-over stamp.
 */
function olderProved(row: OlderRow, entries: readonly unknown[]): boolean {
	const unmarked = entries.filter((entry) => markOn(entry) === undefined);
	if (carriesPrefix(row.source)) return conversationHas(unmarked, row.id);
	return row.handed_at !== undefined && conversationPersonEntries(unmarked, row.payload?.text ?? "", row.handed_at) > 0;
}

/**
 * pi's notes on the images of a user message, appended to its text: `[Image: original …]` for one it
 * resized, `[Image omitted …]` for one it could not decode, `[Image converted …]` for a format it
 * changed. Stripped before a row with no text of its own is matched: such a row is proved only by a
 * message that says nothing else, not by any message that follows it.
 */
export function stripImageNotes(text: string): string {
	return text.replace(TRAILING_IMAGE_NOTES, "").trim();
}

/** The three notes pi writes (`utils/image-process.js`), and only at the end: a person's own `[Image: …]` stays theirs. */
const IMAGE_NOTE = String.raw`\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by [\d.]+ to map to original image\.\]|\[Image omitted: [^\]]*\]|\[Image converted from [^\]]* to [^\]]*\.\]`;
const TRAILING_IMAGE_NOTES = new RegExp(String.raw`(?:\s*(?:${IMAGE_NOTE}))+\s*$`);

/**
 * Whether a user message's text is a person row's: it starts with the row's text (pi appends its
 * image notes after it), or, for a row with no text, it has none of its own once those notes go.
 * The older version's proof only (`olderProved`).
 */
function personTextMatches(messageText: string, rowText: string): boolean {
	return rowText === "" ? stripImageNotes(messageText) === "" : messageText.startsWith(rowText);
}

const textOf = (content: unknown): string | undefined => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const first = content.find((part) => !!part && typeof part === "object" && (part as { type?: unknown }).type === "text");
	return first && typeof (first as { text?: unknown }).text === "string" ? (first as { text: string }).text : undefined;
};

/** The user messages among `entries` whose text starts with `text`, written at or after `since` (pi's `timestamp` on the entry). The older version's proof only. */
function conversationPersonEntries(entries: readonly unknown[], text: string, since: string): number {
	const floor = Date.parse(since);
	return entries.filter((entry) => {
		if (!entry || typeof entry !== "object") return false;
		const value = entry as { type?: unknown; timestamp?: unknown; message?: { role?: unknown; content?: unknown } };
		if (value.type !== "message" || value.message?.role !== "user" || !personTextMatches(textOf(value.message.content) ?? "", text)) return false;
		const at = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
		return Number.isNaN(at) ? false : at >= floor;
	}).length;
}

/** Whether the process of the run that claimed `row` is still there, by the rule of a lease's holder (`holderAlive`). */
export function claimAlive(row: ClaimedRow, probe: ProcessProbe = systemProbe): boolean {
	return holderAlive({ pid: row.run.pid, procStart: row.run.procStart, acquiredAt: row.run.started_at }, probe);
}

/**
 * The one builder of a `Proof`, for the rows of `lane`: the marks of that lane among the entries of
 * the session the rows write into (a fork copies entries with their marks, so a mark names its
 * lane), the two fenced rules, and `ran` over the run records. Who builds a proof says where its
 * records come from; a window writes no run record for a turn it runs, and passes `() => []`.
 * `runs` is read only when a row with a claim is asked about.
 */
export function proofOf(lane: LaneId, entries: () => readonly unknown[], runs: () => readonly RunRecord[]): Proof {
	return {
		has: (row) =>
			entries().some((entry) => {
				const mark = markOn(entry);
				return mark !== undefined && marksRow(mark, lane, row);
			}),
		older: (row) => olderProved(row, entries()),
		heldRunWrote: (row) => conversationHas(entries(), row.id),
		ran: (row) => {
			if (!row.run) return undefined;
			const id = row.run.id;
			const from = Date.parse(row.run.started_at);
			let record: RunRecord | undefined;
			for (const r of runs()) if (r.runId === id && Date.parse(r.startedAt) >= from) record = r; // the newest one of this claim
			return record && runEnd(record);
		},
	};
}

/** Whether `[Trigger <id>] ` is in the conversation: a user message or a custom message that starts with it. */
export function conversationHas(entries: readonly unknown[], id: string): boolean {
	const prefix = `[Trigger ${id}] `;
	return entries.some((entry) => {
		if (!entry || typeof entry !== "object") return false;
		const value = entry as { type?: unknown; message?: { role?: unknown; content?: unknown }; content?: unknown };
		if (value.type === "message" && value.message?.role === "user") return textOf(value.message.content)?.startsWith(prefix) ?? false;
		if (value.type === "custom_message") return textOf(value.content)?.startsWith(prefix) ?? false;
		return false;
	});
}

/**
 * A session file's entries, read and parsed only. `SessionManager.open` migrates an old file or
 * fills an empty one, which is a write, and a process without the lease must not write there.
 */
export function sessionFileEntries(file: string): unknown[] {
	let data: string;
	try {
		data = fs.readFileSync(file, "utf8");
	} catch {
		return []; // no file: nothing landed
	}
	return data.split("\n").flatMap((line) => {
		try {
			return line ? [JSON.parse(line)] : [];
		} catch {
			return []; // a torn line holds no entry
		}
	});
}

/** `conversationHas` over a session file on disk (pi's JSONL), for a process with no session open on it. */
export function sessionFileHas(file: string, id: string): boolean {
	return conversationHas(sessionFileEntries(file), id);
}

/**
 * The modes each executor runs (design §6.3): a window every one, since the person is there to be
 * asked; the background process no attended row, which waits for a window. The view carries the one
 * for its kind, and `decideDrain` asks it after it has recomputed the row's mode itself.
 */
export const CEILING: Record<ExecutorView["kind"], (mode: RequestMode) => boolean> = { window: () => true, held: (mode) => mode !== "attended" };

export interface ExecutorView {
	kind: "window" | "held";
	/** Whether this executor runs rows of `mode` (`CEILING`); a row above it waits for an executor that does. */
	ceiling(mode: RequestMode): boolean;
	/**
	 * Why this executor leaves the row for later, its mode apart (that is `ceiling`, and the engine
	 * recomputes the mode itself); undefined when nothing of its own holds the row. `decideDrain` waits
	 * with this reason, which is computed each time and stored nowhere. A window: always undefined.
	 * pi-loops in the background: a turn of its own is writing the conversation, or the row is a turn
	 * row that this drain may not start (a rule's push waits for a window; a plain job's row starts
	 * at its job's tick, where its sub-agent slot is).
	 */
	blocked(row: UnclaimedRow): string | undefined;
	/**
	 * Whether the run that claimed the row is still going. The executor's question and not the
	 * proof's: an executor that runs rows knows its own runs. Until one does, both answer with the
	 * rule of a lease's holder (`holderAlive`) for the claim's process.
	 */
	claimLive(row: ClaimedRow): boolean;
	/** window: `ctx.isIdle()`; the background process writes into a conversation nobody has open. */
	idle: boolean;
	running?: { requestId?: string; startedAt: string };
	/** Handed to pi and not yet in the conversation: the derived claims. */
	inFlight: ReadonlySet<string>;
	/**
	 * When each person row in `inFlight` that went to an idle pi as a user message was handed over,
	 * for the ones pi has started no run since (`agent_start` clears them; an `input` or
	 * `message_start` seen meanwhile restarts the count). One still here while pi is idle
	 * `PERSON_SEND_GRACE_MS` later was refused: pi's `prompt()` throws before any run starts
	 * (compaction in progress, no model, no credentials), and an extension hears nothing of it.
	 */
	inFlightSince?: ReadonlyMap<string, number>;
	/**
	 * The turn rows in `inFlight` that went to an idle pi as a custom message and that no run has
	 * taken up. Each has the lane, as one in `inFlightSince` has, and no grace applies to it: pi
	 * starts a run for a custom message at once, or when its `agent_settled` handlers return, and
	 * refuses none in silence (probes S2, P17).
	 */
	unstarted?: ReadonlySet<string>;
	/**
	 * Rows pi was handed and no longer has, unwritten, with the reason (src/window-claim.ts
	 * `settleSlots`): a stop named it and it went (`stopped`: exit cancelled, never offered again); a
	 * stop in a terminal took it out of pi's queue (`dropped`); or a run ended with no stop and no entry
	 * carries its mark (`lost`: pi dropped it with no word, another handler took the mark off, or pi
	 * wrote a person's message in words the window could not take for the row's). A failure is counted
	 * for the last two: without the count, a prompt that is lost on every turn would run for ever.
	 */
	gone?: ReadonlyMap<string, Gone>;
	/**
	 * Whether this executor was rung for the row (`/pi-loops ring <id> <fingerprint>`) and the row
	 * still says what the ring said: its attended mode is believed. A fresh person row nobody rang for
	 * yet waits `PERSON_RING_WAIT_MS`, so the bell wins the race with the file watcher.
	 */
	believed?(row: Row): boolean;
	connected(server: string): boolean;
	/** Whether the process that wrote the row is still there: a local row waits for it, a person row is sent only for it. */
	producerAlive(row: Row): boolean;
	/** This executor is the row's producer, bound to its session: the one that runs a local row while it lives, and the page's pi for a person row the page rang it for. */
	mine(row: Row): boolean;
	/**
	 * Whether the conversation's live holder, another process, delivers the person rows addressed to
	 * it (src/lease.ts holderDelivers); undefined when nobody else holds it. `false` makes this
	 * executor run the person rows it was rung for (`mine`) in that holder's place: a terminal standing
	 * aside, or a `pi -p` run, holds the lease and hands nothing over, and the page's message would
	 * otherwise wait for ever, where 0.22 answered it from the page's own pi.
	 */
	holderDelivers?: boolean;
}

/** Every way a row leaves its queue (docs/design.md; the request engine's exits). */
type Exit = "delivered" | "dead" | "cancelled" | "stale" | "refused" | "job-removed" | "stopped";

/**
 * The audit line's `state` for each exit, and the one place the strings are written: `pi-loops
 * abort` and the simulation read them. `delivered` writes `done`, and only for a stop or a cancel:
 * a delivered input's record is its session file.
 */
const AUDIT_STATE = {
	delivered: "done",
	dead: "dead",
	cancelled: "cancelled",
	stale: "stale",
	refused: "refused",
	"job-removed": "job-removed",
	stopped: "stopped",
} as const satisfies Record<Exit, string>;

/**
 * What a drain does with a row. The engine takes a row out of its queue by `exit`, or by `close`
 * with an exit, and in no other way. A row with a claim (`ClaimedRow`) is never handed to pi, and leaves or
 * loses its claim only through `close`.
 */
export type Action =
	| { do: "append"; row: UnclaimedRow; wakeAgent: boolean }
	| { do: "turn"; row: UnclaimedRow }
	| { do: "abort"; stop: UnclaimedRow }
	| { do: "abortWhenStarted"; stop: UnclaimedRow; target: string }
	| { do: "exit"; row: UnclaimedRow; exit: Exclude<Exit, "dead" | "stopped"> }
	/** The dead letter. It cannot be written without its reason, which the finding's text carries. */
	| { do: "exit"; row: UnclaimedRow; exit: "dead"; why: string }
	/**
	 * pi did not write the row it was handed. An attempt is counted; at `DEAD_AFTER_ATTEMPTS` a pi-loops
	 * row is a dead letter. `retry` says when it is offered again: `never` for a person row (the page
	 * takes it back: a retry that did land would answer one prompt twice), `backoff` for a hand-over
	 * pi refused, `now` for one pi dropped (Esc), which the hold after a stop already paces.
	 */
	| { do: "fail"; row: UnclaimedRow; why: string; retry: "never" | "backoff" | "now" }
	/**
	 * The process that ran a claimed row is gone: its run is closed (`closeRun`). What the row gets
	 * is decided there, once, from the run's record: it leaves as `delivered` or as `stopped`, it
	 * stays owed with its claim cleared, or it fails with an attempt.
	 */
	| { do: "close"; row: ClaimedRow }
	/** `until`: when the wait ends on its own (the ring wait), for a drain to be scheduled then. */
	| { do: "wait"; row: Row; why: string; until?: number };

/** What the caller knows about the drain it asks for: a tick is the one drain that may judge a hand-over pi never answered. */
export interface DrainOptions {
	tick?: boolean;
}

/**
 * How long a turn row handed to an idle pi may go without a run starting before it counts as
 * refused. pi emits `agent_start` before its first provider call, so a slow first token is not
 * this, and compaction is not idle (`isIdle` is false while it runs), so a run that compacts first
 * is not either. The count restarts at every `input` and `message_start` pi emits meanwhile, and
 * what is left to cover is pi's pre-run phase after its `input` event: the other extensions' input
 * handlers and the credential check, which can go to the network, none of which pi reports. Five
 * seconds covered `before_agent_start` handlers alone, and a tick landing after a slow credential
 * check failed a send pi then ran. The name stays: src/web/page.js reads it for its follow-up ring.
 */
export const PERSON_SEND_GRACE_MS = 10_000;

/**
 * How long a person row nobody rang for waits before it is handed over capped: the page appends
 * then rings, and the file watcher fires on the append, so a drain can see the row before the bell
 * that vouches for it. Past this, a row stays capped (a terminal answering a page's row, owner
 * decision O2; a line written by hand), and the window asks before a dangerous command.
 */
export const PERSON_RING_WAIT_MS = 2_000;

/**
 * Whether applying `actions` writes anything: a row handed over, removed or buried. A drain that
 * only waits leaves the file, the conversation and the lease as they were, so a holder that must
 * take a lease to drain can see from this alone that there is nothing to take it for.
 */
export function changesSomething(actions: readonly Action[]): boolean {
	return actions.some((a) => a.do === "append" || a.do === "turn" || a.do === "exit" || a.do === "close" || a.do === "fail");
}

/**
 * The input rows of a session in the order the engine offers them, which is the order the page
 * lists them: file order, except that among the turn rows what the person typed takes the lane
 * before what the clock or a server queued, as their own message would; `append` rows keep their
 * place, so a result queued before the claim lands before it.
 */
export function queueOrder(rows: readonly Row[]): Row[] {
	const turns = rows.filter((row) => row.kind === "input" && row.wake === "turn");
	const turnOrder = [...turns.filter((row) => typedByPerson(row.source)), ...turns.filter((row) => !typedByPerson(row.source))];
	return rows.filter((row) => row.kind === "input").map((row) => (row.wake === "turn" ? turnOrder.shift()! : row));
}

export interface JobsView {
	exists(id: string): boolean;
	/** Whether the job is enabled: the clock's row of a disabled job waits, as the clock itself does. */
	enabled(id: string): boolean;
	/** Whether the session has a goal being pursued: a `goal` row without one is stale. */
	goalActive(sessionId: string): boolean;
}

const jobOf = (source: string): string | undefined => (source.startsWith("cron:") ? source.slice("cron:".length) : source.startsWith("cron-run:") ? source.slice("cron-run:".length) : undefined);

/**
 * The run id `/cron` and `cron_list` print as `running <id>`: the job's marker (a loop, or what an
 * earlier version left on a plain job), else the claim of the job's row in its conversation's
 * queue. Not a question of liveness: a claim whose process is gone prints until the next drain
 * closes it, as a stale marker prints until the next tick clears it.
 */
export function runningRun(job: Pick<LoopJob, "id" | "running">, rows: readonly Row[]): string | undefined {
	return job.running?.runId ?? jobClaim(job.id, rows)?.run.id;
}

/** The row of a plain job that a run has claimed, among its conversation's `rows`: the turn that is going for it. */
export function jobClaim(jobId: string, rows: readonly Row[]): ClaimedRow | undefined {
	return rows.find((r): r is ClaimedRow => r.run !== undefined && jobOf(r.source) === jobId);
}

/**
 * The held turns that are going for `jobs`: for each plain job with no marker, the claim on its
 * row, when the process that made it lives. What a window lists as runs of the machine that have
 * no marker in the store.
 */
export function heldTurns(jobs: readonly Pick<LoopJob, "id" | "stateful" | "sessionId" | "running">[], rowsOf: (sessionId: string) => readonly Row[], alive: (row: ClaimedRow) => boolean = claimAlive): Array<{ jobId: string; run: ClaimedRow["run"] }> {
	return jobs.flatMap((job) => {
		if (job.stateful || !job.sessionId || job.running) return [];
		const claimed = jobClaim(job.id, rowsOf(job.sessionId));
		return claimed && alive(claimed) ? [{ jobId: job.id, run: claimed.run }] : [];
	});
}

/** Whether a row of the job is queued in its conversation's lane, claimed or not: the question of the one-shot rule. */
export function jobQueued(jobId: string, rows: readonly Row[]): boolean {
	return rows.some((r) => r.kind === "input" && r.collapse_key === plainCollapseKey(jobId));
}

/** A plain job's prompt waiting in its conversation's queue, as `/cron` and `cron_list` report it. */
export interface QueuedPrompt {
	/** The row's `created_at`: when the prompt was queued. */
	since: string;
	/** Why it waits, when the row itself says: the backoff after a failed hand-over. */
	reason?: string;
}

/**
 * The oldest queued row of a plain job among its conversation's `rows` (`cron:` from the clock,
 * `cron-run:` from `/cron run`), or undefined when none of the job's is queued. The row a held turn
 * is running stays in the file while it runs and is not queued: its claim (`runningRun`) names
 * it, and the listing already shows that. The reason is read from the row alone, so a listing costs
 * one file read per conversation and no executor view.
 */
export function queuedPrompt(job: Pick<LoopJob, "id" | "running">, rows: readonly Row[], now: number): QueuedPrompt | undefined {
	// Only a row the engine would run for this job: its own prefix, its source's mode, not dead. A row
	// written into the file under a job's name is not that job's prompt, and the listing must not say so.
	const row = rows.find((r) => r.kind === "input" && jobOf(r.source) === job.id && !r.run && r.id !== job.running?.runId && r.payload?.text.startsWith(`[Trigger ${r.id}] `) && modeOf("conversation", r.kind, r.source, r.wake) === r.mode && r.attempts < DEAD_AFTER_ATTEMPTS);
	if (!row) return undefined;
	// Stamps from the file are re-written from what they parse to, never echoed: they reach a terminal and the model.
	const created = Date.parse(row.created_at);
	const since = Number.isFinite(created) ? stamp(created) : "?";
	const until = row.not_before === undefined ? NaN : Date.parse(row.not_before);
	if (!Number.isFinite(until) || until <= now) return { since };
	// The error is ours (`redact`ed when written), so the listing may say why the row backs off.
	return { since, reason: `${row.last_error ? `${row.last_error}; ` : ""}backing off until ${stamp(until)}` };
}

/** `ms` as the largest whole unit a wait is read in: `12s`, `3m`, `2h`, `5d`; `?` for a stamp that did not parse. */
export function formatWait(ms: number): string {
	if (!Number.isFinite(ms)) return "?";
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86_400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86_400)}d`;
}

/**
 * Whether `row` holds its lane: a turn handed to an idle pi that no run has taken up, whatever else the
 * row waits for (its job disabled, a backoff), since pi has the prompt already; not one that leaves in
 * this drain (`own`, the row's actions, holds an exit or a fail). An idle pi gets one prompt of ours at a time.
 */
function holdsLane(row: Row, view: ExecutorView, own: readonly Action[]): boolean {
	return row.wake === "turn" && (view.inFlightSince?.has(row.id) === true || view.unstarted?.has(row.id) === true) && !own.some((a) => a.do === "exit" || a.do === "fail");
}

/**
 * Pure. `lane` is the kind of the lane the rows are in. Stops and cancels first, idle or busy; then
 * every input is classified with no regard to whether the lane is free; then the lane is taken, from
 * all the rows; then the rows that could start are started, in order. So where a row sorts does not
 * decide whether a turn is handed over beside one that has the lane. A row with a claim (`row.run`)
 * is decided before any other rule: its run is still going and has the lane, or its run is closed
 * and the row leaves, stays owed, or fails. For the others, oldest first, one lane: a row in
 * backoff, waiting for a server, handed over, above this executor's ceiling or held back by it is
 * skipped and blocks nothing; one whose mode is not its source's is refused and removed.
 * `append` rows land at once while idle, with no turn; during a turn they go as a follow-up, which
 * wakes the agent when it ends (docs/design.md decision 9). A `turn` row is handed over only while
 * pi is idle and the lane is free, one per drain. Among the turn rows, what the person typed takes
 * the lane before what the clock or a server queued, as their own message would; `append` rows keep
 * their place, so a result queued before the claim lands before it. A local row (`isLocal`) is run by its
 * producer while that process lives; every other executor skips it, judges nothing about it and
 * counts no attempt.
 */
export function decideDrain(lane: Lane["kind"], rows: readonly Row[], proof: Proof, jobs: JobsView, view: ExecutorView, now: number, opts: DrainOptions = {}): Action[] {
	const actions: Action[] = [];
	// What a stop or a cancel can take out of the queue: an input no run has claimed.
	const queued = new Map(rows.flatMap((row) => (row.kind === "input" && !row.run ? [[row.id, row] as const] : [])));
	const inputs = queueOrder(rows);
	const cancelled = new Set<string>();
	for (const row of rows) {
		if (row.kind === "input") continue;
		let done = false;
		const target = row.target;
		if (target && "id" in target) {
			if (row.kind === "stop" && view.running?.requestId === target.id) {
				actions.push({ do: "abort", stop: row });
				done = true;
			} else if (row.kind === "stop" && view.inFlight.has(target.id)) {
				// pi holds it (the idle-check race): removing the row would not keep pi from running it.
				actions.push({ do: "abortWhenStarted", stop: row, target: target.id });
				done = true;
			} else if (row.kind === "cancel" && view.inFlight.has(target.id) && view.running?.requestId !== target.id && queued.has(target.id) && !cancelled.has(target.id)) {
				// pi holds the row and has not begun it: behind a running turn, or kept after a stop. The
				// page's "clear queue" writes this cancel and then empties pi, which tells no extension
				// (issue 259). The row leaves now, and the window aborts a turn if pi writes it after all.
				// An `append` row's message starts no turn of its own to abort: one pi still holds (the
				// page's ✕ on that row, which leaves pi as it is) lands as it would have landed before this cancel.
				cancelled.add(target.id);
				actions.push({ do: "abortWhenStarted", stop: row, target: target.id });
				actions.push({ do: "exit", row: queued.get(target.id)!, exit: "cancelled" });
				done = true;
			} else if (queued.has(target.id) && !view.inFlight.has(target.id) && !cancelled.has(target.id)) {
				cancelled.add(target.id);
				actions.push({ do: "exit", row: queued.get(target.id)!, exit: "cancelled" });
				done = true;
			}
		} else if (target && row.kind === "stop" && view.running && Date.parse(view.running.startedAt) < Date.parse(target.started_before)) {
			// As times: each stamp carries its writer's offset, and two offsets do not order as strings.
			actions.push({ do: "abort", stop: row });
			done = true;
		}
		actions.push({ do: "exit", row, exit: done ? "delivered" : "stale" });
	}

	/** What one input row comes to: its actions, whether it has the lane, and the row itself when it would land or start now. */
	type Sorted = { actions: Action[]; holding: boolean; ready?: UnclaimedRow };
	const settled = (...own: Action[]): Sorted => ({ actions: own, holding: false });

	/** A row a run has claimed: its run is going, or it is closed and the row gets what the run came to (`closeRun`). */
	const claimed = (row: ClaimedRow): Sorted => (view.claimLive(row) ? { actions: [{ do: "wait", row, why: "running" }], holding: true } : settled({ do: "close", row }));

	const unclaimed = (row: UnclaimedRow): Sorted => {
		const actions: Action[] = [];
		const done = (): Sorted => ({ actions, holding: holdsLane(row, view, actions) });
		if (landed(row, proof)) {
			actions.push({ do: "exit", row, exit: "delivered" });
			return done();
		}
		const gone = view.gone?.get(row.id);
		if (gone === "stopped") {
			actions.push({ do: "exit", row, exit: "cancelled" });
			return done();
		}
		const wait = (why: string, until?: number) => actions.push({ do: "wait", row, why, ...(until === undefined ? {} : { until }) });
		// A row that leaves while pi holds its prompt and has not begun it (its job removed, its goal
		// cleared): the window aborts the prompt if pi writes it after all, as for a cancel.
		const leaveHeld = (): void => {
			if (view.inFlight.has(row.id) && view.running?.requestId !== row.id) actions.push({ do: "abortWhenStarted", stop: row, target: row.id });
		};
		// Judged on a tick only: the drain that handed the row over, and the one `agent_settled` runs
		// (pi defers a prompt sent while it emits that event until after the handler), both come
		// before pi has had its chance. A bell from outside pi's event cycle (the page's ring) counts.
		const since = view.inFlightSince?.get(row.id);
		const refused = opts.tick && since !== undefined && view.idle && now - since >= PERSON_SEND_GRACE_MS;
		if (row.source === "person") {
			// pi refused it (see `inFlightSince`): the row keeps its error for the page to take back, and
			// is never handed over again, since retrying would answer one prompt twice if it did land.
			if (row.last_error !== undefined) {
				wait(`pi refused it: ${row.last_error}`);
				return done();
			}
			if (refused) {
				actions.push({ do: "fail", row, why: "pi did not start a turn for it", retry: "never" });
				return done();
			}
		} else if (refused) {
			// A pi-loops row is proved by its mark, so offering it again is safe; one refusal must not
			// hold the slot for ever, nor the job's later slots, which collapse onto a queued row.
			actions.push({ do: "fail", row, why: "pi did not start a turn for it", retry: "backoff" });
			return done();
		}
		// What pi no longer has (`ExecutorView.gone`). A person row a stop took out is offered again
		// uncounted, as the message they queued would have gone; one lost after a run that wrote no
		// mark for it goes back to the page, once. Every other row counts an attempt.
		if (gone === "lost") {
			actions.push({ do: "fail", row, why: "pi dropped it before it was written", retry: row.source === "person" ? "never" : "backoff" });
			return done();
		}
		if (row.source !== "person" && gone === "dropped") {
			actions.push({ do: "fail", row, why: "pi dropped it before it was written", retry: "now" });
			// The attempt that buries it: nothing below may hand it over as well.
			if (row.attempts + 1 >= DEAD_AFTER_ATTEMPTS) return done();
		}
		if (row.attempts >= DEAD_AFTER_ATTEMPTS) {
			actions.push({ do: "exit", row, exit: "dead", why: `failed ${row.attempts} times${row.last_error ? `: ${row.last_error}` : ""}` });
			return done();
		}
		// A person's message may be an image alone; everything else is text.
		if (!row.payload?.text && !(row.source === "person" && row.payload?.images?.length)) {
			actions.push({ do: "exit", row, exit: "dead", why: "an input row without text" });
			return done();
		}
		// The prefix is the proof of delivery an older version and a held turn read (`olderProved`,
		// `Proof.heldRunWrote`): a row of such a source without it would be written again by either,
		// with nothing to tell that it landed.
		if (carriesPrefix(row.source) && !row.payload?.text.startsWith(`[Trigger ${row.id}] `)) {
			actions.push({ do: "exit", row, exit: "dead", why: "an input row without its [Trigger <id>] prefix" });
			return done();
		}
		// The producer wrote the mode; the executor runs the row under the one its source gets, and
		// nothing else. A line edited in the file, or written by another version, cannot widen what
		// the turn may do: it is refused, and the audit says so.
		if (modeOf(lane, row.kind, row.source, row.wake) !== row.mode) {
			actions.push({ do: "exit", row, exit: "refused" });
			return done();
		}
		const jobId = jobOf(row.source);
		if (jobId !== undefined) {
			// The jobs are read from a file that can be damaged (empty, written by a newer pi-loops): that
			// costs the rows that name a job, and nothing else in the queue.
			let job: { exists: boolean; enabled: boolean };
			try {
				const exists = jobs.exists(jobId);
				job = { exists, enabled: exists && jobs.enabled(jobId) };
			} catch (err: any) {
				wait(`cannot read the jobs: ${redact(err?.message ?? String(err))}`);
				return done();
			}
			if (!job.exists) {
				leaveHeld();
				actions.push({ do: "exit", row, exit: "job-removed" });
				return done();
			}
			// The clock's prompt waits with its clock; `/cron run` was asked for, and `/cron run` itself
			// refuses a job that is disabled when it is typed.
			if (!job.enabled && row.source.startsWith("cron:")) {
				wait("its job is disabled");
				return done();
			}
		}
		if (isLocal(row) && !view.mine(row) && view.producerAlive(row)) {
			wait("runs in the window that produced it");
			return done();
		}
		// Judged by the executor that runs the row: the goal is that process's state.
		if (row.source === "goal" && !jobs.goalActive(row.lane)) {
			leaveHeld();
			actions.push({ do: "exit", row, exit: "stale" });
			return done();
		}
		if (!view.ceiling(row.mode)) {
			wait(`${row.mode} rows wait for a window`);
			return done();
		}
		const blocked = view.blocked(row);
		if (blocked !== undefined) {
			wait(blocked);
			return done();
		}
		if (row.not_before !== undefined && Date.parse(row.not_before) > now) {
			wait(`backing off until ${row.not_before}`);
			return done();
		}
		if (view.inFlight.has(row.id)) {
			// A turn handed to an idle pi that no run has taken up yet has the lane: an idle pi gets one
			// prompt of ours at a time, from every source. Once a run takes it, or pi keeps it after a
			// stop, the lane is free: the next turn row starts the run that writes it behind.
			wait("handed to pi, not yet in the conversation");
			return done();
		}
		// A person's message is sent only for the page that wrote it (design §5); every other row
		// outlives its producer, and a local one is the holder's to run once the producer is gone.
		if (row.source === "person" && !view.producerAlive(row)) {
			wait("its producer is gone");
			return done();
		}
		if (row.source === "person" && view.believed && !view.believed(row) && now - Date.parse(row.created_at) < PERSON_RING_WAIT_MS) {
			wait("waiting for the page's ring", Date.parse(row.created_at) + PERSON_RING_WAIT_MS);
			return done();
		}
		const missing = row.payload?.requires?.find((server) => !view.connected(server));
		if (missing !== undefined) {
			wait(`waiting for mcp server ${missing}`);
			return done();
		}
		return { actions, holding: false, ready: row };
	};

	const sorted = inputs.filter((row) => !cancelled.has(row.id)).map((row) => (row.run ? claimed(row) : unclaimed(row)));
	// The lane is taken from all the rows, before any of them is started.
	const taken = sorted.some((s) => s.holding);
	let busy = !view.idle;
	// What pi is to abort as it starts goes first: a prompt handed over in this drain must not go to
	// pi while the window still counts a prompt pi will abort as one it is owed.
	for (const { actions: own } of sorted) actions.push(...own.filter((a) => a.do === "abortWhenStarted"));
	for (const { actions: own, holding, ready } of sorted) {
		actions.push(...own.filter((a) => a.do !== "abortWhenStarted"));
		if (holding) busy = true;
		if (!ready) continue;
		if (ready.wake !== "turn") {
			actions.push({ do: "append", row: ready, wakeAgent: busy });
			continue;
		}
		if (busy || taken) {
			actions.push({ do: "wait", row: ready, why: "pi is busy" });
			continue;
		}
		busy = true;
		actions.push({ do: "turn", row: ready });
	}
	return actions;
}

/**
 * What a hand-over came to. `lease-lost`: the window could not write the hold on its lease (another
 * process holds the conversation now), and sent nothing. The drain stops there and counts no attempt
 * and no delivery, as it does when `holds()` turns false between two rows.
 */
export type TurnSent = "sent" | "lease-lost";

export interface Executor {
	/** Read from disk each call: the conversation can be taken while a drain runs. A non-holder still drains the local rows it produced (`ExecutorView.mine`). */
	holds(lane: LaneId): boolean;
	view(lane: LaneId): ExecutorView;
	/** What a row of the lane is proved by: the session it writes into, and the run records. */
	proof(lane: LaneId): Proof;
	/** Hand a turn row to pi; `now` is when, for `ExecutorView.inFlightSince`. A row with a claim cannot be handed over. A promise when the hand-over has work to wait for first (a window resizes a row's images). */
	turn(row: UnclaimedRow, now: number): TurnSent | Promise<TurnSent>;
	append(row: UnclaimedRow, wakeAgent: boolean): TurnSent;
	/** Stop the turn running now. */
	abort(): void;
	/** Stop the turn of row `id`, handed to pi and not started yet, as it starts. */
	abortWhenStarted(id: string): void;
	/** pi refused row `id` (a `fail` action): it is no longer in flight. */
	refused(id: string): void;
}

/** Where the engine records what it did: the jobs it checks rows against, the inbox for dead letters, the audit, and what the closing of a run writes. */
export interface EngineSinks {
	jobs: JobsView;
	/** A dead letter is filed once, under an id derived from its row's; a rule's result keeps `appendOnce`. */
	inbox: Pick<Inbox, "appendOnce" | "fileOnce">;
	audit: Pick<TriggerStore, "appendAudit" | "listAudit">;
	/** jobs.json and the run log, for the closing of a run: its record when none is there, and the job's patch. A window gives these too: it closes the claim of a background process that is gone. */
	ledger: Pick<JobStore, "load" | "update" | "appendRun">;
	/** This process, as the `created_by` of a row the closing writes. */
	self(): Row["created_by"];
}

export interface DrainResult {
	/** Handed to the executor this drain. */
	delivered: string[];
	/** Taken out of the file: done, cancelled, stale, or a removed job's. */
	removed: string[];
	failed: string[];
	dead: string[];
	waiting: string[];
	/** The earliest moment a wait above ends on its own (the ring wait): worth a drain then, not at the next tick. */
	retryAt?: number;
}

const stripPrefix = (text: string) => text.replace(/^\[Trigger [^\]]+\]\s*/, "");

/**
 * The dead letter: the finding first, then the audit line, then the removal. A crash after the
 * finding writes it again on the next drain and loses nothing; the reverse order lost the row.
 */
/** A prompt that never reached its conversation, as its inbox finding reads: why first, then the prompt. */
export function deadLetterText(why: string, prompt: string): string {
	return `could not be delivered (${why}): ${prompt}`;
}

/** The parts of a dead letter's text, or undefined for any other finding: the engine's mark decides, never the text. */
export function deadLetterParts(entry: { text: string; undelivered?: true }, text = entry.text): { why: string; prompt: string } | undefined {
	if (!entry.undelivered) return undefined;
	const m = /^could not be delivered \((.*?)\): ([\s\S]*)$/.exec(text);
	return m ? { why: m[1], prompt: m[2] } : undefined;
}

async function deadLetter(store: RequestStore, sinks: EngineSinks, row: Row, why: string): Promise<void> {
	// A finding names the conversation it is for; a lane of another kind is no conversation.
	const session = parseLane(row.lane)?.kind === "conversation" ? { session_id: row.lane } : {};
	const text = stripPrefix(row.payload?.text ?? "");
	const cwd = row.payload?.cwd ?? "";
	// A rule's result keeps the finding it always had in the inbox (`trigger:<label>`): the
	// since-you-looked count and `/inbox open` tell results from runs by that source. Any other row
	// was meant to run in the conversation, so its finding says why it did not, before a claim reruns it.
	const rule = row.source.startsWith("rule:") ? row.source.slice("rule:".length) : undefined;
	// The check that produced a rule's result decided its finding already (src/trigger-runtime.ts:
	// filed it, or skipped a repeat), so its dead letter files nothing; a result no check decided is
	// filed once by its run (Inbox.appendOnce).
	if (rule !== undefined) {
		if (!checkDecidedFinding(sinks.audit, row.id)) await sinks.inbox.appendOnce({ source: `trigger:${rule}`, run_id: row.id, job_id: rule, cwd, text: text || `rule result ${row.id}`, ...session, lane: row.lane }, { run_id: row.id, source: `trigger:${rule}` });
	}
	// Filed once: a crash between the finding and the removal repeats this at the next drain, and files nothing.
	else await sinks.inbox.fileOnce({ source: row.source, run_id: row.id, cwd, text: deadLetterText(why, text.slice(0, DEAD_LETTER_CHARS) || `${row.kind} request ${row.id}`), ...session, lane: row.lane, undelivered: true }, findingId(`dead | ${row.lane} | ${row.id}`));
	sinks.audit.appendAudit({ cwd, type: "request", traceId: row.id, state: "dead", sourceLabel: row.source, eventLabel: row.lane, summary: text, details: { session_id: row.lane, kind: row.kind, attempts: row.attempts, last_error: row.last_error, reason: why } });
	store.remove(row.lane, [row.id]);
}

/**
 * One more failure of `row`: at `DEAD_AFTER_ATTEMPTS` a pi-loops row is a dead letter; a person row
 * never is (design §5), it keeps its error for the page. Otherwise the count, the error and, when
 * the retry backs off, when it may go again are written on the row, and the audit says `failed`.
 * A row that fails has no run: a claim is cleared in the same write, so the attempt is counted once.
 */
async function failRow(store: RequestStore, sinks: EngineSinks, row: Row, why: string, retry: "never" | "backoff" | "now", now: number): Promise<"failed" | "dead"> {
	const attempts = row.attempts + 1;
	if (row.source !== "person" && attempts >= DEAD_AFTER_ATTEMPTS) {
		await deadLetter(store, sinks, { ...row, attempts, last_error: why }, `failed ${attempts} times: ${why}`);
		return "dead";
	}
	store.update(row.lane, row.id, { attempts, last_error: why, ...(retry === "backoff" ? { not_before: stamp(now + backoffFor(attempts)) } : {}), ...(row.run ? { run: undefined } : {}) });
	sinks.audit.appendAudit({ cwd: row.payload?.cwd ?? "", type: "request", traceId: row.id, state: "failed", sourceLabel: row.source, eventLabel: row.lane, details: { session_id: row.lane, attempts, error: why } });
	return "failed";
}

/** The one way a row leaves its queue, the dead letter apart: its audit line, then the removal. */
function leaveRow(store: RequestStore, sinks: EngineSinks, row: Row, exit: Exclude<Exit, "dead">): void {
	// A delivered input row's record is the session file; everything else ends in the audit.
	if (exit !== "delivered" || row.kind !== "input") sinks.audit.appendAudit({ cwd: row.payload?.cwd ?? "", type: "request", traceId: row.id, state: AUDIT_STATE[exit], sourceLabel: row.source, eventLabel: row.lane, details: { session_id: row.lane, kind: row.kind } });
	store.remove(row.lane, [row.id]);
}

/**
 * The id of the row that asks again after `rowId`. Derived, so a closing that runs twice appends
 * one successor, and a successor that ran meanwhile is found by its prefix and leaves without a
 * second answer.
 */
const successorId = (jobId: string, rowId: string): string => plainRunId(jobId, `after ${rowId}`);

/** What a closing came to: what `settle` decided, the end it read, the job as written, and where the row's id belongs in a `DrainResult`. */
export interface Closed {
	settlement: Settlement;
	end: RunEnd;
	job?: LoopJob;
	outcome: "removed" | "waiting" | "failed" | "dead";
}

/**
 * The closing of the run that claimed `row`: the one function that takes a claim off a row. Two
 * callers: a drain, for a `close` action (the claim's process is gone, and the caller holds the
 * lane), and the process that ran the run, when it ends there, with or without the lease: the
 * closing writes the run log, `jobs.json` and the queue file, and never the conversation. It has
 * no parameter for how the run ended: it reads that from the run log through `proof`, or from the
 * record it appends, so the row cannot be changed before a record exists. `record` is the record
 * of a run that ended in this process; a drain passes none. The closing is the one writer of a
 * record for a claim.
 *
 * The writes, in order. Each is safe to repeat, and a process that stops after any of them leaves
 * the row with its claim, so the next drain starts again at the first:
 *   1. the record, when none belongs to the claim: `record`, else one that says `interrupted`;
 *   2. the job's patch, which `settle` gives once per record;
 *   3. the successor row, under an id derived from this row's;
 *   4. the row, last: it leaves, or its claim is cleared, with or without an attempt.
 */
export async function closeRun(store: RequestStore, sinks: EngineSinks, row: ClaimedRow, proof: Proof, now: number, record?: RunRecord): Promise<Closed> {
	const jobId = jobOf(row.source);
	let end = proof.ran(row);
	if (!end) {
		const named = jobId === undefined ? undefined : sinks.ledger.load().find((j) => j.id === jobId);
		const written: RunRecord = record ?? { runId: row.run.id, jobId: jobId ?? "", ...(named?.name ? { jobName: named.name } : {}), stateful: false, cwd: row.payload?.cwd ?? named?.cwd ?? "", pid: row.run.pid, startedAt: row.run.started_at, finishedAt: stamp(now), ok: false, error: INTERRUPTED, findings: 0, droppedFindings: 0, stateUpdated: false, interrupted: true };
		sinks.ledger.appendRun(written);
		end = runEnd(written);
	}
	const closed = end;
	// Whether the prompt is in the conversation. A run that ended spends its slot either way (the
	// table of `settle`); a run that did not end is delivered only when its prompt is there.
	const written = landed(row, proof);
	let settlement = settle(undefined, closed, written);
	const job = jobId === undefined ? undefined : await sinks.ledger.update(jobId, (j) => {
		settlement = settle(j, closed, written);
		if (settlement.job) Object.assign(j, settlement.job);
	});
	const fate = settlement.row;
	if (job && fate.do === "leave" && fate.exit === "delivered" && fate.successor) store.appendIfAbsent(plainJobRow(job, successorId(job.id, row.id), `cron:${job.id}`, "", sinks.self(), now));
	let outcome: Closed["outcome"];
	if (fate.do === "leave") {
		leaveRow(store, sinks, row, fate.exit);
		outcome = "removed";
	} else if (fate.do === "owed") {
		store.update(row.lane, row.id, { run: undefined });
		outcome = "waiting";
	} else outcome = await failRow(store, sinks, row, fate.why, "backoff", now);
	return { settlement, end: closed, job, outcome };
}

/**
 * Deliver what is queued for `sessionId` through `executor`: every row if it holds the conversation,
 * else only the local rows it produced itself. Read the rows, decide, then apply each action, asking
 * `holds()` again before each one.
 */
export function drain(sessionId: string, store: RequestStore, executor: Executor, now: number, sinks: EngineSinks, opts: DrainOptions = {}): Promise<DrainResult> {
	// One drain of a session at a time in this process: the tick, the bell and a promotion each start
	// one, and two that overlap would hand a row over, or write a dead letter, twice.
	const key = `${store.dir}\0${sessionId}`;
	// `now` is the caller's clock when it asked; the drain may wait behind another, and awaits dead
	// letters of its own. `asked` lets a stamp be written at the moment it is written, in the
	// caller's clock: a message the person typed in the meantime must not prove a row stamped before it.
	const asked = Date.now();
	const next = (draining.get(key) ?? Promise.resolve()).then(() => drainOnce(sessionId, store, executor, now, sinks, opts, asked));
	const settled = next.catch(() => undefined);
	draining.set(key, settled);
	settled
		.then(() => {
			if (draining.get(key) === settled) draining.delete(key);
		})
		.catch(() => undefined); // a map delete cannot reject
	return next;
}
const draining = new Map<string, Promise<unknown>>();

async function drainOnce(sessionId: string, store: RequestStore, executor: Executor, now: number, sinks: EngineSinks, opts: DrainOptions, asked = Date.now()): Promise<DrainResult> {
	/** The caller's clock, read now: `now` plus what has passed since the drain was asked for. */
	const moment = () => now + (Date.now() - asked);
	const out: DrainResult = { delivered: [], removed: [], failed: [], dead: [], waiting: [] };
	const view = executor.view(sessionId);
	// A window that does not hold the conversation (a viewer, one standing aside, a `pi -p` run)
	// still runs what the person typed into it and its own goal's continuations; and the browser
	// page's rows it was rung for, when the holder will not deliver them (`ExecutorView.holderDelivers`).
	const own = (row: Row) => view.mine(row) && (isLocal(row) || (row.source === "person" && view.holderDelivers === false));
	const may = (row?: Row) => executor.holds(sessionId) || (!!row && own(row));
	const rows = may() ? store.list(sessionId) : store.list(sessionId).filter(own);
	const lane = parseLane(sessionId);
	if (!rows.length || !lane) return out;
	const actions = decideDrain(lane.kind, rows, executor.proof(sessionId), sinks.jobs, view, now, opts);
	const failed = async (row: Row, why: string, retry: "never" | "backoff" | "now"): Promise<void> => {
		out.failed.push(row.id);
		if ((await failRow(store, sinks, row, why, retry, now)) === "dead") out.dead.push(row.id);
	};
	const leave = (row: Row, exit: Exclude<Exit, "dead">): void => {
		leaveRow(store, sinks, row, exit);
		out.removed.push(row.id);
	};
	apply: for (const action of actions) {
		// Before each one, not once: the conversation can be taken while this drains.
		if (!may("row" in action ? action.row : undefined)) break;
		switch (action.do) {
			case "wait":
				out.waiting.push(action.row.id);
				if (action.until !== undefined && (out.retryAt === undefined || action.until < out.retryAt)) out.retryAt = action.until;
				break;
			case "exit":
				if (action.exit === "dead") {
					await deadLetter(store, sinks, action.row, action.why);
					out.dead.push(action.row.id);
					break;
				}
				leave(action.row, action.exit);
				break;
			case "close": {
				const closed = await closeRun(store, sinks, action.row, executor.proof(sessionId), now);
				if (closed.outcome === "dead") out.failed.push(action.row.id);
				out[closed.outcome].push(action.row.id);
				break;
			}
			case "abort":
				executor.abort();
				break;
			case "abortWhenStarted":
				executor.abortWhenStarted(action.target);
				break;
			case "fail":
				await failed(action.row, action.why, action.retry);
				executor.refused(action.row.id);
				break;
			case "append":
			case "turn": {
				const row = action.row;
				// Drains overlap (the tick, the bell, a promotion), and one can hand a row over while this
				// one awaits a dead letter: ask again at the moment of handing it over.
				// And whether the row may start: a turn that this drain started holds the appends behind it.
				const current = executor.view(sessionId);
				if (current.inFlight.has(row.id) || landed(row, executor.proof(sessionId)) || current.blocked(row) !== undefined) break;
				try {
					// The stamp first, under the lock: what the page shows of a hand-over, and the start of a
					// version 2 row's text proof. A crash between the two leaves a stamped row with no message,
					// handed over again with a new stamp. A stamp that found no row hands nothing over: the row left the file since this drain
					// read it (cancelled, or taken back by the page and sent over rpc), and a turn now would
					// answer it a second time.
					if (action.do === "turn" && !carriesPrefix(row.source) && !store.update(sessionId, row.id, { handed_at: stamp(moment()) })) break;
					const handed = action.do === "append" ? executor.append(row, action.wakeAgent) : executor.turn(row, now);
					// Awaited only when there is something to wait for: a hand-over that is done at once leaves no gap for pi's events.
					const sent = typeof handed === "string" ? handed : await handed;
					// The hold found another holder: nothing was sent, and nothing more of this drain is ours.
					if (sent === "lease-lost") break apply;
				} catch (err: any) {
					// One attempt, not two: the row is read again, and a row that has a claim now is not
					// failed here. Its closing counts the attempt, once.
					const queued = store.list(sessionId).find((r) => r.id === row.id);
					if (queued && !queued.run) await failed(queued, redact(err?.message ?? String(err)), "backoff");
					break;
				}
				out.delivered.push(row.id);
				// Written into the conversation already (an idle window, the background process): gone now.
				// Otherwise pi holds it as a follow-up and the next drain finds it in the file, or not.
				// A row that a run has claimed leaves through its closing only.
				if (landed(row, executor.proof(sessionId)) && store.removeIf(sessionId, row.id, (r) => !r.run).outcome === "removed") out.removed.push(row.id);
				break;
			}
		}
	}
	return out;
}

/**
 * Every row of a session that can never take them (its file is gone): a pi-loops input becomes a
 * dead letter, in the same order as a failed row (the finding, the audit line, the removal). A stop
 * or a cancel has nothing to tell anyone, and a person's message never goes to the inbox (design
 * §5: the page is where it is answered or given back), so those are audited `stale` and removed,
 * with no finding.
 */
export async function bury(sessionId: ConversationId, store: RequestStore, sinks: EngineSinks, why: string): Promise<string[]> {
	const ids: string[] = [];
	for (const row of store.list(sessionId)) {
		if (row.kind === "input" && row.source !== "person") await deadLetter(store, sinks, row, why);
		else {
			sinks.audit.appendAudit({ cwd: "", type: "request", traceId: row.id, state: AUDIT_STATE.stale, sourceLabel: row.source, eventLabel: row.lane, details: { session_id: row.lane, kind: row.kind, reason: why } });
			store.remove(sessionId, [row.id]);
		}
		ids.push(row.id);
	}
	return ids;
}
