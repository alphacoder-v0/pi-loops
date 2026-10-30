import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LoopScheduler } from "../src/scheduler.ts";
import { runsHere } from "../src/job-owner.ts";
import { fakeRunner } from "./fake-runner.ts";
import { JobStore, type LoopJob } from "../src/store.ts";
import { LeaseBinding, LeaseStore } from "../src/lease.ts";
import { failedRun, type RunnerResult } from "../src/runner.ts";
import { stamp } from "../src/schedule.ts";
import { RequestStore } from "../src/requests.ts";
import { type EngineSinks, drain, plainJobRow, plainRunId } from "../src/engine.ts";
import { WindowExecutor } from "../src/window-executor.ts";
import { TriggerStore } from "../src/triggers.ts";

const okTurn = (): RunnerResult => ({ ok: true, exitCode: 0, timedOut: false, text: "done", usage: { input: 10, output: 5, cost: 0.01, turns: 1 } });

/** What a window's clock wrote for its conversation: the rows queued in requests/<session>.jsonl. */
const rowsFor = (dir: string, sessionId: string) => new RequestStore(dir).list(sessionId);

/**
 * A window on `sessionId`: the engine's executor over a fake pi whose `sendUserMessage` is counted,
 * and a conversation (`entries`) the test writes into when pi would have.
 */
function fakeWindow(sched: LoopScheduler, sessionId: string) {
	const sent: string[] = [];
	const entries: unknown[] = [];
	const ctx = { idle: true, mode: "tui", hasUI: false, isIdle: () => ctx.idle, sessionManager: { getEntries: () => entries }, ui: { notify: () => undefined } } as any;
	const pi = { sendMessage: () => undefined, sendUserMessage: (text: string) => void sent.push(text) };
	const executor = new WindowExecutor(pi, { here: () => ({ sessionId, holds: true }) }, () => ctx);
	const sinks: EngineSinks = { jobs: { exists: (id) => sched.store.load().some((j) => j.id === id), goalActive: () => false }, inbox: sched.inbox, audit: new TriggerStore(sched.requests.dir) };
	const drainNow = (now = Date.now()) => drain(sessionId, sched.requests, executor, now, sinks);
	/** pi wrote the prompt: the user message is in the conversation. */
	const landed = (text: string) => void entries.push({ type: "message", message: { role: "user", content: text } });
	return { sent, entries, ctx, executor, drainNow, landed };
}


function makeJob(over: Partial<LoopJob> = {}): LoopJob {
	return {
		id: `loop-${Math.random().toString(16).slice(2, 10)}`,
		schedule: { kind: "every", ms: 60_000 },
		stateful: true,
		prompt: "check things",
		cwd: os.tmpdir(),
		enabled: true,
		catchUp: true,
		createdAt: new Date(Date.now() - 120_000).toISOString(),
		runCount: 0,
		skippedOverlap: 0,
		...over,
	};
}

const waitFor = async (cond: () => boolean, ms = 5000) => {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error("timeout waiting");
		await new Promise((r) => setTimeout(r, 25));
	}
};

test("a due loop job runs in the fake sub-agent, writes state, routes findings to the inbox", async () => {
	const dir = tmp("pi-loops-sched-");
	const finished: string[] = [];
	const fake = fakeRunner();
	const sched = new LoopScheduler({
		dir,
		runner: fake,
		getSession: () => ({ sessionId: "s1", cwd: dir, model: "test/model", thinking: "low" }),
		hooks: { onRunFinished: (o) => finished.push(o.record.runId) },
	});
	const promptFile = path.join(dir, "prompt.txt");
	process.env.FAKE_PI_PROMPT_FILE = promptFile;
	try {
		const job = await sched.store.add(makeJob({ name: "issues", createdBy: { sessionId: "s1", cwd: dir } }));
		await sched.tick();
		await waitFor(() => finished.length === 1);

		assert.equal(sched.store.readState(job.id), "seen: 1");
		const inbox = sched.inbox.listNew();
		assert.equal(inbox.length, 1);
		assert.equal(inbox[0].text, "something new");
		assert.equal(inbox[0].source, "cron:issues");
		assert.equal(inbox[0].session_id, "s1");
		assert.equal(inbox[0].transcript, sched.store.listRuns(job.id)[0].sessionFile);
		const after = sched.store.load()[0];
		assert.equal(after.runCount, 1);
		assert.equal(after.running, undefined);
		assert.equal(after.lastError, undefined);
		assert.ok(after.lastFiredAt);
		const runs = sched.store.listRuns(job.id);
		assert.equal(runs.length, 1);
		assert.equal(runs[0].ok, true);
		assert.equal(runs[0].forSession, "s1");
		assert.equal(runs[0].findings, 1);
		assert.equal(runs[0].stateUpdated, true);
		assert.ok(runs[0].sessionId, "child session id captured");
		assert.ok(runs[0].sessionFile && fs.existsSync(runs[0].sessionFile), "transcript kept under sessions/<job>/");
		assert.ok(runs[0].sessionFile!.startsWith(path.join(dir, "sessions", job.id)));

		const prompt = fs.readFileSync(promptFile, "utf8");
		assert.ok(prompt.includes("(first run)"));
		assert.ok(prompt.includes("check things"));
		const call = fake.calls[0];
		assert.equal(call.kind, "loop");
		assert.equal(call.model, "test/model");
		assert.equal(call.thinking, "low");
		assert.equal(call.hop, 1);
		assert.equal(call.parentSessionId, "s1", "the run acts for the session that owns the scheduler");
		assert.ok(call.sessionDir?.startsWith(path.join(dir, "sessions", job.id)));

		// Second tick right away: nothing due (interval not elapsed), state carried into the next prompt.
		await sched.tick();
		assert.equal(finished.length, 1);
		assert.equal(await sched.runNow(job.id), true);
		await waitFor(() => finished.length === 2);
		assert.ok(fs.readFileSync(promptFile, "utf8").includes("seen: 1"));
	} finally {
		delete process.env.FAKE_PI_PROMPT_FILE;
		await sched.stop();
	}
});

test("failed run keeps state untouched and records the error", async () => {
	const dir = tmp("pi-loops-sched-");
	const finished: string[] = [];
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ cwd: dir }), hooks: { onRunFinished: (o) => finished.push(o.record.runId) } });
	process.env.FAKE_PI_FAIL = "1";
	try {
		const job = await sched.store.add(makeJob());
		sched.store.writeState(job.id, "keep me");
		await sched.tick();
		await waitFor(() => finished.length === 1);
		assert.equal(sched.store.readState(job.id), "keep me");
		assert.equal(sched.inbox.newCount(), 0);
		assert.match(sched.store.load()[0].lastError ?? "", /boom/);
		assert.equal(sched.store.listRuns()[0].ok, false);
	} finally {
		delete process.env.FAKE_PI_FAIL;
		await sched.stop();
	}
});

test("only a host-role scheduler runs loops; a terminal-role one never does", async () => {
	const dir = tmp("pi-loops-sched-");
	const terminalRunner = fakeRunner();
	const hostRunner = fakeRunner();
	// The predicates src/pi-loops.ts and src/host-runtime.ts pass.
	const terminal = new LoopScheduler({ dir, runner: terminalRunner, getSession: () => ({ sessionId: "s", cwd: dir }), owns: (job, view) => !job.stateful && runsHere(job, view) });
	const host = new LoopScheduler({ dir, runner: hostRunner, kind: "host", getSession: () => ({ cwd: "" }), owns: (job) => job.stateful });
	try {
		await terminal.store.add(makeJob({ cwd: dir, createdAt: new Date(Date.now() - 90_000).toISOString() }));
		await terminal.tick();
		await terminal.drain(3000);
		assert.equal(terminalRunner.calls.length, 0, "a window never runs a loop, however long it is open");
		await host.tick();
		await host.drain(3000);
		assert.equal(hostRunner.calls.length, 1, "the host runs it");
		assert.equal(fs.existsSync(path.join(dir, "scheduler.json")), false, "nobody elects anyone");
	} finally {
		await terminal.stop();
		await host.stop();
	}
});

test("missed ticks: catch up once by default, skip with catchUp=false; overlap is skipped", async () => {
	const dir = tmp("pi-loops-sched-");
	const finished: string[] = [];
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), kind: "host", getSession: () => ({ cwd: "" }), hooks: { onRunFinished: (o) => finished.push(o.record.runId) } });
	try {
		const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
		const catchUp = await sched.store.add(makeJob({ schedule: { kind: "cron", expr: "0 9 * * *" }, createdAt: weekAgo, name: "daily" }));
		const noCatch = await sched.store.add(makeJob({ schedule: { kind: "cron", expr: "0 9 * * *" }, createdAt: weekAgo, catchUp: false, name: "strict" }));
		sched.start(); // sets startedAt = now
		await waitFor(() => finished.length === 1);
		const jobs = sched.store.load();
		const c = jobs.find((j) => j.id === catchUp.id)!;
		const n = jobs.find((j) => j.id === noCatch.id)!;
		assert.equal(c.runCount, 1);
		assert.equal(n.runCount, 0);
		assert.match(n.lastError ?? "", /^missed .* while pi-loops was not running \(catch-up disabled\)$/, "down means pi-loops was down");
		assert.ok(n.lastDueAt, "lastDueAt recorded so it is not retried");

		// overlap: mark as running by this pid with an unknown runId → treated as stale and cleared,
		// while a running marker for a live foreign pid is respected (skipped).
		await sched.store.update(c.id, (j) => {
			j.running = { runId: "foreign", pid: process.ppid, startedAt: new Date().toISOString() };
			j.lastDueAt = undefined;
		});
		await sched.tick();
		const c2 = sched.store.load().find((j) => j.id === c.id)!;
		assert.equal(c2.skippedOverlap, 1);
		assert.match(c2.lastError ?? "", /previous run still active/);
	} finally {
		await sched.stop();
	}
});

