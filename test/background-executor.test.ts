import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { tmp } from "./tmp.ts";
import { loadConfig } from "../src/config.ts";
import { plainJobRow, plainRunId } from "../src/engine.ts";
import { createBackgroundExecutor } from "../src/background-executor.ts";
import { createHostRuntime } from "../src/host-runtime.ts";
import { RunList } from "../src/run-list.ts";
import { LeaseBinding, LeaseStore, procStart } from "../src/lease.ts";
import { RequestStore } from "../src/requests.ts";

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
function scene(script: (req: any, call: number) => any) {
	const dir = tmp("pi-loops-bg-");
	const { sessionId, file } = closedConversation(dir);
	const calls: any[] = [];
	const logs: string[] = [];
	const runner = async (req: any) => {
		calls.push(req);
		return script(req, calls.length);
	};
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner, mcpTools: () => [], log: (line) => void logs.push(line) });
	const requests = new RequestStore(dir);
	const store = host.scheduler.store;
	return {
		dir,
		sessionId,
		file,
		calls,
		logs,
		host,
		requests,
		tick: async () => {
			await host.scheduler.tick();
			await host.scheduler.drain(5000);
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
		await s.host.scheduler.store.add(job(s) as any);
		await s.host.scheduler.store.add(job(s, { id: "cron-nowhere", sessionId: "no-such-conversation" }) as any);
		await s.tick();
		assert.equal(s.calls.length, 1);
		const fired = s.job()!;
		const id = plainRunId("cron-held", fired.lastDueAt!);
		assert.deepEqual([s.calls[0].kind, s.calls[0].sessionFile, s.calls[0].prompt, s.calls[0].runId, s.calls[0].parentSessionId], ["held", s.file, `[Trigger ${id}] remind me`, id, s.sessionId]);
		const [record] = s.runs();
		assert.deepEqual([record.runId, record.jobId, record.ok, record.stateful, record.sessionFile, record.aborted], [id, "cron-held", true, false, s.file, undefined]);
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
		during.running = s.host.scheduler.runningRuns().map((r) => r.runId);
		// The lease has named this run for two minutes: a lease of a run that is not in the list would be given back at the tick.
		const file = path.join(s.dir, "leases", `${s.sessionId}.json`);
		const lease = JSON.parse(fs.readFileSync(file, "utf8"));
		lease.holder.busy.since = new Date(Date.now() - 120_000).toISOString();
		fs.writeFileSync(file, JSON.stringify(lease));
		await s.host.scheduler.tick();
		during.afterTick = leases.read(s.sessionId)?.holder?.busy?.runId;
		await gate;
		return { ok: true, exitCode: 0, timedOut: false, text: "done", usage: USAGE };
	});
	try {
		await s.host.scheduler.store.add(job(s, { name: "reminder" }) as any);
		await s.host.scheduler.tick();
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
		await s.host.scheduler.drain(5000);
		assert.deepEqual([s.rows(), s.host.heldTurn(s.sessionId), s.host.scheduler.runningRuns(), new LeaseStore(s.dir).read(s.sessionId)?.holder], [[], undefined, [], null]);
		assert.equal(s.runs()[0].startedAt, during.claim.started_at, "the record is the claim's: it starts with it");
	} finally {
		release();
		await s.host.stop();
	}
});

