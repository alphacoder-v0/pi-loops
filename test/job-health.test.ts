import { test } from "node:test";
import assert from "node:assert/strict";
import { failingJobs, failingSummary, ruleFailureMark } from "../src/job-health.ts";
import { CHECK_FAILURE_BACKOFF_AFTER } from "../src/trigger-runtime.ts";
import { FAILURE_BACKOFF_AFTER } from "../src/scheduler.ts";
import type { LoopJob } from "../src/store.ts";

const job = (over: Partial<LoopJob>): LoopJob => ({ id: "j-1", schedule: { kind: "every", everyMs: 60_000 } as any, stateful: true, prompt: "p", cwd: "/p", enabled: true, catchUp: true, createdAt: new Date().toISOString(), ...over });

test("a loop is reported as failing once the scheduler has started backing it off", () => {
	const jobs = [
		job({ id: "fine", consecutiveFailures: FAILURE_BACKOFF_AFTER - 1 }),
		job({ id: "bad-night", consecutiveFailures: FAILURE_BACKOFF_AFTER }),
		job({ id: "hopeless", name: "check-issues", consecutiveFailures: 7 }),
		job({ id: "paused", enabled: false, consecutiveFailures: 40 }),
		job({ id: "ours", consecutiveFailures: 4 }),
	];
	assert.deepEqual(
		failingJobs(jobs).map((j) => j.id),
		["hopeless", "ours", "bad-night"],
		"worst first; a disabled job is not reported",
	);
});

test("the failing summary names the worst loop and counts the rest", () => {
	const jobs = [job({ id: "a", name: "check-issues", consecutiveFailures: 7 }), job({ id: "b", consecutiveFailures: 3 })];
	assert.equal(failingSummary(jobs), "2 job(s) failing (check-issues ×7)");
	assert.equal(failingSummary([job({ id: "a" })]), undefined, "nothing failing says nothing at all");
	// A name long enough to push the badge off the line is cut, not wrapped.
	const long = failingSummary([job({ id: "a", name: "nightly-dependency-audit-for-every-workspace", consecutiveFailures: 5 })]);
	assert.equal(long, "1 job(s) failing (nightly-dependency-audi… ×5)");
});

test("a rule is marked failing in /triggers rules once its checks are being backed off, and not before", () => {
	// The runtime polls a rule less often from CHECK_FAILURE_BACKOFF_AFTER failures on; the listing
	// used to read the same as a healthy rule's while that gap widened to six hours.
	assert.equal(CHECK_FAILURE_BACKOFF_AFTER, 3);
	assert.equal(ruleFailureMark({ enabled: true, consecutiveFailures: 3 }), "[failing ×3]");
	assert.equal(ruleFailureMark({ enabled: true, consecutiveFailures: 12 }), "[failing ×12]");
	assert.equal(ruleFailureMark({ enabled: true, consecutiveFailures: 2 }), undefined, "a bad check or two is not a failing rule");
	assert.equal(ruleFailureMark({ enabled: true }), undefined);
	assert.equal(ruleFailureMark({ enabled: false, consecutiveFailures: 9 }), undefined, "a disabled rule is not polled, so it is not marked");
});
