import { test } from "node:test";
import assert from "node:assert/strict";
import { applyJobEdit, nextRunOf } from "../src/job-edit.ts";
import { checkJobName } from "../src/tools.ts";
import { parseSchedule } from "../src/schedule.ts";
import { parseSetArgs } from "../src/args.ts";
import { fromV2, type V2Job } from "../src/convert-v2.ts";

const NOON = Date.parse("2026-09-09T12:00:00Z");

/** A job as a version 2 file held it; `edit` and `next` hand its definition and its cursor over, as the store and clock.json hold them now. */
function job(over: Partial<V2Job> = {}): V2Job {
	return {
		id: "cron-a", schedule: { kind: "cron", expr: "0 9 * * *" }, stateful: true, prompt: "check the issues",
		cwd: "/work/api", enabled: true, catchUp: true, createdAt: new Date(NOON - 7 * 86_400_000).toISOString(),
		runCount: 3, skippedOverlap: 0, ...over,
	} as V2Job;
}
const edit = (j: V2Job, change: Parameters<typeof applyJobEdit>[2], c: Parameters<typeof applyJobEdit>[3]) => applyJobEdit(fromV2(j).job, fromV2(j).clock, change, c);
const next = (j: V2Job, now: number) => nextRunOf(fromV2(j).job, fromV2(j).clock, now);

const ctx = (over: Partial<Parameters<typeof applyJobEdit>[3]> = {}) => ({
	now: NOON, maxPromptBytes: 8192, checkName: checkJobName, others: [], ...over,
});

test("changing a cron expression starts its clock at the edit, not retroactively", () => {
	// A cron job owes every slot matched since its last slot. Moving a daily job to */5 at noon would
	// otherwise owe a run immediately, for a slot that only existed once the expression changed.
	const before = job({ lastDueAt: new Date(NOON - 3 * 3_600_000).toISOString() });
	const applied = edit(before, { schedule: parseSchedule("*/5 * * * *", NOON) }, ctx());
	// The instant, not its spelling: stamps carry this machine's offset now, so a test that compares
	// the string passes in UTC and fails in every other timezone a person might run it in.
	assert.equal(Date.parse(applied.slot!), NOON, "the clock restarts at the edit");
	assert.deepEqual(Object.keys(applied.patch), ["schedule"], "the definition holds no cursor");
	assert.equal(applied.nextRun.kind, "at", "not due at once");
	assert.deepEqual(applied.changed, ["schedule changed from 0 9 * * * to */5 * * * *"]);
});

test("an `every` job that is already overdue says so instead of promising a later time", () => {
	// `every 30m` is measured from its last fire, which is real bookkeeping and is not rewritten: one
	// that last ran an hour ago genuinely is overdue, and the confirmation must not claim otherwise.
	const before = job({ schedule: { kind: "every", ms: 3_600_000 }, lastFiredAt: new Date(NOON - 3_600_000).toISOString() });
	const applied = edit(before, { schedule: parseSchedule("every 30m", NOON) }, ctx());
	assert.deepEqual(Object.keys(applied.patch), ["schedule"], "the last fire is untouched: only the slot is reset");
	assert.equal(applied.nextRun.kind, "due");
});

test("an expression that parses but never matches is refused, and nothing is written", () => {
	assert.throws(() => edit(job(), { schedule: parseSchedule("0 0 30 2 *", NOON) }, ctx()), /has no next run/);
});

test("a job cannot be turned into a one-shot: running one deletes it, and its notes with it", () => {
	assert.throws(() => edit(job(), { schedule: parseSchedule("in 10m", NOON) }, ctx()), /one-shot/);
});

test("the patch carries only what changed, so a run that started meanwhile is not erased", () => {
	// `JobStore.update` re-reads under a lock. A whole job built from a stale copy would wipe the
	// `running` marker a tick set in between; a patch cannot.
	const applied = edit(job(), { prompt: "check the issues, briefly" }, ctx());
	assert.deepEqual(Object.keys(applied.patch), ["prompt"]);
	assert.equal("running" in applied.patch, false);
	assert.equal("runCount" in applied.patch, false);
});

test("--tools - clears a plain job's list, and the patch says what the turns were capped to", () => {
	// A plain job made in 0.22 with --tools never used the list; its turns are capped to it since
	// 0.23, and this is the one way to uncap them without remove-and-re-add.
	const applied = edit(job({ stateful: false, tools: ["read", "grep"] }), { tools: null }, ctx());
	assert.deepEqual(applied.patch, { tools: undefined });
	assert.deepEqual(applied.changed, ["tools changed from read,grep to (none)"]);
	const set = edit(job({ stateful: false }), { tools: ["read"] }, ctx());
	assert.deepEqual([set.patch, set.changed], [{ tools: ["read"] }, ["tools changed from (none) to read"]]);
	assert.equal("tools" in edit(job(), { name: "x" }, ctx()).patch, false, "untouched unless asked");
});

