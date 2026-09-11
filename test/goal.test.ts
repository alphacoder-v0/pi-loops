import { test } from "node:test";
import assert from "node:assert/strict";
import { GOAL_ENTRY, MAX_CONTINUATIONS, applyDecision, branchMovedSince, continuationPrompt, evaluatorPrompt, goalActive, goalLine, latestGoal, newGoal, parseDecision, pauseFor, transcriptFromMessages } from "../src/goal.ts";

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
