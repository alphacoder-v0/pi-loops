import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmp } from "./tmp.ts";
import { Inbox } from "../src/inbox.ts";
import { TriggerStore } from "../src/triggers.ts";
import { RequestStore, type SessionRequest } from "../src/requests.ts";
import { BACKOFF_MS, DEAD_AFTER_ATTEMPTS, type EngineSinks, type Executor, type ExecutorView, conversationHas, decideDrain, drain, modeOf, promotionTarget } from "../src/engine.ts";
import { WindowExecutor, forgetDropped } from "../src/window-executor.ts";

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
		view: () => ({ kind: "window", admits: () => true, idle: opts.idle ?? true, inFlight, connected: () => true, producerAlive: () => true }),
		append: (r) => {
			(opts.deliver ?? ((d, w) => w.add(d.id)))(r, written);
			given.push(r.id);
		},
		turn: () => {
			throw new Error("no turns here");
		},
		abort: () => undefined,
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

const view = (over: Partial<ExecutorView> = {}): ExecutorView => ({ kind: "window", admits: () => true, idle: true, inFlight: new Set(), connected: () => true, producerAlive: () => true, ...over });
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

/** A window over a fake pi: `sent` is what reached `sendUserMessage`, `appended` what reached `sendMessage`, `entries` the conversation. */
function fakeWindowPi(idle: boolean) {
	const sent: Array<{ text: string; options: unknown }> = [];
	const appended: Array<{ content: unknown; options: unknown }> = [];
	const entries: unknown[] = [];
	const ctx = { idle, mode: "tui", hasUI: false, isIdle: () => ctx.idle, sessionManager: { getEntries: () => entries }, ui: { notify: () => undefined } } as any;
	const pi = { sendMessage: (m: { content: unknown }, options: unknown) => void appended.push({ content: m.content, options }), sendUserMessage: (text: string, options: unknown) => void sent.push({ text, options }) };
	const executor = new WindowExecutor(pi, { here: () => ({ sessionId: "s", holds: true }) }, () => ctx);
	return { sent, appended, entries, ctx, executor };
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
