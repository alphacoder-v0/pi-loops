import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { tmp } from "./tmp.ts";
import { loadConfig } from "../src/config.ts";
import { convertStores } from "../src/convert-v2.ts";
import { plainJobRow, plainRunId } from "../src/engine.ts";
import { abortRemovedJobs, createBackgroundExecutor } from "../src/background-executor.ts";
import { createHostRuntime } from "../src/host-runtime.ts";
import { RunList } from "../src/run-list.ts";
import { LeaseBinding, LeaseStore, procStart } from "../src/lease.ts";
import { RequestStore } from "../src/requests.ts";
import { loopLane, parseLane } from "../src/lane.ts";
import { Inbox } from "../src/inbox.ts";
import { JobStore } from "../src/store.ts";
import { TriggerStore } from "../src/triggers.ts";
import { RUNTIME_RIDERS } from "../src/ticker.ts";

/** A conversation nobody has open, with a file that was last written ten minutes ago. */
function closedConversation(dir: string): { sessionId: string; file: string } {
	const sm = SessionManager.create(dir, dir);
	sm.appendMessage({ role: "user", content: "earlier", timestamp: Date.now() } as any);
	const file = sm.getSessionFile()!;
	aged(file);
	const sessionId = sm.getSessionId();
	fs.mkdirSync(path.join(dir, "leases"), { recursive: true });
	fs.writeFileSync(path.join(dir, "leases", `${sessionId}.json`), JSON.stringify({ v: 1, sessionId, sessionFile: file, cwd: dir, epoch: 1, holder: null, updatedAt: new Date().toISOString() }));
	return { sessionId, file };
}
function aged(file: string): void {
	const old = new Date(Date.now() - 10 * 60_000);
	fs.utimesSync(file, old, old);
}

const USAGE = { input: 1, output: 1, cost: 0.01, turns: 1 };
/** What the runner of a held turn does first: the prompt is a user message in the conversation's file. */
const writes = (req: any): void => void SessionManager.open(req.sessionFile).appendMessage({ role: "user", content: req.prompt, timestamp: Date.now() } as any);
const ok = (req: any) => {
	writes(req);
	return { ok: true, exitCode: 0, timedOut: false, text: "done", usage: USAGE };
};
const fails = (message: string, opts: { written: boolean }) => (req: any) => {
	if (opts.written) writes(req);
	return { ok: false, exitCode: 1, timedOut: false, text: "", errorMessage: message, usage: USAGE };
};
/** The words the runner gives a turn it stopped for the daily budget: one of the ways pi-loops stops a turn itself. */
const BUDGET = "stopped by today's budget";

/** pi-loops in the background over one closed conversation, with a scripted runner. */
function scene(script: (req: any, call: number) => any, over: Partial<Parameters<typeof createHostRuntime>[0]> = {}) {
	const dir = tmp("pi-loops-bg-");
	const { sessionId, file } = closedConversation(dir);
	const calls: any[] = [];
	const logs: string[] = [];
	const runner = async (req: any) => {
		calls.push(req);
		return script(req, calls.length);
	};
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner, mcpTools: () => [], log: (line) => void logs.push(line), ...over });
	const requests = new RequestStore(dir);
	const store = host.stores.jobs;
	// The old scheduler was ticked without start(), so these scenes judged no slot missed.
	const kick = async () => {
		const now = Date.now();
		const facts = { startedAt: 0, tickMs: 30_000 };
		for (const name of RUNTIME_RIDERS) await host.riders[name](now, facts);
	};
	return {
		dir,
		sessionId,
		file,
		calls,
		logs,
		host,
		requests,
		kick,
		tick: async () => {
			await kick();
			await host.drain(5000);
		},
		job: (id = "cron-held") => store.load().find((j) => j.id === id),
		runs: () => store.allRuns(),
		rows: () => requests.list(sessionId),
		/** How many times a prompt of this job is in the conversation. */
		prompts: () => SessionManager.open(file).getEntries().filter((e: any) => e.type === "message" && e.message?.role === "user" && String(e.message.content).includes("] remind me")).length,
		requestAudit: () => host.triggers.store.listAudit(20, (r) => r.type === "request").map((r) => r.state),
	};
}
type Scene = ReturnType<typeof scene>;

/** A plain job of the closed conversation whose slot is due now. `once` makes it a one-shot. */
const job = (s: Pick<Scene, "sessionId" | "dir">, over: Record<string, unknown> = {}) => ({ id: "cron-held", schedule: { kind: "every" as const, ms: 3_600_000 }, stateful: false, sessionId: s.sessionId, prompt: "remind me", cwd: s.dir, enabled: true, catchUp: false, createdAt: new Date(Date.now() - 3_700_000).toISOString(), runCount: 0, skippedOverlap: 0, ...over });
/** The same job with its slot not due: it fired a minute ago. */
const notDue = () => ({ lastDueAt: new Date(Date.now() - 60_000).toISOString(), lastFiredAt: new Date(Date.now() - 60_000).toISOString(), runCount: 1 });
/** A row of that job as a window's clock writes it, left in the queue when the window quit. */
const leftRow = (s: Scene, id: string, over: Record<string, unknown> = {}) => ({ ...plainJobRow(job(s) as any, id, "cron:cron-held", "", { pid: 1, instance: "w1", version: "0" }), ...over });

test("[clock-row] pi-loops in the background writes a due slot's row under its derived id and runs it as a held turn in the conversation's own file; a job whose conversation it does not know is not fired", async () => {
	const s = scene(ok);
	try {
		await s.host.stores.jobs.add(job(s, { tools: ["read"], builtinTools: ["grep"] }) as any);
		await s.host.stores.jobs.add(job(s, { id: "cron-nowhere", sessionId: "no-such-conversation" }) as any);
		await s.tick();
		assert.equal(s.calls.length, 1);
		const fired = s.job()!;
		const id = plainRunId("cron-held", fired.lastDueAt!);
		assert.deepEqual([s.calls[0].kind, s.calls[0].sessionFile, s.calls[0].prompt, s.calls[0].runId, s.calls[0].parentSessionId], ["held", s.file, `[Trigger ${id}] remind me`, id, s.sessionId]);
		// As the conversation's owner: the job's own tools, no trust that pi has not saved, the default limit of a turn.
		assert.deepEqual([s.calls[0].tools, s.calls[0].builtinTools, s.calls[0].trusted, s.calls[0].timeoutMs, s.calls[0].hop, s.calls[0].parentCwd], [["read"], ["grep"], false, 15 * 60_000, 1, s.dir]);
		const [record] = s.runs();
		assert.deepEqual([record.runId, record.jobId, record.ok, record.stateful, record.sessionFile, record.aborted], [id, "cron-held", true, false, s.file, undefined]);
		assert.deepEqual([record.usage, record.summary, record.forSession], [USAGE, "done", s.sessionId], "a turn was billed: its cost is in the run log");
		assert.deepEqual([fired.runCount, fired.lastCompletedAt, fired.running, fired.owedSlot, fired.lastError], [1, record.finishedAt, undefined, undefined, undefined]);
		assert.deepEqual([s.rows(), s.prompts()], [[], 1], "the row left once its prompt was in the conversation");
		assert.equal(new LeaseStore(s.dir).read(s.sessionId)?.holder, null, "the conversation is given back");
		const nowhere = s.job("cron-nowhere")!;
		assert.deepEqual([nowhere.runCount, nowhere.lastFiredAt], [0, undefined], "no file to write into: its slot is not spent");
		// The slot is spent: the next tick asks nothing.
		await s.tick();
		assert.deepEqual([s.calls.length, s.prompts()], [1, 1]);
	} finally {
		await s.host.stop();
	}
});

