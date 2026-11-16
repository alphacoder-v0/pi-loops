import { test } from "node:test";
import { automationTools } from "../src/tools.ts";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LoopScheduler } from "../src/scheduler.ts";
import { asleepNote, runsHere } from "../src/job-owner.ts";
import { fakeRunner } from "./fake-runner.ts";
import { collect } from "../src/sdk-runner.ts";
import { JobStore, type LoopJob } from "../src/store.ts";
import { LeaseBinding, LeaseStore } from "../src/lease.ts";
import { failedRun, type RunnerResult } from "../src/runner.ts";
import { stamp } from "../src/schedule.ts";
import { RequestStore, type Row } from "../src/requests.ts";
import { BACKOFF_MS } from "../src/backoff.ts";
import { type EngineSinks, drain, plainJobRow, plainRunId, typedByPerson } from "../src/engine.ts";
import { WindowExecutor } from "../src/window-executor.ts";
import { TriggerStore } from "../src/triggers.ts";

const okTurn = (): RunnerResult => ({ ok: true, exitCode: 0, timedOut: false, text: "done", usage: { input: 10, output: 5, cost: 0.01, turns: 1 } });

/** What a window's clock wrote for its conversation: the rows queued in requests/<session>.jsonl. */
const rowsFor = (dir: string, sessionId: string) => new RequestStore(dir).list(sessionId);

/**
 * A window on `sessionId`: the engine's executor over a fake pi whose turns are counted (`sent`: the
 * words of each custom message that asks for a turn), and a conversation (`entries`) the test writes
 * into when pi would have.
 */