test("non-stateful jobs write a turn row for the owning session only, with the run id in its prompt", async () => {
	const dir = tmp("pi-loops-sched-");
	let sessionId = "other";
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId, cwd: dir }) });
	try {
		const job = await sched.store.add(makeJob({ stateful: false, sessionId: "mine", schedule: { kind: "once", at: Date.now() - 1000 }, prompt: "remind me", tools: ["read"], model: "fake/model" }));
		await sched.tick();
		assert.deepEqual(rowsFor(dir, "mine"), []);
		sessionId = "mine";
		await sched.tick();
		const rows = rowsFor(dir, "mine");
		assert.equal(rows.length, 1);
		assert.match(rows[0].payload!.text, /^\[Trigger run-[0-9a-f]{32}\] remind me$/);
		assert.ok(rows[0].payload!.text.startsWith(`[Trigger ${rows[0].id}] `), `the row's id is the one in its prompt: ${rows[0].payload!.text}`);
		assert.deepEqual({ source: rows[0].source, mode: rows[0].mode, wake: rows[0].wake, collapse: rows[0].collapse_key, tools: rows[0].payload!.tools, model: rows[0].payload!.model }, { source: `cron:${job.id}`, mode: "unattended", wake: "turn", collapse: `cron:${job.id}`, tools: ["read"], model: "fake/model" }, "the row carries the job's declaration");
		assert.equal(sched.store.load()[0]?.runCount, 1, "the slot is spent, and the one-shot stays until its row is done");
	} finally {
		await sched.stop();
	}
});

test("non-stateful jobs inject only in the lease holder; a second window on the same session does not", async () => {
	const dir = tmp("pi-loops-sched-");
	const window = (instance: string) => {
		const binding = new LeaseBinding(new LeaseStore(dir), instance, () => ({ kind: "terminal", pid: process.pid, mode: "tui", pushServers: [] }));
		const sched = new LoopScheduler({ dir, runner: fakeRunner(), instance, leases: binding, getSession: () => ({ sessionId: "s", cwd: dir }) });
		return { binding, sched };
	};
	const first = window("w1");
	const second = window("w2");
	try {
		assert.equal(first.binding.bind("s").outcome, "acquired");
		assert.equal(second.binding.bind("s").outcome, "viewer");
		const job = await first.sched.store.add(makeJob({ stateful: false, sessionId: "s", schedule: { kind: "every", ms: 60_000 }, createdAt: new Date(Date.now() - 90_000).toISOString(), prompt: "remind me" }));
		assert.equal(await second.sched.runNow(job.id), `belongs to session s, which is open in pid ${process.pid} — run it there`);
		await second.sched.tick();
		assert.equal(rowsFor(dir, "s").length, 0, "the viewer fires nothing");
		await first.sched.tick();
		assert.equal(rowsFor(dir, "s").length, 1, "the holder fires it");
		first.binding.release();
		assert.equal(second.binding.refresh()?.outcome, "acquired", "once the holder lets go, the viewer takes the conversation over on its next tick");
		assert.equal(first.binding.heldEpoch("s"), undefined);
	} finally {
		await first.sched.stop();
		await second.sched.stop();
	}
});

test("a plain job's slot is written once when two instances both hold a snapshot", async () => {
	const dir = tmp("pi-loops-sched-");
	const mk = () => new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId: "s", cwd: dir }) });
	const slow = mk();
	const fast = mk();
	await slow.store.add(makeJob({ stateful: false, sessionId: "s", schedule: { kind: "every", ms: 60_000 }, createdAt: new Date(Date.now() - 90_000).toISOString(), prompt: "remind me" }));
	// Hold `slow` between reading jobs.json and dispatching from it, as the stale-snapshot test above does for loops.
	let open!: () => void;
	const gate = new Promise<void>((r) => (open = r));
	const mutate = slow.store.mutate.bind(slow.store);
	(slow.store as any).mutate = async (fn: any) => {
		const result = await mutate(fn);
		await gate;
		return result;
	};
	try {
		const slowTick = slow.tick();
		await new Promise((r) => setTimeout(r, 100));
		await fast.tick();
		open();
		await slowTick;
		assert.equal(rowsFor(dir, "s").length, 1, `one due slot was written ${rowsFor(dir, "s").length} time(s)`);
		assert.equal(slow.store.load()[0].runCount, 1);
	} finally {
		await slow.stop();
		await fast.stop();
	}
});

test("maker/checker: verify=true routes findings through the checker; drops stay out of the inbox; checker failure is fail-open", async () => {
	const dir = tmp("pi-loops-sched-");
	const finished: any[] = [];
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ cwd: dir, model: "m/x" }), hooks: { onRunFinished: (o) => finished.push(o) } });
	process.env.FAKE_PI_REPLY = "<inbox>alpha</inbox><inbox>beta</inbox><inbox>gamma</inbox><loop-state>seen: a b c</loop-state>";
	process.env.FAKE_PI_CHECKER_REPLY = '<verdict n="1">keep — confirmed</verdict><rewrite n="1">alpha (confirmed)</rewrite><verdict n="2">drop — duplicate of alpha</verdict>';
	try {
		const job = await sched.store.add(makeJob({ name: "v", verify: true, checkerModel: "m/checker" }));
		await sched.tick();
		await waitFor(() => finished.length === 1);
		const rec = finished[0].record;
		assert.equal(rec.checker.ok, true);
		assert.equal(rec.checker.kept, 1);
		assert.deepEqual(rec.checker.dropped, [{ text: "beta", reason: "duplicate of alpha" }]);
		assert.equal(rec.checker.unreviewed, 1);
		assert.equal(rec.checker.model, "fake/model");
		assert.ok(rec.checker.sessionFile && fs.existsSync(rec.checker.sessionFile), "checker transcript kept");
		const inbox = sched.inbox.listNew();
		assert.deepEqual(inbox.map((e) => [e.text, e.verified]), [["alpha (confirmed)", true], ["gamma", null]]);
		assert.equal(inbox[0].verified_reason, "confirmed");
		assert.equal(sched.store.readState(job.id), "seen: a b c", "checker never touches the state spine");
		assert.equal(rec.findings, 2);

		// checker failure → fail-open, all findings enter unverified
		process.env.FAKE_PI_CHECKER_FAIL = "1";
		await sched.inbox.dismissAllNew();
		assert.equal(await sched.runNow(job.id), true);
		await waitFor(() => finished.length === 2);
		assert.equal(finished[1].record.checker.ok, false);
		assert.match(finished[1].record.checker.error, /checker boom/);
		assert.equal(sched.inbox.listNew().length, 3);
		assert.ok(sched.inbox.listNew().every((e) => e.verified === null));
	} finally {
		delete process.env.FAKE_PI_REPLY;
		delete process.env.FAKE_PI_CHECKER_REPLY;
		delete process.env.FAKE_PI_CHECKER_FAIL;
		await sched.stop();
	}
});


test("an orphan cwd disables the job once it has been gone a while; a stale run is re-fired; children get a hop", async () => {
	const dir = tmp("pi-loops-sched-");
	const finished: any[] = [];
	const fake = fakeRunner();
	const sched = new LoopScheduler({ dir, runner: fake, hop: 0, getSession: () => ({ cwd: dir }), hooks: { onRunFinished: (o) => finished.push(o) } });
	try {
		// Missing since yesterday: past the grace period a directory gets for arriving late at boot,
		// which is what the two tests below cover.
		const orphan = await sched.store.add(
			makeJob({ name: "orphan", cwd: path.join(dir, "gone"), cwdMissingSince: new Date(Date.now() - 24 * 60 * 60_000).toISOString() }),
		);
		const stale = await sched.store.add(makeJob({ name: "stale", running: { runId: "dead", pid: 999999, startedAt: "t" }, lastDueAt: new Date().toISOString(), lastFiredAt: new Date().toISOString() }));
		await sched.tick();
		const o = sched.store.load().find((j) => j.id === orphan.id)!;
		assert.equal(o.enabled, false);
		assert.match(o.lastError ?? "", /has been missing since/);
		await waitFor(() => finished.length === 1);
		assert.equal(finished[0].job.id, stale.id, "the run that died with its process was retried");
		assert.equal(fake.calls[0].hop, 1, "sub-agents run one hop below the interactive pi");
	} finally {
		await sched.stop();
	}
});

test("plain jobs whose session was deleted are disabled by the host and removed by gc", async () => {
	const dir = tmp("pi-loops-sched-");
	const live = new Set(["alive"]);
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), kind: "host", getSession: () => ({ cwd: "" }), sessionExists: (id) => live.has(id) });
	try {
		const ok = await sched.store.add(makeJob({ stateful: false, sessionId: "alive", schedule: { kind: "cron", expr: "0 9 * * *" }, name: "mine" }));
		const dead = await sched.store.add(makeJob({ stateful: false, sessionId: "gone", schedule: { kind: "cron", expr: "0 9 * * *" }, name: "dead" }));
		await sched.tick();
		const jobs = sched.store.load();
		assert.equal(jobs.find((j) => j.id === ok.id)?.enabled, true);
		const d = jobs.find((j) => j.id === dead.id)!;
		assert.equal(d.enabled, false, "session gone → disabled");
		assert.match(d.lastError ?? "", /session .* no longer exists/);
		const removed = await sched.gc();
		assert.deepEqual(removed.map((j) => j.name), ["dead"]);
		assert.deepEqual(sched.store.load().map((j) => j.name).sort(), ["mine"]);
	} finally {
		await sched.stop();
	}
});

test("/cron run leaves a parked plain job parked: the gc marker survives and nothing is injected", async () => {
	// Running a job the dead-session sweep disabled used to inject into whatever chat happened to be
	// open and clear `lastError` on the way — which erased the marker `gc()` matches on, so the job
	// could never be fired (disabled) and never be collected either.
	const dir = tmp("pi-loops-sched-");
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId: "alive", cwd: dir }), sessionExists: (id) => id === "alive" });
	// The sweep is the host's; the refusal is any window's.
	const host = new LoopScheduler({ dir, runner: fakeRunner(), kind: "host", getSession: () => ({ cwd: "" }), sessionExists: (id) => id === "alive" });
	try {
		const dead = await sched.store.add(makeJob({ stateful: false, sessionId: "gone", schedule: { kind: "cron", expr: "0 9 * * *" }, name: "dead" }));
		await host.tick();
		const parked = sched.store.load()[0].lastError;
		assert.match(parked ?? "", /no longer exists/);

		const refusal = await sched.runNow(dead.id);
		assert.equal(typeof refusal, "string", "a disabled plain job is refused, with a reason /cron run can print");
		assert.match(String(refusal), /disabled/);
		assert.deepEqual(rowsFor(dir, "gone"), [], "and nothing was written for a chat");
		const after = sched.store.load()[0];
		assert.equal(after.lastError, parked, "the marker is untouched");
		assert.equal(after.runCount, 0);
		assert.deepEqual((await sched.gc()).map((j) => j.name), ["dead"], "so gc can still collect it");
	} finally {
		await sched.stop();
		await host.stop();
	}
});

