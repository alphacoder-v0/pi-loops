import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FOREIGN_RUN_STALE_MS, LoopScheduler } from "../src/scheduler.ts";
import { fakeRunner } from "./fake-runner.ts";
import type { LoopJob } from "../src/store.ts";


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

test("only the leader runs loop jobs; a standby takes over after the leader stops", async () => {
	const dir = tmp("pi-loops-sched-");
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
	const dir = tmp("pi-loops-sched-");
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

test("non-stateful jobs inject only into the owning session, and the hook is handed the run id", async () => {
	const dir = tmp("pi-loops-sched-");
	const injected: Array<{ prompt: string; runId: string }> = [];
	let sessionId = "other";
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId, cwd: dir }), hooks: { onInject: (_j, prompt, runId) => void injected.push({ prompt, runId }) } });
	try {
		await sched.store.add(makeJob({ stateful: false, sessionId: "mine", schedule: { kind: "once", at: Date.now() - 1000 }, prompt: "remind me" }));
		await sched.tick();
		assert.equal(injected.length, 0);
		sessionId = "mine";
		await sched.tick();
		assert.equal(injected.length, 1);
		assert.match(injected[0].prompt, /^\[Trigger run-[0-9a-f]{32}\] remind me/);
		assert.ok(injected[0].prompt.startsWith(`[Trigger ${injected[0].runId}] `), `the id is handed over, not parsed back out of ${injected[0].prompt}`);
		assert.equal(sched.store.load().length, 0, "once jobs are removed after firing");
	} finally {
		await sched.stop();
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

test("plain jobs whose session was deleted are disabled by the leader and removed by gc", async () => {
	const dir = tmp("pi-loops-sched-");
	const live = new Set(["alive"]);
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId: "alive", cwd: dir }), sessionExists: (id) => live.has(id) });
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
	const injected: string[] = [];
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId: "alive", cwd: dir }), sessionExists: (id) => id === "alive", hooks: { onInject: (_j, p) => void injected.push(p) } });
	try {
		const dead = await sched.store.add(makeJob({ stateful: false, sessionId: "gone", schedule: { kind: "cron", expr: "0 9 * * *" }, name: "dead" }));
		await sched.tick();
		const parked = sched.store.load()[0].lastError;
		assert.match(parked ?? "", /no longer exists/);

		const refusal = await sched.runNow(dead.id);
		assert.equal(typeof refusal, "string", "a disabled plain job is refused, with a reason /cron run can print");
		assert.match(String(refusal), /disabled/);
		assert.deepEqual(injected, [], "and nothing reached a chat");
		const after = sched.store.load()[0];
		assert.equal(after.lastError, parked, "the marker is untouched");
		assert.equal(after.runCount, 0);
		assert.deepEqual((await sched.gc()).map((j) => j.name), ["dead"], "so gc can still collect it");
	} finally {
		await sched.stop();
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

test("an interactive pi takes the clock back from the headless host; the host sees it on its next tick", async () => {
	const dir = tmp("pi-loops-sched-");
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

test("a running marker left by a recycled pid or another machine does not park the job forever", async () => {
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

		// A marker from another machine is left alone until it is a day old.
		await s.store.update("cron-recycled", (j) => {
			j.running = { runId: "run-elsewhere", pid: 1, host: "another-machine", startedAt: new Date().toISOString() };
		});
		await s.tick();
		assert.equal(s.store.load()[0].running?.runId, "run-elsewhere", "another host's in-flight run is not cleared");
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
	const s = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ cwd: dir }), hooks: { onRunFinished: (o) => finished.push(o) } });
	process.env.FAKE_PI_FAIL = "1";
	try {
		await s.store.add(makeJob({ name: "in-10m", schedule: { kind: "once", at: Date.now() - 1000 } }));
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

test("a corrupt store never escapes the tick — pi has no unhandledRejection handler to catch it", async () => {
	const dir = tmp("pi-loops-corrupt-");
	fs.writeFileSync(path.join(dir, "jobs.json"), '{"version":1,"jobs":[{"id":"cron-x"'); // truncated
	const logged: string[] = [];
	const s = new LoopScheduler({
		dir,
		runner: fakeRunner(),
		getSession: () => ({ cwd: dir }),
		// A UI hook that reads the same corrupt store, as refreshBadge does.
		hooks: { onLeadership: () => { throw new Error("panel read failed"); }, log: (m) => void logged.push(m) },
	});
	try {
		await s.tick(); // must resolve, not reject
		assert.ok(logged.some((m) => /leadership hook failed/.test(m)), logged.join("; "));
		assert.ok(logged.some((m) => /cannot read jobs|tick failed/.test(m)), logged.join("; "));
		await s.tick(); // and keep ticking afterwards
	} finally {
		await s.stop();
	}
});

test("the scheduler says how serious each log line is instead of leaving it to be read off the wording", async () => {
	const dir = tmp("pi-loops-sched-");
	const routine: Array<[string, string | undefined]> = [];
	const s = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ cwd: dir }), hooks: { log: (m, level) => void routine.push([m, level]) } });
	try {
		await s.tick(); // takes the timer over
	} finally {
		await s.stop();
	}
	const takeover = routine.find(([m]) => /took over the loop scheduler/.test(m));
	assert.ok(takeover, routine.map(([m]) => m).join("; "));
	assert.equal(takeover[1], "info", "holding the timer is bookkeeping, not a warning");

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
	const injected: string[] = [];
	const s = new LoopScheduler({
		dir,
		runner: fakeRunner(),
		getSession: () => ({ cwd: dir, sessionId: "sess-1" }),
		getSettings: () => ({ maxConcurrentRuns: 3, catchUp: true, dailyBudgetUsd: 0.0005 }),
		hooks: { onInject: async (_job, text) => void injected.push(text) },
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
		// Injecting one makes the parent agent take a billed turn, so the cap has to cover it too.
		assert.equal(injected.length, 0, "nothing is injected while the day is over budget");
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

test("the leader writes when each job runs next, including the cron expressions nothing else can work out", async () => {
	// The browser panel computed this itself and understood only `every <interval>`, so a job on
	// `0 9 * * *` — the first example in the README — showed no next run at all. A second cron
	// parser in a page with no dependencies was the wrong fix; the process that owns the clock has
	// the evaluator, so it writes the answers where that page already reads pi-loops' files.
	const dir = tmp("pi-loops-sched-");
	const sched = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ cwd: dir }) });
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