function fakeWindow(sched: LoopScheduler, sessionId: string) {
	const sent: string[] = [];
	const entries: unknown[] = [];
	const ctx = { idle: true, mode: "tui", hasUI: false, isIdle: () => ctx.idle, sessionManager: { getEntries: () => entries }, ui: { notify: () => undefined } } as any;
	const turns: Array<{ customType: string; content: string; details: unknown }> = [];
	const pi = { sendMessage: (m: any) => void (turns.push(m), sent.push(m.content)), sendUserMessage: () => assert.fail("a plain job's prompt is not a user message") };
	const executor = new WindowExecutor(pi, { here: () => ({ sessionId, holds: true }), hold: () => true, letGo: () => undefined }, () => ctx, { pid: process.pid }, () => true, () => sched.requests.list(sessionId));
	const sinks: EngineSinks = { jobs: { exists: (id) => sched.store.load().some((j) => j.id === id), enabled: () => true, goalActive: () => false }, inbox: sched.inbox, audit: new TriggerStore(sched.requests.dir) };
	const drainNow = (now = Date.now()) => drain(sessionId, sched.requests, executor, now, sinks);
	/** pi wrote the prompt: the custom message the window sent with `text` is in the conversation, its row's mark in its details. */
	const landed = (text: string) => {
		const message = { role: "custom", ...turns.findLast((turn) => turn.content === text)! };
		executor.messageStarted(message);
		executor.messageEnded(message);
		entries.push({ type: "custom_message", ...message });
	};
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
		// An id of the shape `cron_create` gives: the loop's lane is `@` and that id.
		const job = await sched.store.add(makeJob({ id: "cron-0123456789abcdef0123456789abcdef", name: "issues", createdBy: { sessionId: "s1", cwd: dir } }));
		await sched.tick();
		await waitFor(() => finished.length === 1);

		assert.equal(sched.store.readState(job.id), "seen: 1");
		const inbox = sched.inbox.listNew();
		assert.equal(inbox.length, 1);
		assert.equal(inbox[0].text, "something new");
		assert.equal(inbox[0].source, "cron:issues");
		assert.equal(inbox[0].session_id, "s1");
		assert.equal(inbox[0].lane, "@cron-0123456789abcdef0123456789abcdef", "a loop's finding names the loop's lane");
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

test("a window standing aside names itself, not its own pid as another window", async () => {
	// It holds the lease, but its copy of the conversation is behind the file. /cron marked its own
	// jobs "open in pid <this pid>", and /cron run said to run the job in that pid: this one.
	const dir = tmp("pi-loops-sched-");
	const binding = new LeaseBinding(new LeaseStore(dir), "w1", () => ({ kind: "terminal", pid: process.pid, mode: "tui", pushServers: [] }));
	const leases = { heldEpoch: (id: string) => binding.heldEpoch(id), holderOf: (id: string) => binding.holderOf(id), standsAside: () => binding.standingAside };
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), instance: "w1", leases, getSession: () => ({ sessionId: "s", cwd: dir }) });
	try {
		assert.equal(binding.bind("s").outcome, "acquired");
		binding.standAside();
		const job = await sched.store.add(makeJob({ stateful: false, sessionId: "s", schedule: { kind: "every", ms: 60_000 }, prompt: "remind me" }));
		assert.equal(await sched.runNow(job.id), "belongs to this conversation, but this window shows an older copy of it — /resume this session to run it");
		assert.equal(asleepNote(job, sched.ownerView()), "session s — this window shows an older copy; /resume it to run here");
		// The model reads the same in cron_list: no "runs there", and no pid that is this window's own.
		const list = automationTools({ hop: 0, actor: "tool" }, { scheduler: sched, session: () => ({ sessionId: "s", cwd: dir }), refreshBadge: () => undefined } as any).find((t) => t.name === "cron_list")!;
		const out: any = await list.execute("c", {}, undefined, undefined, undefined as any);
		assert.doesNotMatch(out.content[0].text, /runs there, not here/);
		assert.equal(out.details.jobs[0].held_by_pid, undefined);
		await sched.tick();
		assert.equal(rowsFor(dir, "s").length, 0, "and it fires nothing meanwhile");
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
		assert.equal(await second.sched.runNow(job.id), "belongs to session s, which is open in a terminal — run it there");
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
	const notices: string[] = [];
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), kind: "host", getSession: () => ({ cwd: "" }), sessionExists: (id) => live.has(id), hooks: { log: (m) => void notices.push(m) } });
	try {
		const ok = await sched.store.add(makeJob({ stateful: false, sessionId: "alive", schedule: { kind: "cron", expr: "0 9 * * *" }, name: "mine" }));
		const dead = await sched.store.add(makeJob({ stateful: false, sessionId: "01a1c183-7467-7000-8000-000000000000", schedule: { kind: "cron", expr: "0 9 * * *" }, name: "dead" }));
		await sched.tick();
		const jobs = sched.store.load();
		assert.equal(jobs.find((j) => j.id === ok.id)?.enabled, true);
		const d = jobs.find((j) => j.id === dead.id)!;
		assert.equal(d.enabled, false, "session gone → disabled");
		assert.match(d.lastError ?? "", /^disabled: session 01a1c183-7467 no longer exists/, "the same short id every surface uses");
		assert.ok(notices.includes("cron dead: disabled, its session 01a1c183-7467 no longer exists"), notices.join("\n"));
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

test("a run that timed out is a failed run: its slot is spent and the failure streak rises", async () => {
	const dir = tmp("pi-loops-timeout-slot-");
	// What the runner reports when the deadline aborts the sub-session in the middle of a reply.
	const partial = { role: "assistant", provider: "p", model: "m", stopReason: "aborted", content: [{ type: "text", text: "partial" }] };
	const session = { messages: [{ role: "user" }, partial], sessionId: "sid", sessionFile: undefined, getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0.01, assistantMessages: 1 }), agent: { state: {} } };
	const sched = new LoopScheduler({ dir, runner: async (req) => collect(session as any, req, true), getSession: () => ({ cwd: dir }) });
	try {
		const job = await sched.store.add(makeJob({ cwd: dir }));
		await sched.tick();
		await sched.drain(10_000);
		const after = sched.store.load()[0];
		const [record] = sched.store.listRuns(job.id);
		assert.deepEqual([record.ok, record.error, record.aborted], [false, "timed out after 900s", undefined]);
		assert.deepEqual([after.runCount, after.consecutiveFailures], [1, 1], "the run is counted, and so is the failure");
		assert.ok(after.lastFiredAt, "the slot is not given back");
		await sched.tick();
		await sched.drain(10_000);
		assert.equal(sched.store.listRuns(job.id).length, 1, "the next tick does not run the same slot again");
	} finally {
		await sched.stop();
	}
});

test("the run summary is the first finding when the run filed one, and the reply when it filed none", async () => {
	const dir = tmp("pi-loops-summary-");
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ cwd: dir }) });
	try {
		const job = await sched.store.add(makeJob({ cwd: dir }));
		process.env.FAKE_PI_REPLY = "Looked at CI.\n<inbox>main is red: test/x.test.ts fails</inbox>\n<inbox>second</inbox>\nFiled as #220. Final state:\n<loop-state>seen: 1</loop-state>";
		assert.equal(await sched.runNow(job.id), true);
		await sched.drain(10_000);
		process.env.FAKE_PI_REPLY = "Nothing new since the last run.\n<loop-state>seen: 1</loop-state>";
		assert.equal(await sched.runNow(job.id), true);
		await sched.drain(10_000);
		assert.deepEqual(sched.store.listRuns(job.id).map((r) => r.summary), ["main is red: test/x.test.ts fails", "Nothing new since the last run."]);
	} finally {
		delete process.env.FAKE_PI_REPLY;
		await sched.stop();
	}
});

