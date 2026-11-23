/**
 * The answer lanes of pi-loops in the background (src/answer-lanes.ts): a person's yes to a finding
 * of a loop or a check runs once, in the run that asked, through the real `Answers`, stores and
 * `RunList` of `createHostRuntime`. The first two scenes run pi's real SDK against the stand-in
 * model of test/downstream/fake-model.mjs; the others script the runner.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { type AnswerExecutor, type Answerer } from "../src/answers.ts";
import { type Call, type ResolvedCap, WHY, answerRowId, besideId, inputHash, questionFinding, resolveCap } from "../src/ask.ts";
import { DEFAULT_RUN_TIMEOUT_MS, type RunRecordM4b } from "../src/loop-run.ts";
import { loadConfig } from "../src/config.ts";
import { plainJobRow, plainRunId, ruleResultRow } from "../src/engine.ts";
import { GuardSeats } from "../src/guard.ts";
import type { InboxEntry } from "../src/inbox.ts";
import { checkLane, parseLane } from "../src/lane.ts";
import { LeaseBinding, LeaseStore, procStart } from "../src/lease.ts";
import { createHostRuntime } from "../src/host-runtime.ts";
import { RunList } from "../src/run-list.ts";
import type { RunnerResult, SubagentRequest, SubagentRunner } from "../src/runner.ts";
import { stamp } from "../src/schedule.ts";
import { createInProcessRunner } from "../src/sdk-runner.ts";
import type { LoopJob, RunRecord } from "../src/store.ts";
import { openStores } from "../src/stores.ts";
import { RUNTIME_RIDERS } from "../src/ticker.ts";
import { checkSessionDir, triggerSessionKey } from "../src/check-run.ts";
import { buildPeriodicCheckTrigger } from "../src/triggers.ts";
import { withFileLock } from "../src/lock.ts";
import { tmp } from "./tmp.ts";

const FAKE_MODEL = path.join(path.dirname(new URL(import.meta.url).pathname), "downstream", "fake-model.mjs");
const JOB = "cron-0123456789abcdef0123456789abcdef";
const LANE = `@${JOB}`;
const PERSON: Answerer = { by: "terminal", session: "0f0e0d0c-0b0a-4908-8706-050403020100" };
/** The policy asks about `| eval`; the redirect leaves one line in the project for each time it runs. */
const CMD = "echo ran >> marker.txt | eval";
const USAGE = { input: 1, output: 1, cost: 0.01, turns: 1 };
const lines = (file: string): any[] => fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

/** pi-loops in the background over a fresh loops directory, with `runner`. `tick` runs every rider of one tick, in order, at `now`. */
function world(makeRunner: (inbox: ReturnType<typeof openStores>["inbox"]) => SubagentRunner, opts: { config?: string; isProjectTrusted?: (cwd: string) => boolean; sessionsRoot?: (dir: string) => string } = {}) {
	const dir = tmp("pi-loops-answer-lanes-");
	const cwd = path.join(dir, "proj");
	fs.mkdirSync(cwd, { recursive: true });
	if (opts.config) fs.writeFileSync(path.join(dir, "config.toml"), opts.config);
	const stores = openStores(dir);
	const logs: string[] = [];
	const host = createHostRuntime({ dir, stores, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: makeRunner(stores.inbox), mcpTools: () => [], log: (line) => void logs.push(line), ...(opts.isProjectTrusted ? { isProjectTrusted: opts.isProjectTrusted } : {}), ...(opts.sessionsRoot ? { sessionsRoot: opts.sessionsRoot(dir) } : {}) });
	const tick = async (now = Date.now()): Promise<void> => {
		for (const name of RUNTIME_RIDERS) await host.riders[name](now, { startedAt: 0, tickMs: 30_000 });
	};
	const find = (id: string): InboxEntry | undefined => stores.inbox.list().find((f) => f.id === id);
	const answerRecords = (): RunRecordM4b[] => stores.jobs.allRuns().filter((r) => r.cause === "answer");
	return { dir, cwd, stores, host, logs, tick, find, answerRecords };
}

/** A loop of the project whose slot is not due: it fired a moment ago, and fires again in an hour. */
const loopJob = (cwd: string, over: Partial<LoopJob> = {}): LoopJob => ({ id: JOB, schedule: { kind: "every", ms: 3_600_000 }, stateful: true, prompt: "PROMPT-ONE ship the release", cwd, enabled: true, catchUp: false, createdAt: stamp(Date.now()), runCount: 0, skippedOverlap: 0, ...over }) as LoopJob;

