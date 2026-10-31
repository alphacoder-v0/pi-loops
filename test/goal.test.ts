import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import { Inbox } from "../src/inbox.ts";
import { TriggerStore } from "../src/triggers.ts";
import { RequestStore } from "../src/requests.ts";
import { type EngineSinks, drain, enqueue, goalRow } from "../src/engine.ts";
import { WindowExecutor } from "../src/window-executor.ts";
import { GOAL_ENTRY, MAX_CONTINUATIONS, abortedTurn, applyDecision, branchMovedSince, continuationPending, continuationPrompt, evaluatorPrompt, goalActive, goalLine, goalPursued, settledTurn, latestGoal, newGoal, parseDecision, pauseFor, transcriptFromMessages } from "../src/goal.ts";

test("the evaluator's decision drives the turn, with a budget and pause-on-failure", () => {
	let state = newGoal("the test suite passes");
	assert.equal(state.status, "pursuing");
	assert.equal(goalActive(state), true);

	// Not satisfied: the agent is sent back to work with what is missing.
	const again = applyDecision(state, { ok: false, reason: "3 tests still fail" });
	assert.equal(again.state.iterations, 1);
	assert.equal(again.action.kind, "continue");
	assert.match((again.action as any).prompt, /not satisfied yet/);
	assert.match((again.action as any).prompt, /3 tests still fail/);
	assert.match((again.action as any).prompt, /Do not claim completion/);

	// Satisfied: it stops, and the evidence is kept.
	const done = applyDecision(again.state, { ok: true, reason: "cargo test reported 0 failures" });
	assert.equal(done.state.status, "achieved");
	assert.equal(done.action.kind, "stop");
	assert.equal(done.state.lastReason, "cargo test reported 0 failures");

	// The budget is a hard stop, not an endless loop.
	state = newGoal("never satisfiable");
	for (let i = 0; i < MAX_CONTINUATIONS - 1; i++) state = applyDecision(state, { ok: false, reason: "no" }).state;
	const last = applyDecision(state, { ok: false, reason: "still no" });
	assert.equal(last.state.status, "budget_limited");
	assert.equal(last.action.kind, "pause");
	assert.match((last.action as any).reason, /continuation limit reached \(8\); resume with \/goal resume/);

	// An evaluator that cannot decide pauses instead of looping.
	const paused = pauseFor(newGoal("x"), "goal evaluator failed: no model");
	assert.equal(paused.state.status, "paused");
	assert.equal(paused.action.kind, "pause");
	assert.equal(goalActive(paused.state), true, "a paused goal is still the session's goal");
});

test("parseDecision accepts the shapes it must and refuses everything else", () => {
	assert.deepEqual(parseDecision('{"ok": true, "reason": "done"}'), { ok: true, reason: "done" });
	assert.deepEqual(parseDecision('here you go:\n{"ok": false, "reason": "missing X"}\nthanks'), { ok: false, reason: "missing X" });
	assert.throws(() => parseDecision('{"ok": true, "reason": "  "}'), /empty reason/);
	assert.throws(() => parseDecision("not json at all"), /invalid JSON/);
	assert.throws(() => parseDecision('{"reason": "no ok field"}'), /invalid JSON/);
});

test("the transcript is bounded and keeps the newest evidence", () => {
	const messages = [
		{ role: "user", content: "start" },
		{ role: "assistant", content: [{ type: "text", text: "thinking about it" }, { type: "toolCall", name: "bash" }] },
		{ role: "toolResult", content: [{ type: "text", text: "0 failures" }] },
	];
	const t = transcriptFromMessages(messages);
	assert.match(t, /^user: start\n/);
	assert.match(t, /<tool_call bash>/);
	assert.match(t, /0 failures$/);

	const long = transcriptFromMessages([{ role: "user", content: "x".repeat(500) }, { role: "assistant", content: "the newest line" }], 100);
	assert.ok(long.length <= 102, long.length);
	assert.match(long, /the newest line$/, "the cap truncates the front, never the recent evidence");
	assert.match(long, /^…/);

	// The limit is characters, not UTF-16 code units (one emoji is two). Counting units cut this to
	// roughly half the length and left the cut between the two halves of a character, which reaches
	// the evaluator as a lone surrogate.
	const emoji = transcriptFromMessages([{ role: "user", content: "😀".repeat(200) }, { role: "assistant", content: "zzzzz" }], 100);
	const body = emoji.slice(2); // drop the "…\n" marker
	assert.equal(Array.from(body).length, 100, "the cap counts characters, not UTF-16 code units");
	assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(body), "the cut never leaves half a character");
	assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(body), "the cut never leaves half a character");
});

test("the goal is restored from the session, and a cleared one stays gone", () => {
	const entries = [
		{ customType: "other", data: {} },
		{ customType: GOAL_ENTRY, data: newGoal("first") },
		{ customType: GOAL_ENTRY, data: { ...newGoal("second"), iterations: 2 } },
	];
	assert.equal(latestGoal(entries)?.condition, "second");
	assert.equal(latestGoal(entries)?.iterations, 2);
	assert.equal(latestGoal([...entries, { customType: GOAL_ENTRY, data: { ...newGoal("second"), status: "cleared" } }]), undefined);
	assert.equal(latestGoal([]), undefined);
	assert.equal(latestGoal([{ customType: GOAL_ENTRY, data: { junk: true } }]), undefined, "a malformed entry is not a goal");
});