test("a name has to stay usable as a reference, and a prompt has to fit", () => {
	const others = [job({ id: "cron-b", name: "ci" })];
	assert.throws(() => edit(job(), { name: "ci" }, ctx({ others })), /already exists/);
	assert.throws(() => edit(job(), { name: "my job" }, ctx({ others })), /1-40 chars/);
	assert.throws(() => edit(job(), { prompt: "" }, ctx()), /cannot be empty/);
	assert.throws(() => edit(job(), { prompt: "x".repeat(9000) }, ctx()), /exceeds 8192 bytes/);
	// Clearing an optional field is not the same as leaving it alone.
	assert.deepEqual(edit(job({ model: "p/m" }), { model: null }, ctx()).patch, { model: undefined });
});

test("the same prompt is stored without claiming it changed", () => {
	const applied = edit(job(), { prompt: "check the issues" }, ctx());
	assert.equal(applied.patch.prompt, "check the issues");
	assert.deepEqual(applied.changed, [], "nothing to tie a behaviour change to");
});

test("a disabled job reports no next run, whatever its schedule says", () => {
	// Even one that is owed a run right now: it is disabled, so nothing is going to happen.
	assert.deepEqual(next(job({ enabled: false }), NOON), { kind: "disabled" });
	assert.equal(next(job(), NOON).kind, "due", "the same job enabled is owed the slots it never ran");
	// Caught up, so the answer is a time rather than "now".
	assert.equal(next(job({ lastDueAt: new Date(NOON - 3 * 3_600_000).toISOString() }), NOON).kind, "at");
});


test("[wake-me] /cron set <loop> --wake -: what the loop set goes from clock.json, beside an empty patch; jobs.json keeps the definition; a plain job and any other value are refused", () => {
	assert.deepEqual(parseSetArgs("pr-watch --wake -", { job: true }), { ref: "pr-watch", wake: null });
	assert.throws(() => parseSetArgs("pr-watch --wake in20m", { job: true }), /--wake takes - : it removes the wake a loop set for itself/);
	assert.throws(() => parseSetArgs("rule --wake -"), /unknown flag --wake/, "a rule has no wake");
	const loop = fromV2(job());
	const followup = { id: "fu-1", at: new Date(NOON + 3_600_000).toISOString(), note: "check CI", set_by: "run-a", created_at: new Date(NOON).toISOString() };
	const applied = applyJobEdit(loop.job, { ...(loop.clock ?? { runs: 0 }), followup, quietUntil: followup.at, quietWhy: "check CI" }, { wake: null }, ctx());
	assert.deepEqual(applied.patch, {});
	assert.equal(applied.clearWake, true);
	assert.deepEqual(applied.changed, [`wake removed (it was ${followup.at}: "check CI") (quiet until ${followup.at})`]);
	assert.equal(edit(job(), { name: "x" }, ctx()).clearWake, undefined, "an edit with no --wake leaves the wake");
	assert.throws(() => edit(job({ stateful: false, sessionId: "s" }), { wake: null }, ctx()), /--wake is for a loop/);
});

test("/cron set <loop> --gate '<command>' sets the loop's gate in a patch, --gate - removes it; a plain job, an empty or refused command change nothing", () => {
	assert.deepEqual(parseSetArgs("pr-watch --gate 'gh pr list --json number'", { job: true }), { ref: "pr-watch", gate: "gh pr list --json number" });
	assert.deepEqual(parseSetArgs("pr-watch --gate -", { job: true }), { ref: "pr-watch", gate: null });
	assert.deepEqual(parseSetArgs("pr-watch --gate '-'", { job: true }), { ref: "pr-watch", gate: "-" }, "a quoted - is a command");
	assert.throws(() => parseSetArgs("rule --gate x"), /unknown flag --gate/, "a rule's gate comes only from a proposal");
	const set = edit(job(), { gate: "gh pr list" }, ctx());
	assert.deepEqual(set.patch, { gate: { kind: "command", command: "gh pr list" } });
	assert.deepEqual(set.changed, ['gate changed from (none) to "gh pr list"']);
	const gated = { ...fromV2(job()).job, gate: { kind: "command" as const, command: "gh pr list" } };
	const removed = applyJobEdit(gated, fromV2(job()).clock, { gate: null }, ctx());
	assert.equal("gate" in removed.patch && removed.patch.gate, undefined, "the patch removes it");
	assert.ok("gate" in removed.patch);
	assert.deepEqual(removed.changed, ['gate changed from "gh pr list" to (none)']);
	assert.throws(() => edit(job({ stateful: false, sessionId: "s" }), { gate: "true" }, ctx()), /--gate is for a loop/);
	assert.throws(() => edit(job(), { gate: "  " }, ctx()), /a gate needs a command/);
	assert.throws(() => edit(job(), { gate: "sudo ls" }, ctx()), /the gate would be refused when it runs: sudo invocation/);
	assert.throws(() => edit(job(), { gate: "ls\nrm x" }, ctx()), /a gate is one line/);
});