test("a foreign run marker ages out against the scheduler's own clock", async () => {
	// The class routes time through `now()` so tests can move it; this one branch read `Date.now()`,
	// so the 24-hour rule for a marker left by another machine could not be exercised at all.
	const dir = tmp("pi-loops-sched-");
	let now = Date.now();
	const s = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ cwd: dir }), now: () => now });
	try {
		await s.store.add(makeJob({ name: "foreign", running: { runId: "run-elsewhere", pid: 1, host: "another-machine", startedAt: new Date(now).toISOString() } }));
		await s.tick();
		assert.equal(s.store.load()[0].running?.runId, "run-elsewhere", "a fresh marker is left to the host that owns it");

		now += FOREIGN_RUN_STALE_MS + 60_000;
		await s.tick();
		await s.drain(10_000);
		assert.equal(s.store.load()[0].running, undefined, "a day-old marker from a machine that never came back is cleared");
		assert.match(s.store.load()[0].lastError ?? "", /cleared stale running state|^$/);
	} finally {
		await s.stop();
	}
});

test("/cron run retires a plain one-shot and writes the same bookkeeping the timer path writes", async () => {
	// `/cron run` had its own copy of the plain-job path: no `once` retirement, no `lastDueAt` /
	// `lastCompletedAt`, and `lastError` left behind — so a fired `in 10m` job stayed enabled forever
	// with no next run, and `/cron list` still showed the error from the run before.
	const dir = tmp("pi-loops-sched-");
	const injected: string[] = [];
	const s = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId: "mine", cwd: dir }), hooks: { onInject: (_j, p) => void injected.push(p) } });
	try {
		const once = await s.store.add(makeJob({ name: "in-10m", stateful: false, sessionId: "mine", schedule: { kind: "once", at: Date.now() + 600_000 }, prompt: "remind me" }));
		assert.equal(await s.runNow(once.id), true);
		assert.equal(injected.length, 1);
		assert.match(injected[0], /^\[Trigger run-[0-9a-f]{32}\] remind me$/);
		assert.deepEqual(s.store.load(), [], "the one-shot is retired, as it is when the timer fires it");

		const recurring = await s.store.add(makeJob({ name: "hourly", stateful: false, sessionId: "mine", schedule: { kind: "cron", expr: "0 * * * *" }, prompt: "p", lastError: "boom" }));
		assert.equal(await s.runNow(recurring.id), true);
		const after = s.store.load()[0];
		assert.equal(after.runCount, 1);
		assert.equal(after.lastError, undefined, "a successful injection clears the error the last one left");
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
