import { test } from "node:test";
import assert from "node:assert/strict";
import { renderShare, shareSummary } from "../src/share.ts";

const messages = [
	{ role: "user", content: "deploy with sk-abcdefghijklmnopqrstuvwxyz012345 please" },
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "the key is in the prompt" },
			{ type: "text", text: "Running it." },
			{ type: "toolCall", name: "bash", arguments: { command: "curl -H 'Authorization: Bearer abcdefghijklmnop1234' https://api.example.com" } },
		],
	},
	{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "AWS_SECRET=hunter2hunter2 ok" }] },
	{ role: "assistant", content: [{ type: "text", text: "Done." }] },
];

test("a shared transcript is redacted, and says how much it masked", () => {
	const r = renderShare(messages as any, { model: "openai-codex/gpt-5.5", sessionId: "01a0", when: new Date("2026-09-09T12:00:00Z") });
	// The three secrets in the fixture — prompt, tool call, tool output — must not survive.
	assert.equal(r.markdown.includes("sk-abcdefghijklmnopqrstuvwxyz012345"), false, "api key");
	assert.equal(r.markdown.includes("Bearer abcdefghijklmnop1234"), false, "bearer token");
	assert.equal(r.markdown.includes("hunter2hunter2"), false, "env assignment");
	assert.ok(r.redactions >= 3, `counted ${r.redactions}`);
	// What survives is the part a reader needs.
	assert.match(r.markdown, /# Session transcript/);
	assert.match(r.markdown, /- Model: `openai-codex\/gpt-5\.5`/);
	assert.match(r.markdown, /## 1\. Assistant/);
	assert.match(r.markdown, /<details><summary>thinking<\/summary>/);
	assert.match(r.markdown, /\*\*tool call\*\* `bash`/);
	assert.match(r.markdown, /## 2\. Tool result `bash`/);
	assert.equal(r.messages, 4);
	assert.equal(r.toolResults, 1);
	assert.equal(r.bytes, Buffer.byteLength(r.markdown, "utf8"));
});

test("the confirmation states the visibility and what a transcript contains", () => {
	const r = renderShare(messages as any);
	const secret = shareSummary(r, { public: false }).join("\n");
	assert.match(secret, /unlisted, but anyone with the link/);
	assert.match(secret, /every file the agent read/);
	// A count on its own reads as "nothing sensitive in here"; it never appears without the caveat.
	assert.match(secret, /masked — the redactor knows common shapes, not every shape/);
	assert.match(secret, /1 tool result/);
	assert.match(shareSummary(r, { public: true }).join("\n"), /PUBLIC/);
});

test("an empty or unrecognisable session renders without throwing", () => {
	assert.equal(renderShare([]).messages, 0);
	// Shapes it does not know about are skipped rather than printed as JSON noise.
	const odd = renderShare([{ role: "bashExecution", content: "ls" }, { role: "user", content: "hi" }] as any);
	assert.equal(odd.messages, 1);
	assert.equal(odd.markdown.includes("bashExecution"), false);
});

test("the header says the same number of messages as the confirmation the user approves", () => {
	const odd = renderShare([{ role: "bashExecution", content: "ls" }, { role: "user", content: "hi" }] as any);
	assert.match(odd.markdown, /- Messages: 1$/m, "the header counts what was rendered, not what was handed in");
	assert.match(shareSummary(odd, { public: false }).join("\n"), /1 message\(s\)/);
});