test("each run's record says which run of its loop it was, a failure counted, and a stopped run says so", async () => {
	const dir = tmp("pi-loops-ordinal-");
	const finished: string[] = [];
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ cwd: dir }), hooks: { onRunFinished: (o) => finished.push(o.record.runId) } });
	try {
		const job = await sched.store.add(makeJob());
		for (let i = 1; i <= 5; i++) {
			if (i === 4) process.env.FAKE_PI_FAIL = "1";
			assert.equal(await sched.runNow(job.id), true);
			await waitFor(() => finished.length === i);
			delete process.env.FAKE_PI_FAIL;
		}
		const runs = sched.store.listRuns(job.id);
		assert.deepEqual(runs.map((r) => [r.ordinal, r.ok]), [[1, true], [2, true], [3, true], [4, false], [5, true]]);
		assert.equal(runs.some((r) => r.aborted), false);
	} finally {
		delete process.env.FAKE_PI_FAIL;
		await sched.stop();
	}
	process.env.FAKE_PI_SLEEP = "30";
	const stopped = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ cwd: dir }) });
	try {
		assert.equal(await stopped.runNow(stopped.store.load()[0].id), true);
		await waitFor(() => stopped.runningCount === 1);
		await stopped.stop();
		const last = stopped.store.listRuns().at(-1)!;
		assert.deepEqual([last.ordinal, last.ok, last.aborted], [6, false, true]);
	} finally {
		delete process.env.FAKE_PI_SLEEP;
	}
});

test("a run asked for by hand records the conversation that asked; a scheduled one and an old caller record none", async () => {
	const dir = tmp("pi-loops-requested-");
	const finished: string[] = [];
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ cwd: dir }), hooks: { onRunFinished: (o) => finished.push(o.record.runId) } });
	try {
		const job = await sched.store.add(makeJob());
		for (let i = 1; i <= 3; i++) {
			assert.equal(await sched.runNow(job.id), true);
			await waitFor(() => finished.length === i);
		}
		assert.equal(await sched.runNow(job.id, { sessionId: "conv-b" }), true);
		await waitFor(() => finished.length === 4);
		const runs = sched.store.listRuns(job.id);
		assert.deepEqual(runs.map((r) => r.requestedBy), [undefined, undefined, undefined, { sessionId: "conv-b" }]);
		assert.equal(runs[3].ordinal, 4, "run 4 of the loop");
	} finally {
		await sched.stop();
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
	let clock = Date.now();
	const s = new LoopScheduler({ dir, runner: fake, getSession: () => ({ cwd: dir }), now: () => clock, hooks: { onSchedulerError: (m) => void warnings.push(m) } });
	const due = () => s.store.update("cron-flaky", (j) => {
		j.lastFiredAt = new Date(clock - 120_000).toISOString();
		j.lastDueAt = undefined;
	});
	process.env.FAKE_PI_FAIL = "1";
	try {
		await s.store.add({ id: "cron-flaky", name: "flaky", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "p", cwd: dir, enabled: true, catchUp: true, createdAt: new Date(clock - 120_000).toISOString(), runCount: 0, skippedOverlap: 0 });
		// The first three failures are retried at the normal cadence.
		for (let i = 0; i < 3; i++) {
			await s.tick();
			await s.drain(10_000);
			await due();
			if (i < 2) clock += 60_000;
		}
		assert.equal(s.store.load()[0].consecutiveFailures, 3);
		assert.equal(s.store.listRuns("cron-flaky").length, 3);
		assert.equal(warnings.length, 1, "and the user is told once the streak is established");
		assert.match(warnings[0], /failed 3 times in a row/);

		// The fourth waits one minute after the third failure.
		clock += 30_000;
		await due();
		await s.tick();
		await s.drain(10_000);
		assert.equal(s.store.listRuns("cron-flaky").length, 3, "not started 30 seconds after the last failure");
		clock += 30_000;
		await due();
		await s.tick();
		await s.drain(10_000);
		assert.equal(s.store.listRuns("cron-flaky").length, 4, "started once one minute has passed");

		// The fifth waits five minutes after the fourth failure.
		clock += 5 * 60_000 - 1_000;
		await due();
		await s.tick();
		await s.drain(10_000);
		assert.equal(s.store.listRuns("cron-flaky").length, 4, "four failures wait five minutes, not one");
		clock += 1_000;
		await due();
		await s.tick();
		await s.drain(10_000);
		assert.equal(s.store.listRuns("cron-flaky").length, 5);

		// One success clears the streak and normal cadence resumes.
		delete process.env.FAKE_PI_FAIL;
		await s.store.update("cron-flaky", (j) => {
			j.consecutiveFailures = undefined;
			j.lastCompletedAt = undefined;
		});
		await due();
		await s.tick();
		await s.drain(10_000);
		assert.equal(s.store.listRuns("cron-flaky").length, 6);
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
	const theirs = await sched.store.add(makeJob({ stateful: false, sessionId: "01a09f6d-e15e-7000-8000-000000000001", cwd: dir, name: "theirs" }));
	const answer = await sched.runNow(theirs.id);
	assert.equal(answer, "belongs to session 01a09f6d-e15e, which is not open here — resume it, or /cron add the job again in this chat");
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
		await sched.inbox.decide(finding.id, "dismissed", { reason: "that is expected, stop reporting it" });
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
		// Esc: the turn is aborted and pi is idle, so the queued prompt goes at once (owner decision
		// 2026-11-02: Esc stops the current turn only, as in 0.22.8).
		first.executor.agentEnded();
		first.ctx.idle = true;
		await first.drainNow();
		assert.deepEqual(first.sent, [row.payload!.text], "handed to pi as soon as it is idle, Esc or not");
		// The window quits before pi wrote it: the row is still in the file, and the next window on the
		// conversation hands it over again, so the prompt arrives there once.
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

test("a marker that an earlier version left on a plain job, for a turn whose prompt is in the conversation, is a slot that is spent: the prompt is not asked again", async () => {
	const dir = tmp("pi-loops-sched-");
	// The conversation as 0.24.2 left it: its background process wrote the prompt under a run id of its own, and died.
	const file = path.join(dir, "mine.jsonl");
	const entry = (id: string) => `${JSON.stringify({ type: "message", id: `e-${id}`, timestamp: new Date().toISOString(), message: { role: "user", content: `[Trigger ${id}] remind me` } })}\n`;
	fs.writeFileSync(file, entry("run-written"));
	const leases = { heldEpoch: () => 1, holderOf: () => undefined, sessionFile: (id: string) => (id === "mine" ? file : undefined) };
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId: "mine", cwd: dir }), leases });
	try {
		const fired = new Date(Date.now() - 30_000).toISOString();
		const base = { stateful: false, sessionId: "mine", schedule: { kind: "every" as const, ms: 3_600_000 }, createdAt: new Date(Date.now() - 3_700_000).toISOString(), prompt: "remind me", lastDueAt: fired, lastFiredAt: fired };
		const written = await sched.store.add(makeJob({ ...base, name: "written", running: { runId: "run-written", pid: 999999, startedAt: fired } }));
		const unwritten = await sched.store.add(makeJob({ ...base, name: "unwritten", running: { runId: "run-unwritten", pid: 999999, startedAt: fired } }));
		await sched.tick();
		const after = Object.fromEntries(sched.store.load().map((j) => [j.id, j]));
		assert.deepEqual([after[written.id].running, after[written.id].lastFiredAt, after[written.id].owedSlot, after[written.id].runCount, after[written.id].interruptions], [undefined, fired, undefined, 1, undefined], "spent: the stamps stand, the slot is counted, and nothing is owed");
		assert.deepEqual(rowsFor(dir, "mine").map((r) => r.source), [`cron:${unwritten.id}`], "only the turn that wrote no prompt is asked again");
		assert.equal(after[unwritten.id].running, undefined);
	} finally {
		await sched.stop();
	}
});

