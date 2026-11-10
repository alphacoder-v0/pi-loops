import { test } from "node:test";
import assert from "node:assert/strict";
import { activityFrom, attentionFrom, machineWide } from "../src/activity.ts";
import type { InboxEntry } from "../src/inbox.ts";
import type { LoopJob, RunRecord } from "../src/store.ts";
import type { AuditRecord } from "../src/triggers.ts";

const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const at = (min: number) => new Date(NOW - min * 60_000).toISOString();
const same = (a: string, b: string) => a === b;

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
	runId: `run-${Math.random().toString(16).slice(2, 10)}`,
	jobId: "cron-todo",
	jobName: "todo",
	stateful: true,
	cwd: "/api",
	pid: 1,
	startedAt: at(10),
	finishedAt: at(9),
	ok: true,
	findings: 0,
	droppedFindings: 0,
	stateUpdated: true,
	...over,
});
const finding = (over: Partial<InboxEntry>): InboxEntry => ({ id: "inb-1", created_at: at(1), status: "new", kind: "news", source: "cron:todo", run_id: "run-1", cwd: "/api", text: "a finding", verified: null, dismiss_reason: null, ...over });
const audit = (over: Partial<AuditRecord>): AuditRecord => ({ ts: at(5), type: "trigger_result", traceId: "t-1", cwd: "/api", state: "completed", sourceLabel: "local:dynamic", eventLabel: "periodic", ...over });

test("five runs of a loop are five items, newest first; the first three are marked carded", () => {
	const runs = [1, 2, 3, 4, 5].map((n) => run({ runId: `r${n}`, ordinal: n, finishedAt: at(10 - n) }));
	const out = activityFrom({ runs, audit: [], findings: [], jobs: new Map([["cron-todo", { name: "todo" }]]), rules: new Map(), cwd: "/api", inProject: same, sinceMs: NOW - 86_400_000 });
	assert.deepEqual(out.items.map((i) => [i.id, i.carded]), [["r5", false], ["r4", false], ["r3", true], ["r2", true], ["r1", true]]);
	assert.deepEqual([out.more, out.failed], [0, 0]);
	assert.equal(out.items[4].seconds, 60);
});

test("a failure counts and cards, a stop does neither, a removed loop keeps its name, and another project or an old run is left out", () => {
	const runs = [
		run({ runId: "fail", ordinal: 9, ok: false, error: "provider 500 key sk-abcdefghijklmnopqrstuvwxyz012345" }),
		run({ runId: "stop", ordinal: 9, ok: false, aborted: true }),
		run({ runId: "gone", jobId: "cron-old", jobName: "old" }),
		run({ runId: "elsewhere", cwd: "/web" }),
		run({ runId: "yesterday", finishedAt: at(60 * 25) }),
		run({ runId: "plain", stateful: false }),
	];
	const out = activityFrom({ runs, audit: [], findings: [], jobs: new Map([["cron-todo", { name: "todo" }]]), rules: new Map(), cwd: "/api", inProject: same, sinceMs: NOW - 86_400_000 });
	const by = new Map(out.items.map((i) => [i.id, i]));
	assert.deepEqual([...by.keys()].sort(), ["fail", "gone", "stop"]);
	assert.deepEqual([by.get("fail")!.carded, by.get("stop")!.carded, by.get("stop")!.stopped], [true, false, true]);
	assert.doesNotMatch(by.get("fail")!.error!, /sk-abcdefghijklmnopqrstuvwxyz012345/, "redacted");
	assert.deepEqual(by.get("gone")!.source, { id: "cron-old", name: "old", gone: true });
	assert.equal(out.failed, 1, "a stop is not a failure");
	assert.equal(by.get("stop")!.stoppedBy, undefined, "a quit or a restart is not a person");
	const mine = activityFrom({ runs: [run({ runId: "mine", ok: false, aborted: true, stoppedBy: "person" })], audit: [], findings: [], jobs: new Map([["cron-todo", { name: "todo" }]]), rules: new Map(), cwd: "/api", inProject: same, sinceMs: NOW - 86_400_000 });
	assert.deepEqual([mine.items[0].stopped, mine.items[0].stoppedBy, mine.failed], [true, "person", 0], "the strip says stopped by you");
});

