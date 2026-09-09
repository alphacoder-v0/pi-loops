import { test } from "node:test";
import assert from "node:assert/strict";
import { GOAL_ENTRY, MAX_CONTINUATIONS, applyDecision, continuationPrompt, evaluatorPrompt, goalActive, goalLine, latestGoal, newGoal, parseDecision, pauseFor, transcriptFromMessages } from "../src/goal.ts";

test("the evaluator's decision drives the turn, with pie's budget and pause-on-failure", () => {
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

test("parseDecision accepts pie's shapes and refuses everything else", () => {
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

test("the evaluator prompt carries pie's contract, the condition and the transcript", () => {
	const p = evaluatorPrompt("ship it", "user: hello");
	assert.match(p, /cannot call tools/);
	assert.match(p, /"ok": true/);
	assert.match(p, /insufficient evidence in transcript/);
	assert.match(p, /Goal condition:\nship it/);
	assert.match(p, /Conversation transcript:\nuser: hello/);
	assert.match(continuationPrompt("c", "r"), /Goal condition:\nc/);
	assert.match(goalLine(newGoal("x")), /pursuing \(0\/8 continuations\)/);
});