test("the headless host injects no plain job, and says so rather than reporting a run", async () => {
	const dir = tmp("pi-loops-sched-");
	const host = new LoopScheduler({ dir, runner: fakeRunner(), kind: "host", getSession: () => ({ cwd: "" }) });
	try {
		const job = await host.store.add(makeJob({ stateful: false, sessionId: "someone", schedule: { kind: "once", at: Date.now() + 600_000 }, prompt: "remind me" }));
		assert.equal(typeof (await host.runNow(job.id)), "string", "there is no chat to inject into");
		assert.equal(host.store.load()[0].runCount, 0, "and no run was recorded");
	} finally {
		await host.stop();
	}
});

/** What src/host-runtime.ts gives the host's scheduler: real leases, the host's own identity. */
function hostLeases(dir: string) {
	const store = new LeaseStore(dir);
	const me = { kind: "host" as const, pid: process.pid, instance: "host", acquiredAt: new Date().toISOString(), pushServers: [] };
	return {
		store,
		me,
		leases: {
			heldEpoch: (sid: string) => (store.holds(sid, me) ? store.read(sid)?.epoch : undefined),
			holderOf: (sid: string) => undefined as number | undefined,
			acquireForWork: (sid: string, runId: string, jobId: string) => {
				const got = store.acquireForHost(sid, { ...me, busy: { runId, jobId, since: new Date().toISOString() } });
				return "lease" in got ? { sessionId: sid, epoch: got.lease.epoch, sessionFile: got.lease.sessionFile!, cwd: got.lease.cwd } : undefined;
			},
			releaseWork: (sid: string) => void store.release(sid, me),
		},
	};
}

/** A conversation pi-loops has seen and nobody holds, its file untouched for ten minutes. */
function closedSession(dir: string, sid: string): string {
	const file = path.join(dir, `${sid}.jsonl`);
	fs.writeFileSync(file, "{}\n");
	const old = new Date(Date.now() - 10 * 60_000);
	fs.utimesSync(file, old, old);
	fs.mkdirSync(path.join(dir, "leases"), { recursive: true });
	fs.writeFileSync(path.join(dir, "leases", `${sid}.json`), JSON.stringify({ v: 1, sessionId: sid, sessionFile: file, cwd: dir, epoch: 2, holder: null, updatedAt: new Date().toISOString() }));
	return file;
}

test("the host injects a closed session's plain job through a held turn, and none for a session with no file", async () => {
	const dir = tmp("pi-loops-sched-");
	const { store, leases } = hostLeases(dir);
	const turns: Array<{ prompt: string; file: string; epoch: number }> = [];
	const host = new LoopScheduler({ dir, runner: fakeRunner(), kind: "host", getSession: () => ({ cwd: "" }), owns: () => true, leases, hooks: { onHeldTurn: async (_job, prompt, _runId, held) => { turns.push({ prompt, file: held.sessionFile, epoch: held.epoch }); return { preempted: false, result: okTurn(), landed: true }; } } });
	try {
		const file = closedSession(dir, "closed");
		const due = { stateful: false, schedule: { kind: "every" as const, ms: 60_000 }, createdAt: new Date(Date.now() - 90_000).toISOString(), prompt: "remind me" };
		await host.store.add(makeJob({ ...due, sessionId: "closed", name: "closed" }));
		await host.store.add(makeJob({ ...due, sessionId: "never-seen", name: "unknown" }));
		await host.tick();
		await host.drain(3000);
		assert.equal(turns.length, 1, "one held turn, for the conversation pi-loops knows the file of");
		assert.match(turns[0].prompt, /^\[Trigger run-[0-9a-f]{32}\] remind me/);
		assert.equal(turns[0].file, file);
		assert.equal(turns[0].epoch, 3, "taken under its own epoch");
		const jobs = host.store.load();
		assert.equal(jobs.find((j) => j.name === "closed")?.runCount, 1);
		assert.equal(jobs.find((j) => j.name === "unknown")?.runCount, 0, "no file, no turn: it stays asleep");
		assert.equal(store.read("closed")?.holder, null, "the conversation is given back after the turn");
	} finally {
		await host.stop();
	}
});

test("a terminal preempts the host for its own session only, and the host's aborted turn gives the slot back", async () => {
	const dir = tmp("pi-loops-sched-");
	const { store, leases } = hostLeases(dir);
	closedSession(dir, "s");
	const window = new LeaseBinding(new LeaseStore(dir), "w1", () => ({ kind: "terminal", pid: process.pid, mode: "tui", pushServers: [] }));
	const host = new LoopScheduler({
		dir, runner: fakeRunner(), kind: "host", getSession: () => ({ cwd: "" }), owns: () => true, leases,
		hooks: {
			onHeldTurn: async () => {
				// The person opens the conversation while the host is answering in it.
				const taken = window.bind("s");
				assert.equal(taken.outcome, "acquired");
				assert.equal((taken as any).tookFromHost?.pid, process.pid, "the window is told what it interrupted");
				// Taken before pi wrote the prompt: nothing landed, so the slot itself is owed.
				return { preempted: true, result: failedRun("taken back: a window opened this conversation"), landed: false };
			},
		},
	});
	const terminal = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId: "s", cwd: dir }), leases: window, owns: (job, view) => !job.stateful && runsHere(job, view) });
	try {
		// Plain jobs default to no catch-up, and the window opens well after the slot was due: the slot
		// it takes back must still run, because it was tried, not missed.
		await host.store.add(makeJob({ stateful: false, catchUp: false, sessionId: "s", schedule: { kind: "every", ms: 3_600_000 }, createdAt: new Date(Date.now() - 3_690_000).toISOString(), prompt: "remind me" }));
		await host.tick();
		await host.drain(3000);
		const after = host.store.load()[0];
		assert.equal(after.runCount, 0, "the interrupted turn is not counted");
		assert.equal(after.lastFiredAt, undefined, "and its slot is owed again");
		assert.ok(after.owedSlot, "marked as owed");
		assert.equal(after.running, undefined, "the host's marker is gone");
		assert.equal(store.read("s")?.holder?.kind, "terminal", "the host did not take the conversation back on its way out");
		terminal.start(); // its first tick runs now, long after the slot was due
		for (let i = 0; i < 60 && !rowsFor(dir, "s").length; i++) await new Promise((r) => setTimeout(r, 50));
		assert.equal(rowsFor(dir, "s").length, 1, "the window fires the slot the host gave back");
		const fired = terminal.store.load()[0];
		assert.doesNotMatch(fired.lastError ?? "", /missed/, "not reported as missed");
		assert.equal(fired.owedSlot, undefined, "the debt is paid");
	} finally {
		await host.stop();
		await terminal.stop();
	}
});

test("a held turn that fails is a failed run: recorded, counted, and a one-shot keeps its single retry", async () => {
	const dir = tmp("pi-loops-sched-");
	const { leases } = hostLeases(dir);
	closedSession(dir, "s");
	let calls = 0;
	const host = new LoopScheduler({ dir, runner: fakeRunner(), kind: "host", getSession: () => ({ cwd: "" }), owns: () => true, leases, hooks: { onHeldTurn: async () => ({ preempted: false, result: failedRun(`provider said no ${++calls}`, { usage: { input: 3, output: 0, cost: 0.02, turns: 1 } }), landed: true }) } });
	try {
		await host.store.add(makeJob({ stateful: false, sessionId: "s", schedule: { kind: "once", at: Date.now() - 1000 }, createdAt: new Date(Date.now() - 90_000).toISOString(), prompt: "send the invoice" }));
		await host.tick();
		await host.drain(3000);
		let job = host.store.load()[0];
		assert.ok(job, "a one-shot whose turn failed is not deleted");
		assert.match(job.lastError ?? "", /provider said no 1/);
		assert.equal(job.consecutiveFailures, 1);
		const runs = host.store.listRuns(undefined, 10);
		assert.equal(runs.length, 1, "the turn has a run record");
		assert.deepEqual({ ok: runs[0].ok, stateful: runs[0].stateful, forSession: runs[0].forSession, cost: runs[0].usage?.cost }, { ok: false, stateful: false, forSession: "s", cost: 0.02 });
		assert.equal(host.store.spend(0).total, 0.02, "its cost counts in the spend the daily budget reads");
	} finally {
		await host.stop();
	}
});

test("a held turn the host stops itself owes its slot, and the host runs it on its next tick despite no catch-up", async () => {
	const dir = tmp("pi-loops-sched-");
	const { leases } = hostLeases(dir);
	closedSession(dir, "s");
	let calls = 0;
	const host = new LoopScheduler({ dir, runner: fakeRunner(), kind: "host", getSession: () => ({ cwd: "" }), owns: () => true, leases, hooks: { onHeldTurn: async () => (++calls === 1 ? { preempted: false, result: failedRun("stopped by today's $5.00 daily budget ($1.00 already spent, $5.00 in flight)"), landed: false } : { preempted: false, result: okTurn(), landed: true }) } });
	try {
		await host.store.add(makeJob({ stateful: false, catchUp: false, sessionId: "s", schedule: { kind: "every", ms: 3_600_000 }, createdAt: new Date(Date.now() - 3_690_000).toISOString(), prompt: "remind me" }));
		await host.tick();
		await host.drain(3000);
		let job = host.store.load()[0];
		assert.equal(job.runCount, 0);
		assert.ok(job.owedSlot, "the stopped slot is owed");
		host.start(); // a restarted host: it starts long after the slot was due, and must still run it
		for (let i = 0; i < 60 && calls < 2; i++) await new Promise((r) => setTimeout(r, 50));
		await host.drain(3000);
		job = host.store.load()[0];
		assert.equal(calls, 2, "the owed slot ran on the next tick");
		assert.equal(job.runCount, 1);
		assert.equal(job.owedSlot, undefined);
		assert.doesNotMatch(job.lastError ?? "", /missed/);
	} finally {
		await host.stop();
	}
});

