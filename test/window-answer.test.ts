/**
 * A yes in an open conversation runs in the window that holds it (M5b.3b; design 6.4, "It runs in this
 * conversation after the current turn"; answer protocol sections E, F, C and H1 for a window). The
 * window here is the real `WindowExecutor`, `windowGuard` and `createWindowAnswers` over real stores
 * and a real session file, with pi stood in for: a turn is its custom message written into the
 * session, the model's calls go through the guard, and `agent_settled` is called by hand.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { type Answerer, type Answers, conversationFile, createAnswers } from "../src/answers.ts";
import { WHY, answerRow, answerRowId, answerStep, besideId } from "../src/ask.ts";
import { loadConfig } from "../src/config.ts";
import { DEAD_AFTER_ATTEMPTS, type EngineSinks, drain, plainJobRow, plainRunId, sessionFileEntries } from "../src/engine.ts";
import { createHostRuntime } from "../src/host-runtime.ts";
import type { InboxEntry } from "../src/inbox.ts";
import { LeaseBinding, LeaseStore, procStart } from "../src/lease.ts";
import { RunList } from "../src/run-list.ts";
import type { RunnerResult, SubagentRequest, SubagentRunner } from "../src/runner.ts";
import { stamp } from "../src/schedule.ts";
import type { LoopJob, RunRecord } from "../src/store.ts";
import { openStores } from "../src/stores.ts";
import { checkSessionDir } from "../src/check-run.ts";
import { checkLane } from "../src/lane.ts";
import { RUNTIME_RIDERS } from "../src/ticker.ts";
import { answerTurnEnd } from "../src/window-claim.ts";
import { WindowExecutor, createWindowAnswers, turnJob, windowGuard } from "../src/window-executor.ts";
import { tmp } from "./tmp.ts";

/** The policy asks about `| eval`. */
const CMD = "echo ran >> marker.txt | eval";
const JOB = "cron-fedcba9876543210fedcba9876543210";
const MAYBE = "The command may or may not have run.";

/** A call of a tool other than bash, as the model makes it. */
/** A tool call; `parentToolCallId` makes it a nested call, made inside another tool's call. */
type ToolUse = { toolName: string; input: Record<string, unknown>; parentToolCallId?: string };

/** A pid no process has: a child that ran and exited. */
const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid!;

/** A conversation of the project, written as pi writes one, and its plain job. */
function conversation(dir: string, cwd: string) {
	const sm = SessionManager.create(cwd, path.join(dir, "conversations"));
	sm.appendModelChange("fake", "fake-model");
	sm.appendMessage({ role: "user", content: "earlier", timestamp: Date.now() } as any);
	sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: Date.now() } as any);
	return { sm, sessionId: sm.getSessionId(), file: sm.getSessionFile()! };
}

const plainJob = (sessionId: string, cwd: string): LoopJob => ({ id: JOB, name: "deploy-check", schedule: { kind: "every", ms: 3_600_000 }, stateful: false, sessionId, prompt: "check the deploy", cwd, enabled: true, catchUp: false, createdAt: stamp(Date.now() - 3_700_000), runCount: 0, skippedOverlap: 0 }) as LoopJob;

/**
 * One window on the conversation `sm`, in a loops directory: what pi-loops wires in a window
 * (src/pi-loops.ts), over a pi that is stood in for. `holder` is the process its claims name.
 */
