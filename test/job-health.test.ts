import { test } from "node:test";
import assert from "node:assert/strict";
import { failingJobs, failingSummary } from "../src/job-health.ts";
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