test("a marker that an earlier version left for a turn of a row a window queued, with the prompt written, counts no second slot: the window counted it", async () => {
	const dir = tmp("pi-loops-sched-");
	const file = path.join(dir, "other.jsonl");
	fs.writeFileSync(file, `${JSON.stringify({ type: "message", id: "e1", timestamp: new Date().toISOString(), message: { role: "user", content: "[Trigger run-left] remind me" } })}\n`);
	const leases = { heldEpoch: () => 1, holderOf: () => undefined, sessionFile: (id: string) => (id === "other" ? file : undefined) };
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId: "mine", cwd: dir }), leases });
	try {
		const fired = new Date(Date.now() - 30_000).toISOString();
		const job = await sched.store.add(makeJob({ stateful: false, sessionId: "other", schedule: { kind: "every", ms: 3_600_000 }, createdAt: new Date(Date.now() - 3_700_000).toISOString(), prompt: "remind me", lastDueAt: fired, lastFiredAt: fired, runCount: 1, running: { runId: "run-left", pid: 999_999_999, startedAt: fired } }));
		new RequestStore(dir).append({ ...plainJobRow(job, "run-left", `cron:${job.id}`, "", { pid: 1, instance: "w1", version: "0" }), lane: "other" } as any);
		await sched.tick();
		const after = sched.store.load()[0];
		assert.deepEqual([after.running, after.runCount, after.lastFiredAt, after.owedSlot], [undefined, 1, fired, undefined]);
	} finally {
		await sched.stop();
	}
});

