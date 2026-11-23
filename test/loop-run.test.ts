import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolveCap } from "../src/ask.ts";
import { GuardSeats } from "../src/guard.ts";
import { personAnswers } from "../src/answers.ts";
import { notesWrite } from "../src/notes.ts";
import type { SubagentRequest } from "../src/runner.ts";
import { createInProcessRunner } from "../src/sdk-runner.ts";
import { openStores } from "../src/stores.ts";
import { DEFAULT_RUN_TIMEOUT_MS, closeLoopRun, closeSteps, ensureRecord, runLoop, stoppedTogether, aloneIn } from "../src/loop-run.ts";
import type { LoopRunDeps, ProcessStop, RunRecordM4b } from "../src/loop-run.ts";
import { type EngineSinks } from "../src/engine.ts";
import { RequestStore, type ClaimedRow, type UnclaimedRow } from "../src/requests.ts";
import { RunList } from "../src/run-list.ts";
import { stamp } from "../src/schedule.ts";
import { type LoopJob } from "../src/store.ts";
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
	await runLoop(row, job as LoopJob, f.deps);
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
	const plan = closeSteps({ row: claim, job: job as LoopJob, record: ended, history, self: f.createdBy, now });
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
	assert.deepEqual(closeSteps({ row, job: job as LoopJob, record: stopped, history, self: f.createdBy, now }).at(-1), { write: "row", fate: { do: "leave", exit: "stopped" } });
	const handedBack = { ...stopped, stoppedBy: undefined, stop: undefined, aborted: true as const };
	assert.deepEqual(closeSteps({ row, job: job as LoopJob, record: handedBack, history, self: f.createdBy, now }).at(-1), { write: "row", fate: { do: "owed" } });
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

test("[loop-R6] the third alone interruption disables the job before it removes the row, and files nothing in the inbox, as main", async () => {
	const f = setup();
	const job = await f.stores.jobs.add(makeJob());
	const claimed = rowFor(f.dir, { pid: 99999999, instance: "dead", procStart: "dead", version: "test" });
	f.stores.requests.update(claimed.lane, claimed.id, { attempts: 2 });
	const row = { ...claimed, attempts: 2 };
	const stopped: ProcessStop = { pid: row.run.pid, procStart: row.run.procStart, runs: [row.id] };
	const record = interruptedRecord(row, stopped);
	const history = { ordinal: 0, streak: 0, spent: new Set<string>() };
	const plan = closeSteps({ row, job: job as LoopJob, record, history, self: f.createdBy, now });
	assert.deepEqual(plan.map((step) => step.write), ["run-end", "disable", "row"]);
	assert.equal(plan.at(-1)?.write, "row");
	const prior = [record, record].map((item, index) => ({ ...item, runId: `old-${index}`, finishedAt: stamp(now - 1000 + index), ordinal: index + 1 }));
	for (const item of prior) f.stores.jobs.appendRun(item);
	const outcome = await closeLoopRun(row, f.deps, now, record);
	assert.equal(outcome.outcome, "removed");
	assert.equal(f.stores.requests.list(row.lane).length, 0);
	assert.equal(f.stores.inbox.listNew().length, 0);
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
	await runLoop(claimed, job as LoopJob, f.deps);
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
	assert.equal("lastFiredAt" in f.stores.jobs.load()[0], false, "the definition holds no cursor");
});

const FAKE_MODEL = path.join(path.dirname(new URL(import.meta.url).pathname), "downstream", "fake-model.mjs");
const PUSH = "git push --force origin main";

