import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import { Inbox } from "../src/inbox.ts";
import { JobStore } from "../src/store.ts";
import { markSeen, readSeen, sinceYouLooked, sinceYouLookedLine } from "../src/seen.ts";

const run = (over: Record<string, unknown> = {}) => ({ runId: "r", jobId: "j", stateful: true, cwd: "/", pid: 1, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-02T00:00:00Z", ok: true, findings: 0, droppedFindings: 0, stateUpdated: false, forSession: "s", ...over }) as any;

test("counts runs, failed runs and findings after the cursor; another session does not count", async () => {
	const inbox = new Inbox(tmp("pi-loops-seen-"));
	await inbox.append({ source: "cron:x", text: "new", run_id: "r", job_id: "j", cwd: "/", session_id: "s" });
	const counts = sinceYouLooked([run(), run({ runId: "r2", ok: false }), run({ runId: "other", forSession: "other" })], inbox.list(), "s", "2026-01-01T00:00:00Z");
	assert.deepEqual(counts, { runs: 2, failed: 1, findings: 1 });
});

test("a missing seen.json counts everything once", () => {
	const dir = tmp("pi-loops-seen-");
	assert.deepEqual(readSeen(dir), { v: 1, seen: {} });
	assert.deepEqual(sinceYouLooked([run()], [], "s", readSeen(dir).seen.s), { runs: 1, failed: 0, findings: 0 });
	markSeen(dir, "s", "2026-01-03T00:00:00.000Z");
	assert.deepEqual(readSeen(dir).seen, { s: "2026-01-03T00:00:00.000Z" });
});

test("sinceYouLookedLine has the specified forms", () => {
	assert.equal(sinceYouLookedLine({ runs: 0, failed: 0, findings: 0 }), undefined);
	assert.equal(sinceYouLookedLine({ runs: 4, failed: 1, findings: 3 }), "[inbox] since you last looked: 4 loop runs (1 failed), 3 new findings from loops started in this conversation — /inbox");
	assert.equal(sinceYouLookedLine({ runs: 1, failed: 0, findings: 1 }), "[inbox] since you last looked: 1 loop run, 1 new finding from loops started in this conversation — /inbox");
	assert.equal(sinceYouLookedLine({ runs: 2, failed: 0, findings: 0 }), "[inbox] since you last looked: 2 loop runs from loops started in this conversation — /inbox");
	assert.equal(sinceYouLookedLine({ runs: 0, failed: 0, findings: 3 }), "[inbox] since you last looked: 3 new findings from loops started in this conversation — /inbox");
});

test("findings in other projects are counted apart, and rule results for the conversation are counted from the audit trail", async () => {
	const inbox = new Inbox(tmp("pi-loops-seen-"));
	await inbox.append({ source: "cron:x", text: "here", run_id: "r", job_id: "j", cwd: "/proj/a", session_id: "s" });
	await inbox.append({ source: "cron:x", text: "there", run_id: "r", job_id: "j", cwd: "/proj/b", session_id: "s" });
	await inbox.append({ source: "trigger:Dynamic", text: "rule result filed for s", run_id: "t1", job_id: "Dynamic", cwd: "/proj/a", session_id: "s" });
	const appended = [
		{ ts: "2026-01-02T00:00:00Z", state: "appended", details: { session_id: "s" } },
		{ ts: "2026-01-02T00:00:00Z", state: "appended", details: { session_id: "other" } },
		{ ts: "2026-01-02T00:00:00Z", state: "promoted", details: { session_id: "s" } },
	];
	const counts = sinceYouLooked([], inbox.list(), "s", "2026-01-01T00:00:00Z", { cwd: "/proj/a", inProject: (a, b) => a === b, appended });
	assert.deepEqual(counts, { runs: 0, failed: 0, findings: 1, elsewhere: 1, results: 2 });
	assert.equal(sinceYouLookedLine(counts), "[inbox] since you last looked: 1 new finding from loops started in this conversation, 1 more in other projects (/inbox --all), 2 rule results for this conversation — /inbox");
});