function window(dir: string, cwd: string, sm: SessionManager, opts: { holder: { pid: number; procStart: string | undefined }; instance: string }) {
	const stores = openStores(dir);
	const sessionId = sm.getSessionId();
	const file = sm.getSessionFile()!;
	const leases = new LeaseStore(dir);
	const binding = new LeaseBinding(leases, opts.instance, () => ({ kind: "terminal", pid: opts.holder.pid, ...(opts.holder.procStart ? { procStart: opts.holder.procStart } : {}), mode: "tui", pushServers: [] }));
	binding.bind(sessionId, { sessionFile: file, cwd });
	const sent: any[] = [];
	const state = { idle: true, aborts: 0 };
	const logs: string[] = [];
	const ctx = { mode: "tui", hasUI: false, cwd, isIdle: () => state.idle, hasPendingMessages: () => false, sessionManager: sm, ui: { notify: () => undefined }, abort: () => void state.aborts++ } as any;
	const runs = new RunList();
	const executor = new WindowExecutor({ sendMessage: (message: any) => void sent.push(message), sendUserMessage: () => undefined }, binding, () => ctx, { pid: opts.holder.pid, procStart: opts.holder.procStart }, () => true, () => stores.requests.list(sessionId), () => [], () => stores.jobs.allRuns(), undefined, (runId) => runs.get(runId) !== undefined);
	const answers: Answers = createAnswers({
		inbox: stores.inbox, requests: stores.requests, jobs: stores.jobs, audit: stores.rules,
		sessionFile: conversationFile(leases, undefined), entries: (f) => (fs.existsSync(f) ? sessionFileEntries(f) : undefined),
		checkSessionDir: (c) => checkSessionDir(stores.jobs, c), checkLaneOf: checkLane, runEnd: () => undefined,
		self: () => ({ pid: opts.holder.pid, instance: opts.instance, version: "0" }), now: Date.now, log: (line) => void logs.push(line),
	});
	const windowAnswers = createWindowAnswers({ answers, requests: stores.requests, runs, executor, here: () => ({ sessionId: binding.here().sessionId, cwd, sessionFile: file }), jobs: () => stores.book().jobs, holder: () => opts.holder, log: (line) => void logs.push(line) });
	const guard = windowGuard({
		current: () => executor.currentTurn(),
		config: () => ({ allowCommands: [], loopsDir: dir }),
		log: (line) => void logs.push(line),
		inbox: stores.inbox,
		now: Date.now,
		jobOf: (rowId, sid) => turnJob(rowId, stores.jobs.load(), stores.requests.list(sid), stores.clock.read().jobs),
		answerTurn: (cap) => windowAnswers.seat(cap),
	});
	/** The commands the guard let through: what ran. */
	const ran: string[] = [];
	let calls = 0;
	/** pi starts `message` (a turn row's custom message) as a run, writes it, and the model makes `commands` (a bash command, or another tool's call), each through the guard. */
	async function piRuns(message: any, commands: Array<string | ToolUse>): Promise<Array<{ block?: boolean; reason?: string } | undefined>> {
		state.idle = false;
		executor.agentStarted(Date.now());
		executor.messageStarted({ role: "custom", ...message });
		const ended = executor.messageEnded({ role: "custom", ...message }) ?? { message: { role: "custom", ...message } };
		sm.appendCustomMessageEntry(message.customType, message.content, true, (ended.message as any).details);
		const verdicts = [];
		for (const command of commands) verdicts.push(await modelCalls(command));
		executor.agentEnded();
		return verdicts;
	}
	/** The model makes one call in the run going now, through the guard, and its result is written: a bash command, or `{ toolName, input }`. `ran` gets the command, or `<tool> <input as JSON>`. */
	async function modelCalls(use: string | ToolUse): Promise<{ block?: boolean; reason?: string } | undefined> {
		const id = `call-${opts.instance}-${++calls}`;
		const { toolName, input, parentToolCallId } = typeof use === "string" ? { toolName: "bash", input: { command: use }, parentToolCallId: undefined } : use;
		sm.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name: toolName, arguments: input }], timestamp: Date.now() } as any);
		const verdict = await guard({ toolName, toolCallId: id, ...(parentToolCallId ? { parentToolCallId } : {}), input }, { cwd, sessionManager: sm });
		if (!verdict?.block) ran.push(typeof use === "string" ? use : `${toolName} ${JSON.stringify(input)}`);
		sm.appendMessage({ role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text: verdict?.reason ?? "ran" }], isError: verdict?.block === true, timestamp: Date.now() } as any);
		return verdict;
	}
	/** `agent_settled`, as pi-loops handles it: the executor first, then the answers. */
	async function piSettles(aborted = false): Promise<void> {
		state.idle = true;
		executor.settled(aborted);
		await windowAnswers.settled(aborted, Date.now());
	}
	/** The scheduled turn of the conversation's plain job, handed to the idle pi and run: its `CMD` is asked about (M5b.3a). */
	async function scheduledTurnAsks(): Promise<InboxEntry> {
		const row = plainJobRow(plainJob(sessionId, cwd), plainRunId(JOB, stamp(Date.now() - 30_000)), `cron:${JOB}`, "", { pid: opts.holder.pid, instance: opts.instance, version: "0" } as any);
		stores.requests.appendIfAbsent(row);
		assert.equal(executor.turn(row), "sent");
		const [verdict] = await piRuns(sent.at(-1), [CMD]);
		assert.match(verdict?.reason ?? "", /^asked a person/);
		stores.requests.remove(sessionId, [row.id]);
		await piSettles();
		const question = stores.inbox.list().find((f) => f.ask);
		assert.ok(question, "the scheduled turn asked");
		assert.deepEqual([question.lane, question.ask!.session_id], [sessionId, sessionId]);
		return question;
	}
	const answerMessages = () => sent.filter((m) => String(m.details?.piLoopsRow?.id ?? "").startsWith("ans-"));
	const answerRecords = (): RunRecord[] => stores.jobs.allRuns().filter((r) => r.cause === "answer");
	const find = (id: string) => stores.inbox.list().find((f) => f.id === id);
	return { stores, sessionId, file, binding, executor, windowAnswers, answers, runs, sent, state, logs, ran, piRuns, modelCalls, piSettles, scheduledTurnAsks, answerMessages, answerRecords, find };
}

const person = (sessionId: string): Answerer => ({ by: "terminal", session: sessionId });

function setup() {
	const dir = tmp("pi-loops-window-answer-");
	const cwd = path.join(dir, "proj");
	fs.mkdirSync(cwd, { recursive: true });
	const conv = conversation(dir, cwd);
	return { dir, cwd, ...conv };
}