/** The real runner with the guard's seats over `inbox`, against the stand-in model, which asks for `PUSH` on a prompt with PROMPT-ONE unless `script` says otherwise. */
async function standIn(dir: string, reply: string, inbox: Pick<ReturnType<typeof openStores>["inbox"], "list" | "fileOnce">, opts: { script?: Array<{ match: string; tool: string; args: unknown }>; loopsDir?: string } = {}) {
	const portFile = path.join(dir, "port");
	const modelLog = path.join(dir, "model.jsonl");
	const fake = spawn(process.execPath, [FAKE_MODEL, portFile], { env: { ...process.env, FAKE_MODEL_REPLY: reply, FAKE_MODEL_LOG: modelLog, FAKE_MODEL_TOOL_SCRIPT: JSON.stringify(opts.script ?? [{ match: "PROMPT-ONE", tool: "bash", args: { command: PUSH } }]) }, stdio: "ignore" });
	for (let i = 0; i < 200 && !(fs.existsSync(portFile) && fs.readFileSync(portFile, "utf8").trim()); i++) await new Promise((resolve) => setTimeout(resolve, 50));
	const agentDir = path.join(dir, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${fs.readFileSync(portFile, "utf8").trim()}/v1`, api: "openai-completions", apiKey: "fake", models: [{ id: "fake-model" }] } } }));
	const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
	const model = modelRuntime.getModel("fake", "fake-model");
	assert.ok(model, "the stand-in model is registered");
	const real = createInProcessRunner({
		agentDir,
		parentFlags: { extensionPaths: [], skillPaths: [], promptTemplatePaths: [], appendSystemPrompt: [], noSkills: true, noExtensions: false, noContextFiles: true, noPromptTemplates: true },
		getParentModel: () => model,
		getParentModelRuntime: () => modelRuntime,
		getParentThinking: () => undefined,
		customTools: () => [],
		isTrusted: () => false,
		ownDir: tmp("pi-loops-own-"),
		guard: { seats: new GuardSeats(), deps: { inbox, allowCommands: () => [], now: Date.now, ...(opts.loopsDir ? { loopsDir: opts.loopsDir } : {}) } },
	});
	return { real, modelLog, fake };
}

test("[guard-seated] a loop run whose model asks for a dangerous command files one question in its lane through the seated guard; the checker's run files none; the next run is told under [asked]", { timeout: 60_000 }, async () => {
	const { dir, stores, deps, createdBy } = setup();
	const cwd = path.join(dir, "proj");
	fs.mkdirSync(cwd, { recursive: true });
	const { real, modelLog, fake } = await standIn(dir, "<inbox>main is behind</inbox><loop-state>seen</loop-state>", stores.inbox);
	try {
		const requests: SubagentRequest[] = [];
		const job = makeJob({ cwd, prompt: "PROMPT-ONE push what is ready", verify: true, name: "nightly" });
		await stores.jobs.add(job);
		const loopDeps: LoopRunDeps = { ...deps, runner: (req) => (requests.push(req), real(req)), session: () => ({ sessionId: "s1", cwd }) };
		const run = async (id: string): Promise<void> => {
			const row: UnclaimedRow = { v: 3, id, lane: `@${job.id}`, kind: "input", source: `cron:${job.id}`, mode: "unattended", wake: "turn", payload: { text: "x", cwd }, created_at: stamp(now), created_by: createdBy, attempts: 0 };
			stores.requests.append(row);
			const claimed = deps.runs.claim(stores.requests, row, deps.holder(), { jobId: job.id, label: "nightly", promptPreview: "x", ctrl: new AbortController() }, now)!;
			await runLoop(claimed, job, loopDeps);
		};
		await run("run-00000000000000000000000000000001");

		assert.deepEqual(requests.map((req) => [req.kind, req.guard?.lane]), [["loop", `@${job.id}`], ["checker", undefined]], "the loop's request has a seat in its lane; the checker's has none");
		assert.deepEqual(requests[0].guard?.cap, resolveCap(job, DEFAULT_RUN_TIMEOUT_MS), "the cap is the job's as jobs.json has it");
		assert.deepEqual(requests[0].guard?.origin, { source: "cron:nightly", run_id: "run-00000000000000000000000000000001", cwd, job_id: job.id, who: "nightly" });
		const questions = stores.inbox.list().filter((f) => f.ask);
		assert.equal(questions.length, 1, "one question: the checker's blocked call files none");
		assert.equal(questions[0].ask?.lane, `@${job.id}`);
		assert.equal(questions[0].ask?.call.command, PUSH);
		assert.equal(questions[0].lane, `@${job.id}`);
		assert.match(questions[0].text, /^Run `git push --force origin main`\? \(.+\) · waits: nightly went on without it · if not: it stays undone$/);
		const toolResults = fs.readFileSync(modelLog, "utf8").trim().split("\n").map((line) => JSON.parse(line)).flatMap((body) => body.messages.filter((m: any) => m.role === "tool").map((m: any) => String(m.content)));
		assert.ok(toolResults.some((text) => text.startsWith("asked a person: ")), "the loop's model is told a person was asked");
		assert.ok(toolResults.some((text) => text.includes("This run is unattended")), "the checker's model is refused as before, with nobody asked");

		await run("run-00000000000000000000000000000002");
		assert.match(requests[2].prompt, /\[asked\] \(questions of yours that wait for a person; do not ask them again\)\n- \d\d-\d\d run `git push --force origin main`\n\[\/asked\]/, "the next run is told what waits");
		assert.equal(stores.inbox.list().filter((f) => f.ask).length, 1, "the same call asked again files no second question");
	} finally {
		fake.kill();
	}
});

test("[seated-tools] a job's tools are the same seated as before; only a job that names both tools and builtinTools, which createLoopJob never writes, loses a built-in that builtinTools leaves out", { timeout: 60_000 }, async () => {
	const { dir, stores } = setup();
	const cwd = path.join(dir, "proj");
	fs.mkdirSync(cwd, { recursive: true });
	const { real, modelLog, fake } = await standIn(dir, "done", stores.inbox);
	try {
		const toolsSent = async (job: LoopJob, seated: boolean): Promise<string[]> => {
			const before = fs.existsSync(modelLog) ? fs.readFileSync(modelLog, "utf8").trim().split("\n").length : 0;
			const guard = seated ? { lane: `@${job.id}` as const, origin: { source: "cron:x", run_id: "r", cwd, who: "x" }, cap: resolveCap(job, DEFAULT_RUN_TIMEOUT_MS) } : undefined;
			await real({ cwd, prompt: "list nothing", tools: job.tools, builtinTools: job.builtinTools, timeoutMs: 20_000, hop: 1, kind: "loop", ...(guard ? { guard } : {}) });
			const body = JSON.parse(fs.readFileSync(modelLog, "utf8").trim().split("\n")[before]);
			return (body.tools ?? []).map((t: any) => t.function?.name).sort();
		};
		for (const job of [makeJob({ cwd }), makeJob({ cwd, builtinTools: ["read"] }), makeJob({ cwd, tools: ["bash", "read"] })]) {
			assert.deepEqual(await toolsSent(job, true), await toolsSent(job, false), `the same tools seated: ${JSON.stringify({ tools: job.tools, builtinTools: job.builtinTools })}`);
		}
		const both = makeJob({ cwd, tools: ["bash", "read"], builtinTools: ["read"] });
		assert.deepEqual(await toolsSent(both, false), ["bash", "read"], "before: builtinTools beside tools was not read");
		assert.deepEqual(await toolsSent(both, true), ["read"], "seated: bash, which builtinTools leaves out, is gone");
	} finally {
		fake.kill();
	}
});

test("[M5a.8d] a loop run whose model writes into the loops directory by a relative path is refused through the seated guard: the file is unchanged and no question is filed", { timeout: 60_000 }, async () => {
	const { dir, stores, deps, createdBy } = setup();
	const cwd = tmp("pi-loops-loop-run-proj-");
	const target = path.join(dir, "config.toml");
	fs.writeFileSync(target, "# the person's own\n");
	const { real, modelLog, fake } = await standIn(dir, "<loop-state>seen</loop-state>", stores.inbox, { script: [{ match: "PROMPT-ONE", tool: "write", args: { path: path.relative(cwd, target), content: "[danger]\nallow = [\"git push --force origin main\"]\n" } }], loopsDir: dir });
	try {
		const job = makeJob({ cwd, prompt: "PROMPT-ONE tidy up", name: "nightly" });
		await stores.jobs.add(job);
		const row: UnclaimedRow = { v: 3, id: "run-00000000000000000000000000000001", lane: `@${job.id}`, kind: "input", source: `cron:${job.id}`, mode: "unattended", wake: "turn", payload: { text: "x", cwd }, created_at: stamp(now), created_by: createdBy, attempts: 0 };
		stores.requests.append(row);
		const claimed = deps.runs.claim(stores.requests, row, deps.holder(), { jobId: job.id, label: "nightly", promptPreview: "x", ctrl: new AbortController() }, now)!;
		await runLoop(claimed, job, { ...deps, runner: real, session: () => ({ sessionId: "s1", cwd }) });

		assert.equal(fs.readFileSync(target, "utf8"), "# the person's own\n", "the file is unchanged");
		assert.deepEqual(stores.inbox.list().filter((f) => f.ask), [], "no question is filed");
		const toolResults = fs.readFileSync(modelLog, "utf8").trim().split("\n").map((line) => JSON.parse(line)).flatMap((body) => body.messages.filter((m: any) => m.role === "tool").map((m: any) => String(m.content)));
		assert.ok(toolResults.some((text) => text.startsWith("refused by pi-loops: reads or writes pi-loops' own files. Nobody was asked: a person cannot see on the card what this call would read or write")), "the model is told it is refused and nobody was asked");
	} finally {
		fake.kill();
	}
});

/** One run of `job` through `runLoop` with a runner that answers `reply` (or does `act` first), from a fresh row. */
async function oneRun(f: ReturnType<typeof setup>, job: LoopJob, id: string, reply: string | ((request: SubagentRequest) => { ok: boolean; text: string; timedOut?: boolean })): Promise<{ prompt: string; record: RunRecordM4b }> {
	const row: UnclaimedRow = { v: 3, id, lane: `@${job.id}`, kind: "input", source: `cron:${job.id}`, mode: "unattended", wake: "turn", payload: { text: "x", cwd: job.cwd }, created_at: stamp(now), created_by: f.createdBy, attempts: 0 };
	f.stores.requests.append(row);
	const claimed = f.deps.runs.claim(f.stores.requests, row, f.deps.holder(), { jobId: job.id, label: "watch", promptPreview: "x", ctrl: new AbortController() }, now)!;
	let prompt = "";
	f.deps.runner = async (request) => {
		prompt = request.prompt;
		const out = typeof reply === "string" ? { ok: true, text: reply } : reply(request);
		return { ok: out.ok, exitCode: out.ok ? 0 : 1, timedOut: out.timedOut ?? false, text: out.text, usage: { input: 1, output: 1, cost: 0, turns: 1 }, ...(out.ok ? {} : { errorMessage: out.timedOut ? "timed out" : "the model failed" }) };
	};
	const before = f.finished.length;
	await runLoop(claimed, job, f.deps);
	return { prompt, record: f.finished[before] };
}

test("[notes-write] [overflow] [notes-cut-visible] a run's notes over the cap: the index keeps the leading lines and says it was cut, overflow.md has the whole text, the record has notesCut and the log one warning", async () => {
	const f = setup();
	const warnings: string[] = [];
	f.deps.sinks.log = (line, level) => { if (level === "warning") warnings.push(line); };
	const job = await f.stores.jobs.add(makeJob({ name: "watch" })) as LoopJob;
	const notes = Array.from({ length: 40 }, (_, i) => `- PR #${1000 + i}: watched since 2026-11-${String(1 + (i % 28)).padStart(2, "0")}, ${"x".repeat(50)}`).join("\n");
	const { record } = await oneRun(f, job, "run-00000000000000000000000000000001", `done <loop-state>${notes}</loop-state>`);
	const written = notesWrite(notes);
	assert.ok(written.cut, "the notes are over the cap");
	assert.equal(fs.readFileSync(f.stores.jobs.statePath(job.id), "utf8"), `${written.index}\n`, "the index is notesWrite's");
	assert.equal(fs.readFileSync(path.join(f.stores.jobs.notesDir(job.id), "overflow.md"), "utf8"), `${notes}\n`, "the whole text is in overflow.md");
	assert.deepEqual(record.notesCut, written.cut);
	assert.equal(record.stateUpdated, true);
	assert.deepEqual(f.stores.jobs.listRuns(job.id).at(-1)?.notesCut, written.cut, "the run log carries it");
	assert.equal(warnings.length, 1, "one warning");
	assert.match(warnings[0], new RegExp(`notes cut ${written.cut!.from}→${written.cut!.to}`));
	assert.ok(warnings[0].includes(path.join(f.stores.jobs.notesDir(job.id), "overflow.md")));

	const next = await oneRun(f, job, "run-00000000000000000000000000000002", "done <loop-state>short now</loop-state>");
	assert.ok(next.prompt.includes(`[loop-state] (your notes from the previous run of this recurring job)\n${written.index}\n[/loop-state]`), "the next run reads the index as it is on disk, cut line included");
	assert.equal(f.stores.jobs.readState(job.id), "short now");
	assert.equal(next.record.notesCut, undefined, "notes that fit are not cut");
	assert.equal(warnings.length, 1);
});

