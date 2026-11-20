import { test } from "node:test";
import assert from "node:assert/strict";
import { failingJobs, failingSummary, ruleFailureMark } from "../src/job-health.ts";
import { FAILING_AFTER } from "../src/backoff.ts";
import type { ListedJob } from "../src/job-status.ts";
import type { LoopJob } from "../src/store.ts";

const job = ({ streak = 0, ...over }: Partial<LoopJob> & { streak?: number }): ListedJob => ({ id: "j-1", schedule: { kind: "every", everyMs: 60_000 } as any, stateful: true, prompt: "p", cwd: "/p", enabled: true, catchUp: true, createdAt: new Date().toISOString(), ...over, status: { runs: 0, collapsed: 0, streak } });

test("a loop is reported as failing once the scheduler has started backing it off", () => {
	const jobs = [
		job({ id: "fine", streak: FAILING_AFTER - 1 }),
		job({ id: "bad-night", streak: FAILING_AFTER }),
		job({ id: "hopeless", name: "check-issues", streak: 7 }),
		job({ id: "paused", enabled: false, streak: 40 }),
		job({ id: "ours", streak: 4 }),
	];
	assert.deepEqual(
		failingJobs(jobs).map((j) => j.id),
		["hopeless", "ours", "bad-night"],
		"worst first; a disabled job is not reported",
	);
});

test("the failing summary names the worst loop and counts the rest", () => {
	const jobs = [job({ id: "a", name: "check-issues", streak: 7 }), job({ id: "b", streak: 3 })];
	assert.equal(failingSummary(jobs), "2 loops failing (check-issues ×7)");
	assert.equal(failingSummary([job({ id: "a" })]), undefined, "nothing failing says nothing at all");
	// A name long enough to push the badge off the line is cut, not wrapped.
	const long = failingSummary([job({ id: "a", name: "nightly-dependency-audit-for-every-workspace", streak: 5 })]);
	assert.equal(long, "1 loop failing (nightly-dependency-audi… ×5)");
});

test("a rule is marked failing in /triggers rules once its checks are being backed off, and not before", () => {
	// The runtime polls a rule less often from FAILING_AFTER failures on; the listing
	// used to read the same as a healthy rule's while its checks were backed off.
	assert.equal(FAILING_AFTER, 3);
	assert.equal(ruleFailureMark({ enabled: true, consecutiveFailures: 3 }), "[failing ×3]");
	assert.equal(ruleFailureMark({ enabled: true, consecutiveFailures: 12 }), "[failing ×12]");
	assert.equal(ruleFailureMark({ enabled: true, consecutiveFailures: 2 }), undefined, "a bad check or two is not a failing rule");
	assert.equal(ruleFailureMark({ enabled: true }), undefined);
	assert.equal(ruleFailureMark({ enabled: false, consecutiveFailures: 9 }), undefined, "a disabled rule is not polled, so it is not marked");
});
