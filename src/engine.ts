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
import { type RequestMode, type RequestStore, type SessionRequest } from "./requests.ts";
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

/** A recipe's hand-off to the chat (the tracker description, a merge conflict): one queued at a time per recipe. */
export function recipeRow(prompt: string, recipe: string, to: RowAddress, now = Date.now()): SessionRequest {
	const id = newId("recipe");
	return turnRow(id, `recipe:${recipe}`, `[Trigger ${id}] ${prompt}`, to, `recipe:${recipe}`, now);
}

/** `/new-trigger <request>`: the turn that turns the request into a rule. Every one is its own. */
export function newTriggerRow(prompt: string, to: RowAddress, now = Date.now()): SessionRequest {
	const id = newId("nt");
	return turnRow(id, "new-trigger", `[Trigger ${id}] ${prompt}`, to, undefined, now);
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

/**
 * The sources a person types themselves, in the window the row is for: the hold after a stopped run
 * waits for the person's next input, and one of these is that input.
 */
export function typedByPerson(source: SessionRequest["source"]): boolean {
	return source.startsWith("inbox:") || source.startsWith("recipe:") || source === "new-trigger";
}

/**
 * A row that runs in the process that produced it, whatever that process holds: what the person
 * typed (`typedByPerson`) and a goal's continuation. Their turn belongs in the window the person is
 * looking at, and the goal's state is that window's; another executor runs one only once its
 * producer is gone. The background process never does (src/host-runtime.ts admits no attended row).
 */
export function isLocal(row: SessionRequest): boolean {
	return row.kind === "input" && (typedByPerson(row.source) || row.source === "goal");
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

/** Whether `[Trigger <id>] ` is in the conversation: a user message or a custom message that starts with it. */
export function conversationHas(entries: readonly unknown[], id: string): boolean {
	const prefix = `[Trigger ${id}] `;
	const textOf = (content: unknown): string | undefined => {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return undefined;
		const first = content.find((part) => !!part && typeof part === "object" && (part as { type?: unknown }).type === "text");
		return first && typeof (first as { text?: unknown }).text === "string" ? (first as { text: string }).text : undefined;
	};
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

export interface ExecutorView {
	kind: "window" | "held";
	/** modeOf recomputed, this executor's ceiling applied: a window admits every mode, the background process no attended row. */
	admits(row: SessionRequest): boolean;
	/** window: `ctx.isIdle()`; the background process writes into a conversation nobody has open. */
	idle: boolean;
	/** The hold after an aborted run: `turn` rows wait until it passes. */
	heldUntil?: number;
	running?: { requestId?: string; startedAt: string };
	/** Handed to pi and not yet in the conversation: the derived claims. */
	inFlight: ReadonlySet<string>;
	/** Rows a stop named that pi then dropped unstarted (Esc): removed as cancelled, never offered again. */
	stopped?: ReadonlySet<string>;
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
	| { do: "remove"; row: SessionRequest; why: "done" | "cancelled" | "stale" | "job-removed" }
	| { do: "dead"; row: SessionRequest; why: string }
	| { do: "wait"; row: SessionRequest; why: string };

/**
 * Whether applying `actions` writes anything: a row handed over, removed or buried. A drain that
 * only waits leaves the file, the conversation and the lease as they were, so a holder that must
 * take a lease to drain can see from this alone that there is nothing to take it for.
 */
export function changesSomething(actions: readonly Action[]): boolean {
	return actions.some((a) => a.do === "append" || a.do === "turn" || a.do === "remove" || a.do === "dead");
}

export interface JobsView {
	exists(id: string): boolean;
	/** Whether the session has a goal being pursued: a `goal` row without one is stale. */
	goalActive(sessionId: string): boolean;
}

const jobOf = (source: string): string | undefined => (source.startsWith("cron:") ? source.slice("cron:".length) : source.startsWith("cron-run:") ? source.slice("cron-run:".length) : undefined);

/**
 * Pure. Stops and cancels first, idle or busy; then the inputs, oldest first, one lane: a row in
 * backoff, waiting for a server, handed over or not admitted here is skipped and blocks nothing.
 * `append` rows land at once while idle, with no turn; during a turn they go as a follow-up, which
 * wakes the agent when it ends (docs/design.md decision 9). A `turn` row is handed over only while
 * pi is idle and the lane is free, one per drain. Among the turn rows, what the person typed takes
 * the lane before what the clock or a server queued, as their own message would; `append` rows keep
 * their place, so a result queued before the claim lands before it. A local row (`isLocal`) is run by its
 * producer while that process lives; every other executor skips it, judges nothing about it and
 * counts no attempt.
 */
export function decideDrain(rows: readonly SessionRequest[], entries: { has(id: string): boolean }, jobs: JobsView, view: ExecutorView, now: number): Action[] {
	const actions: Action[] = [];
	const queued = new Map(rows.filter((row) => row.kind === "input").map((row) => [row.id, row]));
	const turns = rows.filter((row) => row.kind === "input" && row.wake === "turn");
	const turnOrder = [...turns.filter((row) => typedByPerson(row.source)), ...turns.filter((row) => !typedByPerson(row.source))];
	const inputs = rows.filter((row) => row.kind === "input").map((row) => (row.wake === "turn" ? turnOrder.shift()! : row));
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
		if (entries.has(row.id)) {
			actions.push({ do: "remove", row, why: "done" });
			continue;
		}
		if (view.stopped?.has(row.id)) {
			actions.push({ do: "remove", row, why: "cancelled" });
			continue;
		}
		if (row.attempts >= DEAD_AFTER_ATTEMPTS) {
			actions.push({ do: "dead", row, why: `failed ${row.attempts} times${row.last_error ? `: ${row.last_error}` : ""}` });
			continue;
		}
		if (!row.payload?.text) {
			actions.push({ do: "dead", row, why: "an input row without text" });
			continue;
		}
		// The prefix is the proof of delivery: a pi-loops row without it would be written again on
		// every drain, with nothing to tell that it landed.
		if (row.source !== "person" && !row.payload.text.startsWith(`[Trigger ${row.id}] `)) {
			actions.push({ do: "dead", row, why: "an input row without its [Trigger <id>] prefix" });
			continue;
		}
		const jobId = jobOf(row.source);
		if (jobId !== undefined && !jobs.exists(jobId)) {
			actions.push({ do: "remove", row, why: "job-removed" });
			continue;
		}
		const wait = (why: string) => actions.push({ do: "wait", row, why });
		if (isLocal(row) && !view.mine(row) && view.producerAlive(row)) {
			wait("runs in the window that produced it");
			continue;
		}
		// Judged by the executor that runs the row: the goal is that process's state.
		if (row.source === "goal" && !jobs.goalActive(row.session_id)) {
			actions.push({ do: "remove", row, why: "stale" });
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
			wait("handed to pi, not yet in the conversation");
			continue;
		}
		// A person's message is sent only for the page that wrote it (design §5); every other row
		// outlives its producer, and a local one is the holder's to run once the producer is gone.
		if (row.source === "person" && !view.producerAlive(row)) {
			wait("its producer is gone");
			continue;
		}
		const missing = row.payload.requires?.find((server) => !view.connected(server));
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
		if (view.heldUntil !== undefined && now < view.heldUntil) {
			wait("held after a stop");
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
	entries(sessionId: string): { has(id: string): boolean };
	turn(row: SessionRequest): void;
	append(row: SessionRequest, wakeAgent: boolean): void;
	/** Stop the turn running now. */
	abort(): void;
	/** Stop the turn of row `id`, handed to pi and not started yet, as it starts. */
	abortWhenStarted(id: string): void;
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
export function drain(sessionId: string, store: RequestStore, executor: Executor, now: number, sinks: EngineSinks): Promise<DrainResult> {
	// One drain of a session at a time in this process: the tick, the bell and a promotion each start
	// one, and two that overlap would hand a row over, or write a dead letter, twice.
	const key = `${store.dir}\0${sessionId}`;
	const next = (draining.get(key) ?? Promise.resolve()).then(() => drainOnce(sessionId, store, executor, now, sinks));
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

async function drainOnce(sessionId: string, store: RequestStore, executor: Executor, now: number, sinks: EngineSinks): Promise<DrainResult> {
	const out: DrainResult = { delivered: [], removed: [], failed: [], dead: [], waiting: [] };
	const view = executor.view(sessionId);
	// A window that does not hold the conversation (a viewer, one standing aside, a `pi -p` run)
	// still runs what the person typed into it and its own goal's continuations, and nothing else.
	const own = (row: SessionRequest) => isLocal(row) && view.mine(row);
	const may = (row?: SessionRequest) => executor.holds(sessionId) || (!!row && own(row));
	const rows = may() ? store.list(sessionId) : store.list(sessionId).filter(own);
	if (!rows.length) return out;
	const actions = decideDrain(rows, executor.entries(sessionId), sinks.jobs, view, now);
	for (const action of actions) {
		// Before each one, not once: the conversation can be taken while this drains.
		if (!may("row" in action ? action.row : undefined)) break;
		switch (action.do) {
			case "wait":
				out.waiting.push(action.row.id);
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
			case "append":
			case "turn": {
				const row = action.row;
				// Drains overlap (the tick, the bell, a promotion), and one can hand a row over while this
				// one awaits a dead letter: ask again at the moment of handing it over.
				if (executor.view(sessionId).inFlight.has(row.id) || executor.entries(sessionId).has(row.id)) break;
				try {
					if (action.do === "append") executor.append(row, action.wakeAgent);
					else executor.turn(row);
				} catch (err: any) {
					const attempts = row.attempts + 1;
					const message = redact(err?.message ?? String(err));
					out.failed.push(row.id);
					if (attempts >= DEAD_AFTER_ATTEMPTS) {
						await deadLetter(store, sinks, sessionId, { ...row, attempts, last_error: message }, `failed ${attempts} times: ${message}`);
						out.dead.push(row.id);
						break;
					}
					store.update(sessionId, row.id, { attempts, last_error: message, not_before: stamp(now + backoffFor(attempts)) });
					sinks.audit.appendAudit({ cwd: row.payload?.cwd ?? "", type: "request", traceId: row.id, state: "failed", sourceLabel: row.source, eventLabel: row.session_id, details: { session_id: row.session_id, attempts, error: message } });
					break;
				}
				out.delivered.push(row.id);
				// Written into the conversation already (an idle window, the background process): gone now.
				// Otherwise pi holds it as a follow-up and the next drain finds it in the file, or not.
				if (executor.entries(sessionId).has(row.id)) {
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
 * Every row of a session that can never take them (its file is gone): an input becomes a dead
 * letter, in the same order as a failed row (the finding, the audit line, the removal); a stop or a
 * cancel has nothing to tell anyone, so it is audited `stale` and removed, with no finding.
 */
export async function bury(sessionId: string, store: RequestStore, sinks: EngineSinks, why: string): Promise<string[]> {
	const ids: string[] = [];
	for (const row of store.list(sessionId)) {
		if (row.kind === "input") await deadLetter(store, sinks, sessionId, row, why);
		else {
			sinks.audit.appendAudit({ cwd: "", type: "request", traceId: row.id, state: "stale", sourceLabel: row.source, eventLabel: row.session_id, details: { session_id: row.session_id, kind: row.kind, reason: why } });
			store.remove(sessionId, [row.id]);
		}
		ids.push(row.id);
	}
	return ids;
}
