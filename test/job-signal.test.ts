import { test } from "node:test";
import assert from "node:assert/strict";
import type { InboxEntry } from "../src/inbox.ts";
import { QUIET_MARK_AFTER, loopSignal, signalSummary } from "../src/job-signal.ts";
import type { RunRecord } from "../src/store.ts";

const DAY = 86_400_000;
const now = Date.parse("2026-09-15T09:00:00.000+08:00");
const run = (daysAgo: number, findings: number, over: Partial<RunRecord> = {}): RunRecord => {
	const at = new Date(now - daysAgo * DAY).toISOString();
	return { runId: `r-${daysAgo}-${findings}`, jobId: "j", stateful: true, cwd: "/p", pid: 1, startedAt: at, finishedAt: at, ok: true, findings, droppedFindings: 0, stateUpdated: true, ...over };
};
const entry = (daysAgo: number, status: InboxEntry["status"], over: Partial<InboxEntry> = {}): InboxEntry => ({ id: `inb-${daysAgo}-${status}`, created_at: new Date(now - daysAgo * DAY).toISOString(), source: "cron:j", text: "f", kind: "news", run_id: "r", job_id: "j", cwd: "/p", verified: null, dismiss_reason: null, status, ...over });

test("a loop's signal: findings in the window, what became of them, and the quiet streak at the tail", () => {
	const runs = [
		run(40, 3), // outside the window: not counted, but part of the streak's history
		run(20, 2),
		run(10, 0, { ok: false, error: "boom" }),
		run(5, 1),
		run(3, 0),
		run(2, 0),
		run(1, 0),
	];
	const inbox = [
		entry(40, "claimed"), // outside the window
		entry(20, "claimed"),
		entry(20, "dismissed", { dismiss_reason: "noise" }),
		entry(5, "dismissed"),
		entry(5, "new", { job_id: "other" }), // another loop's
	];
	const s = loopSignal("j", runs, inbox, now - 30 * DAY);
	assert.deepEqual(s, { runs: 6, findings: 3, claimed: 1, dismissed: 2, dismissedWithReason: 1, quiet: 3 });
	assert.equal(signalSummary(s), "3 findings · 1 claimed · 2 dismissed (1 with a reason)");
	assert.ok(s.quiet >= QUIET_MARK_AFTER);
});

test("the streak is counted from the newest run whatever the window, and a finding ends it", () => {
	const runs = [run(50, 0), run(45, 0), run(40, 0), run(35, 0), run(2, 0)];
	assert.equal(loopSignal("j", runs, [], now - 30 * DAY).quiet, 5, "five empty runs, four of them older than the window");
	assert.equal(loopSignal("j", [...runs, run(1, 1)], [], now - 30 * DAY).quiet, 0);
	// Given out of order, the newest still decides.
	assert.equal(loopSignal("j", [run(1, 0), run(3, 2), run(2, 0)], [], now - 30 * DAY).quiet, 2);
	assert.equal(loopSignal("j", [], [], 0).quiet, 0);
});

test("a loop with no findings yet has no summary; one with only findings says just that", () => {
	assert.equal(signalSummary(loopSignal("j", [run(1, 0)], [], 0)), undefined);
	assert.equal(signalSummary(loopSignal("j", [run(1, 1)], [entry(1, "new")], 0)), "1 finding");
	assert.equal(signalSummary(loopSignal("j", [run(1, 2)], [entry(1, "dismissed"), entry(1, "dismissed")], 0)), "2 findings · 2 dismissed");
});
