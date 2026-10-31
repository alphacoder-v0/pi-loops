import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmp } from "./tmp.ts";
import { Inbox } from "../src/inbox.ts";
import { TriggerStore } from "../src/triggers.ts";
import { RequestStore, type SessionRequest } from "../src/requests.ts";
import { type Action, BACKOFF_MS, CEILING, DEAD_AFTER_ATTEMPTS, bury, cancelRow, heldTurnFor, stopRow, type EngineSinks, type Executor, type ExecutorView, type Producer, conversationHas, decideDrain, drain, dropContinuations, enqueue, goalRow, goalRunId, handOver, handOverTarget, inboxClaimRow, isLocal, modeOf, newTriggerRow, promotionTarget, pushRunRow, queueOrder, recipeRow, releaseLocalRows, requestFingerprint, ringProduced, sameProducer, typedByPerson, waitingLine, PERSON_RING_WAIT_MS, PERSON_SEND_GRACE_MS, armRetry, conversationView, landed, personRow, plainJobRow, plainRunId, stripImageNotes } from "../src/engine.ts";
import { WindowExecutor, forgetDropped, producerAlive, showsTriggeredTurnLine } from "../src/window-executor.ts";
import { procStart } from "../src/lease.ts";
import { stamp } from "../src/schedule.ts";

const row = (id: string, over: Partial<SessionRequest> = {}): SessionRequest => ({ v: 2, id, session_id: "s", kind: "input", source: "rule:local:dynamic", mode: "none", wake: "append", payload: { text: `[Trigger ${id}] hello`, cwd: "/" }, created_at: "2026-01-01T00:00:00Z", created_by: { pid: 1, instance: "w", version: "0" }, attempts: 0, ...over });

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
function fakeExecutor(opts: { holds?: () => boolean; idle?: boolean; deliver?: (row: SessionRequest, written: Set<string>) => void } = {}) {
	const written = new Set<string>();
	const given: string[] = [];
	const inFlight = new Set<string>();
	const executor: Executor = {
		holds: opts.holds ?? (() => true),
		entries: () => ({ has: (id) => written.has(id), personEntries: () => 0 }),
		view: () => ({ kind: "window", ceiling: () => true, admits: () => true, idle: opts.idle ?? true, inFlight, connected: () => true, producerAlive: () => true, mine: () => true }),
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
	const executor = new WindowExecutor(pi, { here: () => ({ sessionId: "s", holds: true }) }, () => ctx);
	for (let i = 0; i < 6; i++) await drain("s", store, executor, T0, sinks);
	assert.deepEqual(sent, [{ content: "[Trigger 1] hello", options: { triggerTurn: true, deliverAs: "followUp" } }], "a busy chat gets it once, as a follow-up that wakes the agent");
	assert.deepEqual(store.list("s").map((d) => d.id), ["1"], "and it stays in the file until pi writes it");
	// pi settled and "1" is not in the conversation: Esc cleared the queue it was in.
	idle = true;
	assert.deepEqual(executor.settled(), ["1"]);
	await drain("s", store, executor, T0, sinks);
	assert.deepEqual(sent[1], { content: "[Trigger 1] hello", options: { triggerTurn: false } }, "offered again, inserted without a turn now that pi is idle");
	entries.push({ type: "custom_message", content: "[Trigger 1] hello" });
	await drain("s", store, executor, T0, sinks);
	assert.deepEqual(store.list("s"), [], "gone once pi wrote it");
	assert.deepEqual(forgetDropped(new Set(["2"]), () => true), [], "one that reached the conversation stays handled");
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
	assert.equal(inbox.listNew().length, 2, "at least once: a second finding is the price of the crash, a lost row would not be");
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
	assert.equal(modeOf("input", "rule:local:dynamic", "append"), "none");
	assert.equal(modeOf("input", "push:srv:key", "append"), "none");
	assert.equal(modeOf("input", "push:srv:key", "turn"), "unattended");
	assert.equal(modeOf("input", "cron:job-1", "turn"), "unattended");
	for (const source of ["cron-run:job-1", "person", "goal", "inbox:inb-1", "recipe:daily", "new-trigger", "cli", "window"] as const) assert.equal(modeOf("input", source, "turn"), "attended", source);
	assert.equal(modeOf("stop", "cli"), "none");
	assert.equal(modeOf("cancel", "person"), "none");
});

const view = (over: Partial<ExecutorView> = {}): ExecutorView => ({ kind: "window", ceiling: () => true, admits: () => true, idle: true, inFlight: new Set(), connected: () => true, producerAlive: () => true, mine: () => true, ...over });
const none = { has: () => false, personEntries: () => 0 };
const jobs = { exists: () => true, enabled: () => true, goalActive: () => true };