test("[M5b.3b] [E4w] [C3w] a yes to a question a window's scheduled turn asked runs in that window once pi is idle: one turn, the granted call once and the same call asked again, done with its record, no news, the row gone", async () => {
	const { dir, cwd, sm, sessionId, file } = setup();
	const w = window(dir, cwd, sm, { holder: { pid: process.pid, procStart: procStart(process.pid) }, instance: "w1" });
	await w.stores.jobs.add(plainJob(sessionId, cwd));
	const question = await w.scheduledTurnAsks();
	assert.equal((await w.answers.say(question.id, "yes", person(sessionId))).said, "Y1");
	const rowId = answerRowId(question.id);

	const met = await w.windowAnswers.tick(Date.now());
	assert.deepEqual(met.map((m) => m.met), ["E4"]);
	assert.equal(w.answerMessages().length, 1, "one turn handed to pi");
	const [turn] = w.answerMessages();
	assert.equal(turn.customType, "pi-loops:turn");
	assert.ok(turn.content.startsWith(`[Trigger ${rowId}] A person said yes to the call you asked about`));
	assert.deepEqual([turn.details.cap.mode, w.stores.requests.list(sessionId)[0]?.run?.id, w.find(question.id)?.answer?.state], ["unattended", rowId, "started"]);

	const verdicts = await w.piRuns(turn, [CMD, CMD]);
	assert.deepEqual(w.ran, [CMD], "the granted call ran once");
	assert.match(verdicts[1]?.reason ?? "", /^asked a person/, "the same call again is told it is asked");
	await w.piSettles();

	const answered = w.find(question.id)!;
	assert.equal(answered.answer?.state, "done");
	const [record, ...more] = w.answerRecords();
	assert.equal(more.length, 0, "one record");
	assert.deepEqual(
		{ runId: record?.runId, cause: record?.cause, ok: record?.ok, grant_used: record?.grant_used, resumed: record?.resumed, sessionFile: record?.sessionFile, stateful: record?.stateful, jobId: record?.jobId, requestedBy: record?.requestedBy },
		{ runId: rowId, cause: "answer", ok: true, grant_used: true, resumed: file, sessionFile: file, stateful: false, jobId: JOB, requestedBy: { sessionId } },
	);
	assert.equal(w.find(besideId(question.id, "outcome")), undefined, "done files no news");
	assert.deepEqual(w.stores.requests.list(sessionId), [], "the row is gone");
	assert.equal(w.runs.all().length, 0);
	const asks = w.stores.inbox.list().filter((f) => f.ask);
	assert.deepEqual(asks.map((f) => f.status), ["claimed", "new"], "the same call again is a second question (docs/design.md), open for the person");

	await w.windowAnswers.tick(Date.now());
	await w.piSettles();
	assert.deepEqual([w.answerMessages().length, w.answerRecords().length], [1, 1], "nothing more");
});

test("[M5b.3b] a nested dangerous call in a window's scheduled turn is refused as in the background, and files no question", async () => {
	const { dir, cwd, sm, sessionId } = setup();
	const w = window(dir, cwd, sm, { holder: { pid: process.pid, procStart: procStart(process.pid) }, instance: "w1" });
	await w.stores.jobs.add(plainJob(sessionId, cwd));
	const row = plainJobRow(plainJob(sessionId, cwd), plainRunId(JOB, stamp(Date.now() - 30_000)), `cron:${JOB}`, "", { pid: process.pid, instance: "w1", version: "0" } as any);
	w.stores.requests.appendIfAbsent(row);
	assert.equal(w.executor.turn(row), "sent");
	const [verdict] = await w.piRuns(w.sent.at(-1), [{ toolName: "bash", input: { command: CMD }, parentToolCallId: "outer-1" }]);
	assert.match(verdict?.reason ?? "", /^refused by pi-loops: .* This run is unattended/);
	assert.deepEqual([w.ran, w.stores.inbox.list().filter((f) => f.ask)], [[], []], "nothing ran and nobody was asked");
});

test("[M5b.3b] a nested call in the answer's turn is refused as in the background: no question, and the grant is left for the call itself", async () => {
	const { dir, cwd, sm, sessionId } = setup();
	const w = window(dir, cwd, sm, { holder: { pid: process.pid, procStart: procStart(process.pid) }, instance: "w1" });
	await w.stores.jobs.add(plainJob(sessionId, cwd));
	const question = await w.scheduledTurnAsks();
	assert.equal((await w.answers.say(question.id, "yes", person(sessionId))).said, "Y1");
	await w.windowAnswers.tick(Date.now());
	const [turn] = w.answerMessages();
	const asksBefore = w.stores.inbox.list().filter((f) => f.ask).length;
	const verdicts = await w.piRuns(turn, [{ toolName: "bash", input: { command: CMD }, parentToolCallId: "outer-1" }, CMD]);
	assert.equal(verdicts[0]?.block, true, "the nested call is blocked");
	assert.match(verdicts[0]?.reason ?? "", /^refused by pi-loops: .* This run is unattended/, "refused as a nested call in the background is (no-transcript)");
	assert.equal(w.stores.inbox.list().filter((f) => f.ask).length, asksBefore, "no question is filed");
	assert.equal(verdicts[1], undefined, "the grant is still there for the call itself");
	assert.deepEqual(w.ran, [CMD], "only the granted call ran, once");
	await w.piSettles();
	assert.equal(w.answerRecords()[0]?.grant_used, true);
});