test("two hosts after a stale lock break: one dispatching from a stale snapshot does not run a slot the other already ran", async () => {
	const dir = tmp("pi-loops-sched-");
	const job = makeJob({ cwd: dir, createdAt: new Date(Date.now() - 90_000).toISOString() });
	const hostRunner = fakeRunner();
	const piRunner = fakeRunner();
	const host = new LoopScheduler({ dir, runner: hostRunner, kind: "host", getSession: () => ({ cwd: "" }) });
	const pi = new LoopScheduler({ dir, runner: piRunner, kind: "host", getSession: () => ({ cwd: "" }) });
	await host.store.add(job);
	// Hold the host between reading jobs.json and dispatching from it. In production the same gap
	// is the dispatch of the jobs listed before this one, each waiting on jobs.lock.
	let open!: () => void;
	const gate = new Promise<void>((r) => (open = r));
	const mutate = host.store.mutate.bind(host.store);
	(host.store as any).mutate = async (fn: any) => {
		const result = await mutate(fn);
		await gate;
		return result;
	};
	try {
		const hostTick = host.tick();
		await new Promise((r) => setTimeout(r, 100));
		await pi.tick();
		await pi.drain(3000);
		open();
		await hostTick;
		await host.drain(3000);
		assert.equal(piRunner.calls.length + hostRunner.calls.length, 1, `one due slot ran ${piRunner.calls.length} time(s) in the pi and ${hostRunner.calls.length} in the host`);
	} finally {
		await host.stop();
		await pi.stop();
	}
});

test("stop() gates a tick already in progress and waits for aborted runs to write their records", async () => {
	const dir = tmp("pi-loops-stop-");
	const fake = fakeRunner();
	const s = new LoopScheduler({ dir, runner: fake, getSession: () => ({ cwd: dir }) });
	const job: LoopJob = { id: "cron-stopgate", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "p", cwd: dir, enabled: true, catchUp: true, createdAt: new Date(Date.now() - 120_000).toISOString(), runCount: 0, skippedOverlap: 0 };
	await s.store.add(job);
	// A tick that is past its leadership claim when stop() is called must not launch anything.
	const tick = s.tick();
	await s.stop();
	await tick;
	assert.equal(fake.calls.length, 0, "no run launched after stop()");
	assert.equal(s.store.load()[0].running, undefined);

	// A run in flight at stop() is aborted, and its record is on disk when stop() returns.
	process.env.FAKE_PI_SLEEP = "30";
	try {
		const t = new LoopScheduler({ dir, runner: fake, getSession: () => ({ cwd: dir }) });
		t.start();
		const end = Date.now() + 5000;
		while (!t.runningCount && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
		assert.equal(t.runningCount, 1);
		await t.stop();
		const rec = t.store.listRuns("cron-stopgate")[0];
		assert.equal(rec?.ok, false);
		assert.match(rec?.error ?? "", /abort/);
		assert.equal(t.store.load()[0].running, undefined, "the running marker is cleared before stop() returns");
	} finally {
		delete process.env.FAKE_PI_SLEEP;
	}
});

test("a verify loop is not re-fired while its checker is still running", async () => {
	const dir = tmp("pi-loops-verify-");
	const fake = fakeRunner();
	const s = new LoopScheduler({ dir, runner: fake, getSession: () => ({ cwd: dir }) });
	await s.store.add({ id: "cron-verify", schedule: { kind: "every", ms: 60_000 }, stateful: true, verify: true, prompt: "watch", cwd: dir, enabled: true, catchUp: true, createdAt: new Date(Date.now() - 120_000).toISOString(), runCount: 0, skippedOverlap: 0 });
	process.env.FAKE_PI_REPLY = "<inbox>a finding</inbox>";
	process.env.FAKE_PI_CHECKER_REPLY = "<verdict 1>ok</verdict 1>";
	process.env.FAKE_PI_CHECKER_SLEEP = "2"; // the maker is quick; the checker outlives the next tick
	try {
		await s.tick();
		const end = Date.now() + 4000;
		while (!fake.calls.some((c) => c.kind === "checker") && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
		assert.ok(fake.calls.some((c) => c.kind === "checker"), "the checker started");
		await s.tick(); // a second tick lands while the checker is still working
		await s.drain(20_000);
		assert.equal(s.store.listRuns("cron-verify").length, 1, "one due slot must produce exactly one run");
		assert.equal(s.inbox.listNew().length, 1, "and exactly one inbox finding");
		assert.equal(fake.calls.filter((c) => c.kind === "loop").length, 1);
	} finally {
		delete process.env.FAKE_PI_REPLY;
		delete process.env.FAKE_PI_CHECKER_REPLY;
		delete process.env.FAKE_PI_CHECKER_SLEEP;
		await s.stop();
	}
});

test("a running marker left by a recycled pid does not park the job forever", async () => {
	const dir = tmp("pi-loops-recycled-");
	const fake = fakeRunner();
	const s = new LoopScheduler({ dir, runner: fake, getSession: () => ({ cwd: dir }) });
	const base: LoopJob = { id: "cron-recycled", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "p", cwd: dir, enabled: true, catchUp: true, createdAt: new Date(Date.now() - 120_000).toISOString(), runCount: 0, skippedOverlap: 0 };
	// process.pid is certainly alive, but the record predates this boot: it cannot be that run.
	await s.store.add({ ...base, running: { runId: "run-old", pid: process.pid + 0, host: os.hostname(), startedAt: "2000-01-01T00:00:00.000Z" } });
	try {
		await s.tick();
		await s.drain(10_000);
		assert.equal(s.store.load()[0].running?.runId, undefined, "the stale marker is cleared");
		assert.equal(s.store.listRuns("cron-recycled").length, 1, "and the owed run happens");
	} finally {
		await s.stop();
	}
});

test("a run held back by the concurrency cap says so instead of looking like it never ran", async () => {
	const dir = tmp("pi-loops-cap-");
	const s = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ cwd: dir }), getSettings: () => ({ maxConcurrentRuns: 1, catchUp: true }) });
	process.env.FAKE_PI_SLEEP = "30";
	try {
		await s.store.add(makeJob({ name: "hog" }));
		await s.tick();
		await waitFor(() => s.runningCount === 1);
		const starved = await s.store.add(makeJob({ name: "starved" }));
		await s.tick();
		const after = s.store.load().find((j) => j.id === starved.id)!;
		// "sub-agent(s)", not "run(s)": the cap is shared with trigger checks, so what is in flight is
		// not necessarily another loop run (test/slots.test.ts).
		assert.match(after.lastError ?? "", /deferred: 1 sub-agent\(s\) already in flight \(max 1\)/);
		assert.equal(after.lastDueAt, undefined, "the slot is still owed, so the next tick tries again");
		assert.equal(after.runCount, 0);
		assert.equal(s.store.listRuns(starved.id).length, 0);

		// The next dispatch that gets through clears it.
		delete process.env.FAKE_PI_SLEEP;
		await s.stop(); // aborts the hog, freeing the slot
		const t = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ cwd: dir }) });
		try {
			await t.tick();
			await t.drain(10_000);
			assert.equal(t.store.load().find((j) => j.id === starved.id)?.lastError, undefined);
		} finally {
			await t.stop();
		}
	} finally {
		delete process.env.FAKE_PI_SLEEP;
		await s.stop();
	}
});

test("a one-shot whose run failed is retried once and then retired, not left enabled forever", async () => {
	const dir = tmp("pi-loops-once-");
	const finished: any[] = [];
	const retired: Array<{ job: LoopJob; reason: string }> = [];
	const s = new LoopScheduler({
		dir,
		runner: fakeRunner(),
		getSession: () => ({ cwd: dir }),
		hooks: {
			onRunFinished: (o) => finished.push(o),
			onJobRetired: (job, reason) => retired.push({ job, reason }),
		},
	});
	process.env.FAKE_PI_FAIL = "1";
	try {
		const job = await s.store.add(makeJob({ name: "in-10m", schedule: { kind: "once", at: Date.now() - 1000 } }));
		await s.tick();
		await waitFor(() => finished.length === 1);
		const after = s.store.load()[0];
		assert.equal(after.runCount, 1);
		assert.equal(after.lastFiredAt, undefined, "the one slot is owed again: exactly one retry");
		assert.match(after.lastError ?? "", /boom \(one-shot: retrying once\)/);

		await s.tick();
		await waitFor(() => finished.length === 2);
		assert.deepEqual(s.store.load(), [], "a one-shot that failed its retry is removed, not parked enabled with no next run");
		assert.equal(s.store.listRuns().filter((r) => !r.ok).length, 2, "both failures stay in the run log");
		assert.equal(retired.length, 1, "the self-removal is reported once");
		assert.equal(retired[0].job.id, job.id);
		assert.equal(retired[0].reason, "one-shot failed twice");
	} finally {
		delete process.env.FAKE_PI_FAIL;
		await s.stop();
	}
});

test("a run aborted by a quit or a session swap gives its slot back instead of losing the tick", async () => {
	const dir = tmp("pi-loops-abort-slot-");
	const fake = fakeRunner();
	const createdAt = new Date(Date.now() - 120_000).toISOString();
	const job: LoopJob = { id: "cron-slot", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "p", cwd: dir, enabled: true, catchUp: true, createdAt, runCount: 0, skippedOverlap: 0 };
	process.env.FAKE_PI_SLEEP = "30";
	try {
		const a = new LoopScheduler({ dir, runner: fake, getSession: () => ({ cwd: dir }) });
		await a.store.add(job);
		a.start();
		const end = Date.now() + 5000;
		while (!a.runningCount && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
		assert.equal(a.runningCount, 1);
		await a.stop(); // what /new, /resume and quitting all do
		const after = a.store.load()[0];
		assert.equal(after.running, undefined);
		assert.equal(after.lastFiredAt, undefined, "the slot it claimed is handed back");
		assert.equal(after.runCount, 0, "an aborted run is not a run");
		assert.match(after.lastError ?? "", /abort/);

		// The replacement session picks it straight back up.
		delete process.env.FAKE_PI_SLEEP;
		const b = new LoopScheduler({ dir, runner: fake, getSession: () => ({ cwd: dir }) });
		try {
			await b.tick();
			await b.drain(10_000);
			assert.equal(b.store.listRuns("cron-slot").filter((r) => r.ok).length, 1, "the tick is re-fired, not lost");
		} finally {
			await b.stop();
		}
	} finally {
		delete process.env.FAKE_PI_SLEEP;
	}
});

test("a job removed by another process has its run here stopped on the next tick", async () => {
	// `/cron remove` in a window removes the job from the store; the run is in the background process,
	// and it went on to its deadline (15 minutes by default), spending as it went.
	const dir = tmp("pi-loops-remove-elsewhere-");
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ cwd: dir }) });
	process.env.FAKE_PI_SLEEP = "30";
	try {
		const job = await sched.store.add(makeJob({ name: "removed-elsewhere" }));
		await sched.tick();
		await waitFor(() => sched.runningCount === 1);
		await new JobStore(dir).remove(job.id);
		await sched.tick();
		await waitFor(() => sched.runningCount === 0);
		assert.equal(sched.runningCount, 0, "stopped, not left to its deadline");
	} finally {
		delete process.env.FAKE_PI_SLEEP;
		await sched.stop();
	}
});