test("[take-back] a window that takes the conversation after the prompt was written stops the turn: the background writes nothing more into the conversation, the row is delivered, and one successor row asks again", async () => {
	let afterTake = "";
	const s = scene((req) => {
		writes(req);
		new LeaseBinding(new LeaseStore(s.dir), "w1", () => ({ kind: "terminal", pid: process.pid, mode: "tui", pushServers: [] })).bind(s.sessionId);
		afterTake = fs.readFileSync(s.file, "utf8");
		return { ok: false, exitCode: 1, timedOut: false, text: "", errorMessage: "taken back: a window opened this conversation", stopReason: "aborted", usage: USAGE };
	});
	try {
		await s.host.scheduler.store.add(job(s) as any);
		await s.tick();
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
		await s.host.scheduler.store.add(job(s) as any);
		await s.tick();
		const [record] = s.runs();
		assert.deepEqual([record.ok, record.error, record.aborted], [false, "the model refused", undefined]);
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
		await s.host.scheduler.store.add(job(s, { schedule: { kind: "once", at: Date.now() - 1_000 } }) as any);
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
		await s.host.scheduler.store.add(job(s, { schedule: { kind: "once", at: Date.now() - 1_000 } }) as any);
		await s.tick();
		assert.deepEqual([s.calls.length, s.job(), s.rows(), s.prompts()], [1, undefined, [], 1]);
	} finally {
		await s.host.stop();
	}
});

test("a turn that pi-loops stops itself before its prompt is written leaves its row owed, and the next tick runs it though no slot is due and catch-up is off", async () => {
	const s = scene((req, call) => (call === 1 ? fails(BUDGET, { written: false })(req) : ok(req)));
	try {
		await s.host.scheduler.store.add(job(s) as any);
		await s.tick();
		const id = s.calls[0].runId;
		assert.deepEqual(s.rows().map((r) => [r.id, r.run, r.attempts, r.not_before]), [[id, undefined, 0, undefined]], "owed: the claim is cleared, and nothing is counted");
		assert.deepEqual([s.runs()[0].aborted, s.job()?.consecutiveFailures, s.job()?.runCount, s.requestAudit()], [true, undefined, 1, []]);
		await s.tick();
		assert.deepEqual([s.calls.length, s.calls[1].runId, s.rows(), s.prompts(), s.job()?.runCount], [2, id, [], 1, 1], "the same row runs again, and its slot is not counted twice");
	} finally {
		await s.host.stop();
	}
});

test("[settle-successor] a turn that pi-loops stops itself after its prompt was written is done, and one successor row asks again: not a successor and an owed slot", async () => {
	const s = scene((req, call) => (call === 1 ? fails(BUDGET, { written: true })(req) : ok(req)));
	try {
		await s.host.scheduler.store.add(job(s) as any);
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
		await s.host.scheduler.store.add(job(s, notDue()) as any);
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
		await s.host.scheduler.store.add(job(s, notDue()) as any);
		SessionManager.open(s.file).appendMessage({ role: "user", content: "[Trigger run-left] remind me", timestamp: Date.now() } as any);
		aged(s.file);
		s.requests.append(leftRow(s, "run-left"));
		await s.tick();
		assert.deepEqual([s.calls.length, s.rows(), s.runs()], [0, [], []]);
	} finally {
		await s.host.stop();
	}
});

test("[proved-by-conversation] a turn that fails before its prompt is written counts an attempt, backs off, and is not run again before its backoff ends; the third failure is a dead letter", async () => {
	const s = scene(fails("no credentials", { written: false }));
	try {
		await s.host.scheduler.store.add(job(s) as any);
		await s.tick();
		const [row] = s.rows();
		assert.deepEqual([row.run, row.attempts, row.last_error, Date.parse(row.not_before!) > Date.now()], [undefined, 1, "no credentials", true]);
		assert.deepEqual([s.requestAudit(), s.job()?.consecutiveFailures, s.job()?.lastError], [["failed"], 1, "no credentials"]);
		const epoch = new LeaseStore(s.dir).read(s.sessionId)?.epoch;
		await s.tick();
		assert.equal(s.calls.length, 1, "a row in backoff waits, and so does the job");
		assert.equal(new LeaseStore(s.dir).read(s.sessionId)?.epoch, epoch, "and the conversation is not taken for a row that cannot start");
		// A row that has failed twice already: this failure is its third.
		const dead = scene(fails("no credentials", { written: false }));
		try {
			await dead.host.scheduler.store.add(job(dead, notDue()) as any);
			dead.requests.append(leftRow(dead, "run-left", { attempts: 2 }));
			await dead.tick();
			assert.deepEqual([dead.calls.length, dead.rows()], [1, []]);
			const [letter] = dead.host.scheduler.inbox.list();
			assert.deepEqual([letter.undelivered, letter.run_id, letter.session_id], [true, "run-left", dead.sessionId]);
			assert.match(letter.text, /^could not be delivered \(failed 3 times: no credentials\): remind me$/);
		} finally {
			await dead.host.stop();
		}
	} finally {
		await s.host.stop();
	}
});

