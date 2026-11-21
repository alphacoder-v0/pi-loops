import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { Inbox } from "../src/inbox.ts";
import { TriggerStore } from "../src/triggers.ts";
import { RequestStore } from "../src/requests.ts";
import { type EngineSinks, drain, enqueue, goalRow } from "../src/engine.ts";
import { WindowExecutor } from "../src/window-executor.ts";
import { GOAL_ENTRY, MAX_CONTINUATIONS, abortedTurn, answeredGoal, applyDecision, branchMovedSince, clearGoal, continuationPending, continuationPrompt, evaluationApplies, evaluatorPrompt, goalActive, goalPursued, heldOutcome, judgeCaughtUp, settledTurn, latestGoal, newGoal, parseDecision, pauseFor, pauseGoal, resumeGoal, transcriptFromMessages, goalWaitingLine } from "../src/goal.ts";
import { personRow, plainJobRow } from "../src/engine.ts";
import type { Row } from "../src/requests.ts";

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

test("a goal waiting on a person waits for them instead of sending the agent back, and is charged nothing", () => {
	const decision = parseDecision('{"ok": false, "needs_person": true, "reason": "the agent asked which branch to deploy"}');
	assert.deepEqual(decision, { ok: false, needsPerson: true, reason: "the agent asked which branch to deploy" });
	const before = { ...newGoal("the app is deployed"), iterations: 3 };
	const next = applyDecision(before, decision);
	assert.equal(next.state.status, "waiting");
	assert.equal(next.state.iterations, 3, "a wait sends nobody back to work, so it costs no continuation");
	assert.equal(next.state.lastReason, "the agent asked which branch to deploy");
	assert.deepEqual(next.action, { kind: "wait", reason: "waiting on you: the agent asked which branch to deploy" });
	assert.equal(goalActive(next.state), true, "a waiting goal is still the session's goal");
	assert.equal(goalPursued(next.state), false, "and no continuation runs for it");
	// The evaluator is told the shape, and the agent is told it may stop and ask.
	assert.match(evaluatorPrompt("c", "t"), /"needs_person": true/);
	assert.match(continuationPrompt("c", "r"), /only a person can unblock/);
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
	assert.equal(branchMovedSince(branch({ id: "e4", type: "custom_message", customType: "pi-loops:turn" }), "e3"), true, "a pi-loops turn also moves the branch");
	assert.equal(branchMovedSince(branch({ id: "e4", type: "custom_message", customType: "other" }), "e3"), false);
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
	// A continuation goes to pi as a custom message that names its row: `sent` is the words, `turns` the messages.
	const turns: Array<{ customType: string; content: string; details: unknown }> = [];
	const executor = new WindowExecutor({ sendMessage: (m: any) => void (turns.push(m), sent.push(m.content)), sendUserMessage: () => assert.fail("a continuation is not a user message") }, { here: () => ({ sessionId: "s", holds: true }), hold: () => true, letGo: () => undefined }, () => ctx, { pid: 1 }, () => true, () => store.list("s"));
	const now = Date.parse("2026-06-01T12:00:00Z");
	const address = { sessionId: "s", cwd: "/p", createdBy: { pid: 1, instance: "w", version: "0" } };
	let state = newGoal("tests pass", new Date(now));
	let evaluations = 0;
	const delivered = (id: string) => executor.delivered(id);
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
	/** The handler at `agent_settled`, with whether the run was aborted (Esc): what pi dropped is forgotten, then the settle decision (src/goal.ts). */
	const settled = async (at: number, aborted = false) => {
		executor.settled(aborted);
		return settledTurn(store.list("s"), executor.handedOver, delivered, evaluate(at), () => drain("s", store, executor, at, sinks));
	};
	/** Pi starts, ends and persists the continuation the window sent with `text`. */
	const writes = (text: string, at: number): void => {
		const message = { role: "custom", ...turns.find((turn) => turn.content === text)! };
		executor.messageStarted(message, at);
		executor.messageEnded(message, at);
		entries.push({ type: "custom_message", timestamp: new Date(at).toISOString(), ...message });
	};
	return { store, sent, entries, ctx, executor, now, settled, pending, writes, drain: (at: number) => drain("s", store, executor, at, sinks), state: () => state, evaluations: () => evaluations, pause: (at: number) => void (state = abortedTurn(state, new Date(at))?.state ?? state) };
}

test("in the idle-check race, a continuation queued behind the person's turn lands once and is charged once", async () => {
	const g = goalSession();
	assert.deepEqual(await g.settled(g.now), { pending: false, continued: true });
	assert.equal(g.evaluations(), 1);
	assert.equal(g.state().iterations, 1, "the evaluator charged one continuation");
	assert.equal(g.sent.length, 1, "and the row was handed to pi while idle");
	const text = g.sent[0];
	const firstId = g.store.list("s")[0].id;
	// pi is busy between the idle check and the hand-over, and holds ours unstarted: no run has taken it up.
	g.ctx.idle = false;
	await g.drain(g.now + 1_000);
	assert.equal(g.sent.length, 1, "not handed over twice while pi has it");
	assert.equal(g.pending(), true, "on its way: a settle now would not judge");
	// The person's turn settles while ours is still unstarted (pi defers a prompt sent while it emits agent_settled).
	assert.deepEqual(await g.settled(g.now + 1_500), { pending: true, continued: false }, "a settle while it is on its way judges nothing");
	assert.equal(g.evaluations(), 1, "and charges nothing");
	// pi runs it: the custom message lands, the row's mark in its details, which is the proof. Then the turn settles.
	g.executor.agentStarted(g.now + 1_800);
	g.writes(text, g.now + 1_900);
	g.executor.agentEnded();
	g.ctx.idle = true;
	await g.settled(g.now + 2_000);
	assert.equal(g.evaluations(), 2, "the continuation's own turn is judged, once");
	assert.equal(g.state().iterations, 2);
	assert.equal(g.sent.length, 2, "and the next continuation is handed over");
	// Two continuations can read the same, so the marks say which landed:
	// the first is gone, the second waits for pi to write it, and its proof is the mark on its own message.
	const [second] = g.store.list("s");
	assert.deepEqual(g.store.list("s").map((r) => r.payload?.text), [g.sent[1]], "the first is gone, the second waits for pi to write it");
	assert.notEqual(second.id, firstId, "the second is its own row, not the first offered again");
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
	g.executor.agentEnded();
	await g.settled(g.now + 1_000, true);
	assert.equal(g.evaluations(), 1, "a paused goal is not judged");
	assert.deepEqual(g.store.list("s"), [], "the continuation of a paused goal is stale and dropped");
	assert.equal(g.sent.length, 1, "never offered again");
	assert.equal(g.state().iterations, 1, "what it cost stays spent; /goal resume judges the next turn afresh");
});

test("/goal resume starts the allowance again whenever it is spent, even after a pause in between (#54)", () => {
	const now = new Date("2026-06-01T12:00:00Z");
	let g = newGoal("tests pass", now);
	for (let i = 0; i < MAX_CONTINUATIONS; i++) g = applyDecision(g, { ok: false, reason: "not yet" }, now).state;
	assert.equal(g.status, "budget_limited");
	assert.equal(resumeGoal(g, now).iterations, 0, "resumed straight from the limit");

	const paused = { ...g, status: "paused" as const };
	const resumed = resumeGoal(paused, now);
	assert.deepEqual([resumed.status, resumed.iterations], ["pursuing", 0], "paused in between: still spent, still started again");
	const next = applyDecision(resumed, { ok: false, reason: "not yet" }, now);
	assert.equal(next.action.kind, "continue", "so the next 'not satisfied' is a continuation, not the limit again");

	const midway = { ...newGoal("tests pass", now), status: "paused" as const, iterations: 3 };
	assert.equal(resumeGoal(midway, now).iterations, 3, "an allowance that is not spent is kept");
});

test("an aborted evaluation never writes over the goal the person just set (#53)", () => {
	const now = new Date("2026-06-01T12:00:00Z");
	const pursued = { ...newGoal("c1", now), iterations: 2 };
	// /goal resume, or /goal c1 typed again, aborts the evaluation and writes a pursuing goal with the
	// same text: the old guard let the aborted evaluation pause it as "goal evaluator cancelled".
	assert.equal(evaluationApplies(resumeGoal({ ...pursued, status: "paused" }, now), pursued, true), false);
	assert.equal(evaluationApplies(newGoal("c1", now), pursued, true), false);
	// Not aborted: it applies to the goal it judged, and not to one paused, cleared or replaced meanwhile.
	assert.equal(evaluationApplies(pursued, pursued, false), true);
	assert.equal(evaluationApplies({ ...pursued, status: "paused" }, pursued, false), false);
	assert.equal(evaluationApplies(undefined, pursued, false), false);
	assert.equal(evaluationApplies(newGoal("c2", now), pursued, false), false);
});

test("a turn that settled while the evaluator ran is judged when it returns, and only then (#50)", async () => {
	// The person asked something while the evaluator read; that turn settled, found the evaluator
	// busy and was skipped. The evaluation came back "held". Nothing judged the goal again until
	// the person typed: now the settle that ran the evaluation judges once more.
	let calls = 0;
	let skipped = false;
	const take = () => {
		const was = skipped;
		skipped = false;
		return was;
	};
	const held = async () => {
		calls++;
		if (calls === 1) skipped = true; // a turn settled during the first evaluation
		return false;
	};
	assert.equal(await judgeCaughtUp(held, take, () => true), false);
	assert.equal(calls, 2, "judged again for the turn it skipped, then stops");

	calls = 0;
	assert.equal(await judgeCaughtUp(async () => (calls++, false), () => false, () => true), false);
	assert.equal(calls, 1, "nothing skipped: judged once");

	calls = 0;
	skipped = false;
	const continued = async () => {
		calls++;
		skipped = true;
		return true;
	};
	assert.equal(await judgeCaughtUp(continued, take, () => true), true);
	assert.equal(calls, 1, "a continuation went out: its own settle judges next");

	calls = 0;
	assert.equal(await judgeCaughtUp(held, take, () => false), false);
	assert.equal(calls, 1, "pi is busy: that turn settles and is judged by itself");
});

test("the extension wires the goal decisions in: the settle judges skipped turns, and every abort forgets them", () => {
	// src/pi-loops.ts has no harness (it is the default export); its source is the thing pinned.
	const source = fs.readFileSync(path.join(process.cwd(), "src", "pi-loops.ts"), "utf8");
	assert.match(source, /judgeCaughtUp\(\(\) => evaluateGoal\(ctx\), skipped, \(\) => ctx\.isIdle\(\)\)/, "agent_settled judges through judgeCaughtUp");
	assert.match(source, /if \(goalEvaluating\) \{\s*goalSkippedTurn = true;/, "a settle that finds the evaluator busy is remembered");
	assert.equal(source.match(/goalAbort\?\.abort\(\);[^\n]*\n\s*goalSkippedTurn = false;/g)?.length, 3, "/goal pause|resume|clear, /goal <condition> and Esc each forget a skipped turn");
	assert.match(source, /if \(!evaluationApplies\(goal, pursued, ctrl\.signal\.aborted\)\) return false;/, "an aborted evaluation is discarded");
	assert.match(source, /: resumeGoal\(goal\);/, "/goal resume goes through resumeGoal");
});

test("a waiting goal: a person's input resumes it, /goal pause and /goal clear end it, and input leaves a paused or budget-limited goal alone", () => {
	const now = new Date("2026-06-01T12:00:00Z");
	const waiting = applyDecision({ ...newGoal("the app is deployed", now), iterations: 2 }, { ok: false, needsPerson: true, reason: "which branch?" }, now).state;
	assert.equal(waiting.status, "waiting");

	const resumed = answeredGoal(waiting, now);
	assert.deepEqual([resumed?.status, resumed?.iterations], ["pursuing", 2], "the answer resumes it, with the allowance it had");
	assert.equal(evaluationApplies(resumed, resumed!, false), true, "and the turn the answer starts is judged when it settles");

	assert.equal(pauseGoal(waiting, now).status, "paused", "/goal pause from waiting");
	assert.equal(clearGoal(waiting, now).status, "cleared", "/goal clear from waiting");
	assert.equal(latestGoal([{ customType: GOAL_ENTRY, data: waiting }])?.status, "waiting", "a waiting goal is one session entry, and --resume finds it waiting");
	assert.equal(latestGoal([{ customType: GOAL_ENTRY, data: waiting }, { customType: GOAL_ENTRY, data: clearGoal(waiting, now) }]), undefined);

	const paused = pauseGoal(waiting, now);
	assert.equal(answeredGoal(paused, now), undefined, "a paused goal still needs /goal resume");
	assert.equal(answeredGoal(abortedTurn(newGoal("x", now), now)!.state, now), undefined, "Esc's pause too");
	let limited = newGoal("never", now);
	for (let i = 0; i < MAX_CONTINUATIONS; i++) limited = applyDecision(limited, { ok: false, reason: "no" }, now).state;
	assert.equal(limited.status, "budget_limited");
	assert.equal(answeredGoal(limited, now), undefined, "the continuation limit still needs /goal resume");
	assert.equal(answeredGoal(newGoal("x", now), now), undefined, "a pursued goal has nothing to resume");
	assert.equal(answeredGoal(applyDecision(newGoal("x", now), { ok: true, reason: "done" }, now).state, now), undefined, "an achieved goal stays achieved");
});

test("eight needs_person decisions in a row never reach the continuation limit", () => {
	const now = new Date("2026-06-01T12:00:00Z");
	let state = newGoal("the app is deployed", now);
	for (let i = 0; i < MAX_CONTINUATIONS; i++) {
		const judged = applyDecision(state, { ok: false, needsPerson: true, reason: `question ${i}` }, now);
		assert.equal(judged.state.status, "waiting", `decision ${i + 1} waits`);
		assert.equal(judged.action.kind, "wait");
		state = answeredGoal(judged.state, now)!;
	}
	assert.deepEqual([state.status, state.iterations], ["pursuing", 0], "no wait was charged");
	assert.equal(applyDecision(state, { ok: false, reason: "not yet" }, now).action.kind, "continue", "the next 'not satisfied' is a continuation, not the limit");
});

test("a wait the session moved on from while the evaluator ran is held, as a continuation is", () => {
	const now = new Date("2026-06-01T12:00:00Z");
	const pursued = { ...newGoal("the app is deployed", now), iterations: 2 };
	const wait = applyDecision(pursued, { ok: false, needsPerson: true, reason: "which branch?" }, now);
	assert.deepEqual(heldOutcome(pursued, wait, false), { state: wait.state, held: false }, "nothing moved: the goal waits");
	const held = heldOutcome(pursued, wait, true);
	assert.equal(held.held, true);
	assert.deepEqual([held.state.status, held.state.iterations], ["pursuing", 2], "the person may have answered meanwhile: their turn is judged when it settles");
	const go = applyDecision(pursued, { ok: false, reason: "3 fail" }, now);
	assert.deepEqual([heldOutcome(pursued, go, true).state.iterations, heldOutcome(pursued, go, true).held], [2, true], "a held continuation costs nothing, as before");
	const done = applyDecision(pursued, { ok: true, reason: "deployed" }, now);
	assert.deepEqual(heldOutcome(pursued, done, true), { state: done.state, held: false }, "a verdict is not held");
});

test("the input decision: a person's input resumes a waiting goal, and the extension's own input does not, except a person row the window handed", () => {
	const T0 = Date.parse("2026-06-01T12:00:00Z");
	const by = { pid: 1, instance: "w", version: "0" };
	/** A window over a fake pi in `mode`; pi emits `input` inside a user message's send, with the source `extension`. */
	const win = (mode: "rpc" | "tui") => {
		const queued = new Map<string, Row>();
		const custom: Array<{ customType: string; content: string; details: unknown }> = [];
		const echoes: boolean[] = [];
		let ex!: WindowExecutor;
		const pi = {
			sendMessage: (m: any) => void custom.push(m),
			sendUserMessage: (content: unknown) => void echoes.push(ex.inputSeen({ source: "extension", text: content as string }, T0)),
		};
		ex = new WindowExecutor(pi as any, { here: () => ({ sessionId: "s", holds: true }), hold: () => ({}) as any, letGo: () => undefined } as any, () => ({ hasUI: false, mode, isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getEntries: () => [] }, abort: () => undefined }) as any, { pid: 1 }, () => true, () => [...queued.values()], () => [], () => []);
		const hand = (row: Row) => {
			queued.set(row.id, row);
			ex.produced(row);
			assert.equal(ex.turn(row as any, T0), "sent");
		};
		/** pi starts the turn message the window sent last: whether the window took it for a person's input. */
		const starts = () => ex.messageStarted({ role: "custom", ...custom.at(-1)! }, T0);
		return { ex, custom, echoes, hand, starts };
	};
	const waiting = applyDecision(newGoal("deployed"), { ok: false, needsPerson: true, reason: "which branch?" }).state;
	const answer = (person: boolean) => (person ? answeredGoal(waiting)?.status : undefined) ?? waiting.status;
	const page = personRow("req-1", "deploy main", undefined, { sessionId: "s", cwd: "/p", createdBy: by }, T0);

	const rpc = win("rpc");
	assert.equal(answer(rpc.ex.inputSeen({ source: "interactive", text: "main" }, T0)), "pursuing", "typed in a terminal");
	assert.equal(answer(rpc.ex.inputSeen({ source: "rpc", text: "main" }, T0)), "pursuing", "sent over rpc");
	assert.equal(answer(rpc.ex.inputSeen({ source: "extension", text: "another extension speaks" }, T0)), "waiting", "another extension's input");
	// The page's message in the page's pi: a person row the window handed through sendUserMessage.
	rpc.hand(page);
	assert.equal(rpc.custom.length, 0, "it went as the person's own words");
	assert.deepEqual(rpc.echoes, [true], "the echo of a person row's send is a person's input");
	assert.equal(answer(rpc.echoes[0]), "pursuing");

	// The page's message for a conversation a terminal holds: a turn message, which makes no input.
	const tui = win("tui");
	tui.hand(page);
	assert.deepEqual(tui.echoes, [], "no user message, no input");
	assert.equal(answer(tui.starts()), "pursuing", "its turn message is a person's input");
	// A scheduled turn, a goal's continuation and an answer's turn are not.
	tui.hand(plainJobRow({ id: "job-1", sessionId: "s", prompt: "tidy the cache", cwd: "/p" } as any, "cron-1", "cron:job-1", "", by, T0));
	assert.equal(answer(tui.starts()), "waiting", "a scheduled turn");
	tui.hand(goalRow("continue", newGoal("deployed"), { sessionId: "s", cwd: "/p", createdBy: by }, T0));
	assert.equal(answer(tui.starts()), "waiting", "a goal's continuation");
	assert.equal(tui.ex.answerTurn({ ...page, id: "ans-1", source: "answer", run: { id: "r", pid: 1, started_at: "" } } as any, "the answer", { kind: "row", id: "ans-1", mode: "unattended", tools: [] }, T0), "sent");
	assert.equal(tui.custom.length, 4, "each went as a turn message");
	assert.equal(answer(tui.starts()), "waiting", "an answer's turn");
});

test("the extension wires the waiting goal in: a person's input resumes it, the commands end it, and the words are design 6.5's", () => {
	// src/pi-loops.ts has no harness (it is the default export); its source is the thing pinned.
	const source = fs.readFileSync(path.join(process.cwd(), "src", "pi-loops.ts"), "utf8");
	assert.match(source, /if \(executor\.inputSeen\([^\n]*\)\) answerGoal\(ctx\);/, "a person's input, as the window decides it, answers the goal");
	assert.match(source, /if \(executor\.messageStarted\(e\.message, Date\.now\(\)\)\) answerGoal\(ctx\);/, "so does a person row's turn message in a terminal, which makes no input");
	assert.match(source, /const resumed = goal && answeredGoal\(goal\);\s*if \(!resumed\) return;\s*persistGoal\(ctx, resumed\);\s*notifyOrLog\(ctx, "\[goal\] your answer resumed the goal", "info"\);/);
	assert.match(source, /notifyOrLog\(ctx, goalWaitingLine\(outcome\.action\.reason\), "warning"\);/, "entering waiting: a warning, so it stays after a redraw");
	assert.equal(goalWaitingLine("waiting on you: which branch should I push to?"), "[goal] waiting on you: which branch should I push to? Answer here and the goal goes on.", "a question keeps its own mark");
	assert.equal(goalWaitingLine("waiting on you: the deploy key"), "[goal] waiting on you: the deploy key. Answer here and the goal goes on.");
	assert.match(source, /`goal: \$\{next\.status\}`/, "the status line reads goal: waiting");
	assert.match(source, /heldOutcome\(pursued, outcome, branchMovedSince\(/, "a wait the session moved on from is held");
	assert.match(source, /persistGoal\(ctx, clearGoal\(goal\)\);/, "/goal clear");
	assert.match(source, /sub === "pause" \? pauseGoal\(goal\) : resumeGoal\(goal\);/, "/goal pause");
});
