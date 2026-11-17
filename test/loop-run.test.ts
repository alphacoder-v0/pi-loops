import assert from "node:assert/strict";
import { test } from "node:test";
import { openStores } from "../src/stores.ts";
import { closeLoopRun, closeSteps, ensureRecord, runLoop, stoppedTogether, aloneIn } from "../src/loop-run.ts";
import type { LoopRunDeps, ProcessStop, RunRecordM4b } from "../src/loop-run.ts";
import { type EngineSinks } from "../src/engine.ts";
import { RequestStore, type ClaimedRow, type UnclaimedRow } from "../src/requests.ts";
import { RunList } from "../src/run-list.ts";
import { stamp } from "../src/schedule.ts";
import { type LoopJob, type LoopJobV3 } from "../src/store.ts";
import { tmp } from "./tmp.ts";
import { fakeRunner } from "./fake-runner.ts";

const now = Date.now();
const makeJob = (over: Partial<LoopJob> = {}): LoopJob => ({
	id: "cron-0123456789abcdef0123456789abcdef",
	schedule: { kind: "every", ms: 60_000 },
	stateful: true,
	prompt: "check changes",
	cwd: process.cwd(),
	enabled: true,
	catchUp: true,
	createdAt: stamp(now - 120_000),
	runCount: 0,
	skippedOverlap: 0,
	...over,
});

function setup() {
	const dir = tmp("pi-loops-loop-run-");
	const stores = openStores(dir);
	const runs = new RunList();
	const finished: RunRecordM4b[] = [];
	const logs: string[] = [];
	const createdBy = { pid: process.pid, instance: "test", version: "test" };
	const engine: EngineSinks = {
		jobs: { exists: (id) => stores.jobs.load().some((job) => job.id === id), enabled: (id) => stores.jobs.load().find((job) => job.id === id)?.enabled ?? false, goalActive: () => false },
		inbox: stores.inbox,
		audit: stores.rules,
		ledger: stores.jobs,
		self: () => createdBy,
	};
	const deps: LoopRunDeps = {
		stores, runs, runner: fakeRunner(), session: () => ({ sessionId: "s1", cwd: process.cwd(), model: "fake/model" }), hop: 0,
		holder: () => ({ pid: process.pid, procStart: "self" }), engine: () => engine,
		sinks: { started: () => undefined, finished: (record) => finished.push(record), filed: () => undefined, log: (line) => logs.push(line) },
		now: () => now,
	};
	return { dir, stores, runs, deps, finished, logs, createdBy };
}

function rowFor(dir: string, createdBy: ClaimedRow["created_by"], at = stamp(now), pid = process.pid, procStart: string | undefined = "self"): ClaimedRow {
	const id = "run-00000000000000000000000000000001";
	const row: UnclaimedRow = {
		v: 3, id, lane: "@cron-0123456789abcdef0123456789abcdef", kind: "input", source: "cron:cron-0123456789abcdef0123456789abcdef", mode: "unattended", wake: "turn",
		payload: { text: "check changes", cwd: process.cwd() }, created_at: at, created_by: createdBy, attempts: 0,
	};
	const requests = new RequestStore(dir);
	requests.append(row);
	return new RunList().claim(requests, row, { pid, procStart },  { jobId: "cron-0123456789abcdef0123456789abcdef", label: "check", promptPreview: "check", ctrl: new AbortController() }, Date.parse(at)) as ClaimedRow;
}

function interruptedRecord(row: ClaimedRow, stop?: ProcessStop): RunRecordM4b {
	return { runId: row.run.id, row: row.id, jobId: row.source.startsWith("cron-run:") ? row.source.slice("cron-run:".length) : row.source.slice("cron:".length), stateful: true, cwd: process.cwd(), pid: row.run.pid, startedAt: row.run.started_at, finishedAt: stamp(now), ok: false, error: "the process running it stopped", findings: 0, droppedFindings: 0, stateUpdated: false, interrupted: true, ...(stop ? { stop } : {}) };
}

