import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmp } from "./tmp.ts";
import { Inbox, findingId } from "../src/inbox.ts";
import { TriggerStore } from "../src/triggers.ts";
import { type ClaimedRow, type ImageContent, RequestStore, type Row, type UnclaimedRow } from "../src/requests.ts";
import * as path from "node:path";
import { BACKOFF_MS } from "../src/backoff.ts";
import { type Action, type Proof, ANSWER_ROW_WAITS, OLD_CLAIM_WAITS, isOldClaim, CEILING, DEAD_AFTER_ATTEMPTS, bury, deadLetterParts, deadLetterText, cancelRow, carriesPrefix, heldTurnFor, stopRow, type EngineSinks, type Executor, type ExecutorView, type Producer, coalesced, conversationHas, decideDrain, drain, dropContinuations, enqueue, goalRow, goalRunId, handOver, handOverTarget, isLocal, modeOf, newTriggerRow, promotionTarget, promotionView, pushRunRow, queueOrder, quietMark, recipeRow, releaseLocalRows, requestFingerprint, ringProduced, sameProducer, stillQuiet, typedByPerson, waitingLine, PERSON_RING_WAIT_MS, PERSON_SEND_GRACE_MS, armRetry, proofOf, landed, personRow, plainJobRow, plainRunId, stripImageNotes, answerClaimLive, claimAlive, changesSomething, runningRun, jobQueued, queuedPrompt, closeRun, heldTurns, sessionFileEntries } from "../src/engine.ts";
import { jobCounts, listedJob, runHistory } from "../src/job-status.ts";
import { runEnd } from "../src/settle.ts";
import type { RunRecord } from "../src/store.ts";

test("a row removed between the drain's read and its hand-over is not handed over: the stamp that found no row says so", async () => {
	// The page's send-here takes a message out of the queue and sends it over rpc. A drain that had
	// already read the row used to stamp it (a no-op on a row that is gone) and hand it over anyway,
	// so the message was answered twice. The stamp's result is the check now.
	const { store, sinks } = world();
	store.append(personRow("p1", "hello", undefined, { sessionId: "s", cwd: "/p", createdBy: page }, T0 - 20_000));
	let views = 0;
	const turned: string[] = [];
	const executor: Executor = {
		holds: () => true,
		proof: () => ({ has: () => false, older: () => false, heldRunWrote: () => false, ran: () => undefined }),
		view: () => {
			// The second view is the re-check just before the hand-over: the page removes the row now.
			if (++views === 2) store.remove("s", ["p1"]);
			return { kind: "window", ceiling: () => true, blocked: () => undefined, claimLive: () => false, idle: true, inFlight: new Set(), connected: () => true, producerAlive: () => true, mine: () => true };
		},
		append: () => undefined,
		turn: (row) => void turned.push(row.id),
		abort: () => undefined,
		abortWhenStarted: () => undefined,
		refused: () => undefined,
	};
	const out = await drain("s", store, executor, T0, sinks);
	assert.deepEqual([store.list("s"), turned, out.delivered], [[], [], []], "nothing handed over for a row the page had already taken out");
});

test("coalesced: a burst of calls while one run is on is one rerun, and a call after that is a new run", async () => {
	let runs = 0;
	let release: () => void = () => undefined;
	const go = coalesced(() => new Promise<void>((r) => {
		runs++;
		release = r;
	}));
	for (let i = 0; i < 30; i++) go();
	assert.equal(runs, 1, "thirty events while one drain runs start no second one");
	release();
	await new Promise((r) => setImmediate(r));
	assert.equal(runs, 2, "one rerun for the whole burst, which reads what the first read too early to see");
	release();
	await new Promise((r) => setImmediate(r));
	assert.equal(runs, 2, "and nothing after it");
	go();
	assert.equal(runs, 3, "a call once it is quiet is a new run");
	release();
});

test("a quiet mark holds while the files and the rows are as they were, and until the first backoff ends", () => {
	const T = Date.parse("2026-06-01T12:00:00Z");
	const files = [{ size: 10, mtimeMs: 1 }, { size: 2, mtimeMs: 2 }];
	const rows = [row("1"), { ...row("2"), attempts: 1, not_before: new Date(T + 5_000).toISOString() }];
	const mark = quietMark(files, rows, T);
	assert.equal(mark.until, T + 5_000, "the earliest backoff that has not ended");
	assert.equal(stillQuiet(mark, files, rows, T + 1_000), true);
	assert.equal(stillQuiet(mark, [{ size: 10, mtimeMs: 3 }, files[1]], rows, T + 1_000), false, "the conversation was written");
	assert.equal(stillQuiet(mark, [{ size: 11, mtimeMs: 1 }, files[1]], rows, T + 1_000), false, "or grew with the same mtime");
	assert.equal(stillQuiet(mark, [files[0], undefined], rows, T + 1_000), false, "jobs.json went");
	assert.equal(stillQuiet(mark, files, [rows[0]], T + 1_000), false, "a row left");
	assert.equal(stillQuiet(mark, files, rows, T + 5_000), false, "the backoff ended: decide again");
	assert.equal(stillQuiet(undefined, files, rows, T), false, "no mark yet");
	assert.equal(quietMark(files, [row("1")], T).until, Infinity, "no backoff: the files and the rows alone decide");
	assert.equal(quietMark(files, [{ ...row("2"), not_before: new Date(T - 1).toISOString() }], T).until, Infinity, "a backoff already over is not a wait");
});
import { WindowExecutor, producerAlive, showsTriggeredTurnLine } from "../src/window-executor.ts";
import { LeaseStore, procStart } from "../src/lease.ts";
import { stamp } from "../src/schedule.ts";
import { PAUSED_WHY } from "../src/run-list.ts";
import { TURN_TYPE, markDetails, markFor, withMark } from "../src/mark.ts";

const row = (id: string, over: Partial<UnclaimedRow> = {}): UnclaimedRow => ({ v: 3, id, lane: "s", kind: "input", source: "rule:local:dynamic", mode: "none", wake: "append", payload: { text: `[Trigger ${id}] hello`, cwd: "/" }, created_at: "2026-01-01T00:00:00Z", created_by: { pid: 1, instance: "w", version: "0" }, attempts: 0, ...over });

const T0 = Date.parse("2026-06-01T12:00:00Z");

function world(dir = tmp()) {
	const store = new RequestStore(dir);
	const inbox = new Inbox(dir);
	const audit = new TriggerStore(dir);
	const sinks: EngineSinks = { jobs: { exists: () => true, enabled: () => true, goalActive: () => true }, inbox, audit };
	return { dir, store, inbox, audit, sinks };
}

/**
 * An executor whose `append` writes the id into the conversation at once, as an idle chat or the
 * background process does, unless `deliver` says otherwise.
 */
function fakeExecutor(opts: { holds?: () => boolean; idle?: boolean; deliver?: (row: Row, written: Set<string>) => void } = {}) {
	const written = new Set<string>();
	const given: string[] = [];
	const inFlight = new Set<string>();
	const executor: Executor = {
		holds: opts.holds ?? (() => true),
		proof: () => ({ has: (row) => written.has(row.id), older: () => false, heldRunWrote: () => false, ran: () => undefined }),
		view: () => ({ kind: "window", ceiling: () => true, blocked: () => undefined, claimLive: () => false, idle: opts.idle ?? true, inFlight, connected: () => true, producerAlive: () => true, mine: () => true }),
		append: (r) => {
			(opts.deliver ?? ((d, w) => w.add(d.id)))(r, written);
			given.push(r.id);
		},
		turn: () => {
			throw new Error("no turns here");
		},
		abort: () => undefined,
		abortWhenStarted: () => undefined,
		refused: () => undefined,
	};
	return { executor, written, given, inFlight };
}

test("enqueue then drain delivers in order and removes the file", async () => {
	const { store, sinks } = world();
	store.append(row("1"));
	store.append(row("2"));
	const fake = fakeExecutor();
	const out = await drain("s", store, fake.executor, T0, sinks);
	assert.deepEqual([out.delivered, out.removed, out.failed, out.waiting], [["1", "2"], ["1", "2"], [], []]);
	assert.deepEqual(fake.given, ["1", "2"]);
	assert.equal(fs.existsSync(store.file("s")), false);
});

test("entry already in the conversation is skipped", async () => {
	const { store, sinks } = world();
	store.append(row("x"));
	const fake = fakeExecutor({ deliver: () => assert.fail("duplicate delivery") });
	fake.written.add("x");
	const out = await drain("s", store, fake.executor, T0, sinks);
	assert.deepEqual([out.delivered, out.removed], [[], ["x"]]);
	assert.deepEqual(store.list("s"), []);
});

test("viewer does not drain", async () => {
	const { store, sinks } = world();
	store.append(row("x"));
	const fake = fakeExecutor({ holds: () => false, deliver: () => assert.fail("viewer delivered") });
	const out = await drain("s", store, fake.executor, T0, sinks);
	assert.deepEqual(out, { delivered: [], removed: [], failed: [], dead: [], waiting: [] });
	assert.equal(store.list("s").length, 1);
});

test("delivery failure keeps that entry and later entries", async () => {
	const { store, sinks, audit } = world();
	store.append(row("1"));
	store.append(row("2"));
	const fake = fakeExecutor({
		deliver: () => {
			throw new Error("stop");
		},
	});
	const out = await drain("s", store, fake.executor, T0, sinks);
	assert.deepEqual([out.delivered, out.failed], [[], ["1", "2"]]);
	assert.deepEqual(store.list("s").map((d) => [d.id, d.attempts, d.last_error, d.not_before !== undefined]), [["1", 1, "stop", true], ["2", 1, "stop", true]], "each one counted a failure, and waits out its backoff");
	const again = await drain("s", store, fake.executor, T0 + 1000, sinks);
	assert.deepEqual([again.waiting, fake.given], [["1", "2"], []], "in backoff: not offered again yet");
	assert.equal(audit.listAudit(10, (r) => r.type === "request" && r.state === "failed").length, 2);
});

test("entry enqueued during drain survives", async () => {
	const { store, sinks } = world();
	store.append(row("1"));
	const fake = fakeExecutor({ deliver: (d, written) => (written.add(d.id), store.append(row("2"))) });
	await drain("s", store, fake.executor, T0, sinks);
	assert.deepEqual(store.list("s").map((d) => d.id), ["2"]);
});

test("conversationHas checks user and custom messages and ignores other entries", () => {
	assert.equal(conversationHas([{ type: "message", message: { role: "user", content: "[Trigger x] text" } }], "x"), true);
	assert.equal(conversationHas([{ type: "message", message: { role: "user", content: [{ type: "text", text: "[Trigger x] text" }] } }], "x"), true);
	assert.equal(conversationHas([{ type: "custom_message", content: "[Trigger x] text" }], "x"), true);
	assert.equal(conversationHas([{ type: "message", message: { role: "assistant", content: "[Trigger x] text" } }, { type: "other", content: "[Trigger x] text" }], "x"), false);
});

test("a delivery leaves the queue only once it is in the conversation, and is not handed over twice meanwhile", async () => {
	const { store, sinks } = world();
	store.append(row("1"));
	// A busy chat: pi queues the follow-up in memory and writes it later.
	const fake = fakeExecutor({ deliver: (d) => void fake.inFlight.add(d.id) });
	await drain("s", store, fake.executor, T0, sinks);
	assert.deepEqual(store.list("s").map((d) => d.id), ["1"], "kept: a window that quits now must not lose it");
	const again = await drain("s", store, fake.executor, T0, sinks);
	assert.deepEqual([fake.given, again.waiting], [["1"], ["1"]], "not handed to pi a second time");
	fake.written.add("1");
	await drain("s", store, fake.executor, T0, sinks);
	assert.deepEqual(store.list("s"), [], "gone once it is in the conversation");
	assert.deepEqual(store.sessions(), []);
});

test("a holder that loses the conversation mid-drain stops: the rest wait for whoever holds it now", async () => {
	// Checked once at the start, the holder kept writing after a window had taken the conversation,
	// and the same rule result could reach it twice.
	const { store, sinks } = world();
	for (const id of ["1", "2", "3"]) store.append(row(id));
	let held = true;
	const fake = fakeExecutor({ holds: () => held, deliver: (d, written) => (written.add(d.id), void (held = false)) });
	await drain("s", store, fake.executor, T0, sinks);
	assert.deepEqual(fake.given, ["1"]);
	assert.deepEqual(store.list("s").map((d) => d.id), ["2", "3"]);
});

test("a follow-up pi dropped (Esc) is offered again once pi has settled, not held for the window's life", async () => {
	const { store, sinks } = world();
	store.append(row("1"));
	const entries: unknown[] = [];
	let idle = false;
	const sent: Array<{ content: unknown; options: unknown }> = [];
	const pi = { sendMessage: (message: { content: unknown }, options: unknown) => void sent.push({ content: message.content, options }) };
	const ctx = { isIdle: () => idle, mode: "tui", sessionManager: { getEntries: () => entries } } as any;
	// The request file as the extension wires it: what the window gave pi is remembered while its row is there.
	const executor = new WindowExecutor(pi, { here: () => ({ sessionId: "s", holds: true }), hold: () => true, letGo: () => undefined }, () => ctx, { pid: 1 }, () => true, () => store.list("s"), undefined, () => []);
	for (let i = 0; i < 6; i++) await drain("s", store, executor, T0, sinks);
	assert.deepEqual(sent, [{ content: "[Trigger 1] hello", options: { triggerTurn: true, deliverAs: "followUp" } }], "a busy chat gets it once, as a follow-up that wakes the agent");
	assert.deepEqual(store.list("s").map((d) => d.id), ["1"], "and it stays in the file until pi writes it");
	// pi settled and "1" is not in the conversation: Esc cleared the queue it was in.
	idle = true;
	assert.deepEqual(executor.settled(true), ["1"]);
	await drain("s", store, executor, T0, sinks);
	assert.deepEqual(sent[1], { content: "[Trigger 1] hello", options: { triggerTurn: false } }, "offered again, inserted without a turn now that pi is idle");
	const one = store.list("s")[0];
	entries.push({ type: "custom_message", content: "[Trigger 1] hello", details: markDetails(markFor(one)) });
	await drain("s", store, executor, T0, sinks);
	assert.deepEqual(store.list("s"), [], "gone once pi wrote it");
	assert.equal(executor.delivered(one), true, "the marked entry proves the row");
	ctx.mode = "print";
	assert.equal(executor.holds("s"), false, "a one-shot run is not where a result should land");
});

test("a row that throws three times becomes one finding and the rows behind it still arrive", async () => {
	const { store, sinks, inbox, audit } = world();
	store.append(row("bad"));
	store.append(row("ok"));
	const fake = fakeExecutor({
		deliver: (d, written) => {
			if (d.id === "bad") throw new Error("pi refused it");
			written.add(d.id);
		},
	});
	const first = await drain("s", store, fake.executor, T0, sinks);
	assert.deepEqual([first.failed, first.removed], [["bad"], ["ok"]], "the failure blocks nothing behind it");
	assert.deepEqual(store.list("s").map((d) => [d.id, d.attempts]), [["bad", 1]]);
	assert.deepEqual((await drain("s", store, fake.executor, T0 + 30_000, sinks)).waiting, ["bad"], "a minute's backoff first");
	assert.deepEqual((await drain("s", store, fake.executor, T0 + BACKOFF_MS[0], sinks)).failed, ["bad"]);
	assert.deepEqual((await drain("s", store, fake.executor, T0 + BACKOFF_MS[0] + 30_000, sinks)).waiting, ["bad"], "then five");
	const third = await drain("s", store, fake.executor, T0 + BACKOFF_MS[0] + BACKOFF_MS[1], sinks);
	assert.deepEqual([third.failed, third.dead], [["bad"], ["bad"]]);
	assert.deepEqual(store.list("s"), [], "a dead letter leaves the queue");
	const findings = inbox.listNew();
	assert.equal(findings.length, 1, "one finding, not one per failure");
	assert.deepEqual([findings[0].source, findings[0].session_id, findings[0].text, findings[0].run_id], ["trigger:local:dynamic", "s", "hello", "bad"]);
	const dead = audit.listAudit(20, (r) => r.type === "request" && r.state === "dead");
	assert.equal(dead.length, 1);
	assert.deepEqual([dead[0].traceId, dead[0].details?.attempts, dead[0].details?.last_error], ["bad", 3, "pi refused it"]);
});

test("a crash between the finding and the removal loses no row", async () => {
	const { store, sinks, inbox, audit } = world();
	store.append(row("dead", { attempts: 3, last_error: "pi refused it" }));
	let crash = true;
	const crashing: EngineSinks = {
		...sinks,
		audit: {
			listAudit: (...a) => audit.listAudit(...a),
			appendAudit: (record) => {
				if (crash) {
					crash = false;
					throw new Error("disk full");
				}
				return audit.appendAudit(record);
			},
		},
	};
	await assert.rejects(drain("s", store, fakeExecutor().executor, T0, crashing), /disk full/);
	assert.equal(inbox.listNew().length, 1, "the finding was written first");
	assert.deepEqual(store.list("s").map((d) => d.id), ["dead"], "and the row is still there: nothing is lost");
	await drain("s", store, fakeExecutor().executor, T0, crashing);
	assert.deepEqual(store.list("s"), [], "the next drain finishes the job");
	assert.equal(audit.listAudit(10, (r) => r.type === "request" && r.state === "dead").length, 1);
	assert.equal(inbox.listNew().length, 1, "exactly once: the next drain finds the finding the first one wrote (Inbox.appendOnce)");
});

test("a row of a newer version is kept and skipped", async () => {
	const { store, sinks } = world();
	store.append(row("1"));
	const newer = JSON.stringify({ ...row("later"), v: 3, kind: "redact" });
	fs.appendFileSync(store.file("s"), `${newer}\n`);
	store.append(row("2"));
	const fake = fakeExecutor();
	const out = await drain("s", store, fake.executor, T0, sinks);
	assert.deepEqual(out.delivered, ["1", "2"], "the rows this version knows are delivered, around it");
	assert.equal(fs.readFileSync(store.file("s"), "utf8"), `${newer}\n`, "the newer row is left for the version that wrote it");
});

test("modeOf gives each source the mode its trigger decided", () => {
	assert.equal(modeOf("conversation", "input", "rule:local:dynamic", "append"), "none");
	assert.equal(modeOf("conversation", "input", "push:srv:key", "append"), "none");
	assert.equal(modeOf("conversation", "input", "push:srv:key", "turn"), "unattended");
	assert.equal(modeOf("conversation", "input", "cron:job-1", "turn"), "unattended");
	for (const source of ["cron-run:job-1", "person", "goal", "recipe:daily", "new-trigger", "cli", "window"] as const) assert.equal(modeOf("conversation", "input", source, "turn"), "attended", source);
	assert.equal(modeOf("conversation", "stop", "cli"), "none");
	assert.equal(modeOf("conversation", "cancel", "person"), "none");
});

const view = (over: Partial<ExecutorView> = {}): ExecutorView => ({ kind: "window", ceiling: () => true, blocked: () => undefined, claimLive: () => false, idle: true, inFlight: new Set(), connected: () => true, producerAlive: () => true, mine: () => true, ...over });
const none: Proof = { has: () => false, older: () => false, heldRunWrote: () => false, ran: () => undefined };
const jobs = { exists: () => true, enabled: () => true, goalActive: () => true };

test("a row wider than its source is refused, audited and removed, never run or left waiting", async () => {
	// A plain job's row with `attended` written into the file: the clock's row gets `unattended`.
	const widened = row("w1", { wake: "turn", source: "cron:j", mode: "attended", payload: { text: "[Trigger w1] hello", cwd: "/" } });
	assert.deepEqual(decideDrain("conversation", [widened], none, jobs, view(), T0), [{ do: "exit", row: widened, exit: "refused" }]);
	// The rule is equality, so a narrower row is refused too: the executor runs a row only as its source.
	const narrowed = row("n1", { wake: "turn", source: "recipe:daily", mode: "unattended", payload: { text: "[Trigger n1] hello", cwd: "/" } });
	assert.deepEqual(decideDrain("conversation", [narrowed], none, jobs, view(), T0), [{ do: "exit", row: narrowed, exit: "refused" }]);
	const result = row("r1", { mode: "attended" });
	assert.deepEqual(decideDrain("conversation", [result], none, jobs, view(), T0), [{ do: "exit", row: result, exit: "refused" }], "an append row too");
	const honest = row("h1", { wake: "turn", source: "cron:j", mode: "unattended", payload: { text: "[Trigger h1] hello", cwd: "/" } });
	assert.deepEqual(decideDrain("conversation", [widened, honest], none, jobs, view(), T0), [
		{ do: "exit", row: widened, exit: "refused" },
		{ do: "turn", row: honest },
	], "the refused row blocks nothing behind it");
	// Through the engine: gone from the file, and the audit says why.
	const { store, audit, sinks } = world();
	store.append(widened);
	const fake = fakeExecutor({ deliver: () => assert.fail("a refused row was delivered") });
	const out = await drain("s", store, fake.executor, T0, sinks);
	assert.deepEqual([out.delivered, out.removed, out.waiting], [[], ["w1"], []]);
	assert.deepEqual(store.list("s"), []);
	const audited = audit.listAudit(10, (r) => r.type === "request" && r.traceId === "w1");
	assert.equal(audited.length, 1);
	assert.equal(audited[0].state, "refused");
	assert.equal(audited[0].sourceLabel, "cron:j");
});

test("an attended row never runs in the background process; it waits for a window", () => {
	const held = (over: Partial<ExecutorView> = {}) => view({ kind: "held", ceiling: CEILING.held, mine: () => false, ...over });
	const claim = recipeRow("look at this", "inb-1", "tracker", { sessionId: "s", cwd: "/", createdBy: { pid: 99, instance: "w", version: "0" } }, T0);
	const goal = goalRow("go on", { condition: "c", iterations: 1, updatedAt: "t" }, { sessionId: "s", cwd: "/", createdBy: { pid: 99, instance: "w", version: "0" } }, T0);
	const person = row("p1", { wake: "turn", source: "person", mode: "attended", payload: { text: "hi", cwd: "/" } });
	// Their producers are gone, so nothing but the ceiling keeps them from this executor.
	for (const attended of [claim, goal, person]) assert.deepEqual(decideDrain("conversation", [attended], none, jobs, held({ producerAlive: () => false }), T0), [{ do: "wait", row: attended, why: "attended rows wait for a window" }], attended.source);
	const cron = row("c1", { wake: "turn", source: "cron:j", mode: "unattended", payload: { text: "[Trigger c1] hello", cwd: "/" } });
	assert.deepEqual(decideDrain("conversation", [cron], none, jobs, held(), T0), [{ do: "turn", row: cron }], "an unattended row is under the ceiling");
	assert.deepEqual(decideDrain("conversation", [row("r1")], none, jobs, held(), T0), [{ do: "append", row: row("r1"), wakeAgent: false }], "and so is a result");
	assert.equal(CEILING.window("attended"), true, "a window runs every mode");
	assert.deepEqual(decideDrain("conversation", [claim], none, jobs, view(), T0), [{ do: "turn", row: claim }]);
});

test("a claim 0.24.2 queued (source inbox:) waits for the conversion in every executor, holds nothing, and a person can still take it out", async () => {
	// A row of 0.24.2, read back as this version reads every line: its source is in no RequestSource now.
	const old = row("claim-1", { source: "inbox:inb-1" as Row["source"], mode: "attended", wake: "turn", payload: { text: "[Trigger claim-1] look into it", cwd: "/" } });
	const cron = row("c1", { wake: "turn", source: "cron:j", mode: "unattended", payload: { text: "[Trigger c1] hello", cwd: "/" } });
	assert.equal(isOldClaim(old), true);
	assert.equal(isOldClaim(cron), false);
	assert.equal(isLocal(old), false, "nobody's local row: no window runs it as its own");
	const held = view({ kind: "held", ceiling: CEILING.held, mine: () => false, producerAlive: () => false });
	for (const v of [view(), view({ producerAlive: () => false }), held]) {
		assert.deepEqual(decideDrain("conversation", [old, cron], none, jobs, v, T0), [{ do: "wait", row: old, why: OLD_CLAIM_WAITS }, { do: "turn", row: cron }], "it waits, and the turn behind it starts");
	}
	// Through the engine: never handed to pi, no attempt counted, still in the file.
	const { store, sinks } = world();
	store.append(old as UnclaimedRow);
	const w = fakeWindowPi(true);
	const out = await drain("s", store, w.executor, T0, sinks);
	assert.deepEqual([out.delivered, out.removed, out.waiting, w.sent], [[], [], ["claim-1"], []]);
	assert.equal(store.list("s")[0].attempts, 0);
	// A cancel from the queue's ✕ still takes it out.
	const cancel = row("x1", { kind: "cancel", source: "person", target: { id: "claim-1" } });
	assert.deepEqual(decideDrain("conversation", [old, cancel], none, jobs, view(), T0), [{ do: "exit", row: old, exit: "cancelled" }, { do: "exit", row: cancel, exit: "delivered" }]);
});

