import { test } from "node:test";
import assert from "node:assert/strict";
import { asleepNote, ownerSession, runsIn } from "../src/job-owner.ts";

test("a loop runs anywhere; a plain job runs only in the session that created it", () => {
	assert.equal(runsIn({ stateful: true }, undefined), true);
	assert.equal(runsIn({ stateful: true, sessionId: "a" }, "b"), true);
	assert.equal(runsIn({ stateful: false, sessionId: "a" }, "a"), true);
	assert.equal(runsIn({ stateful: false, sessionId: "a" }, "b"), false);
	assert.equal(runsIn({ stateful: false, sessionId: "a" }, undefined), false, "no session (the host, --no-session): nowhere for the message to land");
	assert.equal(runsIn({ stateful: false }, "a"), false, "a plain job with no session at all runs nowhere");
});

test("what the lists say about a plain job that is asleep here", () => {
	assert.equal(asleepNote({ stateful: false, sessionId: "01a09f6d-1111" }, "01a09fef-2222"), "session 01a09f6d — resume it to run");
	assert.equal(asleepNote({ stateful: false, sessionId: "01a09f6d-1111" }, "01a09f6d-1111"), undefined);
	assert.equal(asleepNote({ stateful: true }, "x"), undefined, "a loop is never asleep");
	assert.equal(ownerSession({ stateful: true }), undefined);
	assert.equal(ownerSession({ stateful: false, sessionId: "abcdefghij" }), "abcdefgh");
	assert.equal(ownerSession({ stateful: false }), "?");
});
