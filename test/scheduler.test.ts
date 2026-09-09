import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LoopScheduler } from "../src/scheduler.ts";
import { fakeRunner } from "./fake-runner.ts";
import type { LoopJob } from "../src/store.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-sched-"));

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
	const dir = tmp();
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
		const job = await sched.store.add(makeJob({ name: "issues" }));
		await sched.tick(); // claims leadership, dispatches
		await waitFor(() => finished.length === 1);

		assert.equal(sched.isLeader, true);
		assert.equal(sched.store.readState(job.id), "seen: 1");
		const inbox = sched.inbox.listNew();
		assert.equal(inbox.length, 1);
		assert.equal(inbox[0].text, "something new");
		assert.equal(inbox[0].source, "cron:issues");
		const after = sched.store.load()[0];
		assert.equal(after.runCount, 1);
		assert.equal(after.running, undefined);
		assert.equal(after.lastError, undefined);
		assert.ok(after.lastFiredAt);
		const runs = sched.store.listRuns(job.id);
		assert.equal(runs.length, 1);
		assert.equal(runs[0].ok, true);
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
	const dir = tmp();
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

test("only the leader runs loop jobs; a standby takes over after the leader stops", async () => {
	const dir = tmp();
	const a = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ cwd: dir }) });
	const b = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ cwd: dir }) });
	try {
		await a.tick();
		await b.tick();
		assert.equal(a.isLeader, true);
		assert.equal(b.isLeader, false);
		await a.stop();
		assert.equal(a.readLeader(), undefined);
		await b.tick();
		assert.equal(b.isLeader, true);
	} finally {
		await a.stop();
		await b.stop();
	}
});

test("missed ticks: catch up once by default, skip with catchUp=false; overlap is skipped", async () => {
	const dir = tmp();
	const finished: string[] = [];
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ cwd: dir }), hooks: { onRunFinished: (o) => finished.push(o.record.runId) } });
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
		assert.match(n.lastError ?? "", /missed .*catch-up disabled/);
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

test("non-stateful jobs inject only into the owning session", async () => {
	const dir = tmp();
	const injected: string[] = [];
	let sessionId = "other";
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId, cwd: dir }), hooks: { onInject: (_j, p) => void injected.push(p) } });
	try {
		await sched.store.add(makeJob({ stateful: false, sessionId: "mine", schedule: { kind: "once", at: Date.now() - 1000 }, prompt: "remind me" }));
		await sched.tick();
		assert.equal(injected.length, 0);
		sessionId = "mine";
		await sched.tick();
		assert.equal(injected.length, 1);
		assert.match(injected[0], /^\[Trigger run-[0-9a-f]{32}\] remind me/);
		assert.equal(sched.store.load().length, 0, "once jobs are removed after firing");
	} finally {
		await sched.stop();
	}
});

test("maker/checker: verify=true routes findings through the checker; drops stay out of the inbox; checker failure is fail-open", async () => {
	const dir = tmp();
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
		assert.deepEqual(inbox.map((e) => [e.text, e.verified]), [["alpha (confirmed)", true], ["gamma", undefined]]);
		assert.equal(inbox[0].verifiedReason, "confirmed");
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
		assert.ok(sched.inbox.listNew().every((e) => e.verified === undefined));
	} finally {
		delete process.env.FAKE_PI_REPLY;
		delete process.env.FAKE_PI_CHECKER_REPLY;
		delete process.env.FAKE_PI_CHECKER_FAIL;
		await sched.stop();
	}
});


test("orphan cwd disables the job instead of failing every tick; a stale run is re-fired; children get a hop", async () => {
	const dir = tmp();
	const finished: any[] = [];
	const fake = fakeRunner();
	const sched = new LoopScheduler({ dir, runner: fake, hop: 0, getSession: () => ({ cwd: dir }), hooks: { onRunFinished: (o) => finished.push(o) } });
	try {
		const orphan = await sched.store.add(makeJob({ name: "orphan", cwd: path.join(dir, "gone") }));
		const stale = await sched.store.add(makeJob({ name: "stale", running: { runId: "dead", pid: 999999, startedAt: "t" }, lastDueAt: new Date().toISOString(), lastFiredAt: new Date().toISOString() }));
		await sched.tick();
		const o = sched.store.load().find((j) => j.id === orphan.id)!;
		assert.equal(o.enabled, false);
		assert.match(o.lastError ?? "", /no longer exists/);
		await waitFor(() => finished.length === 1);
		assert.equal(finished[0].job.id, stale.id, "the run that died with its process was retried");
		assert.equal(fake.calls[0].hop, 1, "sub-agents run one hop below the interactive pi");
	} finally {
		await sched.stop();
	}
});

test("plain jobs whose session was deleted are disabled by the leader and removed by gc; jobs of another host are left alone", async () => {
	const dir = tmp();
	const live = new Set(["alive"]);
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId: "alive", cwd: dir }), sessionExists: (id) => live.has(id) });
	try {
		const ok = await sched.store.add(makeJob({ stateful: false, sessionId: "alive", schedule: { kind: "cron", expr: "0 9 * * *" }, name: "mine" }));
		const dead = await sched.store.add(makeJob({ stateful: false, sessionId: "gone", schedule: { kind: "cron", expr: "0 9 * * *" }, name: "dead" }));
		const elsewhere = await sched.store.add(makeJob({ stateful: true, host: "another-host", cwd: path.join(dir, "does-not-exist"), name: "remote" }));
		await sched.tick();
		const jobs = sched.store.load();
		assert.equal(jobs.find((j) => j.id === ok.id)?.enabled, true);
		const d = jobs.find((j) => j.id === dead.id)!;
		assert.equal(d.enabled, false, "session gone → disabled");
		assert.match(d.lastError ?? "", /session .* no longer exists/);
		const r = jobs.find((j) => j.id === elsewhere.id)!;
		assert.equal(r.enabled, true, "another host's loop is not this host's business (no orphan check, no run)");
		assert.equal(r.lastError, undefined);
		const removed = await sched.gc();
		assert.deepEqual(removed.map((j) => j.name), ["dead"]);
		assert.deepEqual(sched.store.load().map((j) => j.name).sort(), ["mine", "remote"]);
	} finally {
		await sched.stop();
	}
});

test("an interactive pi takes the clock back from the headless host; the host sees it on its next tick", async () => {
	const dir = tmp();
	const lost: boolean[] = [];
	const host = new LoopScheduler({ dir, runner: fakeRunner(), kind: "host", getSession: () => ({ cwd: "" }), hooks: { onLeadership: (l) => void lost.push(l) } });
	const pi = new LoopScheduler({ dir, runner: fakeRunner(), kind: "interactive", getSession: () => ({ sessionId: "s", cwd: dir }) });
	try {
		await host.tick();
		assert.equal(host.isLeader, true, "alone, the host keeps the clock");
		await pi.tick();
		assert.equal(pi.isLeader, true, "an interactive pi preempts a host leader immediately");
		await host.tick();
		assert.equal(host.isLeader, false);
		assert.deepEqual(lost, [true, false]);
		const other = new LoopScheduler({ dir, runner: fakeRunner(), kind: "interactive", getSession: () => ({ sessionId: "t", cwd: dir }) });
		await other.tick();
		assert.equal(other.isLeader, false, "an interactive leader is not preempted by another interactive pi");
		assert.equal(host.presenceList().find((e) => e.kind === "host")?.cwd, "", "the host is present but owns no project");
		await other.stop();
	} finally {
		await host.stop();
		await pi.stop();
	}
});

test("stop() gates a tick already in progress and waits for aborted runs to write their records", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-stop-"));
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