test("removing a running job aborts its run and leaves no state, transcript or finding behind", async () => {
	const dir = tmp("pi-loops-remove-running-");
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ cwd: dir }) });
	process.env.FAKE_PI_SLEEP = "30";
	try {
		const job = await sched.store.add(makeJob({ name: "removed-while-running" }));
		await sched.tick();
		await waitFor(() => sched.runningCount === 1);
		const r = await sched.removeJob(job.id, { purge: true });
		assert.equal(r.aborted, 1);
		assert.equal(sched.runningCount, 0);
		assert.equal(sched.store.load().some((j) => j.id === job.id), false);
		assert.equal(fs.existsSync(sched.store.statePath(job.id)), false);
		assert.equal(fs.existsSync(path.join(dir, "sessions", job.id)), false);
		assert.equal(sched.inbox.listNew().length, 0);
		const runs = sched.store.listRuns(job.id);
		assert.equal(runs.length, 1);
		assert.equal(runs[0].ok, false);
	} finally {
		delete process.env.FAKE_PI_SLEEP;
		await sched.stop();
	}
});

test("a run whose job another process removed writes no state and no finding, but keeps its record", async () => {
	const dir = tmp("pi-loops-removed-elsewhere-");
	const finished: any[] = [];
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ cwd: dir }), hooks: { onRunFinished: (o) => finished.push(o) } });
	process.env.FAKE_PI_SLEEP = "1";
	try {
		const job = await sched.store.add(makeJob({ name: "removed-by-another-window" }));
		await sched.tick();
		await waitFor(() => sched.runningCount === 1);
		await new JobStore(dir).remove(job.id);
		await waitFor(() => finished.length === 1);
		assert.equal(fs.existsSync(sched.store.statePath(job.id)), false);
		assert.equal(sched.inbox.listNew().length, 0);
		const runs = sched.store.listRuns(job.id);
		assert.equal(runs.length, 1);
		assert.equal(runs[0].findings, 0);
		assert.equal(runs[0].stateUpdated, false);
	} finally {
		delete process.env.FAKE_PI_SLEEP;
		await sched.stop();
	}
});

test("a run whose store cannot be read still writes its record and its findings", async () => {
	const dir = tmp("pi-loops-torn-");
	const finished: any[] = [];
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ cwd: dir }), hooks: { onRunFinished: (o) => finished.push(o) } });
	process.env.FAKE_PI_SLEEP = "1";
	try {
		const job = await sched.store.add(makeJob({ name: "torn-store" }));
		await sched.tick();
		await waitFor(() => sched.runningCount === 1);
		fs.writeFileSync(path.join(dir, "jobs.json"), "   "); // a torn write while the run is in flight
		await waitFor(() => finished.length === 1);
		assert.equal(sched.store.listRuns(job.id).length, 1);
		assert.equal(sched.inbox.listNew().length, 1);
	} finally {
		delete process.env.FAKE_PI_SLEEP;
		await sched.stop();
	}
});

test("a corrupt store never escapes the tick — pi has no unhandledRejection handler to catch it", async () => {
	const dir = tmp("pi-loops-corrupt-");
	fs.writeFileSync(path.join(dir, "jobs.json"), '{"version":1,"jobs":[{"id":"cron-x"'); // truncated
	const logged: string[] = [];
	const s = new LoopScheduler({
		dir,
		runner: fakeRunner(),
		getSession: () => ({ cwd: dir }),
		// A UI hook that reads the same corrupt store, as refreshBadge does.
		hooks: { onTick: () => { throw new Error("panel read failed"); }, log: (m) => void logged.push(m) },
	});
	try {
		await s.tick(); // must resolve, not reject
		assert.ok(logged.some((m) => /tick hook failed/.test(m)), logged.join("; "));
		assert.ok(logged.some((m) => /cannot read jobs|tick failed/.test(m)), logged.join("; "));
		await s.tick(); // and keep ticking afterwards
	} finally {
		await s.stop();
	}
});

test("the scheduler says how serious each log line is instead of leaving it to be read off the wording", async () => {
	const broken = tmp("pi-loops-level-");
	fs.writeFileSync(path.join(broken, "jobs.json"), '{"version":1,"jobs":[{"id":"cron-x"'); // truncated
	const failures: Array<[string, string | undefined]> = [];
	const b = new LoopScheduler({ dir: broken, runner: fakeRunner(), getSession: () => ({ cwd: broken }), hooks: { log: (m, level) => void failures.push([m, level]) } });
	try {
		await b.tick();
	} finally {
		await b.stop();
	}
	const failed = failures.find(([m]) => /cannot read jobs|tick failed/.test(m));
	assert.ok(failed, failures.map(([m]) => m).join("; "));
	assert.notEqual(failed[1], "info", "a failure says nothing, and the receiving end reads an unset level as a warning");
});

test("a daily budget stops dispatching and leaves the slot owed", async () => {
	const dir = tmp("pi-loops-budget-");
	const fake = fakeRunner();
	let cap = 0.10;
	const exceeded: Array<[number, number]> = [];
	const s = new LoopScheduler({
		dir,
		runner: fake,
		getSession: () => ({ cwd: dir }),
		getSettings: () => ({ maxConcurrentRuns: 3, catchUp: true, dailyBudgetUsd: cap }),
		hooks: { onBudgetExceeded: (spent, c) => void exceeded.push([spent, c]) },
	});
	const createdAt = new Date(Date.now() - 120_000).toISOString();
	try {
		await s.store.add({ id: "cron-spend", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "p", cwd: dir, enabled: true, catchUp: true, createdAt, runCount: 0, skippedOverlap: 0 });
		// Under the cap: it runs. fakeRunner charges $0.001 a run.
		await s.tick();
		await s.drain(10_000);
		assert.equal(s.store.listRuns("cron-spend").length, 1);
		assert.equal(s.budgetState().over, false);

		// Now say today already cost more than the cap, and make the job due again.
		cap = 0.0005;
		await s.store.update("cron-spend", (j) => {
			j.lastFiredAt = new Date(Date.now() - 120_000).toISOString();
			j.lastDueAt = undefined;
		});
		const before = s.store.load()[0];
		await s.tick();
		await s.drain(10_000);
		const after = s.store.load()[0];
		assert.equal(s.store.listRuns("cron-spend").length, 1, "nothing more is dispatched");
		assert.match(after.lastError ?? "", /budget/);
		assert.equal(after.lastDueAt, before.lastDueAt, "the slot stays owed rather than being skipped");
		assert.equal(exceeded.length, 1, "and the user is told once, not once per tick");
		await s.tick();
		assert.equal(exceeded.length, 1);

		// Raising the cap lets it run again.
		cap = 10;
		await s.store.update("cron-spend", (j) => {
			j.lastFiredAt = new Date(Date.now() - 120_000).toISOString();
		});
		await s.tick();
		await s.drain(10_000);
		assert.equal(s.store.listRuns("cron-spend").length, 2);
	} finally {
		await s.stop();
	}
});

test("the budget also holds back a plain job's injection", async () => {
	const dir = tmp("pi-loops-budget-plain-");
	const s = new LoopScheduler({
		dir,
		runner: fakeRunner(),
		getSession: () => ({ cwd: dir, sessionId: "sess-1" }),
		getSettings: () => ({ maxConcurrentRuns: 3, catchUp: true, dailyBudgetUsd: 0.0005 }),
	});
	const createdAt = new Date(Date.now() - 120_000).toISOString();
	try {
		// A run from earlier today already put the day over the cap.
		s.store.appendRun({
			runId: "run-old", jobId: "cron-other", stateful: true, cwd: dir, pid: 1,
			startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
			ok: true, findings: 0, droppedFindings: 0, stateUpdated: false,
			usage: { input: 1, output: 1, cost: 1, turns: 1 },
		} as any);
		await s.store.add({ id: "cron-plain", sessionId: "sess-1", schedule: { kind: "every", ms: 60_000 }, stateful: false, prompt: "p", cwd: dir, enabled: true, catchUp: true, createdAt, runCount: 0, skippedOverlap: 0 });
		await s.tick();
		await s.drain(10_000);
		// Its prompt makes the parent agent take a billed turn, so the cap has to cover it too.
		assert.equal(rowsFor(dir, "sess-1").length, 0, "no prompt is queued while the day is over budget");
		assert.match(s.store.load()[0].lastError ?? "", /budget/);
		assert.equal(s.store.load()[0].runCount, 0, "and it is not recorded as having fired");
	} finally {
		await s.stop();
	}
});

test("no cap configured means no ledger read and no cap", async () => {
	const dir = tmp("pi-loops-nocap-");
	const s = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ cwd: dir }), getSettings: () => ({ maxConcurrentRuns: 3, catchUp: true, dailyBudgetUsd: 0 }) });
	try {
		const state = s.budgetState();
		assert.deepEqual(state, { spent: 0, cap: 0, over: false });
	} finally {
		await s.stop();
	}
});

