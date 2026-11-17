import { test } from "node:test";
import assert from "node:assert/strict";
import { markDetails, markFor, markOn, withMark } from "../src/mark.ts";

const mark = markFor({ lane: "s1", id: "r1", created_at: "2026-01-01T00:00:00.000Z" });
const AT = "2026-01-01T00:00:00.000Z";

test("markFor returns the row lane, id and the stamp it was queued at", () => {
	assert.deepEqual(mark, { lane: "s1", id: "r1", at: AT });
});

test("withMark keeps every property and does not change its argument", () => {
	const message = { role: "user", content: "hello", custom: { value: 1 } };
	const before = structuredClone(message);
	const marked = withMark(message, mark);
	assert.deepEqual(marked, { ...message, piLoopsRow: { lane: "s1", id: "r1", at: AT } });
	assert.deepEqual(message, before);
	assert.notEqual(marked, message);
});

test("markDetails places the two mark fields in custom message details", () => {
	assert.deepEqual(markDetails(mark), { piLoopsRow: { lane: "s1", id: "r1", at: AT } });
});

test("markOn reads a marked user message", () => {
	assert.deepEqual(markOn({ type: "message", message: { role: "user", piLoopsRow: { lane: "s1", id: "r1", at: AT } } }), { lane: "s1", id: "r1", at: AT });
});

test("markOn reads a marked custom message", () => {
	assert.deepEqual(markOn({ type: "custom_message", details: { piLoopsRow: { lane: "s1", id: "r1", at: AT } } }), { lane: "s1", id: "r1", at: AT });
});

test("markOn returns undefined for entries without a valid mark", () => {
	for (const entry of [
		{ type: "other", message: { role: "user", piLoopsRow: { lane: "s1", id: "r1", at: AT } } },
		{ type: "message", message: { role: "assistant", piLoopsRow: { lane: "s1", id: "r1", at: AT } } },
		{ type: "message", message: { role: "toolResult", piLoopsRow: { lane: "s1", id: "r1", at: AT } } },
		{ type: "message", message: { piLoopsRow: { lane: "s1", id: "r1", at: AT } } },
		{ type: "custom_message", details: { piLoopsRow: { lane: "s1" } } },
		{ type: "custom_message", piLoopsRow: { lane: "s1", id: "r1", at: AT } },
		{ type: "message", message: { role: "user" } },
		{ type: "message", message: { role: "user", piLoopsRow: null } },
		{ type: "message", message: { role: "user", piLoopsRow: "mark" } },
		{ type: "message", message: { role: "user", piLoopsRow: 3 } },
		{ type: "message", message: { role: "user", piLoopsRow: [] } },
		{ type: "message", message: { role: "user", piLoopsRow: { lane: 3, id: "r1" } } },
		{ type: "message", message: { role: "user", piLoopsRow: { lane: "s1", id: "r1" } } },
		{ type: "custom_message", details: { piLoopsRow: { lane: "s1", id: "r1", at: 5 } } },
		{ type: "message", message: { role: "user", piLoopsRow: { lane: "s1", id: null } } },
		null,
		"entry",
		4,
		[],
	]) assert.equal(markOn(entry), undefined, JSON.stringify(entry));
});

test("markOn drops fields beyond lane, id and at", () => {
	assert.deepEqual(markOn({ type: "custom_message", details: { piLoopsRow: { lane: "s1", id: "r1", at: AT, extra: true } } }), { lane: "s1", id: "r1", at: AT });
});

test("markOn reads the mark added by withMark", () => {
	assert.deepEqual(markOn({ type: "message", message: withMark({ role: "user", content: "hello" }, mark) }), { lane: "s1", id: "r1", at: AT });
});

test("a marked entry keeps its mark through JSON persistence", () => {
	const entry = { type: "message", message: withMark({ role: "user", content: "hello" }, mark) };
	assert.deepEqual(markOn(JSON.parse(JSON.stringify(entry))), { lane: "s1", id: "r1", at: AT });
});

test("an aborted message's mark proves only the row it was sent for, not a row of the same id queued later (#262); an answered one proves both", async () => {
	const { landed, proofOf } = await import("../src/engine.ts");
	const first = { v: 3, id: "r1", lane: "s1", kind: "input", source: "cron:job", mode: "unattended", wake: "turn", payload: { text: "[Trigger r1] go", cwd: "" }, created_at: "2026-11-17T09:00:00.000+08:00", created_by: { instance: "i", pid: 1 }, attempts: 0 } as never;
	const later = { ...(first as object), created_at: "2026-11-17T09:05:00.000+08:00" } as never;
	const entry = (aborted: boolean) => ({ type: "message", message: withMark({ role: "user", content: "[Trigger r1] go" }, markFor(first), aborted) });
	const aborted = proofOf("s1" as never, () => [entry(true)], () => []);
	assert.equal(landed(first, aborted), true, "an aborted message proves its own row, which is not offered again");
	assert.equal(landed(later, aborted), false, "and not a row of the same id queued later, which runs");
	const answered = proofOf("s1" as never, () => [entry(false)], () => []);
	assert.equal(landed(first, answered), true);
	assert.equal(landed(later, answered), true, "an answered message proves the same slot queued again, which is not written twice");
});

test("markOn keeps aborted only when it is true", () => {
	assert.deepEqual(markOn({ type: "message", message: withMark({ role: "user" }, mark, true) }), { lane: "s1", id: "r1", at: AT, aborted: true });
	assert.deepEqual(markOn({ type: "custom_message", details: { piLoopsRow: { lane: "s1", id: "r1", at: AT, aborted: "yes" } } }), { lane: "s1", id: "r1", at: AT });
});