test("a rule check that matched is an item joined to its finding; a quiet check is not; a failed one is", () => {
	const audit_ = [
		audit({ ts: at(6), state: "running", traceId: "t-1" }),
		audit({ traceId: "t-1", summary: "matched dyn-1. hello, world", details: { matched_rule_ids: ["dyn-1"], cost_usd: 0.002 } }),
		audit({ type: "trigger_promotion", state: "promoted", traceId: "t-1" }),
		audit({ traceId: "t-quiet", summary: "no dynamic trigger matched", details: { matched_rule_ids: [] } }),
		audit({ traceId: "t-fail", state: "failed", summary: "provider 500" }),
	];
	const findings = [finding({ id: "inb-r", source: "trigger:local:dynamic", run_id: "t-1", job_id: "dyn-1" })];
	const out = activityFrom({ runs: [], audit: audit_, findings, jobs: new Map(), rules: new Map([["dyn-1", { condition: "~/build.done appears", createdBy: { sessionId: "s1" } }]]), cwd: "/api", inProject: same, sessionId: "s1", sinceMs: NOW - 86_400_000 });
	const by = new Map(out.items.map((i) => [i.id, i]));
	assert.deepEqual([...by.keys()].sort(), ["t-1", "t-fail"]);
	const matched = by.get("t-1")!;
	assert.deepEqual([matched.kind, matched.source.name, matched.inboxIds, matched.inChat, matched.seconds, matched.text, matched.fromThisConversation, matched.costUsd], ["rule", "~/build.done appears", ["inb-r"], true, 60, "matched dyn-1. hello, world", true, 0.002]);
	assert.deepEqual([by.get("t-fail")!.ok, by.get("t-fail")!.error], [false, "provider 500"]);
});

test("the list stops at its limit and counts the rest", () => {
	const runs = Array.from({ length: 120 }, (_, i) => run({ runId: `r${i}`, finishedAt: at(120 - i) }));
	const out = activityFrom({ runs, audit: [], findings: [], jobs: new Map(), rules: new Map(), inProject: same, sinceMs: NOW - 86_400_000 });
	assert.deepEqual([out.items.length, out.more, out.items[0].id], [100, 20, "r119"]);
});

test("attention: this project's new decisions and news, the machine's new decisions, streaks of three, the budget only when over", () => {
	const findings = [
		finding({ id: "d-here", kind: "checkpoint", text: "Ship it? · waits: you", created_at: at(3) }),
		finding({ id: "d-there", kind: "checkpoint", text: "Merge the web branch? · waits: you", cwd: "/web", created_at: at(2) }),
		finding({ id: "n1" }),
		finding({ id: "n2" }),
		finding({ id: "old", status: "dismissed" }),
	];
	const job = (over: Partial<LoopJob>) => ({ id: "cron-a", enabled: true, runCount: 10, ...over }) as LoopJob;
	const jobs = [job({ id: "cron-a", name: "ci", consecutiveFailures: 3 }), job({ id: "cron-b", consecutiveFailures: 2 })];
	const a = attentionFrom({ findings, jobs, cwd: "/api", inProject: same, budget: { spent: 1, cap: 5, over: false }, day: "2026-11-05" });
	assert.deepEqual([a.decisions, a.news], [1, 2]);
	assert.deepEqual(a.newDecisions, [{ id: "d-there", cwd: "/web", headline: "Merge the web branch?" }, { id: "d-here", cwd: "/api", headline: "Ship it?" }]);
	assert.deepEqual(a.failing, [{ jobId: "cron-a", name: "ci", streak: 3, key: "cron-a:7" }], "a streak of two is not failing yet");
	assert.equal(a.budget, undefined);
	const over = attentionFrom({ findings: [], jobs: [job({ consecutiveFailures: 4, runCount: 11 })], inProject: same, budget: { spent: 5.2, cap: 5, over: true }, day: "2026-11-05" });
	assert.deepEqual(over.budget, { day: "2026-11-05", spent: 5.2, cap: 5 });
	assert.equal(over.failing[0].key, "cron-a:7", "the key stays the same for the whole streak");
});