test("the evaluator prompt carries its contract, the condition and the transcript", () => {
	const p = evaluatorPrompt("ship it", "user: hello");
	assert.match(p, /cannot call tools/);
	assert.match(p, /"ok": true/);
	assert.match(p, /insufficient evidence in transcript/);
	assert.match(p, /Goal condition:\nship it/);
	assert.match(p, /Conversation transcript:\nuser: hello/);
	assert.match(continuationPrompt("c", "r"), /Goal condition:\nc/);
	assert.match(goalLine(newGoal("x")), /pursuing \(0\/8 continuations\)/);
});

test("subcommands are exact words; a condition that starts with one is still a condition", () => {
	// The arms are guarded by arity; the first-token rule wiped live goals.
	const isSub = (text: string) => /^(pause|resume|clear|help|start)$/.test(text.trim());
	assert.equal(isSub("clear"), true);
	assert.equal(isSub("  clear  "), true);
	assert.equal(isSub("clear all the type errors and get CI green"), false, "this must set a condition, not wipe the goal");
	assert.equal(isSub("pause the deployment until tests pass"), false);
	assert.equal(isSub("resume"), true);
	assert.equal(isSub("start fix the flaky test"), false, "and must not become a condition named 'start …'");
});

test("a goal restored from a session carries a usable continuation budget", () => {
	// An archive carries goal_state verbatim; a non-numeric `iterations` used to make
	// `iterations + 1 >= MAX_CONTINUATIONS` false forever.
	for (const bad of [undefined, null, "3", Number.NaN, -1, 1.5]) {
		const restored = latestGoal([{ customType: GOAL_ENTRY, data: { ...newGoal("c"), iterations: bad } }])!;
		assert.equal(restored.iterations, 0, `iterations ${JSON.stringify(bad)} must not defeat the budget`);
	}
	let state = latestGoal([{ customType: GOAL_ENTRY, data: { ...newGoal("c"), iterations: Number.NaN } }])!;
	for (let i = 0; i < MAX_CONTINUATIONS; i++) state = applyDecision(state, { ok: false, reason: "no" }).state;
	assert.equal(state.status, "budget_limited", "and the budget still stops it");
});

test("a continuation is held when the user typed while the evaluator ran — not when a card moved the leaf", () => {
	// `e3` is where the session was when the evaluation started. The goal's own previous
	// continuation is already behind it: the turn that carried it had settled by then.
	const settled = [
		{ id: "e1", type: "message", message: { role: "user" } },
		{ id: "e2", type: "message", message: { role: "assistant" } },
		{ id: "e3", type: "custom", customType: GOAL_ENTRY },
	];
	const branch = (...appended: any[]) => [...settled, ...appended];
	assert.equal(branchMovedSince(branch(), "e3"), false, "nothing happened while the evaluator read the transcript");
	assert.equal(
		branchMovedSince(branch({ id: "e4", type: "custom", customType: "pi_loops_snapshot" }, { id: "e5", type: "custom", customType: "pi-loops:view" }), "e3"),
		false,
		"a snapshot and a run card move the leaf without anyone having taken the turn",
	);
	assert.equal(branchMovedSince(branch({ id: "e4", type: "message", message: { role: "user" } }), "e3"), true, "an unrelated prompt: the continuation must not be answered under it");
	assert.equal(branchMovedSince(branch({ id: "e4", type: "message", message: { role: "assistant" } }), "e3"), false);
	assert.equal(branchMovedSince(branch(), "gone"), true, "rewound or forked: the point the goal was judged at is not on this branch any more");
	assert.equal(branchMovedSince(branch(), null), false, "no leaf to compare against: behave as before");
});

test("a turn stopped with Esc pauses a pursued goal until /goal resume; other statuses are left alone", () => {
	const paused = abortedTurn(newGoal("the tests pass"));
	assert.ok(paused);
	assert.equal(paused.state.status, "paused");
	assert.equal(paused.action.kind, "pause");
	assert.match(paused.state.lastReason ?? "", /you stopped the turn/);
	assert.match(paused.state.lastReason ?? "", /\/goal resume/);
	assert.equal(goalActive(paused.state), true, "paused is still the session's goal — resume picks it up");
	assert.equal(abortedTurn(paused.state), undefined, "already paused: nothing to do");
	assert.equal(abortedTurn(applyDecision(newGoal("x"), { ok: true, reason: "done" }).state), undefined, "achieved stays achieved");
	let limited = newGoal("never");
	for (let i = 0; i < MAX_CONTINUATIONS; i++) limited = applyDecision(limited, { ok: false, reason: "no" }).state;
	assert.equal(limited.status, "budget_limited");
	assert.equal(abortedTurn(limited), undefined);
});

