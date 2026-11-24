import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { loadConfig } from "../src/config.ts";
import { abortRemovedJobs } from "../src/background-executor.ts";
import { createHostRuntime } from "../src/host-runtime.ts";
import { EventLog } from "../src/events.ts";
import { checkLane } from "../src/lane.ts";
import { pushRowId, writePush } from "../src/push.ts";
import { RequestStore } from "../src/requests.ts";

const USAGE = { input: 1, output: 1, cost: 0.01, turns: 1 };
const BY = { pid: process.pid, instance: "test", version: "0" };

/** pi-loops in the background with one project that has a rule, and a runner that answers `text`. */
async function scene(over: { budget?: number; runner?: (req: any) => Promise<any> } = {}) {
	const dir = tmp("pi-loops-check-lanes-");
	const project = path.join(dir, "project");
	fs.mkdirSync(project, { recursive: true });
	if (over.budget !== undefined) fs.writeFileSync(path.join(dir, "config.toml"), `[limits]\ndaily_budget_usd = ${over.budget}\n`);
	const calls: any[] = [];
	const logs: string[] = [];
	const runner = over.runner ?? (async (req: any) => {
		calls.push(req);
		return { ok: true, exitCode: 0, timedOut: false, text: "nothing matched", usage: USAGE };
	});
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner, mcpTools: () => [], log: (line) => void logs.push(line) });
	const rule = await host.stores.rules.add({ condition: "a build fails", action: "say so", cwd: project });
	const events = new EventLog(dir, "background");
	const requests = new RequestStore(dir);
	const lane = checkLane(project)!;
	/** A push stored raw and derived into the project's check lane, as M8.3a-2 does at arrival. */
	const push = (key = "k1") => {
		const event = events.append("mcp:ci", JSON.stringify({ method: "ci/build", params: { _meta: { pi_dedup_key: key, pi_summary: "build red" } } }));
		const decision = writePush(requests, { event, key, policy: "drop", label: "ci / build", sourceLabel: "mcp:ci", project, earlier: [], done: () => false, createdBy: BY, now: Date.now() });
		assert.equal(decision.kind, "queued");
		return { event, rowId: pushRowId(event.id, project) };
	};
	/** The check lanes' rider alone: the periodic check of `rule-checks` would call the model too. */
	const tick = async () => {
		await host.riders["check-lanes"](Date.now(), { startedAt: 0, tickMs: 30_000 });
		await host.drain(5000);
	};
	const audit = (traceId: string) => host.stores.rules.listAudit(50, (r) => r.traceId === traceId).map((r) => r.state);
	return { dir, project, host, rule, events, requests, lane, push, tick, calls, logs, audit };
}

test("[check-lanes-run] the background runs a check lane's push row once with runCheck: one record, the row gone", async () => {
	const s = await scene();
	const { rowId } = s.push();
	await s.tick();
	assert.equal(s.calls.length, 1, "one check");
	assert.match(s.calls[0].prompt, /a build fails/, "the project's rule is evaluated");
	const records = s.host.stores.jobs.allRuns().filter((r) => r.runId === rowId);
	assert.equal(records.length, 1);
	assert.deepEqual([records[0].jobId, records[0].cause, records[0].row, records[0].ok], [s.lane, "push", rowId, true]);
	assert.deepEqual(s.requests.list(s.lane), [], "the row left its lane");
	await s.tick();
	assert.equal(s.calls.length, 1, "never twice");
});

test("a proposed rule is never checked by a push: a project whose only rule is proposed runs no model", async () => {
	const s = await scene();
	await s.host.stores.rules.update(s.rule.id, (r) => {
		r.enabled = false;
		r.proposed = { at: new Date().toISOString(), session: "s" };
	});
	const { rowId } = s.push();
	await s.tick();
	assert.equal(s.calls.length, 0, "no sub-agent was asked");
	assert.equal(s.host.stores.rules.load()[0].enabled, false);
	assert.deepEqual(s.requests.list(s.lane), [], "the row left its lane: nothing to evaluate is no failure to retry");
	assert.ok(s.audit(rowId).includes("no_rules"), JSON.stringify(s.audit(rowId)));
	assert.equal(s.host.stores.jobs.allRuns().some((r) => r.runId === rowId), false, "no run, so no record");
});