test("a window's clock waits for a plain job whose row a run has claimed: the slot stays owed, and /cron run says it is already running", async () => {
	const dir = tmp("pi-loops-sched-");
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId: "mine", cwd: dir }) });
	try {
		const job = await sched.store.add(makeJob({ stateful: false, sessionId: "mine", schedule: { kind: "every", ms: 60_000 }, createdAt: new Date(Date.now() - 90_000).toISOString(), prompt: "remind me" }));
		// The turn pi-loops in the background was running for this job when its process stopped: the row and its claim.
		const store = new RequestStore(dir);
		store.append(plainJobRow(job, "run-claimed", `cron:${job.id}`, "", { pid: 1, instance: "host", version: "0" }));
		assert.equal(store.claim("mine", "run-claimed", { id: "run-claimed", pid: 999_999_999, started_at: new Date().toISOString() } as any), true);
		await sched.tick();
		const after = sched.store.load()[0];
		assert.deepEqual([after.lastFiredAt, after.lastDueAt, after.skippedOverlap, after.runCount], [undefined, undefined, 0, 0], "the slot is neither spent nor counted as an overlap");
		assert.deepEqual(rowsFor(dir, "mine").map((r) => r.id), ["run-claimed"], "and no second row is written beside the claimed one");
		assert.equal(await sched.runNow(job.id), "is already running");
		// The claim is closed (here: cleared, as a drain does): the slot fires at the next tick.
		store.update("mine", "run-claimed", { run: undefined });
		store.remove("mine", ["run-claimed"]);
		await sched.tick();
		assert.equal(sched.store.load()[0].runCount, 1);
	} finally {
		await sched.stop();
	}
});

test("a slot collapsed onto a queued prompt is counted as an overlap and sets no error", async () => {
	// 0.22.8 fired every slot while the chat was busy and reported no error; 0.24 collapses the later
	// slot onto the queued prompt (decision 6). The collapse is the count, not an error that outlives
	// the prompt: `/cron` and `cron_list` read `lastError` as the job's health.
	const dir = tmp("pi-loops-sched-");
	let clock = Date.now();
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), now: () => clock, getSession: () => ({ sessionId: "mine", cwd: dir }) });
	try {
		await sched.store.add(makeJob({ stateful: false, sessionId: "mine", schedule: { kind: "every", ms: 60_000 }, createdAt: new Date(clock - 90_000).toISOString(), prompt: "remind me" }));
		await sched.tick();
		assert.equal(rowsFor(dir, "mine").length, 1, "the first slot wrote the prompt");
		clock += 60_000;
		await sched.tick();
		const job = sched.store.load()[0];
		assert.equal(rowsFor(dir, "mine").length, 1, "the second slot is spent onto the queued prompt");
		assert.deepEqual({ skippedOverlap: job.skippedOverlap, lastError: job.lastError, runCount: job.runCount }, { skippedOverlap: 1, lastError: undefined, runCount: 1 });
	} finally {
		await sched.stop();
	}
});

/* --------------------------------------------------------------- a window's plain job whose turn pi did not write */

/**
 * A window on session "s" whose pi loses every turn it is handed while `losing` is true (a run takes
 * it up and settles with no entry that carries its mark, as when another extension replaces the
 * message), and writes the turn otherwise. pi refuses no custom message in silence, so a loss is the
 * one way a hand-over of a plain job's prompt fails without a throw.
 */
function losingWindow(sched: LoopScheduler, clock: () => number) {
	const entries: unknown[] = [];
	const sent: string[] = [];
	const state = { losing: true };
	const ctx = { mode: "tui", hasUI: false, isIdle: () => true, sessionManager: { getEntries: () => entries }, ui: { notify: () => undefined } } as any;
	const runs = (turn: { content: string }): void => {
		const at = clock();
		const message = { role: "custom", ...turn };
		executor.agentStarted(at);
		executor.messageStarted(message, at);
		executor.messageEnded(message, at);
		if (!state.losing) entries.push({ type: "custom_message", ...message });
		executor.agentEnded();
		executor.settled();
	};
	const pi = { sendMessage: (turn: { content: string }) => { sent.push(turn.content); runs(turn); }, sendUserMessage: () => assert.fail("a plain job's prompt is not a user message") };
	const executor: WindowExecutor = new WindowExecutor(pi as any, { here: () => ({ sessionId: "s", holds: true }), hold: () => true, letGo: () => undefined }, () => ctx, { pid: process.pid }, () => true, () => sched.requests.list("s"));
	const sinks: EngineSinks = { jobs: { exists: (id) => sched.store.load().some((j) => j.id === id), enabled: (id) => sched.store.load().find((j) => j.id === id)?.enabled ?? false, goalActive: () => false }, inbox: sched.inbox, audit: new TriggerStore(sched.requests.dir) };
	const tick = async () => {
		await sched.tick();
		return drain("s", sched.requests, executor, clock(), sinks, { tick: true });
	};
	return { entries, sent, state, executor, tick };
}