test("[turn-lease] [runs-list] [R1] [R2] while a held turn runs: its row has the claim, the lease is kept and names the run, and the status, the page and the sweep of unused leases find the run", async () => {
	let release: () => void = () => undefined;
	const gate = new Promise<void>((r) => (release = r));
	const during: any = {};
	const s = scene(async (req) => {
		writes(req);
		const leases = new LeaseStore(s.dir);
		during.claim = s.rows()[0]?.run;
		during.lease = leases.read(s.sessionId);
		during.held = s.host.heldTurn(s.sessionId);
		during.running = s.host.runs.all().map((r) => r.runId);
		// The lease has named this run for two minutes: a lease of a run that is not in the list would be given back at the tick.
		const file = path.join(s.dir, "leases", `${s.sessionId}.json`);
		const lease = JSON.parse(fs.readFileSync(file, "utf8"));
		lease.holder.busy.since = new Date(Date.now() - 120_000).toISOString();
		fs.writeFileSync(file, JSON.stringify(lease));
		await s.kick();
		during.afterTick = leases.read(s.sessionId)?.holder?.busy?.runId;
		await gate;
		return { ok: true, exitCode: 0, timedOut: false, text: "done", usage: USAGE };
	});
	try {
		await s.host.stores.jobs.add(job(s, { name: "reminder" }) as any);
		await s.kick();
		const began = Date.now();
		while (during.afterTick === undefined && Date.now() - began < 5000) await new Promise((r) => setTimeout(r, 20));
		const id = s.calls[0].runId;
		// R1: the claim is on the row before the runner is asked, with this process's identity.
		assert.deepEqual([during.claim.id, during.claim.pid, during.claim.procStart], [id, process.pid, procStart(process.pid)]);
		assert.equal(Number.isFinite(Date.parse(during.claim.started_at)), true);
		// R2 and turn-lease: the drain that started the turn has ended, and the lease is still this process's, naming the run.
		assert.deepEqual([during.lease.holder.kind, during.lease.holder.pid, during.lease.holder.busy.runId, during.lease.holder.busy.jobId], ["host", process.pid, id, "cron-held"]);
		// runs-list: one list answers the page, the status, and the sweep.
		assert.deepEqual(during.held, { runId: id, label: "reminder" });
		assert.deepEqual(during.running, [id]);
		assert.equal(during.afterTick, id, "a lease whose run is in the list is not given back, however long ago it was taken");
		release();
		await s.host.drain(5000);
		assert.deepEqual([s.rows(), s.host.heldTurn(s.sessionId), s.host.runs.all(), new LeaseStore(s.dir).read(s.sessionId)?.holder], [[], undefined, [], null]);
		assert.equal(s.runs()[0].startedAt, during.claim.started_at, "the record is the claim's: it starts with it");
	} finally {
		release();
		await s.host.stop();
	}
});

test("[take-back] a window that takes the conversation after the prompt was written stops the turn: the background writes nothing more into the conversation, the row is delivered, and one successor row asks again", async () => {
	let afterTake = "";
	let opened: ReturnType<typeof mock.method> | undefined;
	const s = scene((req) => {
		writes(req);
		new LeaseBinding(new LeaseStore(s.dir), "w1", () => ({ kind: "terminal", pid: process.pid, mode: "tui", pushServers: [] })).bind(s.sessionId, { sessionFile: s.file, cwd: s.dir });
		afterTake = fs.readFileSync(s.file, "utf8");
		// From here the conversation is the window's: an open by pi's session manager can write the file.
		opened = mock.method(SessionManager, "open");
		return { ok: false, exitCode: 1, timedOut: false, text: "", errorMessage: "taken back: a window opened this conversation", stopReason: "aborted", usage: USAGE };
	});
	try {
		await s.host.stores.jobs.add(job(s) as any);
		await s.tick();
		const opens = opened!.mock.callCount();
		opened!.mock.restore();
		assert.equal(opens, 0, "after the take-back the background reads the conversation as a plain file, and never opens it");
		const id = s.calls[0].runId;
		assert.equal(fs.readFileSync(s.file, "utf8"), afterTake, "the closing reads the conversation and does not write it");
		const [record] = s.runs();
		assert.deepEqual([record.runId, record.aborted, record.stoppedBy], [id, true, undefined]);
		const rows = s.rows();
		assert.deepEqual(rows.map((r) => [r.id, r.source, r.run, r.attempts]), [[plainRunId("cron-held", `after ${id}`), "cron:cron-held", undefined, 0]], "the row is gone, and one successor is queued for the window");
		const after = s.job()!;
		assert.deepEqual([after.runCount, after.owedSlot, after.consecutiveFailures, after.lastError], [1, undefined, undefined, undefined], "a hand-back is no failure, and the successor is the owed work");
		assert.equal(new LeaseStore(s.dir).read(s.sessionId)?.holder?.kind, "terminal", "the window keeps the conversation");
	} finally {
		await s.host.stop();
	}
});

test("a turn that fails after its prompt was written is a failed run: recorded, counted, its slot spent, and not asked again", async () => {
	const s = scene(fails("the model refused", { written: true }));
	try {
		await s.host.stores.jobs.add(job(s) as any);
		await s.tick();
		const [record] = s.runs();
		assert.deepEqual([record.ok, record.error, record.aborted], [false, "the model refused", undefined]);
		assert.deepEqual({ stateful: record.stateful, forSession: record.forSession, cost: record.usage?.cost }, { stateful: false, forSession: s.sessionId, cost: 0.01 });
		assert.equal(s.host.stores.jobs.spend(0).total, 0.01, "its cost counts in the spend the daily budget reads");
		const after = s.job()!;
		assert.deepEqual([after.runCount, after.consecutiveFailures, after.lastError, after.lastCompletedAt], [1, 1, "the model refused", record.finishedAt]);
		assert.deepEqual(s.rows(), []);
		await s.tick();
		assert.equal(s.calls.length, 1);
	} finally {
		await s.host.stop();
	}
});

