import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKOFF_MS, backoffFor, FAILING_AFTER, failurePause } from "../src/backoff.ts";

test("The backoff table lists one minute, five minutes, thirty minutes, two hours and six hours.", () => {
	assert.deepEqual(BACKOFF_MS, [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000]);
});

test("backoffFor returns each step and clamps values outside the table.", () => {
	assert.deepEqual([1, 2, 3, 4, 5].map(backoffFor), BACKOFF_MS);
	assert.equal(backoffFor(6), 6 * 3_600_000);
	assert.equal(backoffFor(50), 6 * 3_600_000);
	assert.equal(backoffFor(0), 60_000);
	assert.equal(backoffFor(-3), 60_000);
});

test("Three failures in a row make a loop or rule check count as failing.", () => {
	assert.equal(FAILING_AFTER, 3);
});

test("failurePause starts at one minute on the third failure and follows the table.", () => {
	assert.deepEqual([0, 1, 2].map(failurePause), [0, 0, 0]);
	assert.deepEqual([3, 4, 5, 6, 7, 30].map(failurePause), [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 6 * 3_600_000]);
});
