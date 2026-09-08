import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LoopScheduler } from "../src/scheduler.ts";
import { runPiSubagent } from "../src/runner.ts";
import type { LoopJob } from "../src/store.ts";

const FAKE_PI = path.join(import.meta.dirname, "fake-pi.sh");
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

test("runner parses fake pi JSON output", async () => {
	const r = await runPiSubagent({ cwd: os.tmpdir(), prompt: "hi", timeoutMs: 5000, piBin: FAKE_PI });
	assert.equal(r.ok, true);
	assert.ok(r.text.includes("<inbox>"));
	assert.equal(r.model, "fake/model");
	assert.equal(r.usage.turns, 1);
	const f = await runPiSubagent({ cwd: os.tmpdir(), prompt: "hi", timeoutMs: 5000, piBin: FAKE_PI, env: { FAKE_PI_FAIL: "1" } });
	assert.equal(f.ok, false);
	assert.equal(f.exitCode, 3);
	assert.match(f.errorMessage ?? "", /boom/);
	const t = await runPiSubagent({ cwd: os.tmpdir(), prompt: "hi", timeoutMs: 300, piBin: FAKE_PI, env: { FAKE_PI_SLEEP: "3" } });
	assert.equal(t.timedOut, true);
	assert.equal(t.ok, false);
});

test("a due loop job runs in the fake sub-agent, writes state, routes findings to the inbox", async () => {
	const dir = tmp();
	const finished: string[] = [];
	const sched = new LoopScheduler({
		dir,
		piBin: FAKE_PI,
		getSession: () => ({ sessionId: "s1", cwd: dir, model: "test/model", thinking: "low" }),
		hooks: { onRunFinished: (o) => finished.push(o.record.runId) },
	});
	const promptFile = path.join(dir, "prompt.txt");
	const argsFile = path.join(dir, "args.txt");
	const envFile = path.join(dir, "env.txt");
	process.env.FAKE_PI_PROMPT_FILE = promptFile;
	process.env.FAKE_PI_ARGS_FILE = argsFile;
	process.env.FAKE_PI_ENV_FILE = envFile;
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
		const args = fs.readFileSync(argsFile, "utf8").split("\n");
		assert.ok(args.includes("--mode") && args.includes("json") && args.includes("--session-dir") && args.includes("-p"));
		assert.ok(!args.includes("--no-session"));
		assert.ok(args.includes("test/model"));
		assert.ok(args.includes("low"));
		assert.match(fs.readFileSync(envFile, "utf8"), /PI_LOOPS_CHILD=1/);

		// Second tick right away: nothing due (interval not elapsed), state carried into the next prompt.
		await sched.tick();
		assert.equal(finished.length, 1);
		assert.equal(await sched.runNow(job.id), true);
		await waitFor(() => finished.length === 2);
		assert.ok(fs.readFileSync(promptFile, "utf8").includes("seen: 1"));
	} finally {
		delete process.env.FAKE_PI_PROMPT_FILE;
		delete process.env.FAKE_PI_ARGS_FILE;
		delete process.env.FAKE_PI_ENV_FILE;
		await sched.stop();
	}
});

test("failed run keeps state untouched and records the error", async () => {
	const dir = tmp();
	const finished: string[] = [];
	const sched = new LoopScheduler({ dir, piBin: FAKE_PI, getSession: () => ({ cwd: dir }), hooks: { onRunFinished: (o) => finished.push(o.record.runId) } });
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
	const a = new LoopScheduler({ dir, piBin: FAKE_PI, getSession: () => ({ cwd: dir }) });
	const b = new LoopScheduler({ dir, piBin: FAKE_PI, getSession: () => ({ cwd: dir }) });
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
	const sched = new LoopScheduler({ dir, piBin: FAKE_PI, getSession: () => ({ cwd: dir }), hooks: { onRunFinished: (o) => finished.push(o.record.runId) } });
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
	const sched = new LoopScheduler({ dir, piBin: FAKE_PI, getSession: () => ({ sessionId, cwd: dir }), hooks: { onInject: (_j, p) => void injected.push(p) } });
	try {
		await sched.store.add(makeJob({ stateful: false, sessionId: "mine", schedule: { kind: "once", at: Date.now() - 1000 }, prompt: "remind me" }));
		await sched.tick();
		assert.equal(injected.length, 0);
		sessionId = "mine";
		await sched.tick();
		assert.equal(injected.length, 1);
		assert.match(injected[0], /^\[Trigger run-[0-9a-f]{8}\] remind me/);
		assert.equal(sched.store.load().length, 0, "once jobs are removed after firing");
	} finally {
		await sched.stop();
	}
});

test("maker/checker: verify=true routes findings through the checker; drops stay out of the inbox; checker failure is fail-open", async () => {
	const dir = tmp();
	const finished: any[] = [];
	const sched = new LoopScheduler({ dir, piBin: FAKE_PI, getSession: () => ({ cwd: dir, model: "m/x" }), hooks: { onRunFinished: (o) => finished.push(o) } });
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