test("a project is matched once per distinct cwd, and a record outside the window is never matched", () => {
	const asked: string[] = [];
	const counting = (a: string, b: string) => (asked.push(a), a === b);
	const runs = [...Array.from({ length: 50 }, (_, i) => run({ runId: `r${i}`, finishedAt: at(i + 1) })), ...Array.from({ length: 50 }, (_, i) => run({ runId: `old${i}`, cwd: "/old", finishedAt: at(60 * 30 + i) }))];
	const audit_ = Array.from({ length: 20 }, (_, i) => audit({ traceId: `t${i}`, cwd: "/web", details: { matched_rule_ids: ["dyn-1"] } }));
	const out = activityFrom({ runs, audit: audit_, findings: [], jobs: new Map(), rules: new Map(), cwd: "/api", inProject: counting, sinceMs: NOW - 86_400_000 });
	assert.equal(out.items.length, 50);
	assert.deepEqual(asked.sort(), ["/api", "/web"]);
});

test("a rule result's row leads with what the check said after its `matched <rule-id>`", () => {
	const id = `dyn-${"a1".repeat(16)}`;
	const out = activityFrom({ runs: [], audit: [audit({ summary: `matched ${id}. Ran cargo test in the project: test result: ok.`, details: { matched_rule_ids: [id] } })], findings: [], jobs: new Map(), rules: new Map(), cwd: "/api", inProject: same, sinceMs: NOW - 86_400_000 });
	assert.equal(out.items[0].text, "Ran cargo test in the project: test result: ok.");
});

test("a finding with no cwd is counted in the title of every project, as the inbox lists it", () => {
	const findings = [finding({ id: "loose", cwd: "" }), finding({ id: "loose-d", kind: "checkpoint", cwd: "", text: "Ship it? · waits: you" }), finding({ id: "there", cwd: "/web" })];
	const a = attentionFrom({ findings, jobs: [], cwd: "/api", inProject: same, day: "2026-11-05" });
	assert.deepEqual([a.decisions, a.news], [1, 1]);
});

test("a conversation in no project known is told nothing of any project: only the machine-wide parts", () => {
	const full = attentionFrom({ findings: [finding({ id: "d", kind: "checkpoint", text: "Ship it? · waits: you" }), finding({ id: "n" })], jobs: [{ id: "cron-a", enabled: true, runCount: 9, consecutiveFailures: 3 } as LoopJob], inProject: same, budget: { spent: 6, cap: 5, over: true }, day: "2026-11-05" });
	const wide = machineWide(full);
	assert.deepEqual(Object.keys(wide).sort(), ["budget", "failing", "newDecisions"]);
	assert.deepEqual([wide.newDecisions.length, wide.failing.length, wide.budget?.cap], [1, 1, 5]);
});

test("in chat follows where a run's card went: the conversation that asked for it, not the loop's creator", () => {
	const asked = run({ runId: "asked", ordinal: 9, forSession: "creator", requestedBy: { sessionId: "asker" } as RunRecord["requestedBy"] });
	const first = run({ runId: "first", ordinal: 1, forSession: "creator" });
	const quiet = run({ runId: "quiet", ordinal: 9, forSession: "creator" });
	const inChat = (sessionId: string) => {
		const out = activityFrom({ runs: [asked, first, quiet], audit: [], findings: [], jobs: new Map([["cron-todo", { name: "todo" }]]), rules: new Map(), cwd: "/api", sessionId, inProject: same, sinceMs: NOW - 86_400_000 });
		return Object.fromEntries(out.items.map((i) => [i.id, i.inChat]));
	};
	assert.deepEqual(inChat("asker"), { asked: true, first: false, quiet: false }, "the asker's strip has the run it asked for");
	assert.deepEqual(inChat("creator"), { asked: false, first: true, quiet: false }, "the creator's has its loop's carded run, and not the one asked from elsewhere");
});