test("[loop-R2] started runs after the claim is on disk and before the runner", async () => {
	const f = setup();
	const job = await f.stores.jobs.add(makeJob());
	const row = rowFor(f.dir, f.createdBy);
	f.runs.add({ runId: row.id, jobId: job.id, label: job.id, startedAt: row.run.started_at, promptPreview: "check", ctrl: new AbortController() });
	let called = false;
	f.deps.runner = async (request) => {
		called = true;
		assert.equal(f.stores.requests.list(row.lane)[0].run?.id, row.id);
		assert.equal(request.kind, "loop");
		assert.equal(request.prompt.startsWith("[Trigger"), false, "the row's proof prefix is not the prompt a loop's model reads");
		return { ok: true, exitCode: 0, timedOut: false, text: "ok", usage: { input: 1, output: 1, cost: 0, turns: 1 } };
	};
	f.deps.sinks.started = (_job, claimed) => {
		assert.equal(f.stores.requests.list(claimed.lane)[0].run?.id, claimed.id);
		assert.equal(called, false);
	};
	await runLoop(row, job as LoopJobV3, f.deps);
	assert.equal(called, true);
	assert.equal(f.runs.get(row.id), undefined);
});

test("[loop-R3] close plan writes the record, clock and row in order and repeats safely", async () => {
	const f = setup();
	const job = await f.stores.jobs.add(makeJob());
	const row = rowFor(f.dir, { ...f.createdBy, pid: 99999999, procStart: "dead" });
	const claim = { ...row, run: { ...row.run, pid: 99999999, procStart: "dead" } };
	const ended: RunRecordM4b = { ...interruptedRecord(claim), ok: true, error: undefined, interrupted: undefined, ordinal: 1 };
	const history = { ordinal: 1, streak: 0, spent: new Set<string>([ended.runId]) };
	const plan = closeSteps({ row: claim, job: job as LoopJobV3, record: ended, history, self: f.createdBy, now });
	assert.deepEqual(plan.map((step) => step.write), ["run-end", "clock", "row"]);
	const first = await closeLoopRun(claim, f.deps, now, ended);
	const second = await closeLoopRun(claim, f.deps, now, ended);
	assert.equal(first.outcome, "removed");
	assert.equal(second.outcome, "removed");
	assert.equal(f.stores.jobs.listRuns(job.id).filter((record) => record.runId === row.id).length, 1);
	assert.deepEqual(f.stores.requests.list(row.lane), []);
});

test("[loop-R4] a person's stop spends the slot; a hand-back leaves it owed", () => {
	const f = setup();
	const job = makeJob();
	const row = rowFor(f.dir, f.createdBy);
	const stopped = { ...interruptedRecord(row), aborted: true as const, stoppedBy: "person" as const, interrupted: undefined, error: "stopped by a person" };
	const history = { ordinal: 0, streak: 0, spent: new Set<string>() };
	assert.deepEqual(closeSteps({ row, job: job as LoopJobV3, record: stopped, history, self: f.createdBy, now }).at(-1), { write: "row", fate: { do: "leave", exit: "stopped" } });
	const handedBack = { ...stopped, stoppedBy: undefined, stop: undefined, aborted: true as const };
	assert.deepEqual(closeSteps({ row, job: job as LoopJobV3, record: handedBack, history, self: f.createdBy, now }).at(-1), { write: "row", fate: { do: "owed" } });
});

