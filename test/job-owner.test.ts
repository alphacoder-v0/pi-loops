import { test } from "node:test";
import assert from "node:assert/strict";
import { asleepNote, ownerSession, runsHere, runsSomewhere, whereRuns } from "../src/job-owner.ts";

const holding = (sessionId: string | undefined, holders: Record<string, number> = {}) => ({ sessionId, holdsOwn: !!sessionId, holderOf: (id: string) => holders[id] });

test("a loop runs on the machine; a plain job runs only in the instance holding its session's lease", () => {
	assert.deepEqual(whereRuns({ stateful: true }, holding(undefined)), { kind: "machine" });
	assert.deepEqual(whereRuns({ stateful: false, sessionId: "a" }, holding("a")), { kind: "here" });
	assert.deepEqual(whereRuns({ stateful: false, sessionId: "a" }, holding("b", { a: 41 })), { kind: "terminal", pid: 41 });
	assert.deepEqual(whereRuns({ stateful: false, sessionId: "a" }, holding("b")), { kind: "asleep" });
	assert.deepEqual(whereRuns({ stateful: false, sessionId: "a" }, holding(undefined)), { kind: "asleep" }, "no session (the host, --no-session): nowhere for the message to land");
	assert.deepEqual(whereRuns({ stateful: false }, holding("a")), { kind: "asleep" }, "a plain job with no session at all runs nowhere");
});

test("a second window on the same conversation is a viewer: the job runs in the holder's pid, not here", () => {
	const viewer = { sessionId: "a", holdsOwn: false, holderOf: (id: string) => (id === "a" ? 41 : undefined) };
	assert.deepEqual(whereRuns({ stateful: false, sessionId: "a" }, viewer), { kind: "terminal", pid: 41 });
	assert.equal(runsHere({ stateful: false, sessionId: "a" }, viewer), false);
	assert.equal(runsHere({ stateful: true }, viewer), true, "a loop is the leader's question, not the lease's");
});

test("what the lists say about a plain job that does not run here", () => {
	assert.equal(asleepNote({ stateful: false, sessionId: "01a09f6d-1111" }, holding("01a09fef-2222")), "session 01a09f6d — resume it to run");
	assert.equal(asleepNote({ stateful: false, sessionId: "01a09f6d-1111" }, holding("01a09fef-2222", { "01a09f6d-1111": 4242 })), "session 01a09f6d — open in pid 4242");
	assert.equal(asleepNote({ stateful: false, sessionId: "01a09f6d-1111" }, holding("01a09f6d-1111")), undefined);
	assert.equal(asleepNote({ stateful: true }, holding("x")), undefined, "a loop is never asleep");
	assert.equal(ownerSession({ stateful: true }), undefined);
	assert.equal(ownerSession({ stateful: false, sessionId: "abcdefghij" }), "abcdefgh");
	assert.equal(ownerSession({ stateful: false }), "?");
});

test("a closed conversation's plain job runs in the host when the host can hold it, else it is asleep", () => {
	const view = { sessionId: "b", holdsOwn: true, holderOf: () => undefined, hostRuns: (id: string) => id === "known" };
	assert.deepEqual(whereRuns({ stateful: false, sessionId: "known" }, view), { kind: "host" });
	assert.equal(asleepNote({ stateful: false, sessionId: "known-1234" }, { ...view, hostRuns: () => true }), "session known-12 — runs in the host");
	assert.deepEqual(whereRuns({ stateful: false, sessionId: "never-seen" }, view), { kind: "asleep" }, "no file pi-loops knows: asleep");
	assert.deepEqual(whereRuns({ stateful: false, sessionId: "known" }, { ...view, holderOf: () => 7 }), { kind: "terminal", pid: 7 }, "a window holding it comes first");
	assert.equal(runsHere({ stateful: false, sessionId: "known" }, view), false, "not this window's to fire");
});

test("a closed conversation the host is answering in shows as running in the host, not as open in its pid", () => {
	const view = { sessionId: "here", holdsOwn: true, holderOf: () => 4321, holderKind: () => "host" as const };
	assert.deepEqual(whereRuns({ stateful: false, sessionId: "other" }, view), { kind: "host" });
	assert.deepEqual(whereRuns({ stateful: false, sessionId: "other" }, { ...view, holderKind: () => "terminal" as const }), { kind: "terminal", pid: 4321 });
});

test("with no host to run them, loops and closed conversations' plain jobs are paused: marked, and promised no next run", () => {
	const view = { sessionId: "here", holdsOwn: true, hostRuns: () => true, hostPaused: "the host is stopped — /cron host start" };
	const loop = { stateful: true, sessionId: undefined };
	const closed = { stateful: false, sessionId: "closed" };
	assert.deepEqual(whereRuns(loop, view), { kind: "paused", reason: "the host is stopped — /cron host start" });
	assert.equal(runsSomewhere(loop, view), false, "no next run is shown for a run that will not happen");
	assert.equal(asleepNote(loop, view), "paused: the host is stopped — /cron host start");
	assert.equal(asleepNote(closed, view), "session closed — paused: the host is stopped — /cron host start");
	assert.equal(runsSomewhere({ stateful: false, sessionId: "here" }, view), true, "this window's own plain jobs still run");
	assert.deepEqual(whereRuns({ stateful: false, sessionId: "open" }, { ...view, holderOf: () => 4321 }), { kind: "terminal", pid: 4321 }, "one open elsewhere runs there");
});