/** A session with a goal: the request store, a window over a fake pi, and the handler's settle decision. */
function goalSession() {
	const dir = tmp();
	const store = new RequestStore(dir);
	const sinks: EngineSinks = { jobs: { exists: () => true, enabled: () => true, goalActive: () => goalPursued(state) }, inbox: new Inbox(dir), audit: new TriggerStore(dir) };
	const sent: string[] = [];
	const entries: unknown[] = [];
	const ctx = { idle: true, mode: "tui", hasUI: false, isIdle: () => ctx.idle, sessionManager: { getEntries: () => entries }, ui: { notify: () => undefined } } as any;
	const executor = new WindowExecutor({ sendMessage: () => undefined, sendUserMessage: (text: string) => void sent.push(text) }, { here: () => ({ sessionId: "s", holds: true }) }, () => ctx, { pid: 1 }, () => true);
	const now = Date.parse("2026-06-01T12:00:00Z");
	const address = { sessionId: "s", cwd: "/p", createdBy: { pid: 1, instance: "w", version: "0" } };
	let state = newGoal("tests pass", new Date(now));
	let evaluations = 0;
	const delivered = (id: string) => executor.entries("s").has(id);
	const pending = () => continuationPending(store.list("s"), executor.handedOver, delivered);
	/** `evaluateGoal` as the handler passes it: judge, charge, hand the continuation over as a row; true when it did. */
	const evaluate = (at: number) => async () => {
		if (!goalPursued(state)) return false;
		evaluations++;
		const judged = applyDecision(state, { ok: false, reason: "3 fail" }, new Date(at));
		state = judged.state;
		if (judged.action.kind !== "continue") return false;
		assert.equal(enqueue(store, goalRow(judged.action.prompt, state, address, at), delivered), true, "the continuation is written");
		await drain("s", store, executor, at, sinks);
		return true;
	};
	/** The handler at `agent_settled`: what pi dropped is forgotten, then the settle decision (src/goal.ts). */
	const settled = async (at: number) => {
		executor.settled();
		return settledTurn(store.list("s"), executor.handedOver, delivered, evaluate(at), () => drain("s", store, executor, at, sinks));
	};
	return { store, sent, entries, ctx, executor, now, settled, pending, drain: (at: number) => drain("s", store, executor, at, sinks), state: () => state, evaluations: () => evaluations, pause: (at: number) => void (state = abortedTurn(state, new Date(at))?.state ?? state) };
}

test("in the idle-check race, a continuation queued behind the person's turn lands once and is charged once", async () => {
	const g = goalSession();
	assert.deepEqual(await g.settled(g.now), { pending: false, continued: true });
	assert.equal(g.evaluations(), 1);
	assert.equal(g.state().iterations, 1, "the evaluator charged one continuation");
	assert.equal(g.sent.length, 1, "and the row was handed to pi while idle");
	const text = g.sent[0];
	// The person started a run between the idle check and the hand-over: pi holds ours as a follow-up.
	g.ctx.idle = false;
	await g.drain(g.now + 1_000);
	assert.equal(g.sent.length, 1, "not handed over twice while pi has it");
	assert.equal(g.pending(), true, "on its way: a settle now would not judge");
	// The person's turn settles with ours still queued in pi (it settles before the follow-up starts).
	assert.deepEqual(await g.settled(g.now + 1_500), { pending: true, continued: false }, "a settle while it is on its way judges nothing");
	assert.equal(g.evaluations(), 1, "and charges nothing");
	// pi runs the follow-up after the person's turn: the user message lands, then the turn settles.
	g.entries.push({ type: "message", message: { role: "user", content: text } });
	g.ctx.idle = true;
	await g.settled(g.now + 2_000);
	assert.equal(g.evaluations(), 2, "the continuation's own turn is judged, once");
	assert.equal(g.state().iterations, 2);
	assert.equal(g.sent.length, 2, "and the next continuation is handed over");
	assert.equal(g.sent.filter((t) => t === text).length, 1, "the first landed once");
	assert.deepEqual(g.store.list("s").map((r) => r.payload?.text), [g.sent[1]], "the first is gone, the second waits for pi to write it");
});

test("Esc pauses the goal and its queued continuation is dropped", async () => {
	const g = goalSession();
	await g.settled(g.now);
	assert.equal(g.sent.length, 1);
	const row = g.store.list("s")[0];
	assert.equal(row.source, "goal");
	// Esc during the turn pi started for the continuation, or during the person's own: the goal pauses at `agent_end` (abortedTurn), pi drops what it queued.
	g.pause(g.now + 1_000);
	assert.equal(g.state().status, "paused");
	assert.equal(g.state().iterations, 1);
	g.executor.agentStarted(g.now);
	g.executor.agentEnded(g.now + 1_000, true);
	await g.settled(g.now + 1_000);
	assert.equal(g.evaluations(), 1, "a paused goal is not judged");
	assert.deepEqual(g.store.list("s"), [], "the continuation of a paused goal is stale and dropped");
	assert.equal(g.sent.length, 1, "never offered again");
	assert.equal(g.state().iterations, 1, "what it cost stays spent; /goal resume judges the next turn afresh");
});