test("[M5b.9] a yes to a control-plane call a window's scheduled turn asked about runs that one call in the window, also when the job declares its tools", async () => {
	const { dir, cwd, sm, sessionId } = setup();
	const w = window(dir, cwd, sm, { holder: { pid: process.pid, procStart: procStart(process.pid) }, instance: "w1" });
	const job = { ...plainJob(sessionId, cwd), tools: ["read"] };
	await w.stores.jobs.add(job);
	const remove: ToolUse = { toolName: "cron_remove", input: { ref: "old-watch" } };
	const row = plainJobRow(job, plainRunId(JOB, stamp(Date.now() - 30_000)), `cron:${JOB}`, "", { pid: process.pid, instance: "w1", version: "0" } as any);
	w.stores.requests.appendIfAbsent(row);
	assert.equal(w.executor.turn(row), "sent");
	const [asked] = await w.piRuns(w.sent.at(-1), [remove]);
	assert.match(asked?.reason ?? "", /^asked a person: changes what pi-loops runs: cron_remove \{"ref":"old-watch"\}/);
	w.stores.requests.remove(sessionId, [row.id]);
	await w.piSettles();
	const question = w.stores.inbox.list().find((f) => f.ask)!;
	assert.deepEqual([question.ask?.call.tool, question.ask?.call.command], ["cron_remove", undefined]);
	assert.deepEqual(w.ran, [], "the call did not run");

	assert.equal((await w.answers.say(question.id, "yes", person(sessionId))).said, "Y1");
	await w.windowAnswers.tick(Date.now());
	const [turn] = w.answerMessages();
	assert.ok(turn, "the yes is handed to pi as a turn, not closed refused");
	await w.piRuns(turn, [remove]);
	await w.piSettles();
	assert.deepEqual(w.ran, ['cron_remove {"ref":"old-watch"}'], "the granted call ran once");
	assert.equal(w.find(question.id)?.answer?.state, "done");
});

test("[M5b.3b] a yes that arrives while a turn runs waits for that turn to settle, then runs once", async () => {
	const { dir, cwd, sm, sessionId } = setup();
	const w = window(dir, cwd, sm, { holder: { pid: process.pid, procStart: procStart(process.pid) }, instance: "w1" });
	await w.stores.jobs.add(plainJob(sessionId, cwd));
	const question = await w.scheduledTurnAsks();
	// The person's own turn is on.
	w.state.idle = false;
	w.executor.agentStarted(Date.now());
	assert.equal((await w.answers.say(question.id, "yes", person(sessionId))).said, "Y1");
	const met = await w.windowAnswers.drain(Date.now());
	assert.deepEqual(met.map((m) => [m.met, m.met === "hold" && m.why]), [["hold", "pi is busy: it runs after the current turn"]]);
	assert.equal(w.answerMessages().length, 0, "nothing is handed during the turn");
	assert.deepEqual(w.stores.requests.list(sessionId).map((r) => [r.run, r.waiting]), [[undefined, "pi is busy: it runs after the current turn"]]);
	assert.equal(w.find(question.id)?.answer?.state, "pending");

	w.executor.agentEnded();
	await w.piSettles();
	assert.deepEqual((await w.windowAnswers.drain(Date.now())).map((m) => m.met), ["E4"]);
	assert.equal(w.answerMessages().length, 1);
	await w.piRuns(w.answerMessages()[0], [CMD]);
	await w.piSettles();
	assert.deepEqual([w.ran, w.find(question.id)?.answer?.state, w.answerRecords().length], [[CMD], "done", 1]);
});

test("[M5b.3b] [H1w] [no-row-window] a pending yes whose row was lost gets its row back at the window's next tick, then runs once when pi is idle", async () => {
	const { dir, cwd, sm, sessionId } = setup();
	const w = window(dir, cwd, sm, { holder: { pid: process.pid, procStart: procStart(process.pid) }, instance: "w1" });
	await w.stores.jobs.add(plainJob(sessionId, cwd));
	const question = await w.scheduledTurnAsks();
	w.state.idle = false;
	w.executor.agentStarted(Date.now());
	assert.equal((await w.answers.say(question.id, "yes", person(sessionId))).said, "Y1");
	const rowId = answerRowId(question.id);
	w.stores.requests.remove(sessionId, [rowId]);
	assert.deepEqual([w.stores.requests.list(sessionId), w.find(question.id)?.answer?.state], [[], "pending"], "a pending answer with no row");

	const met = await w.windowAnswers.tick(Date.now());
	assert.deepEqual(w.stores.requests.list(sessionId).map((r) => [r.id, r.run]), [[rowId, undefined]], "the tick puts the row back");
	assert.deepEqual(met.map((m) => m.met), ["hold"], "and it waits for the turn that runs");
	assert.equal(w.answerMessages().length, 0);

	w.executor.agentEnded();
	await w.piSettles();
	assert.deepEqual((await w.windowAnswers.drain(Date.now())).map((m) => m.met), ["E4"]);
	assert.equal(w.answerMessages().length, 1, "one turn handed to pi");
	await w.piRuns(w.answerMessages()[0], [CMD]);
	await w.piSettles();
	assert.deepEqual([w.ran, w.find(question.id)?.answer?.state, w.answerRecords().length], [[CMD], "done", 1], "the granted call ran once and the answer is done");
	assert.deepEqual(w.stores.requests.list(sessionId), [], "the row is gone");
});

