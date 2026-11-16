import { test } from "node:test";
import assert from "node:assert/strict";
import { markDetails, markFor, markOn, withMark } from "../src/mark.ts";

const mark = markFor({ lane: "s1", id: "r1" });

test("markFor returns the row lane and id", () => {
	assert.deepEqual(mark, { lane: "s1", id: "r1" });
});

test("withMark keeps every property and does not change its argument", () => {
	const message = { role: "user", content: "hello", custom: { value: 1 } };
	const before = structuredClone(message);
	const marked = withMark(message, mark);
	assert.deepEqual(marked, { ...message, piLoopsRow: { lane: "s1", id: "r1" } });
	assert.deepEqual(message, before);
	assert.notEqual(marked, message);
});

test("markDetails places the two mark fields in custom message details", () => {
	assert.deepEqual(markDetails(mark), { piLoopsRow: { lane: "s1", id: "r1" } });
});

test("markOn reads a marked user message", () => {
	assert.deepEqual(markOn({ type: "message", message: { role: "user", piLoopsRow: { lane: "s1", id: "r1" } } }), { lane: "s1", id: "r1" });
});

test("markOn reads a marked custom message", () => {
	assert.deepEqual(markOn({ type: "custom_message", details: { piLoopsRow: { lane: "s1", id: "r1" } } }), { lane: "s1", id: "r1" });
});

test("markOn returns undefined for entries without a valid mark", () => {
	for (const entry of [
		{ type: "other", message: { role: "user", piLoopsRow: { lane: "s1", id: "r1" } } },
		{ type: "message", message: { role: "assistant", piLoopsRow: { lane: "s1", id: "r1" } } },
		{ type: "message", message: { role: "toolResult", piLoopsRow: { lane: "s1", id: "r1" } } },
		{ type: "message", message: { piLoopsRow: { lane: "s1", id: "r1" } } },
		{ type: "custom_message", details: { piLoopsRow: { lane: "s1" } } },
		{ type: "custom_message", piLoopsRow: { lane: "s1", id: "r1" } },
		{ type: "message", message: { role: "user" } },
		{ type: "message", message: { role: "user", piLoopsRow: null } },
		{ type: "message", message: { role: "user", piLoopsRow: "mark" } },
		{ type: "message", message: { role: "user", piLoopsRow: 3 } },
		{ type: "message", message: { role: "user", piLoopsRow: [] } },
		{ type: "message", message: { role: "user", piLoopsRow: { lane: 3, id: "r1" } } },
		{ type: "message", message: { role: "user", piLoopsRow: { lane: "s1", id: null } } },
		null,
		"entry",
		4,
		[],
	]) assert.equal(markOn(entry), undefined, JSON.stringify(entry));
});

test("markOn drops fields beyond lane and id", () => {
	assert.deepEqual(markOn({ type: "custom_message", details: { piLoopsRow: { lane: "s1", id: "r1", extra: true } } }), { lane: "s1", id: "r1" });
});

test("markOn reads the mark added by withMark", () => {
	assert.deepEqual(markOn({ type: "message", message: withMark({ role: "user", content: "hello" }, mark) }), { lane: "s1", id: "r1" });
});

test("a marked entry keeps its mark through JSON persistence", () => {
	const entry = { type: "message", message: withMark({ role: "user", content: "hello" }, mark) };
	assert.deepEqual(markOn(JSON.parse(JSON.stringify(entry))), { lane: "s1", id: "r1" });
});