test("a job that keeps failing backs off instead of re-firing at every due tick", async () => {
	const dir = tmp("pi-loops-backoff-");
	const fake = fakeRunner();
	const warnings: string[] = [];
	const s = new LoopScheduler({ dir, runner: fake, getSession: () => ({ cwd: dir }), hooks: { onSchedulerError: (m) => void warnings.push(m) } });
	const due = () => s.store.update("cron-flaky", (j) => {
		j.lastFiredAt = new Date(Date.now() - 120_000).toISOString();
		j.lastDueAt = undefined;
	});
	process.env.FAKE_PI_FAIL = "1";
	try {
		await s.store.add({ id: "cron-flaky", name: "flaky", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "p", cwd: dir, enabled: true, catchUp: true, createdAt: new Date(Date.now() - 120_000).toISOString(), runCount: 0, skippedOverlap: 0 });
		// The first three failures are retried at the normal cadence.
		for (let i = 0; i < 3; i++) {
			await s.tick();
			await s.drain(10_000);
			await due();
		}
		assert.equal(s.store.load()[0].consecutiveFailures, 3);
		assert.equal(s.store.listRuns("cron-flaky").length, 3);
		assert.equal(warnings.length, 1, "and the user is told once the streak is established");
		assert.match(warnings[0], /failed 3 times in a row/);

		// The fourth is held back even though the job is due.
		await s.tick();
		await s.drain(10_000);
		assert.equal(s.store.listRuns("cron-flaky").length, 3, "backed off rather than run");

		// One success clears the streak and normal cadence resumes.
		delete process.env.FAKE_PI_FAIL;
		await s.store.update("cron-flaky", (j) => {
			j.consecutiveFailures = undefined;
			j.lastCompletedAt = undefined;
		});
		await due();
		await s.tick();
		await s.drain(10_000);
		assert.equal(s.store.listRuns("cron-flaky").length, 4);
		assert.equal(s.store.load()[0].consecutiveFailures, undefined, "a success clears the streak");
	} finally {
		delete process.env.FAKE_PI_FAIL;
		await s.stop();
	}
});

test("a cwd that is not mounted yet is waited for, not treated as a deleted project", async () => {
	// The reboot case: a network mount, an external disk or an encrypted volume comes up after the
	// first pi does, and the job was disabled on the first miss — then stayed disabled once the
	// directory was back, which nobody notices until the work has not happened for a week.
	const dir = tmp("pi-loops-sched-");
	const project = path.join(dir, "mounted-late");
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ cwd: dir }) });
	const job = await sched.store.add(makeJob({ name: "nightly", cwd: project }));

	await sched.tick();
	let stored = sched.store.load().find((j) => j.id === job.id)!;
	assert.equal(stored.enabled, true, "still enabled while the directory might still be coming");
	assert.match(stored.lastError ?? "", /waiting: cwd .*is not there yet/);
	assert.ok(stored.cwdMissingSince, "and it remembers when it started waiting");
	assert.equal(stored.lastDueAt, undefined, "the slot is owed, not consumed");

	// The mount arrives. The owed run happens and the marker goes with the outage.
	fs.mkdirSync(project, { recursive: true });
	await sched.tick();
	await waitFor(() => (sched.store.load().find((j) => j.id === job.id)?.runCount ?? 0) > 0);
	stored = sched.store.load().find((j) => j.id === job.id)!;
	assert.equal(stored.cwdMissingSince, undefined, "the waiting marker does not outlive the outage");
	assert.equal(stored.enabled, true);

	await sched.stop();
});

test("a cwd that stays missing does eventually disable the job", async () => {
	// The other half: a deleted worktree must stop being retried, and say since when.
	const dir = tmp("pi-loops-sched-");
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ cwd: dir }) });
	const longGone = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
	const job = await sched.store.add(makeJob({ name: "moved-away", cwd: path.join(dir, "gone"), cwdMissingSince: longGone }));

	await sched.tick();
	const stored = sched.store.load().find((j) => j.id === job.id)!;
	assert.equal(stored.enabled, false, "past the grace period it is disabled");
	assert.match(stored.lastError ?? "", /disabled: cwd .*has been missing since/);

	await sched.stop();
});

test("pi-loops writes when each job runs next, including the cron expressions nothing else can work out", async () => {
	// The browser panel computed this itself and understood only `every <interval>`, so a job on
	// `0 9 * * *` — the first example in the README — showed no next run at all. A second cron
	// parser in a page with no dependencies was the wrong fix; the host has the evaluator, so it
	// writes the answers where that page already reads pi-loops' files.
	const dir = tmp("pi-loops-sched-");
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), kind: "host", getSession: () => ({ cwd: "" }) });
	const cron = await sched.store.add(makeJob({ name: "nightly", schedule: { kind: "cron", expr: "0 9 * * *" }, cwd: dir }));
	const off = await sched.store.add(makeJob({ name: "paused", schedule: { kind: "cron", expr: "0 9 * * *" }, cwd: dir, enabled: false }));
	await sched.tick();

	const file = path.join(dir, "next-runs.json");
	const doc = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.ok(doc.next[cron.id], "the cron job has a next run");
	assert.ok(Date.parse(doc.next[cron.id]) > Date.now(), "and it is ahead of us");
	assert.equal(doc.next[off.id], undefined, "a disabled job has none");

	// The timestamp moves every tick and the answers do not: an unchanged tick rewrites nothing, or
	// a machine with one nightly job writes this file 2880 times a day.
	const before = fs.statSync(file).mtimeMs;
	await new Promise((r) => setTimeout(r, 20));
	await sched.tick();
	assert.equal(fs.statSync(file).mtimeMs, before, "an unchanged tick leaves it alone");

	await sched.stop();
});

test("a dead marker whose run record exists is cleared, its bookkeeping finished, and its slot not re-run", async () => {
	// The process died between appending the run record and the store update after it: the run
	// happened. Rolling the stamps back ran it a second time.
	const dir = tmp("pi-loops-sched-");
	const fake = fakeRunner();
	const s = new LoopScheduler({ dir, runner: fake, kind: "host", getSession: () => ({ cwd: "" }) });
	try {
		const firedAt = new Date(Date.now() - 30_000).toISOString();
		const job = await s.store.add(makeJob({ cwd: dir, schedule: { kind: "every", ms: 3_600_000 }, createdAt: new Date(Date.now() - 3_700_000).toISOString(), lastDueAt: firedAt, lastFiredAt: firedAt, running: { runId: "run-dead", pid: 2 ** 22 + 7, host: os.hostname(), startedAt: firedAt } }));
		s.store.appendRun({ runId: "run-dead", jobId: job.id, stateful: true, cwd: dir, pid: 2 ** 22 + 7, startedAt: firedAt, finishedAt: new Date(Date.now() - 10_000).toISOString(), ok: false, error: "provider said no", findings: 0, droppedFindings: 0, stateUpdated: false } as any);
		await s.tick();
		await s.drain(3000);
		const after = s.store.load()[0];
		assert.equal(after.running, undefined, "the marker is cleared");
		assert.equal(fake.calls.length, 0, "the slot that already ran is not run again");
		assert.equal(after.lastFiredAt, firedAt, "its stamps are kept");
		assert.equal(after.runCount, 1);
		assert.equal(after.consecutiveFailures, 1);
		assert.equal(after.lastError, "provider said no", "and the bookkeeping is finished from the record");
	} finally {
		await s.stop();
	}
});

test("a dead marker without a record is rolled back, so the slot runs once more", async () => {
	const dir = tmp("pi-loops-sched-");
	const fake = fakeRunner();
	const s = new LoopScheduler({ dir, runner: fake, kind: "host", getSession: () => ({ cwd: "" }) });
	try {
		const firedAt = new Date(Date.now() - 30_000).toISOString();
		await s.store.add(makeJob({ cwd: dir, schedule: { kind: "every", ms: 3_600_000 }, createdAt: new Date(Date.now() - 3_700_000).toISOString(), lastDueAt: firedAt, lastFiredAt: firedAt, running: { runId: "run-dead", pid: 2 ** 22 + 7, host: os.hostname(), startedAt: firedAt } }));
		await s.tick();
		await s.drain(3000);
		assert.equal(fake.calls.length, 1, "the run that died is owed again");
		assert.equal(s.store.listRuns().length, 1);
	} finally {
		await s.stop();
	}
});

test("/cron run queues a plain one-shot's prompt and writes the same bookkeeping the timer path writes", async () => {
	// `/cron run` had its own copy of the plain-job path: no `once` retirement, no `lastDueAt` /
	// `lastCompletedAt`, and `lastError` left behind — so a fired `in 10m` job stayed enabled forever
	// with no next run, and `/cron list` still showed the error from the run before.
	const dir = tmp("pi-loops-sched-");
	const s = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId: "mine", cwd: dir }) });
	try {
		const once = await s.store.add(makeJob({ name: "in-10m", stateful: false, sessionId: "mine", schedule: { kind: "once", at: Date.now() + 600_000 }, prompt: "remind me" }));
		assert.equal(await s.runNow(once.id), true);
		let rows = rowsFor(dir, "mine");
		assert.equal(rows.length, 1);
		assert.match(rows[0].payload!.text, /^\[Trigger run-[0-9a-f]{32}\] remind me$/);
		assert.equal(rows[0].source, `cron-run:${once.id}`, "typed in its own conversation: the person's turn, not the clock's");
		assert.equal(rows[0].mode, "attended");
		assert.equal(await s.runNow(once.id), "already has its prompt queued in this conversation", "asked again while queued: collapsed, not a second prompt");
		assert.equal(rowsFor(dir, "mine").length, 1);
		assert.equal(s.store.load().length, 1, "the one-shot stays until its prompt is in the conversation");
		s.requests.remove("mine", [rows[0].id]); // the engine's removal once the prompt is in the conversation
		await s.tick();
		assert.deepEqual(s.store.load(), [], "the one-shot is retired, as it is when the timer fires it");

		const recurring = await s.store.add(makeJob({ name: "hourly", stateful: false, sessionId: "mine", schedule: { kind: "cron", expr: "0 * * * *" }, prompt: "p", lastError: "boom" }));
		assert.equal(await s.runNow(recurring.id), true);
		const after = s.store.load()[0];
		assert.equal(after.runCount, 1);
		assert.equal(after.lastError, undefined, "a queued prompt clears the error the last run left");
		assert.ok(after.lastFiredAt && after.lastCompletedAt, "and the run is on the record, not only in the chat");
	} finally {
		await s.stop();
	}
});