test("[failed-run-keeps-index] a failed or timed-out run does not change the index, and the files it wrote in its notes directory stay", async () => {
	const f = setup();
	const job = await f.stores.jobs.add(makeJob({ name: "watch" })) as LoopJob;
	f.stores.jobs.writeState(job.id, "baseline: 3");
	const dir = f.stores.jobs.notesDir(job.id);
	let n = 0;
	for (const timedOut of [false, true]) {
		const file = path.join(dir, `run-${n}.md`);
		const { record } = await oneRun(f, job, `run-0000000000000000000000000000000${++n}`, () => {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(file, "written by the run");
			return { ok: false, timedOut, text: `<loop-state>${"y".repeat(3000)}</loop-state>` };
		});
		assert.equal(record.ok, false);
		assert.equal(record.stateUpdated, false);
		assert.equal(record.notesCut, undefined);
		assert.equal(f.stores.jobs.readState(job.id), "baseline: 3", timedOut ? "timed out: the index is as it was" : "failed: the index is as it was");
		assert.equal(fs.readFileSync(file, "utf8"), "written by the run", "the file the run wrote stays");
		assert.equal(fs.existsSync(path.join(dir, "overflow.md")), false, "and a failed run's notes are not written anywhere");
	}
});

test("[repeat-rule] a loop run's finding with the words of a new finding of the same loop is not filed again, and the record counts what was filed and what repeated", async () => {
	const f = setup();
	const job = await f.stores.jobs.add(makeJob({ name: "watch" })) as LoopJob;
	const first = await oneRun(f, job, "run-00000000000000000000000000000001", "<inbox>PR #12 has failing CI</inbox><inbox>PR #12 has failing CI</inbox><inbox>main is behind</inbox><loop-state>s</loop-state>");
	assert.deepEqual([first.record.findings, first.record.repeats], [2, 1]);
	const second = await oneRun(f, job, "run-00000000000000000000000000000002", "<inbox>PR #12 has failing CI</inbox><inbox>PR #13 is new</inbox><loop-state>s</loop-state>");
	assert.deepEqual([second.record.findings, second.record.repeats], [1, 1], "only the new words are filed; the repeat is counted apart");
	const third = await oneRun(f, job, "run-00000000000000000000000000000003", "<inbox>PR #13 is new</inbox><loop-state>s</loop-state>");
	assert.deepEqual([third.record.findings, third.record.repeats], [0, 1], "a run whose findings all repeat filed none, and says it found them");
	const quiet = await oneRun(f, job, "run-00000000000000000000000000000004", "<loop-state>s</loop-state>");
	assert.equal("repeats" in quiet.record, false, "a run with no repeat writes no count");
	assert.deepEqual(f.stores.inbox.list().map((e) => e.text), ["PR #12 has failing CI", "main is behind", "PR #13 is new"]);
});

