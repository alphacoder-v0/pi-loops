// The end of a loop's run, held to what main does at the end of one: the slot runs once whatever the
// closing cannot read, the transcripts are pruned, and a crash is retried at once and parks quietly.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../src/config.ts";
import { createHostRuntime } from "../src/host-runtime.ts";
import { RUNTIME_RIDERS } from "../src/ticker.ts";
import { loopLane } from "../src/lane.ts";
import { plainJobRow, plainRunId } from "../src/engine.ts";
import { listedJobs } from "../src/job-status.ts";
import { tmp } from "./tmp.ts";

const USAGE = { input: 1, output: 1, cost: 0, turns: 1 };
const ID = "cron-0123456789abcdef0123456789abcdef";
const OK = { ok: true, exitCode: 0, timedOut: false, text: "<loop-state>seen</loop-state>done", usage: USAGE };
type Host = ReturnType<typeof createHostRuntime>;

function start(dir: string, runner: (req: any) => Promise<unknown>, logs: string[] = []): Host {
	return createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: runner as any, mcpTools: () => [], log: (line) => void logs.push(line) });
}
async function tick(host: Host, now: number, logs: string[] = []): Promise<void> {
	for (const name of RUNTIME_RIDERS) {
		try { await host.riders[name](now, { startedAt: 0, tickMs: 30_000 }); }
		catch (error) { logs.push(`tick: ${name} failed: ${(error as Error).message}`); }
	}
	await host.drain(2000);
}
const loop = (dir: string, t0: number, ms: number, extra: Record<string, unknown> = {}) => ({ id: ID, schedule: { kind: "every", ms }, stateful: true, prompt: "look", cwd: dir, enabled: true, catchUp: true, createdAt: new Date(t0 - ms - 30_000).toISOString(), runCount: 0, skippedOverlap: 0, ...extra });
/** The process running a claim has exited: its pid is one that has. */
function orphan(host: Host): void {
	const lane = loopLane(ID)!;
	const dead = spawnSync("true").pid!;
	for (const row of host.stores.requests.list(lane)) if (row.run) host.stores.requests.update(lane, row.id, { run: { ...row.run, pid: dead } } as any);
}

test("a run log that cannot be read as a loop's run ends costs no slot and runs none twice: the next slots run, and a restart does not run the first again", async () => {
	const dir = tmp();
	const runsFile = path.join(dir, "runs.jsonl");
	const calls: string[] = [];
	const logs: string[] = [];
	let host: Host;
	const runner = async (req: any) => {
		calls.push(req.runId);
		if (calls.length === 1) {
			host.stores.jobs.appendRun({ runId: "run-other", jobId: "goal", stateful: false, cwd: dir, pid: process.pid, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ok: true, findings: 0, droppedFindings: 0, stateUpdated: false } as any);
			fs.chmodSync(runsFile, 0o000);
		}
		return OK;
	};
	host = start(dir, runner, logs);
	const t0 = Date.now();
	await host.stores.jobs.add(loop(dir, t0, 60_000) as any);
	try {
		await tick(host, t0, logs);
		assert.equal(calls.length, 1);
		fs.chmodSync(runsFile, 0o644);
		for (let minute = 1; minute <= 5; minute++) await tick(host, t0 + minute * 60_000, logs);
		assert.equal(calls.length, 6, "one run for each of the next five slots");
	} finally { fs.chmodSync(runsFile, 0o644); await host.stop(); }
	orphan(host);
	const again = start(dir, runner, logs);
	try {
		await tick(again, t0 + 6 * 60_000 - 10_000, logs);
		assert.equal(calls.filter((id) => id === calls[0]).length, 1, "the first slot's prompt is sent once");
	} finally { await again.stop(); }
});

test("a loop keeps its 20 newest transcripts, as docs/configuration.md says and main prunes them", async () => {
	const dir = tmp();
	let n = 0;
	const host = start(dir, async (req: any) => {
		fs.mkdirSync(req.sessionDir, { recursive: true });
		const file = path.join(req.sessionDir, `${String(++n).padStart(3, "0")}.jsonl`);
		fs.writeFileSync(file, "{}\n");
		fs.utimesSync(file, n, n);
		return { ...OK, sessionFile: file };
	});
	const t0 = Date.now();
	await host.stores.jobs.add(loop(dir, t0, 60_000) as any);
	try {
		for (let minute = 0; minute < 25; minute++) await tick(host, t0 + minute * 60_000);
		assert.equal(n, 25);
		assert.equal(fs.readdirSync(host.stores.jobs.sessionDirFor(ID)).filter((f) => f.endsWith(".jsonl")).length, 20);
	} finally { await host.stop(); }
});

