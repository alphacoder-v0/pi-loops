/**
 * The one engine that delivers a session's requests (src/requests.ts). `decideDrain` is pure: the
 * rows, what the conversation already holds, the jobs and the executor's view in, the actions out.
 * `drain` applies them through an executor: the window that holds the conversation
 * (src/window-executor.ts), or the background process for a closed one (src/host-runtime.ts).
 *
 * Delivery is at least once; `[Trigger <id>] ` already in the conversation is what makes a second
 * delivery a no-op, and a row leaves the file only once that proof is in the file. A row that fails
 * waits out a backoff and blocks nothing behind it; at three failures it is a dead letter: an inbox
 * finding first, then an audit line, then the removal, so a crash in between loses no row.
 */
import type { Inbox } from "./inbox.ts";
import { redact } from "./redact.ts";
import { type RequestMode, type RequestStore, type SessionRequest } from "./requests.ts";
import { stamp } from "./schedule.ts";
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
	connected(server: string): boolean;
	/** Person rows: the page that wrote it must still be alive. */
	producerAlive(row: SessionRequest): boolean;
}

export type Action =
	| { do: "append"; row: SessionRequest; wakeAgent: boolean }
	| { do: "turn"; row: SessionRequest }
	| { do: "abort"; stop: SessionRequest }
	| { do: "abortWhenStarted"; stop: SessionRequest; target: string }
	| { do: "remove"; row: SessionRequest; why: "done" | "cancelled" | "stale" | "job-removed" }
	| { do: "dead"; row: SessionRequest; why: string }
	| { do: "wait"; row: SessionRequest; why: string };

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
 * pi is idle and the lane is free, one per drain.
 */
export function decideDrain(rows: readonly SessionRequest[], entries: { has(id: string): boolean }, jobs: JobsView, view: ExecutorView, now: number): Action[] {
	const actions: Action[] = [];
	const queued = new Map(rows.filter((row) => row.kind === "input").map((row) => [row.id, row]));
	const cancelled = new Set<string>();
	for (const row of rows) {
		if (row.kind === "input") continue;
		let done = false;
		const target = row.target;
		if (target && "id" in target) {
			if (row.kind === "stop" && view.running?.requestId === target.id) {
				actions.push({ do: "abort", stop: row });
				done = true;
			} else if (queued.has(target.id) && !cancelled.has(target.id)) {
				cancelled.add(target.id);
				actions.push({ do: "remove", row: queued.get(target.id)!, why: "cancelled" });
				done = true;
			}
		} else if (target && row.kind === "stop" && view.running && view.running.startedAt < target.started_before) {
			actions.push({ do: "abort", stop: row });
			done = true;
		}
		actions.push({ do: "remove", row, why: done ? "done" : "stale" });
	}
	let laneTaken = false;
	for (const row of rows) {
		if (row.kind !== "input" || cancelled.has(row.id)) continue;
		if (entries.has(row.id)) {
			actions.push({ do: "remove", row, why: "done" });
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
		if (row.source === "goal" && !jobs.goalActive(row.session_id)) {
			actions.push({ do: "remove", row, why: "stale" });
			continue;
		}
		const wait = (why: string) => actions.push({ do: "wait", row, why });
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
		if (!view.producerAlive(row)) {
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
	/** Read from disk each call: the conversation can be taken while a drain runs. */
	holds(sessionId: string): boolean;
	view(sessionId: string): ExecutorView;
	entries(sessionId: string): { has(id: string): boolean };
	turn(row: SessionRequest): void;
	append(row: SessionRequest, wakeAgent: boolean): void;
	abort(): void;
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
 * Deliver what is queued for `sessionId` through `executor`, if it holds the conversation: read the
 * rows, decide, then apply each action, asking `holds()` again before each one.
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
	if (!executor.holds(sessionId)) return out;
	const rows = store.list(sessionId);
	if (!rows.length) return out;
	const actions = decideDrain(rows, executor.entries(sessionId), sinks.jobs, executor.view(sessionId), now);
	for (const action of actions) {
		// Before each one, not once: the conversation can be taken while this drains.
		if (!executor.holds(sessionId)) break;
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
 * Every row of a session that can never take them (its file is gone) becomes a dead letter, each in
 * the same order as a failed row: the finding, the audit line, the removal.
 */
export async function bury(sessionId: string, store: RequestStore, sinks: EngineSinks, why: string): Promise<string[]> {
	const ids: string[] = [];
	for (const row of store.list(sessionId)) {
		await deadLetter(store, sinks, sessionId, row, why);
		ids.push(row.id);
	}
	return ids;
}