test("a plain job's turn that pi did not write is offered again with a backoff, and three such losses are one dead letter, not a job stuck until the person's next turn", async () => {
	const dir = tmp("pi-loops-sched-");
	let clock = Date.now();
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), now: () => clock, getSession: () => ({ sessionId: "s", cwd: dir }) });
	const w = losingWindow(sched, () => clock);
	const at = async (ms: number) => {
		clock += ms;
		return w.tick();
	};
	try {
		const job = await sched.store.add(makeJob({ stateful: false, sessionId: "s", schedule: { kind: "every", ms: 3_600_000 }, createdAt: new Date(clock - 3_590_000).toISOString(), prompt: "hourly check" }));
		let out = await at(60_000);
		assert.equal(w.sent.length, 1, "the slot is handed over");
		const id = out.delivered[0];
		out = await at(1_000);
		assert.deepEqual(out.failed, [id], "the run settled and no entry carries its mark: lost, with an attempt counted and no grace waited out");
		let left = rowsFor(dir, "s")[0];
		assert.deepEqual([left.attempts, left.last_error, left.not_before], [1, "pi dropped it before it was written", stamp(clock + BACKOFF_MS[0])]);
		assert.equal(w.executor.view("s").inFlight.has(id), false, "and not in flight any more");
		out = await at(BACKOFF_MS[0] - 1_000);
		assert.deepEqual([out.delivered, w.sent.length], [[], 1], "backing off");
		out = await at(1_000);
		assert.deepEqual([out.delivered, w.sent.length], [[id], 2], "offered again once the backoff is over");
		out = await at(1_000);
		assert.deepEqual([out.failed, rowsFor(dir, "s")[0].attempts], [[id], 2]);
		out = await at(BACKOFF_MS[1] + 1_000);
		assert.deepEqual([out.delivered, w.sent.length], [[id], 3]);
		out = await at(1_000);
		assert.deepEqual([out.dead, rowsFor(dir, "s")], [[id], []], "the third loss buries it");
		const dead = sched.inbox.listNew();
		assert.deepEqual([dead.length, dead[0].source, dead[0].text], [1, `cron:${job.id}`, "could not be delivered (failed 3 times: pi dropped it before it was written): hourly check"]);
		// pi works again; the next slot is a fresh row, not a skipped overlap.
		w.state.losing = false;
		out = await at(3_600_000 - (clock - Date.parse(sched.store.load()[0].lastFiredAt!)) + 1_000);
		assert.equal(out.delivered.length, 1, "the next slot runs");
		assert.equal(w.entries.length, 1, "and lands");
		const after = sched.store.load()[0];
		assert.deepEqual([after.skippedOverlap, after.lastError], [0, undefined]);
	} finally {
		await sched.stop();
	}
});

test("the job's next slot is not collapsed onto a row whose turn pi did not write: that row goes, and the slot's own row takes its place", async () => {
	const dir = tmp("pi-loops-sched-");
	let clock = Date.now();
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), now: () => clock, getSession: () => ({ sessionId: "s", cwd: dir }) });
	const w = losingWindow(sched, () => clock);
	try {
		await sched.store.add(makeJob({ stateful: false, sessionId: "s", schedule: { kind: "every", ms: 60_000 }, createdAt: new Date(clock - 90_000).toISOString(), prompt: "every minute" }));
		let out = await w.tick();
		const first = out.delivered[0];
		assert.ok(first, "the first slot is handed over");
		clock += 11_000;
		out = await w.tick();
		assert.deepEqual([out.failed, rowsFor(dir, "s")[0].attempts], [[first], 1], "lost");
		w.state.losing = false;
		clock += 50_000;
		out = await w.tick();
		const rows = rowsFor(dir, "s");
		assert.notEqual(out.delivered[0], first, "the next slot's own row is handed over");
		assert.deepEqual([rows.length, rows[0]?.attempts], [0, undefined], "and landed; the lost row is gone with the slot it stood for");
		assert.equal(w.entries.length, 1);
		const job = sched.store.load()[0];
		assert.deepEqual([job.skippedOverlap, job.lastError, job.runCount], [0, undefined, 2], "no overlap counted against a loss");
	} finally {
		await sched.stop();
	}
});