test("[settle-one-shot] a one-shot whose turn fails is asked once more, by a successor row, and is retired after its second failure", async () => {
	const s = scene(fails("the model refused", { written: true }));
	try {
		await s.host.stores.jobs.add(job(s, { schedule: { kind: "once", at: Date.now() - 1_000 } }) as any);
		await s.tick();
		const first = s.calls[0].runId;
		assert.deepEqual(s.rows().map((r) => r.id), [plainRunId("cron-held", `after ${first}`)]);
		assert.deepEqual([s.job()?.consecutiveFailures, s.job()?.lastError], [1, "the model refused (one-shot: retrying once)"]);
		// The retry is a row: the next tick runs it, though no slot is due.
		await s.tick();
		assert.deepEqual([s.calls.length, s.calls[1].runId, s.rows(), s.job()], [2, plainRunId("cron-held", `after ${first}`), [], undefined], "the second failure retires it");
		assert.equal(s.runs().length, 2);
	} finally {
		await s.host.stop();
	}
});

test("a one-shot whose turn succeeds is retired when the turn ends", async () => {
	const s = scene(ok);
	try {
		await s.host.stores.jobs.add(job(s, { schedule: { kind: "once", at: Date.now() - 1_000 } }) as any);
		await s.tick();
		assert.deepEqual([s.calls.length, s.job(), s.rows(), s.prompts()], [1, undefined, [], 1]);
	} finally {
		await s.host.stop();
	}
});

test("a turn that pi-loops stops itself before its prompt is written leaves its row owed, and the next tick runs it though no slot is due and catch-up is off", async () => {
	const s = scene((req, call) => (call === 1 ? fails(BUDGET, { written: false })(req) : ok(req)));
	try {
		await s.host.stores.jobs.add(job(s) as any);
		await s.tick();
		const id = s.calls[0].runId;
		assert.deepEqual(s.rows().map((r) => [r.id, r.run, r.attempts, r.not_before]), [[id, undefined, 0, undefined]], "owed: the claim is cleared, and nothing is counted");
		assert.deepEqual([s.runs()[0].aborted, s.job()?.consecutiveFailures, s.job()?.runCount, s.requestAudit()], [true, undefined, 1, []]);
		await s.tick();
		assert.deepEqual([s.calls.length, s.calls[1].runId, s.rows(), s.prompts(), s.job()?.runCount], [2, id, [], 1, 1], "the same row runs again, and its slot is not counted twice");
		assert.deepEqual(s.runs().map((r) => [r.runId, r.aborted, r.ok]), [[id, true, false], [id, undefined, true]], "two records in the run log, with one run id");
	} finally {
		await s.host.stop();
	}
});

test("[settle-successor] a turn that pi-loops stops itself after its prompt was written is done, and one successor row asks again: not a successor and an owed slot", async () => {
	const s = scene((req, call) => (call === 1 ? fails(BUDGET, { written: true })(req) : ok(req)));
	try {
		await s.host.stores.jobs.add(job(s) as any);
		await s.tick();
		const id = s.calls[0].runId;
		const next = plainRunId("cron-held", `after ${id}`);
		assert.deepEqual([s.rows().map((r) => r.id), s.job()?.owedSlot, s.job()?.runCount], [[next], undefined, 1]);
		await s.tick();
		assert.deepEqual([s.calls.length, s.calls[1].runId, s.rows(), s.prompts()], [2, next, [], 2]);
	} finally {
		await s.host.stop();
	}
});

test("a row that a window left in the queue is run once, under its own id, though no slot is due", async () => {
	const s = scene(ok);
	try {
		await s.host.stores.jobs.add(job(s, notDue()) as any);
		s.requests.append(leftRow(s, "run-left"));
		await s.tick();
		assert.deepEqual([s.calls.length, s.calls[0].runId, s.calls[0].prompt, s.runs()[0].runId, s.rows()], [1, "run-left", "[Trigger run-left] remind me", "run-left", []]);
		assert.equal(s.job()?.runCount, 1, "the window counted its slot when it wrote the row");
		await s.tick();
		assert.equal(s.calls.length, 1);
	} finally {
		await s.host.stop();
	}
});

test("a row whose prompt is already in the conversation is done, not run again", async () => {
	const s = scene(ok);
	try {
		await s.host.stores.jobs.add(job(s, notDue()) as any);
		const left = leftRow(s, "run-left");
		SessionManager.open(s.file).appendMessage({ role: "user", content: "[Trigger run-left] remind me", piLoopsRow: { lane: s.sessionId, id: "run-left", at: left.created_at }, timestamp: Date.now() } as any);
		aged(s.file);
		s.requests.append(left);
		await s.tick();
		assert.deepEqual([s.calls.length, s.rows(), s.runs()], [0, [], []]);
	} finally {
		await s.host.stop();
	}
});

test("[ended-by-record] a turn that fails before its prompt is written spends its slot: the failure is recorded and counted, the row leaves, and the prompt is not asked again", async () => {
	const s = scene(fails("no credentials", { written: false }));
	try {
		await s.host.stores.jobs.add(job(s) as any);
		await s.tick();
		const [record] = s.runs();
		assert.deepEqual([record.ok, record.error, record.aborted, record.interrupted], [false, "no credentials", undefined, undefined]);
		assert.deepEqual([s.rows(), s.prompts(), s.requestAudit()], [[], 0, []], "no retry, no audit line, and no dead letter");
		assert.deepEqual([s.job()?.runCount, s.job()?.consecutiveFailures, s.job()?.lastError], [1, 1, "no credentials"]);
		assert.deepEqual(s.host.stores.inbox.list(), []);
		await s.tick();
		assert.equal(s.calls.length, 1);
	} finally {
		await s.host.stop();
	}
});

