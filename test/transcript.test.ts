import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { composeLoopPrompt } from "../src/protocol.ts";
import { summarizeSessionFile } from "../src/transcript.ts";

test("summarizeSessionFile renders user/tool/result/assistant lines and skips junk", () => {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-tr-")), "s.jsonl");
	const lines = [
		JSON.stringify({ type: "session", id: "x" }),
		JSON.stringify({ type: "message", id: "a", message: { role: "user", content: "intro\n[loop-state]\nold\n[/loop-state]\n\ncheck issues with sk-abcdefghij1234567890abcd\n\nOutput protocol (mandatory):\n- tags" } }),
		"{broken",
		JSON.stringify({ type: "message", id: "b", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "grep", arguments: { pattern: "TODO", path: "src" } }] } }),
		JSON.stringify({ type: "message", id: "c", message: { role: "toolResult", toolCallId: "c1", toolName: "grep", isError: true, content: [{ type: "text", text: "no matches\nline2" }] } }),
		JSON.stringify({ type: "message", id: "d", message: { role: "assistant", content: [{ type: "text", text: "done <inbox>x</inbox><loop-state>y</loop-state>" }] } }),
	];
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
	const out = summarizeSessionFile(file);
	assert.deepEqual(out.map((l) => l.kind), ["user", "tool", "result", "assistant"]);
	assert.equal(out[0].text, "› check issues with [REDACTED:openai_anthropic_key]");
	assert.equal(out[1].text, "grep /TODO/ in src");
	assert.equal(out[2].text, "  ✗ no matches  (+1 lines)");
	assert.equal(out[3].text, "done");
	assert.equal(summarizeSessionFile("/nonexistent")[0].kind, "meta");
});

test("the › line is the job text of a prompt protocol.ts composed, not of one written out by hand here", () => {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-tr-")), "s.jsonl");
	const prompt = composeLoopPrompt("check issues", "seen: 1", { name: "issues", runAt: "2026-09-12 09:00 +08:00" });
	fs.writeFileSync(file, `${JSON.stringify({ type: "message", id: "a", message: { role: "user", content: prompt } })}\n`);
	const out = summarizeSessionFile(file);
	assert.equal(out[0].text, "› check issues", "the state block and the protocol block are both trimmed away");
});