test("[check-lanes-dead] a push row whose stored event is gone leaves the lane dead, with no model call", async () => {
	const s = await scene();
	const { rowId } = s.push();
	fs.rmSync(path.join(s.dir, "events.jsonl"));
	await s.tick();
	assert.equal(s.calls.length, 0);
	assert.deepEqual(s.requests.list(s.lane), []);
	assert.ok(s.audit(rowId).includes("dead"), JSON.stringify(s.audit(rowId)));
});

test("[check-lanes-budget] over today's budget a push row leaves with budget_exceeded and no run", async () => {
	const s = await scene({ budget: 0.001 });
	s.host.stores.jobs.appendRun({ runId: "spent", jobId: "x", stateful: true, cwd: s.dir, pid: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ok: true, findings: 0, droppedFindings: 0, stateUpdated: false, usage: { ...USAGE, cost: 1 } });
	const { rowId } = s.push();
	await s.tick();
	assert.equal(s.calls.length, 0);
	assert.deepEqual(s.requests.list(s.lane), []);
	assert.ok(s.audit(rowId).includes("budget_exceeded"), JSON.stringify(s.audit(rowId)));
});

test("[check-lanes-one-at-a-time] a second push row of the lane waits while the first one's check runs", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const calls: any[] = [];
	const s = await scene({ runner: async (req) => { calls.push(req); await gate; return { ok: true, exitCode: 0, timedOut: false, text: "nothing matched", usage: USAGE }; } });
	s.push("k1");
	s.push("k2");
	const facts = { startedAt: 0, tickMs: 30_000 };
	await s.host.riders["check-lanes"](Date.now(), facts);
	await s.host.riders["check-lanes"](Date.now(), facts);
	assert.equal(calls.length, 1, "the second waits for the first");
	assert.equal(s.requests.list(s.lane).filter((r) => !r.run).length, 1);
	release();
	await s.host.drain(5000);
	await s.tick();
	assert.equal(calls.length, 2, "then it runs");
	assert.deepEqual(s.requests.list(s.lane), []);
});

test("[check-lanes-removed-jobs] the removed-jobs rider leaves a check lane's run alone", () => {
	const ctrl = new AbortController();
	const fake = { runId: "evt-1", jobId: checkLane("/tmp/some-project")!, label: "the check of some-project", promptPreview: "", ctrl, startedAt: new Date().toISOString() };
	const listed = { all: () => [fake] } as any;
	assert.equal(abortRemovedJobs(listed, () => false, () => undefined), 0);
	assert.equal(ctrl.signal.aborted, false);
});

test("[check-lanes-interrupted] a push row claimed by a process that died is closed with an interrupted record under its lane, and waits its backoff to run again", async () => {
	const s = await scene();
	const { rowId } = s.push();
	const [row] = s.requests.list(s.lane);
	s.requests.claim(s.lane, row.id, { id: rowId, pid: 999_999_999, procStart: "gone", started_at: new Date(Date.now() - 60_000).toISOString() } as any);
	await s.tick();
	const interrupted = s.host.stores.jobs.allRuns().find((r) => r.runId === rowId && r.interrupted);
	assert.equal(interrupted?.jobId, s.lane, "the project's failure streak counts it");
	const [again] = s.requests.list(s.lane);
	assert.equal(again?.id, rowId, "the push is not lost");
	assert.deepEqual([again.run, again.attempts, again.not_before !== undefined], [undefined, 1, true], "unclaimed, one attempt, waiting its backoff");
	assert.equal(s.calls.length, 0, "not before its backoff");
});