test("decideDrain: stops and cancels act first, idle or busy, and never on whatever runs next", () => {
	const a = row("a");
	const b = row("b");
	const cancel = row("c1", { kind: "cancel", source: "person", target: { id: "a" } });
	const stop = row("s1", { kind: "stop", source: "cli", target: { id: "b" } });
	assert.deepEqual(decideDrain("conversation", [a, b, cancel, stop], none, jobs, view({ idle: false }), T0), [
		{ do: "exit", row: a, exit: "cancelled" },
		{ do: "exit", row: cancel, exit: "delivered" },
		{ do: "exit", row: b, exit: "cancelled" },
		{ do: "exit", row: stop, exit: "delivered" },
	]);
	const running = row("s2", { kind: "stop", source: "cli", target: { id: "r" } });
	assert.deepEqual(decideDrain("conversation", [running], none, jobs, view({ running: { requestId: "r", startedAt: "2026-06-01T11:00:00Z" } }), T0), [{ do: "abort", stop: running }, { do: "exit", row: running, exit: "delivered" }]);
	const late = row("s3", { kind: "stop", source: "cli", target: { current: true, started_before: "2026-06-01T11:00:00Z" } });
	assert.deepEqual(decideDrain("conversation", [late], none, jobs, view({ running: { startedAt: "2026-06-01T11:30:00Z" } }), T0), [{ do: "exit", row: late, exit: "stale" }], "a late stop never stops the next turn");
	assert.deepEqual(decideDrain("conversation", [late], none, jobs, view({ running: { startedAt: "2026-06-01T10:30:00Z" } }), T0), [{ do: "abort", stop: late }, { do: "exit", row: late, exit: "delivered" }]);
	assert.deepEqual(decideDrain("conversation", [stop], none, jobs, view(), T0), [{ do: "exit", row: stop, exit: "stale" }], "nothing to stop: stale");
});

test("decideDrain: one lane, oldest first; a row that cannot go now blocks nothing behind it", () => {
	const backoff = row("x", { wake: "turn", source: "cron:j", mode: "unattended", not_before: new Date(T0 + 60_000).toISOString() });
	const result = row("y");
	const turn = row("z", { wake: "turn", source: "cron:j", mode: "unattended" });
	const another = row("w", { wake: "turn", source: "cron:j", mode: "unattended" });
	assert.deepEqual(decideDrain("conversation", [backoff, result, turn, another], none, jobs, view(), T0), [
		{ do: "wait", row: backoff, why: `backing off until ${backoff.not_before}` },
		{ do: "append", row: result, wakeAgent: false },
		{ do: "turn", row: turn },
		{ do: "wait", row: another, why: "pi is busy" },
	], "idle: a result lands without a turn, one turn is handed over, the next waits");
	assert.deepEqual(decideDrain("conversation", [result, turn], none, jobs, view({ idle: false }), T0), [
		{ do: "append", row: result, wakeAgent: true },
		{ do: "wait", row: turn, why: "pi is busy" },
	], "busy: a result goes as a follow-up that wakes the agent, a turn waits");
	assert.deepEqual(decideDrain("conversation", [result], none, jobs, view({ blocked: () => "held back for a reason of its own" }), T0), [{ do: "wait", row: result, why: "held back for a reason of its own" }]);
	assert.deepEqual(decideDrain("conversation", [result], none, jobs, view({ inFlight: new Set(["y"]) }), T0), [{ do: "wait", row: result, why: "handed to pi, not yet in the conversation" }]);
	const needs = row("n", { wake: "turn", source: "cron:j", mode: "unattended", payload: { text: "[Trigger n] t", cwd: "/", requires: ["gh"] } });
	assert.deepEqual(decideDrain("conversation", [needs], none, jobs, view({ connected: () => false }), T0), [{ do: "wait", row: needs, why: "waiting for mcp server gh" }]);
	assert.deepEqual(decideDrain("conversation", [result], { ...none, has: () => true }, jobs, view(), T0), [{ do: "exit", row: result, exit: "delivered" }]);
	assert.deepEqual(decideDrain("conversation", [turn], none, { ...jobs, exists: () => false }, view(), T0), [{ do: "exit", row: turn, exit: "job-removed" }], "removing a job cancels its queued rows");
	const goal = row("g", { wake: "turn", source: "goal", mode: "attended" });
	assert.deepEqual(decideDrain("conversation", [goal], none, { ...jobs, enabled: () => true, goalActive: () => false }, view(), T0), [{ do: "exit", row: goal, exit: "stale" }]);
	const tired = row("t", { attempts: 3, last_error: "no" });
	assert.deepEqual(decideDrain("conversation", [tired], none, jobs, view(), T0), [{ do: "exit", row: tired, exit: "dead", why: "failed 3 times: no" }]);
	const empty = row("e", { payload: undefined });
	assert.deepEqual(decideDrain("conversation", [empty], none, jobs, view(), T0), [{ do: "exit", row: empty, exit: "dead", why: "an input row without text" }]);
});

test("two drains that overlap hand a row over once", async () => {
	// The tick, the bell and a promotion each drain; one awaiting a dead letter let another hand the
	// same row over, and the first handed it over again when it resumed.
	const { store, sinks } = world();
	store.append(row("dead", { attempts: DEAD_AFTER_ATTEMPTS }));
	store.append(row("x"));
	const fake = fakeExecutor({ deliver: (d) => fake.inFlight.add(d.id) }); // pi holds it as a follow-up
	await Promise.all([drain("s", store, fake.executor, T0, sinks), drain("s", store, fake.executor, T0, sinks)]);
	assert.deepEqual(fake.given, ["x"], "handed to pi once");
});

test("a pi-loops row without its [Trigger <id>] prefix becomes one dead letter, not a write on every drain", async () => {
	const { store, sinks, inbox } = world();
	store.append(row("x", { payload: { text: "no proof here", cwd: "/" } }));
	const fake = fakeExecutor();
	assert.deepEqual((await drain("s", store, fake.executor, T0, sinks)).dead, ["x"]);
	assert.deepEqual(fake.given, [], "never handed over");
	await drain("s", store, fake.executor, T0, sinks);
	assert.equal(inbox.listNew().length, 1);
});

test("two drains that overlap write a dead letter once", async () => {
	const { store, sinks, inbox } = world();
	store.append(row("dead", { attempts: DEAD_AFTER_ATTEMPTS }));
	const fake = fakeExecutor();
	await Promise.all([drain("s", store, fake.executor, T0, sinks), drain("s", store, fake.executor, T0, sinks)]);
	assert.equal(inbox.listNew().length, 1);
});

test("a rule's dead letter is the inbox finding a rule's result always was", async () => {
	// The since-you-looked count and /inbox open tell results from runs by `trigger:` and job_id.
	const { store, sinks, inbox } = world();
	store.append(row("r", { attempts: DEAD_AFTER_ATTEMPTS, source: "rule:local:dynamic" }));
	await drain("s", store, fakeExecutor().executor, T0, sinks);
	const [f] = inbox.listNew();
	assert.deepEqual([f.source, f.job_id, f.text, f.session_id], ["trigger:local:dynamic", "local:dynamic", "hello", "s"]);
});

test("a rule's dead letter files nothing when the check of that run decided its finding, a repeat included", async () => {
	const { store, sinks, inbox, audit } = world();
	// The check of run "r" skipped filing: what it said repeats the latest new finding of its rule.
	audit.appendAudit({ cwd: "/", type: "trigger_result", traceId: "r", state: "completed", sourceLabel: "local:dynamic", eventLabel: "dynamic periodic check", summary: "matched dyn-1. hello", details: { matched_rule_ids: ["dyn-1"], inbox: "repeat" } });
	store.append(row("r", { attempts: DEAD_AFTER_ATTEMPTS, source: "rule:local:dynamic" }));
	await drain("s", store, fakeExecutor().executor, T0, sinks);
	assert.deepEqual(inbox.listNew(), [], "the check's decision stands: a repeat files nothing more");
	assert.deepEqual(store.list("s"), [], "and the row is still buried");
	store.append(row("r2", { attempts: DEAD_AFTER_ATTEMPTS, source: "rule:local:dynamic" }));
	await drain("s", store, fakeExecutor().executor, T0, sinks);
	assert.deepEqual(inbox.listNew().map((f) => f.run_id), ["r2"], "a row whose check decided nothing is filed, once");
});

test("promotionTarget: the creating conversation while a window holds it, else the project's open window, else the closed creating one, else the inbox", () => {
	// Owner decision 2026-11-02: the project's open window, with the creating conversation first. Every branch, with the view as a window or the background process reads it.
	const view = (o: { open?: string[]; known?: string[]; windows?: Array<{ sessionId: string; pid: number }> } = {}) => ({
		open: (id: string) => (o.open ?? []).includes(id),
		known: (id: string) => (o.known ?? []).includes(id),
		openInProject: () => o.windows ?? [],
	});
	const b = { sessionId: "B", pid: 20 };
	const c = { sessionId: "C", pid: 10 };
	assert.deepEqual(promotionTarget("A", view({ open: ["A", "B"], known: ["A"], windows: [b] })), { to: "row", sessionId: "A" }, "the creating conversation, open: first, whatever else is open");
	assert.deepEqual(promotionTarget("A", view({ open: ["B", "C"], known: ["A"], windows: [b, c] })), { to: "row", sessionId: "C" }, "closed: the project's open window, lowest pid (0.22.8's cwd owner)");
	assert.deepEqual(promotionTarget("A", view({ open: ["B", "C"], known: ["A"], windows: [b, { ...c, pid: 20 }] })), { to: "row", sessionId: "B" }, "a pid tie breaks on the session id, so every process agrees");
	assert.deepEqual(promotionTarget("A", view({ known: ["A"] })), { to: "row", sessionId: "A" }, "no window in the project: appended to the closed creating conversation");
	assert.deepEqual(promotionTarget("A", view({ open: ["B"], windows: [b] })), { to: "row", sessionId: "B" }, "an imported rule's unknown creating conversation: the project's window");
	assert.deepEqual(promotionTarget("A", view()), { to: "inbox", sessionId: "A" }, "unknown or gone, and no window: the inbox, marked for it");
	assert.deepEqual(promotionTarget(undefined, view({ open: ["B"], windows: [b] })), { to: "row", sessionId: "B" }, "a rule a loop's run made: the project's window");
	assert.deepEqual(promotionTarget(undefined, view()), { to: "inbox" }, "and with no window, the inbox");
});

test("promotionView reads the leases: a live terminal that delivers is an open window, in the project when its cwd is the rule's or inside it", () => {
	const dir = tmp();
	fs.mkdirSync(path.join(dir, "proj", "sub"), { recursive: true });
	fs.writeFileSync(path.join(dir, "a.jsonl"), "");
	const leases = new LeaseStore(dir);
	const me = (pid: number, mode: "tui" | "print", aside?: true) => ({ kind: "terminal" as const, pid, instance: `w${pid}`, procStart: procStart(pid), acquiredAt: stamp(), mode, pushServers: [], ...(aside ? { aside } : {}) });
	leases.acquire("A", me(process.pid, "tui"), { sessionFile: path.join(dir, "a.jsonl"), cwd: path.join(dir, "proj", "sub") });
	leases.acquire("P", me(process.pid, "print"), { cwd: path.join(dir, "proj") });
	leases.acquire("S", me(process.pid, "tui", true), { cwd: path.join(dir, "proj") });
	leases.acquire("E", me(process.pid, "tui"), { cwd: path.join(dir, "elsewhere") });
	leases.acquire("D", { ...me(999_999, "tui"), procStart: "0", acquiredAt: "2000-01-01T00:00:00Z" }, { cwd: path.join(dir, "proj") });
	leases.release("A", me(process.pid, "tui"));
	leases.acquire("A", me(process.pid, "tui"), { sessionFile: path.join(dir, "a.jsonl"), cwd: path.join(dir, "proj", "sub") });
	const view = promotionView(leases, path.join(dir, "proj"));
	assert.deepEqual(view.openInProject(), [{ sessionId: "A", pid: process.pid }], "a subdirectory counts; a pi -p run, a window standing aside, another project and a dead pid do not");
	assert.deepEqual([view.open("A"), view.open("P"), view.open("S"), view.open("D"), view.open("nope")], [true, false, false, false, false]);
	assert.deepEqual([view.known("A"), view.known("P")], [true, false], "known: pi-loops has its file and the file is there");
	assert.deepEqual(promotionView(leases, undefined).openInProject(), [], "a rule with no project reaches no window by project");
});

/**
 * A window over a fake pi: `sent` is every turn that reached pi (a custom message of `pi-loops:turn`
 * through `sendMessage`, or the person's own page message through `sendUserMessage`), `appended`
 * what else reached `sendMessage`, `entries` the conversation, `notices` the system lines. `self` is
 * the process the window is (pid 1 unless said), `holds` whether it has the lease, `alive` whether a
 * row's producer is.
 */
/** `rows` is the request file as the extension wires it: what this window produced is remembered only while the row is there. */
function fakeWindowPi(idle: boolean, opts: { holds?: boolean; self?: Producer; alive?: (row: Row) => boolean; mode?: string; rows?: () => Row[]; images?: (row: Row) => ImageContent[] } = {}) {
	const sent: Array<{ text: string; options: unknown }> = [];
	const appended: Array<{ content: unknown; options: unknown }> = [];
	const notices: string[] = [];
	const entries: unknown[] = [];
	const ctx = { idle, aborts: 0, mode: opts.mode ?? "tui", hasUI: true, isIdle: () => ctx.idle, abort: () => void ctx.aborts++, sessionManager: { getEntries: () => entries }, editor: "", ui: { notify: (line: string) => void notices.push(line), getEditorText: () => ctx.editor, setEditorText: (text: string) => void (ctx.editor = text) } } as any;
	const turns: CustomTurn[] = [];
	const pi = { sendMessage: (m: CustomTurn, options: unknown) => void (m.customType === TURN_TYPE ? (turns.push(m), sent.push({ text: m.content as string, options })) : appended.push({ content: m.content, options })), sendUserMessage: (text: string, options: unknown) => void sent.push({ text, options }) };
	const handed: Row[] = [];
	const executor = new WindowExecutor(pi, { here: () => ({ sessionId: "s", holds: opts.holds ?? true }), hold: () => true, letGo: () => undefined }, () => ctx, opts.self ?? { pid: 1 }, opts.alive ?? (() => true), opts.rows ?? (() => handed), opts.images, () => [], SAME_SIZE);
	const turn = executor.turn.bind(executor);
	executor.turn = (row, now) => { handed.push(row); return turn(row, now); };
	/**
	 * Pi writes a message with `text` at `at`, as a real pi does: `message_start`, then `message_end`,
	 * then the entry. A turn the window sent as a custom message with these words is written as that
	 * message, its details in the entry. Anything else is a user message, and what `message_end`
	 * answers (the message with a row's mark, when it is the person's own page message) is what pi persists.
	 */
	const writes = (text: string, at = Date.now()): void => {
		const held = turns.findIndex((turn) => turn.content === text);
		if (held >= 0) return writesTurn(executor, entries, turns.splice(held, 1)[0], at);
		const message = { role: "user", content: [{ type: "text", text }] };
		executor.messageStarted(message, at);
		entries.push({ type: "message", timestamp: new Date(at).toISOString(), message: executor.messageEnded(message, at)?.message ?? message });
	};
	/** The person sends `text` in this window at `at`: pi's `input`, then the message pi writes for it. */
	const types = (text: string, at = Date.now()): void => {
		executor.inputSeen({ source: "interactive", text }, at);
		writes(text, at);
	};
	/** Pi starts the custom turn the window sent with `text`, and does not write it yet. */
	const starts = (text: string, at = Date.now()): void => executor.messageStarted({ role: "custom", ...turns.find((turn) => turn.content === text)! }, at);
	return { sent, appended, notices, entries, ctx, executor, writes, types, turns, starts };
}
/** A resizer that finds every image within pi's limits. */
const SAME_SIZE = { resizeImage: async (bytes: Uint8Array, mimeType: string) => ({ data: Buffer.from(bytes).toString("base64"), mimeType, originalWidth: 1, originalHeight: 1, width: 1, height: 1, wasResized: false }), formatDimensionNote: () => undefined };
/** A turn row's custom message, as the window gives it to `pi.sendMessage`. */
type CustomTurn = { customType: string; content: unknown; display: boolean; details: { piLoopsRow: { lane: string; id: string; at: string }; cap: { mode: string } } };
/** What every custom turn is sent with. */
const TURN_OPTIONS = { triggerTurn: true, deliverAs: "followUp" };
/** Pi starts, ends and persists a custom turn the window sent. */
function writesTurn(executor: WindowExecutor, entries: unknown[], turn: CustomTurn, at: number): void {
	executor.messageStarted({ role: "custom", ...turn }, at);
	const ended = executor.messageEnded({ role: "custom", ...turn }, at)?.message as CustomTurn | undefined;
	entries.push({ type: "custom_message", timestamp: new Date(at).toISOString(), ...turn, details: ended?.details ?? turn.details });
}
const turnRow = (id: string) => row(id, { source: "cron:j", mode: "unattended", wake: "turn", collapse_key: "cron:j" });
/** A user message pi wrote at `at`: what proves a text-proved row (a person's, a claim's) once it is at or after the hand-over stamp. */
const userEntry = (text: string, at: number) => ({ type: "message", timestamp: new Date(at).toISOString(), message: { role: "user", content: [{ type: "text", text }] } });

test("nothing is handed to pi while a turn runs", async () => {
	const { store, sinks } = world();
	store.append(turnRow("t1"));
	const w = fakeWindowPi(false);
	for (let i = 0; i < 3; i++) {
		const out = await drain("s", store, w.executor, T0, sinks);
		assert.deepEqual(out.waiting, ["t1"]);
	}
	assert.deepEqual(w.sent, [], "a turn row is never queued inside pi, where Esc would drop it");
	assert.deepEqual(store.list("s").map((r) => r.id), ["t1"]);
	w.ctx.idle = true;
	await drain("s", store, w.executor, T0, sinks);
	assert.deepEqual(w.sent, [{ text: "[Trigger t1] hello", options: TURN_OPTIONS }], "handed over once pi is idle, as a custom message that asks for a turn");
	assert.deepEqual(w.turns[0].details, { piLoopsRow: { lane: "s", id: "t1", at: store.list("s")[0].created_at }, cap: { kind: "row", id: "t1", mode: "unattended" } }, "its row, the generation it was queued as, and its cap in the details");
	await drain("s", store, w.executor, T0, sinks);
	assert.equal(w.sent.length, 1, "and not again while pi has it");
	assert.deepEqual(store.list("s").map((r) => r.id), ["t1"], "in the file until pi writes it");
	w.writes("[Trigger t1] hello", T0 + 2_500);
	await drain("s", store, w.executor, T0, sinks);
	assert.deepEqual(store.list("s"), []);
});

test("after Esc, queued turn rows run once pi is idle, as messages queued in a chat do", async () => {
	// Owner decision 2026-11-02: Esc and Stop stop the current turn only, as in 0.22.8. 0.24 used to
	// hold the clock's rows a minute after a stop, and the person's until they typed; the queue is
	// visible and cancellable instead (`/cron queue`, the page's ✕).
	const { store, sinks } = world();
	store.append(turnRow("t1"));
	store.append(row("a1"));
	const w = fakeWindowPi(true);
	w.executor.agentStarted(T0 - 5_000);
	w.executor.agentEnded();
	const out = await drain("s", store, w.executor, T0 + 1_000, sinks);
	assert.deepEqual(w.sent.map((s) => s.text), ["[Trigger t1] hello"], "the stopped run holds nothing: the next row goes at once");
	assert.deepEqual(out.delivered, ["t1", "a1"]);
	assert.deepEqual(w.appended.map((a) => a.options), [{ triggerTurn: true, deliverAs: "followUp" }], "the result behind it goes as a follow-up to that turn");
	assert.equal(w.executor.view("s").running, undefined, "the stopped run is over");
});

const to = { sessionId: "s", cwd: "/proj", createdBy: { pid: 1, instance: "w", version: "0" } };
const HEX32 = /^[0-9a-f]{32}$/;

test("pushRunRow: the trace id is the row id, the prompt keeps its one prefix, pushes of one event kind collapse", () => {
	const trigger = { traceId: "t-1", idempotencyKey: "mcp:gh:custom:issue-7", source: { kind: "mcp" as const, serverName: "gh" } };
	const r = pushRunRow("[Trigger t-1] gh fired: issue opened", trigger, to, T0);
	assert.equal(r.id, "t-1");
	assert.equal(r.source, "push:gh");
	assert.equal(r.mode, "unattended");
	assert.equal(r.wake, "turn");
	assert.equal(r.collapse_key, "push:gh:custom:issue-7");
	assert.equal(r.payload?.text, "[Trigger t-1] gh fired: issue opened", "no second prefix");
	assert.equal(r.payload?.cwd, "/proj");
	assert.equal(r.lane, "s");
	assert.equal(modeOf("conversation", r.kind, r.source, r.wake), r.mode);
	assert.equal(showsTriggeredTurnLine(r.source), true, "a push announces its turn as it did");
});

test("goalRow: the same continuation always has the same id, a goal set again does not", () => {
	const state = { condition: "tests pass", iterations: 2, updatedAt: "2026-06-01T12:00:00Z" };
	const a = goalRow("The current /goal is not satisfied yet.", state, to, T0);
	const b = goalRow("The current /goal is not satisfied yet.", state, to, T0 + 5_000);
	assert.equal(a.id, b.id, "derived, not minted");
	assert.match(a.id, /^goal-[0-9a-f]{32}$/);
	assert.equal(a.id, `goal-${goalRunId(state).slice(5)}`);
	assert.notEqual(a.id, goalRow("x", { ...state, iterations: 3 }, to, T0).id, "the next iteration is another row");
	assert.notEqual(a.id, goalRow("x", { ...state, updatedAt: "2026-06-02T12:00:00Z" }, to, T0).id, "the same condition judged again is another row");
	assert.deepEqual([a.source, a.mode, a.wake, a.collapse_key], ["goal", "attended", "turn", "goal"]);
	assert.equal(a.payload?.text, `[Trigger ${a.id}] The current /goal is not satisfied yet.`, "the evaluator's words after the row's prefix, so a wrapped continuation is still known");
	assert.equal(a.payload?.cwd, "/proj");
	assert.equal(showsTriggeredTurnLine(a.source), false, "the goal prints its own notice");
});

test("recipeRow, newTriggerRow: a fresh id each, the person's own sources, collapse per recipe", () => {
	const recipe = recipeRow("Describe the tracker", "daily", "tracker", to, T0);
	assert.match(recipe.id, /^recipe-[0-9a-f]{32}$/);
	assert.deepEqual([recipe.source, recipe.mode, recipe.wake, recipe.collapse_key], ["recipe:daily", "attended", "turn", "recipe:daily:tracker"]);
	assert.equal(recipe.payload?.text, `[Trigger ${recipe.id}] Describe the tracker`);

	const nt = newTriggerRow("The user asked pi to create a dynamic trigger.", to, T0);
	assert.match(nt.id, /^nt-[0-9a-f]{32}$/);
	assert.deepEqual([nt.source, nt.mode, nt.wake, nt.collapse_key], ["new-trigger", "attended", "turn", undefined]);
	assert.equal(nt.payload?.text, `[Trigger ${nt.id}] The user asked pi to create a dynamic trigger.`);

	assert.equal(recipe.payload?.cwd, "/proj");
	for (const r of [recipe, nt]) {
		assert.match(r.id.replace(/^[a-z]+-/, ""), HEX32);
		assert.equal(modeOf("conversation", r.kind, r.source, r.wake), r.mode);
		assert.equal(typedByPerson(r.source), true, `${r.source} is typed by the person`);
		assert.equal(showsTriggeredTurnLine(r.source), false, `${r.source} keeps its own notice`);
	}
	for (const source of ["goal", "cron:j", "push:gh", "rule:local:dynamic"] as const) assert.equal(typedByPerson(source), false, source);
	assert.equal(typedByPerson("cron-run:j"), true, "/cron run is typed: pi fires no input event for an extension command, so the row is what says the person acted");
});

