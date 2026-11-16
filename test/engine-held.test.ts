// What the drain decides for a row pi holds and has not begun: a cancel, a row that leaves, a row pi lost. From the Gates review of PR 261.
import { test } from "node:test";
import assert from "node:assert/strict";
import { type ExecutorView, type Proof, cancelRow, decideDrain } from "../src/engine.ts";
import type { UnclaimedRow } from "../src/requests.ts";

const T0 = Date.parse("2026-06-01T12:00:00Z");
const by = { pid: 1, instance: "w", version: "0" };
const row = (id: string, over: Partial<UnclaimedRow> = {}): UnclaimedRow => ({ v: 3, id, lane: "s", kind: "input", source: "cron:j", mode: "unattended", wake: "turn", collapse_key: "cron:j", payload: { text: `[Trigger ${id}] hello`, cwd: "/" }, created_at: "2026-01-01T00:00:00Z", created_by: by, attempts: 0, ...over }) as UnclaimedRow;
const view = (over: Partial<ExecutorView> = {}): ExecutorView => ({ kind: "window", ceiling: () => true, blocked: () => undefined, claimLive: () => false, idle: true, inFlight: new Set(), connected: () => true, producerAlive: () => true, mine: () => true, ...over });
const none: Proof = { has: () => false, older: () => false, heldRunWrote: () => false, ran: () => undefined };
const jobs = { exists: () => true, enabled: () => true, goalActive: () => true };

test("a cancel of the row whose message pi has begun does not take it out", () => {
	const t1 = row("t1");
	const cancel = cancelRow("s", { id: "t1" }, "page" as any, by as any, T0);
	const acts = decideDrain("conversation", [t1, cancel], none, jobs, view({ idle: false, inFlight: new Set(["t1"]), running: { requestId: "t1", startedAt: new Date(T0).toISOString() } }), T0);
	assert.equal(acts.some((a) => a.do === "exit" && a.row.id === "t1"), false, JSON.stringify(acts.map((a) => [a.do, (a as any).row?.id ?? (a as any).target])));
});

test("a row whose job is gone while pi holds its prompt unstarted is aborted as it starts", () => {
	const t1 = row("t1");
	const acts = decideDrain("conversation", [t1], none, { ...jobs, exists: () => false }, view({ inFlight: new Set(["t1"]), inFlightSince: new Map([["t1", T0]]) }), T0);
	assert.deepEqual(acts.map((a) => a.do), ["abortWhenStarted", "exit"]);
});

test("a goal's continuation that leaves while pi holds it unstarted is aborted as it starts", () => {
	const g = row("goal-1", { source: "goal", mode: "attended", payload: { text: "continue", cwd: "/" } } as any);
	const acts = decideDrain("conversation", [g], none, { ...jobs, goalActive: () => false }, view({ inFlight: new Set(["goal-1"]), inFlightSince: new Map([["goal-1", T0]]) }), T0);
	assert.deepEqual(acts.map((a) => a.do), ["abortWhenStarted", "exit"]);
});

test("a row pi lost unwritten is one attempt with a backoff; a person's goes back to the page", () => {
	const t1 = row("t1");
	const acts = decideDrain("conversation", [t1], none, jobs, view({ gone: new Map([["t1", "lost"]]) }), T0);
	assert.deepEqual(acts.filter((a) => a.do === "fail").map((a: any) => [a.row.id, a.retry]), [["t1", "backoff"]]);
	const p = row("p1", { source: "person", mode: "attended", payload: { text: "hi", cwd: "/" } } as any);
	const acts2 = decideDrain("conversation", [p], none, jobs, view({ gone: new Map([["p1", "lost"]]) }), T0);
	assert.deepEqual(acts2.filter((a) => a.do === "fail").map((a: any) => [a.row.id, a.retry]), [["p1", "never"]]);
});