test("a slot waits behind a row of its job that backs off: no lease is taken, the slot is not spent, and the row keeps its attempts until its third, which is a dead letter", async () => {
	const s = scene(ok);
	try {
		await s.host.stores.jobs.add(job(s) as any);
		// The row of a turn whose process stopped twice before its prompt was written: it backs off.
		s.requests.append(leftRow(s, "run-left", { attempts: 2, last_error: "the process running it stopped", not_before: new Date(Date.now() + 5 * 60_000).toISOString() }));
		const epoch = new LeaseStore(s.dir).read(s.sessionId)?.epoch;
		await s.tick();
		assert.deepEqual([s.calls.length, s.rows().map((r) => [r.id, r.attempts]), s.job()?.lastFiredAt, s.job()?.skippedOverlap, new LeaseStore(s.dir).read(s.sessionId)?.epoch], [0, [["run-left", 2]], undefined, 0, epoch], "the due slot waits, and the conversation is not taken");
		// Its backoff is over, and the process that claims it stops a third time: the claim of a process that is gone.
		s.requests.update(s.sessionId, "run-left", { not_before: undefined });
		assert.equal(s.requests.claim(s.sessionId, "run-left", { id: "run-left", pid: 999_999_999, started_at: new Date().toISOString() } as any), true);
		await s.tick();
		const [letter] = s.host.stores.inbox.list();
		assert.deepEqual([letter.undelivered, letter.run_id, letter.session_id], [true, "run-left", s.sessionId]);
		assert.match(letter.text, /^could not be delivered \(failed 3 times: the process running it stopped\): remind me$/);
		assert.equal(s.rows().some((r) => r.id === "run-left"), false);
	} finally {
		await s.host.stop();
	}
});

test("a due slot is spent onto the row a window left, not run after it: one turn, and the overlap is counted", async () => {
	const s = scene(ok);
	try {
		await s.host.stores.jobs.add(job(s) as any);
		s.requests.append(leftRow(s, "run-left"));
		await s.tick();
		assert.deepEqual([s.calls.length, s.calls[0].runId, s.rows(), s.prompts()], [1, "run-left", [], 1]);
		assert.deepEqual([s.job()?.skippedOverlap, s.job()?.runCount, !!s.job()?.lastFiredAt], [1, 0, true], "the slot is spent as an overlap, with no row of its own");
	} finally {
		await s.host.stop();
	}
});

test("a /cron run row left queued in a closed conversation waits for a window and does not stop the job's schedule in the background", async () => {
	const s = scene(ok);
	try {
		await s.host.stores.jobs.add(job(s) as any);
		const asked = { ...plainJobRow(job(s) as any, "run-asked", "cron-run:cron-held", "", { pid: 1, instance: "w1", version: "0" }) };
		s.requests.append(asked);
		await s.tick();
		assert.equal(s.calls.length, 1, "the clock's slot runs");
		assert.notEqual(s.calls[0].runId, "run-asked");
		assert.deepEqual(s.rows().map((r) => [r.id, r.mode, r.run]), [["run-asked", "attended", undefined]], "the person's row is a window's to run");
		assert.deepEqual([s.job()?.runCount, s.job()?.skippedOverlap], [1, 0]);
	} finally {
		await s.host.stop();
	}
});

test("a rule's result that is queued while a held turn runs is not written beside it, and is written once the turn has ended", async () => {
	let release: () => void = () => undefined;
	const gate = new Promise<void>((r) => (release = r));
	const during: any = {};
	const s = scene(async (req) => {
		writes(req);
		const { ruleResultRow } = await import("../src/engine.ts");
		s.requests.append(ruleResultRow(s.sessionId, "[Trigger t-result] the deploy finished", { traceId: "t-result", sourceLabel: "local:dynamic", cwd: s.dir }, { pid: 1, instance: "w1", version: "0" }));
		await s.kick();
		during.rows = s.rows().map((r) => r.id);
		during.file = fs.readFileSync(s.file, "utf8").includes("the deploy finished");
		await gate;
		return { ok: true, exitCode: 0, timedOut: false, text: "done", usage: USAGE };
	});
	try {
		await s.host.stores.jobs.add(job(s) as any);
		await s.kick();
		const began = Date.now();
		while (during.file === undefined && Date.now() - began < 5000) await new Promise((r) => setTimeout(r, 20));
		assert.deepEqual([during.rows.includes("t-result"), during.file], [true, false], "the runner has the file: the result waits in the queue");
		release();
		await s.host.drain(5000);
		aged(s.file);
		await s.tick();
		assert.deepEqual([s.rows(), fs.readFileSync(s.file, "utf8").includes("the deploy finished")], [[], true]);
	} finally {
		release();
		await s.host.stop();
	}
});

test("[R2] a due slot is spent onto a row of its job that had failed, which keeps its attempts, and the lease names that row's run", async () => {
	let busy: any;
	let attempts: number | undefined;
	const s = scene((req) => {
		busy = new LeaseStore(s.dir).read(s.sessionId)?.holder?.busy;
		attempts = s.rows()[0]?.attempts;
		return ok(req);
	});
	try {
		await s.host.stores.jobs.add(job(s) as any);
		// A row of an earlier slot whose turn was cut off once, its backoff over.
		s.requests.append(leftRow(s, "run-refused", { attempts: 1, last_error: "the process running it stopped", not_before: new Date(Date.now() - 1_000).toISOString() }));
		await s.tick();
		assert.deepEqual([s.calls.length, s.calls[0].runId, attempts], [1, "run-refused", 1], "the row runs, with the attempt it had: a new slot's row does not take its place");
		assert.deepEqual([busy.runId, busy.jobId], ["run-refused", "cron-held"]);
		assert.deepEqual([s.rows(), s.job()?.skippedOverlap, s.job()?.runCount], [[], 1, 0], "the due slot is spent onto it, as an overlap");
	} finally {
		await s.host.stop();
	}
});

test("a rule's push that asks for a turn waits for a window: pi-loops in the background starts a plain job's row only, at its job's tick", async () => {
	const s = scene(ok);
	try {
		const { ruleResultRow } = await import("../src/engine.ts");
		s.requests.append({ ...ruleResultRow(s.sessionId, "[Trigger t-push] look at the alert", { traceId: "t-push", sourceLabel: "x", cwd: s.dir }, { pid: 1, instance: "w1", version: "0" }), source: "push:srv:key" as const, wake: "turn" as const, mode: "unattended" as const });
		await s.host.stores.jobs.add(job(s) as any);
		await s.tick();
		assert.equal(s.calls.length, 1);
		assert.match(s.calls[0].prompt, /remind me$/);
		assert.deepEqual(s.rows().map((r) => [r.id, r.run, r.attempts]), [["t-push", undefined, 0]]);
		// And a plain job's row is not started by a delivery: its turn starts at its job's tick, where its slot is.
		const idle = scene(ok);
		try {
			await idle.host.stores.jobs.add(job(idle, { ...notDue(), enabled: false }) as any);
			idle.requests.append(leftRow(idle, "run-left"));
			await idle.tick();
			assert.deepEqual([idle.calls.length, idle.rows().map((r) => [r.id, r.run, r.attempts])], [0, [["run-left", undefined, 0]]], "a disabled job's row waits, with no attempt counted");
		} finally {
			await idle.host.stop();
		}
	} finally {
		await s.host.stop();
	}
});

