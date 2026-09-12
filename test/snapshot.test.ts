import { test } from "node:test";
import assert from "node:assert/strict";
import { SNAPSHOT_MIN_GAP_MS, shouldEmitSnapshot, snapshotFingerprint } from "../src/snapshot.ts";

const data = (over: any = {}) => ({
	scheduler: { running: true, leader: true },
	counts: { jobs: 2, rules: 1 },
	mcp: [{ name: "hub", state: "connected", tools: ["hub_search"], queuedCount: 3 }],
	hooks: { count: 0, events: [] },
	tools: ["bash"],
	at: "2026-09-12T10:00:00Z",
	...over,
});

test("the fingerprint follows what a reader would call a change, not the counters", () => {
	const base = snapshotFingerprint(data());
	assert.equal(base, snapshotFingerprint(data({ at: "2026-09-12T11:00:00Z" })), "the timestamp alone is not a change");
	assert.equal(base, snapshotFingerprint(data({ mcp: [{ name: "hub", state: "connected", tools: ["hub_search"], queuedCount: 900 }] })), "nor is a busy server's queue");
	assert.notEqual(base, snapshotFingerprint(data({ scheduler: { running: true, leader: false } })), "losing the clock is");
	assert.notEqual(base, snapshotFingerprint(data({ tools: ["bash", "hub_search"] })), "and so is a new tool");
});

test("an unchanged snapshot within the gap is not written, and /cron snapshot always is", () => {
	const now = 5_000_000;
	const prev = { fingerprint: "abc", at: now - 1_000 };
	assert.equal(shouldEmitSnapshot(prev, "def", now, false), false, "a change this soon after the last entry waits");
	assert.equal(shouldEmitSnapshot(prev, "def", now + SNAPSHOT_MIN_GAP_MS, false), true, "and is written once the gap has passed");
	assert.equal(shouldEmitSnapshot(prev, "abc", now + 10 * SNAPSHOT_MIN_GAP_MS, false), false, "an unchanged snapshot is never written on its own");
	assert.equal(shouldEmitSnapshot(prev, "abc", now, true), true, "force writes it regardless");
	assert.equal(shouldEmitSnapshot({ at: 0 }, "abc", now, false), true, "and the first snapshot of a session is a change");
});