test("enqueue: a second row with a queued collapse key is not written; one with no key always is", () => {
	const { store } = world();
	assert.equal(enqueue(store, recipeRow("a", "daily", "tracker", to, T0)), true);
	assert.equal(enqueue(store, recipeRow("b", "daily", "tracker", to, T0)), false, "collapse, never replay");
	assert.equal(enqueue(store, recipeRow("c", "weekly", "tracker", to, T0)), true, "another recipe is another lane");
	assert.equal(enqueue(store, newTriggerRow("x", to, T0)), true);
	assert.equal(enqueue(store, newTriggerRow("y", to, T0)), true, "no key: every /new-trigger is its own");
	const same = goalRow("p", { condition: "c", iterations: 1, updatedAt: "t" }, to, T0);
	assert.equal(enqueue(store, same), true);
	assert.equal(enqueue(store, same), false, "the same id is one row");
	assert.equal(store.list("s").length, 5);
});

/** `handOver`'s dependencies over a store and a window: the real executor, a drain through it. */
function handOverDeps(store: RequestStore, w: ReturnType<typeof fakeWindowPi>, sinks: EngineSinks, at = T0) {
	return { store, delivered: (row: Row) => w.executor.proof("s").has(row), produced: (row: Row) => w.executor.produced(row), drain: () => drain("s", store, w.executor, at, sinks) };
}

test("a hand-off while pi is busy prints the queued line; typed after Esc it runs before the clock's row", async () => {
	const { store, sinks } = world();
	const busy = fakeWindowPi(false);
	const row = recipeRow("describe the tracker", "daily", "tracker", to, T0);
	const out = await handOver(handOverDeps(store, busy, sinks), row);
	assert.deepEqual([out.written, out.result?.waiting, out.line], [true, [row.id], "queued: recipe daily runs after the current turn"], "the row was written by this very hand-over, so the line is its");
	assert.deepEqual(busy.sent, []);
	const again = await handOver(handOverDeps(store, busy, sinks), recipeRow("describe the tracker", "daily", "tracker", to, T0 + 1));
	assert.deepEqual([again.written, again.line], [false, undefined], "a second hand-off of the same recipe collapses and says nothing more");
	assert.deepEqual(store.list("s").map((r) => r.id), [row.id], "the first row is still the only one");

	// After Esc nothing is held: a claim typed then still takes the lane before the clock's row.
	const held = fakeWindowPi(true);
	held.executor.agentStarted(T0 - 5_000);
	held.executor.agentEnded();
	const stop = world();
	stop.store.append(turnRow("t1"));
	const typed = recipeRow("fix", "inb-9", "tracker", to, T0 + 2_000);
	const now = await handOver(handOverDeps(stop.store, held, stop.sinks, T0 + 3_000), typed);
	assert.deepEqual([now.result?.delivered, now.line, held.sent.map((s) => s.text)], [[typed.id], undefined, [typed.payload!.text]], "typed by the person: the claim runs now, before the clock's row");
	assert.deepEqual(now.result?.waiting, ["t1"], "one lane: the clock's row waits for the claim's turn, not for a minute");
	const push = pushRunRow("[Trigger p1] x", { traceId: "p1", idempotencyKey: "mcp:gh:tools", source: { kind: "mcp", serverName: "gh" } }, to, T0);
	const pushed = await handOver(handOverDeps(stop.store, fakeWindowPi(false), stop.sinks), push);
	assert.equal(pushed.line, "queued triggered turn (trace p1) after the current one");
});

test("a claim, a recipe hand-off, /new-trigger and a goal continuation carry their row's prefix, and the mark of the message pi writes is the proof", async () => {
	// Owner decision 2026-11-16: words pi-loops writes carry `[Trigger <id>]`, so a wrapped prompt is
	// known; only the person's message goes in their words alone. A row of these sources queued by an
	// earlier version has no prefix, so it is not required of them (`carriesPrefix`).
	for (const source of ["cron:j", "cron-run:j", "rule:x", "push:gh"] as const) assert.equal(carriesPrefix(source), true, source);
	for (const source of ["recipe:r", "new-trigger", "goal", "person"] as const) assert.equal(carriesPrefix(source), false, source);
	const { store, sinks } = world();
	const claim = recipeRow("Finding: disk is full", "inb-1", "tracker", to, T0);
	store.append(claim);
	const w = fakeWindowPi(true, { rows: () => store.list("s") });
	w.executor.produced(claim);
	let out = await drain("s", store, w.executor, T0, sinks);
	assert.deepEqual([out.delivered, w.sent.map((s) => s.text)], [[claim.id], [`[Trigger ${claim.id}] Finding: disk is full`]], "the row's prefix before the words pi-loops wrote");
	assert.equal(typeof store.list("s")[0].handed_at, "string", "stamped under the lock before the hand-over");
	// A message with the same words that is already in the conversation carries no mark and proves nothing; the one pi writes for it does.
	w.entries.push(userEntry(claim.payload!.text, T0 - 60_000));
	out = await drain("s", store, w.executor, T0 + 1_000, sinks);
	assert.deepEqual([out.removed, out.waiting], [[], [claim.id]], "an earlier message with the same words is not this claim's");
	w.executor.agentStarted(T0 + 2_000);
	w.writes(claim.payload!.text, T0 + 2_000);
	out = await drain("s", store, w.executor, T0 + 3_000, sinks);
	assert.deepEqual([out.removed, store.list("s")], [[claim.id], []], "done once pi wrote its message, with its mark");
	assert.equal(w.executor.view("s").inFlight.size, 0);
});

test("a hand-off's turn runs under the cap its own message names at message_start, so a short one never takes a longer one's turn", () => {
	const w = fakeWindowPi(true);
	const short = recipeRow("fix", "inb-1", "tracker", to, T0);
	const long = recipeRow("fix it and push --force", "daily", "tracker", to, T0);
	for (const r of [short, long]) w.executor.produced(r);
	w.executor.agentStarted(T0);
	w.executor.turn(long);
	w.executor.turn(short);
	w.starts(long.payload!.text);
	assert.deepEqual(w.executor.currentTurn(), { kind: "row", id: long.id, mode: "attended" }, '"fix" does not take the turn of "fix it and push --force"');
	assert.equal(w.executor.view("s").running?.requestId, long.id);
	w.starts(short.payload!.text);
	assert.deepEqual(w.executor.currentTurn(), { kind: "row", id: short.id, mode: "attended" });
	const goal = goalRow("The current /goal is not satisfied yet.", { condition: "c", iterations: 1, updatedAt: "t" }, to, T0);
	w.executor.produced(goal);
	w.executor.turn(goal);
	w.starts(goal.payload!.text);
	assert.deepEqual(w.executor.currentTurn(), { kind: "row", id: goal.id, mode: "attended" }, "a goal continuation names its row too");
});

test("a goal row is stale once the goal is cleared", async () => {
	const { store, sinks, audit } = world();
	let active = true;
	const withGoal: EngineSinks = { ...sinks, jobs: { exists: () => true, enabled: () => true, goalActive: () => active } };
	const g = goalRow("continue", { condition: "c", iterations: 1, updatedAt: "t" }, to, T0);
	store.append(g);
	const w = fakeWindowPi(false);
	await drain("s", store, w.executor, T0, withGoal);
	assert.deepEqual(store.list("s").map((r) => r.id), [g.id], "waits while pi is busy and the goal stands");
	active = false;
	const out = await drain("s", store, w.executor, T0, withGoal);
	assert.deepEqual(out.removed, [g.id]);
	assert.deepEqual(store.list("s"), [], "the continuation of a goal that is gone is not run");
	assert.deepEqual(w.sent, []);
	assert.deepEqual(audit.listAudit(10).filter((r) => r.traceId === g.id).map((r) => r.state), ["stale"]);
});

/** The rows the person types in the window with pid 11, and the clock's for the job. */
const by = (pid: number) => ({ ...to, createdBy: { pid, instance: `w${pid}`, procStart: `start-${pid}`, version: "0" } });

test("a claim typed in a viewer window runs there, not in the holder", async () => {
	const { store, sinks } = world();
	const claim = recipeRow("investigate", "inb-1", "tracker", by(11), T0);
	enqueue(store, claim);
	const holder = fakeWindowPi(true, { holds: true, self: { pid: 22, procStart: "start-22" } });
	const out = await drain("s", store, holder.executor, T0, sinks);
	assert.deepEqual([holder.sent, out.waiting], [[], [claim.id]], "the holder leaves it to the window it was typed in");
	assert.equal(store.list("s")[0].attempts, 0, "no attempt counted");
	const viewer = fakeWindowPi(true, { holds: false, self: { pid: 11, procStart: "start-11" } });
	assert.equal(viewer.executor.holds("s"), false);
	const mine = await drain("s", store, viewer.executor, T0, sinks);
	assert.deepEqual([viewer.sent.map((s) => s.text), mine.delivered], [[claim.payload!.text], [claim.id]], "the viewer runs its own claim without the lease");
	// A row of somebody else's is not the viewer's to touch: a cron row waits for the holder.
	const cron = turnRow("t1");
	store.append(cron);
	viewer.writes(claim.payload!.text, T0 + 1_000);
	const again = await drain("s", store, viewer.executor, T0, sinks);
	assert.deepEqual([again.delivered, again.removed, again.waiting], [[], [claim.id], []], "the viewer finishes its claim and does not see the cron row");
	assert.deepEqual(store.list("s").map((r) => r.id), [cron.id]);
	// The same process in `pi -p`: no lease is ever taken there, and its own claim still runs there.
	const print = fakeWindowPi(true, { holds: false, self: { pid: 11, procStart: "start-11" }, mode: "print" });
	const other = recipeRow("fix", "inb-2", "tracker", by(11), T0);
	enqueue(store, other);
	await drain("s", store, print.executor, T0, sinks);
	assert.deepEqual(print.sent.map((s) => s.text), [other.payload!.text]);
	// A producer whose pid was recycled is not the producer.
	const recycled = fakeWindowPi(true, { holds: false, self: { pid: 11, procStart: "start-later" } });
	assert.equal(recycled.executor.view("s").mine(claim), false);
	for (const r of [claim, other]) assert.equal(isLocal(r), true);
	assert.equal(isLocal(cron), false);
	assert.equal(isLocal(goalRow("p", { condition: "c", iterations: 1, updatedAt: "t" }, by(11), T0)), true);
});

test("a local row whose producer died is run by the holder", async () => {
	const { store, sinks } = world();
	const claim = recipeRow("investigate", "inb-1", "tracker", by(11), T0);
	enqueue(store, claim);
	let alive = true;
	const holder = fakeWindowPi(true, { holds: true, self: { pid: 22 }, alive: () => alive });
	await drain("s", store, holder.executor, T0, sinks);
	assert.deepEqual(holder.sent, [], "waits while the window it was typed in lives");
	alive = false;
	const out = await drain("s", store, holder.executor, T0, sinks);
	assert.deepEqual([holder.sent.map((s) => s.text), out.delivered], [[claim.payload!.text], [claim.id]], "the typing window is gone: the holder runs it");
});

test("a goal row is not removed as stale by a window that is not its producer", async () => {
	const { store, sinks } = world();
	const noGoal: EngineSinks = { ...sinks, jobs: { exists: () => true, enabled: () => true, goalActive: () => false } };
	const g = goalRow("continue", { condition: "c", iterations: 1, updatedAt: "t" }, by(11), T0);
	enqueue(store, g);
	const holder = fakeWindowPi(true, { holds: true, self: { pid: 22 } });
	const out = await drain("s", store, holder.executor, T0, noGoal);
	assert.deepEqual([out.removed, out.waiting, holder.sent], [[], [g.id], []], "the holder has no goal, and that says nothing about the producer's");
	const producer = fakeWindowPi(true, { holds: false, self: { pid: 11, procStart: "start-11" } });
	const judged = await drain("s", store, producer.executor, T0, noGoal);
	assert.deepEqual([judged.removed, producer.sent], [[g.id], []], "its producer, with the goal gone, drops it");
	assert.deepEqual(store.list("s"), []);
});

test("a claim typed while pi is busy runs before an older queued cron row once pi is idle", async () => {
	const { store, sinks } = world();
	const cron = turnRow("t1");
	store.append(cron);
	const w = fakeWindowPi(false);
	await drain("s", store, w.executor, T0 + 1_000, sinks);
	assert.deepEqual(w.sent, [], "the clock's row waits for the turn to end");
	const claim = recipeRow("investigate", "inb-1", "tracker", to, T0 + 2_000);
	enqueue(store, claim);
	w.executor.produced(claim);
	w.ctx.idle = true;
	const out = await drain("s", store, w.executor, T0 + 3_000, sinks);
	assert.deepEqual(w.sent.map((s) => s.text), [claim.payload!.text], "what the person typed goes first");
	assert.deepEqual([out.delivered, out.waiting], [[claim.id], [cron.id]]);
	assert.deepEqual(decideDrain("conversation", [cron, claim], none, jobs, view(), T0).map((a) => a.do === "turn" || a.do === "wait" ? `${a.do} ${a.row.id}` : a.do), [`turn ${claim.id}`, "wait t1"], "typed first, then oldest first");
});

test("a push collapsed onto a queued one is audited as collapsed", async () => {
	const { store } = world();
	const trigger = (traceId: string) => ({ traceId, idempotencyKey: "mcp:gh:custom:issue-7", source: { kind: "mcp" as const, serverName: "gh" } });
	const first = pushRunRow("[Trigger p1] issue", trigger("p1"), to, T0);
	const second = pushRunRow("[Trigger p2] issue", trigger("p2"), to, T0 + 1);
	assert.equal(enqueue(store, first), true);
	const written = enqueue(store, second);
	assert.equal(written, false, "collapsed under the lock that appends");
	assert.deepEqual(store.list("s").map((r) => r.id), ["p1"]);
	assert.equal(handOverTarget(written, { delivered: [] }, "p2"), "collapsed");
	assert.equal(handOverTarget(true, { delivered: ["p1"] }, "p1"), "chat");
	assert.equal(handOverTarget(true, { delivered: [] }, "p1"), "queued");
	assert.equal(handOverTarget(true, undefined, "p1"), "queued");
	// Another store on the same directory, the way a second process sees it.
	const twin = new RequestStore(store.dir);
	assert.equal(twin.appendIfAbsent(pushRunRow("[Trigger p3] issue", trigger("p3"), to, T0 + 2), { collapse: true }), false);
	assert.equal(twin.appendIfAbsent(pushRunRow("[Trigger p3] issue", trigger("p3"), to, T0 + 2)), true, "without collapse only the id is checked");
});

test("the window says when a row it produced waits, naming the row and its source", () => {
	assert.equal(waitingLine("push:gh", "abcdef0123"), "queued triggered turn (trace abcdef01) after the current one");
	assert.equal(waitingLine("cron:j1", "run-1", "nightly"), "queued: cron nightly runs after the current turn", "the clock's row, by the job's name");
	assert.equal(waitingLine("cron:j1", "run-1"), "queued: cron j1 runs after the current turn", "by its id when the caller has no name");
	assert.equal(waitingLine("cron-run:j1", "run-2", "nightly"), "queued: cron nightly runs after the current turn");
	assert.equal(waitingLine("recipe:daily", "x"), "queued: recipe daily runs after the current turn");
	assert.equal(waitingLine("new-trigger", "x"), "queued: /new-trigger runs after the current turn");
	assert.equal(waitingLine("goal", "goal-1"), undefined, "the goal printed its own notice");
});

test("WindowExecutor.turn announces cron and push turns, not a claim or a goal continuation", () => {
	const w = fakeWindowPi(true);
	w.executor.turn(turnRow("run-11111111"));
	w.executor.turn(pushRunRow("[Trigger trace-2222] x", { traceId: "trace-2222", idempotencyKey: "mcp:gh:tools", source: { kind: "mcp", serverName: "gh" } }, to, T0));
	assert.deepEqual(w.notices, ["running triggered turn (trace run-1111)", "running triggered turn (trace trace-22)"]);
	w.executor.turn(recipeRow("x", "inb-1", "tracker", to, T0));
	w.executor.turn(goalRow("x", { condition: "c", iterations: 1, updatedAt: "t" }, to, T0));
	w.executor.turn(recipeRow("x", "daily", "tracker", to, T0));
	w.executor.turn(newTriggerRow("x", to, T0));
	assert.equal(w.notices.length, 2, "the person's own rows and the goal keep the notices they print themselves");
	assert.equal(w.sent.length, 6, "every one was handed to pi");
});

test("dropContinuations: this instance's goal rows and a dead producer's go, a live other window's stay", () => {
	const { store } = world();
	const self = { pid: 11, procStart: "start-11" };
	const mine1 = goalRow("a", { condition: "c", iterations: 1, updatedAt: "t1" }, by(11), T0);
	const mine2 = goalRow("a", { condition: "c", iterations: 2, updatedAt: "t2" }, by(11), T0);
	const live = goalRow("a", { condition: "d", iterations: 1, updatedAt: "t1" }, by(22), T0);
	const dead = goalRow("a", { condition: "e", iterations: 1, updatedAt: "t1" }, by(33), T0);
	const claim = recipeRow("x", "inb-1", "tracker", by(11), T0);
	for (const r of [claim, mine1, live, dead, mine2]) store.append(r);
	const alive = (row: Row) => row.created_by.pid !== 33;
	assert.deepEqual(dropContinuations(store, "s", self, alive), [mine1.id, dead.id, mine2.id]);
	assert.deepEqual(store.list("s").map((r) => r.id), [claim.id, live.id], "the claim is not a continuation; the live window's goal is its own");
	assert.deepEqual(dropContinuations(store, "s", self, alive), [], "nothing left to drop");
	assert.deepEqual(dropContinuations(store, "s", { pid: 11, procStart: "start-later" }, alive), [], "a reused pid is not this instance");
	assert.equal(sameProducer({ pid: 11 }, self), true, "a writer with no start time is matched by pid");
	assert.equal(sameProducer({ pid: 11, procStart: "start-11" }, { pid: 11 }), true);
	assert.equal(sameProducer({ pid: 11, procStart: "x" }, self), false);
});

test("a local row whose producer moved to another conversation is run by the holder", async () => {
	const { store, sinks } = world();
	const me = { pid: process.pid, procStart: procStart(process.pid) };
	const claim = recipeRow("investigate", "inb-1", "tracker", { ...to, createdBy: { ...me, instance: "w", version: "0" } }, Date.now());
	enqueue(store, claim);
	const holder = fakeWindowPi(true, { holds: true, self: { pid: 22, procStart: "start-22" }, alive: producerAlive });
	await drain("s", store, holder.executor, Date.now(), sinks);
	assert.deepEqual(holder.sent, [], "this process is alive and on the conversation: the row is its");
	const producer = fakeWindowPi(true, { holds: false, self: me });
	assert.equal(producer.executor.view("s").mine(claim), true);
	// This process typed /new: still alive, bound elsewhere. It leaves its queued rows to the holder.
	assert.deepEqual(releaseLocalRows(store, "s", me, () => false, T0), [claim.id]);
	assert.deepEqual(releaseLocalRows(store, "s", me, () => false, T0), [], "marked once");
	const left = store.list("s")[0];
	assert.equal(Date.parse(left.created_by.left!), T0, "stamped when it left (in this machine's zone, as every stamp)");
	assert.equal(producer.executor.view("s").mine(left), false, "no longer the producer's, even if it comes back");
	assert.equal(producerAlive(left), false);
	const out = await drain("s", store, holder.executor, Date.now(), sinks);
	assert.deepEqual([out.delivered, holder.sent.map((s) => s.text)], [[claim.id], [claim.payload!.text]], "the holder runs it");
	const cron = turnRow("t1");
	store.append(cron);
	assert.deepEqual(releaseLocalRows(store, "s", { pid: 1 }, () => false, T0), [], "a plain job's row is nobody's to leave");
});

test("producerAlive: a dead pid, a reused pid, an unknown start time, a producer that left", () => {
	const probe = { alive: (pid: number) => pid !== 404, startTime: (pid: number) => (pid === 7 ? "B" : undefined), bootedAt: () => T0 };
	const r = (created_by: Row["created_by"], created_at = new Date(T0 + 1_000).toISOString()) => ({ created_by, created_at });
	assert.equal(producerAlive(r({ pid: 404, instance: "w", version: "0" }), probe), false, "dead pid");
	assert.equal(producerAlive(r({ pid: 7, instance: "w", version: "0", procStart: "A" }), probe), false, "reused pid: the process at 7 started at B");
	assert.equal(producerAlive(r({ pid: 7, instance: "w", version: "0", procStart: "B" }), probe), true);
	assert.equal(producerAlive(r({ pid: 9, instance: "w", version: "0", procStart: "X" }), probe), true, "start time unknown here, row from this boot: alive");
	assert.equal(producerAlive(r({ pid: 9, instance: "w", version: "0", procStart: "X" }, new Date(T0 - 120_000).toISOString()), probe), false, "start time unknown, row older than this boot: a previous boot's");
	assert.equal(producerAlive(r({ pid: 7, instance: "w", version: "0" }, new Date(T0 - 120_000).toISOString()), probe), false, "the row's writer had no start time: the same rule");
	assert.equal(producerAlive(r({ pid: 7, instance: "w", version: "0", procStart: "B", left: "2026-06-01T12:00:00Z" }), probe), false, "left the conversation");
});

test("an older rule result before a typed claim is appended without waking the agent", () => {
	const result = row("r1");
	const cron = turnRow("t1");
	const claim = recipeRow("x", "inb-1", "tracker", to, T0);
	const brief = (a: Action) => (a.do === "append" ? `append ${a.row.id} wake=${a.wakeAgent}` : a.do === "turn" || a.do === "wait" ? `${a.do} ${a.row.id}` : a.do);
	assert.deepEqual(decideDrain("conversation", [result, cron, claim], none, jobs, view(), T0).map(brief), ["append r1 wake=false", `turn ${claim.id}`, "wait t1"], "the result keeps its place and lands first, without a turn; the claim takes the first turn slot");
	assert.deepEqual(decideDrain("conversation", [cron, result, claim], none, jobs, view(), T0).map(brief), [`turn ${claim.id}`, "append r1 wake=true", "wait t1"], "a result queued after a turn slot is a follow-up, as before");
	assert.deepEqual(decideDrain("conversation", [result, claim], none, jobs, view({ idle: false }), T0).map(brief), ["append r1 wake=true", `wait ${claim.id}`]);
});

test("a window leaving a conversation removes a local row it already ran there instead of leaving it to the holder", () => {
	const { store } = world();
	const me = { pid: process.pid, procStart: procStart(process.pid) };
	const ran = recipeRow("investigate", "inb-1", "tracker", { ...to, createdBy: { ...me, instance: "w", version: "0" } }, Date.now());
	const waiting = newTriggerRow("make a rule", { ...to, createdBy: { ...me, instance: "w", version: "0" } }, Date.now());
	enqueue(store, ran);
	enqueue(store, waiting);
	// The claim's turn started here and its message is in this window's conversation; the holder's copy need not show it yet.
	assert.deepEqual(releaseLocalRows(store, "s", me, (row) => row.id === ran.id, T0), [waiting.id]);
	assert.deepEqual(store.list("s").map((row) => [row.id, row.created_by.left !== undefined]), [[waiting.id, true]], "the claim is gone, not handed to the holder to run again");
});

/** A seeded generator (mulberry32), so a failing run is the same run again. */
function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Five conversations, two producers, a bell that loses or repeats rings, an executor that is pi: a
 * row handed to it is written after a while, or dropped (Esc) once the agent has settled, so the
 * next drain offers it again. The tick is the floor.
 */