test("a claim of this process whose run is not going is closed at the next tick, also while a window holds the conversation: the window is not held by it", async () => {
	const s = scene(ok);
	try {
		await s.host.stores.jobs.add(job(s, notDue()) as any);
		s.requests.append(leftRow(s, "run-left"));
		// The claim of a turn whose closing did not happen: this process lives, and nothing runs.
		assert.equal(s.requests.claim(s.sessionId, "run-left", { id: "run-left", pid: process.pid, procStart: procStart(process.pid), started_at: new Date().toISOString() } as any), true);
		new LeaseBinding(new LeaseStore(s.dir), "w1", () => ({ kind: "terminal", pid: process.pid, mode: "tui", pushServers: [] })).bind(s.sessionId, { sessionFile: s.file, cwd: s.dir });
		await s.tick();
		const [row] = s.rows();
		assert.deepEqual([row.run, row.attempts, row.last_error], [undefined, 1, "the process running it stopped"]);
		assert.deepEqual(s.runs().map((r) => [r.runId, r.interrupted]), [["run-left", true]]);
		assert.equal(s.calls.length, 0);
	} finally {
		await s.host.stop();
	}
});

test("a drain starts the turn of the job it was fired for, and no other job's: a second job's row in the same conversation starts at its own tick, as its own job", async () => {
	const s = scene(ok);
	try {
		await s.host.stores.jobs.add(job(s) as any);
		await s.host.stores.jobs.add(job(s, { id: "cron-other", prompt: "remind me too", ...notDue() }) as any);
		// The other job's row was queued first, so it sorts before the due slot's row.
		s.requests.append({ ...plainJobRow(job(s, { id: "cron-other", prompt: "remind me too" }) as any, "run-other", "cron:cron-other", "", { pid: 1, instance: "w1", version: "0" }, Date.now() - 60_000) });
		for (let i = 0; i < 3 && s.runs().length < 2; i++) {
			aged(s.file);
			await s.tick();
		}
		const by = Object.fromEntries(s.runs().map((r) => [r.runId, r.jobId]));
		assert.equal(by["run-other"], "cron-other", "its record names its own job");
		assert.deepEqual(Object.values(by).sort(), ["cron-held", "cron-other"]);
		assert.deepEqual(s.rows(), []);
	} finally {
		await s.host.stop();
	}
});

test("pi-loops in the background does not take a conversation that the page has open, though its job's slot is due", async () => {
	const dir = tmp("pi-loops-bg-");
	const { sessionId } = closedConversation(dir);
	const leases = new LeaseStore(dir);
	const requests = new RequestStore(dir);
	let open = true;
	let clocked = 0;
	const never = () => {
		throw new Error("nothing is written for a conversation the page has open");
	};
	const background = createBackgroundExecutor({
		dir,
		requests,
		leases,
		jobs: { load: () => [], allRuns: () => [], remove: never } as any,
		runs: new RunList(),
		runner: never as any,
		sinks: never as any,
		holder: (busy) => ({ kind: "host", pid: process.pid, instance: "host", procStart: procStart(process.pid), acquiredAt: new Date().toISOString(), pushServers: [], ...(busy ? { busy } : {}) }),
		pageHolds: () => open,
		turnTimeoutMs: 1_000,
		appended: never,
		deliveryFailed: never,
		log: () => undefined,
	});
	const due = new Date(Date.now() - 1_000).toISOString();
	const clock = async () => {
		clocked++;
		return "lost" as const;
	};
	await background.fire(job({ sessionId, dir }) as any, due, { release: () => undefined } as any, clock, Date.now());
	assert.deepEqual([clocked, leases.read(sessionId)?.holder, leases.read(sessionId)?.epoch], [0, null, 1], "no lease is taken, and the clock writes no row");
	// The same call once the page has let go: the lease is taken, and the clock is asked.
	open = false;
	await background.fire(job({ sessionId, dir }) as any, due, { release: () => undefined } as any, clock, Date.now());
	assert.deepEqual([clocked, leases.read(sessionId)?.holder, (leases.read(sessionId)?.epoch ?? 0) > 1], [1, null, true], "taken, and given back when the clock lost the slot");
});

test("[take-back] a window that takes the conversation before the model is asked stops the turn there: no model call, the row is owed, and nothing is counted", async () => {
	let taken = false;
	const s = scene(ok);
	// The window arrives as the turn begins: after its claim, before the runner.
	s.logs.push = (line: string) => {
		if (!taken && /turn run-[0-9a-f]+ in session/.test(line)) {
			taken = true;
			new LeaseBinding(new LeaseStore(s.dir), "w1", () => ({ kind: "terminal", pid: process.pid, mode: "tui", pushServers: [] })).bind(s.sessionId, { sessionFile: s.file, cwd: s.dir });
		}
		return 0;
	};
	try {
		await s.host.stores.jobs.add(job(s) as any);
		await s.tick();
		assert.equal(taken, true);
		assert.equal(s.calls.length, 0, "the model is not asked for a turn whose conversation is gone");
		const [record] = s.runs();
		assert.deepEqual([record.aborted, record.stoppedBy, record.ok], [true, undefined, false]);
		assert.deepEqual(s.rows().map((r) => [r.run, r.attempts]), [[undefined, 0]], "owed to the window");
		assert.deepEqual([s.job()?.consecutiveFailures, s.job()?.interruptions, s.prompts()], [undefined, undefined, 0]);
	} finally {
		await s.host.stop();
	}
});

test("a turn that is going when pi-loops stops is handed back, not failed: its record says so, and one successor row asks again", { timeout: 30_000 }, async () => {
	let began: () => void = () => undefined;
	const running = new Promise<void>((r) => (began = r));
	const s = scene(async (req) => {
		writes(req);
		began();
		await new Promise<void>((r) => (req.signal.aborted ? r() : req.signal.addEventListener("abort", () => r(), { once: true })));
		return { ok: false, exitCode: 1, timedOut: false, text: "", errorMessage: "aborted", stopReason: "aborted", usage: USAGE };
	});
	try {
		await s.host.stores.jobs.add(job(s) as any);
		await s.kick();
		// A turn that never starts fails here, and does not hold the suite.
		await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error("the turn did not start")), 10_000).unref())]);
		const id = s.calls[0].runId;
		// A quit: every run of this process is aborted, with no person's word.
		await s.host.stop();
		const [record] = s.runs();
		assert.deepEqual([record.runId, record.aborted, record.stoppedBy], [id, true, undefined]);
		assert.deepEqual(s.rows().map((r) => [r.id, r.run]), [[plainRunId("cron-held", `after ${id}`), undefined]]);
		assert.deepEqual([s.job()?.consecutiveFailures, s.job()?.runCount], [undefined, 1]);
	} finally {
		await s.host.stop();
	}
});

