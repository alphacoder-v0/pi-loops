import { test } from "node:test";
import assert from "node:assert/strict";
import { promotionBody } from "../src/trigger-runtime.ts";
import { capRedacted, previewRedacted } from "../src/redact.ts";
import { buildPeriodicCheckTrigger } from "../src/triggers.ts";

test("a promoted result keeps its line structure; only the one-line previews collapse it", () => {
	const result = "diff --git a/x b/x\n@@ -1,2 +1,2 @@\n-  old line\n+  new line";
	const body = promotionBody(buildPeriodicCheckTrigger("/p", 1), result);
	assert.ok(body.includes("\n-  old line\n"), "newlines and indentation survive into the chat");
	assert.equal(body.split("\n").length, 4);
	assert.match(body, /^\[Trigger [0-9a-f-]+\] diff --git/);
	assert.equal(previewRedacted(result, 4096).includes("\n"), false, "the TUI preview still collapses");
});

test("capRedacted still redacts and caps", () => {
	assert.equal(capRedacted("x".repeat(10), 4), "xxxx…");
	assert.ok(!capRedacted("token: sk-abcdefghijklmnopqrstuvwxyz012345", 4096).includes("sk-abcdefghijklmnopqrstuvwxyz012345"));
});