test("a plain job's clock writes nothing when it is asked with no lease on the conversation", async () => {
	const dir = tmp("pi-loops-sched-");
	// An executor that asks the clock without the lease it must take first.
	const said: string[] = [];
	const background = { owes: () => false, fire: async (_job: unknown, _due: unknown, _permit: unknown, clock: () => Promise<string>) => void said.push(await clock()) };
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), kind: "host", getSession: () => ({ cwd: "" }), owns: () => true, sessionExists: () => true, leases: { heldEpoch: () => undefined, holderOf: () => undefined }, background } as any);
	try {
		await sched.store.add(makeJob({ stateful: false, sessionId: "s", schedule: { kind: "every", ms: 60_000 }, createdAt: new Date(Date.now() - 90_000).toISOString(), prompt: "p" }));
		await sched.tick();
		await sched.stop();
		assert.deepEqual(said, ["lost"]);
		assert.deepEqual(rowsFor(dir, "s"), [], "no row in a conversation this process does not hold");
		const job = sched.store.load()[0];
		assert.deepEqual([job.lastFiredAt, job.runCount], [undefined, 0], "and the slot is still owed");
	} finally {
		await sched.stop();
	}
});

test("a plain job's slot lost to another process leaves no row behind", async () => {
	const dir = tmp("pi-loops-sched-");
	// The lease's epoch moves once the row is in the file, as it does when a pi-loops 0.22 window fired
	// the same slot between this process's row and its stamps.
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId: "s", cwd: dir }), leases: { heldEpoch: () => (rowsFor(dir, "s").length ? 2 : 1), holderOf: () => undefined } });
	try {
		await sched.store.add(makeJob({ stateful: false, sessionId: "s", schedule: { kind: "every", ms: 60_000 }, createdAt: new Date(Date.now() - 90_000).toISOString(), prompt: "p" }));
		await sched.tick();
		assert.deepEqual(rowsFor(dir, "s"), [], "the lost slot's row is removed, so the other process's prompt is the only one");
		const job = sched.store.load()[0];
		assert.deepEqual([job.lastFiredAt, job.runCount], [undefined, 0], "and no stamp moved here");
	} finally {
		await sched.stop();
	}
});

test("the scheduler reports each plain-job row it writes, so the window records /cron run's as the person's own", async () => {
	const dir = tmp("pi-loops-sched-");
	const written: Row[] = [];
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId: "mine", cwd: dir }), hooks: { onRowWritten: (row) => void written.push(row) } });
	try {
		const job = await sched.store.add(makeJob({ stateful: false, sessionId: "mine", schedule: { kind: "every", ms: 60_000 }, prompt: "deploy check" }));
		assert.equal(await sched.runNow(job.id), true);
		assert.deepEqual(written.map((r) => [r.source, typedByPerson(r.source)]), [[`cron-run:${job.id}`, true]]);
		assert.equal(await sched.runNow(job.id), "already has its prompt queued in this conversation");
		assert.equal(written.length, 1, "a collapsed ask wrote nothing");
	} finally {
		await sched.stop();
	}
});

test("a /cron run row pi refused once is not replaced by the clock's next slot: it stays the person's", async () => {
	const dir = tmp("pi-loops-sched-");
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId: "s", cwd: dir }) });
	try {
		const job = makeJob({ stateful: false, sessionId: "s", schedule: { kind: "every", ms: 60_000 }, createdAt: new Date(Date.now() - 90_000).toISOString(), prompt: "p" });
		await sched.store.add(job);
		new RequestStore(dir).append({ ...plainJobRow(job, "run-typed", `cron-run:${job.id}`, "", { pid: 1, instance: "w", version: "0" }), attempts: 1 });
		await sched.tick();
		assert.deepEqual(rowsFor(dir, "s").map((r) => [r.id, r.source, r.mode]), [["run-typed", `cron-run:${job.id}`, "attended"]], "the slot collapsed onto it");
	} finally {
		await sched.stop();
	}
});

test("a plain-job row is reported as this window's before the scheduler awaits anything", async () => {
	const dir = tmp("pi-loops-sched-");
	const seen: Array<string | undefined> = [];
	let sched: LoopScheduler;
	sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId: "s", cwd: dir }), hooks: { onRowWritten: () => void seen.push(sched.store.load()[0].lastFiredAt) } });
	try {
		await sched.store.add(makeJob({ stateful: false, sessionId: "s", schedule: { kind: "every", ms: 60_000 }, createdAt: new Date(Date.now() - 90_000).toISOString(), prompt: "p" }));
		await sched.tick();
		assert.deepEqual(seen, [undefined], "reported before the stamps were written: a drain in between already knows the row is this window's");
	} finally {
		await sched.stop();
	}
});