test("a loop's run that its process took down runs again at the next tick, with no wait, and the slot that came due beside it counts no skipped overlap", async () => {
	const dir = tmp();
	const calls: string[] = [];
	let hold: (() => void) | undefined;
	const runner = async (req: any) => { calls.push(req.runId); if (calls.length === 1) await new Promise<void>((resolve) => { hold = resolve; }); return OK; };
	const first = start(dir, runner);
	const t0 = Date.now();
	await first.stores.jobs.add(loop(dir, t0, 600_000) as any);
	await tick(first, t0);
	assert.equal(calls.length, 1);
	orphan(first);
	const second = start(dir, runner);
	try {
		await tick(second, t0 + 600_000);
		await tick(second, t0 + 630_000);
		assert.equal(calls.length, 2, "the interrupted slot runs again at once");
		assert.equal(second.stores.jobs.load().find((j) => j.id === ID)?.skippedOverlap ?? 0, 0);
	} finally { hold?.(); await second.stop(); }
});

test("a loop parked after its third interrupted run files nothing in the inbox, and says so in the log, as main", async () => {
	const dir = tmp();
	const logs: string[] = [];
	const host = start(dir, async () => OK, logs);
	const t0 = Date.now();
	const job = loop(dir, t0, 3_600_000, { createdAt: new Date(t0 - 600_000).toISOString(), lastDueAt: new Date(t0 - 300_000).toISOString() }) as any;
	await host.stores.jobs.add(job);
	const lane = loopLane(ID)!;
	const slot = new Date(t0 - 300_000).toISOString();
	const base = plainJobRow(job, plainRunId(ID, slot), `cron:${ID}`, "", { pid: process.pid, instance: "x", version: "0" } as any, t0 - 300_000);
	host.stores.requests.appendIfAbsent({ ...base, lane, attempts: 2, payload: { ...base.payload!, slot } } as any);
	host.stores.requests.update(lane, base.id, { run: { id: base.id, pid: spawnSync("true").pid!, started_at: new Date(t0 - 200_000).toISOString() } } as any);
	try {
		await tick(host, t0);
		assert.equal(host.stores.jobs.load().find((j) => j.id === ID)?.enabled, false, "parked");
		assert.deepEqual(host.stores.inbox.list(), []);
		assert.ok(logs.some((line) => line.includes("parked after 3 interrupted runs")), logs.join("\n"));
	} finally { await host.stop(); }
});

test("a loop's run has its job's time limit, not one that a row in its lane names: a row can be written by hand", async () => {
	const dir = tmp();
	const limits: number[] = [];
	const host = start(dir, async (req: any) => (limits.push(req.timeoutMs), OK));
	const t0 = Date.now();
	const job = loop(dir, t0, 3_600_000, { timeoutMs: 60_000, createdAt: new Date(t0 - 600_000).toISOString(), lastDueAt: new Date(t0 - 300_000).toISOString() }) as any;
	await host.stores.jobs.add(job);
	const slot = new Date(t0 - 300_000).toISOString();
	const base = plainJobRow(job, plainRunId(ID, slot), `cron:${ID}`, "", { pid: process.pid, instance: "x", version: "0" } as any, t0 - 300_000);
	host.stores.requests.appendIfAbsent({ ...base, lane: loopLane(ID)!, payload: { ...base.payload!, slot, timeout_ms: 86_400_000 } } as any);
	try {
		await tick(host, t0);
		assert.deepEqual(limits, [60_000]);
	} finally { await host.stop(); }
});

