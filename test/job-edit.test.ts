import { test } from "node:test";
import assert from "node:assert/strict";
import { applyJobEdit, nextRunOf } from "../src/job-edit.ts";
import { checkJobName } from "../src/tools.ts";
import { parseSchedule } from "../src/schedule.ts";
import type { LoopJob } from "../src/store.ts";

const NOON = Date.parse("2026-09-09T12:00:00Z");

function job(over: Partial<LoopJob> = {}): LoopJob {
	return {
		id: "cron-a", schedule: { kind: "cron", expr: "0 9 * * *" }, stateful: true, prompt: "check the issues",
		cwd: "/work/api", enabled: true, catchUp: true, createdAt: new Date(NOON - 7 * 86_400_000).toISOString(),
		runCount: 3, skippedOverlap: 0, ...over,
	} as LoopJob;
}

const ctx = (over: Partial<Parameters<typeof applyJobEdit>[2]> = {}) => ({
	now: NOON, maxPromptBytes: 8192, checkName: checkJobName, others: [], ...over,
});

test("changing a cron expression starts its clock at the edit, not retroactively", () => {
	// A cron job owes every slot matched since lastDueAt. Moving a daily job to */5 at noon would
	// otherwise owe a run immediately, for a slot that only existed once the expression changed.
	const before = job({ lastDueAt: new Date(NOON - 3 * 3_600_000).toISOString() });
	const applied = applyJobEdit(before, { schedule: parseSchedule("*/5 * * * *", NOON) }, ctx());
	// The instant, not its spelling: stamps carry this machine's offset now, so a test that compares
	// the string passes in UTC and fails in every other timezone a person might run it in.
	assert.equal(Date.parse(applied.patch.lastDueAt!), NOON);
	assert.equal(applied.nextRun.kind, "at", "not due at once");
	assert.deepEqual(applied.changed, ["schedule changed from 0 9 * * * to */5 * * * *"]);
});

test("an `every` job that is already overdue says so instead of promising a later time", () => {
	// `every 30m` is measured from lastFiredAt, which is real bookkeeping and is not rewritten: one
	// that last ran an hour ago genuinely is overdue, and the confirmation must not claim otherwise.
	const before = job({ schedule: { kind: "every", ms: 3_600_000 }, lastFiredAt: new Date(NOON - 3_600_000).toISOString() });
	const applied = applyJobEdit(before, { schedule: parseSchedule("every 30m", NOON) }, ctx());
	assert.equal(applied.patch.lastFiredAt, undefined, "lastFiredAt is untouched");
	assert.equal(applied.nextRun.kind, "due");
});

test("an expression that parses but never matches is refused, and nothing is written", () => {
	assert.throws(() => applyJobEdit(job(), { schedule: parseSchedule("0 0 30 2 *", NOON) }, ctx()), /has no next run/);
});

test("a job cannot be turned into a one-shot: running one deletes it, and its notes with it", () => {
	assert.throws(() => applyJobEdit(job(), { schedule: parseSchedule("in 10m", NOON) }, ctx()), /one-shot/);
});

test("the patch carries only what changed, so a run that started meanwhile is not erased", () => {
	// `JobStore.update` re-reads under a lock. A whole job built from a stale copy would wipe the
	// `running` marker a tick set in between; a patch cannot.
	const applied = applyJobEdit(job(), { prompt: "check the issues, briefly" }, ctx());
	assert.deepEqual(Object.keys(applied.patch), ["prompt"]);
	assert.equal("running" in applied.patch, false);
	assert.equal("runCount" in applied.patch, false);
});

test("a name has to stay usable as a reference, and a prompt has to fit", () => {
	const others = [job({ id: "cron-b", name: "ci" })];
	assert.throws(() => applyJobEdit(job(), { name: "ci" }, ctx({ others })), /already exists/);
	assert.throws(() => applyJobEdit(job(), { name: "my job" }, ctx({ others })), /1-40 chars/);
	assert.throws(() => applyJobEdit(job(), { prompt: "" }, ctx()), /cannot be empty/);
	assert.throws(() => applyJobEdit(job(), { prompt: "x".repeat(9000) }, ctx()), /exceeds 8192 bytes/);
	// Clearing an optional field is not the same as leaving it alone.
	assert.deepEqual(applyJobEdit(job({ model: "p/m" }), { model: null }, ctx()).patch, { model: undefined });
});

test("the same prompt is stored without claiming it changed", () => {
	const applied = applyJobEdit(job(), { prompt: "check the issues" }, ctx());
	assert.equal(applied.patch.prompt, "check the issues");
	assert.deepEqual(applied.changed, [], "nothing to tie a behaviour change to");
});

test("a disabled job reports no next run, whatever its schedule says", () => {
	// Even one that is owed a run right now: it is disabled, so nothing is going to happen.
	assert.deepEqual(nextRunOf(job({ enabled: false }), NOON), { kind: "disabled" });
	assert.equal(nextRunOf(job(), NOON).kind, "due", "the same job enabled is owed the slots it never ran");
	// Caught up, so the answer is a time rather than "now".
	assert.equal(nextRunOf(job({ lastDueAt: new Date(NOON - 3 * 3_600_000).toISOString() }), NOON).kind, "at");
});