async function doorbellWorld(dropProbability: number, seed: number) {
	const { store, sinks } = world();
	const rand = seeded(seed);
	const TICK = 50;
	const MAX_DELAY = 20;
	const sessions = ["s1", "s2", "s3", "s4", "s5"];
	const written = new Map(sessions.map((s) => [s, new Map<string, number>()]));
	const inFlight = new Map(sessions.map((s) => [s, new Set<string>()]));
	const enqueuedAt = new Map<string, number>();
	const landedAt = new Map<string, number>();
	const executorMs = new Map<string, number>();
	const offers = new Map<string, number>();
	const sessionOf = new Map<string, string>();
	const failures: unknown[] = [];
	const executorFor = (sid: string): Executor => ({
		holds: () => true,
		proof: () => ({ has: (row) => written.get(sid)!.has(row.id), older: () => false, heldRunWrote: () => false, ran: () => undefined }),
		view: () => ({ kind: "window", ceiling: () => true, blocked: () => undefined, claimLive: () => false, idle: true, inFlight: inFlight.get(sid)!, connected: () => true, producerAlive: () => true, mine: () => true }),
		append: (r) => {
			inFlight.get(sid)!.add(r.id);
			offers.set(r.id, (offers.get(r.id) ?? 0) + 1);
			const handedAt = Date.now();
			const dropped = rand() < 0.3;
			setTimeout(() => {
				inFlight.get(sid)!.delete(r.id); // agent_settled: pi wrote it, or dropped it
				// Measured, not the nominal delay: a timer held back by the drains' synchronous file work
				// (every rewrite is fsynced) is the executor's time, not the engine's.
				executorMs.set(r.id, (executorMs.get(r.id) ?? 0) + (Date.now() - handedAt));
				if (dropped) return;
				written.get(sid)!.set(r.id, (written.get(sid)!.get(r.id) ?? 0) + 1);
				landedAt.set(r.id, Date.now());
			}, Math.floor(rand() * MAX_DELAY));
		},
		turn: () => {
			throw new Error("no turns here");
		},
		abort: () => undefined,
		abortWhenStarted: () => undefined,
	});
	const executors = new Map(sessions.map((s) => [s, executorFor(s)]));
	const drainNow = (sid: string) => drain(sid, store, executors.get(sid)!, Date.now(), sinks);
	const bell = (sid: string) => {
		const repeats = 1 + Math.floor(rand() * 10);
		for (let i = 0; i < repeats; i++) if (rand() >= dropProbability) drainNow(sid).catch((err) => failures.push(err));
	};
	// When each tick came and how long its drains ran (every rewrite is fsynced): the tick after an
	// enqueue starts within one span of it and hands the row over before its drains end, so a bound
	// in ticks has to be in this run's ticks.
	const tickAt: number[] = [Date.now()];
	let tickBusy = 0;
	const tick = setInterval(() => {
		const began = Date.now();
		tickAt.push(began);
		Promise.all(sessions.map(drainNow))
			.then(() => void (tickBusy = Math.max(tickBusy, Date.now() - began)))
			.catch((err) => failures.push(err));
	}, TICK);
	const producer = async (name: string, n: number) => {
		for (let i = 0; i < n; i++) {
			const sid = sessions[Math.floor(rand() * sessions.length)];
			const id = `${name}-${i}`;
			store.append(row(id, { lane: sid }));
			enqueuedAt.set(id, Date.now());
			sessionOf.set(id, sid);
			bell(sid);
			await sleep(Math.floor(rand() * 3));
		}
	};
	try {
		await Promise.all([producer("a", 100), producer("b", 100)]);
		const deadline = Date.now() + 3000;
		while (landedAt.size < 200 && Date.now() < deadline) await sleep(10);
		await sleep(TICK + MAX_DELAY);
	} finally {
		clearInterval(tick);
	}
	await Promise.all(sessions.map((sid) => drain(sid, store, executors.get(sid)!, Date.now(), sinks)));
	const tickSpan = Math.max(TICK, ...tickAt.slice(1).map((at, i) => at - tickAt[i]));
	return { store, tickSpan, tickBusy, written, enqueuedAt, landedAt, executorMs, offers, sessionOf, failures };
}

test("a lost or duplicated doorbell only changes timing", async () => {
	for (const [dropProbability, seed] of [
		[0, 1],
		[0.5, 2],
		[1, 3],
	] as const) {
		const w = await doorbellWorld(dropProbability, seed);
		const label = `drop ${dropProbability}, seed ${seed}`;
		assert.deepEqual(w.failures, [], label);
		assert.equal(w.landedAt.size, 200, `${label}: delivered = enqueued`);
		for (const [id, sid] of w.sessionOf) {
			assert.equal(w.written.get(sid)!.get(id), 1, `${label}: ${id} once in ${sid}`);
			for (const other of w.written.keys()) if (other !== sid) assert.equal(w.written.get(other)!.has(id), false, `${label}: ${id} only in ${sid}`);
		}
		assert.deepEqual(w.store.sessions(), [], `${label}: every row left the files`);
		if (dropProbability < 1) continue;
		// Every bell lost: the tick alone carries each row, so it is handed over by the tick after its
		// enqueue, and again by the tick after each drop, plus what the executor took.
		for (const [id, at] of w.landedAt) {
			const bound = w.offers.get(id)! * (w.tickSpan + w.tickBusy) + w.executorMs.get(id)!;
			assert.ok(at - w.enqueuedAt.get(id)! <= bound, `${label}: ${id} took ${at - w.enqueuedAt.get(id)!} ms, bound ${bound} (${w.offers.get(id)} offer(s), tick span ${w.tickSpan} ms, busy ${w.tickBusy} ms, executor ${w.executorMs.get(id)} ms)`);
		}
	}
});

test("a lost or duplicated doorbell only changes timing: the holder killed between hand-over and write, the next holder delivers once", async () => {
	const { store, sinks } = world();
	store.append(row("x"));
	let aAlive = true;
	// Window A hands the row to its pi and dies before pi writes it: the row stays in the file.
	const a = fakeExecutor({ holds: () => aAlive, deliver: (d) => (a.inFlight.add(d.id), void (aAlive = false)) });
	const first = await drain("s", store, a.executor, T0, sinks);
	assert.deepEqual([first.delivered, first.removed, store.list("s").map((r) => r.id)], [["x"], [], ["x"]]);
	// Window B now holds the conversation: its pi has nothing in flight, the conversation has no x.
	const b = fakeExecutor();
	await drain("s", store, b.executor, T0, sinks);
	await drain("s", store, b.executor, T0, sinks);
	await drain("s", store, a.executor, T0, sinks);
	assert.deepEqual([b.given, a.given, [...b.written]], [["x"], ["x"], ["x"]], "B wrote it once; A, dead, writes nothing more");
	assert.deepEqual(store.list("s"), []);
});

test("a stale stop is a no-op and never stops the next turn", async () => {
	const { store, sinks, audit } = world();
	const w = fakeWindowPi(false);
	w.executor.agentStarted(T0);
	// Asked while that turn ran; read only after it ended and the next one began.
	const stop = stopRow("s", { current: true, started_before: stamp(T0 + 5_000) }, "cli", { pid: 1, instance: "cli", version: "0" }, T0 + 5_000);
	store.append(stop);
	w.executor.agentEnded();
	w.executor.agentStarted(T0 + 20_000);
	const out = await drain("s", store, w.executor, T0 + 25_000, sinks);
	assert.equal(w.ctx.aborts, 0, "the next turn is not stopped");
	assert.deepEqual([out.removed, store.list("s")], [[stop.id], []]);
	assert.equal(audit.listAudit(1, (r) => r.type === "request" && r.traceId === stop.id)[0]?.state, "stale");
	// The same stop, read while the turn it was asked about still runs, stops that turn.
	const w2 = fakeWindowPi(false);
	w2.executor.agentStarted(T0);
	store.append(stop);
	await drain("s", store, w2.executor, T0 + 6_000, sinks);
	assert.equal(w2.ctx.aborts, 1);
	assert.equal(audit.listAudit(1, (r) => r.type === "request" && r.traceId === stop.id)[0]?.state, "done");
});

test("started_before compares times, not strings", () => {
	// 20:00+09:00 is 11:00Z: before 11:30Z as a time, after it as a string.
	const early = row("s4", { kind: "stop", source: "cli", target: { current: true, started_before: "2026-06-01T11:30:00Z" } });
	assert.deepEqual(decideDrain("conversation", [early], none, jobs, view({ running: { startedAt: "2026-06-01T20:00:00+09:00" } }), T0), [{ do: "abort", stop: early }, { do: "exit", row: early, exit: "delivered" }]);
	// 03:00-09:00 is 12:00Z: after 11:30Z as a time, before it as a string.
	const late = row("s5", { kind: "stop", source: "cli", target: { current: true, started_before: "2026-06-01T11:30:00Z" } });
	assert.deepEqual(decideDrain("conversation", [late], none, jobs, view({ running: { startedAt: "2026-06-01T03:00:00-09:00" } }), T0), [{ do: "exit", row: late, exit: "stale" }]);
});

test("a stop for a row pi has queued but not started aborts it when it starts", async () => {
	const { store, sinks, audit } = world();
	store.append(turnRow("t1"));
	const w = fakeWindowPi(true);
	await drain("s", store, w.executor, T0, sinks);
	assert.equal(w.sent.length, 1, "handed to pi");
	const stop = stopRow("s", { id: "t1" }, "cli", { pid: 1, instance: "cli", version: "0" }, T0);
	store.append(stop);
	await drain("s", store, w.executor, T0 + 1_000, sinks);
	assert.equal(w.ctx.aborts, 0, "not yet: pi has not started it");
	assert.deepEqual(store.list("s").map((r) => r.id), ["t1"], "the row stays while pi holds it; the stop is done");
	assert.equal(audit.listAudit(1, (r) => r.type === "request" && r.traceId === stop.id)[0]?.state, "done");
	w.executor.agentStarted(T0 + 2_000);
	w.executor.messageStarted({ role: "user", content: "[Trigger t1] hello" });
	assert.equal(w.ctx.aborts, 0, "a user message with its words is not it");
	const sentDetails = w.turns[0].details;
	w.writes("[Trigger t1] hello");
	assert.equal(w.ctx.aborts, 1, "aborted as its turn starts");
	w.executor.agentEnded();
	await drain("s", store, w.executor, T0 + 4_000, sinks);
	assert.deepEqual(store.list("s"), [], "pi wrote the turn's message, with its mark: the row is done, not offered again");
	w.executor.messageStarted({ role: "custom", customType: TURN_TYPE, content: "[Trigger t1] hello", display: true, details: sentDetails });
	assert.equal(w.ctx.aborts, 1, "armed once");
});

test("a cancel removes a queued row, which never runs", async () => {
	const { store, sinks, audit } = world();
	store.append(turnRow("t1"));
	const cancel = cancelRow("s", { id: "t1" }, "person", { pid: 1, instance: "web", version: "0" }, T0);
	store.append(cancel);
	const w = fakeWindowPi(true);
	const out = await drain("s", store, w.executor, T0, sinks);
	assert.deepEqual(w.sent, [], "never handed to pi");
	assert.deepEqual(out.removed.sort(), [cancel.id, "t1"].sort());
	assert.deepEqual(store.list("s"), []);
	const states = Object.fromEntries(audit.listAudit(10, (r) => r.type === "request").map((r) => [r.traceId, r.state]));
	assert.deepEqual(states, { t1: "cancelled", [cancel.id]: "done" });
	await drain("s", store, w.executor, T0 + 1_000, sinks);
	assert.deepEqual(w.sent, []);
});

test("heldTurnFor: an exact run id, a unique prefix, an ambiguous prefix refused, and leases that name no turn", () => {
	const probe = { alive: (pid: number) => pid !== 999, startTime: () => undefined, bootedAt: () => 0 };
	const lease = (sessionId: string, pid: number, runId: string) => ({ v: 1 as const, sessionId, epoch: 1, updatedAt: "2026-06-01T00:00:00Z", holder: { kind: "host" as const, pid, instance: "host", acquiredAt: "2026-06-01T00:00:00Z", pushServers: [], busy: { runId, since: "2026-06-01T00:00:00Z" } } });
	const leases = [lease("s1", 1, "run-aaaa0001"), lease("s2", 1, "run-aaaa0002"), lease("s3", 1, "run-bbbb0001"), lease("dead", 999, "run-dead0001"), lease("promo", 1, "tr-promo0001")];
	assert.deepEqual(heldTurnFor(leases, "run-aaaa0001", probe), { kind: "turn", sessionId: "s1", runId: "run-aaaa0001" }, "exact");
	assert.deepEqual(heldTurnFor(leases, "run-bbbb", probe), { kind: "turn", sessionId: "s3", runId: "run-bbbb0001" }, "a unique prefix");
	assert.deepEqual(heldTurnFor(leases, "run-aaaa", probe), { kind: "ambiguous", matches: ["run-aaaa0001", "run-aaaa0002"] }, "an ambiguous prefix names none");
	assert.equal(heldTurnFor(leases, "run-dead", probe), undefined, "a dead process's lease names no turn");
	assert.equal(heldTurnFor(leases, "tr-promo0001", probe), undefined, "a conversation held for a write is not a turn");
});

test("a stop for a conversation that is gone is stale, not a finding", async () => {
	const { store, sinks, inbox, audit } = world();
	store.append(row("in"));
	const stop = stopRow("s", { current: true, started_before: stamp(T0) }, "cli", { pid: 1, instance: "cli", version: "0" }, T0);
	store.append(stop);
	assert.deepEqual((await bury("s", store, sinks, "its conversation is gone")).sort(), ["in", stop.id].sort());
	assert.deepEqual(store.list("s"), []);
	assert.deepEqual(inbox.listNew().map((e) => e.run_id), ["in"], "the input is a finding; the stop has nothing to tell anyone");
	assert.equal(audit.listAudit(1, (r) => r.type === "request" && r.traceId === stop.id)[0]?.state, "stale");
	assert.equal(audit.listAudit(1, (r) => r.type === "request" && r.traceId === "in")[0]?.state, "dead");
});

test("a plain job's dead letter says why it was not delivered, before the prompt", async () => {
	// The finding used to be the job's prompt alone: the reason went to the audit, and `/inbox claim`
	// on it re-ran the prompt with nobody told it had failed.
	const { store, sinks, inbox } = world();
	store.append(turnRow("gone"));
	await bury("s", store, sinks, "its conversation is gone");
	store.append(turnRow("tried"));
	store.update("s", "tried", { attempts: DEAD_AFTER_ATTEMPTS, last_error: "pi did not start a turn for it" });
	await drain("s", store, fakeWindowPi(true).executor, T0, sinks);
	assert.deepEqual(inbox.listNew().map((e) => [e.run_id, e.text, e.undelivered]), [
		["gone", "could not be delivered (its conversation is gone): hello", true],
		["tried", `could not be delivered (failed ${DEAD_AFTER_ATTEMPTS} times: pi did not start a turn for it): hello`, true],
	]);
});

/** A window over a fake pi with the request file in a variable: `rows` is what the file holds now. */
function windowOver(opts: { hold?: () => boolean; throws?: () => boolean; mode?: "tui" | "rpc" } = {}) {
	const state = { rows: [] as Row[], sent: [] as string[], appended: [] as unknown[], aborts: 0 };
	const ctx = { mode: opts.mode ?? "tui", hasUI: false, isIdle: () => true, hasPendingMessages: () => false, abort: () => void state.aborts++, sessionManager: { getEntries: () => [] }, ui: { notify: () => undefined } } as any;
	const pi = { sendMessage: (message: unknown) => void state.appended.push(message), sendUserMessage: (text: string) => { if (opts.throws?.()) throw new Error("no model selected"); state.sent.push(text); } };
	const executor = new WindowExecutor(pi, { here: () => ({ sessionId: "s", holds: true }), hold: opts.hold ?? (() => true), letGo: () => undefined }, () => ctx, { pid: 1 }, () => true, () => state.rows, undefined, () => []);
	const ends = (text: string) => executor.messageEnded({ role: "user", content: text });
	/** The page queued a message of the person and rang this window for it. */
	const rung = (id: string, text: string): UnclaimedRow => {
		const made = personRow(id, text, undefined, { sessionId: "s", cwd: "/p", createdBy: { pid: 4242, instance: "page", version: "0" } }, T0);
		state.rows = [...state.rows, made];
		executor.produced(made);
		return made;
	};
	return { state, executor, ends, rung };
}

test("a proof reads the marks of its own lane only: a fork's entry with another lane's mark and this id proves nothing", () => {
	const t1 = { id: "t1", created_at: "2026-01-01T00:00:00.000Z" };
	const entry = (lane: string) => ({ type: "message", message: withMark({ role: "user", content: "[Trigger t1] hello" }, markFor({ lane, ...t1 } as Pick<Row, "lane" | "id" | "created_at">)) });
	assert.equal(proofOf("s", () => [entry("other")], () => []).has(t1), false);
	assert.equal(proofOf("s", () => [entry("s")], () => []).has(t1), true);
});

test("the person's own page message that a cancel named after its row left is aborted, and its mark names only that row's generation", () => {
	const w = windowOver({ mode: "rpc" });
	const p1 = w.rung("p1", "hello");
	w.executor.turn(p1, T0);
	w.executor.abortWhenStarted("p1");
	w.state.rows = [];
	w.executor.view("s");
	w.executor.agentStarted(T0 + 1);
	w.executor.messageStarted({ role: "user", content: "hello" }, T0 + 2);
	assert.equal(w.state.aborts, 1, "aborted as it starts");
	assert.deepEqual((w.ends("hello")?.message as { piLoopsRow?: unknown } | undefined)?.piLoopsRow, { lane: "s", id: "p1", at: p1.created_at, aborted: true }, "aborted: it proves no row p1 queued later");
});

test("a settle after a drain took the row out owes it no exit: the same row queued again is not cancelled by what pi did with the old prompt", () => {
	const w = windowOver();
	const t1 = turnRow("t1");
	w.state.rows = [t1];
	w.executor.turn(t1, T0);
	w.executor.abortWhenStarted("t1");
	w.state.rows = []; // the drain that asked for the abort took the row out; no look since
	w.executor.agentStarted(T0 + 1);
	assert.deepEqual(w.executor.settled(true), [], "Esc: nothing is gone for a row that left");
	w.state.rows = [t1];
	assert.equal(w.executor.view("s").gone?.get("t1"), undefined, "the same row, queued again, is not taken for stopped");
});

test("a person's page message pi was judged to have refused stays after its row left, and a late message with its text still carries its mark", () => {
	const w = windowOver({ mode: "rpc" });
	const p1 = w.rung("p1", "hello");
	w.executor.turn(p1, T0);
	w.executor.refused("p1");
	w.state.rows = []; // the page took it back
	w.executor.view("s");
	w.executor.agentStarted(T0 + 1);
	w.executor.messageStarted({ role: "user", content: "hello" }, T0 + 2);
	assert.deepEqual((w.ends("hello")?.message as { piLoopsRow?: unknown } | undefined)?.piLoopsRow, { lane: "s", id: "p1", at: p1.created_at });
});

test("a hand-over of the person's page message that pi throws at keeps the earlier one pi may still send late", () => {
	let throwing = false;
	const w = windowOver({ throws: () => throwing, mode: "rpc" });
	const p1 = w.rung("p1", "hello");
	w.executor.turn(p1, T0);
	w.executor.refused("p1");
	throwing = true;
	assert.throws(() => w.executor.turn(p1, T0 + 60_000));
	w.executor.agentStarted(T0 + 60_001);
	w.executor.messageStarted({ role: "user", content: "hello" }, T0 + 60_002);
	assert.deepEqual((w.ends("hello")?.message as { piLoopsRow?: unknown } | undefined)?.piLoopsRow, { lane: "s", id: "p1", at: p1.created_at }, "the late send of the first is proved");
});

test("Enter during a run in a terminal is a steer, written before what waits: a rewritten message then may be the steer, and gets no mark", () => {
	const w = fakeWindowPi(false);
	const goal = row("g1", { source: "goal", mode: "attended", wake: "turn", payload: { text: "keep going", cwd: "/" } });
	w.executor.agentStarted(T0);
	w.executor.messageStarted({ role: "user", content: "the run's own first message" }, T0); // the person's run, say
	w.executor.turn(goal, T0 + 1); // queued behind the run
	w.executor.inputSeen({ source: "interactive", text: "and check the logs", streamingBehavior: "steer" }, T0 + 2);
	w.executor.messageStarted({ role: "user", content: "[rewritten] keep going" }, T0 + 3);
	assert.equal(w.executor.messageEnded({ role: "user", content: "[rewritten] keep going" }), undefined, "the steer could be it: no mark for the goal's row");
});

test("a rewritten message with no prefix gets no mark while someone else's input waits, whatever pi's delivery of that input", () => {
	const at = (behind: "steer" | "followUp", source: "rpc" | "extension" | "interactive") => {
		const w = fakeWindowPi(false);
		const goal = row("g1", { source: "goal", mode: "attended", wake: "turn", payload: { text: "keep going", cwd: "/" } });
		w.executor.agentStarted(T0);
		w.executor.messageStarted({ role: "user", content: "the run's own first message" }, T0); // the person's run, say
		w.executor.turn(goal, T0 + 1); // queued behind the run
		w.executor.inputSeen({ source, text: "and check the logs", streamingBehavior: behind }, T0 + 2);
		w.executor.messageStarted({ role: "user", content: "[rewritten] keep going" }, T0 + 3);
		return w.executor.messageEnded({ role: "user", content: "[rewritten] keep going" });
	};
	assert.equal(at("steer", "rpc"), undefined, "the page's steer");
	assert.equal(at("steer", "extension"), undefined, "another extension's steer");
	assert.equal(at("followUp", "interactive"), undefined, "a terminal's follow-up (Alt+Enter): no order of pi is read");
});

test("a steer waiting as pi writes a refused prompt of ours late takes the message: a mark less, never one on a message that may be the person's", () => {
	const w = fakeWindowPi(true, { mode: "rpc" });
	const claim = row("c1", { source: "recipe:r", mode: "attended", wake: "turn", payload: { text: "address finding 1.", cwd: "/" } });
	w.executor.turn(claim, T0);
	w.executor.refused("c1"); // the grace passed; pi sends it late
	w.executor.agentStarted(T0 + 1);
	w.executor.inputSeen({ source: "rpc", text: "and the logs", streamingBehavior: "steer" }, T0 + 2);
	w.executor.messageStarted({ role: "user", content: "[rewritten] address finding 1." }, T0 + 3);
	assert.equal(w.executor.messageEnded({ role: "user", content: "[rewritten] address finding 1." }), undefined, "the steer could be it: no mark (the claim is offered again)");
});

test("an input pi refuses during a run (sent with no delivery) leaves nothing that could take a message", () => {
	const w = windowOver({ mode: "rpc" });
	const p1 = w.rung("p1", "keep going");
	w.executor.turn(p1, T0);
	w.executor.inputSeen({ source: "extension", text: "keep going" }, T0); // the echo of our own send
	w.executor.agentStarted(T0 + 1);
	w.executor.inputSeen({ source: "extension", text: "keep going" }, T0 + 2); // another extension, in the very same words: pi throws, already processing
	w.executor.messageStarted({ role: "user", content: "keep going" }, T0 + 3);
	assert.ok(w.ends("keep going"), "the person's message is marked: no waiting input of someone else took it");
});

test("the page's message that a run of ours overtook is still the person's: no mark of ours, and what follows it is their turn", () => {
	const w = fakeWindowPi(true, { mode: "rpc" });
	w.executor.inputSeen({ source: "rpc", text: "look" }, T0);
	const t1 = turnRow("t1");
	w.executor.turn(t1, T0 + 1);
	w.executor.agentStarted(T0 + 2);
	w.writes("[Trigger t1] hello", T0 + 3);
	assert.equal(w.executor.currentTurn()?.kind, "row", "our turn, under its cap");
	w.executor.messageStarted({ role: "user", content: "[rewritten] look" }, T0 + 4);
	assert.equal(w.executor.messageEnded({ role: "user", content: "[rewritten] look" }), undefined, "no mark of ours on the person's message");
	assert.deepEqual(w.executor.currentTurn(), { kind: "person" }, "a user message is the person's, whatever its words: no other extension's input was seen");
});

test("a follow-up of someone else that pi no longer holds (pi idle with nothing pending) takes no later message", () => {
	const w = windowOver({ mode: "rpc" });
	w.executor.agentStarted(T0);
	w.executor.inputSeen({ source: "extension", text: "another extension says hi", streamingBehavior: "followUp" }, T0 + 1);
	w.executor.agentEnded(); // the page cleared pi's queue: nothing pending, and pi idle
	w.executor.view("s");
	w.executor.inputSeen({ source: "interactive", text: "typed" }, T0 + 2); // the person types into the idle pi
	w.executor.agentStarted(T0 + 2);
	w.executor.messageStarted({ role: "user", content: "typed" }, T0 + 2);
	const p1 = w.rung("p1", "another extension says hi"); // the person's page message, in the words the cleared follow-up had
	w.executor.turn(p1, T0 + 3);
	w.executor.messageStarted({ role: "user", content: "another extension says hi" }, T0 + 4);
	assert.ok(w.ends("another extension says hi"), "the person's message is marked");
});

test("an append that cannot write the hold first sends nothing: lease-lost", () => {
	const w = windowOver({ hold: () => false });
	const r = row("r1");
	w.state.rows = [r];
	w.executor.agentStarted(T0); // a follow-up during a run takes the hold
	assert.equal(w.executor.append(r, true), "lease-lost");
	assert.deepEqual(w.state.appended, []);
});