test("[M5b.3b] the person stops the answer's turn: it closes unfinished, stopped by a person, with the careful news once", async () => {
	const { dir, cwd, sm, sessionId } = setup();
	const w = window(dir, cwd, sm, { holder: { pid: process.pid, procStart: procStart(process.pid) }, instance: "w1" });
	await w.stores.jobs.add(plainJob(sessionId, cwd));
	const question = await w.scheduledTurnAsks();
	await w.answers.say(question.id, "yes", person(sessionId));
	await w.windowAnswers.drain(Date.now());
	await w.piRuns(w.answerMessages()[0], []);
	await w.piSettles(true);

	const answered = w.find(question.id)!;
	assert.deepEqual([answered.answer?.state, answered.answer?.state === "unfinished" && answered.answer.why], ["unfinished", WHY.stopped]);
	const [record] = w.answerRecords();
	assert.deepEqual([record?.aborted, record?.stoppedBy, record?.grant_used, record?.ok], [true, "person", false, false]);
	const news = w.stores.inbox.list().filter((f) => f.id === besideId(question.id, "outcome"));
	assert.equal(news.length, 1);
	assert.ok(news[0].text.endsWith(MAYBE), "its prompt is in the conversation: the careful sentence");
	assert.deepEqual([w.stores.requests.list(sessionId), w.ran], [[], []]);
	await w.windowAnswers.tick(Date.now());
	assert.deepEqual([w.answerMessages().length, w.answerRecords().length], [1, 1], "a stopped yes is spent");
});

test("[M5b.3b] a window that dies during the answer's turn: the next window closes it by F2, once, with the careful news, and the call does not run again", async () => {
	const { dir, cwd, sm, sessionId, file } = setup();
	const first = window(dir, cwd, sm, { holder: { pid: deadPid(), procStart: undefined }, instance: "w1" });
	await first.stores.jobs.add(plainJob(sessionId, cwd));
	const question = await first.scheduledTurnAsks();
	await first.answers.say(question.id, "yes", person(sessionId));
	await first.windowAnswers.drain(Date.now());
	await first.piRuns(first.answerMessages()[0], [CMD]);
	assert.deepEqual(first.ran, [CMD], "the granted call ran before the window died");
	// The window is gone: no settle, no closing. pi opens the conversation again in another window.
	const second = window(dir, cwd, SessionManager.open(file), { holder: { pid: process.pid, procStart: procStart(process.pid) }, instance: "w2" });
	assert.equal(second.binding.here().holds, true, "the lease is taken from the dead pid");
	assert.deepEqual((await second.windowAnswers.tick(Date.now())).map((m) => [m.met, m.met === "F2" && m.state]), [["F2", "unfinished"]]);

	const answered = second.find(question.id)!;
	assert.deepEqual([answered.answer?.state, answered.answer?.state === "unfinished" && answered.answer.why], ["unfinished", WHY.died]);
	const news = second.stores.inbox.list().filter((f) => f.id === besideId(question.id, "outcome"));
	assert.equal(news.length, 1);
	assert.ok(news[0].text.endsWith(MAYBE), "the prompt is in the conversation, so the command may have run");
	assert.deepEqual(second.answerRecords().map((r) => [r.runId, r.interrupted]), [[answerRowId(question.id), true]]);
	assert.deepEqual(second.stores.requests.list(sessionId), []);

	await second.windowAnswers.tick(Date.now());
	await second.piSettles();
	assert.deepEqual([second.answerMessages().length, second.answerRecords().length, second.stores.inbox.list().filter((f) => f.id === besideId(question.id, "outcome")).length], [0, 1, 1], "closed once, and no turn of it again");
	assert.deepEqual([...first.ran, ...second.ran], [CMD]);
});

/** A runner that records the answer runs it is asked for and runs none. */
function recordingRunner() {
	const calls: SubagentRequest[] = [];
	const runner: SubagentRunner = (req) => {
		calls.push(req);
		return Promise.resolve({ ok: true, exitCode: 0, timedOut: false, text: "", usage: { input: 1, output: 1, cost: 0, turns: 1 } } as RunnerResult);
	};
	return { runner, answerCalls: () => calls.filter((req) => req.prompt.includes("[Trigger ans-")) };
}