test("[reported] [notes-files] the next run is told what its loop reported and what a person did with it, and which files its notes directory holds", async () => {
	const f = setup();
	const job = await f.stores.jobs.add(makeJob({ name: "watch" })) as LoopJob;
	await oneRun(f, job, "run-00000000000000000000000000000001", "<inbox>flaky test in foo.test.ts</inbox><inbox>PR #12 has failing CI</inbox><loop-state>s</loop-state>");
	const flaky = f.stores.inbox.list().find((e) => e.text.startsWith("flaky"))!;
	await personAnswers({ inbox: f.stores.inbox, requests: f.stores.requests, jobs: f.stores.jobs, audit: f.stores.rules, sessionFile: () => undefined, self: () => f.createdBy, now: Date.now, log: () => undefined }).say(flaky.id, "no", { by: "cli" }, { reason: "Not a bug" });
	fs.mkdirSync(f.stores.jobs.notesDir(job.id), { recursive: true });
	fs.writeFileSync(path.join(f.stores.jobs.notesDir(job.id), "prs.md"), "p".repeat(3174));
	const { prompt } = await oneRun(f, job, "run-00000000000000000000000000000002", "<loop-state>s</loop-state>");
	const dismissedOn = f.stores.inbox.list().find((e) => e.id === flaky.id)!.dismissed_at!.slice(5, 10);
	const pr = f.stores.inbox.list().find((e) => e.text.startsWith("PR #12"))!;
	assert.ok(prompt.includes(`[reported] (what this loop already told a person, and what they did with it; do not report these again unless what they describe has changed)\n- ${pr.created_at.slice(5, 10)} new: PR #12 has failing CI\n- ${dismissedOn} dismissed ("Not a bug"): flaky test in foo.test.ts\n[/reported]`) || prompt.includes(`- ${dismissedOn} dismissed ("Not a bug"): flaky test in foo.test.ts\n- ${pr.created_at.slice(5, 10)} new: PR #12 has failing CI\n[/reported]`), prompt);
	const dir = f.stores.jobs.notesDir(job.id);
	assert.match(prompt, new RegExp(`\\[notes-files\\] \\(longer notes you keep as files in ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/; read one when you need it\\)\\n- prs\\.md · 3\\.1 KB · changed \\d{4}-\\d\\d-\\d\\d\\n\\[/notes-files\\]`));
	assert.ok(prompt.includes(`Put anything longer in a file under ${dir}/ and name the file in your notes.`));
});