test("a row wider than its source is refused, audited and removed, never run or left waiting", async () => {
	// A plain job's row with `attended` written into the file: the clock's row gets `unattended`.
	const widened = row("w1", { wake: "turn", source: "cron:j", mode: "attended", payload: { text: "[Trigger w1] hello", cwd: "/" } });
	assert.deepEqual(decideDrain([widened], none, jobs, view(), T0), [{ do: "remove", row: widened, why: "refused" }]);
	// The rule is equality, so a narrower row is refused too: the executor runs a row only as its source.
	const narrowed = row("n1", { wake: "turn", source: "inbox:inb-1", mode: "unattended", payload: { text: "[Trigger n1] hello", cwd: "/" } });
	assert.deepEqual(decideDrain([narrowed], none, jobs, view(), T0), [{ do: "remove", row: narrowed, why: "refused" }]);
	const result = row("r1", { mode: "attended" });
	assert.deepEqual(decideDrain([result], none, jobs, view(), T0), [{ do: "remove", row: result, why: "refused" }], "an append row too");
	const honest = row("h1", { wake: "turn", source: "cron:j", mode: "unattended", payload: { text: "[Trigger h1] hello", cwd: "/" } });
	assert.deepEqual(decideDrain([widened, honest], none, jobs, view(), T0), [
		{ do: "remove", row: widened, why: "refused" },
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
	const claim = inboxClaimRow("look at this", "inb-1", { sessionId: "s", cwd: "/", createdBy: { pid: 99, instance: "w", version: "0" } }, T0);
	const goal = goalRow("go on", { condition: "c", iterations: 1, updatedAt: "t" }, { sessionId: "s", cwd: "/", createdBy: { pid: 99, instance: "w", version: "0" } }, T0);
	const person = row("p1", { wake: "turn", source: "person", mode: "attended", payload: { text: "hi", cwd: "/" } });
	// Their producers are gone, so nothing but the ceiling keeps them from this executor.
	for (const attended of [claim, goal, person]) assert.deepEqual(decideDrain([attended], none, jobs, held({ producerAlive: () => false }), T0), [{ do: "wait", row: attended, why: "attended rows wait for a window" }], attended.source);
	const cron = row("c1", { wake: "turn", source: "cron:j", mode: "unattended", payload: { text: "[Trigger c1] hello", cwd: "/" } });
	assert.deepEqual(decideDrain([cron], none, jobs, held(), T0), [{ do: "turn", row: cron }], "an unattended row is under the ceiling");
	assert.deepEqual(decideDrain([row("r1")], none, jobs, held(), T0), [{ do: "append", row: row("r1"), wakeAgent: false }], "and so is a result");
	assert.equal(CEILING.window("attended"), true, "a window runs every mode");
	assert.deepEqual(decideDrain([claim], none, jobs, view(), T0), [{ do: "turn", row: claim }]);
});

test("decideDrain: stops and cancels act first, idle or busy, and never on whatever runs next", () => {
	const a = row("a");
	const b = row("b");
	const cancel = row("c1", { kind: "cancel", source: "person", target: { id: "a" } });
	const stop = row("s1", { kind: "stop", source: "cli", target: { id: "b" } });
	assert.deepEqual(decideDrain([a, b, cancel, stop], none, jobs, view({ idle: false }), T0), [
		{ do: "remove", row: a, why: "cancelled" },
		{ do: "remove", row: cancel, why: "done" },
		{ do: "remove", row: b, why: "cancelled" },
		{ do: "remove", row: stop, why: "done" },
	]);
	const running = row("s2", { kind: "stop", source: "cli", target: { id: "r" } });
	assert.deepEqual(decideDrain([running], none, jobs, view({ running: { requestId: "r", startedAt: "2026-06-01T11:00:00Z" } }), T0), [{ do: "abort", stop: running }, { do: "remove", row: running, why: "done" }]);
	const late = row("s3", { kind: "stop", source: "cli", target: { current: true, started_before: "2026-06-01T11:00:00Z" } });
	assert.deepEqual(decideDrain([late], none, jobs, view({ running: { startedAt: "2026-06-01T11:30:00Z" } }), T0), [{ do: "remove", row: late, why: "stale" }], "a late stop never stops the next turn");
	assert.deepEqual(decideDrain([late], none, jobs, view({ running: { startedAt: "2026-06-01T10:30:00Z" } }), T0), [{ do: "abort", stop: late }, { do: "remove", row: late, why: "done" }]);
	assert.deepEqual(decideDrain([stop], none, jobs, view(), T0), [{ do: "remove", row: stop, why: "stale" }], "nothing to stop: stale");
});

test("decideDrain: one lane, oldest first; a row that cannot go now blocks nothing behind it", () => {
	const backoff = row("x", { wake: "turn", source: "cron:j", mode: "unattended", not_before: new Date(T0 + 60_000).toISOString() });
	const result = row("y");
	const turn = row("z", { wake: "turn", source: "cron:j", mode: "unattended" });
	const another = row("w", { wake: "turn", source: "cron:j", mode: "unattended" });
	assert.deepEqual(decideDrain([backoff, result, turn, another], none, jobs, view(), T0), [
		{ do: "wait", row: backoff, why: `backing off until ${backoff.not_before}` },
		{ do: "append", row: result, wakeAgent: false },
		{ do: "turn", row: turn },
		{ do: "wait", row: another, why: "pi is busy" },
	], "idle: a result lands without a turn, one turn is handed over, the next waits");
	assert.deepEqual(decideDrain([result, turn], none, jobs, view({ idle: false }), T0), [
		{ do: "append", row: result, wakeAgent: true },
		{ do: "wait", row: turn, why: "pi is busy" },
	], "busy: a result goes as a follow-up that wakes the agent, a turn waits");
	assert.deepEqual(decideDrain([turn], none, jobs, view({ heldUntil: T0 + 1 }), T0), [{ do: "wait", row: turn, why: "held after a stop" }]);
	assert.deepEqual(decideDrain([result], none, jobs, view({ admits: () => false }), T0), [{ do: "wait", row: result, why: "not admitted by this executor" }]);
	assert.deepEqual(decideDrain([result], none, jobs, view({ inFlight: new Set(["y"]) }), T0), [{ do: "wait", row: result, why: "handed to pi, not yet in the conversation" }]);
	const needs = row("n", { wake: "turn", source: "cron:j", mode: "unattended", payload: { text: "[Trigger n] t", cwd: "/", requires: ["gh"] } });
	assert.deepEqual(decideDrain([needs], none, jobs, view({ connected: () => false }), T0), [{ do: "wait", row: needs, why: "waiting for mcp server gh" }]);
	assert.deepEqual(decideDrain([result], { has: () => true }, jobs, view(), T0), [{ do: "remove", row: result, why: "done" }]);
	assert.deepEqual(decideDrain([turn], none, { ...jobs, exists: () => false }, view(), T0), [{ do: "remove", row: turn, why: "job-removed" }], "removing a job cancels its queued rows");
	const goal = row("g", { wake: "turn", source: "goal", mode: "attended" });
	assert.deepEqual(decideDrain([goal], none, { ...jobs, enabled: () => true, goalActive: () => false }, view(), T0), [{ do: "remove", row: goal, why: "stale" }]);
	const tired = row("t", { attempts: 3, last_error: "no" });
	assert.deepEqual(decideDrain([tired], none, jobs, view(), T0), [{ do: "dead", row: tired, why: "failed 3 times: no" }]);
	const empty = row("e", { payload: undefined });
	assert.deepEqual(decideDrain([empty], none, jobs, view(), T0), [{ do: "dead", row: empty, why: "an input row without text" }]);
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

test("promotionTarget: a row for the creating conversation, else the inbox marked for it", () => {
	const view = (o: { legacy?: string[]; known?: string[] } = {}) => ({ legacyOpen: (id: string) => (o.legacy ?? []).includes(id), known: (id: string) => (o.known ?? ["c"]).includes(id) });
	const win = { sessionId: "here", inProject: true, isHost: false };
	assert.deepEqual(promotionTarget("c", win, view()), { to: "row", sessionId: "c" });
	assert.deepEqual(promotionTarget("here", win, view({ known: [] })), { to: "row", sessionId: "here" }, "this window's own, file written or not");
	assert.deepEqual(promotionTarget(undefined, win, view()), { to: "row", sessionId: "here" }, "a shell rule of this project: this chat");
	assert.deepEqual(promotionTarget(undefined, { ...win, inProject: false }, view()), { to: "inbox" });
	assert.deepEqual(promotionTarget(undefined, { inProject: false, isHost: true }, view()), { to: "inbox" });
	assert.deepEqual(promotionTarget("c", win, view({ legacy: ["c"] })), { to: "inbox", sessionId: "c" }, "a 0.22 window never reads requests/");
	assert.deepEqual(promotionTarget("gone", win, view()), { to: "inbox", sessionId: "gone" }, "a file unknown or gone could never take it");
});

/**
 * A window over a fake pi: `sent` is what reached `sendUserMessage`, `appended` what reached
 * `sendMessage`, `entries` the conversation, `notices` the system lines. `self` is the process the
 * window is (pid 1 unless said), `holds` whether it has the lease, `alive` whether a row's producer is.
 */
/** `rows` is the request file as the extension wires it: what this window produced is remembered only while the row is there. */
function fakeWindowPi(idle: boolean, opts: { holds?: boolean; self?: Producer; alive?: (row: SessionRequest) => boolean; mode?: string; rows?: () => SessionRequest[] } = {}) {
	const sent: Array<{ text: string; options: unknown }> = [];
	const appended: Array<{ content: unknown; options: unknown }> = [];
	const notices: string[] = [];
	const entries: unknown[] = [];
	const ctx = { idle, aborts: 0, mode: opts.mode ?? "tui", hasUI: true, isIdle: () => ctx.idle, abort: () => void ctx.aborts++, sessionManager: { getEntries: () => entries }, ui: { notify: (line: string) => void notices.push(line) } } as any;
	const pi = { sendMessage: (m: { content: unknown }, options: unknown) => void appended.push({ content: m.content, options }), sendUserMessage: (text: string, options: unknown) => void sent.push({ text, options }) };
	const executor = new WindowExecutor(pi, { here: () => ({ sessionId: "s", holds: opts.holds ?? true }) }, () => ctx, opts.self ?? { pid: 1 }, opts.alive ?? (() => true), opts.rows ?? (() => []));
	return { sent, appended, notices, entries, ctx, executor };
}
const turnRow = (id: string) => row(id, { source: "cron:j", mode: "unattended", wake: "turn", collapse_key: "cron:j" });

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
	assert.deepEqual(w.sent, [{ text: "[Trigger t1] hello", options: { deliverAs: "followUp" } }], "handed over once pi is idle");
	await drain("s", store, w.executor, T0, sinks);
	assert.equal(w.sent.length, 1, "and not again while pi has it");
	assert.deepEqual(store.list("s").map((r) => r.id), ["t1"], "in the file until pi writes it");
	w.entries.push({ type: "message", message: { role: "user", content: "[Trigger t1] hello" } });
	await drain("s", store, w.executor, T0, sinks);
	assert.deepEqual(store.list("s"), []);
});

test("after Esc, turn rows wait for the next input or a minute", async () => {
	const { store, sinks } = world();
	store.append(turnRow("t1"));
	store.append(row("a1"));
	const w = fakeWindowPi(true);
	w.executor.agentStarted(T0 - 5_000);
	w.executor.agentEnded(T0, true);
	const out = await drain("s", store, w.executor, T0 + 1_000, sinks);
	assert.deepEqual(w.sent, [], "a stopped run holds the turns queued behind it");
	assert.deepEqual(out.waiting, ["t1"]);
	assert.deepEqual(w.appended.map((a) => a.options), [{ triggerTurn: false }], "an append row still lands, without a turn");
	await drain("s", store, w.executor, T0 + 59_000, sinks);
	assert.deepEqual(w.sent, []);
	w.executor.personInput();
	await drain("s", store, w.executor, T0 + 59_000, sinks);
	assert.deepEqual(w.sent.map((s) => s.text), ["[Trigger t1] hello"], "the person's next input ends the hold");

	const late = world();
	late.store.append(turnRow("t2"));
	const w2 = fakeWindowPi(true);
	w2.executor.agentEnded(T0, true);
	await drain("s", late.store, w2.executor, T0 + 59_000, late.sinks);
	assert.deepEqual(w2.sent, []);
	await drain("s", late.store, w2.executor, T0 + 60_000, late.sinks);
	assert.deepEqual(w2.sent.map((s) => s.text), ["[Trigger t2] hello"], "or a minute passes");
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
	assert.equal(r.session_id, "s");
	assert.equal(modeOf(r.kind, r.source, r.wake), r.mode);
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
	assert.equal(a.payload?.text, `[Trigger ${a.id}] The current /goal is not satisfied yet.`);
	assert.equal(a.payload?.cwd, "/proj");
	assert.equal(showsTriggeredTurnLine(a.source), false, "the goal prints its own notice");
});

test("inboxClaimRow, recipeRow, newTriggerRow: a fresh id each, the person's own sources, collapse per finding and per recipe", () => {
	const claim = inboxClaimRow("A recurring loop reported this finding", "inb-1", to, T0);
	assert.match(claim.id, /^claim-[0-9a-f]{32}$/);
	assert.notEqual(claim.id, inboxClaimRow("x", "inb-1", to, T0).id);
	assert.deepEqual([claim.source, claim.mode, claim.wake, claim.collapse_key], ["inbox:inb-1", "attended", "turn", "inbox:inb-1"]);
	assert.equal(claim.payload?.text, `[Trigger ${claim.id}] A recurring loop reported this finding`);
	assert.equal(claim.payload?.cwd, "/proj");

	const recipe = recipeRow("Describe the tracker", "daily", "tracker", to, T0);
	assert.match(recipe.id, /^recipe-[0-9a-f]{32}$/);
	assert.deepEqual([recipe.source, recipe.mode, recipe.wake, recipe.collapse_key], ["recipe:daily", "attended", "turn", "recipe:daily:tracker"]);
	assert.equal(recipe.payload?.text, `[Trigger ${recipe.id}] Describe the tracker`);

	const nt = newTriggerRow("The user asked pi to create a dynamic trigger.", to, T0);
	assert.match(nt.id, /^nt-[0-9a-f]{32}$/);
	assert.deepEqual([nt.source, nt.mode, nt.wake, nt.collapse_key], ["new-trigger", "attended", "turn", undefined]);
	assert.equal(nt.payload?.text, `[Trigger ${nt.id}] The user asked pi to create a dynamic trigger.`);

	for (const r of [claim, recipe, nt]) {
		assert.match(r.id.replace(/^[a-z]+-/, ""), HEX32);
		assert.equal(modeOf(r.kind, r.source, r.wake), r.mode);
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
	return { store, delivered: (id: string) => w.executor.entries("s").has(id), produced: (row: SessionRequest) => w.executor.produced(row), drain: () => drain("s", store, w.executor, at, sinks) };
}

test("a claimed finding's hand-off is queued before the finding is marked claimed", async () => {
	const { store, inbox, sinks } = world();
	const entry = await inbox.append({ source: "cron:j", run_id: "run-1", cwd: "/proj", text: "disk is full" });
	const order: string[] = [];
	const watching: Pick<Inbox, "setStatus"> = {
		setStatus: (id, status, by) => {
			order.push(`setStatus ${status} by ${by}`);
			return inbox.setStatus(id, status, by);
		},
	};
	const originalAppend = store.appendIfAbsent.bind(store);
	store.appendIfAbsent = (r, opts) => {
		order.push("append");
		return originalAppend(r, opts);
	};
	const w = fakeWindowPi(true);
	const row = inboxClaimRow("investigate", entry.id, to, T0);
	const out = await handOver(handOverDeps(store, w, sinks), row, { inbox: watching, entryId: entry.id });
	assert.deepEqual(order, ["append", "setStatus claimed by s"]);
	assert.deepEqual([out.written, out.result?.delivered, out.line], [true, [row.id], undefined], "idle: handed over at once, nothing to say");
	assert.equal(inbox.list().find((e) => e.id === entry.id)?.status, "claimed");

	// A crash between the two: the finding stays `new`, with its hand-off queued, so nobody is told twice and nothing is lost.
	const crash = world();
	const second = await crash.inbox.append({ source: "cron:j", run_id: "run-2", cwd: "/proj", text: "cert expires" });
	const dies: Pick<Inbox, "setStatus"> = { setStatus: () => Promise.reject(new Error("process died")) };
	const row2 = inboxClaimRow("investigate", second.id, to, T0);
	await assert.rejects(handOver(handOverDeps(crash.store, fakeWindowPi(true), crash.sinks), row2, { inbox: dies, entryId: second.id }), /process died/);
	assert.deepEqual(crash.store.list("s").map((r) => r.id), [row2.id], "the hand-off is queued");
	assert.equal(crash.inbox.list().find((e) => e.id === second.id)?.status, "new", "and the finding is still new");
});

test("a claim while pi is busy prints the queued line, and one typed after Esc ends the hold", async () => {
	const { store, inbox, sinks } = world();
	const entry = await inbox.append({ source: "cron:j", run_id: "run-1", cwd: "/proj", text: "disk is full" });
	const busy = fakeWindowPi(false);
	const row = inboxClaimRow("investigate", entry.id, to, T0);
	const out = await handOver(handOverDeps(store, busy, sinks), row, { inbox, entryId: entry.id });
	assert.deepEqual([out.written, out.result?.waiting, out.line], [true, [row.id], "queued: runs after the current turn"], "the claim was written by this very hand-over, so the line is its");
	assert.deepEqual(busy.sent, []);
	const again = await handOver(handOverDeps(store, busy, sinks), inboxClaimRow("investigate", entry.id, to, T0 + 1), { inbox, entryId: entry.id });
	assert.deepEqual([again.written, again.line], [false, undefined], "a second claim of the same finding collapses, and the queued one already said so");

	const held = fakeWindowPi(true);
	held.executor.agentStarted(T0 - 5_000);
	held.executor.agentEnded(T0, true);
	store.append(turnRow("t1"));
	const stop = world();
	stop.store.append(turnRow("t1"));
	await drain("s", stop.store, held.executor, T0 + 1_000, stop.sinks);
	assert.deepEqual(held.sent, [], "the stopped run holds queued turns");
	const typed = inboxClaimRow("fix", "inb-9", to, T0 + 2_000);
	const now = await handOver(handOverDeps(stop.store, held, stop.sinks, T0 + 3_000), typed);
	assert.deepEqual([now.result?.delivered, now.line, held.sent.map((s) => s.text)], [[typed.id], undefined, [typed.payload!.text]], "typed by the person: the hold ends and the claim runs now");
	const push = pushRunRow("[Trigger p1] x", { traceId: "p1", idempotencyKey: "mcp:gh:tools", source: { kind: "mcp", serverName: "gh" } }, to, T0);
	const pushed = await handOver(handOverDeps(stop.store, fakeWindowPi(false), stop.sinks), push);
	assert.equal(pushed.line, "queued triggered turn (trace p1) after the current one");
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
	const claim = inboxClaimRow("investigate", "inb-1", by(11), T0);
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
	viewer.entries.push({ type: "message", message: { role: "user", content: claim.payload!.text } });
	const again = await drain("s", store, viewer.executor, T0, sinks);
	assert.deepEqual([again.delivered, again.removed, again.waiting], [[], [claim.id], []], "the viewer finishes its claim and does not see the cron row");
	assert.deepEqual(store.list("s").map((r) => r.id), [cron.id]);
	// The same process in `pi -p`: no lease is ever taken there, and its own claim still runs there.
	const print = fakeWindowPi(true, { holds: false, self: { pid: 11, procStart: "start-11" }, mode: "print" });
	const other = inboxClaimRow("fix", "inb-2", by(11), T0);
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
	const claim = inboxClaimRow("investigate", "inb-1", by(11), T0);
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

test("a claim typed after Esc runs before an older queued cron row", async () => {
	const { store, sinks } = world();
	const cron = turnRow("t1");
	store.append(cron);
	const w = fakeWindowPi(true);
	w.executor.agentStarted(T0 - 5_000);
	w.executor.agentEnded(T0, true);
	await drain("s", store, w.executor, T0 + 1_000, sinks);
	assert.deepEqual(w.sent, [], "the stopped run holds the cron row");
	const claim = inboxClaimRow("investigate", "inb-1", to, T0 + 2_000);
	enqueue(store, claim);
	w.executor.produced(claim);
	const out = await drain("s", store, w.executor, T0 + 3_000, sinks);
	assert.deepEqual(w.sent.map((s) => s.text), [claim.payload!.text], "what the person typed goes first, and ends the hold");
	assert.deepEqual([out.delivered, out.waiting], [[claim.id], [cron.id]]);
	assert.deepEqual(decideDrain([cron, claim], none, jobs, view(), T0).map((a) => a.do === "turn" || a.do === "wait" ? `${a.do} ${a.row.id}` : a.do), [`turn ${claim.id}`, "wait t1"], "typed first, then oldest first");
	const recipe = recipeRow("r", "daily", "tracker", to, T0);
	assert.equal(w.executor.view("s").heldUntil, undefined);
	w.executor.agentEnded(T0, true);
	w.executor.produced(goalRow("p", { condition: "c", iterations: 1, updatedAt: "t" }, to, T0));
	assert.notEqual(w.executor.view("s").heldUntil, undefined, "a goal continuation is not the person's input");
	w.executor.produced(recipe);
	assert.equal(w.executor.view("s").heldUntil, undefined, "a recipe hand-off the person typed is");
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

test("the window says when a row it produced waits, in the words each source had", () => {
	assert.equal(waitingLine("push:gh", "abcdef0123"), "queued triggered turn (trace abcdef01) after the current one");
	for (const source of ["inbox:inb-1", "recipe:daily", "new-trigger"] as const) assert.equal(waitingLine(source, "x"), "queued: runs after the current turn", source);
	assert.equal(waitingLine("goal", "goal-1"), undefined, "the goal printed its own notice");
	assert.equal(waitingLine("cron:j", "run-1"), undefined, "a plain job is not produced by hand");
});

test("WindowExecutor.turn announces cron and push turns, not a claim or a goal continuation", () => {
	const w = fakeWindowPi(true);
	w.executor.turn(turnRow("run-11111111"));
	w.executor.turn(pushRunRow("[Trigger trace-2222] x", { traceId: "trace-2222", idempotencyKey: "mcp:gh:tools", source: { kind: "mcp", serverName: "gh" } }, to, T0));
	assert.deepEqual(w.notices, ["running triggered turn (trace run-1111)", "running triggered turn (trace trace-22)"]);
	w.executor.turn(inboxClaimRow("x", "inb-1", to, T0));
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
	const claim = inboxClaimRow("x", "inb-1", by(11), T0);
	for (const r of [claim, mine1, live, dead, mine2]) store.append(r);
	const alive = (row: SessionRequest) => row.created_by.pid !== 33;
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
	const claim = inboxClaimRow("investigate", "inb-1", { ...to, createdBy: { ...me, instance: "w", version: "0" } }, Date.now());
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
	assert.equal(left.created_by.left, "2026-06-01T12:00:00.000+00:00");
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
	const r = (created_by: SessionRequest["created_by"], created_at = new Date(T0 + 1_000).toISOString()) => ({ created_by, created_at });
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
	const claim = inboxClaimRow("x", "inb-1", to, T0);
	const brief = (a: Action) => (a.do === "append" ? `append ${a.row.id} wake=${a.wakeAgent}` : a.do === "turn" || a.do === "wait" ? `${a.do} ${a.row.id}` : a.do);
	assert.deepEqual(decideDrain([result, cron, claim], none, jobs, view(), T0).map(brief), ["append r1 wake=false", `turn ${claim.id}`, "wait t1"], "the result keeps its place and lands first, without a turn; the claim takes the first turn slot");
	assert.deepEqual(decideDrain([cron, result, claim], none, jobs, view(), T0).map(brief), [`turn ${claim.id}`, "append r1 wake=true", "wait t1"], "a result queued after a turn slot is a follow-up, as before");
	assert.deepEqual(decideDrain([result, claim], none, jobs, view({ idle: false }), T0).map(brief), ["append r1 wake=true", `wait ${claim.id}`]);
});

test("a window leaving a conversation removes a local row it already ran there instead of leaving it to the holder", () => {
	const { store } = world();
	const me = { pid: process.pid, procStart: procStart(process.pid) };
	const ran = inboxClaimRow("investigate", "inb-1", { ...to, createdBy: { ...me, instance: "w", version: "0" } }, Date.now());
	const waiting = newTriggerRow("make a rule", { ...to, createdBy: { ...me, instance: "w", version: "0" } }, Date.now());
	enqueue(store, ran);
	enqueue(store, waiting);
	// The claim's turn started here and its message is in this window's conversation; the holder's copy need not show it yet.
	assert.deepEqual(releaseLocalRows(store, "s", me, (id) => id === ran.id, T0), [waiting.id]);
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
		entries: () => ({ has: (id) => written.get(sid)!.has(id) }),
		view: () => ({ kind: "window", ceiling: () => true, admits: () => true, idle: true, inFlight: inFlight.get(sid)!, connected: () => true, producerAlive: () => true, mine: () => true }),
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
			store.append(row(id, { session_id: sid }));
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
	w.executor.agentEnded(T0 + 10_000, false);
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
	assert.deepEqual(decideDrain([early], none, jobs, view({ running: { startedAt: "2026-06-01T20:00:00+09:00" } }), T0), [{ do: "abort", stop: early }, { do: "remove", row: early, why: "done" }]);
	// 03:00-09:00 is 12:00Z: after 11:30Z as a time, before it as a string.
	const late = row("s5", { kind: "stop", source: "cli", target: { current: true, started_before: "2026-06-01T11:30:00Z" } });
	assert.deepEqual(decideDrain([late], none, jobs, view({ running: { startedAt: "2026-06-01T03:00:00-09:00" } }), T0), [{ do: "remove", row: late, why: "stale" }]);
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
	w.executor.messageStarted({ role: "user", content: "[Trigger other] not it" });
	assert.equal(w.ctx.aborts, 0);
	w.executor.messageStarted({ role: "user", content: "[Trigger t1] hello" });
	assert.equal(w.ctx.aborts, 1, "aborted as its turn starts");
	w.entries.push({ type: "message", message: { role: "user", content: "[Trigger t1] hello" } });
	w.executor.agentEnded(T0 + 3_000, true);
	await drain("s", store, w.executor, T0 + 4_000, sinks);
	assert.deepEqual(store.list("s"), [], "pi wrote the prompt at message_end: the row is done, not offered again");
	w.executor.messageStarted({ role: "user", content: "[Trigger t1] hello" });
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

test("a stop for a row pi dropped removes it instead of starting it again", async () => {
	const { store, sinks, audit } = world();
	store.append(turnRow("t1"));
	const w = fakeWindowPi(true);
	await drain("s", store, w.executor, T0, sinks);
	assert.equal(w.sent.length, 1, "handed to pi");
	store.append(stopRow("s", { id: "t1" }, "cli", { pid: 1, instance: "cli", version: "0" }, T0));
	await drain("s", store, w.executor, T0 + 1_000, sinks);
	// Esc: pi dropped t1 without starting it.
	assert.deepEqual(w.executor.settled(), ["t1"]);
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
const userEntry = (text: string, at: number) => ({ type: "message", timestamp: new Date(at).toISOString(), message: { role: "user", content: [{ type: "text", text }] } });

test("a person row is done once a user message with its text follows its hand-over stamp, and pi's image note does not hide it", async () => {
	// pi appends a note to the text when it resizes or converts an image ("\n\n[Image: original …]"),
	// so the message starts with the row's text and need not equal it. The proof is read against
	// `handed_at`, the stamp the drain writes under the lock just before the hand-over: a "look" from
	// an hour ago, or from before the stamp, proves nothing, and a row never handed over is never done.
	const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
	const row = personRow("p1", "look", [image], { sessionId: "s", cwd: "/p", createdBy: page }, T0);
	const note = "look\n\n[Image: original 2880x1800, displayed at 2000x1250. Multiply coordinates by 1.44 to map to original image.]";
	const entries: unknown[] = [userEntry("look", T0 - 3_600_000)];
	const conv = conversationView(() => entries);
	assert.equal(landed(row, conv), false, "never handed over: never done");
	const handed = { ...row, handed_at: stamp(T0 + 1_000) };
	assert.equal(landed(handed, conv), false, "a 'look' from an hour ago is not this delivery");
	entries.push(userEntry(note, T0 + 2_000));
	assert.equal(landed(handed, conv), true, "pi's note after the text is still this message");
	assert.equal(landed({ ...row, handed_at: stamp(T0 + 3_000) }, conv), false, "and never a message older than the stamp");
	// Through the drain: the stamp is written as the row is handed over, and the message removes it.
	const { store, sinks, audit } = world();
	store.append(row);
	const w = fakeWindowPi(true, { rows: () => store.list("s") });
	w.executor.produced(row);
	await drain("s", store, w.executor, T0, sinks);
	const stampedAt = Date.parse(store.list("s")[0]?.handed_at ?? "");
	assert.ok(stampedAt >= T0 && stampedAt < T0 + 1_000, `stamped under the lock as it went, at the moment of the stamp (${stampedAt - T0} ms after the drain was asked for)`);
	w.entries.push(userEntry(note, T0 + 500));
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
	w.entries.push(userEntry("yes", T0 + 2_500));
	out = await drain("s", store, w.executor, T0 + 3_000, sinks);
	assert.deepEqual([out.removed, out.delivered], [["p1"], ["p2"]], "the first is proved and the second goes, in one drain");
	assert.deepEqual(store.list("s").map((r) => [r.id, Date.parse(r.handed_at!) >= T0 + 3_000]), [["p2", true]], "the second waits for a message after its own stamp");
	out = await drain("s", store, w.executor, T0 + 4_000, sinks);
	assert.deepEqual([out.removed, w.sent.length], [[], 2], "the first's message does not prove the second");
	w.entries.push(userEntry("yes", T0 + 4_500));
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
	assert.deepEqual(w2.sent.map((s) => s.text), ["hello"], "nobody rang: handed over anyway, capped (test/window-guard.test.ts)");
});

test("a person row goes to pi as the person's message, images with it, and a person's rows take the lane first", async () => {
	const { store, sinks } = world();
	store.append(turnRow("t1"));
	const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
	const row = personRow("p1", "look", [image], { sessionId: "s", cwd: "/p", createdBy: page }, T0);
	store.append(row);
	assert.deepEqual(queueOrder(store.list("s")).map((r) => r.id), ["p1", "t1"]);
	const w = fakeWindowPi(true, { rows: () => store.list("s") });
	w.executor.produced(row);
	await drain("s", store, w.executor, T0, sinks);
	assert.deepEqual(w.sent, [{ text: [{ type: "text", text: "look" }, image], options: { deliverAs: "followUp" } }], "the person's row first, as pi's own prompt takes it");
	// A row with no text is proved by a message with no text of its own once pi's image notes are
	// stripped, and by nothing else: not a cron turn, not words the person typed in the terminal.
	const imageOnly = { ...personRow("p2", "", [image], { sessionId: "s", cwd: "/p", createdBy: page }, T0), handed_at: stamp(T0 + 100) };
	assert.equal(landed(imageOnly, conversationView(() => [])), false);
	assert.equal(landed(imageOnly, conversationView(() => [userEntry("[Trigger abc] run the nightly check", T0 + 200)])), false, "a cron turn is not the person's image");
	assert.equal(landed(imageOnly, conversationView(() => [userEntry("look at this", T0 + 200)])), false, "nor are words typed in the terminal");
	assert.equal(landed(imageOnly, conversationView(() => [userEntry("\n\n[Image: original 2880x1800, displayed at 2000x1250. Multiply coordinates by 1.44 to map to original image.]", T0 + 200)])), true, "its own entry: pi's note and nothing else");
	assert.equal(landed(imageOnly, conversationView(() => [{ type: "message", timestamp: new Date(T0 + 200).toISOString(), message: { role: "user", content: [image] } }])), true, "or no text at all");
	assert.equal(stripImageNotes("fix\n\n[Image: original 2880x1800, displayed at 2000x1250. Multiply coordinates by 1.44 to map to original image.][Image omitted: could not be resized below the inline image size limit.]\n[Image converted from image/avif to image/png.]"), "fix");
	const alone = world();
	alone.store.append(personRow("p2", "", [image], { sessionId: "s", cwd: "/p", createdBy: page }, T0));
	const w2 = fakeWindowPi(true, { rows: () => alone.store.list("s") });
	const out = await drain("s", alone.store, w2.executor, T0 + PERSON_RING_WAIT_MS, alone.sinks);
	assert.deepEqual([out.dead, w2.sent.length], [[], 1], "an image alone is a message, not a dead letter");
});

test("a person row pi refused gets last_error once pi stayed idle past the grace, and is never handed over again", async () => {
	const { store, sinks, audit } = world();
	const row = fromPage("p1", "hello", T0);
	store.append(row);
	const w = fakeWindowPi(true, { rows: () => store.list("s") });
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
	const w2 = fakeWindowPi(true, { rows: () => slow.store.list("s") });
	w2.executor.produced(slowRow);
	await drain("s", slow.store, w2.executor, T0, slow.sinks);
	w2.executor.agentStarted(T0 + 200);
	w2.ctx.idle = false;
	out = await drain("s", slow.store, w2.executor, T0 + 30_000, slow.sinks, { tick: true });
	assert.deepEqual([out.failed, out.waiting], [[], ["p2"]]);
	w2.entries.push(userEntry("slow", T0 + 30_500));
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
	w4.executor.agentEnded(T0 + 5_000, false);
	out = await drain("s", taken.store, w4.executor, T0 + 6_000, taken.sinks, { tick: true });
	assert.deepEqual([out.failed, out.waiting], [[], ["p4"]], "pi took a run since: not a refusal");
	assert.deepEqual(w4.executor.settled(), ["p4"], "dropped with pi's queue: offered again");
	await drain("s", taken.store, w4.executor, T0 + 7_000, taken.sinks);
	assert.equal(w4.sent.length, 2);
});

test("after Stop, the person's queued rows wait until they send again", async () => {
	const { store, sinks } = world();
	const first = fromPage("p1", "first", T0);
	store.append(first);
	const w = fakeWindowPi(true, { rows: () => store.list("s") });
	w.executor.produced(first);
	w.executor.agentStarted(T0 - 5_000);
	w.executor.agentEnded(T0, true);
	let out = await drain("s", store, w.executor, T0 + 1_000, sinks);
	assert.deepEqual([w.sent, out.waiting], [[], ["p1"]], "a stopped run holds what the person had queued");
	for (const later of [59_000, 61_000, 3_600_000]) {
		await drain("s", store, w.executor, T0 + later, sinks);
		assert.deepEqual(w.sent, [], `no clock sends words a person stopped (${later / 1000} s later)`);
	}
	// They send again: the page's ring records the new row as produced, which is their input.
	const second = fromPage("p2", "second", T0 + 3_600_000);
	store.append(second);
	w.executor.produced(second);
	out = await drain("s", store, w.executor, T0 + 3_600_500, sinks);
	assert.deepEqual(w.sent.map((s) => s.text), ["first"], "the older of their messages goes first");
	assert.deepEqual(out.waiting, ["p2"], "one lane: the next waits for the turn to end");
	// Typing in the window ends it too; pi-loops' own rows still wait out the minute without that.
	const typed = world();
	typed.store.append(fromPage("p3", "mine", T0));
	typed.store.append(turnRow("t1"));
	const w2 = fakeWindowPi(true, { rows: () => typed.store.list("s") });
	w2.executor.produced(typed.store.list("s")[0]);
	w2.executor.agentEnded(T0, true);
	await drain("s", typed.store, w2.executor, T0 + 61_000, typed.sinks);
	assert.deepEqual(w2.sent.map((s) => s.text), ["[Trigger t1] hello"], "the clock releases pi-loops' row, not the person's");
	w2.executor.personInput();
	await drain("s", typed.store, w2.executor, T0 + 62_000, typed.sinks);
	assert.deepEqual(w2.sent.map((s) => s.text), ["[Trigger t1] hello", "mine"]);
});

test("a terminal holder hands a page's row over when the ring wait ends, with no tick", { timeout: 10_000 }, async () => {
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
	const again = () => {
		fired++;
		void drain("s", store, w.executor, Date.now(), sinks).catch(() => undefined);
	};
	armRetry(timers, "s", 10, again);
	armRetry(timers, "s", out.retryAt! - Date.now(), again);
	assert.equal(timers.size, 1, "one timer per session");
	const deadline = now + PERSON_RING_WAIT_MS + 1_500;
	while (!w.sent.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
	assert.deepEqual(w.sent.map((s) => s.text), ["from the page"], "handed over within the ring wait plus a margin, with no tick");
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

test("a page's row written or released after a Stop is not held by it, so a terminal holder answers it", async () => {
	// Owner decision O2: the terminal holds, the page rings its own pi, and nobody types in the
	// terminal. The hold a Stop put on the person's rows must still lift for what the person does on
	// the page: a new send is a row created after the hold began; "send queued" writes `released_at`.
	const { store, sinks } = world();
	const before = fromPage("p1", "earlier", T0 - 10_000);
	store.append(before);
	const w = fakeWindowPi(true, { rows: () => store.list("s") });
	w.executor.agentStarted(T0 - 5_000);
	w.executor.agentEnded(T0 - 1_000, true);
	let out = await drain("s", store, w.executor, T0 + 3_600_000, sinks);
	assert.deepEqual([w.sent, out.waiting], [[], ["p1"]], "queued before the Stop: held, an hour later too");
	const after = fromPage("p2", "continue", T0);
	store.append(after);
	out = await drain("s", store, w.executor, T0 + 3_600_000, sinks);
	assert.deepEqual([w.sent.map((s) => s.text), out.waiting], [["continue"], ["p1"]], "sent after the Stop: not held; the earlier one still is");
	store.update("s", "p1", { released_at: stamp(T0 + 3_600_000) });
	w.entries.push(userEntry("continue", T0 + 3_600_001));
	out = await drain("s", store, w.executor, T0 + 3_600_002, sinks);
	assert.deepEqual(w.sent.map((s) => s.text), ["continue", "earlier"], "send queued released it");
});

test("a hand-over stamp is the moment of the stamp, not the moment the drain was asked for", async () => {
	// Drains queue behind one another. The first here has a dead letter to write, which awaits the
	// inbox; the second was asked for at T0 and runs once the first is done. A message the person
	// typed in between must not prove the row the second one stamps.
	const { store, inbox, audit } = world();
	const slow: EngineSinks = { jobs: { exists: () => true, enabled: () => true, goalActive: () => true }, inbox: { append: async (entry) => { await new Promise((r) => setTimeout(r, 300)); return inbox.append(entry); } } as any, audit };
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
function windowOn(store: RequestStore, idle = true) {
	const sent: Array<{ text: string; options: unknown }> = [];
	const appended: Array<{ content: unknown; options: unknown }> = [];
	const entries: unknown[] = [];
	const ctx = { idle, mode: "tui", hasUI: false, isIdle: () => ctx.idle, abort: () => undefined, sessionManager: { getEntries: () => entries }, ui: { notify: () => undefined } } as any;
	const pi = { sendMessage: (m: { content: unknown }, options: unknown) => void appended.push({ content: m.content, options }), sendUserMessage: (text: string, options: unknown) => void sent.push({ text, options }) };
	const executor = new WindowExecutor(pi, { here: () => ({ sessionId: "s", holds: true }) }, () => ctx, { pid: 1 }, () => true, () => store.list("s"));
	return { sent, appended, entries, ctx, executor };
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
	const broken: EngineSinks = { jobs: { exists: () => { throw new Error("jobs.json is empty; restore it from jobs.json.bak"); }, enabled: () => true, goalActive: () => true }, inbox: { append: async () => undefined } as any, audit };
	const w = windowOn(store);
	const out = await drain("s", store, w.executor, T0 + 5_000, broken);
	assert.deepEqual([out.delivered.sort(), out.waiting], [[page.id, "tr-1"].sort(), [clock.id]], "the queue drains around the one row that cannot be judged");
	assert.deepEqual([w.sent.length, w.appended.length], [1, 1]);
	const why = decideDrain(store.list("s"), conversationView(() => []), broken.jobs, w.executor.view("s"), T0 + 5_000).find((a) => a.row?.id === clock.id);
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
	assert.deepEqual(decideDrain(store.list("s"), conversationView(() => []), sinks.jobs, w.executor.view("s"), T0).map((a) => (a.do === "wait" ? a.why : a.do)), ["its job is disabled"]);
	enabled = true;
	out = await drain("s", store, w.executor, T0 + 1, sinks);
	assert.deepEqual(out.delivered, [parked.id], "enabled again: it runs");
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

test("after Esc, /cron run's row ends the hold and takes the lane before the clock's row", async () => {
	const { store, sinks } = world();
	const clock = plainJobRow(plainJob(), plainRunId("j1", "2026-06-01T12:00:00Z"), "cron:j1", "", plainBy, T0);
	const asked = plainJobRow(plainJob(), plainRunId("j1", "2026-06-01T12:00:30Z"), "cron-run:j1", "", plainBy, T0 + 30_000);
	store.append(clock);
	store.append(asked);
	const w = windowOn(store);
	w.executor.agentStarted(T0 + 1_000);
	w.executor.agentEnded(T0 + 2_000, true); // Esc
	w.executor.settled();
	let out = await drain("s", store, w.executor, T0 + 31_000, sinks);
	assert.deepEqual([out.delivered, out.waiting], [[], [asked.id, clock.id]], "held after a stop, the person's ask listed first");
	assert.equal(typedByPerson("cron-run:j1"), true);
	w.executor.produced(asked); // what the scheduler's onRowWritten hook does for the row /cron run wrote
	out = await drain("s", store, w.executor, T0 + 32_000, sinks);
	assert.deepEqual(out.delivered, [asked.id], "typed by the person: the hold is over and theirs goes first");
	assert.deepEqual(w.sent.map((s) => s.text), [asked.payload!.text]);
});

test("the background process leaves a goal continuation a quitting window left for a window", () => {
	const now = Date.now();
	const left = goalRow("[goal] keep going", { condition: "tests pass", iterations: 2, updatedAt: stamp(now) }, { sessionId: "s", cwd: "/x", createdBy: { ...plainBy, left: stamp(now) } }, now);
	// heldView in src/host-runtime.ts, and its sinks: goalActive is always false there.
	const host: ExecutorView = { kind: "held", ceiling: CEILING.held, admits: (r) => r.wake !== "turn", idle: true, inFlight: new Set(), connected: () => true, producerAlive: () => true, mine: () => false };
	assert.deepEqual(decideDrain([left], conversationView(() => []), { exists: () => true, enabled: () => true, goalActive: () => false }, host, now).map((a) => a.do), ["wait"]);
});

test("a prompt an input extension rewrites runs once, under its row's cap, as 0.22 did", async () => {
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
		// pi runs the turn; another extension's `input` handler prepends a note, so the stored user
		// message no longer starts with the prefix and the row can never be proved by the file.
		const text = `Respond briefly. ${w.sent.at(-1)!.text}`;
		w.executor.agentStarted(at + 1);
		w.executor.messageStarted({ role: "user", content: text }, at + 2);
		caps.push(w.executor.currentTurn());
		w.entries.push({ type: "message", message: { role: "user", content: text } });
		w.executor.agentEnded(at + 3, false);
		w.executor.settled();
	}
	assert.equal(turns, 1, "it ran: offered again it would run a second time, with whatever side effects it has");
	assert.deepEqual(caps, [{ kind: "row", id, mode: "unattended", tools: ["read"], builtinTools: undefined }], "under the row's cap, prefix or not");
	assert.deepEqual(store.list("s"), [], "the row is gone");
	assert.equal(inbox.listNew().length, 0, "and a run that happened is not a dead letter");
});

test("a hand-over is judged refused only after the grace has passed since pi's last input, not since the hand-over", async () => {
	const { store, sinks } = world();
	const id = plainRunId("j1", "2026-06-01T12:00:00Z");
	store.append(plainJobRow(plainJob(), id, "cron:j1", "", plainBy, T0));
	const w = windowOn(store);
	assert.deepEqual((await drain("s", store, w.executor, T0, sinks)).delivered, [id]);
	w.executor.inputSeen(T0 + 8_000); // pi emitted `input` for our prompt: it is in its pre-run phase
	let out = await drain("s", store, w.executor, T0 + 8_000 + PERSON_SEND_GRACE_MS - 1, sinks, { tick: true });
	assert.deepEqual([out.failed, out.waiting], [[], [id]], "past the grace since the hand-over, not since the input");
	out = await drain("s", store, w.executor, T0 + 8_000 + PERSON_SEND_GRACE_MS, sinks, { tick: true });
	assert.deepEqual(out.failed, [id]);
	const left = store.list("s")[0];
	assert.deepEqual([left.attempts, left.last_error, left.not_before], [1, "pi did not start a turn for it", stamp(T0 + 8_000 + PERSON_SEND_GRACE_MS + BACKOFF_MS[0])], "a pi-loops row backs off and is offered again");
	assert.equal(w.executor.view("s").inFlight.has(id), false);
	assert.equal(PERSON_SEND_GRACE_MS, 10_000, "pi's pre-run phase after its input event (other input handlers, the credential check) is what is left to cover");
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
