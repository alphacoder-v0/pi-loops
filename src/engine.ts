/**
 * The one engine that delivers a session's requests (src/requests.ts). `decideDrain` is pure: the
 * rows, what the conversation already holds, the jobs and the executor's view in, the actions out.
 * `drain` applies them through an executor: the window that holds the conversation
 * (src/window-executor.ts), or the background process for a closed one (src/host-runtime.ts). A
 * local row (what the person typed, a goal's continuation) is run by the window that produced it,
 * lease or not, for as long as that window is on the conversation.
 *
 * Delivery is at least once; `[Trigger <id>] ` already in the conversation is what makes a second
 * delivery a no-op, and a row leaves the file only once that proof is in the file. A row that fails
 * waits out a backoff and blocks nothing behind it; at three failures it is a dead letter: an inbox
 * finding first, then an audit line, then the removal, so a crash in between loses no row.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type { Inbox } from "./inbox.ts";
import { redact } from "./redact.ts";
import { type ProcessProbe, type SessionLease, holderAlive } from "./lease.ts";
import { type ImageContent, type RequestMode, type RequestStore, type SessionRequest } from "./requests.ts";
import { stamp } from "./schedule.ts";
import { type LoopJob, newId } from "./store.ts";
import type { TriggerStore } from "./triggers.ts";

/** Failures of one row before it is a dead letter. */
export const DEAD_AFTER_ATTEMPTS = 3;
/** The wait after the first, second and later failures. */
export const BACKOFF_MS: readonly number[] = [60_000, 5 * 60_000, 30 * 60_000];
/** How much of a dead row's text the finding carries. */
export const DEAD_LETTER_CHARS = 400;

export function backoffFor(attempts: number): number {
	return BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1];
}

/**
 * The mode a source gets (design §6.2): the producer writes it, the executor recomputes it. Attended
 * rows run as the person's own turns; unattended ones under the row's declared tools and the guard;
 * `none` asks for no model call of its own (a chat busy with a turn is still woken to see it, as a
 * follow-up is: docs/design.md decision 9).
 */
export function modeOf(kind: SessionRequest["kind"], source: SessionRequest["source"], wake?: SessionRequest["wake"]): RequestMode {
	if (kind !== "input") return "none";
	if (source.startsWith("rule:")) return "none";
	if (source.startsWith("push:")) return wake === "turn" ? "unattended" : "none";
	if (source.startsWith("cron:")) return "unattended";
	return "attended";
}