test("[waiting-written] The background writes why a loop's row waits on the row, for the lists: the slots, then the start clears it", async () => {
	const dir = tmp();
	fs.writeFileSync(path.join(dir, "config.toml"), "[cron]\nmax_concurrent_runs = 1\n");
	let release: (() => void) | undefined;
	const host = start(dir, async () => { await new Promise<void>((resolve) => { release = resolve; }); return OK; });
	const t0 = Date.now();
	const other = "cron-fedcba9876543210fedcba9876543210";
	await host.stores.jobs.add(loop(dir, t0, 600_000) as any);
	await host.stores.jobs.add({ ...loop(dir, t0, 600_000), id: other } as any);
	try {
		await tick(host, t0);
		const rows = [loopLane(ID)!, loopLane(other)!].flatMap((lane) => host.stores.requests.list(lane));
		const waiting = rows.filter((row) => !row.run);
		assert.equal(rows.filter((row) => row.run).length, 1, "one runs");
		assert.deepEqual(waiting.map((row) => row.waiting), ["deferred: 1 sub-agent(s) already in flight (max 1)"]);
		release?.();
		await host.drain(2000);
		await tick(host, t0 + 1000);
		const after = [loopLane(ID)!, loopLane(other)!].flatMap((lane) => host.stores.requests.list(lane));
		assert.deepEqual(after.filter((row) => !row.run).map((row) => row.waiting), [], "the second started, and no row waits");
	} finally { release?.(); await host.stop(); }
});

test("[waiting-backoff] A row in its failure's backoff is not 'deferred' by the slots: main's backoff came first and kept the failure as the reason", async () => {
	const dir = tmp();
	fs.writeFileSync(path.join(dir, "config.toml"), "[cron]\nmax_concurrent_runs = 1\n");
	let release: (() => void) | undefined;
	const host = start(dir, async () => { await new Promise<void>((resolve) => { release = resolve; }); return OK; });
	const t0 = Date.now();
	const other = "cron-fedcba9876543210fedcba9876543210";
	await host.stores.jobs.add(loop(dir, t0, 600_000) as any);
	await host.stores.jobs.add({ ...loop(dir, t0, 600_000), id: other } as any);
	try {
		await tick(host, t0);
		const lanes = [loopLane(ID)!, loopLane(other)!];
		const waiting = lanes.flatMap((lane) => host.stores.requests.list(lane).filter((row) => !row.run).map((row) => ({ lane, row })))[0];
		assert.equal(waiting?.row.waiting, "deferred: 1 sub-agent(s) already in flight (max 1)");
		host.stores.requests.update(waiting.lane, waiting.row.id, { not_before: new Date(t0 + 3_600_000).toISOString() });
		await tick(host, t0 + 1000);
		assert.equal(host.stores.requests.list(waiting.lane).find((row) => row.id === waiting.row.id)?.waiting, undefined);
	} finally { release?.(); await host.stop(); }
});

test("[run-now-spends-waiting] /cron run of an every loop whose slot waits for a free slot spends that slot, as main moved the last fire: it runs once, and the lists name no wait", async () => {
	const dir = tmp();
	fs.writeFileSync(path.join(dir, "config.toml"), "[cron]\nmax_concurrent_runs = 1\n");
	const calls: string[] = [];
	let release: (() => void) | undefined;
	const host = start(dir, async (req: any) => { calls.push(req.runId); if (calls.length === 1) await new Promise<void>((resolve) => { release = resolve; }); return OK; });
	const t0 = Date.now();
	const holder = "cron-fedcba9876543210fedcba9876543210";
	await host.stores.jobs.add({ ...loop(dir, t0, 600_000), id: holder } as any);
	try {
		await tick(host, t0);
		await host.stores.jobs.add(loop(dir, t0, 600_000) as any);
		await tick(host, t0 + 1000);
		assert.equal(host.stores.requests.list(loopLane(ID)!).filter((row) => !row.run)[0]?.waiting, "deferred: 1 sub-agent(s) already in flight (max 1)");
		assert.equal(await host.loops.runNow(ID), true);
		await host.drain(2000);
		release?.();
		await host.drain(2000);
		await tick(host, t0 + 2000);
		await tick(host, t0 + 3000);
		assert.equal(calls.length, 2, "the holder once, this loop once by /cron run");
		assert.deepEqual(host.stores.requests.list(loopLane(ID)!), [], "no row of this loop waits");
		assert.equal(listedJobs(host.stores).find((job) => job.id === ID)?.lastError, undefined);
	} finally { release?.(); await host.stop(); }
});