test("a window that cannot write the hold first sends nothing: lease-lost, and the row stays as it was", () => {
	const w = windowOver({ hold: () => false });
	const t1 = turnRow("t1");
	w.state.rows = [t1];
	assert.equal(w.executor.turn(t1, T0), "lease-lost");
	assert.deepEqual(w.state.sent, []);
	assert.equal(w.executor.view("s").inFlight.has("t1"), false);
});

test("a stop for a row pi dropped removes it instead of starting it again", async () => {
	const { store, sinks, audit } = world();
	store.append(turnRow("t1"));
	const w = fakeWindowPi(true);
	await drain("s", store, w.executor, T0, sinks);
	assert.equal(w.sent.length, 1, "handed to pi");
	store.append(stopRow("s", { id: "t1" }, "cli", { pid: 1, instance: "cli", version: "0" }, T0));
	await drain("s", store, w.executor, T0 + 1_000, sinks);
	// A run started and Esc stopped it before its first message: pi dropped t1 without starting it.
	w.executor.agentStarted(T0 + 1_500);
	assert.deepEqual(w.executor.settled(true), ["t1"]);
	const out = await drain("s", store, w.executor, T0 + 2_000, sinks);
	assert.deepEqual([out.removed, w.sent.length, store.list("s")], [["t1"], 1, []], "removed, not offered again");
	assert.equal(audit.listAudit(1, (r) => r.type === "request" && r.traceId === "t1")[0]?.state, "cancelled");
	w.executor.agentStarted(T0 + 3_000);
	w.executor.messageStarted({ role: "user", content: "[Trigger t1] hello" });
	assert.equal(w.ctx.aborts, 0, "nothing stays armed for it");
});

/* ------------------------------------------------------------------ person rows (design §5) */

const page = { pid: 4242, instance: "page", version: "0" };
const fromPage = (id: string, text: string, at: number) => personRow(id, text, undefined, { sessionId: "s", cwd: "/p", createdBy: page }, at);

test("a person row of version 2 is done once a user message with its text follows its hand-over stamp, and pi's image note does not hide it", async () => {
	// pi appends a note to the text when it resizes or converts an image ("\n\n[Image: original …]"),
	// so the message starts with the row's text and need not equal it. The proof is read against
	// `handed_at`, the stamp the drain writes under the lock just before the hand-over: a "look" from
	// an hour ago, or from before the stamp, proves nothing, and a row never handed over is never done.
	const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
	const row = { ...personRow("p1", "look", [image], { sessionId: "s", cwd: "/p", createdBy: page }, T0), line: 2 as const };
	const note = "look\n\n[Image: original 2880x1800, displayed at 2000x1250. Multiply coordinates by 1.44 to map to original image.]";
	const entries: unknown[] = [userEntry("look", T0 - 3_600_000)];
	const conv = proofOf("s", () => entries, () => []);
	assert.equal(landed(row, conv), false, "never handed over: never done");
	const handed = { ...row, handed_at: stamp(T0 + 1_000) };
	assert.equal(landed(handed, conv), false, "a 'look' from an hour ago is not this delivery");
	entries.push(userEntry(note, T0 + 2_000));
	assert.equal(landed(handed, conv), true, "pi's note after the text is still this message");
	assert.equal(landed({ ...row, handed_at: stamp(T0 + 3_000) }, conv), false, "and never a message older than the stamp");
	// Through the drain, as a row of this version (the store writes no version 2 line): the stamp is
	// written as the row is handed over, and the message pi writes, with its mark and pi's note, removes it.
	const { store, sinks, audit } = world();
	store.append(row, [image]);
	const w = fakeWindowPi(true, { mode: "rpc", rows: () => store.list("s"), images: (r) => store.images(r) });
	w.executor.produced(row);
	await drain("s", store, w.executor, T0, sinks);
	const stampedAt = Date.parse(store.list("s")[0]?.handed_at ?? "");
	assert.ok(stampedAt >= T0 && stampedAt < T0 + 1_000, `stamped under the lock as it went, at the moment of the stamp (${stampedAt - T0} ms after the drain was asked for)`);
	w.executor.agentStarted(T0 + 500);
	w.writes(note, T0 + 500);
	const out = await drain("s", store, w.executor, T0 + 1_000, sinks);
	assert.deepEqual([out.removed, store.list("s"), w.sent.length], [["p1"], [], 1], "done, with no audit line, like a prefixed row");
	assert.equal(audit.listAudit(5, (r) => r.traceId === "p1").length, 0);
});

test("two identical messages are both sent and each is proved by its own entry", async () => {
	const { store, sinks } = world();
	const first = fromPage("p1", "yes", T0);
	const second = fromPage("p2", "yes", T0 + 1_000);
	store.append(first);
	store.append(second);
	const w = fakeWindowPi(true, { rows: () => store.list("s") });
	w.executor.produced(first);
	w.executor.produced(second);
	await drain("s", store, w.executor, T0 + 2_000, sinks);
	assert.deepEqual(w.sent.map((m) => m.text), ["yes"], "one lane: the first goes");
	// pi still reports idle (it defers a prompt sent while it emits agent_settled): the first is in
	// flight, and holds the lane until its message is in the conversation.
	let out = await drain("s", store, w.executor, T0 + 2_200, sinks);
	assert.deepEqual([w.sent.length, out.waiting], [1, ["p1", "p2"]], "a turn pi holds and has not written is the lane's");
	w.writes("yes", T0 + 2_500);
	out = await drain("s", store, w.executor, T0 + 3_000, sinks);
	assert.deepEqual([out.removed, out.delivered], [["p1"], ["p2"]], "the first is proved and the second goes, in one drain");
	assert.deepEqual(store.list("s").map((r) => [r.id, Date.parse(r.handed_at!) >= T0 + 3_000]), [["p2", true]], "the second waits for a message after its own stamp");
	out = await drain("s", store, w.executor, T0 + 4_000, sinks);
	assert.deepEqual([out.removed, w.sent.length], [[], 2], "the first's message does not prove the second");
	w.writes("yes", T0 + 4_500);
	out = await drain("s", store, w.executor, T0 + 5_000, sinks);
	assert.deepEqual([out.removed, store.list("s"), w.sent.length], [["p2"], [], 2], "both sent once, each proved by its own message");
});

test("a person row whose page is gone is not sent", async () => {
	const { store, sinks } = world();
	store.append(fromPage("p1", "are you there", T0));
	const w = fakeWindowPi(true, { alive: () => false, rows: () => store.list("s") });
	// Long past the wait for a ring: a dead page rings for nothing.
	const out = await drain("s", store, w.executor, T0 + 60_000, sinks);
	assert.deepEqual([w.sent, out.waiting], [[], ["p1"]], "no page to answer: it waits in the file");
	assert.equal(store.list("s").length, 1);
	const live = fakeWindowPi(true, { alive: () => true, rows: () => store.list("s") });
	await drain("s", store, live.executor, T0 + PERSON_RING_WAIT_MS, sinks);
	assert.deepEqual(live.sent.map((s) => s.text), ["are you there"], "sent once the page is there");
});

test("a person row waits for the page's ring, and goes capped once the wait is over", async () => {
	// The page appends, then rings; the file watcher fires on the append. Handed over at once, the
	// row would start before the ring that vouches for it, and the person's own message would ask
	// before `rm -rf`.
	const { store, sinks } = world();
	const row = fromPage("p1", "hello", T0);
	store.append(row);
	const w = fakeWindowPi(true, { rows: () => store.list("s") });
	let out = await drain("s", store, w.executor, T0 + 100, sinks);
	assert.deepEqual([w.sent, out.waiting], [[], ["p1"]], "not yet rung for");
	w.executor.produced(row);
	out = await drain("s", store, w.executor, T0 + 200, sinks);
	assert.deepEqual(w.sent.map((s) => s.text), ["hello"], "the ring came: handed over at once");
	const unrung = world();
	unrung.store.append(fromPage("p2", "hello", T0));
	const w2 = fakeWindowPi(true, { rows: () => unrung.store.list("s") });
	await drain("s", unrung.store, w2.executor, T0 + PERSON_RING_WAIT_MS - 1, unrung.sinks);
	assert.deepEqual(w2.sent, []);
	await drain("s", unrung.store, w2.executor, T0 + PERSON_RING_WAIT_MS, unrung.sinks);
	assert.deepEqual(w2.sent.map((s) => s.text), ["hello"], "nobody rang: handed over anyway, capped (test/guard.test.ts: a person row nobody rang for runs capped)");
});

test("a person row goes to pi as the person's message, images with it, and a person's rows take the lane first", async () => {
	const { store, sinks } = world();
	store.append(turnRow("t1"));
	const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
	const row = personRow("p1", "look", [image], { sessionId: "s", cwd: "/p", createdBy: page }, T0);
	store.append(row, [image]);
	assert.deepEqual(queueOrder(store.list("s")).map((r) => r.id), ["p1", "t1"]);
	const w = fakeWindowPi(true, { mode: "rpc", rows: () => store.list("s"), images: (r) => store.images(r) });
	w.executor.produced(row);
	await drain("s", store, w.executor, T0, sinks);
	assert.deepEqual(w.sent, [{ text: [{ type: "text", text: "look" }, image], options: { deliverAs: "followUp" } }], "the person's row first, as pi's own prompt takes it, the bytes read from beside the queue");
	// A row of this version is proved by its mark only, also one with no text.
	const current = { ...personRow("p2", "", [image], { sessionId: "s", cwd: "/p", createdBy: page }, T0), handed_at: stamp(T0 + 100) };
	const noteEntry = userEntry("\n\n[Image: original 2880x1800, displayed at 2000x1250. Multiply coordinates by 1.44 to map to original image.]", T0 + 200);
	assert.equal(landed(current, proofOf("s", () => [noteEntry], () => [])), false, "a message with no mark is not this row's");
	assert.equal(landed(current, proofOf("s", () => [{ ...noteEntry, message: withMark(noteEntry.message, markFor(current)) }], () => [])), true, "the message with its mark is");
	// A row of a version 2 line, queued before marks, with no text, is proved by a message with no
	// text of its own once pi's image notes are stripped, and by nothing else: not a cron turn, not
	// words the person typed in the terminal.
	const imageOnly = { ...current, line: 2 as const };
	assert.equal(landed(imageOnly, proofOf("s", () => [], () => [])), false);
	assert.equal(landed(imageOnly, proofOf("s", () => [userEntry("[Trigger abc] run the nightly check", T0 + 200)], () => [])), false, "a cron turn is not the person's image");
	assert.equal(landed(imageOnly, proofOf("s", () => [userEntry("look at this", T0 + 200)], () => [])), false, "nor are words typed in the terminal");
	assert.equal(landed(imageOnly, proofOf("s", () => [userEntry("\n\n[Image: original 2880x1800, displayed at 2000x1250. Multiply coordinates by 1.44 to map to original image.]", T0 + 200)], () => [])), true, "its own entry: pi's note and nothing else");
	assert.equal(landed(imageOnly, proofOf("s", () => [{ type: "message", timestamp: new Date(T0 + 200).toISOString(), message: { role: "user", content: [image] } }], () => [])), true, "or no text at all");
	assert.equal(stripImageNotes("fix\n\n[Image: original 2880x1800, displayed at 2000x1250. Multiply coordinates by 1.44 to map to original image.][Image omitted: could not be resized below the inline image size limit.]\n[Image converted from image/avif to image/png.]"), "fix");
	const alone = world();
	alone.store.append(personRow("p2", "", [image], { sessionId: "s", cwd: "/p", createdBy: page }, T0), [image]);
	const w2 = fakeWindowPi(true, { rows: () => alone.store.list("s"), images: (r) => alone.store.images(r) });
	const out = await drain("s", alone.store, w2.executor, T0 + PERSON_RING_WAIT_MS, alone.sinks);
	assert.deepEqual([out.dead, w2.sent.length], [[], 1], "an image alone is a message, not a dead letter");
	assert.deepEqual([w2.sent[0].text, w2.sent[0].options, w2.turns[0].details.cap.mode], [[{ type: "text", text: "" }, image], TURN_OPTIONS, "unattended"], "nobody rang for it: a custom message, capped, its image resized by the window before the send");
	// The bytes swapped under the row: the hand-over fails with the reason on the row, and nothing is sent as the person's.
	const swapped = world();
	const sw = personRow("p3", "look", [image], { sessionId: "s", cwd: "/p", createdBy: page }, T0);
	swapped.store.append(sw, [image]);
	fs.writeFileSync(swapped.store.imageFile("s", "p3"), JSON.stringify([{ ...image, data: "BBBB" }]));
	const w3 = fakeWindowPi(true, { mode: "rpc", rows: () => swapped.store.list("s"), images: (r) => swapped.store.images(r) });
	w3.executor.produced(sw);
	const refused = await drain("s", swapped.store, w3.executor, T0, swapped.sinks);
	assert.deepEqual([refused.failed, w3.sent.length], [["p3"], 0]);
	assert.match(swapped.store.list("s")[0]?.last_error ?? "", /not the ones it was written with/);
});

test("a person row pi refused gets last_error once pi stayed idle past the grace, and is never handed over again", async () => {
	const { store, sinks, audit } = world();
	const row = fromPage("p1", "hello", T0);
	store.append(row);
	const w = fakeWindowPi(true, { mode: "rpc", rows: () => store.list("s") });
	w.executor.produced(row);
	await drain("s", store, w.executor, T0, sinks);
	assert.equal(w.sent.length, 1, "handed over");
	let out = await drain("s", store, w.executor, T0 + PERSON_SEND_GRACE_MS - 1, sinks, { tick: true });
	assert.deepEqual([out.failed, out.waiting, w.sent.length], [[], ["p1"], 1], "within the grace pi may still be starting it");
	out = await drain("s", store, w.executor, T0 + PERSON_SEND_GRACE_MS + 3_000, sinks);
	assert.deepEqual([out.failed, out.waiting], [[], ["p1"]], "a drain that is not the tick (the one agent_settled runs, a bell) never judges it: pi defers a prompt sent while it emits agent_settled");
	out = await drain("s", store, w.executor, T0 + PERSON_SEND_GRACE_MS, sinks, { tick: true });
	assert.deepEqual(out.failed, ["p1"]);
	const left = store.list("s")[0];
	assert.equal(left?.last_error, "pi did not start a turn for it");
	assert.equal(left?.attempts, 1);
	assert.equal(audit.listAudit(1, (r) => r.type === "request" && r.traceId === "p1")[0]?.state, "failed");
	out = await drain("s", store, w.executor, T0 + 60_000, sinks, { tick: true });
	assert.deepEqual([out.waiting, w.sent.length], [["p1"], 1], "and it is not sent again: the page takes it back");
	assert.equal(w.executor.view("s").inFlight.has("p1"), false);

	// A slow first token is not a refusal: pi started a run before the grace passed.
	const slow = world();
	const slowRow = fromPage("p2", "slow", T0);
	slow.store.append(slowRow);
	const w2 = fakeWindowPi(true, { mode: "rpc", rows: () => slow.store.list("s") });
	w2.executor.produced(slowRow);
	await drain("s", slow.store, w2.executor, T0, slow.sinks);
	w2.executor.agentStarted(T0 + 200);
	w2.ctx.idle = false;
	out = await drain("s", slow.store, w2.executor, T0 + 30_000, slow.sinks, { tick: true });
	assert.deepEqual([out.failed, out.waiting], [[], ["p2"]]);
	w2.writes("slow", T0 + 30_500);
	w2.ctx.idle = true;
	out = await drain("s", slow.store, w2.executor, T0 + 31_000, slow.sinks);
	assert.deepEqual([out.removed, slow.store.list("s")], [["p2"], []], "landed late, done");

	// pi busy with no run of ours started (a compaction began as the row was handed over): not idle,
	// so not refused yet; it is judged once pi is idle again.
	const busy = world();
	const busyRow = fromPage("p3", "busy", T0);
	busy.store.append(busyRow);
	const w3 = fakeWindowPi(true, { rows: () => busy.store.list("s") });
	w3.executor.produced(busyRow);
	await drain("s", busy.store, w3.executor, T0, busy.sinks);
	w3.ctx.idle = false;
	out = await drain("s", busy.store, w3.executor, T0 + 30_000, busy.sinks, { tick: true });
	assert.deepEqual([out.failed, out.waiting], [[], ["p3"]], "pi is doing something: not a refusal");

	// A run that started after the hand-over (the person's own, from the terminal) took pi's queue
	// with our row in it: between its agent_end and agent_settled pi is idle, and that is not a
	// refusal either. If Esc dropped the row, settled() offers it again.
	const taken = world();
	const takenRow = fromPage("p4", "taken", T0);
	taken.store.append(takenRow);
	const w4 = fakeWindowPi(true, { rows: () => taken.store.list("s") });
	w4.executor.produced(takenRow);
	await drain("s", taken.store, w4.executor, T0, taken.sinks);
	w4.executor.agentStarted(T0 + 100);
	w4.executor.agentEnded();
	out = await drain("s", taken.store, w4.executor, T0 + 6_000, taken.sinks, { tick: true });
	assert.deepEqual([out.failed, out.waiting], [[], ["p4"]], "pi took a run since: not a refusal");
	assert.deepEqual(w4.executor.settled(true), ["p4"], "Esc dropped it with pi's queue: offered again");
	await drain("s", taken.store, w4.executor, T0 + 7_000, taken.sinks);
	assert.equal(w4.sent.length, 2);
});

test("after Stop, the person's queued rows run once pi is idle, oldest first, one lane", async () => {
	// Owner decision 2026-11-02: Stop stops the current turn only, as Esc does in the terminal. What
	// the person queued is theirs to cancel from the queue (the page's ✕), not held until they type.
	const { store, sinks } = world();
	const first = fromPage("p1", "first", T0);
	store.append(first);
	const w = fakeWindowPi(true, { rows: () => store.list("s") });
	w.executor.produced(first);
	w.executor.agentStarted(T0 - 5_000);
	w.executor.agentEnded();
	let out = await drain("s", store, w.executor, T0 + 1_000, sinks);
	assert.deepEqual([w.sent.map((s) => s.text), out.delivered], [["first"], ["p1"]], "the stopped run holds nothing of theirs");
	const second = fromPage("p2", "second", T0 + 2_000);
	store.append(second);
	w.executor.produced(second);
	out = await drain("s", store, w.executor, T0 + 3_000, sinks);
	assert.deepEqual([w.sent.length, out.waiting], [1, ["p1", "p2"]], "one lane: the next waits until pi has written the first");
	w.writes("first", T0 + 4_000);
	out = await drain("s", store, w.executor, T0 + 5_000, sinks);
	assert.deepEqual([w.sent.map((s) => s.text), out.removed, out.delivered], [["first", "second"], ["p1"], ["p2"]]);
	// The person's row and the clock's queued together after a Stop: the person's first, nothing held.
	const both = world();
	both.store.append(turnRow("t1"));
	both.store.append(fromPage("p3", "mine", T0));
	const w2 = fakeWindowPi(true, { rows: () => both.store.list("s") });
	w2.executor.produced(both.store.list("s")[1]);
	w2.executor.agentEnded();
	out = await drain("s", both.store, w2.executor, T0 + 1_000, both.sinks);
	assert.deepEqual([w2.sent.map((s) => s.text), out.waiting], [["mine"], ["t1"]]);
});

