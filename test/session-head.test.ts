import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { automationBadge, previewText, readSessionHead } from "../src/session-head.ts";

test("the head of a session file: id, when, name, the first thing said, how many messages", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-head-"));
	const file = path.join(dir, "s.jsonl");
	const lines = [
		{ type: "session", version: 3, id: "01a0-abc", timestamp: "2026-09-14T13:48:39.061Z", cwd: "/work/api" },
		{ type: "model_change", id: "x" },
		{ type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "  fix the\nlogin bug  " }] } },
		{ type: "message", id: "m2", message: { role: "assistant", content: "on it" } },
		{ type: "session_info", name: "login" },
		{ type: "message", id: "m3", message: { role: "user", content: "thanks" } },
	];
	fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	const head = readSessionHead(file)!;
	assert.equal(head.id, "01a0-abc");
	assert.equal(head.startedAt, "2026-09-14T13:48:39.061Z");
	assert.equal(head.cwd, "/work/api");
	assert.equal(head.name, "login");
	assert.equal(head.first, "fix the\nlogin bug");
	assert.equal(head.messages, 3);
	assert.equal(head.truncated, false);
	fs.writeFileSync(path.join(dir, "not.jsonl"), "hello\n");
	assert.equal(readSessionHead(path.join(dir, "not.jsonl")), undefined);
	assert.equal(readSessionHead(path.join(dir, "missing.jsonl")), undefined);
	// A window smaller than the file: a floor on the count, and the half line at the end is not parsed.
	const small = readSessionHead(file, 200)!;
	assert.equal(small.truncated, true);
	assert.ok(small.messages <= 3);
});

test("a preview is one line, cut by characters, never inside one", () => {
	assert.equal(previewText("fix the\n  login bug"), "fix the login bug");
	const cjk = "汉".repeat(85);
	const p = previewText(cjk);
	assert.equal([...p].length, 81, "80 characters and an ellipsis, never a byte boundary");
	assert.ok(p.endsWith("…"));
	assert.equal(previewText("short"), "short");
});

test("the automation badge counts what the session has", () => {
	const job = (over: any) => ({ id: "j", schedule: { kind: "every", everyMs: 1 }, stateful: false, prompt: "p", cwd: "/", enabled: true, catchUp: false, createdAt: "t", runCount: 0, skippedOverlap: 0, ...over }) as any;
	const rule = (over: any) => ({ id: "r", condition: "c", action: "a", enabled: true, fireOnce: true, promoteToChat: false, createdAt: "t", cwd: "/", ...over }) as any;
	assert.equal(automationBadge("s1", [], []), undefined, "nothing → no badge");
	assert.equal(automationBadge("s1", [job({ sessionId: "s1" }), job({ sessionId: "s1" }), job({ sessionId: "s2" })], [rule({ createdBy: { sessionId: "s1" } })]), "2 cron, 1 trigger");
	assert.equal(automationBadge("s1", [job({ sessionId: "s1", enabled: false })], []), "automation off");
	assert.equal(automationBadge("s1", [job({ createdBy: { sessionId: "s1" }, stateful: true })], []), "1 cron", "a loop this session created counts too");
});