test("pi-loops in the background does not ask again a prompt that 0.24.2 wrote and left a marker for; it asks again the one that was not written", async () => {
	const s = scene(ok);
	try {
		// 0.24.2 ran the turn with a marker on the job and no row, and its process stopped.
		const fired = new Date(Date.now() - 30_000).toISOString();
		const marked = (runId: string) => ({ lastDueAt: fired, lastFiredAt: fired, running: { runId, pid: 999_999_999, startedAt: fired } });
		SessionManager.open(s.file).appendMessage({ role: "user", content: "[Trigger run-written] remind me", timestamp: Date.now() } as any);
		aged(s.file);
		await s.host.stores.jobs.add(job(s, marked("run-written")) as any);
		const other = closedConversation(s.dir);
		await s.host.stores.jobs.add(job({ sessionId: other.sessionId, dir: s.dir }, { id: "cron-unwritten", ...marked("run-unwritten") }) as any);
		// The markers are what 0.24.2 left on disk at a start; the conversion reads them before a tick.
		convertStores(s.dir);
		for (let i = 0; i < 2; i++) await s.tick();
		assert.deepEqual(s.calls.map((c) => c.jobId), ["cron-unwritten"], "only the turn that wrote no prompt is asked again");
		const written = s.job()!;
		assert.deepEqual([written.running, written.runCount, written.owedSlot, written.lastFiredAt], [undefined, 1, undefined, fired], "spent: the stamps stand, and the slot is counted");
	} finally {
		await s.host.stop();
	}
});

/** The executor by itself over one closed conversation, with real stores and a runner that counts: for a call the scheduler would not make, and for what the runtime wires in. */
function bare(over: Partial<Parameters<typeof createBackgroundExecutor>[0]> = {}) {
	const dir = tmp("pi-loops-bg-");
	const { sessionId, file } = closedConversation(dir);
	const leases = new LeaseStore(dir);
	const requests = new RequestStore(dir);
	const jobs = new JobStore(dir);
	const inbox = new Inbox(dir);
	const audit = new TriggerStore(dir);
	const calls: any[] = [];
	const background = createBackgroundExecutor({
		dir,
		requests,
		leases,
		jobs,
		runs: new RunList(),
		runner: (async (req: any) => {
			calls.push(req);
			return ok(req);
		}) as any,
		sinks: () => ({ jobs: { exists: (id) => jobs.load().some((j) => j.id === id), enabled: (id) => jobs.load().find((j) => j.id === id)?.enabled ?? false, goalActive: () => false }, inbox, audit, ledger: jobs, self: () => ({ pid: process.pid, instance: "host", version: "0" }) }),
		holder: (busy) => ({ kind: "host", pid: process.pid, instance: "host", procStart: procStart(process.pid), acquiredAt: new Date().toISOString(), pushServers: [], ...(busy ? { busy } : {}) }),
		turnTimeoutMs: 1_000,
		appended: () => undefined,
		deliveryFailed: () => undefined,
		log: () => undefined,
		...over,
	});
	const permit = { release: () => undefined } as any;
	return { dir, sessionId, file, leases, requests, jobs, calls, background, permit };
}

test("when the clock loses the slot, pi-loops in the background starts nothing in that conversation at that tick, also when a prompt of the job waits there", async () => {
	const b = bare();
	const held = await b.jobs.add(job(b) as any);
	b.requests.append(leftRow(b as any, "run-left"));
	const due = new Date(Date.now() - 1_000).toISOString();
	await b.background.fire(held, due, b.permit, async () => "lost" as const, Date.now());
	assert.deepEqual([b.calls.length, b.requests.list(b.sessionId).map((r) => [r.id, r.run])], [0, [["run-left", undefined]]], "the prompt that waits is not started by a tick whose slot was lost");
	assert.equal(b.leases.read(b.sessionId)?.holder, null, "and the conversation is given back");
	// The same call with a clock that spent the slot onto that prompt: it runs.
	await b.background.fire(held, due, b.permit, async () => "collapsed" as const, Date.now());
	assert.deepEqual(b.calls.map((c) => c.runId), ["run-left"]);
});

test("a held turn runs as its job and its conversation's directory are set: the job's own time limit, and what pi trusts for the conversation's directory, not for the one the job names; a lease that names no directory is trusted for nothing", async () => {
	const asked: unknown[] = [];
	const b = bare({ ownerTrusts: (cwd) => (asked.push(cwd), cwd === b.dir) });
	// The job names another directory, as one that a model chose can: trust is not asked for it.
	const held = await b.jobs.add(job(b, { ...notDue(), timeoutMs: 42_000, cwd: tmp("pi-loops-elsewhere-") }) as any);
	b.requests.append(leftRow(b as any, "run-left"));
	await b.background.fire(held, undefined, b.permit, async () => "fired" as const, Date.now());
	assert.deepEqual([b.calls[0].timeoutMs, b.calls[0].trusted, b.calls[0].cwd, asked], [42_000, true, b.dir, [b.dir]]);
	// The same conversation with a lease that names no directory, as one that an older version wrote.
	const file = path.join(b.dir, "leases", `${b.sessionId}.json`);
	const { cwd: _cwd, ...lease } = JSON.parse(fs.readFileSync(file, "utf8"));
	fs.writeFileSync(file, JSON.stringify(lease));
	b.requests.append(leftRow(b as any, "run-left-2"));
	await b.background.fire(held, undefined, b.permit, async () => "fired" as const, Date.now());
	assert.deepEqual([b.calls.length, b.calls[1]?.trusted, asked], [2, false, [b.dir]], "not asked, and not trusted");
});

test("a plain job that fails for the third time in a row in the background is said to be failing, with its last error; the second time is not, and a turn that is handed back says nothing", async () => {
	const said: Array<[string, string]> = [];
	let call = 0;
	const b = bare({ runner: (async (req: any) => (++call <= 2 ? fails("boom", { written: true }) : fails(BUDGET, { written: false }))(req)) as any, failing: (message, failing) => void said.push([message, failing.id]) });
	const held = await b.jobs.add(job(b, { ...notDue(), consecutiveFailures: 1 }) as any);
	b.requests.append(leftRow(b as any, "run-left"));
	await b.background.fire(held, undefined, b.permit, async () => "fired" as const, Date.now());
	assert.deepEqual([b.jobs.load()[0].consecutiveFailures, said], [2, []]);
	b.requests.append(leftRow(b as any, "run-left-2"));
	await b.background.fire(b.jobs.load()[0], undefined, b.permit, async () => "fired" as const, Date.now());
	const third = [["cron-held has failed 3 times in a row; backing off (last: boom)", "cron-held"]];
	assert.deepEqual([b.jobs.load()[0].consecutiveFailures, said], [3, third]);
	// A turn that pi-loops stops itself is no failure: the count stands at three, and nothing is said again.
	b.requests.append(leftRow(b as any, "run-left-3"));
	await b.background.fire(b.jobs.load()[0], undefined, b.permit, async () => "fired" as const, Date.now());
	assert.deepEqual([call, b.jobs.load()[0].consecutiveFailures, said], [3, 3, third]);
});

