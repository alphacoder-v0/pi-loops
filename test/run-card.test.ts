import { test } from "node:test";
import assert from "node:assert/strict";
import { CARDED_FIRST_RUNS, burstLine, panelRuns, placeRunCards, runCardDelivery, runCardFor, runLine } from "../src/run-card.ts";
import type { RunRecord } from "../src/store.ts";

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
	runId: `run-${Math.random().toString(16).slice(2, 10)}`,
	jobId: "cron-todo",
	jobName: "todo",
	stateful: true,
	cwd: "/work/api",
	pid: 1,
	startedAt: "2026-11-05T12:00:00.000Z",
	finishedAt: "2026-11-05T12:00:05.000Z",
	ok: true,
	findings: 0,
	droppedFindings: 0,
	stateUpdated: true,
	...over,
});

test("a loop's first three runs card and its fourth and fifth do not", () => {
	assert.equal(CARDED_FIRST_RUNS, 3);
	assert.deepEqual([1, 2, 3, 4, 5].map((ordinal) => runCardFor(record({ ordinal }))), ["card", "card", "card", "quiet", "quiet"]);
});

test("a failed run cards whatever its place, and a stopped run never does", () => {
	assert.equal(runCardFor(record({ ordinal: 40, ok: false, error: "provider 500" })), "card");
	assert.equal(runCardFor(record({ ordinal: 4, ok: false })), "card");
	assert.equal(runCardFor(record({ ordinal: 1, ok: false, aborted: true })), "quiet", "a stop is not a failure, even among the first three");
	assert.equal(runCardFor(record({ ordinal: 9, ok: false, aborted: true })), "quiet");
});

test("a record written before 0.24 has no ordinal and is not one of the first three", () => {
	assert.equal(runCardFor(record()), "quiet");
	assert.equal(runCardFor(record({ ok: false })), "card", "its failure still cards");
});

test("a run line is one line: the loop, the time, the cost, the findings, or the error", () => {
	assert.equal(runLine(record({ usage: { input: 1, output: 1, cost: 0.003, turns: 1 }, findings: 1 }), "todo"), "cron todo · 5s · $0.003 · 1 finding");
	assert.equal(runLine(record({ findings: 2 }), "todo"), "cron todo · 5s · 2 findings");
	assert.equal(runLine(record({ ok: false, error: "provider 500\nat line 2", finishedAt: "2026-11-05T12:00:04.000Z" }), "todo"), "cron todo FAILED · 4s · provider 500 at line 2");
	assert.equal(runLine(record({ ok: false, aborted: true }), "todo"), "cron todo stopped · 5s");
	const long = runLine(record({ ok: false, error: "x".repeat(400) }), "todo");
	assert.ok(long.length <= 160, `clipped: ${long.length}`);
	assert.doesNotMatch(runLine(record({ ok: false, error: "key sk-abcdefghijklmnopqrstuvwxyz012345" }), "todo"), /sk-abcdefghijklmnopqrstuvwxyz012345/, "redacted");
});

test("a burst of carded runs shows five cards, oldest first, and folds the rest into one line", () => {
	const fresh = Array.from({ length: 9 }, (_, i) => record({ runId: `r${i}`, ordinal: 10 + i, ok: false, finishedAt: `2026-11-05T12:0${i}:00.000Z` }));
	fresh.push(record({ runId: "quiet", ordinal: 50, finishedAt: "2026-11-05T11:00:00.000Z" }));
	const placed = placeRunCards(fresh.reverse());
	assert.deepEqual(placed.cards.map((r) => r.runId), ["r0", "r1", "r2", "r3", "r4"]);
	assert.deepEqual({ more: placed.more, failed: placed.failed }, { more: 4, failed: 4 });
	assert.equal(burstLine(placed), "+4 more runs finished (4 failed) — /cron runs");
	assert.equal(burstLine({ more: 1, failed: 0 }), "+1 more run finished — /cron runs");
	assert.deepEqual(placeRunCards([record({ ordinal: 7 })]), { cards: [], more: 0, failed: 0 }, "a quiet run is no card and no fold");
});

test("a carded run is saved in the conversation from a terminal and from the page's pi alike; a window that does not hold it only says it", () => {
	const failed = record({ ordinal: 9, ok: false, error: "provider 500" });
	const first = record({ ordinal: 1 });
	assert.deepEqual(runCardDelivery(first, { mode: "tui", mayAppend: true }), { save: true });
	assert.deepEqual(runCardDelivery(failed, { mode: "tui", mayAppend: true }), { save: true, notify: "warning" }, "a terminal's failure is said too, for when the card has scrolled by");
	assert.deepEqual(runCardDelivery(first, { mode: "rpc", mayAppend: true }), { save: true }, "the page's pi saves it: the page draws the entry");
	assert.deepEqual(runCardDelivery(failed, { mode: "rpc", mayAppend: true }), { save: true }, "and a notice would draw the same line twice in the page");
	assert.deepEqual(runCardDelivery(failed, { mode: "rpc", mayAppend: false }), { save: false, notify: "warning" }, "a viewer writes nothing into the conversation another window holds");
	assert.deepEqual(runCardDelivery(first, { mode: "print", mayAppend: true }), { save: false, notify: "info" });
	assert.deepEqual(runCardDelivery(record({ ordinal: 5 }), { mode: "rpc", mayAppend: true }), { save: false }, "a quiet run is neither");
});

test("the panel lists the project's latest loop runs, never a plain job's turn or a /goal evaluator's", () => {
	const all = [record({ runId: "a" }), record({ runId: "goal", stateful: false, jobId: "goal-evaluator" }), record({ runId: "b" }), record({ runId: "elsewhere", cwd: "/work/web" }), record({ runId: "c" }), record({ runId: "plain", stateful: false }), record({ runId: "d" }), record({ runId: "e" })];
	assert.deepEqual(panelRuns(all, (cwd) => cwd === "/work/api", 3).map((r) => r.runId), ["b", "c", "d", "e"], "the latest three, and one more so the panel knows there are others");
});