test("a terminal holder hands a page's row over when the ring wait ends, with no tick", { timeout: 20_000 }, async () => {
	// Owner decision O2: the ring goes to the page's pi, so a terminal that holds the session is
	// rung for nothing, and its next tick is up to 30 s away. The drain that waits for a ring says
	// when the wait ends; one timer per session drains then.
	const { store, sinks } = world();
	const now = Date.now();
	store.append(fromPage("p1", "from the page", now));
	const w = fakeWindowPi(true, { rows: () => store.list("s") });
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const out = await drain("s", store, w.executor, now, sinks);
	assert.deepEqual([w.sent, out.waiting, out.retryAt], [[], ["p1"], now + PERSON_RING_WAIT_MS], "waiting, and says until when");
	let fired = 0;
	// What the retried drain came to: it failed on a loaded runner once and the reason was dropped here.
	const results: string[] = [];
	const again = () => {
		fired++;
		drain("s", store, w.executor, Date.now(), sinks).then(
			(r) => void results.push(`drained at +${Date.now() - now} ms: ${JSON.stringify(r)}`),
			(err) => void results.push(`threw at +${Date.now() - now} ms: ${err?.stack ?? err}`),
		);
	};
	armRetry(timers, "s", 10, again);
	// The margin src/pi-loops.ts gives it: a timer may fire a millisecond before Date.now() reaches
	// retryAt, and a drain then still sees the ring wait running and hands nothing over.
	armRetry(timers, "s", out.retryAt! - Date.now() + 50, again);
	assert.equal(timers.size, 1, "one timer per session");
	const deadline = now + PERSON_RING_WAIT_MS + 8_000; // a loaded CI runner's timers, not a tick: there is none here
	while (!w.sent.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
	assert.deepEqual(w.sent.map((s) => s.text), ["from the page"], `handed over within the ring wait plus a margin, with no tick; fired ${fired}, ${results.join("; ") || "no drain finished"}`);
	assert.deepEqual([fired, timers.size], [1, 0], "the second arm replaced the first, which never fired; the timer is gone");
});

test("ringProduced believes a row only while the file still says what the ring said", () => {
	const row = fromPage("p1", "hello", T0);
	const produced: string[] = [];
	assert.equal(ringProduced([row], "p1", requestFingerprint(row), (r) => void produced.push(r.id)), true);
	assert.equal(ringProduced([row], "p1", requestFingerprint({ ...row, payload: { text: "hello.", cwd: "/p" } }), (r) => void produced.push(r.id)), false, "a fingerprint of other words");
	assert.equal(ringProduced([], "p1", requestFingerprint(row), (r) => void produced.push(r.id)), false, "a row that is gone");
	assert.deepEqual(produced, ["p1"]);
	assert.match(requestFingerprint(row), /^[0-9a-f]{32}$/, "one word on a command line");
	// The images are part of what was said: a swapped image is another message.
	const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
	const withImage = personRow("p1", "describe this", [image], { sessionId: "s", cwd: "/p", createdBy: page }, T0);
	const swapped = personRow("p1", "describe this", [{ ...image, data: "BBBB" }], { sessionId: "s", cwd: "/p", createdBy: page }, T0);
	assert.notEqual(requestFingerprint(withImage), requestFingerprint(swapped), "another image, another fingerprint");
	assert.notEqual(requestFingerprint(withImage), requestFingerprint(personRow("p1", "describe this", undefined, { sessionId: "s", cwd: "/p", createdBy: page }, T0)), "an image added, too");
	assert.equal(requestFingerprint(withImage), requestFingerprint({ ...withImage, handed_at: stamp(T0), created_at: stamp(T0 + 1) }), "the stamps are not part of it");
});

test("a hand-over stamp is the moment of the stamp, not the moment the drain was asked for", async () => {
	// Drains queue behind one another. The first here has a dead letter to write, which awaits the
	// inbox; the second was asked for at T0 and runs once the first is done. A message the person
	// typed in between must not prove the row the second one stamps.
	const { store, inbox, audit } = world();
	const slow: EngineSinks = { jobs: { exists: () => true, enabled: () => true, goalActive: () => true }, inbox: { append: async (entry) => { await new Promise((r) => setTimeout(r, 300)); return inbox.append(entry); }, appendOnce: async (entry, key) => { await new Promise((r) => setTimeout(r, 300)); return inbox.appendOnce(entry, key); } } as any, audit };
	store.append(row("dead", { attempts: 3 }));
	const mine = fromPage("p1", "yes", T0);
	store.append(mine);
	const w = fakeWindowPi(true, { rows: () => store.list("s") });
	w.executor.produced(mine);
	const first = drain("s", store, w.executor, T0, slow);
	const second = drain("s", store, w.executor, T0, slow);
	await Promise.all([first, second]);
	assert.deepEqual(w.sent.map((s) => s.text), ["yes"]);
	const stampedAt = Date.parse(store.list("s")[0]?.handed_at ?? "");
	assert.ok(stampedAt >= T0 + 250, `stamped when written, ${stampedAt - T0} ms after T0, not at T0`);
});

/* ------------------------------------------------------------- what pi does not write: refused, dropped, rewritten */

const plainBy = { pid: 1, instance: "w", version: "0" };
const plainJob = (over: { tools?: string[]; builtinTools?: string[] } = {}) => ({ id: "j1", sessionId: "s", prompt: "check CI", cwd: "/p", model: undefined, thinking: undefined, tools: undefined, builtinTools: undefined, ...over });
/** A window whose executor reads the request file, as the extension's does, so what the file no longer holds is forgotten with it. */
function windowOn(store: RequestStore, idle = true, mode: "tui" | "rpc" = "tui") {
	const sent: Array<{ text: string; options: unknown }> = [];
	const appended: Array<{ content: unknown; options: unknown }> = [];
	const entries: unknown[] = [];
	const ctx = { idle, mode, hasUI: false, isIdle: () => ctx.idle, abort: () => undefined, sessionManager: { getEntries: () => entries }, ui: { notify: () => undefined } } as any;
	const turns: CustomTurn[] = [];
	const pi = { sendMessage: (m: CustomTurn, options: unknown) => void (m.customType === TURN_TYPE ? (turns.push(m), sent.push({ text: m.content as string, options })) : appended.push({ content: m.content, options })), sendUserMessage: (text: string, options: unknown) => void sent.push({ text, options }) };
	const executor = new WindowExecutor(pi, { here: () => ({ sessionId: "s", holds: true }), hold: () => true, letGo: () => undefined }, () => ctx, { pid: 1 }, () => true, () => store.list("s"), undefined, () => []);
	/** Pi writes the custom turn the window sent with `text`. */
	const writes = (text: string, at = Date.now()): void => writesTurn(executor, entries, turns.splice(turns.findIndex((turn) => turn.content === text), 1)[0], at);
	return { sent, appended, entries, ctx, executor, turns, writes };
}

test("a damaged jobs.json costs only the rows that name a job: the person's message and a rule's result still arrive", async () => {
	const { store, audit } = world();
	const to = { sessionId: "s", cwd: "/p", createdBy: plainBy };
	const page = personRow("11111111-2222-3333-4444-555555555555", "hello from the browser", undefined, to, T0);
	const clock = plainJobRow(plainJob(), plainRunId("j1", "2026-06-01T12:00:00Z"), "cron:j1", "", plainBy, T0 + 1);
	store.append(page);
	store.append(clock);
	store.append(row("tr-1", { created_at: stamp(T0 + 2) }));
	// jobs.json is empty (a torn write) or from a newer pi-loops: JobStore.load() throws from every lookup.
	const broken: EngineSinks = { jobs: { exists: () => { throw new Error("jobs.json is empty; restore it from jobs.json.bak"); }, enabled: () => true, goalActive: () => true }, inbox: { appendOnce: async () => undefined, fileOnce: async () => undefined } as any, audit };
	const w = windowOn(store);
	const out = await drain("s", store, w.executor, T0 + 5_000, broken);
	assert.deepEqual([out.delivered.sort(), out.waiting], [[page.id, "tr-1"].sort(), [clock.id]], "the queue drains around the one row that cannot be judged");
	assert.deepEqual([w.sent.length, w.appended.length], [1, 1]);
	const why = decideDrain("conversation", store.list("s"), proofOf("s", () => [], () => []), broken.jobs, w.executor.view("s"), T0 + 5_000).find((a) => a.row?.id === clock.id);
	assert.equal(why?.do, "wait");
	assert.match((why as { why: string }).why, /^cannot read the jobs: jobs\.json is empty/);
});

test("a disabled job's queued prompt waits until the job is enabled again; /cron run's row of a job disabled since runs", async () => {
	const { store, inbox, audit } = world();
	const parked = plainJobRow(plainJob(), plainRunId("j1", "2026-06-01T12:00:00Z"), "cron:j1", "", plainBy, T0);
	store.append(parked);
	let enabled = false;
	const sinks: EngineSinks = { jobs: { exists: () => true, enabled: () => enabled, goalActive: () => true }, inbox, audit };
	const w = windowOn(store);
	let out = await drain("s", store, w.executor, T0, sinks);
	assert.deepEqual([out.delivered, out.waiting, w.sent.length], [[], [parked.id], 0], "a parked job's prompt is not handed to pi because a window opened the conversation");
	assert.deepEqual(decideDrain("conversation", store.list("s"), proofOf("s", () => [], () => []), sinks.jobs, w.executor.view("s"), T0).map((a) => (a.do === "wait" ? a.why : a.do)), ["its job is disabled"]);
	enabled = true;
	out = await drain("s", store, w.executor, T0 + 1, sinks);
	assert.deepEqual(out.delivered, [parked.id], "enabled again: it runs");
	// pi runs it and writes its prompt, with its mark: an idle pi gets one prompt of ours at a time.
	w.executor.agentStarted(T0 + 1);
	const message = { role: "user", content: w.sent[0].text };
	w.executor.messageStarted(message, T0 + 1);
	w.entries.push({ type: "message", message: w.executor.messageEnded(message, T0 + 1)?.message ?? message });
	w.executor.agentEnded();
	w.executor.settled();
	enabled = false;
	const asked = plainJobRow(plainJob(), plainRunId("j1", "2026-06-01T13:00:00Z"), "cron-run:j1", "", plainBy, T0 + 2);
	store.append(asked);
	out = await drain("s", store, w.executor, T0 + 3, sinks);
	assert.deepEqual(out.delivered, [asked.id], "the person asked for this one; /cron run itself refuses a job disabled when it is typed");
});

test("a recipe's merge-conflict hand-off is not collapsed by its tracker description still waiting; a second conflict hand-off is", async () => {
	const { store } = world();
	const to = { sessionId: "s", cwd: "/p", createdBy: plainBy };
	const busy = { store, delivered: () => false, produced: () => undefined, drain: async () => ({ delivered: [], removed: [], failed: [], dead: [], waiting: [] }) };
	const setup = await handOver(busy, recipeRow("[setup] describe this project's tracker", "triage", "tracker", to));
	const conflicts = await handOver(busy, recipeRow("[conflicts] resolve playbook.md with the person", "triage", "merge", to));
	const again = await handOver(busy, recipeRow("[conflicts] resolve agents.md with the person", "triage", "merge", to));
	assert.deepEqual([setup.written, conflicts.written, again.written], [true, true, false]);
	assert.deepEqual(store.list("s").map((r) => r.collapse_key), ["recipe:triage:tracker", "recipe:triage:merge"]);
});

test("after Esc, /cron run's row takes the lane before the clock's row, and nothing waits out a minute", async () => {
	const { store, sinks } = world();
	const clock = plainJobRow(plainJob(), plainRunId("j1", "2026-06-01T12:00:00Z"), "cron:j1", "", plainBy, T0);
	const asked = plainJobRow(plainJob(), plainRunId("j1", "2026-06-01T12:00:30Z"), "cron-run:j1", "", plainBy, T0 + 30_000);
	store.append(clock);
	store.append(asked);
	const w = windowOn(store);
	w.executor.agentStarted(T0 + 1_000);
	w.executor.agentEnded(); // Esc
	w.executor.settled();
	assert.equal(typedByPerson("cron-run:j1"), true);
	w.executor.produced(asked); // what the scheduler's onRowWritten hook does for the row /cron run wrote
	const out = await drain("s", store, w.executor, T0 + 31_000, sinks);
	assert.deepEqual([out.delivered, out.waiting], [[asked.id], [clock.id]], "typed by the person: theirs goes first; the clock's waits for the lane, not for a minute");
	assert.deepEqual(w.sent.map((s) => s.text), [asked.payload!.text]);
});

test("the background process leaves a goal continuation a quitting window left for a window", () => {
	const now = Date.now();
	const left = goalRow("[goal] keep going", { condition: "tests pass", iterations: 2, updatedAt: stamp(now) }, { sessionId: "s", cwd: "/x", createdBy: { ...plainBy, left: stamp(now) } }, now);
	// heldView in src/host-runtime.ts, and its sinks: goalActive is always false there.
	const host: ExecutorView = { kind: "held", ceiling: CEILING.held, blocked: (r) => (r.wake === "turn" ? "turn rows wait for a window" : undefined), claimLive: () => false, idle: true, inFlight: new Set(), connected: () => true, producerAlive: () => true, mine: () => false };
	assert.deepEqual(decideDrain("conversation", [left], proofOf("s", () => [], () => []), { exists: () => true, enabled: () => true, goalActive: () => false }, host, now).map((a) => a.do), ["wait"]);
});

test("a prompt runs once, under its row's cap, beside an extension that rewrites every user message: no input handler sees it", async () => {
	const { store, sinks, inbox } = world();
	const id = plainRunId("j1", "2026-06-01T12:00:00Z");
	store.append(plainJobRow(plainJob({ tools: ["read"] }), id, "cron:j1", "", plainBy, T0));
	const w = windowOn(store);
	const caps: unknown[] = [];
	let turns = 0;
	for (let cycle = 0; cycle < 6; cycle++) {
		const at = T0 + cycle * 60_000;
		const out = await drain("s", store, w.executor, at, sinks);
		if (!out.delivered.length) continue;
		turns++;
		// pi runs the turn. Another extension's `input` handler prepends a note to every user message;
		// the turn is a custom message, which pi gives to no `input` handler: it is written as it was sent.
		w.executor.agentStarted(at + 1);
		w.writes(w.sent.at(-1)!.text, at + 2);
		caps.push(w.executor.currentTurn());
		w.executor.agentEnded();
		w.executor.settled();
	}
	assert.equal(turns, 1, "it ran, and its mark is in the entry: offered again it would run a second time, with whatever side effects it has");
	assert.deepEqual(caps, [{ kind: "row", id, mode: "unattended", tools: ["read"] }], "under the row's cap, read from the message");
	assert.deepEqual(store.list("s"), [], "the row is gone");
	assert.equal(inbox.listNew().length, 0, "and a run that happened is not a dead letter");
});

test("the person's page message is judged refused only after the grace has passed since pi's last input, not since the hand-over; a turn row's custom message is never judged so", async () => {
	const { store, sinks } = world();
	const id = "11111111-2222-3333-4444-555555555555";
	const person = personRow(id, "look", undefined, { sessionId: "s", cwd: "/p", createdBy: { pid: process.pid, instance: "page", version: "0" } }, T0);
	store.append(person);
	const w = windowOn(store, true, "rpc");
	w.executor.produced(person);
	assert.deepEqual((await drain("s", store, w.executor, T0, sinks)).delivered, [id]);
	w.executor.inputSeen({ source: "extension", text: "look" }, T0 + 8_000); // pi emitted `input` for our prompt: it is in its pre-run phase
	let out = await drain("s", store, w.executor, T0 + 8_000 + PERSON_SEND_GRACE_MS - 1, sinks, { tick: true });
	assert.deepEqual([out.failed, out.waiting], [[], [id]], "past the grace since the hand-over, not since the input");
	out = await drain("s", store, w.executor, T0 + 8_000 + PERSON_SEND_GRACE_MS, sinks, { tick: true });
	assert.deepEqual(out.failed, [id]);
	const left = store.list("s")[0];
	assert.deepEqual([left.attempts, left.last_error], [1, "pi did not start a turn for it"], "it keeps its error for the page to take back");
	assert.equal(w.executor.view("s").inFlight.has(id), false);
	assert.equal(PERSON_SEND_GRACE_MS, 10_000, "pi's pre-run phase after its input event (other input handlers, the credential check) is what is left to cover");
	// The clock's prompt goes as a custom message: pi starts its run or says why not, so no tick judges it.
	const clock = world();
	const run = plainRunId("j1", "2026-06-01T12:00:00Z");
	clock.store.append(plainJobRow(plainJob(), run, "cron:j1", "", plainBy, T0));
	const c = windowOn(clock.store);
	assert.deepEqual((await drain("s", clock.store, c.executor, T0, clock.sinks)).delivered, [run]);
	out = await drain("s", clock.store, c.executor, T0 + 3_600_000, clock.sinks, { tick: true });
	assert.deepEqual([out.failed, out.waiting, clock.store.list("s")[0].attempts], [[], [run], 0]);
});

test("what this window produced is forgotten with the row: an id that left the file is not believed if it comes back", () => {
	const { store } = world();
	const to = { sessionId: "s", cwd: "/p", createdBy: { pid: 4242, instance: "page", version: "0" } };
	const r = personRow("p1", "hi", undefined, to, T0);
	const w = windowOn(store);
	store.append(r);
	w.executor.produced(r);
	assert.equal(w.executor.view("s").believed!(r), true);
	store.remove("s", ["p1"]);
	w.executor.view("s");
	// The only way to see the entry go: a window open for weeks must not keep one per slot it ever produced.
	store.append(r);
	assert.equal(w.executor.view("s").believed!(r), false);
});

test("a dead letter's text is read back as why and the prompt, so a claim asks for the prompt, not an investigation", () => {
	const text = deadLetterText("pi did not start a turn for it", "[Trigger run-1] check CI");
	assert.deepEqual(deadLetterParts({ text, undelivered: true }), { why: "pi did not start a turn for it", prompt: "[Trigger run-1] check CI" });
	assert.equal(deadLetterParts({ text: "a finding a loop reported", undelivered: true }), undefined, "any other text is left as it is");
	assert.equal(deadLetterParts({ text }), undefined, "and the text alone is not a dead letter: a loop can write it");
});

test("a turn that sorts first is not handed to an idle pi that holds another prompt of ours unstarted (#245)", () => {
	// The goal's continuation is with an idle pi that no run has taken up (`inFlightSince`): it has the lane. The person's message
	// sorts before it (`queueOrder`), so it was decided before the lane was known to be taken.
	const held = row("g1", { source: "goal", mode: "attended", wake: "turn", payload: { text: "keep going", cwd: "/" }, handed_at: "2026-01-01T00:00:00Z" });
	const person = row("p1", { source: "person", mode: "attended", wake: "turn", payload: { text: "hello", cwd: "/" } });
	for (const fileOrder of [[held, person], [person, held]]) {
		const actions = decideDrain("conversation", fileOrder, none, jobs, view({ inFlight: new Set(["g1"]), inFlightSince: new Map([["g1", T0]]) }), T0);
		assert.deepEqual(actions.map((a) => [a.do, "row" in a ? a.row.id : "", "why" in a ? a.why : ""]), [["wait", "p1", "pi is busy"], ["wait", "g1", "handed to pi, not yet in the conversation"]]);
	}
	// An append row beside it is still written, and wakes the agent only when it comes after the held turn, as before.
	const result = row("r1");
	assert.deepEqual(decideDrain("conversation", [result, held], none, jobs, view({ inFlight: new Set(["g1"]), inFlightSince: new Map([["g1", T0]]) }), T0).map((a) => [a.do, "row" in a ? a.row.id : "", "wakeAgent" in a ? a.wakeAgent : ""]), [["append", "r1", false], ["wait", "g1", ""]]);
	assert.deepEqual(decideDrain("conversation", [held, result], none, jobs, view({ inFlight: new Set(["g1"]), inFlightSince: new Map([["g1", T0]]) }), T0).map((a) => [a.do, "row" in a ? a.row.id : "", "wakeAgent" in a ? a.wakeAgent : ""]), [["wait", "g1", ""], ["append", "r1", true]]);
});

/* ------------------------------------------------------------------ a row a run has claimed */

/** A turn row a background run has claimed: a plain job's slot, its prompt not written yet. */
const claimedRow = (id: string, over: Partial<UnclaimedRow> = {}): ClaimedRow => ({ ...row(id, { wake: "turn", source: "cron:j", mode: "unattended", payload: { text: `[Trigger ${id}] go`, cwd: "/p" }, ...over }), run: { id: `run-${id}`, pid: 4242, started_at: "2026-06-01T11:59:00Z" } });
const proofThat = (over: Partial<Proof>): Proof => ({ ...none, ...over });
const gone = { claimLive: () => false };
/** The run record of the claim that `claimedRow` and `claimIn` make: its run id and its start. */
const recordOf = (id: string, over: Partial<RunRecord> = {}): RunRecord => ({ runId: `run-${id}`, jobId: "j", stateful: false, cwd: "/p", pid: 4242, startedAt: "2026-06-01T11:59:00Z", finishedAt: "2026-06-01T12:00:00Z", ok: true, findings: 0, droppedFindings: 0, stateUpdated: false, ...over });
const ENDED = recordOf("c1");
const FAILED = recordOf("c1", { ok: false, error: "boom" });
const STOPPED = recordOf("c1", { ok: false, aborted: true, stoppedBy: "person" });
const HANDED_BACK = recordOf("c1", { ok: false, aborted: true });
const ENDS = [undefined, ...[ENDED, FAILED, STOPPED, HANDED_BACK, recordOf("c1", { ok: false, interrupted: true })].map(runEnd)];

test("[2.1-1] a row whose run is still going waits as running and has the lane, whatever the records say and wherever it sorts", () => {
	const running = claimedRow("c1");
	const turn = row("t2", { wake: "turn", source: "cron:j", mode: "unattended", payload: { text: "[Trigger t2] go", cwd: "/p" } });
	const result = row("a3");
	for (const end of ENDS) {
		for (const rows of [[running, turn, result], [turn, running, result]]) {
			const actions = decideDrain("conversation", rows, proofThat({ ran: (r) => (r.id === "c1" ? end : undefined) }), jobs, view({ claimLive: () => true }), T0);
			const by = Object.fromEntries(actions.map((a) => ["row" in a ? a.row.id : "", a]));
			assert.deepEqual(by.c1, { do: "wait", row: running, why: "running" }, `${end?.how}`);
			assert.deepEqual(by.t2, { do: "wait", row: turn, why: "pi is busy" }, "no turn is started beside a run, before it or after it");
			assert.equal(by.a3.do, "append", "a result is still written");
		}
	}
	// A held turn's prompt is in the conversation while its run is still going: the row waits for the run, it is not delivered yet.
	assert.deepEqual(decideDrain("conversation", [running], proofThat({ has: () => true, ran: () => runEnd(ENDED) }), jobs, view({ claimLive: () => true }), T0), [{ do: "wait", row: running, why: "running" }]);
	// An append after the running row wakes the agent; one before it does not, as with a turn pi holds.
	assert.deepEqual(decideDrain("conversation", [running, result], none, jobs, view({ claimLive: () => true }), T0)[1], { do: "append", row: result, wakeAgent: true });
	assert.deepEqual(decideDrain("conversation", [result, running], none, jobs, view({ claimLive: () => true }), T0)[0], { do: "append", row: result, wakeAgent: false });
});

test("[2.1-2] a row whose run's process is gone gets one action, the closing of its run, and never a hand-over or a bare exit", () => {
	for (const end of ENDS) {
		for (const written of [false, true]) {
			const row = claimedRow("c1");
			assert.deepEqual(decideDrain("conversation", [row], proofThat({ ran: () => end, has: () => written }), jobs, view(gone), T0), [{ do: "close", row }], `${end?.how} ${written}`);
		}
	}
	// A row that is past its attempts, has no text, or names a job that is gone is still closed first.
	for (const over of [{ attempts: 5 }, { payload: { text: "", cwd: "/p" } }]) assert.equal(decideDrain("conversation", [claimedRow("c1", over)], none, jobs, view(gone), T0)[0].do, "close");
	assert.equal(decideDrain("conversation", [claimedRow("c1")], none, { ...jobs, exists: () => false }, view(gone), T0)[0].do, "close");
});

/** An executor that must hand nothing over: nothing is alive, and a hand-over throws. */
function closingExecutor(proof: Partial<Proof> = {}): Executor {
	const never = () => {
		throw new Error("a row was handed over");
	};
	return { holds: () => true, proof: () => proofThat(proof), view: () => view(gone), append: never, turn: never, abort: () => undefined, abortWhenStarted: () => undefined, refused: () => undefined };
}

/** A world whose closing can write: a run log, and the jobs the rows name (`j`, a recurring plain job; `null` for a job that is gone). */
function closingWorld(job: Record<string, unknown> | null = { id: "j", sessionId: "s", prompt: "go", cwd: "/p", schedule: { kind: "every", ms: 60_000 }, enabled: true, stateful: false }) {
	const w = world();
	const runs: RunRecord[] = [];
	const jobsList = job ? [{ ...job }] : [];
	const entries: unknown[] = [];
	const log: string[] = [];
	w.sinks.ledger = {
		load: () => jobsList as any,
		disable: async (id: string, disabled: any) => {
			const found: any = jobsList.find((j) => j.id === id);
			if (!found) return undefined;
			log.push(`job, the row ${w.store.list("s").some((r) => r.run) ? "claimed" : "changed"}`);
			if (found.enabled) Object.assign(found, { enabled: false, disabled });
			return found as any;
		},
		appendRun: (record: RunRecord) => {
			log.push(`record, the row ${w.store.list("s").some((r) => r.run) ? "claimed" : "changed"}`);
			runs.push(record);
		},
	};
	w.sinks.counts = (id: string) => jobCounts(runHistory(runs).get(id), undefined);
	w.sinks.self = () => ({ pid: 7, instance: "test", version: "0" });
	/** The prompt of row `id`, as the runner writes it into the conversation. */
	/** Pi wrote the prompt of row `id`: with its mark when a window gave it pi (`marked`), with none when a held turn of the background did. */
	const written = (id: string, marked = false) => {
		const message = { role: "user", content: `[Trigger ${id}] go` };
		const queued = w.store.list("s").find((r) => r.id === id);
		entries.push({ type: "message", timestamp: "2026-06-01T11:59:30Z", message: marked && queued ? withMark(message, markFor(queued)) : message });
	};
	/** An executor for a queue with claimed rows: nothing is alive, and it must hand nothing over. Its proof is the real one, over this world's conversation and run log. */
	const never = () => {
		throw new Error("a claimed row was handed over");
	};
	const executor: Executor = { holds: () => true, proof: () => proofOf("s", () => entries, () => runs), view: () => view(gone), append: never, turn: never, abort: () => undefined, abortWhenStarted: () => undefined, refused: () => undefined };
	const requestAudit = () => w.audit.listAudit(10, (r) => r.type === "request").map((r) => [r.state, r.traceId]);
	/** The job as the lists show it: its failures, last error and last completion are the run log's. */
	const status = () => listedJob(jobsList[0] as any, undefined, [], runHistory(runs).get("j")).status;
	return { ...w, runs, jobsList, entries, log, written, executor, requestAudit, status, job: () => jobsList[0] as any };
}
const claimIn = (store: RequestStore, id: string, over: Partial<UnclaimedRow> = {}): void => {
	store.append(row(id, { wake: "turn", source: "cron:j", mode: "unattended", collapse_key: "cron:j", payload: { text: `[Trigger ${id}] go`, cwd: "/p" }, ...over }));
	assert.equal(store.claim("s", id, { id: `run-${id}`, pid: 4242, started_at: "2026-06-01T11:59:00Z" }), true);
};

test("[2.1-3] [ended-by-record] a closed run that ended, or whose prompt is in the conversation, lets its row leave as delivered: a run that ended spends its slot, written or not", async () => {
	for (const record of [ENDED, FAILED, STOPPED, HANDED_BACK, undefined]) {
		const w = closingWorld();
		claimIn(w.store, "c1");
		if (record) w.runs.push(record);
		w.written("c1");
		const out = await drain("s", w.store, w.executor, T0, w.sinks);
		assert.deepEqual([w.store.list("s").filter((r) => r.id === "c1"), out.removed, out.failed], [[], ["c1"], []], `${record ? runEnd(record).how : "no record"}`);
		assert.deepEqual(w.requestAudit(), [], "a delivered input's record is its session");
	}
	// The run ended, and its prompt is not in the conversation: the slot is spent all the same. The
	// record is in the run log, and a failure is the job's; the row is not tried again.
	for (const record of [ENDED, FAILED]) {
		const w = closingWorld();
		claimIn(w.store, "c1", { attempts: 1 });
		w.runs.push(record);
		const out = await drain("s", w.store, w.executor, T0, w.sinks);
		assert.deepEqual([w.store.list("s"), out.removed, out.failed, w.requestAudit(), w.status().streak], [[], ["c1"], [], [], record.ok ? 0 : 1], runEnd(record).how);
	}
	// A run that did not end is delivered only by its prompt: stopped, handed back and cut off each keep the row or exit otherwise.
	for (const record of [STOPPED, HANDED_BACK, undefined]) {
		const w = closingWorld();
		claimIn(w.store, "c1");
		if (record) w.runs.push(record);
		const out = await drain("s", w.store, w.executor, T0, w.sinks);
		assert.deepEqual(out.removed.length + w.store.list("s").length, 1);
		assert.notDeepEqual([out.removed, w.requestAudit()], [["c1"], []], `${record ? runEnd(record).how : "no record"}: not a delivery`);
	}
	// A lane whose session is new each time has no conversation to look in: there the record of a run that ended proves the row.
	const lane = `@cron-${"0".repeat(32)}`;
	for (const [record, leaves] of [[ENDED, true], [FAILED, true], [HANDED_BACK, false]] as const) {
		const loop = closingWorld();
		loop.store.append(row("c1", { lane, wake: "turn", source: `cron:cron-${"0".repeat(32)}`, mode: "unattended", payload: { text: "[Trigger c1] go", cwd: "/p" } }));
		assert.equal(loop.store.claim(lane, "c1", { id: "run-c1", pid: 4242, started_at: "2026-06-01T11:59:00Z" }), true);
		loop.runs.push(record);
		await drain(lane, loop.store, loop.executor, T0, loop.sinks);
		assert.equal(loop.store.list(lane).length, leaves ? 0 : 1, runEnd(record).how);
	}
});

test("[2.1-4] [exit-stopped] [R4] a run a person stopped before its prompt was written spends its slot: the row leaves as stopped, and no attempt and no failure are counted", async () => {
	const w = closingWorld();
	w.runs.push({ ...FAILED, runId: "run-earlier", error: "earlier", finishedAt: "2026-06-01T11:58:00Z" });
	claimIn(w.store, "c1", { attempts: 1 });
	w.runs.push(STOPPED);
	const out = await drain("s", w.store, w.executor, T0, w.sinks);
	assert.deepEqual([w.store.list("s"), out.removed, out.failed, out.dead], [[], ["c1"], [], []]);
	assert.deepEqual(w.requestAudit(), [["stopped", "c1"]]);
	assert.equal(w.inbox.list().length, 0, "a stop is no failure and no dead letter");
	assert.deepEqual([w.status().streak, w.status().error, w.status().completed, w.job().enabled], [1, "earlier", STOPPED.finishedAt, true], "the streak and the last error stay");
});

test("[2.1-5] [R4] a run that was handed back with no prompt written leaves its row owed: the claim is cleared, and nothing is counted", async () => {
	const w = closingWorld();
	claimIn(w.store, "c1", { attempts: 1 });
	w.runs.push(HANDED_BACK);
	const out = await drain("s", w.store, w.executor, T0, w.sinks);
	const [left] = w.store.list("s");
	assert.deepEqual([left.id, left.run, left.attempts, left.not_before], ["c1", undefined, 1, undefined]);
	assert.deepEqual([out.waiting, out.removed, out.failed, out.dead], [["c1"], [], [], []]);
	assert.deepEqual(w.requestAudit(), []);
	assert.equal(w.inbox.list().length, 0);
	assert.deepEqual([w.status().streak, w.status().completed, w.log], [0, undefined, []], "a hand-back counts nothing and writes no job");
});

test("[settle-successor] a run that was handed back with its prompt written is delivered, and one successor row asks again: once, also when the closing runs twice", async () => {
	const w = closingWorld();
	claimIn(w.store, "c1");
	w.runs.push(HANDED_BACK);
	w.written("c1");
	// The successor is written while the row still has its claim: a process that stops between the two leaves the claim, and the closing runs again.
	const append = w.store.appendIfAbsent.bind(w.store);
	const claimedAtAppend: unknown[] = [];
	w.store.appendIfAbsent = (...args) => {
		claimedAtAppend.push(w.store.list("s").find((r) => r.id === "c1")?.run?.id);
		return append(...args);
	};
	await drain("s", w.store, w.executor, T0, w.sinks);
	assert.deepEqual(claimedAtAppend, ["run-c1"]);
	const next = plainRunId("j", "after c1");
	const [successor] = w.store.list("s");
	assert.deepEqual([w.store.list("s").length, successor.id, successor.source, successor.run, successor.attempts, successor.collapse_key, successor.payload?.text, successor.created_by.pid], [1, next, "cron:j", undefined, 0, "cron:j", `[Trigger ${next}] go`, 7]);
	// The process stopped after the successor and before the row left: the row is still claimed, and the closing runs again.
	claimIn(w.store, "c1");
	await drain("s", w.store, w.executor, T0, w.sinks);
	assert.deepEqual(w.store.list("s").map((r) => r.id), [next], "one successor, and the row is gone");
	// A job that is gone has no successor.
	const gone2 = closingWorld(null);
	claimIn(gone2.store, "c1");
	gone2.runs.push(HANDED_BACK);
	gone2.written("c1");
	await drain("s", gone2.store, gone2.executor, T0, gone2.sinks);
	assert.deepEqual(gone2.store.list("s"), []);
});

test("[2.1-6] [R5] a claim whose process is gone and that has no record gets an interrupted record, then an attempt unless its prompt is in the conversation; the third attempt is a dead letter", async () => {
	const w = closingWorld();
	claimIn(w.store, "c1");
	const first = await drain("s", w.store, w.executor, T0, w.sinks);
	assert.deepEqual(w.runs, [{ runId: "run-c1", jobId: "j", stateful: false, cwd: "/p", pid: 4242, startedAt: "2026-06-01T11:59:00Z", finishedAt: stamp(T0), ok: false, error: "the process running it stopped", findings: 0, droppedFindings: 0, stateUpdated: false, interrupted: true }]);
	const [left] = w.store.list("s");
	assert.deepEqual([left.run, left.attempts, left.last_error, left.not_before], [undefined, 1, "the process running it stopped", stamp(T0 + BACKOFF_MS[0])]);
	assert.deepEqual([first.failed, first.dead], [["c1"], []]);
	assert.deepEqual(w.requestAudit(), [["failed", "c1"]]);
	assert.deepEqual([w.status().streak, w.sinks.counts("j").interrupted, w.job().enabled], [0, 1, true], "a process that died is no failure of the job: it is one interruption");
	// The prompt was written before the process died: the row is delivered, and nothing is asked again.
	const there = closingWorld();
	claimIn(there.store, "c1");
	there.written("c1");
	const out = await drain("s", there.store, there.executor, T0, there.sinks);
	assert.deepEqual([there.store.list("s"), out.removed, out.failed, there.runs.map((r) => r.interrupted)], [[], ["c1"], [], [true]]);
	// Two attempts already: this failure is the third.
	const again = closingWorld();
	claimIn(again.store, "c2", { attempts: 2 });
	const third = await drain("s", again.store, again.executor, T0, again.sinks);
	assert.deepEqual([again.store.list("s"), third.failed, third.dead], [[], ["c2"], ["c2"]]);
	const [letter] = again.inbox.list();
	assert.deepEqual([letter.id, letter.undelivered, letter.run_id], [findingId("dead | s | c2"), true, "c2"]);
	assert.match(letter.text, /^could not be delivered \(failed 3 times: the process running it stopped\): go$/);
});

test("[R5] a job whose turn stops its process three times in a row is turned off, with its prompt written or not: the third closing says why", async () => {
	for (const written of [true, false]) {
		const w = closingWorld();
		for (let n = 1; n <= 3; n++) {
			const id = `c${n}`;
			w.store.append(row(id, { wake: "turn", source: "cron:j", mode: "unattended", collapse_key: "cron:j", payload: { text: `[Trigger ${id}] go`, cwd: "/p" } }));
			assert.equal(w.store.claim("s", id, { id: `run-${id}`, pid: 4242, started_at: stamp(T0 + n * 60_000) }), true);
			if (written) w.written(id);
			await drain("s", w.store, w.executor, T0 + n * 60_000 + 1_000, w.sinks);
			assert.deepEqual([w.sinks.counts("j").interrupted, w.job().enabled], [n, n < 3], `${written} ${n}`);
		}
		assert.equal(w.job().disabled.code, "interrupted");
		assert.match(w.job().disabled.why, /^parked: its last 3 runs were interrupted before they finished/);
		assert.match(w.status().error, /^parked: its last 3 runs were interrupted before they finished/, "the lists say why");
		assert.equal(w.runs.filter((r) => r.interrupted).length, 3);
	}
});

test("[R3] the closing writes the record, then the row; the row keeps its claim until the record is written, and a record that cannot be written changes nothing", async () => {
	const w = closingWorld();
	claimIn(w.store, "c1");
	w.written("c1");
	const [claimed] = w.store.list("s") as ClaimedRow[];
	// A run that ended in this process hands its record to the closing, which is the one writer of it.
	const closed = await closeRun(w.store, w.sinks, claimed, w.executor.proof("s"), T0, FAILED);
	assert.deepEqual(w.log, ["record, the row claimed"], "a failure writes no job: the run log counts it");
	assert.deepEqual(w.runs, [FAILED]);
	assert.deepEqual([closed.end.how, closed.outcome, closed.settlement.row, w.status().streak, w.status().error], ["failed", "removed", { do: "leave", exit: "delivered" }, 1, "boom"]);
	assert.deepEqual(w.store.list("s"), []);
	// The closing runs again after a stop between the record's write and the row's: no second record, and the failure is counted once.
	claimIn(w.store, "c1");
	const again = await closeRun(w.store, w.sinks, w.store.list("s")[0] as ClaimedRow, w.executor.proof("s"), T0, FAILED);
	assert.deepEqual([w.runs.length, w.status().streak, again.outcome], [1, 1, "removed"]);
	// The run log cannot be written: the job and the row are as they were, and the next closing starts again.
	const stuck = closingWorld();
	claimIn(stuck.store, "c1");
	stuck.sinks.ledger.appendRun = () => {
		throw new Error("disk full");
	};
	await assert.rejects(closeRun(stuck.store, stuck.sinks, stuck.store.list("s")[0] as ClaimedRow, stuck.executor.proof("s"), T0), /disk full/);
	assert.deepEqual([stuck.store.list("s")[0].run?.id, stuck.store.list("s")[0].attempts, stuck.status().completed, stuck.log], ["run-c1", 0, undefined, []]);
});

test("[settle-one-shot] the closing asks a failed one-shot again with a successor row, once, and says so in its last error; a repeat of the closing keeps both", async () => {
	const w = closingWorld({ id: "j", sessionId: "s", prompt: "go", cwd: "/p", schedule: { kind: "once", at: 1 }, enabled: true, stateful: false });
	claimIn(w.store, "c1");
	w.runs.push(FAILED);
	w.written("c1");
	await drain("s", w.store, w.executor, T0, w.sinks);
	const next = plainRunId("j", "after c1");
	assert.deepEqual([w.store.list("s").map((r) => r.id), w.status().streak, w.status().error], [[next], 1, "boom (one-shot: retrying once)"]);
	claimIn(w.store, "c1");
	await drain("s", w.store, w.executor, T0, w.sinks);
	assert.deepEqual([w.store.list("s").map((r) => r.id), w.status().streak], [[next], 1]);
});

test("[claim-record] a record belongs to its claim: the record of a row's first run does not close its second run", async () => {
	const w = closingWorld();
	claimIn(w.store, "c1");
	// The first run of this row was handed back a minute before this claim was made.
	w.runs.push(recordOf("c1", { ok: false, aborted: true, startedAt: "2026-06-01T11:58:00Z", finishedAt: "2026-06-01T11:58:30Z" }));
	const [claimed] = w.store.list("s");
	assert.equal(w.executor.proof("s").ran(claimed), undefined);
	const out = await drain("s", w.store, w.executor, T0, w.sinks);
	// Read as the first run's record, the row would stay owed for ever with no attempt counted.
	assert.deepEqual([out.failed, w.store.list("s")[0].attempts, w.runs.length, w.runs[1].interrupted], [["c1"], 1, 2, true]);
	// A record that started with the claim is the claim's.
	assert.deepEqual(proofOf("s", () => [], () => [recordOf("c1", { ok: false, aborted: true })]).ran(claimed), { how: "handed-back", at: "2026-06-01T12:00:00Z" });
});

/* ------------------------------------------------------------------ the exits, each with its trace */

test("[exit-delivered] [exit-cancelled] [exit-stale] [exit-refused] [exit-job-removed] every exit but the dead letter removes its row and leaves its own audit state", async () => {
	const turn = (id: string, over: Partial<UnclaimedRow> = {}) => row(id, { wake: "turn", source: "cron:j", mode: "unattended", payload: { text: `[Trigger ${id}] go`, cwd: "/p" }, ...over });
	const cases: Array<{ rows: UnclaimedRow[]; proof?: Partial<Proof>; jobs?: Partial<typeof jobs>; states: Array<[string, string]> }> = [
		// A delivered input leaves no line; the cancel that did its job leaves `done`.
		{ rows: [row("d1")], proof: { has: (r) => r.id === "d1" }, states: [] },
		{ rows: [turn("q1"), cancelRow("s", { id: "q1" }, "cli", page)], states: [["cancelled", "q1"], ["done", ""]] },
		{ rows: [cancelRow("s", { id: "nothing" }, "cli", page)], states: [["stale", ""]] },
		{ rows: [turn("g1", { source: "goal", mode: "attended", payload: { text: "keep going", cwd: "/p" } })], jobs: { goalActive: () => false }, states: [["stale", "g1"]] },
		{ rows: [turn("w1", { mode: "attended" })], states: [["refused", "w1"]] },
		{ rows: [turn("j1")], jobs: { exists: () => false }, states: [["job-removed", "j1"]] },
	];
	for (const c of cases) {
		const { store, audit, inbox } = world();
		for (const r of c.rows) store.append(r);
		const executor: Executor = { ...closingExecutor(c.proof), view: () => view({ idle: false }) };
		const out = await drain("s", store, executor, T0, { jobs: { ...jobs, ...c.jobs }, inbox, audit });
		assert.deepEqual(store.list("s"), [], JSON.stringify(c.states));
		assert.equal(out.removed.length, c.rows.length);
		const lines = audit.listAudit(10, (r) => r.type === "request").map((r) => [r.state, r.traceId.startsWith("cancel-") ? "" : r.traceId]);
		assert.deepEqual(lines.sort(), [...c.states].sort());
		assert.equal(inbox.list().length, 0, "none of these is a dead letter");
	}
});

test("[exit-dead] [R6] a dead letter is the finding, then the audit line, then the removal; a crash before the removal files nothing the second time", async () => {
	const { store, audit, inbox } = world();
	const dead = row("x1", { wake: "turn", source: "cron:j", mode: "unattended", attempts: 3, last_error: "boom", payload: { text: "[Trigger x1] go", cwd: "/p" } });
	store.append(dead);
	// The first drain stops between the audit line and the removal: the audit sink throws after it wrote.
	const order: string[] = [];
	let crash = true;
	const sinks: EngineSinks = {
		jobs,
		inbox: { appendOnce: (...a) => inbox.appendOnce(...a), fileOnce: async (entry, id) => (order.push("finding"), inbox.fileOnce(entry, id)) },
		audit: {
			listAudit: (...a) => audit.listAudit(...a),
			appendAudit: (record) => {
				order.push(`audit ${record.state}`);
				audit.appendAudit(record);
				if (crash) throw new Error("the process stops here");
			},
		},
	};
	await assert.rejects(drain("s", store, closingExecutor(), T0, sinks), /the process stops here/);
	assert.deepEqual(order, ["finding", "audit dead"], "the finding is there before anything else");
	assert.equal(store.list("s").length, 1, "the row is still owed: its removal comes last");
	crash = false;
	const out = await drain("s", store, closingExecutor(), T0, sinks);
	assert.deepEqual([store.list("s"), out.dead], [[], ["x1"]]);
	const letters = inbox.list();
	assert.equal(letters.length, 1, "one finding, though the dead letter was written twice");
	assert.deepEqual([letters[0].id, letters[0].lane, letters[0].session_id, letters[0].undelivered, letters[0].source], [findingId("dead | s | x1"), "s", "s", true, "cron:j"]);
	assert.equal(letters[0].text, "could not be delivered (failed 3 times: boom): go");
});

test("[blocked] a row its executor holds back waits with the executor's own reason, and is not handed over", async () => {
	const result = row("b1");
	const turn = row("b2", { wake: "turn", source: "cron:j", mode: "unattended", payload: { text: "[Trigger b2] go", cwd: "/p" } });
	const blocked = (r: UnclaimedRow) => (r.wake === "turn" ? "turn rows wait for a window" : undefined);
	assert.deepEqual(decideDrain("conversation", [result, turn], none, jobs, view({ blocked }), T0), [{ do: "append", row: result, wakeAgent: false }, { do: "wait", row: turn, why: "turn rows wait for a window" }]);
	assert.deepEqual(decideDrain("conversation", [result], none, jobs, view({ blocked: () => "a turn of pi-loops is writing this conversation" }), T0), [{ do: "wait", row: result, why: "a turn of pi-loops is writing this conversation" }]);
	// Through the drain: nothing reaches the executor, and the row stays.
	const { store, sinks } = world();
	store.append(result);
	const out = await drain("s", store, { ...closingExecutor(), view: () => view({ blocked: () => "held back" }) }, T0, sinks);
	assert.deepEqual([out.waiting, store.list("s").map((r) => r.id)], [["b1"], ["b1"]]);
});

test("[mode-by-lane] a row in a loop's lane or a check's lane is unattended whatever asked for it, and a conversation keeps its rules", () => {
	for (const lane of ["loop", "check"] as const) {
		for (const source of ["cron-run:j", "cron:j", "person", "goal", "push:srv:key", "rule:local:dynamic", "cli"] as const) {
			for (const wake of ["turn", "append", undefined] as const) assert.equal(modeOf(lane, "input", source, wake), "unattended", `${lane} ${source} ${wake}`);
		}
		assert.equal(modeOf(lane, "stop", "cli"), "none", "a stop asks for no run, in any lane");
		assert.equal(modeOf(lane, "cancel", "cli"), "none");
	}
	assert.equal(modeOf("conversation", "input", "cron-run:j", "turn"), "attended", "in a conversation a run a person asked for is theirs");
	// The engine recomputes the mode with the lane it is draining: the same row is run in a loop's lane and refused in a conversation.
	const asked = row("m1", { lane: "@cron-j", wake: "turn", source: "cron-run:j", mode: "unattended", payload: { text: "[Trigger m1] go", cwd: "/p" } });
	assert.deepEqual(decideDrain("loop", [asked], none, jobs, view(), T0), [{ do: "turn", row: asked }]);
	assert.deepEqual(decideDrain("conversation", [asked], none, jobs, view(), T0), [{ do: "exit", row: asked, exit: "refused" }]);
});

test("a proof reads what a claim's run came to from the run records: the newest record of the claim's run, and nothing for a row with no claim", () => {
	const claimed = claimedRow("c1");
	const record = (over: Record<string, unknown>) => recordOf("c1", over as Partial<RunRecord>);
	const ran = (records: unknown[]) => proofOf("s", () => [], () => records as any).ran(claimed)?.how;
	assert.equal(ran([]), undefined, "no record has the run's id");
	assert.equal(ran([record({ runId: "another-run" })]), undefined);
	assert.equal(ran([record({})]), "succeeded");
	assert.equal(ran([record({ ok: false, error: "boom" })]), "failed");
	assert.equal(ran([record({ ok: false, aborted: true, stoppedBy: "person" })]), "stopped");
	assert.equal(ran([record({ ok: false, aborted: true })]), "handed-back");
	assert.equal(ran([record({ ok: false, interrupted: true })]), "interrupted");
	assert.equal(ran([record({ ok: false, aborted: true }), record({})]), "succeeded", "the newest record of the run");
	// A row with no claim: nothing to ask, and the run log is not read.
	let read = 0;
	const lazy = proofOf("s", () => [], () => (read++, [record({ runId: "t9" })]));
	assert.equal(lazy.ran(row("t9")), undefined);
	assert.equal(landed(row("t9"), lazy), false);
	assert.equal(read, 0);
});

test("a claim is alive while its process is, by the rule of a lease's holder: the same pid started at another time is another process", () => {
	const claimed = { ...claimedRow("c1"), run: { id: "run-c1", pid: 4242, procStart: "100", started_at: "2026-06-01T11:59:00Z" } };
	const probe = (alive: boolean, start: string | undefined) => ({ alive: () => alive, startTime: () => start, bootedAt: () => 0 });
	assert.equal(claimAlive(claimed, probe(true, "100")), true);
	assert.equal(claimAlive(claimed, probe(false, "100")), false, "its process is gone");
	assert.equal(claimAlive(claimed, probe(true, "999")), false, "the pid was given to another process");
	// With no start time to compare, a claim made before this machine started is another process's.
	const { procStart: _, ...run } = claimed.run;
	const booted = (at: string) => ({ alive: () => true, startTime: () => "100", bootedAt: () => Date.parse(at) });
	assert.equal(claimAlive({ ...claimed, run }, booted("2026-06-01T12:05:00Z")), false, "claimed six minutes before the boot");
	assert.equal(claimAlive({ ...claimed, run }, booted("2026-06-01T11:58:00Z")), true, "claimed after the boot");
});

test("an answer's claim of this process is live only while its run is listed; another process's by the rule of a lease's holder", () => {
	const claimed = { ...claimedRow("c1"), run: { id: "run-c1", pid: 4242, procStart: "100", started_at: "2026-06-01T11:59:00Z" } };
	const probe = (alive: boolean) => ({ alive: () => alive, startTime: () => "100", bootedAt: () => 0 });
	const self = { pid: 4242, procStart: "100" };
	assert.equal(answerClaimLive(claimed, self, () => true, probe(true)), true, "its run is in the list");
	assert.equal(answerClaimLive(claimed, self, () => false, probe(true)), false, "its run left the list: this living process holds nothing");
	assert.equal(answerClaimLive(claimed, { pid: 7, procStart: "1" }, () => false, probe(true)), true, "another process that lives");
	assert.equal(answerClaimLive(claimed, { pid: 7, procStart: "1" }, () => true, probe(false)), false, "another process that is gone");
});

test("[exit-cancelled] a cancel or a stop does not take a claimed row out of its queue: only its run decides what becomes of it", () => {
	const claimed = claimedRow("c1");
	for (const order of [cancelRow("s", { id: "c1" }, "cli", page), stopRow("s", { id: "c1" }, "cli", page)]) {
		for (const live of [true, false]) {
			const actions = decideDrain("conversation", [claimed, order], proofThat({ ran: () => runEnd(HANDED_BACK) }), jobs, view({ claimLive: () => live }), T0);
			assert.deepEqual(actions, [{ do: "exit", row: order, exit: "stale" }, live ? { do: "wait", row: claimed, why: "running" } : { do: "close", row: claimed }], `${order.kind} ${live}`);
		}
	}
});

test("a drain has something to do when it would close a run or take a row out, and nothing when every row waits", () => {
	// The background reads a quiet queue again only when a decision would change something: a claim
	// whose process died must count, or it is never closed.
	const claimed = claimedRow("c1");
	const plain = row("p1");
	assert.equal(changesSomething([{ do: "close", row: claimed }]), true);
	assert.equal(changesSomething([{ do: "exit", row: plain, exit: "stale" }]), true);
	assert.equal(changesSomething([{ do: "exit", row: plain, exit: "dead", why: "x" }]), true);
	assert.equal(changesSomething([{ do: "fail", row: plain, why: "x", retry: "backoff" }]), true);
	assert.equal(changesSomething([{ do: "append", row: plain, wakeAgent: false }, { do: "turn", row: plain }]), true);
	assert.equal(changesSomething([{ do: "wait", row: plain, why: "x" }, { do: "wait", row: claimed, why: "running" }]), false);
	assert.equal(changesSomething([]), false);
});

test("a window decides a claimed row as the background does: it holds nothing back, asks the claim's process, and reads the run log", async () => {
	const store = new RequestStore(tmp());
	const records: unknown[] = [];
	const entries: unknown[] = [];
	const ctx = { idle: true, mode: "tui", hasUI: false, isIdle: () => true, abort: () => undefined, sessionManager: { getEntries: () => entries }, ui: { notify: () => undefined } } as any;
	const executor = new WindowExecutor({ sendMessage: () => undefined, sendUserMessage: () => undefined } as any, { here: () => ({ sessionId: "s", holds: true }), hold: () => true, letGo: () => undefined }, () => ctx, { pid: 1 }, () => true, () => store.list("s"), () => [], () => records as any);
	const view = executor.view("s");
	assert.equal(view.blocked(row("b1")), undefined, "a window holds no row back for a reason of its own");
	// Claimed a moment ago by this process: a claim older than the machine's start is a process of before the reboot.
	const mine = { ...claimedRow("c1"), run: { id: "run-c1", pid: process.pid, started_at: new Date().toISOString() } };
	const dead = { ...claimedRow("c2"), run: { id: "run-c2", pid: 999_999_999, started_at: "2026-06-01T11:59:00Z" } };
	assert.deepEqual([view.claimLive(mine), view.claimLive(dead)], [true, false]);
	// A run the background left with a record: the window reads what it came to, and does not count a stop or an abort as a failure.
	assert.equal(executor.proof("s").ran(dead), undefined, "no record yet");
	records.push(recordOf("c2", { pid: 999_999_999, ok: false, aborted: true }));
	assert.equal(executor.proof("s").ran(dead)?.how, "handed-back");
	assert.deepEqual(decideDrain("conversation", [dead], executor.proof("s"), jobs, view, T0), [{ do: "close", row: dead }]);
	records.push(recordOf("c2", { pid: 999_999_999, ok: false, aborted: true, stoppedBy: "person" }));
	assert.equal(executor.proof("s").ran(dead)?.how, "stopped");
});

test("[R6] a dead letter names the queue it came from: a conversation's has its session, a loop's lane has its lane and no session; a rule's result has its lane too", async () => {
	const { store, sinks, inbox } = world();
	const loop = "@cron-0123456789abcdef0123456789abcdef";
	store.append(row("x-loop", { lane: loop, wake: "turn", source: "cron:cron-0123456789abcdef0123456789abcdef", mode: "unattended", attempts: 3, last_error: "boom", payload: { text: "[Trigger x-loop] go", cwd: "/p" } }));
	store.append(row("x-conv", { lane: "s", wake: "turn", source: "cron:j", mode: "unattended", attempts: 3, last_error: "boom", payload: { text: "[Trigger x-conv] go", cwd: "/p" } }));
	// The same row id in two queues: each has its own dead letter.
	store.append(row("x-loop", { lane: "s", wake: "turn", source: "cron:j", mode: "unattended", attempts: 3, last_error: "boom", payload: { text: "[Trigger x-loop] go", cwd: "/p" } }));
	store.append(row("x-rule", { lane: "s", payload: { text: "a rule's result with no prefix", cwd: "/p" } }));
	await drain(loop, store, closingExecutor(), T0, sinks);
	await drain("s", store, closingExecutor(), T0, sinks);
	const by = (run: string, lane: string) => inbox.list().find((e) => e.run_id === run && e.lane === lane)!;
	assert.deepEqual([by("x-loop", loop).id, by("x-loop", loop).session_id, by("x-loop", loop).undelivered], [findingId(`dead | ${loop} | x-loop`), undefined, true]);
	assert.deepEqual([by("x-conv", "s").id, by("x-conv", "s").session_id], [findingId("dead | s | x-conv"), "s"]);
	assert.deepEqual([by("x-loop", "s").id, by("x-loop", "s").session_id], [findingId("dead | s | x-loop"), "s"], "the same row id in another queue is another dead letter");
	assert.deepEqual([by("x-rule", "s").source, by("x-rule", "s").session_id, by("x-rule", "s").undelivered], ["trigger:local:dynamic", "s", undefined], "a rule's result keeps the finding it always had, with its lane");
	assert.equal(inbox.list().length, 4);
});

test("[quiet-claim] a queue that holds a claim is never quiet: the tick asks again whether its run is going", () => {
	const files = [{ size: 10, mtimeMs: 1 }];
	const free = [claimedRow("c1")].map(({ run: _, ...rest }) => rest as UnclaimedRow);
	assert.equal(stillQuiet(quietMark(files, free, T0), files, free, T0 + 1), true, "the same rows with no claim are quiet");
	const held = [claimedRow("c1")];
	assert.equal(stillQuiet(quietMark(files, held, T0), files, held, T0 + 1), false);
});

test("the run a plain job is in is its marker, else the claim of its row; a row of the job is queued with or without a claim", () => {
	const mine = claimedRow("r1", { source: "cron:j", collapse_key: "cron:j" });
	const { run: _, ...free } = mine;
	const other = claimedRow("r2", { source: "cron:other", collapse_key: "cron:other" });
	assert.equal(runningRun({ id: "j", status: {} }, [other, mine]), "run-r1");
	assert.equal(runningRun({ id: "j", status: {} }, [other, free as UnclaimedRow]), undefined, "a row with no claim is not a run");
	assert.equal(runningRun({ id: "j", status: { run: { runId: "run-old" } } }, [mine]), "run-old", "a marker comes first");
	assert.equal(runningRun({ id: "j", status: {} }, []), undefined);
	assert.equal(jobQueued("j", [other]), false);
	assert.equal(jobQueued("j", [other, mine]), true, "a claimed row is queued");
	assert.equal(jobQueued("j", [free as UnclaimedRow]), true);
	assert.equal(jobQueued("j", [{ ...(free as UnclaimedRow), kind: "stop" }]), false, "only an input is a prompt");
	// A row that a run has claimed is running, not waiting: the listing says `running`, not `[queued]`.
	assert.equal(queuedPrompt({ id: "j", status: {} }, [mine], T0), undefined);
	assert.notEqual(queuedPrompt({ id: "j", status: {} }, [free as UnclaimedRow], T0), undefined);
});

/** A plain job's turn row, as the clock writes it. */
const slotRow = (id: string): UnclaimedRow => row(id, { wake: "turn", source: "cron:j", mode: "unattended", collapse_key: "cron:j", payload: { text: `[Trigger ${id}] go`, cwd: "/p" } });

test("a hand-over that throws counts one attempt, and none for a row that has a claim by then: the closing of its run counts it, once", async () => {
	const starts = (w: ReturnType<typeof closingWorld>, claims: boolean): Executor => ({
		...w.executor,
		view: () => view({ claimLive: () => true }),
		turn: (r) => {
			if (claims) assert.equal(w.store.claim("s", r.id, { id: "run-t1", pid: 4242, started_at: "2026-06-01T11:59:00Z" }), true);
			throw new Error("could not start");
		},
	});
	const plain = closingWorld();
	plain.store.append(slotRow("t1"));
	const out = await drain("s", plain.store, starts(plain, false), T0, plain.sinks);
	assert.deepEqual([plain.store.list("s")[0].attempts, plain.store.list("s")[0].last_error, out.failed, plain.requestAudit()], [1, "could not start", ["t1"], [["failed", "t1"]]]);
	const claimed = closingWorld();
	claimed.store.append(slotRow("t1"));
	const out2 = await drain("s", claimed.store, starts(claimed, true), T0, claimed.sinks);
	const [left] = claimed.store.list("s");
	assert.deepEqual([left.run?.id, left.attempts, left.last_error, out2.failed, claimed.requestAudit()], ["run-t1", 0, undefined, [], []]);
});

test("the drain does not remove a row that a run has claimed, though its prompt is written: it leaves through its closing only", async () => {
	const w = closingWorld();
	w.store.append(slotRow("t1"));
	// The claim, then the prompt in the conversation with its mark, before the drain looks again:
	// the proof alone says the row landed, so only the claim keeps it.
	const executor: Executor = {
		...w.executor,
		view: () => view({ claimLive: () => true }),
		turn: (r) => {
			assert.equal(w.store.claim("s", r.id, { id: "run-t1", pid: 4242, started_at: "2026-06-01T11:59:00Z" }), true);
			w.written(r.id, true);
		},
	};
	const out = await drain("s", w.store, executor, T0, w.sinks);
	assert.deepEqual([w.store.list("s").map((r) => [r.id, r.run?.id]), out.delivered, out.removed], [[["t1", "run-t1"]], ["t1"], []]);
	// With no claim the same row is removed at once, as a window's append is.
	const free = closingWorld();
	free.store.append(slotRow("t1"));
	const out2 = await drain("s", free.store, { ...free.executor, view: () => view(), turn: (r) => free.written(r.id, true) }, T0, free.sinks);
	assert.deepEqual([free.store.list("s"), out2.removed], [[], ["t1"]]);
});

test("[two-writers] an append that sorts after a turn is not written once that turn has started in the same drain: the executor is asked again at each hand-over", async () => {
	const run = async (blocksOnceStarted: boolean) => {
		const w = closingWorld();
		w.store.append(slotRow("t1"));
		w.store.append(row("a2"));
		let started = false;
		const appended: string[] = [];
		const executor: Executor = {
			...w.executor,
			view: () => view({ blocked: () => (started && blocksOnceStarted ? "a turn of pi-loops is writing this conversation" : undefined) }),
			turn: () => void (started = true),
			append: (r) => void appended.push(r.id),
		};
		const out = await drain("s", w.store, executor, T0, w.sinks);
		return { appended, delivered: out.delivered, queued: w.store.list("s").map((r) => r.id) };
	};
	assert.deepEqual(await run(true), { appended: [], delivered: ["t1"], queued: ["t1", "a2"] });
	assert.deepEqual(await run(false), { appended: ["a2"], delivered: ["t1", "a2"], queued: ["t1", "a2"] });
});

test("the held turns a window lists are the claims on plain jobs' rows whose process lives: not a loop, not a job with a marker, not a claim of a process that is gone", () => {
	const claim = (job: string, id: string) => claimedRow(id, { source: `cron:${job}`, collapse_key: `cron:${job}`, lane: `s-${job}` });
	const rowsOf = (sessionId: string): Row[] => ({ "s-a": [claim("a", "r-a")], "s-b": [claim("b", "r-b")], "s-c": [claim("c", "r-c")], "s-d": [claim("d", "r-d")], "s-e": [slotRow("r-e")] })[sessionId] ?? [];
	const jobsList = [
		{ id: "a", stateful: false, sessionId: "s-a", status: {} },
		{ id: "b", stateful: true, sessionId: "s-b", status: {} },
		{ id: "c", stateful: false, sessionId: "s-c", status: { run: { runId: "run-old", pid: 1, startedAt: "2026-06-01T11:00:00Z" } } },
		{ id: "d", stateful: false, sessionId: "s-d", status: {} },
		{ id: "e", stateful: false, sessionId: "s-e", status: {} },
		{ id: "f", stateful: false, status: {} },
	];
	const alive = (row: ClaimedRow) => row.id !== "r-d";
	assert.deepEqual(heldTurns(jobsList, rowsOf, alive), [{ jobId: "a", run: claim("a", "r-a").run }]);
	// By default a claim is alive by the rule of a lease's holder: these claims are of a pid that is not there.
	assert.deepEqual(heldTurns(jobsList, rowsOf), []);
});

test("[R5] two turns that were going when their process stopped are each counted: a turn is closed by itself, and nothing says what else its process had going", async () => {
	const w = closingWorld();
	w.jobsList.push({ id: "k", sessionId: "t", prompt: "go", cwd: "/p", schedule: { kind: "every", ms: 60_000 }, enabled: true, stateful: false });
	const other = () => w.jobsList[1] as any;
	for (let n = 1; n <= 3; n++) {
		for (const lane of ["s", "t"]) {
			const id = `${lane}${n}`;
			w.store.append(row(id, { lane, wake: "turn", source: `cron:${lane === "s" ? "j" : "k"}`, mode: "unattended", collapse_key: `cron:${lane === "s" ? "j" : "k"}`, payload: { text: `[Trigger ${id}] go`, cwd: "/p" } }));
			assert.equal(w.store.claim(lane, id, { id: `run-${id}`, pid: 4242, started_at: stamp(T0 + n * 60_000) }), true);
			w.written(id);
		}
		for (const lane of n % 2 ? ["s", "t"] : ["t", "s"]) await drain(lane, w.store, w.executor, T0 + n * 60_000 + 1_000, w.sinks);
		assert.deepEqual([w.sinks.counts("j").interrupted, w.job().enabled, w.sinks.counts("k").interrupted, other().enabled], [n, n < 3, n, n < 3], `death ${n}`);
	}
});

test("a turn pi holds behind a run keeps its row's cap when its row leaves the file: the cap is in its message (final-state check A, F6)", () => {
	const job = { id: "job-1", sessionId: "s", prompt: "tidy the cache", cwd: "/p", model: undefined, thinking: undefined, tools: undefined, builtinTools: undefined };
	const row = plainJobRow(job, "run-1111222233334444", "cron:job-1", "", { pid: 1, instance: "w", version: "0" }, T0);
	let rows: Row[] = [row];
	const w = fakeWindowPi(false, { rows: () => rows });
	w.executor.agentStarted(T0);
	w.executor.messageStarted({ role: "user", content: "the person's message" }, T0);
	w.executor.turn(row, T0 + 1); // pi is busy: queued behind the person's run
	rows = []; // the row left the file (a /goal clear, say)
	w.executor.view("s");
	w.starts(row.payload!.text, T0 + 2);
	assert.deepEqual(w.executor.currentTurn(), { kind: "row", id: row.id, mode: "unattended" }, "the row's own cap, not the person's");
});

test("an older version's row its words proved while pi held its turn keeps its cap for that turn (final-state check A, F6)", () => {
	const made = newTriggerRow("continue", { sessionId: "s", cwd: "/p", createdBy: { pid: 99, instance: "w", version: "0" } }, T0);
	const row = { ...made, line: 2, payload: { ...made.payload!, text: "continue" } } as unknown as Row; // 0.24.2 queued it with no prefix
	let rows: Row[] = [row];
	const w = fakeWindowPi(false, { rows: () => rows, alive: () => false });
	w.executor.agentStarted(T0);
	w.executor.messageStarted({ role: "user", content: "the person's message" }, T0);
	w.executor.turn(row, T0 + 1);
	rows = [{ ...row, handed_at: stamp(T0 + 1) } as Row];
	w.entries.push(userEntry("continue the migration plan", T0 + 2)); // the person's words prove it by the older proof
	w.executor.view("s");
	w.starts("continue", T0 + 3);
	assert.deepEqual(w.executor.currentTurn(), { kind: "row", id: row.id, mode: "unattended" }, "the row's own cap, not the person's");
});

/* ------------------------------------------------------------------ M4a: a row with no claim is proved by a record of its id (D3) */

test("[T2-ran] a slot appended again after its row ran and left is proved by the record of its id, whatever its stamp; [T2-aborted-runs] a handed-back or interrupted record proves nothing, and a row that cannot be claimed never reads the run log", () => {
	const job = { id: "cron-d3", sessionId: "s", prompt: "go", cwd: "/p" } as Parameters<typeof plainJobRow>[0];
	const id = plainRunId(job.id, "2026-06-01T12:00:00.000Z");
	const again = plainJobRow(job, id, `cron:${job.id}`, "", page, Date.parse("2026-06-01T12:10:00.000Z"));
	const record = (over: Partial<RunRecord>): RunRecord => ({ runId: id, jobId: job.id, stateful: false, cwd: "/p", pid: 1, startedAt: "2026-06-01T12:01:00.000Z", finishedAt: "2026-06-01T12:02:00.000Z", ok: true, findings: 0, droppedFindings: 0, stateUpdated: false, sessionId: "s", ...over });
	const proved = (records: RunRecord[], row: Row = again) => landed(row, proofOf("s", () => [], () => records));
	assert.equal(proved([record({})]), true, "succeeded: the slot ran, the copy appended after it is not run again");
	assert.equal(proved([record({ ok: false, error: "boom" })]), true, "failed: the slot ran");
	assert.equal(proved([record({ ok: false, aborted: true, stoppedBy: "person" })]), true, "a person stopped it: the slot is spent");
	assert.equal(proved([record({ ok: false, aborted: true })]), false, "handed back: the slot is owed, the copy runs");
	assert.equal(proved([record({ ok: false, interrupted: true })]), false, "interrupted: the copy runs");
	assert.equal(proved([record({ runId: "another" })]), false, "a record of another id proves nothing");
	let read = 0;
	const attended = { ...again, mode: "attended" as const };
	assert.equal(landed(attended, proofOf("s", () => [], () => (read++, [record({})]))), false, "a row no run can claim is not proved by a record");
	assert.equal(read, 0, "and the run log is not read for it");
	// An archive imported as another conversation keeps the job's id, so the same slot id is queued there: the run in the first conversation does not prove it.
	assert.equal(proved([record({ sessionId: "s" })]), true, "a held turn of this conversation proves it");
	assert.equal(proved([record({ sessionId: "another-conversation" })]), false, "a run in another conversation does not");
});

/** An `ans-` row of a yes and a `no-` row of a no, as src/ask.ts writes them. */
const ANS = `ans-${"a".repeat(32)}`;
const NO = `no-${"b".repeat(32)}`;
const answerOf = (over: Partial<UnclaimedRow> = {}): UnclaimedRow => row(ANS, { source: "answer", mode: "unattended", wake: "turn", payload: { text: `[Trigger ${ANS}] go`, cwd: "/p", finding: `inb-${"a".repeat(32)}` }, ...over });
const noOf = (): UnclaimedRow => row(NO, { source: "answer", mode: "none", wake: "append", payload: { text: `[Trigger ${NO}] A person said no`, cwd: "/p", finding: `inb-${"b".repeat(32)}` } });
const claimOf = (r: UnclaimedRow): ClaimedRow => ({ ...r, run: { id: r.id, pid: 7, started_at: "2026-06-01T11:59:00Z", procStart: "p7" } } as ClaimedRow);

test("decideDrain: an ans- row waits and nothing else, whatever would apply to another row; it never holds a lane unclaimed", () => {
	const answers = [answerOf(), answerOf({ attempts: DEAD_AFTER_ATTEMPTS }), answerOf({ mode: "attended" }), answerOf({ not_before: new Date(T0 - 1).toISOString() }), answerOf({ payload: undefined })];
	for (const lane of ["conversation", "loop", "check"] as const) for (const ans of answers) {
		assert.deepEqual(decideDrain(lane, [ans], none, jobs, view(), T0), [{ do: "wait", row: ans, why: ANSWER_ROW_WAITS }], `${lane}: never handed to pi, never dead, never refused`);
		assert.deepEqual(decideDrain(lane, [ans], { ...none, has: () => true }, jobs, view(), T0), [{ do: "wait", row: ans, why: ANSWER_ROW_WAITS }], `${lane}: a mark proves nothing of it`);
	}
	const turn = row("z", { wake: "turn", source: "cron:j", mode: "unattended" });
	assert.deepEqual(decideDrain("loop", [answerOf(), turn], none, jobs, view(), T0), [{ do: "wait", row: answerOf(), why: ANSWER_ROW_WAITS }, { do: "turn", row: turn }], "a slot's turn starts beside an answer that has not started");
});

test("decideDrain: a live claim on an ans- row holds its lane, a dead one is never closed here", () => {
	const claimed = claimOf(answerOf());
	const turn = row("z", { wake: "turn", source: "cron:j", mode: "unattended" });
	assert.deepEqual(decideDrain("loop", [claimed, turn], none, jobs, view({ claimLive: () => true }), T0), [
		{ do: "wait", row: claimed, why: ANSWER_ROW_WAITS },
		{ do: "wait", row: turn, why: "pi is busy" },
	], "no slot's turn starts beside a live answer run");
	assert.deepEqual(decideDrain("loop", [claimed, turn], none, jobs, view({ claimLive: () => false }), T0), [
		{ do: "wait", row: claimed, why: ANSWER_ROW_WAITS },
		{ do: "turn", row: turn },
	], "a dead claim is the answer protocol's (F1): no close, and the lane is free");
});

test("decideDrain: a cancel that names an ans- row finds no target and leaves as stale; a no- row is an ordinary append row", () => {
	const ans = answerOf();
	const cancel = row("c1", { kind: "cancel", source: "person", target: { id: ANS } });
	assert.deepEqual(decideDrain("conversation", [ans, cancel], none, jobs, view(), T0), [
		{ do: "exit", row: cancel, exit: "stale" },
		{ do: "wait", row: ans, why: ANSWER_ROW_WAITS },
	]);
	const no = noOf();
	assert.deepEqual(decideDrain("conversation", [no], none, jobs, view({ idle: false }), T0), [{ do: "append", row: no, wakeAgent: true }]);
	const cancelNo = row("c2", { kind: "cancel", source: "person", target: { id: NO } });
	assert.deepEqual(decideDrain("conversation", [no, cancelNo], none, jobs, view(), T0), [{ do: "exit", row: no, exit: "cancelled" }, { do: "exit", row: cancelNo, exit: "delivered" }], "a no- row is cancelled as any queued row is");
});

test("bury leaves an ans- row for the answer protocol and drops a no- row as stale, with no finding", async () => {
	const { store, sinks, inbox, audit } = world();
	store.append(answerOf({ lane: "s" }));
	store.append(noOf());
	assert.deepEqual(await bury("s", store, sinks, "its conversation is gone"), [NO]);
	assert.deepEqual(store.list("s").map((r) => r.id), [ANS], "the yes stays: its finding holds the answer");
	assert.deepEqual(inbox.listNew(), [], "neither is a dead letter");
	assert.equal(audit.listAudit(1, (r) => r.type === "request" && r.traceId === NO)[0]?.state, "stale");
});

test("[wake-me] a follow-up's row is its loop's row: it leaves as job-removed when the loop is removed, and it waits while the loop is disabled", () => {
	const woke = row("fu-1", { lane: "@cron-j", wake: "turn", source: "wake:cron-j", mode: "unattended", payload: { text: "look at #12", cwd: "/" } });
	const held = view({ kind: "held", mine: () => false });
	assert.deepEqual(decideDrain("loop", [woke], none, { ...jobs, exists: (id: string) => id !== "cron-j" }, held, T0), [{ do: "exit", row: woke, exit: "job-removed" }]);
	assert.deepEqual(decideDrain("loop", [woke], none, { ...jobs, enabled: (id: string) => id !== "cron-j" }, held, T0).map((a) => (a.do === "wait" ? a.why : a.do)), ["its job is disabled"]);
	assert.deepEqual(decideDrain("loop", [woke], none, jobs, held, T0).map((a) => a.do), ["turn"], "an enabled loop's follow-up runs");
});

test("[fifo-session-file] a session file that is not a regular file holds no entries, and reading it does not block (U6 of M3)", { skip: process.platform === "win32" }, async () => {
	const { spawnSync } = await import("node:child_process");
	const dir = tmp();
	const fifo = path.join(dir, "s.jsonl");
	assert.equal(spawnSync("mkfifo", [fifo]).status, 0, "mkfifo");
	// In a child: a read that blocks on the FIFO blocks the whole process, so the test cannot time it out from inside.
	const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
	const script = `import(${JSON.stringify(path.join(repo, "src/engine.ts"))}).then((m) => { process.stdout.write(JSON.stringify(m.sessionFileEntries(${JSON.stringify(fifo)}))); process.exit(0); })`;
	const child = spawnSync(process.execPath, ["--import", path.join(repo, "src/register-pi.mjs"), "--input-type=module", "-e", script], { encoding: "utf8", timeout: 15_000, env: { ...process.env, PI_LOOPS_HOST: "off" } });
	assert.equal(child.signal, null, "the read returned instead of blocking");
	assert.equal(child.stdout, "[]");
	assert.deepEqual(sessionFileEntries(path.join(dir, "missing.jsonl")), []);
});

test("[upgrade-hold] while the upgrade's pause holds, every job's row waits, /cron run's too; a person's row, a command typed in the window and a goal's continuation are not held; resumed, the job's row runs", async () => {
	const { store, inbox, audit } = world();
	const page = personRow("11111111-2222-3333-4444-555555555556", "hello from the browser", undefined, { sessionId: "s", cwd: "/p", createdBy: plainBy }, T0);
	const clock = plainJobRow(plainJob(), plainRunId("j1", "2026-06-01T12:00:00Z"), "cron:j1", "", plainBy, T0 + 1);
	store.append(page);
	store.append(clock);
	let paused = true;
	const sinks: EngineSinks = { jobs: { exists: () => true, enabled: () => true, goalActive: () => true, paused: () => paused }, inbox, audit };
	const w = windowOn(store);
	const why = decideDrain("conversation", store.list("s"), proofOf("s", () => [], () => []), sinks.jobs, w.executor.view("s"), T0).find((a) => a.row?.id === clock.id);
	assert.deepEqual(why?.do === "wait" ? why.why : why?.do, "pi-loops is paused after the upgrade: pi-loops resume");
	const asked = plainJobRow(plainJob(), "run-asked-by-a-person", "cron-run:j1", "", plainBy, T0 + 2);
	assert.equal(decideDrain("conversation", [asked], proofOf("s", () => [], () => []), sinks.jobs, w.executor.view("s"), T0).find((a) => a.row?.id === asked.id)?.do, "wait", "/cron run's row waits too");
	// What runs in the window the person looks at goes: a command they typed there, their goal's continuation.
	const to = { sessionId: "s", cwd: "/p", createdBy: plainBy };
	for (const typed of [newTriggerRow("make a rule", to, T0), goalRow("keep going", { condition: "done", iterations: 1, updatedAt: stamp(T0) }, to, T0)]) {
		const action = decideDrain("conversation", [typed], proofOf("s", () => [], () => []), sinks.jobs, w.executor.view("s"), T0).find((a) => a.row?.id === typed.id);
		assert.ok(!(action?.do === "wait" && action.why === PAUSED_WHY), `${typed.source} is not held by the pause`);
	}
	const out = await drain("s", store, w.executor, T0 + 5_000, sinks);
	assert.deepEqual([out.delivered, out.waiting], [[page.id], [clock.id]], "the person's own message goes; the job's row waits");
	paused = false;
	const fresh = windowOn(store);
	const after = decideDrain("conversation", [clock], proofOf("s", () => [], () => []), sinks.jobs, fresh.executor.view("s"), T0 + 6_000).find((a) => a.row?.id === clock.id);
	assert.notEqual(after?.do, "wait", "resumed: the job's row is no longer held");
});