/** The real runner with the guard's seats over `inbox`, against the stand-in model, and an extension that asks again once the granted call ran. */
async function standIn(dir: string, inbox: Parameters<Parameters<typeof world>[0]>[0]) {
	const portFile = path.join(dir, "port");
	const modelLog = path.join(dir, "model.jsonl");
	const script = [
		{ match: "PROMPT-ONE", tool: "bash", args: { command: CMD } },
		{ match: "A person said yes to the call you asked about", tool: "bash", args: { command: CMD } },
		{ match: "PROMPT-AGAIN", tool: "bash", args: { command: CMD } },
	];
	const fake = spawn(process.execPath, [FAKE_MODEL, portFile], { env: { ...process.env, FAKE_MODEL_REPLY: "<inbox>the release is out</inbox>", FAKE_MODEL_LOG: modelLog, FAKE_MODEL_TOOL_SCRIPT: JSON.stringify(script) }, stdio: "ignore" });
	for (let i = 0; i < 200 && !(fs.existsSync(portFile) && fs.readFileSync(portFile, "utf8").trim()); i++) await new Promise((resolve) => setTimeout(resolve, 50));
	const agentDir = path.join(dir, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${fs.readFileSync(portFile, "utf8").trim()}/v1`, api: "openai-completions", apiKey: "fake", models: [{ id: "fake-model" }] } } }));
	const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
	const model = modelRuntime.getModel("fake", "fake-model");
	assert.ok(model, "the stand-in model is registered");
	// After a bash call that ran, the model is told once more to run it: the same call, in the same run.
	const again = path.join(dir, "again.ts");
	fs.writeFileSync(again, `export default function (pi: any) { let sent = false; pi.on("tool_result", (event: any) => { if (event.toolName === "bash" && !event.isError && !sent) { sent = true; pi.sendUserMessage("PROMPT-AGAIN run it once more", { deliverAs: "steer" }); } }); }\n`);
	const real = createInProcessRunner({
		agentDir,
		parentFlags: { extensionPaths: [again], skillPaths: [], promptTemplatePaths: [], appendSystemPrompt: [], noSkills: true, noExtensions: false, noContextFiles: true, noPromptTemplates: true },
		getParentModel: () => model,
		getParentModelRuntime: () => modelRuntime,
		getParentThinking: () => undefined,
		customTools: () => [],
		isTrusted: () => false,
		ownDir: tmp("pi-loops-own-"),
		guard: { seats: new GuardSeats(), deps: { inbox, allowCommands: () => [], now: Date.now } },
	});
	return { real, fake, modelLog };
}

/** The bash results of `file` after the message that holds `marker`, in order: whether each is an error, and its text. */
function bashResultsAfter(file: string, marker: string): Array<{ error: boolean; text: string }> {
	const messages = lines(file).filter((e) => e.type === "message").map((e) => e.message);
	const from = messages.findIndex((m) => m.role === "user" && JSON.stringify(m.content).includes(marker));
	assert.ok(from >= 0, `the transcript holds ${marker}`);
	return messages.slice(from).filter((m) => m.role === "toolResult" && m.toolName === "bash").map((m) => ({ error: m.isError === true, text: JSON.stringify(m.content) }));
}

test("[answer-loop] a yes to a loop's question resumes the run that asked: the granted call runs once, the same call after it is asked about, the record is the answer's, and the finding ends done", { timeout: 90_000 }, async () => {
	let model: Awaited<ReturnType<typeof standIn>> | undefined;
	const w = world(() => (req) => model!.real(req));
	model = await standIn(w.dir, w.stores.inbox);
	try {
		await w.stores.jobs.add(loopJob(w.cwd, { name: "release" }));
		assert.equal(await w.host.loops.runNow(JOB), true);
		await w.host.drain(30_000);
		const question = w.stores.inbox.list().find((f) => f.ask);
		assert.ok(question, "the loop's run asked about its call");
		assert.equal(question.ask!.lane, LANE);
		const file = question.transcript!;
		assert.equal(fs.existsSync(path.join(w.cwd, "marker.txt")), false, "nothing ran before the yes");

		const said = await w.host.answers.say(question.id, "yes", PERSON);
		assert.deepEqual([said.said, said.said === "Y1" && said.queued], ["Y1", true]);
		const rowId = answerRowId(question.id);
		await w.tick();
		await w.host.drain(30_000);

		assert.equal(fs.readFileSync(path.join(w.cwd, "marker.txt"), "utf8"), "ran\n", "the granted call ran once");
		const results = bashResultsAfter(file, `[Trigger ${rowId}] `);
		assert.deepEqual(results.map((r) => r.error), [false, true], "in the same transcript: the granted call, then the same call blocked");
		assert.match(results[1].text, /asked a person/, "the second identical call is asked about again");
		const [record] = w.answerRecords();
		assert.ok(record, "one record of the answer's run");
		assert.deepEqual(
			{ runId: record.runId, row: record.row, jobId: record.jobId, cause: record.cause, resumed: record.resumed, grant_used: record.grant_used, ordinal: record.ordinal, ok: record.ok, sessionFile: record.sessionFile, requestedBy: record.requestedBy },
			{ runId: rowId, row: rowId, jobId: JOB, cause: "answer", resumed: file, grant_used: true, ordinal: undefined, ok: true, sessionFile: file, requestedBy: { sessionId: PERSON.session } },
		);
		const answered = w.find(question.id)!;
		assert.equal(answered.answer?.state, "done");
		assert.equal(w.find(besideId(question.id, "outcome")), undefined, "done files no companion");
		const released = w.stores.inbox.list().filter((f) => f.text === "the release is out");
		assert.deepEqual(released.map((f) => [f.lane, f.transcript, f.run_id === rowId]), [[LANE, file, false]], "the run that asked filed its <inbox> finding in its lane; the resumed run's same words are a repeat of it and are not filed again");
		assert.deepEqual([record.findings, record.repeats], [0, 1]);
		assert.deepEqual(w.stores.requests.list(LANE), [], "the row is gone");
		assert.equal(w.host.runs.all().length, 0);
	} finally {
		await w.host.stop();
		model?.fake.kill();
	}
});

test("[answer-check] a yes to a check's question resumes the check's transcript in its project's check session directory", { timeout: 90_000 }, async () => {
	let model: Awaited<ReturnType<typeof standIn>> | undefined;
	const w = world(() => (req) => model!.real(req));
	model = await standIn(w.dir, w.stores.inbox);
	try {
		const lane = checkLane(w.cwd)!;
		const sessionDir = w.stores.jobs.sessionDirFor(triggerSessionKey(w.cwd));
		// What a rule check's request is (src/trigger-runtime.ts): its project's check lane and session directory.
		const asked = await model.real({ cwd: w.cwd, prompt: "PROMPT-ONE check the release", timeoutMs: 20_000, sessionDir, hop: 1, kind: "trigger", traceId: "trace-1", guard: { lane, origin: { source: "trigger:release-rule", run_id: "trace-1", cwd: w.cwd, who: "the check of proj" }, cap: resolveCap({ cwd: w.cwd }, 20_000) } });
		assert.equal(asked.ok, true, asked.errorMessage ?? "");
		const question = w.stores.inbox.list().find((f) => f.ask)!;
		assert.equal(question.ask!.lane, lane);
		const file = question.transcript!;
		assert.equal(path.dirname(file), sessionDir);

		assert.equal((await w.host.answers.say(question.id, "yes", PERSON)).said, "Y1");
		const rowId = answerRowId(question.id);
		await w.tick();
		await w.host.drain(30_000);

		assert.equal(fs.readFileSync(path.join(w.cwd, "marker.txt"), "utf8"), "ran\n", "the granted call ran once");
		assert.deepEqual(bashResultsAfter(file, `[Trigger ${rowId}] `).map((r) => r.error), [false, true]);
		const [record] = w.answerRecords();
		assert.deepEqual([record?.jobId, record?.resumed, record?.sessionFile, record?.grant_used, record?.stateful], [lane, file, file, true, false]);
		assert.equal(w.find(question.id)!.answer?.state, "done");
		assert.deepEqual(w.stores.requests.list(lane), []);
	} finally {
		await w.host.stop();
		model?.fake.kill();
	}
});

/** A runner that ends an answer's run when `release` is called or its signal aborts, and any other run at once. */
function scripted() {
	const calls: SubagentRequest[] = [];
	const waiting: Array<() => void> = [];
	const runner: SubagentRunner = (req) => {
		calls.push(req);
		const done: RunnerResult = { ok: true, exitCode: 0, timedOut: false, text: "<inbox>looked into it</inbox>", usage: USAGE };
		if (!req.prompt.includes("[Trigger ans-")) return Promise.resolve(done);
		return new Promise((resolve) => {
			const stop = () => resolve({ ok: false, exitCode: 1, timedOut: false, text: "", errorMessage: "aborted", stopReason: "aborted", usage: USAGE });
			if (req.signal?.aborted) return stop();
			req.signal?.addEventListener("abort", stop, { once: true });
			waiting.push(() => resolve(done));
		});
	};
	return { runner, calls, release: () => waiting.splice(0).forEach((end) => end()), answerCalls: () => calls.filter((req) => req.prompt.includes("[Trigger ans-")) };
}

/** A news finding of the loop, and a person's yes to it. */
async function yesTo(w: ReturnType<typeof world>, text: string): Promise<InboxEntry> {
	const finding = await w.stores.inbox.append({ source: "cron:release", text, run_id: `run-${text}`, job_id: JOB, cwd: w.cwd, kind: "news", lane: LANE });
	const said = await w.host.answers.say(finding.id, "yes", PERSON);
	assert.equal(said.said, "Y1");
	return finding;
}

/** A scheduled row of the loop, due now, as the clock writes it. */
function dueRow(w: ReturnType<typeof world>, at: number): string {
	const slot = stamp(at - 30_000);
	const row = plainJobRow(loopJob(w.cwd) as any, plainRunId(JOB, slot), `cron:${JOB}`, "", { pid: process.pid, instance: "test", version: "0" } as any, at - 30_000);
	w.stores.requests.appendIfAbsent({ ...row, lane: LANE, payload: { ...row.payload!, slot } } as any);
	return row.id;
}

test("[answer-overlap] a slot due beside an answer that starts in the same tick is skipped as an overlap on the ans- row", async () => {
	const s = scripted();
	const w = world(() => s.runner);
	try {
		await w.stores.jobs.add(loopJob(w.cwd));
		const finding = await yesTo(w, "the build is red");
		const now = Date.now();
		dueRow(w, now);
		await w.tick(now);
		const rows = w.stores.requests.list(LANE) as any[];
		assert.deepEqual(rows.map((r) => [r.id, !!r.run, r.collapsed, r.skipped]), [[answerRowId(finding.id), true, 1, 1]], "the slot is counted on the answer's row and spent");
		assert.deepEqual(s.calls.length, 1, "only the answer runs");
		assert.equal(w.stores.clock.read().jobs[JOB]?.collapsed, 1);
		s.release();
		await w.host.drain(5_000);
		assert.equal(w.find(finding.id)!.answer?.state, "done");
		assert.deepEqual(w.stores.requests.list(LANE), [], "the count leaves with the row");
	} finally {
		await w.host.stop();
	}
});

test("[answer-off] a yes to a loop that is off waits, with the answer lane's reason as the one writer of its row's waiting, and runs once the loop is on", async () => {
	const s = scripted();
	const w = world(() => s.runner);
	try {
		await w.stores.jobs.add(loopJob(w.cwd, { enabled: false }));
		const finding = await yesTo(w, "the build is red");
		const rowId = answerRowId(finding.id);
		await w.tick();
		const waitingOf = () => w.stores.requests.list(LANE).find((r) => r.id === rowId)?.waiting;
		assert.equal(waitingOf(), "its job is disabled", "the answer lane wrote why it waits, and the loop lane's gate pass left it");
		await w.host.loops.drain(parseLane(LANE) as any, Date.now());
		assert.equal(waitingOf(), "its job is disabled", "a loop lane's drain alone does not write it either");
		assert.equal(s.calls.length, 0);
		assert.equal(w.find(finding.id)!.answer?.state, "pending");

		await w.stores.jobs.enable(JOB);
		await w.tick();
		s.release();
		await w.host.drain(5_000);
		assert.equal(s.answerCalls().length, 1, "it runs once the loop is on");
		assert.equal(w.find(finding.id)!.answer?.state, "done");
		assert.deepEqual(w.stores.requests.list(LANE), []);
	} finally {
		await w.host.stop();
	}
});

test("[answer-repeat] a loop's resumed run files as its scheduled runs do: a finding that repeats an open one of the loop is not filed again, and the record counts it as a repeat", async () => {
	const s = scripted();
	const w = world(() => s.runner);
	try {
		await w.stores.jobs.add(loopJob(w.cwd));
		const open = await w.stores.inbox.append({ source: "cron:release", text: "looked into it", run_id: "run-earlier", job_id: JOB, cwd: w.cwd, kind: "news", lane: LANE });
		const finding = await yesTo(w, "the build is red");
		await w.tick();
		s.release();
		await w.host.drain(5_000);
		assert.equal(s.answerCalls().length, 1);
		assert.equal(w.find(finding.id)!.answer?.state, "done");
		assert.deepEqual(w.stores.inbox.list().filter((f) => f.text === "looked into it").map((f) => f.id), [open.id], "the open finding is the only one");
		const [record] = w.answerRecords();
		assert.deepEqual([record?.findings, record?.repeats], [0, 1]);
	} finally {
		await w.host.stop();
	}
});

test("[answer-removed] a removed loop: its running answer is stopped and closes unfinished; its queued answer leaves as E2", async () => {
	const s = scripted();
	const w = world(() => s.runner);
	try {
		await w.stores.jobs.add(loopJob(w.cwd));
		const running = await yesTo(w, "first");
		await w.tick();
		const queued = await yesTo(w, "second");
		await w.tick();
		assert.equal(s.answerCalls().length, 1, "one answer runs; the other waits for it");
		assert.equal(w.stores.requests.list(LANE).find((r) => r.id === answerRowId(queued.id))?.waiting, "another run of the loop is going");

		await w.stores.jobs.remove(JOB);
		await w.tick();
		await w.host.drain(5_000);
		const stopped = w.find(running.id)!;
		assert.deepEqual([stopped.answer?.state, stopped.answer?.state === "unfinished" && stopped.answer.why], ["unfinished", WHY.stopped]);
		assert.ok(w.find(besideId(running.id, "outcome")), "with its news");
		const [record] = w.answerRecords();
		assert.deepEqual([record?.cause, record?.aborted], ["answer", true]);
		const left = w.find(queued.id)!;
		assert.deepEqual([left.answer?.state, left.answer?.state === "not_run" && left.answer.why], ["not_run", WHY.loopRemoved]);
		assert.deepEqual(w.stores.requests.list(LANE), []);
		assert.equal(s.answerCalls().length, 1, "the queued answer never ran");
	} finally {
		await w.host.stop();
	}
});

test("[answer-orphan] a claim of this process whose run left the list holds no lane: the loop's slot runs beside it, F1 counts it, and it runs after its backoff", async () => {
	const s = scripted();
	const w = world(() => s.runner);
	try {
		await w.stores.jobs.add(loopJob(w.cwd));
		const finding = await yesTo(w, "the build is red");
		const rowId = answerRowId(finding.id);
		const t0 = Date.now();
		// E4a was written and E4b threw: the claim is this process's, and its run is in no list.
		w.stores.requests.update(LANE, rowId, { run: { id: rowId, pid: process.pid, started_at: stamp(t0 - 60_000), ...(procStart(process.pid) ? { procStart: procStart(process.pid) } : {}) } } as any);
		const slotRow = dueRow(w, t0);
		await w.host.loops.drain(parseLane(LANE) as any, t0);
		await w.host.drain(5_000);
		assert.deepEqual(s.calls.map((req) => req.prompt.includes("[Trigger ans-")), [false], "the loop's slot ran: the claim did not hold the lane");
		assert.equal(w.stores.requests.list(LANE).some((r) => r.id === slotRow), false);

		await w.tick(t0);
		const row = w.stores.requests.list(LANE).find((r) => r.id === rowId)!;
		assert.deepEqual([row.run, row.attempts, row.not_before !== undefined], [undefined, 1, true], "F1: the claim is cleared and the attempt counted");
		assert.equal(w.find(finding.id)!.answer?.state, "pending");

		await w.tick(Date.parse(row.not_before!) + 1_000);
		s.release();
		await w.host.drain(5_000);
		assert.equal(s.answerCalls().length, 1, "it runs after its backoff");
		assert.equal(w.find(finding.id)!.answer?.state, "done");
	} finally {
		await w.host.stop();
	}
});

test("[answer-backoff] F1's backoff holds the yes: a tick before not_before starts nothing and says why it waits, a tick after it runs the yes once", async () => {
	const s = scripted();
	const w = world(() => s.runner);
	try {
		await w.stores.jobs.add(loopJob(w.cwd));
		const finding = await yesTo(w, "the build is red");
		const rowId = answerRowId(finding.id);
		const t0 = Date.now();
		// E4a was written and E4b threw: the claim is this process's, and its run is in no list.
		w.stores.requests.update(LANE, rowId, { run: { id: rowId, pid: process.pid, started_at: stamp(t0 - 60_000), ...(procStart(process.pid) ? { procStart: procStart(process.pid) } : {}) } } as any);
		await w.tick(t0);
		const row = w.stores.requests.list(LANE).find((r) => r.id === rowId)!;
		assert.deepEqual([row.run, row.attempts], [undefined, 1], "F1 counted the attempt");
		const until = Date.parse(row.not_before!);
		assert.ok(until > t0, "and wrote its backoff");

		await w.tick(until - 1_000);
		assert.equal(s.answerCalls().length, 0, "a tick before the backoff ends starts nothing");
		const waiting = w.stores.requests.list(LANE).find((r) => r.id === rowId)!;
		assert.deepEqual([waiting.run, waiting.waiting], [undefined, `backing off until ${row.not_before}`]);
		assert.equal(w.find(finding.id)!.answer?.state, "pending");

		await w.tick(until + 1_000);
		s.release();
		await w.host.drain(5_000);
		assert.equal(s.answerCalls().length, 1, "it runs once the backoff ends");
		assert.equal(w.find(finding.id)!.answer?.state, "done");
	} finally {
		await w.host.stop();
	}
});

test("[answer-claim-recheck] a run of the loop that starts between the read before the locks and the claim holds the yes: E4 claims nothing beside it", async () => {
	const s = scripted();
	let loopStarted!: () => void;
	const started = new Promise<void>((resolve) => (loopStarted = resolve));
	let endLoop!: () => void;
	const loopEnds = new Promise<void>((resolve) => (endLoop = resolve));
	const runner: SubagentRunner = async (req) => {
		if (req.prompt.includes("[Trigger ans-")) return s.runner(req);
		loopStarted();
		await loopEnds;
		return { ok: true, exitCode: 0, timedOut: false, text: "", usage: USAGE };
	};
	const w = world(() => runner);
	try {
		await w.stores.jobs.add(loopJob(w.cwd));
		const finding = await yesTo(w, "the build is red");
		const rowId = answerRowId(finding.id);
		// inbox.lock is held: the drain reads the lane, finds nothing that holds it, and waits for the lock.
		let drained: Promise<unknown> | undefined;
		await withFileLock(path.join(w.dir, "inbox.lock"), async () => {
			drained = w.host.answerLanes.drain(parseLane(LANE)!, Date.now());
			assert.equal(await w.host.loops.runNow(JOB), true);
			await started;
		});
		await drained;
		assert.equal(s.answerCalls().length, 0, "no answer runs beside the loop's run");
		const row = w.stores.requests.list(LANE).find((r) => r.id === rowId)!;
		assert.deepEqual([row.run, row.waiting], [undefined, "another run of the loop is going"], "the claim asked the lane again, and the row says why it waits");
		assert.equal(w.find(finding.id)!.answer?.state, "pending");
		endLoop();
		await w.host.drain(5_000);
		await w.tick();
		s.release();
		await w.host.drain(5_000);
		assert.equal(s.answerCalls().length, 1, "it runs after the loop's run");
	} finally {
		endLoop();
		await w.host.stop();
	}
});

test("[answer-check-running] a yes to a check's finding waits while a check of its project runs, and runs once it ends", async () => {
	const s = scripted();
	let checkStarted!: () => void;
	const started = new Promise<void>((resolve) => (checkStarted = resolve));
	let endCheck!: () => void;
	const checkEnds = new Promise<void>((resolve) => (endCheck = resolve));
	const runner: SubagentRunner = async (req) => {
		if (req.prompt.includes("[Trigger ans-")) return s.runner(req);
		checkStarted();
		await checkEnds;
		return { ok: true, exitCode: 0, timedOut: false, text: "no match", usage: USAGE };
	};
	const w = world(() => runner);
	try {
		const lane = checkLane(w.cwd)!;
		const rule = await w.stores.rules.add({ condition: "the deploy is stuck", action: "say so", cwd: w.cwd, fireOnce: false });
		const finding = await w.stores.inbox.append({ source: "trigger:deploy-rule", text: "the deploy is stuck", run_id: "trace-1", cwd: w.cwd, kind: "news", lane });
		assert.equal((await w.host.answers.say(finding.id, "yes", PERSON)).said, "Y1");
		const check = w.host.triggers.handle(buildPeriodicCheckTrigger(w.cwd, 1), "sub_agent", [rule]);
		await started;
		await w.host.answerLanes.tick(Date.now());
		assert.equal(s.answerCalls().length, 0, "the check's transcript is not resumed while a check of the project runs");
		assert.equal(w.stores.requests.list(lane).find((r) => r.id === answerRowId(finding.id))?.waiting, "a check of this project is running");
		endCheck();
		await check;
		await w.host.answerLanes.tick(Date.now());
		s.release();
		await w.host.drain(5_000);
		assert.equal(s.answerCalls().length, 1, "it runs once the check ended");
		assert.equal(w.find(finding.id)!.answer?.state, "done");
	} finally {
		endCheck();
		await w.host.stop();
	}
});

test("[answer-stop] stop(drainMs) aborts the answer runs that are going and waits for their closings", async () => {
	const s = scripted();
	const w = world(() => s.runner);
	try {
		await w.stores.jobs.add(loopJob(w.cwd));
		const finding = await yesTo(w, "the build is red");
		await w.tick();
		assert.equal(w.host.runs.all().length, 1);
		await w.host.answerLanes.stop(5_000);
		const answered = w.find(finding.id)!;
		assert.deepEqual([answered.answer?.state, answered.answer?.state === "unfinished" && answered.answer.why], ["unfinished", WHY.stopped], "closed before stop returned");
		assert.deepEqual([w.host.runs.all().length, w.stores.requests.list(LANE).length], [0, 0]);
	} finally {
		await w.host.stop();
	}
});

test("[answer-orphan-clock] the clock reads a claim of this process whose answer run left the list as holding nothing: a due slot is written, not pushed back by it or counted on it", async () => {
	const s = scripted();
	const w = world(() => s.runner);
	try {
		const t0 = Date.now();
		await w.stores.jobs.add(loopJob(w.cwd, { schedule: { kind: "every", ms: 60_000 }, catchUp: true, createdAt: stamp(t0 - 120_000) }));
		const finding = await yesTo(w, "the build is red");
		const rowId = answerRowId(finding.id);
		w.stores.requests.update(LANE, rowId, { run: { id: rowId, pid: process.pid, started_at: stamp(t0 - 30_000), ...(procStart(process.pid) ? { procStart: procStart(process.pid) } : {}) } } as any);
		// A live claim's start is the loop's last fire: read as live, this one would put the slot due at t0 + 30s.
		await w.host.riders.clock(t0, { startedAt: 0, tickMs: 30_000 });
		const rows = w.stores.requests.list(LANE) as any[];
		const answer = rows.find((r) => r.id === rowId);
		assert.deepEqual([answer?.collapsed, answer?.skipped, w.stores.clock.read().jobs[JOB]?.collapsed], [undefined, undefined, undefined], "nothing is counted on a claim that holds nothing");
		assert.equal(rows.filter((r) => r.source === `cron:${JOB}`).length, 1, "the slot's own row is written");
	} finally {
		await w.host.stop();
	}
});

/** E4a and E4b of `finding`'s yes, written for a process that died right after: its claim names a pid that is not there. */
async function startedByDeadProcess(w: ReturnType<typeof world>, finding: InboxEntry, laneId: string): Promise<string> {
	const scratch = new RunList();
	const dead = { pid: 2 ** 22 + 17, procStart: "gone" };
	const executor: AnswerExecutor = {
		blocked: () => undefined,
		live: () => false,
		claim: (row, _finding, lock, now) => scratch.claim(w.stores.requests, row, dead, { jobId: JOB, label: "dead", promptPreview: "", ctrl: new AbortController() }, now, lock),
		release: () => undefined,
	};
	const met = await w.host.answers.meet(parseLane(laneId)!, answerRowId(finding.id), executor, Date.now());
	assert.equal(met.met, "E4");
	assert.equal(w.find(finding.id)!.answer?.state, "started");
	return answerRowId(finding.id);
}

test("[answer-f2-hooks] a loop's answer that a restarted process closes as F2 fires the loop's run_end hook once; a check lane's fires none", async () => {
	const s = scripted();
	const w = world(() => s.runner);
	const events = path.join(w.dir, "events.jsonl");
	fs.writeFileSync(path.join(w.dir, "hooks.toml"), ['[[hook]]', 'event = "run_end"', `command = "cat \\"$PI_HOOK_PAYLOAD\\" >> ${events}; echo >> ${events}"`, ""].join("\n"));
	try {
		await w.stores.jobs.add(loopJob(w.cwd, { name: "release" }));
		const loopRow = await startedByDeadProcess(w, await yesTo(w, "the build is red"), LANE);
		const check = checkLane(w.cwd)!;
		const checkFinding = await w.stores.inbox.append({ source: "trigger:release-rule", text: "the deploy is stuck", run_id: "trace-1", cwd: w.cwd, kind: "news", lane: check });
		assert.equal((await w.host.answers.say(checkFinding.id, "yes", PERSON)).said, "Y1");
		await startedByDeadProcess(w, checkFinding, check);

		await w.tick();
		await w.host.stop();
		const fired = fs.existsSync(events) ? lines(events) : [];
		assert.deepEqual(fired.map((e) => [e.event, e.run_id, e.run_job, e.run_ok]), [["run_end", loopRow, "release", false]], "one run_end, the loop's, for the run that died");
		assert.equal(w.find(checkFinding.id)!.answer?.state, "unfinished");
		assert.equal(s.answerCalls().length, 0, "nothing ran again");
	} finally {
		await w.host.stop();
	}
});

/** A question of the loop's run `sid`, filed as Q1 files it with `cap`, and its transcript in the loop's session directory proving the blocked call. */
async function questionOf(w: ReturnType<typeof world>, sid: string, cap: ResolvedCap): Promise<InboxEntry> {
	const call: Call = { tool: "bash", tool_call_id: "call-1", command: CMD, input_sha256: inputHash({ command: CMD }), reason: "eval" };
	const file = path.join(w.stores.jobs.sessionDirFor(JOB), `${sid}.jsonl`);
	const entries = [
		{ type: "session", id: sid, cwd: w.cwd },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: call.tool_call_id, name: "bash", arguments: { command: CMD } }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: call.tool_call_id, isError: true, content: [] } },
	];
	fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
	const { id, entry } = questionFinding(call, { lane: LANE, sessionId: sid, sessionFile: file, cap }, { source: `cron:${JOB}`, run_id: "r0", cwd: w.cwd, job_id: JOB, who: "release" }, stamp(Date.now()));
	return w.stores.inbox.fileOnce(entry, id);
}

test("[resolved-cap] a question that recorded a 2e9 ms timeout gets the job's default; one asked in another directory is refused and runs nothing", async () => {
	const s = scripted();
	const w = world(() => s.runner);
	try {
		await w.stores.jobs.add(loopJob(w.cwd));
		const long = await questionOf(w, "0199aaaa-0000-7000-8000-0000000000a1", { ...resolveCap({ cwd: w.cwd }, DEFAULT_RUN_TIMEOUT_MS), timeoutMs: 2e9 });
		assert.equal(long.ask?.run?.timeout_ms, 2e9);
		assert.equal((await w.host.answers.say(long.id, "yes", PERSON)).said, "Y1");
		await w.tick();
		const [req] = s.answerCalls();
		assert.deepEqual([req?.timeoutMs, req?.guard?.cap.timeoutMs], [DEFAULT_RUN_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS], "a job with no timeout: the code's default, not the question's");
		s.release();
		await w.host.drain(5_000);

		const moved = await questionOf(w, "0199aaaa-0000-7000-8000-0000000000a2", resolveCap({ cwd: path.join(w.dir, "elsewhere") }, DEFAULT_RUN_TIMEOUT_MS));
		assert.equal((await w.host.answers.say(moved.id, "yes", PERSON)).said, "Y1");
		await w.tick();
		await w.host.drain(5_000);
		assert.equal(s.answerCalls().length, 1, "the question asked in another directory runs nothing");
		const answer = w.find(moved.id)!.answer;
		assert.equal(answer?.state, "unfinished");
		assert.match(answer?.state === "unfinished" ? answer.why : "", /^refused: the question was asked in .*elsewhere, and this run would be in /);
		assert.equal(answer?.state === "unfinished" && answer.ending, "The command was not run.");
	} finally {
		await w.host.stop();
	}
});

test("[answer-run-end] run_end after a restart with a record whose jobId is not the lane's job fires no hook", async () => {
	const s = scripted();
	const w = world(() => s.runner);
	const events = path.join(w.dir, "events.jsonl");
	fs.writeFileSync(path.join(w.dir, "hooks.toml"), ['[[hook]]', 'event = "run_end"', `command = "cat \\"$PI_HOOK_PAYLOAD\\" >> ${events}; echo >> ${events}"`, ""].join("\n"));
	try {
		await w.stores.jobs.add(loopJob(w.cwd, { name: "release" }));
		await w.stores.jobs.add(loopJob(w.cwd, { id: "cron-ffffffffffffffffffffffffffffffff", name: "other" }));
		const rowId = await startedByDeadProcess(w, await yesTo(w, "the build is red"), LANE);
		const run = w.stores.requests.list(LANE).find((r) => r.id === rowId)!.run!;
		// The run log names the run of this lane's row under another loop's id.
		w.stores.jobs.appendRun({ runId: run.id, jobId: "cron-ffffffffffffffffffffffffffffffff", jobName: "other", stateful: true, cwd: w.cwd, pid: run.pid, startedAt: run.started_at, finishedAt: stamp(Date.now()), ok: true, findings: 0, droppedFindings: 0, stateUpdated: false, cause: "answer" } as RunRecord);

		await w.tick();
		await w.host.stop();
		assert.equal(fs.existsSync(events), false, "no run_end: the record is not of the loop the lane names");
		assert.equal(w.logs.some((line) => line.includes("run_end not fired")), true);
		assert.equal(w.find(answerRowIdFinding(w, rowId))?.answer?.state, "done", "the answer still closes");
	} finally {
		await w.host.stop();
	}
});

const answerRowIdFinding = (w: ReturnType<typeof world>, rowId: string): string => w.stores.inbox.list().find((f) => answerRowId(f.id) === rowId)!.id;

test("[check-cap] an answer to a check's finding runs with the check's own cap: [triggers] run_timeout_secs and the rule's pinned model", async () => {
	const s = scripted();
	const w = world(() => s.runner, { config: "[triggers]\nrun_timeout_secs = 60\n" });
	try {
		await w.stores.rules.add({ condition: "the deploy is stuck", action: "say so", cwd: w.cwd, model: "fake/pinned", thinking: "high", fireOnce: false });
		const lane = checkLane(w.cwd)!;
		const finding = await w.stores.inbox.append({ source: "trigger:deploy-rule", text: "the deploy is stuck", run_id: "trace-1", cwd: w.cwd, kind: "news", lane });
		assert.equal((await w.host.answers.say(finding.id, "yes", PERSON)).said, "Y1");
		await w.tick();
		const [req] = s.answerCalls();
		assert.ok(req, "the answer runs");
		assert.deepEqual([req.timeoutMs, req.model, req.thinking], [60_000, "fake/pinned", "high"], "the check's timeout and pinned model, not a loop's defaults");
		assert.deepEqual(req.guard?.cap, w.host.triggers.checkCapOf(w.cwd), "the one cap a check of the project runs under");
		s.release();
		await w.host.drain(5_000);
	} finally {
		await w.host.stop();
	}
});

test("[check-dir-symlink] an answer to a check's question from a project reached through a symlink finds the transcript its check wrote under the real path", async () => {
	const s = scripted();
	const w = world(() => s.runner);
	try {
		const link = path.join(w.dir, "link");
		fs.symlinkSync(w.cwd, link);
		const lane = checkLane(link)!;
		assert.equal(lane, checkLane(w.cwd), "one check lane");
		const sid = "0199aaaa-0000-7000-8000-0000000000c1";
		const call: Call = { tool: "bash", tool_call_id: "call-1", command: CMD, input_sha256: inputHash({ command: CMD }), reason: "eval" };
		const file = path.join(checkSessionDir(w.stores.jobs, w.cwd), `${sid}.jsonl`);
		const entries = [
			{ type: "session", id: sid, cwd: w.cwd },
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: call.tool_call_id, name: "bash", arguments: { command: CMD } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: call.tool_call_id, isError: true, content: [] } },
		];
		fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
		const { id, entry } = questionFinding(call, { lane, sessionId: sid, sessionFile: file, cap: resolveCap({ cwd: link }, DEFAULT_RUN_TIMEOUT_MS) }, { source: "trigger:release-rule", run_id: "trace-1", cwd: link, who: "the check of link" }, stamp(Date.now()));
		const question = await w.stores.inbox.fileOnce(entry, id);
		assert.equal((await w.host.answers.say(question.id, "yes", PERSON)).said, "Y1");
		await w.tick();
		const [req] = s.answerCalls();
		assert.deepEqual(req?.resume, { file, sessionId: sid }, "the check's transcript under the real path is resumed");
		s.release();
		await w.host.drain(5_000);
		assert.equal(w.find(question.id)!.answer?.state, "unfinished", "it ran: the stand-in made no call, so the grant is unused");
	} finally {
		await w.host.stop();
	}
});

test("[removed-job-hooks] run_end of an answer whose loop was removed loads no project hooks: only the user's own fire", async () => {
	const s = scripted();
	const w = world(() => s.runner, { config: "allow_project_hooks = true\n", isProjectTrusted: () => true });
	const userEvents = path.join(w.dir, "user-events.jsonl");
	const projectEvents = path.join(w.dir, "project-events.jsonl");
	const rule = (file: string) => ['[[hook]]', 'event = "run_end"', `command = "cat \\"$PI_HOOK_PAYLOAD\\" >> ${file}; echo >> ${file}"`, ""].join("\n");
	fs.writeFileSync(path.join(w.dir, "hooks.toml"), rule(userEvents));
	fs.mkdirSync(path.join(w.cwd, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(w.cwd, ".pi", "hooks.toml"), rule(projectEvents));
	try {
		await w.stores.jobs.add(loopJob(w.cwd, { name: "release" }));
		const rowId = await startedByDeadProcess(w, await yesTo(w, "the build is red"), LANE);
		await w.stores.jobs.remove(JOB);
		await w.tick();
		await w.host.stop();
		assert.deepEqual((fs.existsSync(userEvents) ? lines(userEvents) : []).map((e) => [e.event, e.run_id]), [["run_end", rowId]], "the user's hook fires");
		assert.equal(fs.existsSync(projectEvents), false, "the removed job's project hook does not");
	} finally {
		await w.host.stop();
	}
});

/** A conversation of the project that nobody has open: its file in the project's session directory, last written ten minutes ago, and its lease with no holder. */
function closedConversation(w: ReturnType<typeof world>): { sessionId: string; file: string } {
	const sm = SessionManager.create(w.cwd, path.join(w.dir, "conversations"));
	sm.appendModelChange("fake", "fake-model");
	sm.appendMessage({ role: "user", content: "earlier", timestamp: Date.now() } as any);
	const file = sm.getSessionFile()!;
	const old = new Date(Date.now() - 10 * 60_000);
	fs.utimesSync(file, old, old);
	const sessionId = sm.getSessionId();
	fs.mkdirSync(path.join(w.dir, "leases"), { recursive: true });
	fs.writeFileSync(path.join(w.dir, "leases", `${sessionId}.json`), JSON.stringify({ v: 1, sessionId, sessionFile: file, cwd: w.cwd, epoch: 1, holder: null, updatedAt: new Date().toISOString() }));
	return { sessionId, file };
}
const aged = (file: string): void => {
	const old = new Date(Date.now() - 10 * 60_000);
	fs.utimesSync(file, old, old);
};
/** A plain job of the conversation whose slot is due now. */
const plainJob = (sessionId: string, cwd: string): LoopJob => ({ id: "cron-fedcba9876543210fedcba9876543210", name: "remind", schedule: { kind: "every", ms: 3_600_000 }, stateful: false, sessionId, prompt: "PROMPT-ONE remind me to ship", cwd, enabled: true, catchUp: false, createdAt: stamp(Date.now() - 3_700_000), runCount: 0, skippedOverlap: 0 }) as LoopJob;
/** A news finding filed for the conversation, and a person's yes to it. */
async function yesInConversation(w: ReturnType<typeof world>, sessionId: string, text: string): Promise<InboxEntry> {
	const finding = await w.stores.inbox.append({ source: "cron:remind", text, run_id: `run-${text}`, cwd: w.cwd, kind: "news", lane: sessionId });
	const said = await w.host.answers.say(finding.id, "yes", PERSON);
	assert.deepEqual([said.said, said.said === "Y1" && said.lane], ["Y1", sessionId]);
	return finding;
}

test("[answer-conversation] a plain job's held turn in a closed conversation asks about a dangerous call; after a yes the next tick takes the lease, runs the granted call once in that conversation, writes done and gives the lease back", { timeout: 120_000 }, async () => {
	let model: Awaited<ReturnType<typeof standIn>> | undefined;
	const w = world(() => (req) => model!.real(req));
	model = await standIn(w.dir, w.stores.inbox);
	try {
		const { sessionId, file } = closedConversation(w);
		await w.stores.jobs.add(plainJob(sessionId, w.cwd));
		await w.tick();
		await w.host.drain(30_000);
		const question = w.stores.inbox.list().find((f) => f.ask);
		assert.ok(question, "the held turn asked about its call");
		assert.deepEqual([question.ask!.lane, question.ask!.session_id, question.lane], [sessionId, sessionId, sessionId], "in the conversation's own lane, from its own transcript");
		assert.equal(fs.existsSync(path.join(w.cwd, "marker.txt")), false, "nothing ran before the yes");
		const leases = new LeaseStore(w.dir);
		const before = leases.read(sessionId)!;
		assert.equal(before.holder, null, "the held turn gave the conversation back");

		assert.equal((await w.host.answers.say(question.id, "yes", PERSON)).said, "Y1");
		const rowId = answerRowId(question.id);
		assert.deepEqual(w.stores.requests.list(sessionId).map((r) => r.id), [rowId]);
		await w.tick();
		await w.host.drain(30_000);

		assert.equal(fs.readFileSync(path.join(w.cwd, "marker.txt"), "utf8"), "ran\n", "the granted call ran once");
		assert.deepEqual(bashResultsAfter(file, `[Trigger ${rowId}] `).map((r) => r.error), [false, true], "in the conversation's file: the granted call, then the same call asked about again");
		const [record] = w.answerRecords();
		assert.deepEqual(
			{ runId: record?.runId, cause: record?.cause, grant_used: record?.grant_used, ok: record?.ok, sessionFile: record?.sessionFile, resumed: record?.resumed, stateful: record?.stateful, requestedBy: record?.requestedBy },
			{ runId: rowId, cause: "answer", grant_used: true, ok: true, sessionFile: file, resumed: file, stateful: false, requestedBy: { sessionId: PERSON.session } },
		);
		assert.equal(w.find(question.id)!.answer?.state, "done");
		assert.deepEqual(w.stores.requests.list(sessionId), [], "the row is gone");
		const after = leases.read(sessionId)!;
		assert.deepEqual([after.holder, after.epoch], [null, before.epoch + 2], "the answer took the lease once and gave it back");
		assert.equal(w.host.runs.all().length, 0);
	} finally {
		await w.host.stop();
		model?.fake.kill();
	}
});

test("[answer-conversation-window] while a window holds the conversation, its answer waits; once the window lets go it waits for the file to be quiet, then runs once as a held turn under the lease, which it gives back", async () => {
	const s = scripted();
	const w = world(() => s.runner);
	try {
		const { sessionId, file } = closedConversation(w);
		const finding = await yesInConversation(w, sessionId, "the release notes are stale");
		const rowId = answerRowId(finding.id);
		const leases = new LeaseStore(w.dir);
		const window = new LeaseBinding(leases, "w1", () => ({ kind: "terminal", pid: process.pid, mode: "tui", pushServers: [] }));
		window.bind(sessionId, { sessionFile: file, cwd: w.cwd });
		await w.tick();
		assert.equal(s.answerCalls().length, 0, "nothing runs while the window holds it");
		assert.deepEqual(w.stores.requests.list(sessionId).map((r) => [r.id, r.run, r.waiting]), [[rowId, undefined, undefined]], "the row is the window's to wait on");
		assert.equal(w.find(finding.id)!.answer?.state, "pending");

		// The window wrote the conversation and let go of it a moment ago.
		window.release();
		fs.utimesSync(file, new Date(), new Date());
		await w.tick();
		assert.equal(s.answerCalls().length, 0);
		assert.deepEqual(w.stores.requests.list(sessionId).map((r) => [r.run, r.waiting]), [[undefined, "its conversation cannot be taken now (session file changed in the last two minutes)"]]);
		assert.equal(leases.read(sessionId)?.holder, null, "no lease is kept for a row that waits");

		aged(file);
		await w.tick();
		assert.equal(s.answerCalls().length, 1);
		const req = s.answerCalls()[0];
		assert.deepEqual([req.kind, req.sessionFile, req.resume, req.guard?.lane, req.guard?.cap.cwd, req.guard?.cap.model, req.runId], ["held", file, undefined, sessionId, w.cwd, null, rowId]);
		const holder = leases.read(sessionId)?.holder;
		assert.deepEqual([holder?.kind, holder?.busy?.runId], ["host", rowId], "the lease names the answer's run while it goes");
		assert.equal(w.host.heldTurn(sessionId)?.runId, rowId, "it is the conversation's turn: a stop row reaches it");
		s.release();
		await w.host.drain(5_000);
		assert.equal(w.find(finding.id)!.answer?.state, "done");
		assert.deepEqual([w.stores.requests.list(sessionId), leases.read(sessionId)?.holder], [[], null], "the row is gone and the lease given back");
		await w.tick();
		assert.equal(s.answerCalls().length, 1, "run once");
	} finally {
		await w.host.stop();
	}
});

test("[answer-conversation-gone] a deleted conversation's answer row is met as gone before bury: the finding says so and nothing runs; the lane's other rows are buried as before", async () => {
	const s = scripted();
	const w = world(() => s.runner);
	try {
		const { sessionId, file } = closedConversation(w);
		const finding = await yesInConversation(w, sessionId, "the release notes are stale");
		w.stores.requests.append(ruleResultRow(sessionId, "a rule's result", { traceId: "trace-gone", sourceLabel: "notes-rule", cwd: w.cwd }, { pid: process.pid, instance: "test", version: "0" } as any));
		fs.rmSync(file);
		await w.tick();
		const answered = w.find(finding.id)!;
		assert.deepEqual([answered.answer?.state, answered.answer?.state === "not_run" && answered.answer.why], ["not_run", WHY.conversationDeleted]);
		assert.deepEqual(w.stores.requests.list(sessionId), [], "both rows left");
		assert.equal(s.answerCalls().length, 0);
		assert.ok(w.logs.some((line) => line.includes("1 queued request(s) for session") && line.includes("its conversation is gone")), "the rule's row is buried as before, and the answer row is not among them");
		const audit = w.host.triggers.store.listAudit(20, (r) => r.type === "request").map((r) => [r.traceId, r.state]);
		assert.ok(audit.some(([id, state]) => id === answerRowId(finding.id) && state === "stale"), "the answer row's exit is audited");
	} finally {
		await w.host.stop();
	}
});

test("[answer-conversation-no-lease] a yes in a conversation whose lease was swept finds its file in pi's sessions directory: Y1, not a deleted conversation, and the background never meets it as gone", async () => {
	const s = scripted();
	const w = world(() => s.runner, { sessionsRoot: (dir) => path.join(dir, "pi-sessions") });
	try {
		const sm = SessionManager.create(w.cwd, path.join(w.dir, "pi-sessions", "--proj--"));
		sm.appendModelChange("fake", "fake-model");
		sm.appendMessage({ role: "user", content: "earlier", timestamp: Date.now() } as any);
		const sessionId = sm.getSessionId();
		aged(sm.getSessionFile()!);
		assert.equal(new LeaseStore(w.dir).read(sessionId), undefined, "no lease names the conversation");
		const finding = await w.stores.inbox.append({ source: "cron:remind", text: "the release notes are stale", run_id: "run-1", cwd: w.cwd, kind: "news", lane: sessionId });
		const said = await w.host.answers.say(finding.id, "yes", PERSON);
		assert.deepEqual([said.said, said.said === "Y1" && said.lane], ["Y1", sessionId], "the conversation is there: its file is in pi's sessions directory");
		await w.tick();
		await w.tick();
		const answered = w.find(finding.id)!;
		assert.equal(answered.answer?.state, "pending", "not met as a deleted conversation");
		assert.deepEqual(w.stores.requests.list(sessionId).map((r) => r.id), [answerRowId(finding.id)], "its row waits");
	} finally {
		await w.host.stop();
	}
});

/** What a person does to a conversation between the lease and pi's open: deletes its file, or puts another session's file in its place. */
function spoilConversation(how: "deleted" | "replaced", file: string, w: ReturnType<typeof world>): string | undefined {
	fs.rmSync(file);
	if (how === "deleted") return undefined;
	const other = SessionManager.create(w.cwd, path.join(w.dir, "elsewhere"));
	other.appendModelChange("fake", "fake-model");
	other.appendMessage({ role: "user", content: "another conversation", timestamp: Date.now() } as any);
	fs.copyFileSync(other.getSessionFile()!, file);
	return fs.readFileSync(file, "utf8");
}
const modelCalls = (log: string): number => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0);

for (const how of ["deleted", "replaced"] as const) {
	test(`[held-open-proof] an answer's turn whose conversation is ${how} after the lease and before pi opens it runs nothing and makes no file`, { timeout: 60_000 }, async () => {
		let model: Awaited<ReturnType<typeof standIn>> | undefined;
		let spoil: ((req: SubagentRequest) => void) | undefined;
		const w = world(() => (req) => {
			spoil?.(req);
			spoil = undefined;
			return model!.real(req);
		});
		model = await standIn(w.dir, w.stores.inbox);
		try {
			const { sessionId, file } = closedConversation(w);
			const finding = await yesInConversation(w, sessionId, "the release notes are stale");
			let left: string | undefined;
			spoil = (req) => {
				assert.equal(req.sessionFile, file);
				left = spoilConversation(how, file, w);
			};
			await w.tick();
			await w.host.drain(30_000);
			assert.equal(spoil, undefined, "the turn reached the runner");
			assert.equal(modelCalls(model.modelLog), 0, "no prompt reached the model");
			assert.equal(fs.existsSync(file), how === "replaced", how === "deleted" ? "the file is not made again" : "the other session's file is still there");
			if (how === "replaced") assert.equal(fs.readFileSync(file, "utf8"), left, "and nothing was written into it");
			const answered = w.find(finding.id)!;
			assert.equal(answered.answer?.state, "unfinished");
			assert.match(w.answerRecords()[0]?.error ?? "", how === "deleted" ? /the conversation's file is gone/ : /opened as another session/);
			assert.equal(new LeaseStore(w.dir).read(sessionId)?.holder, null, "the lease is given back");
		} finally {
			await w.host.stop();
			model?.fake.kill();
		}
	});

	test(`[held-open-proof] a plain job's turn whose conversation is ${how} after the lease and before pi opens it runs nothing and makes no file`, { timeout: 60_000 }, async () => {
		let model: Awaited<ReturnType<typeof standIn>> | undefined;
		let spoil: ((req: SubagentRequest) => void) | undefined;
		const w = world(() => (req) => {
			spoil?.(req);
			spoil = undefined;
			return model!.real(req);
		});
		model = await standIn(w.dir, w.stores.inbox);
		try {
			const { sessionId, file } = closedConversation(w);
			const job = plainJob(sessionId, w.cwd);
			await w.stores.jobs.add(job);
			let left: string | undefined;
			spoil = (req) => {
				assert.deepEqual([req.kind, req.sessionFile], ["held", file]);
				left = spoilConversation(how, file, w);
			};
			await w.tick();
			await w.host.drain(30_000);
			assert.equal(spoil, undefined, "the turn reached the runner");
			assert.equal(modelCalls(model.modelLog), 0, "no prompt reached the model");
			assert.equal(fs.existsSync(file), how === "replaced", how === "deleted" ? "the file is not made again" : "the other session's file is still there");
			if (how === "replaced") assert.equal(fs.readFileSync(file, "utf8"), left, "and nothing was written into it");
			const [record] = w.stores.jobs.allRuns().filter((r) => r.jobId === job.id);
			assert.equal(record?.ok, false);
			assert.match(record?.error ?? "", how === "deleted" ? /the conversation's file is gone/ : /opened as another session/);
			assert.equal(w.stores.inbox.list().length, 0, "no question was asked");
		} finally {
			await w.host.stop();
			model?.fake.kill();
		}
	});
}

test("[answer-conversation-one-path] a closed conversation's answer is met by its delivery, never by the answers rider's own drain", async () => {
	const s = scripted();
	const w = world(() => s.runner);
	try {
		const { sessionId } = closedConversation(w);
		const finding = await yesInConversation(w, sessionId, "the release notes are stale");
		await w.host.answerLanes.tick(Date.now());
		assert.equal(s.answerCalls().length, 0, "the answers rider leaves a conversation's lane alone");
		assert.deepEqual(w.stores.requests.list(sessionId).map((r) => r.run), [undefined]);
		await w.host.riders["closed-conversations"](Date.now(), { startedAt: 0, tickMs: 30_000 });
		assert.equal(s.answerCalls().length, 1, "its delivery meets it");
		s.release();
		await w.host.drain(5_000);
		assert.equal(w.find(finding.id)!.answer?.state, "done");
	} finally {
		await w.host.stop();
	}
});