test("a due slot is spent onto the row a window left, not run after it: one turn, and the overlap is counted", async () => {
	const s = scene(ok);
	try {
		await s.host.scheduler.store.add(job(s) as any);
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
		await s.host.scheduler.store.add(job(s) as any);
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
		await s.host.scheduler.tick();
		during.rows = s.rows().map((r) => r.id);
		during.file = fs.readFileSync(s.file, "utf8").includes("the deploy finished");
		await gate;
		return { ok: true, exitCode: 0, timedOut: false, text: "done", usage: USAGE };
	});
	try {
		await s.host.scheduler.store.add(job(s) as any);
		await s.host.scheduler.tick();
		const began = Date.now();
		while (during.file === undefined && Date.now() - began < 5000) await new Promise((r) => setTimeout(r, 20));
		assert.deepEqual([during.rows.includes("t-result"), during.file], [true, false], "the runner has the file: the result waits in the queue");
		release();
		await s.host.scheduler.drain(5000);
		aged(s.file);
		await s.tick();
		assert.deepEqual([s.rows(), fs.readFileSync(s.file, "utf8").includes("the deploy finished")], [[], true]);
	} finally {
		release();
		await s.host.stop();
	}
});

test("[R2] the lease names the run that is going, also when the slot's row took the place of a row that had failed", async () => {
	let busy: any;
	const s = scene((req) => {
		busy = new LeaseStore(s.dir).read(s.sessionId)?.holder?.busy;
		return ok(req);
	});
	try {
		await s.host.scheduler.store.add(job(s) as any);
		// A row of an earlier slot that failed once, its backoff over: the due slot asks in its place.
		s.requests.append(leftRow(s, "run-refused", { attempts: 1, last_error: "no credentials", not_before: new Date(Date.now() - 1_000).toISOString() }));
		await s.tick();
		assert.equal(s.calls.length, 1);
		assert.notEqual(s.calls[0].runId, "run-refused");
		assert.deepEqual([busy.runId, busy.jobId], [s.calls[0].runId, "cron-held"]);
		assert.deepEqual(s.rows(), []);
	} finally {
		await s.host.stop();
	}
});

test("a rule's push that asks for a turn waits for a window: pi-loops in the background starts a plain job's row only, at its job's tick", async () => {
	const s = scene(ok);
	try {
		const { ruleResultRow } = await import("../src/engine.ts");
		s.requests.append({ ...ruleResultRow(s.sessionId, "[Trigger t-push] look at the alert", { traceId: "t-push", sourceLabel: "x", cwd: s.dir }, { pid: 1, instance: "w1", version: "0" }), source: "push:srv:key" as const, wake: "turn" as const, mode: "unattended" as const });
		await s.host.scheduler.store.add(job(s) as any);
		await s.tick();
		assert.equal(s.calls.length, 1);
		assert.match(s.calls[0].prompt, /remind me$/);
		assert.deepEqual(s.rows().map((r) => [r.id, r.run, r.attempts]), [["t-push", undefined, 0]]);
		// And a plain job's row is not started by a delivery: its turn starts at its job's tick, where its slot is.
		const idle = scene(ok);
		try {
			await idle.host.scheduler.store.add(job(idle, { ...notDue(), enabled: false }) as any);
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
		await s.host.scheduler.store.add(job(s, notDue()) as any);
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
		await s.host.scheduler.store.add(job(s) as any);
		await s.host.scheduler.store.add(job(s, { id: "cron-other", prompt: "remind me too", ...notDue() }) as any);
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