test("[own-notes-dir] through the seated guard, a loop run writes a file in its own notes directory; its index and another loop's notes stay refused", { timeout: 90_000 }, async () => {
	const { dir, stores, deps, createdBy } = setup();
	const cwd = tmp("pi-loops-loop-run-proj-");
	const own = makeJob({ cwd, prompt: "PROMPT-OWN keep notes", name: "own" });
	const other = makeJob({ id: "cron-fedcba9876543210fedcba9876543210", cwd, prompt: "PROMPT-OTHER keep notes", name: "other" });
	const index = makeJob({ id: "cron-00000000000000000000000000000abc", cwd, prompt: "PROMPT-INDEX keep notes", name: "index" });
	const ownFile = path.join(stores.jobs.notesDir(own.id), "prs.md");
	// The other loop's run climbs out of its own notes directory into this one's.
	const planted = `${stores.jobs.notesDir(other.id)}${path.sep}..${path.sep}${own.id}${path.sep}planted.md`;
	const { real, modelLog, fake } = await standIn(dir, "<loop-state>see prs.md</loop-state>", stores.inbox, { loopsDir: dir, script: [
		{ match: "PROMPT-OWN", tool: "write", args: { path: ownFile, content: "PR #12: red since 11-12\n" } },
		{ match: "PROMPT-OTHER", tool: "write", args: { path: planted, content: "planted" } },
		{ match: "PROMPT-INDEX", tool: "write", args: { path: stores.jobs.statePath(index.id), content: "forged index" } },
	] });
	try {
		const runOf = async (job: LoopJob, id: string) => {
			await stores.jobs.add(job);
			const row: UnclaimedRow = { v: 3, id, lane: `@${job.id}`, kind: "input", source: `cron:${job.id}`, mode: "unattended", wake: "turn", payload: { text: "x", cwd }, created_at: stamp(now), created_by: createdBy, attempts: 0 };
			stores.requests.append(row);
			const claimed = deps.runs.claim(stores.requests, row, deps.holder(), { jobId: job.id, label: job.name!, promptPreview: "x", ctrl: new AbortController() }, now)!;
			await runLoop(claimed, job, { ...deps, runner: real, session: () => ({ sessionId: "s1", cwd }) });
		};
		await runOf(own, "run-00000000000000000000000000000001");
		assert.equal(fs.readFileSync(ownFile, "utf8"), "PR #12: red since 11-12\n", "the write into its own notes directory went through");
		await runOf(other, "run-00000000000000000000000000000002");
		assert.equal(fs.existsSync(path.join(stores.jobs.notesDir(own.id), "planted.md")), false, "another loop's notes directory, reached by ../ out of its own, is refused");
		await runOf(index, "run-00000000000000000000000000000003");
		assert.equal(stores.jobs.readState(index.id), "see prs.md", "the index is written by pi-loops alone: the model's write was refused");
		const toolResults = fs.readFileSync(modelLog, "utf8").trim().split("\n").map((line) => JSON.parse(line)).flatMap((body) => body.messages.filter((m: any) => m.role === "tool").map((m: any) => String(m.content)));
		assert.equal(toolResults.filter((text) => text.startsWith("refused by pi-loops: reads or writes pi-loops' own files")).length, 2, "two refusals: the other loop's notes and the index");
		assert.deepEqual(stores.inbox.list().filter((f) => f.ask), [], "no question is filed");
	} finally {
		fake.kill();
	}
});