test("[loop-R5] interrupted claims share a stop record; the live process has no stop", async () => {
	const f = setup();
	const job = await f.stores.jobs.add(makeJob());
	const first = rowFor(f.dir, { pid: 99999999, instance: "dead", procStart: "dead", version: "test" }, stamp(now), 99999999, "dead");
	const secondId = "run-00000000000000000000000000000002";
	const requests = new RequestStore(f.dir);
	requests.append({ ...first, id: secondId, run: undefined });
	const second = new RunList().claim(requests, { ...first, id: secondId, run: undefined }, { pid: first.run.pid, procStart: first.run.procStart }, { jobId: "cron-0123456789abcdef0123456789abcdef", label: "check", promptPreview: "check", ctrl: new AbortController() }, now)!;
	const stop = stoppedTogether(first.run, [first, second], []);
	assert.deepEqual(stop.runs, [first.id, second.id].sort());
	assert.equal(aloneIn(interruptedRecord(first, stop)), false);
	const deadDeps = { stores: f.stores, holder: () => ({ pid: process.pid, procStart: "self" }) };
	const record = ensureRecord(first, deadDeps, now);
	assert.deepEqual(record.stop?.runs, stop.runs);
	const ownRow = { ...first, id: "run-own", run: { ...first.run, id: "run-own", pid: process.pid, procStart: "self" } };
	const own = ensureRecord(ownRow, deadDeps, now);
	assert.equal(own.stop, undefined);
	assert.equal(aloneIn(own), true);
	void job;
});

test("[loop-R6] the third alone interruption disables before dead-lettering and removing the row", async () => {
	const f = setup();
	const job = await f.stores.jobs.add(makeJob());
	const claimed = rowFor(f.dir, { pid: 99999999, instance: "dead", procStart: "dead", version: "test" });
	f.stores.requests.update(claimed.lane, claimed.id, { attempts: 2 });
	const row = { ...claimed, attempts: 2 };
	const stopped: ProcessStop = { pid: row.run.pid, procStart: row.run.procStart, runs: [row.id] };
	const record = interruptedRecord(row, stopped);
	const history = { ordinal: 0, streak: 0, spent: new Set<string>() };
	const plan = closeSteps({ row, job: job as LoopJobV3, record, history, self: f.createdBy, now });
	assert.deepEqual(plan.map((step) => step.write), ["run-end", "disable", "row"]);
	assert.equal(plan.at(-1)?.write, "row");
	const prior = [record, record].map((item, index) => ({ ...item, runId: `old-${index}`, finishedAt: stamp(now - 1000 + index), ordinal: index + 1 }));
	for (const item of prior) f.stores.jobs.appendRun(item);
	const outcome = await closeLoopRun(row, f.deps, now, record);
	assert.equal(outcome.outcome, "dead");
	assert.equal(f.stores.requests.list(row.lane).length, 0);
	assert.equal(f.stores.inbox.listNew().length, 1);
});

test("[kept-catch-up-note] a caught-up run tells the model it is catching up", async () => {
	const f = setup();
	const job = await f.stores.jobs.add(makeJob({ catchUp: true }));
	const row = rowFor(f.dir, f.createdBy);
	const claimed = { ...row, payload: { ...row.payload!, catch_up: true as const } };
	let prompt = "";
	f.deps.runner = async (request) => {
		prompt = request.prompt;
		return { ok: true, exitCode: 0, timedOut: false, text: "ok", usage: { input: 1, output: 1, cost: 0, turns: 1 } };
	};
	await runLoop(claimed, job as LoopJobV3, f.deps);
	assert.match(prompt, /\(catching up a missed tick\)/);
});

test("[kept-last-fired] a loop's fired stamp is its claim start, including cron-run rows", async () => {
	const f = setup();
	const job = await f.stores.jobs.add(makeJob());
	const startedAt = stamp(now - 5_000);
	const row = rowFor(f.dir, f.createdBy, startedAt);
	const claim = { ...row, source: "cron-run:cron-0123456789abcdef0123456789abcdef" as const };
	const record: RunRecordM4b = { ...interruptedRecord(claim), ok: true, error: undefined, interrupted: undefined, ordinal: 1 };
	await closeLoopRun(claim, f.deps, now, record);
	assert.equal(f.stores.book().clock.jobs[job.id].fired, startedAt);
	assert.equal(f.stores.jobs.load()[0].lastFiredAt, startedAt);
});