test("/cron run refuses a plain job of a session that is not open here, the way it refuses a disabled one", async () => {
	const dir = tmp("pi-loops-sched-");
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId: "here", cwd: dir }) });
	const theirs = await sched.store.add(makeJob({ stateful: false, sessionId: "01a09f6d-elsewhere", cwd: dir, name: "theirs" }));
	const answer = await sched.runNow(theirs.id);
	assert.equal(answer, "belongs to session 01a09f6d, which is not open here — resume it, or /cron add the job again in this chat");
	assert.equal(sched.store.load()[0].runCount, 0, "and nothing was injected anywhere");
	await sched.stop();
});

test("a finding dismissed with a reason since the previous run is in the next run's prompt, and only that one", async () => {
	const dir = tmp("pi-loops-sched-");
	const finished: string[] = [];
	const fake = fakeRunner();
	const sched = new LoopScheduler({ dir, runner: fake, getSession: () => ({ sessionId: "s1", cwd: dir }), hooks: { onRunFinished: (o) => finished.push(o.record.runId) } });
	try {
		const job = await sched.store.add(makeJob({ name: "issues" }));
		await sched.tick();
		await waitFor(() => finished.length === 1);
		assert.ok(!fake.calls[0].prompt.includes("[dismissed]"), "nothing to say on the first run");
		const [finding] = sched.inbox.listNew();
		await sched.inbox.setStatus(finding.id, "dismissed", undefined, "that is expected, stop reporting it");
		assert.equal(await sched.runNow(job.id), true);
		await waitFor(() => finished.length === 2);
		const second = fake.calls[1].prompt;
		assert.ok(second.includes("[dismissed]"), second);
		assert.ok(second.includes('- "something new" — that is expected, stop reporting it'));
		assert.equal(await sched.runNow(job.id), true);
		await waitFor(() => finished.length === 3);
		assert.ok(!fake.calls[2].prompt.includes("[dismissed]"), "said once: the run after that relies on its notes");
	} finally {
		await sched.stop();
	}
});

test("a job whose runs keep dying with their process is parked after three, and a finished run clears the count", async () => {
	const dir = tmp("pi-loops-sched-");
	const { spawnSync } = await import("node:child_process");
	const dead = spawnSync("true").pid!;
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), kind: "host", getSession: () => ({ cwd: dir }), owns: () => false });
	try {
		const running = { runId: "run-gone", pid: dead, host: os.hostname(), startedAt: new Date().toISOString() };
		await sched.store.add(makeJob({ id: "cron-parked", cwd: dir, interruptions: 2, running }));
		await sched.store.add(makeJob({ id: "cron-retry", cwd: dir, interruptions: 1, running: { ...running, runId: "run-gone-2", pid: spawnSync("true").pid! } }));
		await sched.tick();
		const jobs = sched.store.load();
		const parked = jobs.find((j) => j.id === "cron-parked")!;
		assert.equal(parked.enabled, false, "the third interruption parks it");
		assert.match(parked.lastError ?? "", /^parked: its last 3 runs were interrupted/);
		assert.equal(parked.owedSlot, undefined);
		const retried = jobs.find((j) => j.id === "cron-retry")!;
		assert.deepEqual([retried.enabled, retried.interruptions], [true, 2], "the second is still retried");
	} finally {
		await sched.stop();
	}
});

test("a process that dies with several runs in flight counts none of them toward parking", async () => {
	// One loop's crash took the runs beside it down too, and three such crashes parked every loop that
	// happened to share the process: each needed /cron enable after one bad neighbour.
	const dir = tmp("pi-loops-sched-");
	const { spawnSync } = await import("node:child_process");
	const dead = spawnSync("true").pid!;
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), kind: "host", getSession: () => ({ cwd: dir }), owns: () => false });
	try {
		const running = { runId: "run-a", pid: dead, host: os.hostname(), startedAt: new Date().toISOString() };
		await sched.store.add(makeJob({ id: "cron-a", cwd: dir, interruptions: 2, running }));
		await sched.store.add(makeJob({ id: "cron-b", cwd: dir, interruptions: 2, running: { ...running, runId: "run-b" } }));
		await sched.tick();
		for (const job of sched.store.load()) {
			assert.deepEqual([job.id, job.enabled, job.interruptions], [job.id, true, 2], "retried, not counted");
			assert.ok(job.owedSlot, "and owed again");
		}
	} finally {
		await sched.stop();
	}
});

test("a window that fires its plain job writes the job's next run at once, not a tick later", async () => {
	// The browser panel showed no next run for a third of a minute after each fire: the next-runs
	// file was written only on a tick, and the background process's still had the one just used.
	const dir = tmp("pi-loops-sched-");
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId: "mine", cwd: dir }), writesNextRuns: () => false });
	try {
		const job = await sched.store.add(makeJob({ stateful: false, sessionId: "mine", schedule: { kind: "every", ms: 60_000 }, createdAt: new Date(Date.now() - 61_000).toISOString(), prompt: "ping" }));
		await sched.tick();
		const doc = JSON.parse(fs.readFileSync(path.join(dir, "next-runs.json"), "utf8"));
		assert.ok(Date.parse(doc.next[job.id]) > Date.now(), `the next run, ahead of us, right after the fire; got ${doc.next[job.id]}`);
	} finally {
		await sched.stop();
	}
});

test("a plain job's prompt survives Esc and a window quitting and arrives once", async () => {
	const dir = tmp("pi-loops-sched-");
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId: "s", cwd: dir }) });
	try {
		await sched.store.add(makeJob({ stateful: false, sessionId: "s", schedule: { kind: "every", ms: 60_000 }, createdAt: new Date(Date.now() - 90_000).toISOString(), prompt: "remind me" }));
		await sched.tick();
		const [row] = rowsFor(dir, "s");
		assert.ok(row, "the clock wrote the prompt as a row");
		// The first window is in the middle of a turn: the row waits in the file, out of pi's reach.
		const first = fakeWindow(sched, "s");
		first.ctx.idle = false;
		await first.drainNow();
		assert.deepEqual(first.sent, [], "nothing is handed to pi while it runs");
		// Esc: the turn is aborted, pi is idle, and queued turns wait for the person.
		first.executor.agentEnded(Date.now(), true);
		first.ctx.idle = true;
		await first.drainNow();
		assert.deepEqual(first.sent, [], "held after a stop");
		// The window quits with the row still queued. The next window on the conversation drains it.
		const second = fakeWindow(sched, "s");
		await second.drainNow();
		assert.deepEqual(second.sent, [row.payload!.text], "handed to pi once it is idle");
		await second.drainNow();
		assert.equal(second.sent.length, 1, "not handed over again while pi has it");
		second.landed(row.payload!.text);
		await second.drainNow();
		assert.deepEqual(rowsFor(dir, "s"), [], "gone once pi wrote it");
		await sched.tick();
		await second.drainNow();
		assert.equal(second.sent.length, 1, "the slot was spent once: no second prompt");
		assert.equal(sched.store.load()[0].runCount, 1);
	} finally {
		await sched.stop();
	}
});

test("a crash between the row and the slot fires the slot once", async () => {
	const dir = tmp("pi-loops-sched-");
	const mk = () => new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId: "s", cwd: dir }) });
	const crashed = mk();
	const next = mk();
	try {
		await crashed.store.add(makeJob({ stateful: false, sessionId: "s", schedule: { kind: "every", ms: 60_000 }, createdAt: new Date(Date.now() - 90_000).toISOString(), prompt: "remind me" }));
		// The process ends at the second of the two writes a firing makes, whichever order they come in.
		let writes = 0;
		const ended = () => {
			if (++writes >= 2) throw new Error("the process ended here");
		};
		const append = crashed.requests.appendIfAbsent.bind(crashed.requests);
		(crashed.requests as any).appendIfAbsent = (row: any) => (ended(), append(row));
		const update = crashed.store.update.bind(crashed.store);
		(crashed.store as any).update = (id: any, fn: any) => (ended(), update(id, fn));
		await crashed.tick();
		assert.equal(rowsFor(dir, "s").length, 1, "the row is written before the slot is spent");
		assert.equal(crashed.store.load()[0].runCount, 0, "and the slot is still owed");
		await next.tick();
		const rows = rowsFor(dir, "s");
		assert.equal(rows.length, 1, `the next tick decides the same slot and writes no second row (${rows.map((r) => r.id).join(", ")})`);
		const job = next.store.load()[0];
		assert.equal(job.runCount, 1, "and spends the slot");
		assert.equal(rows[0].id, plainRunId(job.id, job.lastDueAt!), "the row's id is the slot's");
	} finally {
		await crashed.stop();
		await next.stop();
	}
});

test("a one-shot plain job is kept until its prompt is in the conversation", async () => {
	const dir = tmp("pi-loops-sched-");
	const retired: string[] = [];
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId: "s", cwd: dir }), hooks: { onJobRetired: (job, reason) => void retired.push(`${job.name}: ${reason}`) } });
	try {
		await sched.store.add(makeJob({ name: "once", stateful: false, sessionId: "s", schedule: { kind: "once", at: Date.now() - 1000 }, prompt: "remind me" }));
		await sched.tick();
		const [row] = rowsFor(dir, "s");
		assert.ok(row);
		await sched.tick();
		assert.equal(sched.store.load().length, 1, "fired, and kept while its row is queued: a quit now loses nothing");
		assert.deepEqual(retired, []);
		const window = fakeWindow(sched, "s");
		await window.drainNow();
		assert.equal(sched.store.load().length, 1, "handed to pi, not written yet: still kept");
		window.landed(row.payload!.text);
		await window.drainNow();
		assert.deepEqual(rowsFor(dir, "s"), []);
		await sched.tick();
		assert.deepEqual(sched.store.load(), [], "retired once the prompt is in the conversation");
		assert.deepEqual(retired, ["once: one-shot fired"]);
	} finally {
		await sched.stop();
	}
});

