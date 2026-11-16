// A row of a version 2 line, queued by 0.24.2, keeps the text proof of that version; a row of this version has its mark only. From the Gates review of PR 261.
import { test } from "node:test";
import assert from "node:assert/strict";
import { landed, plainJobRow, personRow, proofOf } from "../src/engine.ts";
import { stamp } from "../src/schedule.ts";
import { withMark, markFor } from "../src/mark.ts";

const T0 = Date.parse("2026-11-16T00:00:00.000Z");
const page = { pid: 1, instance: "page", version: "x" } as any;
const user = (text: string, at: number) => ({ type: "message", timestamp: new Date(at).toISOString(), message: { role: "user", content: [{ type: "text", text }] } });
const marked = (text: string, at: number, lane: string, id: string) => ({ type: "message", timestamp: new Date(at).toISOString(), message: withMark({ role: "user", content: [{ type: "text", text }] }, markFor({ lane, id } as any)) });

test("a v2 person row is not proved by a message of this version that carries another row's mark", () => {
	const row = { ...personRow("p1", "look", [], { sessionId: "s", cwd: "/p", createdBy: page }, T0), line: 2 as const, handed_at: stamp(T0 + 1000) };
	assert.equal(landed(row, proofOf("s", () => [user("look", T0 + 2000)], () => [])), true, "control: an unmarked message after the stamp proves it");
	assert.equal(landed(row, proofOf("s", () => [marked("look", T0 + 2000, "s", "p2")], () => [])), false, "a marked message proves no older row");
});

test("a v2 prefixed row is proved by an unmarked [Trigger <id>] message, and a v3 one is not", () => {
	const row = plainJobRow({ id: "j", sessionId: "s", prompt: "run j.", cwd: "/p" } as any, "r1", "cron:j", "", page, T0);
	const entries = [user("[Trigger r1] run j.", T0 + 2000)];
	assert.equal(landed({ ...row, line: 2 as const } as any, proofOf("s", () => entries, () => [])), true, "a 0.24.2 delivery of a v2 cron row is its proof");
	assert.equal(landed(row, proofOf("s", () => entries, () => [])), false, "a v3 row is proved by its mark only");
});
