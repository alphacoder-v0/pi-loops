import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { loadConfig } from "../src/config.ts";
import { EventLog, type RawEvent } from "../src/events.ts";
import { createHostRuntime } from "../src/host-runtime.ts";
import { checkLane } from "../src/lane.ts";
import { pushRowId, writePush } from "../src/push.ts";
import { RequestStore } from "../src/requests.ts";

const USAGE = { input: 1, output: 1, cost: 0.01, turns: 1 };
const BY = { pid: process.pid, instance: "test", version: "0" };
const GONE = { pid: 999_999_999, procStart: "gone" };
const FACTS = { startedAt: 0, tickMs: 30_000 };

/** One pi-loops process in the background over `dir`, with a runner that answers every check and counts it. */
function runtime(dir: string) {
	const calls: unknown[] = [];
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: async (req: unknown) => { calls.push(req); return { ok: true, exitCode: 0, timedOut: false, text: "nothing matched", usage: USAGE }; }, mcpTools: () => [], log: () => undefined });
	return { host, calls };
}

/**
 * A loops directory with one project that has one enabled rule, and one push from `ci` stored raw.
 * `first` is the process that will crash: the scene writes what it left on disk through the stores.
 */
async function crashed() {
	const dir = tmp("pi-loops-push-crash-");
	const project = path.join(dir, "project");
	fs.mkdirSync(project, { recursive: true });
	const first = runtime(dir);
	await first.host.stores.rules.add({ condition: "a build fails", action: "say so", cwd: project });
	const requests = new RequestStore(dir);
	const lane = checkLane(project)!;
	const event = new EventLog(dir, "background").append("mcp:ci", JSON.stringify({ method: "ci/build", params: { _meta: { pi_dedup_key: "k1", pi_summary: "build red" } } }));
	const rowId = pushRowId(event.id, project);
	const writeRow = (stored: RawEvent) => {
		const decision = writePush(requests, { event: stored, key: "k1", policy: "drop", label: "ci / build", sourceLabel: "mcp:ci", project, earlier: [], done: () => false, createdBy: BY, now: Date.now() });
		assert.equal(decision.kind, "queued");
	};
	return { dir, project, first, requests, lane, event, rowId, writeRow };
}

type Crashed = Awaited<ReturnType<typeof crashed>>;

/** The restart: a new process over the same directory writes the rows of stored pushes again, as host.ts does at start. */
function restart(s: Crashed) {
	const next = runtime(s.dir);
	next.host.rederivePushes((server) => server === "ci");
	return next;
}

/** The check lanes' rider and the drain, again until the lane, the run log and the runner stop changing. */
async function settle(s: Crashed, next: ReturnType<typeof runtime>) {
	const seen = () => JSON.stringify([s.requests.list(s.lane), next.host.stores.jobs.allRuns().length, next.calls.length]);
	for (let i = 0; i < 20; i++) {
		const before = seen();
		await next.host.riders["check-lanes"](Date.now(), FACTS);
		await next.host.drain(5000);
		if (seen() === before) return;
	}
	assert.fail(`the lane did not settle: ${seen()}`);
}

/** What every scene ends with: no row, one ok record for the push, one record per run. */
function noneLost(s: Crashed, next: ReturnType<typeof runtime>, calls: number) {
	assert.deepEqual(s.requests.list(s.lane), [], "the lane has no row");
	const records = next.host.stores.jobs.allRuns().filter((r) => r.runId === s.rowId);
	assert.equal(records.filter((r) => r.ok).length, 1, `one ok record for the push: ${JSON.stringify(records)}`);
	const runs = records.map((r) => `${r.runId} ${r.startedAt}`);
	assert.equal(new Set(runs).size, runs.length, `no run has two records: ${JSON.stringify(runs)}`);
	assert.equal(next.calls.length, calls, "the runner after the restart");
}

test("[push-crash-none-lost] a crash after the push is stored and before its row: the restart writes the row, and it runs once", async () => {
	const s = await crashed();
	assert.deepEqual(s.requests.list(s.lane), []);
	const next = restart(s);
	assert.deepEqual(s.requests.list(s.lane).map((r) => r.id), [s.rowId], "the row is written at start");
	await settle(s, next);
	noneLost(s, next, 1);
});

test("[push-crash-none-lost] a crash after the row is written and before a claim: it runs once", async () => {
	const s = await crashed();
	s.writeRow(s.event);
	const next = restart(s);
	assert.deepEqual(s.requests.list(s.lane).map((r) => r.id), [s.rowId], "the row there is left as it is");
	await settle(s, next);
	noneLost(s, next, 1);
});

test("[push-crash-none-lost] a crash after the claim and before a record: the row closes interrupted, waits its backoff, then runs once", async () => {
	const s = await crashed();
	s.writeRow(s.event);
	const started = new Date(Date.now() - 60_000).toISOString();
	assert.ok(s.requests.claim(s.lane, s.rowId, { id: s.rowId, ...GONE, started_at: started } as any));
	const next = restart(s);
	await settle(s, next);
	const interrupted = next.host.stores.jobs.allRuns().filter((r) => r.runId === s.rowId);
	assert.deepEqual(interrupted.map((r) => [r.jobId, r.startedAt, r.ok, r.interrupted]), [[s.lane, started, false, true]], "one interrupted record under the lane");
	const [waiting] = s.requests.list(s.lane);
	assert.deepEqual([waiting?.id, waiting?.run, waiting?.attempts, waiting?.not_before !== undefined], [s.rowId, undefined, 1, true], "the push waits its backoff");
	assert.equal(next.calls.length, 0, "not before its backoff");
	assert.ok(s.requests.update(s.lane, s.rowId, { not_before: new Date(Date.now() - 1000).toISOString() }));
	await settle(s, next);
	noneLost(s, next, 1);
});

test("[push-crash-none-lost] a crash after the run's ok record and before the row is removed: the row leaves with no second run", async () => {
	const s = await crashed();
	s.writeRow(s.event);
	const started = new Date(Date.now() - 60_000).toISOString();
	assert.ok(s.requests.claim(s.lane, s.rowId, { id: s.rowId, ...GONE, started_at: started } as any));
	s.first.host.stores.jobs.appendRun({ runId: s.rowId, jobId: s.lane, cause: "push", row: s.rowId, stateful: false, cwd: s.project, pid: GONE.pid, startedAt: started, finishedAt: new Date(Date.now() - 30_000).toISOString(), ok: true, findings: 0, droppedFindings: 0, stateUpdated: false, usage: USAGE });
	const next = restart(s);
	await settle(s, next);
	noneLost(s, next, 0);
	assert.equal(next.host.stores.jobs.allRuns().filter((r) => r.runId === s.rowId).length, 1, "no interrupted record beside the ok one");
});

test("[push-crash-none-lost] a crash after the row was closed: the restart writes no row and nothing runs", async () => {
	const s = await crashed();
	s.writeRow(s.event);
	await s.first.host.riders["check-lanes"](Date.now(), FACTS);
	await s.first.host.drain(5000);
	assert.equal(s.first.calls.length, 1, "the first process ran it");
	assert.deepEqual(s.requests.list(s.lane), [], "and closed its row");
	const next = restart(s);
	assert.deepEqual(s.requests.list(s.lane), [], "a row proved done is not written again");
	await settle(s, next);
	noneLost(s, next, 0);
});