test("a person's stop spends the loop's slot: the record says so, the next tick runs nothing, runCount and the failure streak stay", async () => {
	const dir = tmp("pi-loops-person-stop-");
	const finished: any[] = [];
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ cwd: dir }), hooks: { onRunFinished: (o) => void finished.push(o.record) } });
	process.env.FAKE_PI_SLEEP = "30";
	try {
		const job = await sched.store.add(makeJob({ cwd: dir, consecutiveFailures: 1 }));
		await sched.tick();
		await waitFor(() => sched.runningCount === 1);
		const { runId } = sched.runningRuns()[0];
		assert.equal(sched.abortRun(runId), true);
		await waitFor(() => finished.length === 1);
		const record = sched.store.listRuns(job.id).at(-1)!;
		assert.deepEqual([record.runId, record.ok, record.aborted, record.stoppedBy, record.stoppedFrom, record.error], [runId, false, true, "person", "cli", "stopped by a person"]);
		const after = sched.store.load()[0];
		assert.equal(after.running, undefined);
		assert.ok(after.lastFiredAt, "the slot is spent, not handed back");
		assert.equal(after.runCount, 0, "a stopped run is not counted");
		assert.equal(after.consecutiveFailures, 1, "a stop is not a failure");
		await sched.tick();
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(sched.runningCount, 0, "the next tick does not run it again");
		assert.equal(sched.store.listRuns(job.id).length, 1);
	} finally {
		delete process.env.FAKE_PI_SLEEP;
		await sched.stop();
	}
});

test("a one-shot loop a person stopped is turned off with why, not run again and not deleted", async () => {
	const dir = tmp("pi-loops-person-stop-once-");
	const finished: any[] = [];
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ cwd: dir }), hooks: { onRunFinished: (o) => void finished.push(o.record) } });
	process.env.FAKE_PI_SLEEP = "30";
	try {
		const job = await sched.store.add(makeJob({ cwd: dir, name: "once-off", schedule: { kind: "once", at: Date.now() - 1000 } }));
		await sched.tick();
		await waitFor(() => sched.runningCount === 1);
		sched.abortRun(sched.runningRuns()[0].runId);
		await waitFor(() => finished.length === 1);
		const after = sched.store.load().find((j) => j.id === job.id);
		assert.ok(after, "kept, with its notes");
		assert.equal(after.enabled, false);
		assert.equal(after.lastError, "stopped by a person; /cron run once-off runs it now");
		await sched.tick();
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(sched.runningCount, 0);
	} finally {
		delete process.env.FAKE_PI_SLEEP;
		await sched.stop();
	}
});

test("a stop that lands after the run finished leaves an ok record; a quit still hands the slot back", async () => {
	const dir = tmp("pi-loops-stop-race-");
	const finished: any[] = [];
	let sched!: LoopScheduler;
	// The run's answer is in before the stop reaches it: the runner resolves ok with the stop already sent.
	const runner = async (): Promise<RunnerResult> => {
		sched.abortRun(sched.runningRuns()[0].runId);
		return okTurn();
	};
	sched = new LoopScheduler({ dir, runner, getSession: () => ({ cwd: dir }), hooks: { onRunFinished: (o) => void finished.push(o.record) } });
	try {
		const job = await sched.store.add(makeJob({ cwd: dir }));
		await sched.tick();
		await waitFor(() => finished.length === 1);
		const record = sched.store.listRuns(job.id)[0];
		assert.deepEqual([record.ok, record.aborted, record.stoppedBy], [true, undefined, undefined]);
		assert.equal(sched.store.load()[0].runCount, 1);
	} finally {
		await sched.stop();
	}
	// A quit (no reason on the signal) rolls the slot back, as it always did.
	process.env.FAKE_PI_SLEEP = "30";
	const quit = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ cwd: dir }) });
	try {
		const job = await quit.store.add(makeJob({ cwd: dir }));
		await quit.tick();
		await waitFor(() => quit.runningCount === 1);
		await quit.stop();
		const after = quit.store.load().find((j) => j.id === job.id)!;
		assert.equal(after.lastFiredAt, undefined, "handed back");
		assert.equal(quit.store.listRuns(job.id).at(-1)?.stoppedBy, undefined);
	} finally {
		delete process.env.FAKE_PI_SLEEP;
	}
});

test("a stop from the page says so on the record; one from a terminal says cli", async () => {
	const dir = tmp("pi-loops-stop-from-");
	const finished: any[] = [];
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ cwd: dir }), hooks: { onRunFinished: (o) => void finished.push(o.record) } });
	process.env.FAKE_PI_SLEEP = "30";
	try {
		await sched.store.add(makeJob({ cwd: dir }));
		await sched.tick();
		await waitFor(() => sched.runningCount === 1);
		const { runId } = sched.runningRuns()[0];
		assert.equal(sched.abortRun(runId, "page"), true);
		await waitFor(() => finished.length === 1);
		assert.deepEqual([finished[0].stoppedBy, finished[0].stoppedFrom], ["person", "page"]);
	} finally {
		delete process.env.FAKE_PI_SLEEP;
		await sched.stop();
	}
});
