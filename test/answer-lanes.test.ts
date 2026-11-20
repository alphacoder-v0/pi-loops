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
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type AnswerExecutor, type Answerer } from "../src/answers.ts";
import { WHY, answerRowId, besideId } from "../src/ask.ts";
import { loadConfig } from "../src/config.ts";
import { plainJobRow, plainRunId } from "../src/engine.ts";
import { GuardSeats } from "../src/guard.ts";
import type { InboxEntry } from "../src/inbox.ts";
import { parseLane } from "../src/lane.ts";
import { procStart } from "../src/lease.ts";
import { createHostRuntime } from "../src/host-runtime.ts";
import { RunList } from "../src/run-list.ts";
import type { RunnerResult, SubagentRequest, SubagentRunner } from "../src/runner.ts";
import { stamp } from "../src/schedule.ts";
import { createInProcessRunner } from "../src/sdk-runner.ts";
import type { LoopJob, RunRecord } from "../src/store.ts";
import { openStores } from "../src/stores.ts";
import { RUNTIME_RIDERS } from "../src/ticker.ts";
import { checkLane, triggerSessionKey } from "../src/trigger-runtime.ts";
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
function world(makeRunner: (inbox: ReturnType<typeof openStores>["inbox"]) => SubagentRunner) {
	const dir = tmp("pi-loops-answer-lanes-");
	const cwd = path.join(dir, "proj");
	fs.mkdirSync(cwd, { recursive: true });
	const stores = openStores(dir);
	const logs: string[] = [];
	const host = createHostRuntime({ dir, stores, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: makeRunner(stores.inbox), mcpTools: () => [], log: (line) => void logs.push(line) });
	const tick = async (now = Date.now()): Promise<void> => {
		for (const name of RUNTIME_RIDERS) await host.riders[name](now, { startedAt: 0, tickMs: 30_000 });
	};
	const find = (id: string): InboxEntry | undefined => stores.inbox.list().find((f) => f.id === id);
	const answerRecords = (): RunRecord[] => stores.jobs.allRuns().filter((r) => r.cause === "answer");
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
		guard: { seats: new GuardSeats(), deps: { inbox, allowCommands: () => [], hop: 1, now: Date.now } },
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
		const file = question.ask!.session_file;
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
		assert.deepEqual(w.stores.inbox.list().filter((f) => f.run_id === rowId).map((f) => [f.text, f.lane, f.transcript]), [["the release is out", LANE, file]], "the run's <inbox> finding is filed once, in its lane");
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
		const asked = await model.real({ cwd: w.cwd, prompt: "PROMPT-ONE check the release", timeoutMs: 20_000, sessionDir, hop: 1, kind: "trigger", traceId: "trace-1", guard: { lane, origin: { source: "trigger:release-rule", run_id: "trace-1", cwd: w.cwd, who: "the check of proj" }, cap: { cwd: w.cwd, timeout_ms: 20_000 } } });
		assert.equal(asked.ok, true, asked.errorMessage ?? "");
		const question = w.stores.inbox.list().find((f) => f.ask)!;
		assert.equal(question.ask!.lane, lane);
		const file = question.ask!.session_file;
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