test("[M5b.3b] the background meets its own orphaned answer claim in an open conversation by F1, F2 and F3, and never starts the yes there", async () => {
	const { dir, cwd, sessionId, file } = setup();
	const stores = openStores(dir);
	const r = recordingRunner();
	const host = createHostRuntime({ dir, stores, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: r.runner, mcpTools: () => [], log: () => undefined });
	const tick = async (now = Date.now()): Promise<void> => {
		for (const name of RUNTIME_RIDERS) await host.riders[name](now, { startedAt: 0, tickMs: 30_000 });
	};
	try {
		// A window holds the conversation.
		const binding = new LeaseBinding(new LeaseStore(dir), "w1", () => ({ kind: "terminal", pid: process.pid, mode: "tui", pushServers: [] }));
		binding.bind(sessionId, { sessionFile: file, cwd });
		const finding = await stores.inbox.append({ source: "cron:deploy-check", text: "the deploy is stale", run_id: "run-1", cwd, kind: "news", lane: sessionId });
		assert.equal((await host.answers.say(finding.id, "yes", person(sessionId))).said, "Y1");
		const rowId = answerRowId(finding.id);
		const own = (at: number) => ({ id: rowId, pid: process.pid, procStart: procStart(process.pid), started_at: stamp(at) });

		// F1: a claim of this process with no run in its list, the answer still pending.
		assert.ok(stores.requests.claim(sessionId, rowId, own(Date.now()) as any));
		await tick();
		assert.deepEqual(stores.requests.list(sessionId).map((row) => [row.run, row.attempts]), [[undefined, 1]], "F1 took the claim off and counted it");
		await tick(Date.now() + 3_600_000);
		assert.deepEqual([stores.requests.list(sessionId).map((row) => row.run), r.answerCalls().length, stores.inbox.list().find((f) => f.id === finding.id)?.answer?.state], [[undefined], 0, "pending"], "the yes is never started while the window holds the conversation");

		// F2: the answer started under that claim, and its closing never ran.
		const claim = own(Date.now());
		await stores.inbox.section((tx) => {
			const step = answerStep("E4", tx.find(finding.id), { to: "started", run: claim } as any, { at: stamp(Date.now()), lane: sessionId as any });
			assert.ok(!("refused" in step));
			return tx.write(step as any);
		});
		assert.ok(stores.requests.claim(sessionId, rowId, claim as any));
		await tick();
		const closed = stores.inbox.list().find((f) => f.id === finding.id)!;
		assert.deepEqual([closed.answer?.state, closed.answer?.state === "unfinished" && closed.answer.why], ["unfinished", WHY.died]);
		assert.deepEqual(stores.jobs.allRuns().filter((rec) => rec.cause === "answer").map((rec) => [rec.runId, rec.interrupted]), [[rowId, true]]);
		assert.deepEqual(stores.requests.list(sessionId), [], "F2 removed the row");

		// F3: the row comes back with that claim after its closing (a stop between C3 and C4).
		stores.requests.appendIfAbsent({ ...answerRow(closed, sessionId as any, stamp(Date.now()), { pid: process.pid, instance: "host", version: "0" } as any), run: claim } as any);
		await tick();
		assert.deepEqual([stores.requests.list(sessionId), stores.jobs.allRuns().filter((rec) => rec.cause === "answer").length, r.answerCalls().length], [[], 1, 0], "F3 removed it, with no second record and no run");
	} finally {
		await host.stop();
	}
});

test("[M5b.3b] answerTurnEnd: a written turn ran, one pi still holds waits, any other is unwritten", () => {
	assert.deepEqual([answerTurnEnd(true, true), answerTurnEnd(true, false), answerTurnEnd(false, true), answerTurnEnd(false, false)], ["ran", "ran", "waits", "unwritten"]);
});


test("[M5b.3b] in a window's drain, an answer claim of this window holds the lane only while its run is listed; one whose closing threw holds nothing", () => {
	const self = { pid: process.pid, procStart: procStart(process.pid) };
	let listed = true;
	const executor = new WindowExecutor({ sendMessage: () => undefined, sendUserMessage: () => undefined }, { here: () => ({ sessionId: "s", holds: true }), hold: () => true, letGo: () => undefined }, () => undefined, self, () => true, () => [], () => [], () => [], undefined, () => listed);
	const row = { ...answerRow({ id: "inb-1", text: "x", cwd: "/p", claimed_by: "s" } as any, "s" as any, stamp(Date.now()), { pid: self.pid, instance: "w", version: "0" } as any), run: { id: "ans-1", pid: self.pid, procStart: self.procStart, started_at: stamp(Date.now()) } } as any;
	assert.equal(executor.view("s").claimLive(row), true, "its run is listed: the lane is held");
	listed = false;
	assert.equal(executor.view("s").claimLive(row), false, "its run left the list: nothing is held");
});