test("a slot waits behind a row of its job that is at its last attempt and has no dead letter yet: the clock is not asked, no lease is taken, and no turn starts", async () => {
	// A row with three attempts is in the queue only when a process stopped as it filed the dead letter.
	const b = bare();
	const held = await b.jobs.add(job(b) as any);
	b.requests.append(leftRow(b as any, "run-left", { attempts: 3, last_error: "the process running it stopped" }));
	const epoch = b.leases.read(b.sessionId)?.epoch;
	let clocked = 0;
	await b.background.fire(held, new Date(Date.now() - 1_000).toISOString(), b.permit, async () => (clocked++, "fired" as const), Date.now());
	assert.deepEqual([clocked, b.calls.length, b.leases.read(b.sessionId)?.epoch, b.requests.list(b.sessionId).map((r) => [r.id, r.run, r.attempts])], [0, 0, epoch, [["run-left", undefined, 3]]]);
});

test("a drain stops where a window takes the conversation: the result it wrote stays, and the next one is left for the window", async () => {
	const s = scene(ok);
	try {
		const { ruleResultRow } = await import("../src/engine.ts");
		const by = { pid: 1, instance: "w1", version: "0" };
		for (const id of ["t-first", "t-second"]) s.requests.append(ruleResultRow(s.sessionId, `[Trigger ${id}] look at ${id}`, { traceId: id, sourceLabel: "x", cwd: s.dir }, by));
		// The window arrives after the first result is written: at the audit line of its delivery.
		const audit = s.host.triggers.store;
		const append = audit.appendAudit.bind(audit);
		let taken = false;
		audit.appendAudit = ((record: any) => {
			if (!taken && record.traceId === "t-first") {
				taken = true;
				new LeaseBinding(new LeaseStore(s.dir), "w1", () => ({ kind: "terminal", pid: process.pid, mode: "tui", pushServers: [] })).bind(s.sessionId, { sessionFile: s.file, cwd: s.dir });
			}
			return append(record);
		}) as typeof audit.appendAudit;
		await s.tick();
		const written = SessionManager.open(s.file).getEntries().map((e: any) => (e.type === "custom_message" ? String(e.content) : String(e.message?.content ?? ""))).filter((text) => text.startsWith("[Trigger t-"));
		assert.equal(taken, true);
		assert.deepEqual([written.map((text) => text.slice(0, 18)), s.rows().map((r) => r.id)], [["[Trigger t-first] "], ["t-second"]]);
	} finally {
		await s.host.stop();
	}
});