/** A rule's result as the row its creating conversation gets: an `append` with no model call, its trace id the proof of delivery. */
export function ruleResultRow(sessionId: string, content: string, trigger: { traceId: string; sourceLabel: string; cwd?: string }, createdBy: SessionRequest["created_by"], now = Date.now()): SessionRequest {
	const source = `rule:${trigger.sourceLabel}` as const;
	return { v: 2, id: trigger.traceId, session_id: sessionId, kind: "input", source, mode: modeOf("input", source, "append"), wake: "append", payload: { text: content, cwd: trigger.cwd ?? "" }, created_at: stamp(now), created_by: createdBy, attempts: 0 };
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
export function plainJobRow(job: Pick<LoopJob, "id" | "sessionId" | "prompt" | "cwd" | "model" | "thinking" | "tools" | "builtinTools">, id: string, source: `cron:${string}` | `cron-run:${string}`, note: string, createdBy: SessionRequest["created_by"], now = Date.now()): SessionRequest {
	return {
		v: 2,
		id,
		session_id: job.sessionId ?? "",
		kind: "input",
		source,
		mode: modeOf("input", source, "turn"),
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
	createdBy: SessionRequest["created_by"];
}

/** `text` already starts with `[Trigger <id>] `: the proof of delivery every pi-loops row carries. */
function turnRow(id: string, source: SessionRequest["source"], text: string, to: RowAddress, collapseKey: string | undefined, now: number): SessionRequest {
	return {
		v: 2,
		id,
		session_id: to.sessionId,
		kind: "input",
		source,
		mode: modeOf("input", source, "turn"),
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
export function pushRunRow(prompt: string, trigger: { traceId: string; idempotencyKey: string; source: { kind: "mcp"; serverName: string } | { kind: "local"; subkind: string } }, to: RowAddress, now = Date.now()): SessionRequest {
	const server = trigger.source.kind === "mcp" ? trigger.source.serverName : trigger.source.subkind;
	const ownPrefix = `mcp:${server}:`;
	const key = trigger.idempotencyKey.startsWith(ownPrefix) ? trigger.idempotencyKey.slice(ownPrefix.length) : trigger.idempotencyKey;
	return turnRow(trigger.traceId, `push:${server}`, prompt, to, `push:${server}:${key}`, now);
}

/**
 * The id of a goal's continuation: `goal-` plus 32 hex of a hash of the goal's condition, the
 * iteration the continuation is and the stamp of the decision that asked for it. Derived, so the
 * same continuation written twice is one row; the stamp keeps a goal set again with the same
 * condition from finding its predecessor's `[Trigger goal-…]` in the conversation and never running.
 */
export function goalRunId(goal: { condition: string; iterations: number; updatedAt: string }): string {
	return `goal-${createHash("sha256").update(`${goal.condition}|${goal.iterations}|${goal.updatedAt}`).digest("hex").slice(0, 32)}`;
}

/** A `/goal` continuation as the row its session runs as a turn: attended, the person's own goal (design O3). */
export function goalRow(prompt: string, goal: { condition: string; iterations: number; updatedAt: string }, to: RowAddress, now = Date.now()): SessionRequest {
	const id = goalRunId(goal);
	return turnRow(id, "goal", `[Trigger ${id}] ${prompt}`, to, "goal", now);
}

/** `/inbox claim`: the finding as the turn that addresses it. A fresh id per claim; one queued hand-off per finding. */
export function inboxClaimRow(prompt: string, entryId: string, to: RowAddress, now = Date.now()): SessionRequest {
	const id = newId("claim");
	return turnRow(id, `inbox:${entryId}`, `[Trigger ${id}] ${prompt}`, to, `inbox:${entryId}`, now);
}

/** What a recipe hands to the chat: the tracker description `/recipe add` needs, or a merge conflict `/recipe update` left. */
export type RecipeHandOff = "tracker" | "merge";

/**
 * A recipe's hand-off to the chat: one queued at a time per recipe and per kind, so a merge conflict
 * is not swallowed by the tracker description still waiting, which says nothing about it.
 */
export function recipeRow(prompt: string, recipe: string, kind: RecipeHandOff, to: RowAddress, now = Date.now()): SessionRequest {
	const id = newId("recipe");
	return turnRow(id, `recipe:${recipe}`, `[Trigger ${id}] ${prompt}`, to, `recipe:${recipe}:${kind}`, now);
}

/** `/new-trigger <request>`: the turn that turns the request into a rule. Every one is its own. */
export function newTriggerRow(prompt: string, to: RowAddress, now = Date.now()): SessionRequest {
	const id = newId("nt");
	return turnRow(id, "new-trigger", `[Trigger ${id}] ${prompt}`, to, undefined, now);
}

/**
 * What the person typed into the browser page (design §5): a turn in their own words, with no
 * `[Trigger]` prefix, so the text itself is the proof of delivery (`landed`). The id is the page's
 * UUID for that send, so a retried send is one message. `created_by` is the page's web.mjs: the row
 * is sent only while that process lives (`decideDrain`), and offered by the next page otherwise.
 */
export function personRow(id: string, text: string, images: ImageContent[] | undefined, to: RowAddress, now = Date.now()): SessionRequest {
	return {
		v: 2,
		id,
		session_id: to.sessionId,
		kind: "input",
		source: "person",
		mode: modeOf("input", "person", "turn"),
		wake: "turn",
		payload: { text, ...(images?.length ? { images } : {}), cwd: to.cwd },
		created_at: stamp(now),
		created_by: to.createdBy,
		attempts: 0,
	};
}

/**
 * What a produced row said that decides its cap, as a hex digest: a change to any of it in the file
 * is not the producer's. The text, the images (type and bytes: a swapped image is another message),
 * the declared tools. The page sends it with `/pi-loops ring <id> <fingerprint>` over pi's rpc
 * stdin, a channel no model tool can write to, so the window believes the row's attended mode only
 * when the row in the file still has this fingerprint (`ringProduced`).
 */
export function requestFingerprint(row: SessionRequest): string {
	const images = row.payload?.images?.map((image) => [image.mimeType, image.data]) ?? null;
	return createHash("sha256").update(JSON.stringify([row.kind, row.source, row.wake ?? null, row.payload?.text ?? "", images, row.payload?.tools ?? null, row.payload?.builtin_tools ?? null])).digest("hex").slice(0, 32);
}

/**
 * `/pi-loops ring <id> <fingerprint>`: the queued row with that id is recorded as produced by this
 * window (`produced`) only when the row now in the file has exactly that fingerprint. Returns whether
 * it was; a ring for a row that is gone, or that says something else now, records nothing.
 */
export function ringProduced(rows: readonly SessionRequest[], id: string, fingerprint: string, produced: (row: SessionRequest) => void): boolean {
	const row = rows.find((r) => r.id === id);
	if (!row || requestFingerprint(row) !== fingerprint) return false;
	produced(row);
	return true;
}

/**
 * `pi-loops abort` (`cli`) or `/triggers abort` (`window`): stop the turn `target` names, in whichever
 * process holds the conversation. A row, so it outlives a socket that does not answer; no payload,
 * the target is the whole request. `{id}` names a row's turn; `{current, started_before}` names the
 * turn running when the stop was asked for, so a late one never stops the next turn.
 */
export function stopRow(sessionId: string, target: NonNullable<SessionRequest["target"]>, source: "cli" | "window", createdBy: SessionRequest["created_by"], now = Date.now()): SessionRequest {
	return { v: 2, id: newId("stop"), session_id: sessionId, kind: "stop", source, mode: modeOf("stop", source), target, created_at: stamp(now), created_by: createdBy, attempts: 0 };
}

/** Take a queued row out before it runs. One pi already holds is not cancelled: a stop aborts it as it starts. */
export function cancelRow(sessionId: string, target: { id: string }, source: SessionRequest["source"], createdBy: SessionRequest["created_by"], now = Date.now()): SessionRequest {
	return { v: 2, id: newId("cancel"), session_id: sessionId, kind: "cancel", source, mode: modeOf("cancel", source), target, created_at: stamp(now), created_by: createdBy, attempts: 0 };
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
function typedInWindow(source: SessionRequest["source"]): boolean {
	return source.startsWith("inbox:") || source.startsWith("recipe:") || source === "new-trigger";
}

/**
 * The sources a person types themselves, in the window the row is for or in the browser page: the
 * hold after a stopped run waits for the person's next input, and one of these is that input; among
 * the turn rows, these take the lane first, as the person's own message would. `/cron run` is typed
 * too: pi fires no `input` event for an extension command, so the row is what says the person acted.
 */
export function typedByPerson(source: SessionRequest["source"]): boolean {
	return source === "person" || source.startsWith("cron-run:") || typedInWindow(source);
}

/**
 * A row that runs in the process that produced it, whatever that process holds: what the person
 * typed into the window (`typedInWindow`) and a goal's continuation. Their turn belongs in the window
 * the person is looking at, and the goal's state is that window's; another executor runs one only
 * once its producer is gone. The background process never does (src/host-runtime.ts admits no
 * attended row). A `person` row is not local: its producer is the page's web.mjs, which runs nothing;
 * the holder runs it (design §5, O2).
 */
export function isLocal(row: SessionRequest): boolean {
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
export function dropContinuations(store: RequestStore, sessionId: string, self: Producer, alive: (row: SessionRequest) => boolean): string[] {
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
export function releaseLocalRows(store: RequestStore, sessionId: string, self: Producer, deliveredHere: (id: string) => boolean, now = Date.now()): string[] {
	const mine = store.list(sessionId).filter((row) => isLocal(row) && row.created_by.left === undefined && sameProducer(row.created_by, self));
	const ran = mine.filter((row) => deliveredHere(row.id));
	if (ran.length) store.remove(sessionId, ran.map((row) => row.id));
	const left = mine.filter((row) => !deliveredHere(row.id));
	for (const row of left) store.update(sessionId, row.id, { created_by: { ...row.created_by, left: stamp(now) } });
	return left.map((row) => row.id);
}

/**
 * Queue `row` unless a row with its id, or with its collapse key, is already queued: collapse, never
 * replay (docs/design.md decision 6). A queued row whose proof `delivered` already finds in the
 * conversation is done, not queued: the goal's next continuation is written while the last one is
 * still in the file, waiting for the drain that removes it. Returns whether it was written.
 */
export function enqueue(store: RequestStore, row: SessionRequest, delivered: (id: string) => boolean = () => false): boolean {
	return store.appendIfAbsent(row, { collapse: true, done: (queued) => delivered(queued.id) });
}

/** Where a producer's hand-over went, for the trigger audit: not written at all, in the chat already, or waiting in the file. */
export function handOverTarget(written: boolean, result: Pick<DrainResult, "delivered"> | undefined, id: string): "collapsed" | "chat" | "queued" {
	if (!written) return "collapsed";
	return result?.delivered.includes(id) ? "chat" : "queued";
}

export const queuedTriggeredTurn = (runId: string): string => `queued triggered turn (trace ${runId.slice(0, 8)}) after the current one`;

/**
 * What the window says when a row it just produced was not handed over at once (pi busy, or the
 * hold after a stop): a push keeps the line it had, what the person typed gets a plain one, and a
 * goal continuation says nothing more than its own notice did.
 */
export function waitingLine(source: SessionRequest["source"], id: string): string | undefined {
	if (source.startsWith("push:")) return queuedTriggeredTurn(id);
	if (typedByPerson(source)) return "queued: runs after the current turn";
	return undefined;
}

/** What a window's hand-over needs: its store, whether a row's proof is in its conversation, its executor's `produced`, and its drain. */
export interface HandOverDeps {
	store: RequestStore;
	delivered(id: string): boolean;
	produced(row: SessionRequest): void;
	drain(): Promise<DrainResult | undefined>;
}

export interface HandOverOutcome {
	/** False: a row with its id or its collapse key was already queued. */
	written: boolean;
	result: DrainResult | undefined;
	/** The line to show when the row was written and waits. */
	line?: string;
}

/**
 * A prompt one of a window's sources has for the chat: queued as a row (collapsed when one with its
 * key is already there), then delivered now when pi is idle; otherwise it waits in the file for the
 * tick, the bell or `agent_settled`, and `line` says so once. For `/inbox claim`, the hand-off is
 * queued first and the finding marked claimed after: a crash between the two leaves the finding
 * `new` with its hand-off queued, where the reverse order left it claimed with nobody told.
 */
export async function handOver(deps: HandOverDeps, row: SessionRequest, claim?: { inbox: Pick<Inbox, "setStatus">; entryId: string }): Promise<HandOverOutcome> {
	const written = enqueue(deps.store, row, deps.delivered);
	if (claim) await claim.inbox.setStatus(claim.entryId, "claimed", row.session_id);
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

export type PromotionTarget = { to: "row"; sessionId: string } | { to: "inbox"; sessionId?: string };

/**
 * Where a rule's result goes, decided the same way by a window and by the background process: a row
 * for the conversation that created the rule, or the inbox, marked for that conversation, when no
 * row could reach it. A rule made from a shell has no creating conversation: a window takes it into
 * its own chat when the rule is for this project; the background process files it in the inbox.
 */
export function promotionTarget(forSession: string | undefined, here: { sessionId?: string; inProject: boolean; isHost: boolean }, view: { legacyOpen(sessionId: string): boolean; known(sessionId: string): boolean }): PromotionTarget {
	const target = forSession ?? (here.isHost || !here.inProject ? undefined : here.sessionId);
	if (!target) return { to: "inbox" };
	// A pi-loops 0.22 window has it open, and never reads requests/.
	if (view.legacyOpen(target)) return { to: "inbox", sessionId: target };
	// pi-loops never saw its file, or the file is gone: nothing could ever take the row.
	if (target !== here.sessionId && !view.known(target)) return { to: "inbox", sessionId: target };
	return { to: "row", sessionId: target };
}

/** What a row's proof of delivery is read from: the conversation, as `landed` asks it. */
export interface ConversationView {
	/** Whether `[Trigger <id>] ` is in it (`conversationHas`). */
	has(id: string): boolean;
	/** How many user messages whose text is `text`'s (`personTextMatches`) it holds, written at or after `since` (`conversationPersonEntries`). */
	personEntries(text: string, since: string): number;
}

/**
 * Whether `row`'s delivery is in the conversation (design §2.2). A pi-loops row carries its proof in
 * its text: `[Trigger <id>] `. A person row's proof is a user message whose text starts with the
 * row's (pi appends a note to the text when it resizes or converts an image), written at or after
 * `handed_at`, the stamp the holder puts on the row just before each hand-over. One lane hands over
 * one row at a time, so an earlier message with the same words, or another row's, is older than the
 * stamp and proves nothing; a row never handed over has no stamp and is never done.
 */
export function landed(row: SessionRequest, conversation: ConversationView): boolean {
	if (row.source !== "person") return conversation.has(row.id);
	return row.handed_at !== undefined && conversation.personEntries(row.payload?.text ?? "", row.handed_at) > 0;
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
 */
export function personTextMatches(messageText: string, rowText: string): boolean {
	return rowText === "" ? stripImageNotes(messageText) === "" : messageText.startsWith(rowText);
}

const textOf = (content: unknown): string | undefined => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const first = content.find((part) => !!part && typeof part === "object" && (part as { type?: unknown }).type === "text");
	return first && typeof (first as { text?: unknown }).text === "string" ? (first as { text: string }).text : undefined;
};

/** The user messages among `entries` whose text starts with `text`, written at or after `since` (pi's `timestamp` on the entry). */
export function conversationPersonEntries(entries: readonly unknown[], text: string, since: string): number {
	const floor = Date.parse(since);
	return entries.filter((entry) => {
		if (!entry || typeof entry !== "object") return false;
		const value = entry as { type?: unknown; timestamp?: unknown; message?: { role?: unknown; content?: unknown } };
		if (value.type !== "message" || value.message?.role !== "user" || !personTextMatches(textOf(value.message.content) ?? "", text)) return false;
		const at = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
		return Number.isNaN(at) ? false : at >= floor;
	}).length;
}

/** `conversationHas` and `conversationPersonEntries` over one list of entries. */
export function conversationView(entries: () => readonly unknown[]): ConversationView {
	return { has: (id) => conversationHas(entries(), id), personEntries: (text, since) => conversationPersonEntries(entries(), text, since) };
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
	 * This executor's own reasons to leave a row for later, its mode apart (that is `ceiling`, and the
	 * engine recomputes the mode itself): the background process takes nothing while a held turn has
	 * the conversation's file, and no turn row until held turns ride rows.
	 */
	admits(row: SessionRequest): boolean;
	/** window: `ctx.isIdle()`; the background process writes into a conversation nobody has open. */
	idle: boolean;
	/** The hold after an aborted run: pi-loops `turn` rows wait until it passes, or the person's next input. */
	heldUntil?: number;
	/**
	 * When the hold after an aborted run began, for the person's own rows: one created or released
	 * (`released_at`, written by "send queued") after it is not held; the rest wait until the person
	 * acts in the window (`personInput`) or a row of theirs is rung for, never on a clock.
	 */
	personHeldSince?: number;
	running?: { requestId?: string; startedAt: string };
	/** Handed to pi and not yet in the conversation: the derived claims. */
	inFlight: ReadonlySet<string>;
	/** Rows a stop named that pi then dropped unstarted (Esc): removed as cancelled, never offered again. */
	stopped?: ReadonlySet<string>;
	/** Rows whose turn ran under a message that lost their prefix: done, though the file cannot prove it. */
	ran?: ReadonlySet<string>;
	/**
	 * When each turn row in `inFlight` was handed to pi, for the ones pi has started no run since
	 * (`agent_start` clears them; an `input` or `message_start` seen meanwhile restarts the count).
	 * One still here while pi is idle `PERSON_SEND_GRACE_MS` later was refused: pi's `prompt()` throws
	 * before any run starts (compaction in progress, no model, no credentials), and an extension hears
	 * nothing of it.
	 */
	inFlightSince?: ReadonlyMap<string, number>;
	/**
	 * Rows pi was handed and had dropped unwritten when it settled (Esc clears its queues; an `input`
	 * handler that rewrote the prefix away). Offered again, with an attempt counted: without the
	 * count, a prompt an extension rewrites on every turn would run for ever.
	 */
	dropped?: ReadonlySet<string>;
	/**
	 * Whether this executor was rung for the row (`/pi-loops ring <id> <fingerprint>`) and the row
	 * still says what the ring said: its attended mode is believed. A fresh person row nobody rang for
	 * yet waits `PERSON_RING_WAIT_MS`, so the bell wins the race with the file watcher.
	 */
	believed?(row: SessionRequest): boolean;
	connected(server: string): boolean;
	/** Whether the process that wrote the row is still there: a local row waits for it, a person row is sent only for it. */
	producerAlive(row: SessionRequest): boolean;
	/** This executor is the row's producer, bound to its session: the one that runs a local row while it lives. */
	mine(row: SessionRequest): boolean;
}

export type Action =
	| { do: "append"; row: SessionRequest; wakeAgent: boolean }
	| { do: "turn"; row: SessionRequest }
	| { do: "abort"; stop: SessionRequest }
	| { do: "abortWhenStarted"; stop: SessionRequest; target: string }
	| { do: "remove"; row: SessionRequest; why: "done" | "cancelled" | "stale" | "job-removed" | "refused" }
	| { do: "dead"; row: SessionRequest; why: string }
	/**
	 * pi did not write the row it was handed. An attempt is counted; at `DEAD_AFTER_ATTEMPTS` a pi-loops
	 * row is a dead letter. `retry` says when it is offered again: `never` for a person row (the page
	 * takes it back: a retry that did land would answer one prompt twice), `backoff` for a hand-over
	 * pi refused, `now` for one pi dropped (Esc), which the hold after a stop already paces.
	 */
	| { do: "fail"; row: SessionRequest; why: string; retry: "never" | "backoff" | "now" }
	/** `until`: when the wait ends on its own (the ring wait), for a drain to be scheduled then. */
	| { do: "wait"; row: SessionRequest; why: string; until?: number };

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
 * check failed a send pi then ran. The name stays: src/web.mjs reads it for its follow-up ring.
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
	return actions.some((a) => a.do === "append" || a.do === "turn" || a.do === "remove" || a.do === "dead" || a.do === "fail");
}

/**
 * The input rows of a session in the order the engine offers them, which is the order the page
 * lists them: file order, except that among the turn rows what the person typed takes the lane
 * before what the clock or a server queued, as their own message would; `append` rows keep their
 * place, so a result queued before the claim lands before it.
 */
export function queueOrder(rows: readonly SessionRequest[]): SessionRequest[] {
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
 * is running stays in the file while it runs and is not queued: the job's `running` marker names
 * it, and the listing already shows that. The reason is read from the row alone, so a listing costs
 * one file read per conversation and no executor view.
 */
export function queuedPrompt(job: Pick<LoopJob, "id" | "running">, rows: readonly SessionRequest[], now: number): QueuedPrompt | undefined {
	// Only a row the engine would run for this job: its own prefix, its source's mode, not dead. A row
	// written into the file under a job's name is not that job's prompt, and the listing must not say so.
	const row = rows.find((r) => r.kind === "input" && jobOf(r.source) === job.id && r.id !== job.running?.runId && r.payload?.text.startsWith(`[Trigger ${r.id}] `) && modeOf(r.kind, r.source, r.wake) === r.mode && r.attempts < DEAD_AFTER_ATTEMPTS);
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
 * Pure. Stops and cancels first, idle or busy; then the inputs, oldest first, one lane: a row in
 * backoff, waiting for a server, handed over, above this executor's ceiling or not admitted here is
 * skipped and blocks nothing; one whose mode is not its source's is refused and removed.
 * `append` rows land at once while idle, with no turn; during a turn they go as a follow-up, which
 * wakes the agent when it ends (docs/design.md decision 9). A `turn` row is handed over only while
 * pi is idle and the lane is free, one per drain. Among the turn rows, what the person typed takes
 * the lane before what the clock or a server queued, as their own message would; `append` rows keep
 * their place, so a result queued before the claim lands before it. A local row (`isLocal`) is run by its
 * producer while that process lives; every other executor skips it, judges nothing about it and
 * counts no attempt.
 */
export function decideDrain(rows: readonly SessionRequest[], entries: ConversationView, jobs: JobsView, view: ExecutorView, now: number, opts: DrainOptions = {}): Action[] {
	const actions: Action[] = [];
	const queued = new Map(rows.filter((row) => row.kind === "input").map((row) => [row.id, row]));
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
			} else if (queued.has(target.id) && !view.inFlight.has(target.id) && !cancelled.has(target.id)) {
				cancelled.add(target.id);
				actions.push({ do: "remove", row: queued.get(target.id)!, why: "cancelled" });
				done = true;
			}
		} else if (target && row.kind === "stop" && view.running && Date.parse(view.running.startedAt) < Date.parse(target.started_before)) {
			// As times: each stamp carries its writer's offset, and two offsets do not order as strings.
			actions.push({ do: "abort", stop: row });
			done = true;
		}
		actions.push({ do: "remove", row, why: done ? "done" : "stale" });
	}
	let laneTaken = false;
	for (const row of inputs) {
		if (cancelled.has(row.id)) continue;
		if (landed(row, entries)) {
			actions.push({ do: "remove", row, why: "done" });
			continue;
		}
		if (view.stopped?.has(row.id)) {
			actions.push({ do: "remove", row, why: "cancelled" });
			continue;
		}
		if (view.ran?.has(row.id)) {
			actions.push({ do: "remove", row, why: "done" });
			continue;
		}
		const wait = (why: string, until?: number) => actions.push({ do: "wait", row, why, ...(until === undefined ? {} : { until }) });
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
				continue;
			}
			if (refused) {
				actions.push({ do: "fail", row, why: "pi did not start a turn for it", retry: "never" });
				continue;
			}
		} else if (refused) {
			// A pi-loops row is proved by its prefix, so offering it again is safe; one refusal must not
			// hold the slot for ever, nor the job's later slots, which collapse onto a queued row.
			actions.push({ do: "fail", row, why: "pi did not start a turn for it", retry: "backoff" });
			continue;
		}
		// A person row pi dropped is offered again uncounted: a Stop put it back, and the hold on the
		// person's rows (`personHeldSince`) is what paces it.
		if (row.source !== "person" && view.dropped?.has(row.id)) {
			actions.push({ do: "fail", row, why: "pi dropped it before it was written", retry: "now" });
			// The attempt that buries it: nothing below may hand it over as well.
			if (row.attempts + 1 >= DEAD_AFTER_ATTEMPTS) continue;
		}
		if (row.attempts >= DEAD_AFTER_ATTEMPTS) {
			actions.push({ do: "dead", row, why: `failed ${row.attempts} times${row.last_error ? `: ${row.last_error}` : ""}` });
			continue;
		}
		// A person's message may be an image alone; everything else is text.
		if (!row.payload?.text && !(row.source === "person" && row.payload?.images?.length)) {
			actions.push({ do: "dead", row, why: "an input row without text" });
			continue;
		}
		// The prefix is the proof of delivery: a pi-loops row without it would be written again on
		// every drain, with nothing to tell that it landed.
		if (row.source !== "person" && !row.payload?.text.startsWith(`[Trigger ${row.id}] `)) {
			actions.push({ do: "dead", row, why: "an input row without its [Trigger <id>] prefix" });
			continue;
		}
		// The producer wrote the mode; the executor runs the row under the one its source gets, and
		// nothing else. A line edited in the file, or written by another version, cannot widen what
		// the turn may do: it is refused, and the audit says so.
		if (modeOf(row.kind, row.source, row.wake) !== row.mode) {
			actions.push({ do: "remove", row, why: "refused" });
			continue;
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
				continue;
			}
			if (!job.exists) {
				actions.push({ do: "remove", row, why: "job-removed" });
				continue;
			}
			// The clock's prompt waits with its clock; `/cron run` was asked for, and `/cron run` itself
			// refuses a job that is disabled when it is typed.
			if (!job.enabled && row.source.startsWith("cron:")) {
				wait("its job is disabled");
				continue;
			}
		}
		if (isLocal(row) && !view.mine(row) && view.producerAlive(row)) {
			wait("runs in the window that produced it");
			continue;
		}
		// Judged by the executor that runs the row: the goal is that process's state.
		if (row.source === "goal" && !jobs.goalActive(row.session_id)) {
			actions.push({ do: "remove", row, why: "stale" });
			continue;
		}
		if (!view.ceiling(row.mode)) {
			wait(`${row.mode} rows wait for a window`);
			continue;
		}
		if (!view.admits(row)) {
			wait("not admitted by this executor");
			continue;
		}
		if (row.not_before !== undefined && Date.parse(row.not_before) > now) {
			wait(`backing off until ${row.not_before}`);
			continue;
		}
		if (view.inFlight.has(row.id)) {
			// A person's turn pi holds and has not written is the lane's: handed over too, a second row
			// with the same words would be proved by the first one's message. A pi-loops row is proved by
			// its own prefix, and one pi silently dropped must not stall the rows behind it.
			if (row.wake === "turn" && row.source === "person") laneTaken = true;
			wait("handed to pi, not yet in the conversation");
			continue;
		}
		// A person's message is sent only for the page that wrote it (design §5); every other row
		// outlives its producer, and a local one is the holder's to run once the producer is gone.
		if (row.source === "person" && !view.producerAlive(row)) {
			wait("its producer is gone");
			continue;
		}
		if (row.source === "person" && view.believed && !view.believed(row) && now - Date.parse(row.created_at) < PERSON_RING_WAIT_MS) {
			wait("waiting for the page's ring", Date.parse(row.created_at) + PERSON_RING_WAIT_MS);
			continue;
		}
		const missing = row.payload?.requires?.find((server) => !view.connected(server));
		if (missing !== undefined) {
			wait(`waiting for mcp server ${missing}`);
			continue;
		}
		const idle = view.idle && !laneTaken;
		if (row.wake !== "turn") {
			actions.push({ do: "append", row, wakeAgent: !idle });
			continue;
		}
		if (!idle) {
			wait("pi is busy");
			continue;
		}
		const personHeld = view.personHeldSince !== undefined && Date.parse(row.released_at ?? row.created_at) <= view.personHeldSince;
		if (row.source === "person" ? personHeld : view.heldUntil !== undefined && now < view.heldUntil) {
			wait(row.source === "person" ? "held after a stop: waiting for you" : "held after a stop");
			continue;
		}
		laneTaken = true;
		actions.push({ do: "turn", row });
	}
	return actions;
}

export interface Executor {
	/** Read from disk each call: the conversation can be taken while a drain runs. A non-holder still drains the local rows it produced (`ExecutorView.mine`). */
	holds(sessionId: string): boolean;
	view(sessionId: string): ExecutorView;
	entries(sessionId: string): ConversationView;
	/** Hand a turn row to pi; `now` is when, for `ExecutorView.inFlightSince`. */
	turn(row: SessionRequest, now: number): void;
	append(row: SessionRequest, wakeAgent: boolean): void;
	/** Stop the turn running now. */
	abort(): void;
	/** Stop the turn of row `id`, handed to pi and not started yet, as it starts. */
	abortWhenStarted(id: string): void;
	/** pi refused row `id` (a `fail` action): it is no longer in flight. */
	refused(id: string): void;
}

/** Where the engine records what it did: the jobs it checks rows against, the inbox for dead letters, the audit. */
export interface EngineSinks {
	jobs: JobsView;
	inbox: Pick<Inbox, "append">;
	audit: Pick<TriggerStore, "appendAudit">;
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
async function deadLetter(store: RequestStore, sinks: EngineSinks, sessionId: string, row: SessionRequest, why: string): Promise<void> {
	const text = stripPrefix(row.payload?.text ?? "");
	const cwd = row.payload?.cwd ?? "";
	// A rule's result keeps the finding it always had in the inbox (`trigger:<label>`): the
	// since-you-looked count and `/inbox open` tell results from runs by that source.
	const rule = row.source.startsWith("rule:") ? row.source.slice("rule:".length) : undefined;
	await sinks.inbox.append(rule !== undefined ? { source: `trigger:${rule}`, run_id: row.id, job_id: rule, cwd, text: text || `rule result ${row.id}`, session_id: sessionId } : { source: row.source, run_id: row.id, cwd, text: text.slice(0, DEAD_LETTER_CHARS) || `${row.kind} request ${row.id}`, session_id: sessionId });
	sinks.audit.appendAudit({ cwd, type: "request", traceId: row.id, state: "dead", sourceLabel: row.source, eventLabel: row.session_id, summary: text, details: { session_id: row.session_id, kind: row.kind, attempts: row.attempts, last_error: row.last_error, reason: why } });
	store.remove(sessionId, [row.id]);
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
	// still runs what the person typed into it and its own goal's continuations, and nothing else.
	const own = (row: SessionRequest) => isLocal(row) && view.mine(row);
	const may = (row?: SessionRequest) => executor.holds(sessionId) || (!!row && own(row));
	const rows = may() ? store.list(sessionId) : store.list(sessionId).filter(own);
	if (!rows.length) return out;
	const actions = decideDrain(rows, executor.entries(sessionId), sinks.jobs, view, now, opts);
	/**
	 * One more failure of `row`: at `DEAD_AFTER_ATTEMPTS` a pi-loops row is a dead letter; a person row
	 * never is (design §5), it keeps its error for the page. Otherwise the count, the error and, when
	 * the retry backs off, when it may go again are written on the row, and the audit says `failed`.
	 */
	const failed = async (row: SessionRequest, why: string, retry: "never" | "backoff" | "now"): Promise<void> => {
		const attempts = row.attempts + 1;
		out.failed.push(row.id);
		if (row.source !== "person" && attempts >= DEAD_AFTER_ATTEMPTS) {
			await deadLetter(store, sinks, sessionId, { ...row, attempts, last_error: why }, `failed ${attempts} times: ${why}`);
			out.dead.push(row.id);
			return;
		}
		store.update(sessionId, row.id, { attempts, last_error: why, ...(retry === "backoff" ? { not_before: stamp(now + backoffFor(attempts)) } : {}) });
		sinks.audit.appendAudit({ cwd: row.payload?.cwd ?? "", type: "request", traceId: row.id, state: "failed", sourceLabel: row.source, eventLabel: row.session_id, details: { session_id: row.session_id, attempts, error: why } });
	};
	for (const action of actions) {
		// Before each one, not once: the conversation can be taken while this drains.
		if (!may("row" in action ? action.row : undefined)) break;
		switch (action.do) {
			case "wait":
				out.waiting.push(action.row.id);
				if (action.until !== undefined && (out.retryAt === undefined || action.until < out.retryAt)) out.retryAt = action.until;
				break;
			case "remove":
				// A done input row's record is the session file; everything else ends in the audit.
				if (action.why !== "done" || action.row.kind !== "input") sinks.audit.appendAudit({ cwd: action.row.payload?.cwd ?? "", type: "request", traceId: action.row.id, state: action.why, sourceLabel: action.row.source, eventLabel: action.row.session_id, details: { session_id: action.row.session_id, kind: action.row.kind } });
				store.remove(sessionId, [action.row.id]);
				out.removed.push(action.row.id);
				break;
			case "dead":
				await deadLetter(store, sinks, sessionId, action.row, action.why);
				out.dead.push(action.row.id);
				break;
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
				if (executor.view(sessionId).inFlight.has(row.id) || landed(row, executor.entries(sessionId))) break;
				try {
					// The stamp first, under the lock: the proof of a person row's delivery is a user message
					// written at or after it. A crash between the two leaves a stamped row with no message,
					// handed over again with a new stamp; the reverse order could lose the proof of a send.
					if (action.do === "turn" && row.source === "person") store.update(sessionId, row.id, { handed_at: stamp(moment()) });
					if (action.do === "append") executor.append(row, action.wakeAgent);
					else executor.turn(row, now);
				} catch (err: any) {
					await failed(row, redact(err?.message ?? String(err)), "backoff");
					break;
				}
				out.delivered.push(row.id);
				// Written into the conversation already (an idle window, the background process): gone now.
				// Otherwise pi holds it as a follow-up and the next drain finds it in the file, or not.
				if (landed(row, executor.entries(sessionId))) {
					store.remove(sessionId, [row.id]);
					out.removed.push(row.id);
				}
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
export async function bury(sessionId: string, store: RequestStore, sinks: EngineSinks, why: string): Promise<string[]> {
	const ids: string[] = [];
	for (const row of store.list(sessionId)) {
		if (row.kind === "input" && row.source !== "person") await deadLetter(store, sinks, sessionId, row, why);
		else {
			sinks.audit.appendAudit({ cwd: "", type: "request", traceId: row.id, state: "stale", sourceLabel: row.source, eventLabel: row.session_id, details: { session_id: row.session_id, kind: row.kind, reason: why } });
			store.remove(sessionId, [row.id]);
		}
		ids.push(row.id);
	}
	return ids;
}