test("[M5b.3b] the window's one drain: an engine drain racing an answer drain hands pi one turn at a time, and the answer closes on its own turn's settle", async () => {
	const { dir, cwd, sm, sessionId } = setup();
	const w = window(dir, cwd, sm, { holder: { pid: process.pid, procStart: procStart(process.pid) }, instance: "w1" });
	const job = plainJob(sessionId, cwd);
	await w.stores.jobs.add(job);
	const question = await w.scheduledTurnAsks();
	const handed = w.sent.length;
	const by = { pid: process.pid, instance: "w1", version: "0" } as any;
	const now = Date.now();
	// A row the engine dead-letters, then the job's next turn: the engine reads both, and waits on the
	// dead letter (held at `gate`) between its read of the rows and its hand-over of the turn.
	w.stores.requests.appendIfAbsent({ ...plainJobRow(job, plainRunId(JOB, stamp(now - 60_000)), `cron:${JOB}`, "", by, now - 60_000), attempts: DEAD_AFTER_ATTEMPTS });
	const next = plainJobRow(job, plainRunId(JOB, stamp(now)), `cron:${JOB}`, "", by, now);
	w.stores.requests.appendIfAbsent(next);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	let parked!: () => void;
	const reached = new Promise<void>((resolve) => (parked = resolve));
	const sinks: EngineSinks = {
		jobs: { exists: (id) => w.stores.jobs.load().some((j) => j.id === id), enabled: (id) => w.stores.jobs.load().find((j) => j.id === id)?.enabled ?? false, goalActive: () => false },
		inbox: { appendOnce: (entry, key, o) => w.stores.inbox.appendOnce(entry, key, o), fileOnce: async (entry, id) => { parked(); await gate; return w.stores.inbox.fileOnce(entry, id); } },
		audit: w.stores.rules, ledger: w.stores.jobs, counts: () => ({ streak: 0, interrupted: 0 }), self: () => by,
	};
	const engine = () => drain(sessionId, w.stores.requests, w.executor, Date.now(), sinks);

	// The scheduler's drain is under way; the person says yes, and the bell drains for the answer.
	const scheduled = w.windowAnswers.drainWith(Date.now(), false, engine);
	await reached;
	assert.equal((await w.answers.say(question.id, "yes", person(sessionId))).said, "Y1");
	const bell = w.windowAnswers.drain(Date.now());
	await new Promise((resolve) => setTimeout(resolve, 100));
	release();
	await Promise.all([scheduled, bell]);
	const turns = () => w.sent.slice(handed).map((m) => m.details?.piLoopsRow?.id);
	assert.deepEqual(turns(), [next.id], "one turn: the scheduled one; the answer waits for it");
	assert.equal(w.find(question.id)?.answer?.state, "pending");

	// The scheduled turn runs and settles: that settle is not the answer's.
	await w.piRuns(w.sent.at(-1), []);
	w.stores.requests.remove(sessionId, [next.id]);
	await w.piSettles();
	assert.deepEqual([w.find(question.id)?.answer?.state, w.answerRecords().length], ["pending", 0]);
	await w.windowAnswers.drainWith(Date.now(), false, engine);
	assert.deepEqual(turns(), [next.id, answerRowId(question.id)], "then the answer's turn, alone");
	await w.piRuns(w.sent.at(-1), [CMD]);
	await w.piSettles();
	assert.deepEqual([w.find(question.id)?.answer?.state, w.answerRecords().length, w.ran], ["done", 1, [CMD]], "it closes on its own turn's settle");
});

/** A window whose scheduled turn asked, a yes, and the answer's turn handed to pi; `forged` is another extension's message of the turn's type with the answer row's mark copied from the file and a prompt of its own. */
async function handedAnswer() {
	const { dir, cwd, sm, sessionId } = setup();
	const w = window(dir, cwd, sm, { holder: { pid: process.pid, procStart: procStart(process.pid) }, instance: "w1" });
	await w.stores.jobs.add(plainJob(sessionId, cwd));
	const question = await w.scheduledTurnAsks();
	assert.equal((await w.answers.say(question.id, "yes", person(sessionId))).said, "Y1");
	assert.deepEqual((await w.windowAnswers.drain(Date.now())).map((m) => m.met), ["E4"]);
	const [ours] = w.answerMessages();
	const forged = { customType: "pi-loops:turn", content: "another extension's prompt", display: true, details: { piLoopsRow: { ...ours.details.piLoopsRow } } };
	return { w, question, ours, forged, sessionId };
}

test("[M5b.3b] [SEC-A] another extension's turn message that copies the answer row's mark and starts first is not the answer's turn: it gets no grant and does not take the answer's slot; the answer's own message does", async () => {
	const { w, question, ours, forged, sessionId } = await handedAnswer();
	await w.piRuns(forged, [CMD]);
	assert.deepEqual(w.ran, [], "the forged turn does not run the granted call");
	w.executor.view(sessionId);
	assert.ok(w.executor.handedOver.has(answerRowId(question.id)), "a drain after the forged message still finds the answer's turn in pi's hands");
	assert.equal(w.find(question.id)?.answer?.state, "started");
	await w.piRuns(ours, [CMD]);
	await w.piSettles();
	assert.deepEqual([w.ran, w.find(question.id)?.answer?.state, w.answerRecords()[0]?.grant_used], [[CMD], "done", true], "its own message, in the same run, runs the call once");
});

