import { test } from "node:test";
import assert from "node:assert/strict";
import { PAUSE_DISMISSED, PAUSE_FINDINGS, QUIET_SUGGEST_AFTER, applyTune, rowSignal, suggestTune } from "../src/job-tune.ts";
import type { LoopSignal } from "../src/job-signal.ts";
import type { LoopJob } from "../src/store.ts";

const now = Date.parse("2026-11-05T09:07:00Z");
const job = (over: Partial<LoopJob> = {}): LoopJob => ({ id: "cron-aaaaaaaa", schedule: { kind: "every", ms: 15 * 60_000 }, stateful: true, prompt: "p", cwd: "/p", enabled: true, catchUp: true, createdAt: "2026-10-01T00:00:00Z", runCount: 40, skippedOverlap: 0, ...over });
const signal = (over: Partial<LoopSignal> = {}): LoopSignal => ({ runs: 40, findings: 0, claimed: 0, dismissed: 0, dismissedWithReason: 0, quiet: 0, ...over });
const ctx = { now, maxPromptBytes: 8192, checkName: () => undefined, others: [] };

test("the thresholds are the ones docs/loops.md names", () => {
	assert.deepEqual([QUIET_SUGGEST_AFTER, PAUSE_FINDINGS, PAUSE_DISMISSED], [12, 5, 5]);
});

test("a quiet loop that runs more often than hourly is offered hourly; at 11 quiet runs, or already hourly, nothing", () => {
	assert.deepEqual(suggestTune(job(), signal({ quiet: 12 }), now), { kind: "slower", key: "slower:cron-aaaaaaaa:every 15m", label: "Run hourly instead" });
	assert.equal(suggestTune(job(), signal({ quiet: 11 }), now), undefined);
	assert.equal(suggestTune(job({ schedule: { kind: "every", ms: 3_600_000 } }), signal({ quiet: 40 }), now), undefined, "quiet is not a fault");
	assert.equal(suggestTune(job({ schedule: { kind: "cron", expr: "0 9 * * *" } }), signal({ quiet: 40 }), now), undefined);
	assert.equal(suggestTune(job({ schedule: { kind: "cron", expr: "*/15 * * * *" } }), signal({ quiet: 12 }), now)?.key, "slower:cron-aaaaaaaa:*/15 * * * *");
});

test("a loop whose findings were all dismissed is offered Pause, which wins over hourly", () => {
	assert.equal(suggestTune(job(), signal({ findings: 6, dismissed: 6, quiet: 20 }), now)?.kind, "pause");
	assert.equal(suggestTune(job(), signal({ findings: 6, dismissed: 5, claimed: 1 }), now), undefined, "one claim and it is worth something");
	assert.equal(suggestTune(job(), signal({ findings: 4, dismissed: 4 }), now), undefined);
	assert.equal(suggestTune(job(), signal({ findings: 6, dismissed: 4 }), now), undefined);
});

test("no suggestion for a disabled, plain, one-shot or running loop, or one the person kept", () => {
	const quiet = signal({ quiet: 30 });
	assert.equal(suggestTune(job({ enabled: false }), quiet, now), undefined);
	assert.equal(suggestTune(job({ stateful: false }), quiet, now), undefined);
	assert.equal(suggestTune(job({ schedule: { kind: "once", at: now + 60_000 } }), quiet, now), undefined);
	assert.equal(suggestTune(job({ running: { runId: "run-x", pid: 1, host: "h", startedAt: "t" } as any }), quiet, now), undefined);
	assert.equal(suggestTune(job({ tuneKept: "slower:cron-aaaaaaaa:every 15m" }), quiet, now), undefined);
	// Kept under another schedule: the key changed with it, so the suggestion is new.
	assert.equal(suggestTune(job({ tuneKept: "slower:cron-aaaaaaaa:every 10m" }), quiet, now)?.kind, "slower");
});

test("applying: hourly goes through applyJobEdit (the clock restarts at the edit); Pause turns the loop off", () => {
	const hourly = applyTune(job({ tuneKept: "old" }), suggestTune(job(), signal({ quiet: 12 }), now)!, ctx);
	assert.equal(hourly.op, "set");
	assert.deepEqual(hourly.patch.schedule, { kind: "every", ms: 3_600_000 });
	assert.equal(Date.parse(hourly.patch.lastDueAt!), now);
	assert.ok("tuneKept" in hourly.patch && hourly.patch.tuneKept === undefined);
	assert.deepEqual(hourly.changed, ["schedule changed from every 15m to every 1h"]);
	const cron = applyTune(job({ schedule: { kind: "cron", expr: "*/15 * * * *" } }), { kind: "slower", key: "k", label: "Run hourly instead" }, ctx);
	assert.deepEqual(cron.patch.schedule, { kind: "cron", expr: "0 * * * *" });
	const pause = applyTune(job(), { kind: "pause", key: "k", label: "Pause" }, ctx);
	assert.equal(pause.op, "disable");
	assert.equal(pause.patch.enabled, false);
});

test("rowSignal: the four numbers a row shows", () => {
	assert.deepEqual(rowSignal(signal({ findings: 6, claimed: 0, dismissed: 6, quiet: 12 })), { findings30d: 6, claimed30d: 0, dismissed30d: 6, quietStreak: 12 });
});