test("[loop-R1] a loop lane claims and starts its row once, and a second drain cannot claim it again", async () => {
	const s = scene(() => ({ ok: true, exitCode: 0, timedOut: false, text: "done", usage: USAGE }));
	try {
		await s.host.stores.jobs.add(job(s, { stateful: true, catchUp: true }) as any);
		await s.host.tick();
		const end = Date.now() + 5_000;
		while (!s.host.stores.jobs.allRuns().length && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
		const lane = `@${s.job()!.id}`;
		await s.host.loops.drain(parseLane(lane) as any, Date.now());
		assert.equal(s.host.stores.jobs.allRuns().length, 1);
		assert.equal(s.calls.length, 1);
	} finally {
		await s.host.stop();
	}
});

test("[job-removed-aborts] removed jobs abort every matching run once, including held turns", () => {
	const runs = new RunList();
	const ctrl = new AbortController();
	const turnCtrl = new AbortController();
	runs.add({ runId: "loop-run", jobId: "gone-loop", label: "loop", startedAt: new Date().toISOString(), promptPreview: "", ctrl });
	runs.add({ runId: "held-run", jobId: "gone-plain", label: "plain", startedAt: new Date().toISOString(), promptPreview: "", ctrl: turnCtrl });
	runs.add({ runId: "kept-run", jobId: "kept", label: "kept", startedAt: new Date().toISOString(), promptPreview: "", ctrl: new AbortController() });
	const lines: string[] = [];
	assert.equal(abortRemovedJobs(runs, (id) => id === "kept", (line) => lines.push(line)), 2);
	assert.deepEqual([ctrl.signal.aborted, turnCtrl.signal.aborted], [true, true]);
	assert.equal(abortRemovedJobs(runs, (id) => id === "kept", (line) => lines.push(line)), 0, "an already stopped run is not logged or aborted twice");
	assert.deepEqual(lines, [
		"cron loop: removed while it ran; stopped run loop-run",
		"cron plain: removed while it ran; stopped run held-run",
	]);
});

test("[job-removed-aborts] the next drain of a removed loop's lane removes its row as job-removed", async () => {
	const s = scene(ok);
	try {
		const id = "cron-removed-loop";
		const lane = loopLane(id)!;
		await s.host.stores.jobs.add({ ...job(s, { id, stateful: true }), sessionId: undefined } as any);
		const row = { ...plainJobRow({ ...job(s, { id, stateful: true }), sessionId: lane } as any, "removed-row", `cron:${id}`, "", { pid: process.pid, instance: "test", version: "0" }), lane };
		s.requests.append(row as any);
		await s.host.stores.jobs.remove(id);
		await s.host.loops.drainAll(Date.now());
		assert.deepEqual(s.requests.list(lane), []);
		assert.equal(s.calls.length, 0);
	} finally { await s.host.stop(); }
});

test("a row of the job at its second attempt, its backoff over, is started under its own id", async () => {
	const b = bare();
	const held = await b.jobs.add(job(b, notDue()) as any);
	b.requests.append(leftRow(b as any, "run-left", { attempts: 2, last_error: "the process running it stopped", not_before: new Date(Date.now() - 1_000).toISOString() }));
	assert.equal(b.background.owes(held, Date.now()), true);
	await b.background.fire(held, undefined, b.permit, async () => "fired" as const, Date.now());
	assert.deepEqual(b.calls.map((c) => c.runId), ["run-left"]);
});

test("the runtime gives a held turn what pi trusts for its conversation's directory, and says a plain job that keeps failing in the log and in its project's windows", async () => {
	const s = scene(fails("boom", { written: true }), { ownerTrusts: (cwd) => cwd === s.dir });
	try {
		await s.host.stores.jobs.add(job(s, { consecutiveFailures: 2 }) as any);
		await s.tick();
		const line = "cron-held has failed 3 times in a row; backing off (last: boom)";
		assert.deepEqual([s.calls[0].trusted, s.job()?.consecutiveFailures], [true, 3]);
		assert.deepEqual([s.logs.includes(line), s.host.notices().filter((n) => n.text === line).map((n) => n.cwd)], [true, [s.dir]]);
	} finally {
		await s.host.stop();
	}
});

test("[cron-run-loop-now] a loop run starts immediately despite the budget and slot cap", async () => {
	let finish!: (value: any) => void;
	const s = scene(() => new Promise((resolve) => { finish = resolve; }), { config: () => ({ ...loadConfig("/does-not-exist"), dailyBudgetUsd: 1, maxConcurrentRuns: 0 }) as any });
	try {
		const id = "cron-loop-now";
		await s.host.stores.jobs.add({ ...job(s, { id, stateful: true, enabled: true }), sessionId: undefined } as any);
		assert.equal(await s.host.loops.runNow(id), true);
		const limit = Date.now() + 2_000;
		while (!s.calls.length && Date.now() < limit) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(s.calls.length, 1);
	} finally {
		finish?.({ ok: true, exitCode: 0, timedOut: false, text: "done", usage: USAGE });
		await s.host.stop();
	}
});

test("[cron-run-refused-running] a loop run is refused with main's words while its run is active", async () => {
	let finish!: (value: any) => void;
	const s = scene(() => new Promise((resolve) => { finish = resolve; }));
	try {
		const id = "cron-loop-active";
		await s.host.stores.jobs.add({ ...job(s, { id, stateful: true }), sessionId: undefined } as any);
		assert.equal(await s.host.loops.runNow(id), true);
		assert.equal(await s.host.loops.runNow(id), "is already running");
	} finally {
		finish?.({ ok: true, exitCode: 0, timedOut: false, text: "done", usage: USAGE });
		await s.host.stop();
	}
});

test("[cwd-missing-30min] a loop whose cwd is missing waits 30 minutes from the first miss, as main: an old row alone disables nothing, a cwd that comes back runs the owed slot, one missing for the whole grace disables the job and spends the slot", async () => {
	const s = scene(ok);
	try {
		const id = "cron-cwd-missing";
		const cwd = path.join(s.dir, "mounted-late");
		const lane = loopLane(id)!;
		const book = () => s.host.stores.book().jobs.find((candidate) => candidate.id === id);
		await s.host.stores.jobs.add({ ...job(s, { id, stateful: true, cwd }), sessionId: undefined } as any);
		// A row owed from long ago (a run handed back two hours before this start): its age is not the cwd's absence.
		const row = { ...plainJobRow({ ...job(s, { id, stateful: true, cwd }), sessionId: lane } as any, "cwd-row", `cron:${id}`, "", { pid: process.pid, instance: "test", version: "0" }), lane, created_at: new Date(Date.now() - 120 * 60_000).toISOString() };
		s.requests.append(row as any);
		const t0 = Date.now();
		await s.host.loops.drain(parseLane(lane) as any, t0);
		assert.equal(book()?.enabled, true, "the first miss waits: the mount may come up after pi-loops");
		assert.deepEqual(s.requests.list(lane).map((item) => item.id), [row.id]);
		assert.equal(s.calls.length, 0);
		// The mount comes up inside the grace: the owed slot runs, and the marker goes.
		fs.mkdirSync(cwd);
		await s.host.loops.drain(parseLane(lane) as any, t0 + 60_000);
		await s.host.loops.settle(5000);
		assert.equal(s.calls.length, 1, "the owed slot ran");
		assert.equal(book()?.cwdMissingSince, undefined, "the marker does not outlive the outage");
		// Missing again: 29 minutes later it still waits; at 30 minutes the job is disabled with main's words and the slot is spent.
		fs.rmSync(cwd, { recursive: true, force: true });
		const again = { ...plainJobRow({ ...job(s, { id, stateful: true, cwd }), sessionId: lane } as any, "cwd-row-2", `cron:${id}`, "", { pid: process.pid, instance: "test", version: "0" }), lane };
		s.requests.append(again as any);
		const t1 = t0 + 2 * 60_000;
		await s.host.loops.drain(parseLane(lane) as any, t1);
		await s.host.loops.drain(parseLane(lane) as any, t1 + 29 * 60_000);
		assert.equal(book()?.enabled, true);
		await s.host.loops.drain(parseLane(lane) as any, t1 + 30 * 60_000);
		const disabled = book()?.disabled;
		assert.equal(disabled?.code, "cwd-missing");
		assert.match(disabled?.why ?? "", /^disabled: cwd .* has been missing since /);
		assert.deepEqual(s.requests.list(lane), [], "the slot is spent and the stale row is gone");
		assert.equal(s.calls.length, 1);
	} finally { await s.host.stop(); }
});

test("[kept-catch-up-note] a caught-up loop slot says so in the background log", async () => {
	const s = scene(ok);
	try {
		await s.host.stores.jobs.add({ ...job(s, { id: "cron-catch-up", schedule: { kind: "every", ms: 60_000 }, stateful: true, catchUp: true, createdAt: new Date(Date.now() - 4 * 60_000 - 40_000).toISOString() }), sessionId: undefined } as any);
		const now = Date.now();
		await s.host.riders.clock(now, { startedAt: now, tickMs: 30_000 });
		assert.ok(s.logs.some((line) => line.includes("catching up a missed tick")), s.logs.join("\n"));
	} finally { await s.host.stop(); }
});

test("[kept-notices] loop failure and daily budget notices are each said once", async () => {
	const config = () => ({ ...loadConfig("/does-not-exist"), dailyBudgetUsd: 0.01 });
	const s = scene(ok, { config });
	try {
		const id = "cron-notice-loop";
		const loop = { ...job(s, { id, stateful: true }), sessionId: undefined } as any;
		await s.host.stores.jobs.add(loop);
		for (let i = 1; i <= 3; i++) s.host.stores.jobs.appendRun({ runId: `r${i}`, jobId: id, jobName: id, stateful: true, cwd: s.dir, pid: process.pid, startedAt: new Date(Date.now() - 1000 + i).toISOString(), finishedAt: new Date(Date.now() - 1000 + i).toISOString(), ok: false, error: "boom", findings: 0, droppedFindings: 0, stateUpdated: false, usage: USAGE });
		const facts = { startedAt: Date.now() - 10_000, tickMs: 30_000 };
		await s.host.riders.notices(Date.now(), facts);
		await s.host.riders.notices(Date.now(), facts);
		const notices = s.host.notices().map((item) => item.text);
		assert.equal(notices.filter((text) => text === `${id} has failed 3 times in a row; backing off (last: boom)`).length, 1);
		assert.equal(notices.filter((text) => text.includes("budget; dispatching is paused")).length, 1);
	} finally { await s.host.stop(); }
});