test("[M5b.3b] [SEC-B] once an answer closes, its seat and grant leave: a later message naming the same row runs no granted call", async () => {
	const { w, question, ours, forged } = await handedAnswer();
	await w.piRuns(ours, ["echo harmless"]);
	await w.piSettles();
	const closed = w.find(question.id)!;
	assert.deepEqual([closed.answer?.state, w.runs.all().length], ["unfinished", 0]);
	await w.piRuns(forged, [CMD]);
	await w.piSettles();
	assert.deepEqual(w.ran, ["echo harmless"], "the granted call does not run after the answer closed");
	assert.equal(w.answerRecords()[0]?.grant_used, false);
});

test("[M5b.3b] [SEC-D] a yes whose granted tool the job no longer declares closes refused, not run, and hands pi no turn", async () => {
	const { dir, cwd, sm, sessionId } = setup();
	const w = window(dir, cwd, sm, { holder: { pid: process.pid, procStart: procStart(process.pid) }, instance: "w1" });
	await w.stores.jobs.add({ ...plainJob(sessionId, cwd), builtinTools: ["bash", "read"] } as LoopJob);
	const question = await w.scheduledTurnAsks();
	await w.stores.jobs.update(JOB, (job) => {
		job.builtinTools = ["read"];
	});
	await w.answers.say(question.id, "yes", person(sessionId));
	assert.deepEqual((await w.windowAnswers.drain(Date.now())).map((m) => m.met), ["E4"]);
	assert.equal(w.answerMessages().length, 0, "no turn is handed");
	const answered = w.find(question.id)!;
	assert.deepEqual([answered.answer?.state, answered.answer?.state === "unfinished" && answered.answer.why], ["unfinished", "refused: bash is not among the tools the job declares now"]);
	const news = w.stores.inbox.list().filter((f) => f.id === besideId(question.id, "outcome"));
	assert.equal(news.length, 1);
	assert.ok(news[0].text.endsWith("The command was not run."));
	assert.deepEqual([w.ran, w.stores.requests.list(sessionId), w.runs.all().length], [[], [], 0]);
});

test("[M5b.3b] a yes whose plain job is disabled waits in the window, as the background holds a disabled loop's, and runs once the job is on", async () => {
	const { dir, cwd, sm, sessionId } = setup();
	const w = window(dir, cwd, sm, { holder: { pid: process.pid, procStart: procStart(process.pid) }, instance: "w1" });
	await w.stores.jobs.add(plainJob(sessionId, cwd));
	const question = await w.scheduledTurnAsks();
	await w.stores.jobs.update(JOB, (job) => {
		job.enabled = false;
	});
	await w.answers.say(question.id, "yes", person(sessionId));
	assert.deepEqual((await w.windowAnswers.drain(Date.now())).map((m) => [m.met, m.met === "hold" && m.why]), [["hold", "its job is disabled"]]);
	assert.deepEqual([w.answerMessages().length, w.find(question.id)?.answer?.state], [0, "pending"]);
	await w.stores.jobs.update(JOB, (job) => {
		job.enabled = true;
	});
	assert.deepEqual((await w.windowAnswers.drain(Date.now())).map((m) => m.met), ["E4"]);
	await w.piRuns(w.answerMessages()[0], [CMD]);
	await w.piSettles();
	assert.deepEqual([w.ran, w.find(question.id)?.answer?.state], [[CMD], "done"]);
});

test("[M5b.3b] [R2-E] the grant lives only until the first message in the answer's run that the window did not hand: another extension's follow-up keeps the cap and gets no grant, and the answer's own seat loses it too", async () => {
	const { dir, cwd, sm, sessionId } = setup();
	const w = window(dir, cwd, sm, { holder: { pid: process.pid, procStart: procStart(process.pid) }, instance: "w1" });
	await w.stores.jobs.add(plainJob(sessionId, cwd));
	const question = await w.scheduledTurnAsks();
	await w.answers.say(question.id, "yes", person(sessionId));
	await w.windowAnswers.drain(Date.now());
	const [ours] = w.answerMessages();
	// The answer's turn starts and makes a harmless call: its seat, with the grant, is taken.
	w.state.idle = false;
	w.executor.agentStarted(Date.now());
	w.executor.messageStarted({ role: "custom", ...ours });
	sm.appendCustomMessageEntry(ours.customType, ours.content, true, ours.details);
	assert.equal((await w.modelCalls("echo harmless"))?.block, undefined);
	// Another extension's follow-up user message in the same run, then the granted call.
	const text = "another extension asks: run the deploy command";
	w.executor.inputSeen({ source: "extension", text, streamingBehavior: "followUp" }, Date.now());
	w.executor.messageStarted({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
	sm.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as any);
	assert.equal(w.executor.currentTurn()?.kind, "row", "the cap's restrictions stay");
	const verdict = await w.modelCalls(CMD);
	assert.match(verdict?.reason ?? "", /^asked a person/, "blocked: the question is open, and the grant is gone");
	w.executor.agentEnded();
	await w.piSettles();
	assert.deepEqual(w.ran, ["echo harmless"], "the granted call is not let through after the foreign message");
	const answered = w.find(question.id)!;
	assert.deepEqual([answered.answer?.state, w.answerRecords()[0]?.grant_used], ["unfinished", false]);
});