test("a held turn runs a row a window left, once", async () => {
	const dir = tmp("pi-loops-sched-");
	const { leases } = hostLeases(dir);
	closedSession(dir, "s");
	const turns: Array<{ prompt: string; runId: string }> = [];
	const host = new LoopScheduler({ dir, runner: fakeRunner(), kind: "host", getSession: () => ({ cwd: "" }), owns: () => true, leases, hooks: { onHeldTurn: async (_job, prompt, runId) => { turns.push({ prompt, runId }); return { preempted: false, result: okTurn(), landed: true }; } } });
	try {
		// The window spent the slot (the row, then the stamps) and quit before pi was idle to take it.
		const firedAt = new Date(Date.now() - 60_000).toISOString();
		const job = await host.store.add(makeJob({ stateful: false, sessionId: "s", schedule: { kind: "every", ms: 3_600_000 }, createdAt: new Date(Date.now() - 3_690_000).toISOString(), prompt: "remind me", lastDueAt: firedAt, lastFiredAt: firedAt, lastCompletedAt: firedAt, runCount: 1 }));
		const row = plainJobRow(job, plainRunId(job.id, firedAt), `cron:${job.id}`, "", { pid: 1, instance: "w1", version: "0" });
		host.requests.append(row);
		await host.tick();
		await host.drain(3000);
		assert.deepEqual(turns, [{ prompt: row.payload!.text, runId: row.id }], "the row runs as the held turn, under its own id");
		assert.deepEqual(rowsFor(dir, "s"), [], "and leaves the queue once its prompt is in the conversation");
		const after = host.store.load()[0];
		assert.equal(after.runCount, 1, "the window counted the slot when it wrote the row");
		assert.equal(after.lastFiredAt, firedAt, "no slot of the host's own was spent");
		assert.equal(host.store.listRuns(undefined, 10)[0]?.runId, row.id, "the run record is the row's");
		await host.tick();
		await host.drain(3000);
		assert.equal(turns.length, 1, "once");
	} finally {
		await host.stop();
	}
});

/** A host whose held turns are scripted: `turn(n)` answers the n-th call (1-based); every call is recorded. */
function scriptedHost(dir: string, turn: (n: number) => { preempted: boolean; result: RunnerResult; landed: boolean }) {
	const { leases } = hostLeases(dir);
	closedSession(dir, "s");
	const turns: Array<{ prompt: string; runId: string }> = [];
	const host = new LoopScheduler({ dir, runner: fakeRunner(), kind: "host", getSession: () => ({ cwd: "" }), owns: () => true, leases, hooks: { onHeldTurn: async (_job, prompt, runId) => { turns.push({ prompt, runId }); return turn(turns.length); } } });
	const ticks = async (n: number) => { for (let i = 0; i < n; i++) { await host.tick(); await host.drain(3000); } };
	return { host, turns, ticks };
}
const hourly = (over: Partial<LoopJob> = {}) => makeJob({ stateful: false, sessionId: "s", schedule: { kind: "every", ms: 3_600_000 }, createdAt: new Date(Date.now() - 3_690_000).toISOString(), prompt: "remind me", ...over });

test("a held turn stopped after its prompt landed leaves one successor prompt, not a successor and an owed slot", async () => {
	const dir = tmp("pi-loops-sched-");
	const { host, turns, ticks } = scriptedHost(dir, (n) => (n === 1 ? { preempted: false, result: failedRun("stopped by today's $5.00 daily budget"), landed: true } : { preempted: false, result: okTurn(), landed: true }));
	try {
		await host.store.add(hourly());
		await ticks(4);
		assert.equal(turns.length, 2, `the cut-off turn, then its successor once: ${turns.map((t) => t.runId).join(", ")}`);
		const job = host.store.load()[0];
		assert.equal(job.owedSlot, undefined, "the successor row was the owed slot");
		assert.deepEqual(rowsFor(dir, "s"), []);
	} finally {
		await host.stop();
	}
});

test("a held turn taken back after its prompt landed is one prompt in the window, not a successor and an owed slot", async () => {
	const dir = tmp("pi-loops-sched-");
	const { host, ticks } = scriptedHost(dir, () => ({ preempted: true, result: failedRun("taken back: a window opened this conversation"), landed: true }));
	const win = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId: "s", cwd: dir }) });
	try {
		await host.store.add(hourly());
		await ticks(1);
		await host.stop();
		assert.equal(rowsFor(dir, "s").length, 1, "the successor row waits for the window");
		const window = fakeWindow(win, "s");
		await window.drainNow();
		for (const text of window.sent) window.landed(text);
		await window.drainNow();
		await win.tick();
		await window.drainNow();
		assert.equal(window.sent.length, 1, `the successor row and the slot are one prompt, not ${window.sent.length}`);
	} finally {
		await host.stop();
		await win.stop();
	}
});

test("a row whose prompt is already in the conversation is done, not run again", async () => {
	const dir = tmp("pi-loops-sched-");
	const { host, turns, ticks } = scriptedHost(dir, () => ({ preempted: false, result: okTurn(), landed: true }));
	try {
		const firedAt = new Date(Date.now() - 60_000).toISOString();
		const job = await host.store.add(hourly({ lastDueAt: firedAt, lastFiredAt: firedAt, runCount: 1 }));
		const row = plainJobRow(job, plainRunId(job.id, firedAt), `cron:${job.id}`, "", { pid: 1, instance: "w1", version: "0" });
		host.requests.append(row);
		// A process before this one ran the row and died before removing it: the prompt is in the file.
		const file = path.join(dir, "s.jsonl");
		fs.appendFileSync(file, `${JSON.stringify({ type: "message", message: { role: "user", content: row.payload!.text } })}\n`);
		const old = new Date(Date.now() - 10 * 60_000);
		fs.utimesSync(file, old, old);
		await ticks(2);
		assert.deepEqual(turns, [], "a prompt already in the conversation is not asked again");
		assert.deepEqual(rowsFor(dir, "s"), [], "the row is done");
	} finally {
		await host.stop();
	}
});

test("a held one-shot that fails once is retried once, then retired", async () => {
	const dir = tmp("pi-loops-sched-");
	const retired: string[] = [];
	const { host, turns, ticks } = scriptedHost(dir, () => ({ preempted: false, result: failedRun("provider 500"), landed: true }));
	(host as any).hooks.onJobRetired = (_job: LoopJob, reason: string) => void retired.push(reason);
	try {
		await host.store.add(makeJob({ name: "once", stateful: false, sessionId: "s", schedule: { kind: "once", at: Date.now() - 1000 }, prompt: "remind me" }));
		await ticks(4);
		assert.equal(turns.length, 2, `one retry, then no more: ${turns.length} turns`);
		assert.deepEqual(host.store.load(), [], "retired after the second failure");
		assert.deepEqual(retired, ["one-shot failed twice (provider 500)"]);
		assert.equal(host.store.listRuns(undefined, 10).length, 2, "both failures are on the record");
	} finally {
		await host.stop();
	}
});

test("a row the background process could not land counts an attempt and backs off", async () => {
	const dir = tmp("pi-loops-sched-");
	const { host, turns, ticks } = scriptedHost(dir, () => ({ preempted: false, result: failedRun("the session could not be opened"), landed: false }));
	try {
		const firedAt = new Date(Date.now() - 60_000).toISOString();
		const job = await host.store.add(hourly({ lastDueAt: firedAt, lastFiredAt: firedAt, runCount: 1 }));
		host.requests.append(plainJobRow(job, plainRunId(job.id, firedAt), `cron:${job.id}`, "", { pid: 1, instance: "w1", version: "0" }));
		await ticks(1);
		const [row] = rowsFor(dir, "s");
		assert.equal(turns.length, 1);
		assert.equal(row?.attempts, 1, "a failure before the prompt landed is an attempt");
		assert.match(row?.last_error ?? "", /could not be opened/);
		assert.ok(row?.not_before && Date.parse(row.not_before) > Date.now(), "and the row backs off");
		await ticks(2);
		assert.equal(turns.length, 1, "not run again while it backs off");
	} finally {
		await host.stop();
	}
});

test("/cron run while the job's prompt is queued moves no stamp", async () => {
	const dir = tmp("pi-loops-sched-");
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId: "mine", cwd: dir }) });
	try {
		const job = await sched.store.add(makeJob({ stateful: false, sessionId: "mine", schedule: { kind: "every", ms: 60_000 }, createdAt: new Date(Date.now() - 90_000).toISOString(), prompt: "remind me" }));
		await sched.tick();
		const before = sched.store.load()[0];
		assert.equal(rowsFor(dir, "mine").length, 1);
		assert.equal(await sched.runNow(job.id), "already has its prompt queued in this conversation");
		const after = sched.store.load()[0];
		assert.deepEqual({ lastFiredAt: after.lastFiredAt, lastDueAt: after.lastDueAt, skippedOverlap: after.skippedOverlap, lastError: after.lastError, runCount: after.runCount }, { lastFiredAt: before.lastFiredAt, lastDueAt: before.lastDueAt, skippedOverlap: 0, lastError: undefined, runCount: 1 }, "asked for nothing new: no slot spent, no overlap counted");
	} finally {
		await sched.stop();
	}
});

test("a due slot is spent onto the row a crashed window left, not run after it", async () => {
	const dir = tmp("pi-loops-sched-");
	const { host, turns, ticks } = scriptedHost(dir, () => ({ preempted: false, result: okTurn(), landed: true }));
	try {
		// The window wrote the row for the slot an hour before the one due now, and died before the
		// swap: the stamps are untouched, so two slots have passed and one row is queued.
		const job = await host.store.add(hourly({ createdAt: new Date(Date.now() - 2 * 3_600_000 - 90_000).toISOString() }));
		const oldSlot = stamp(Date.parse(job.createdAt) + 3_600_000);
		const row = plainJobRow(job, plainRunId(job.id, oldSlot), `cron:${job.id}`, "", { pid: 1, instance: "w1", version: "0" });
		host.requests.append(row);
		await ticks(2);
		assert.deepEqual(turns.map((t) => t.runId), [row.id], "the row runs once; the slot due collapses onto it, as a window would");
		const after = host.store.load()[0];
		assert.equal(after.skippedOverlap, 1, "counted as the overlap it is");
		assert.equal(after.lastDueAt, stamp(Date.parse(job.createdAt) + 2 * 3_600_000), "the slot due is spent");
		assert.deepEqual(rowsFor(dir, "s"), []);
	} finally {
		await host.stop();
	}
});
