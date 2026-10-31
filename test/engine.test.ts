import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmp } from "./tmp.ts";
import { Inbox } from "../src/inbox.ts";
import { TriggerStore } from "../src/triggers.ts";
import { RequestStore, type SessionRequest } from "../src/requests.ts";
import { type Action, BACKOFF_MS, DEAD_AFTER_ATTEMPTS, bury, cancelRow, heldTurnFor, stopRow, type EngineSinks, type Executor, type ExecutorView, type Producer, conversationHas, decideDrain, drain, dropContinuations, enqueue, goalRow, goalRunId, handOver, handOverTarget, inboxClaimRow, isLocal, modeOf, newTriggerRow, promotionTarget, pushRunRow, recipeRow, releaseLocalRows, sameProducer, typedByPerson, waitingLine } from "../src/engine.ts";
import { WindowExecutor, forgetDropped, producerAlive, showsTriggeredTurnLine } from "../src/window-executor.ts";
import { procStart } from "../src/lease.ts";
import { stamp } from "../src/schedule.ts";

const row = (id: string, over: Partial<SessionRequest> = {}): SessionRequest => ({ v: 2, id, session_id: "s", kind: "input", source: "rule:local:dynamic", mode: "none", wake: "append", payload: { text: `[Trigger ${id}] hello`, cwd: "/" }, created_at: "2026-01-01T00:00:00Z", created_by: { pid: 1, instance: "w", version: "0" }, attempts: 0, ...over });

const T0 = Date.parse("2026-06-01T12:00:00Z");

function world(dir = tmp()) {
	const store = new RequestStore(dir);
	const inbox = new Inbox(dir);
	const audit = new TriggerStore(dir);
	const sinks: EngineSinks = { jobs: { exists: () => true, goalActive: () => true }, inbox, audit };
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
		entries: () => ({ has: (id) => written.has(id) }),
		view: () => ({ kind: "window", admits: () => true, idle: opts.idle ?? true, inFlight, connected: () => true, producerAlive: () => true, mine: () => true }),
		append: (r) => {
			(opts.deliver ?? ((d, w) => w.add(d.id)))(r, written);
			given.push(r.id);
		},
		turn: () => {
			throw new Error("no turns here");
		},
		abort: () => undefined,
		abortWhenStarted: () => undefined,
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

const view = (over: Partial<ExecutorView> = {}): ExecutorView => ({ kind: "window", admits: () => true, idle: true, inFlight: new Set(), connected: () => true, producerAlive: () => true, mine: () => true, ...over });
const none = { has: () => false };
const jobs = { exists: () => true, goalActive: () => true };

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
	assert.deepEqual(decideDrain([goal], none, { ...jobs, goalActive: () => false }, view(), T0), [{ do: "remove", row: goal, why: "stale" }]);
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
function fakeWindowPi(idle: boolean, opts: { holds?: boolean; self?: Producer; alive?: (row: SessionRequest) => boolean; mode?: string } = {}) {
	const sent: Array<{ text: string; options: unknown }> = [];
	const appended: Array<{ content: unknown; options: unknown }> = [];
	const notices: string[] = [];
	const entries: unknown[] = [];
	const ctx = { idle, aborts: 0, mode: opts.mode ?? "tui", hasUI: true, isIdle: () => ctx.idle, abort: () => void ctx.aborts++, sessionManager: { getEntries: () => entries }, ui: { notify: (line: string) => void notices.push(line) } } as any;
	const pi = { sendMessage: (m: { content: unknown }, options: unknown) => void appended.push({ content: m.content, options }), sendUserMessage: (text: string, options: unknown) => void sent.push({ text, options }) };
	const executor = new WindowExecutor(pi, { here: () => ({ sessionId: "s", holds: opts.holds ?? true }) }, () => ctx, opts.self ?? { pid: 1 }, opts.alive ?? (() => true));
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

	const recipe = recipeRow("Describe the tracker", "daily", to, T0);
	assert.match(recipe.id, /^recipe-[0-9a-f]{32}$/);
	assert.deepEqual([recipe.source, recipe.mode, recipe.wake, recipe.collapse_key], ["recipe:daily", "attended", "turn", "recipe:daily"]);
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
	for (const source of ["goal", "cron:j", "cron-run:j", "push:gh", "rule:local:dynamic"] as const) assert.equal(typedByPerson(source), false, source);
});

test("enqueue: a second row with a queued collapse key is not written; one with no key always is", () => {
	const { store } = world();
	assert.equal(enqueue(store, recipeRow("a", "daily", to, T0)), true);
	assert.equal(enqueue(store, recipeRow("b", "daily", to, T0)), false, "collapse, never replay");
	assert.equal(enqueue(store, recipeRow("c", "weekly", to, T0)), true, "another recipe is another lane");
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
	const withGoal: EngineSinks = { ...sinks, jobs: { exists: () => true, goalActive: () => active } };
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
	const noGoal: EngineSinks = { ...sinks, jobs: { exists: () => true, goalActive: () => false } };
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
	const recipe = recipeRow("r", "daily", to, T0);
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
	w.executor.turn(recipeRow("x", "daily", to, T0));
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
		view: () => ({ kind: "window", admits: () => true, idle: true, inFlight: inFlight.get(sid)!, connected: () => true, producerAlive: () => true, mine: () => true }),
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
