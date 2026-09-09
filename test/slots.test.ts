import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LoopScheduler } from "../src/scheduler.ts";
import { SubagentSlots } from "../src/slots.ts";
import { TriggerRuntime } from "../src/trigger-runtime.ts";
import { type Trigger, TriggerStore, buildPeriodicCheckTrigger } from "../src/triggers.ts";
import type { RunnerResult, SubagentRequest } from "../src/runner.ts";
import { fakeRunner } from "./fake-runner.ts";
import type { LoopJob } from "../src/store.ts";

function makeJob(cwd: string, over: Partial<LoopJob> = {}): LoopJob {
	return {
		id: `loop-${Math.random().toString(16).slice(2, 10)}`,
		schedule: { kind: "every", ms: 60_000 },
		stateful: true,
		prompt: "check things",
		cwd,
		enabled: true,
		catchUp: true,
		createdAt: new Date(Date.now() - 120_000).toISOString(),
		runCount: 0,
		skippedOverlap: 0,
		...over,
	};
}

/** A trigger runner that blocks its first call until `open()`, so a check can be held in flight. */
function gatedRunner() {
	const calls: SubagentRequest[] = [];
	let unblock!: () => void;
	const gate = new Promise<void>((r) => (unblock = r));
	const run = async (req: SubagentRequest): Promise<RunnerResult> => {
		calls.push(req);
		if (calls.length === 1) await gate;
		return { ok: true, exitCode: 0, timedOut: false, text: "no match", usage: { input: 1, output: 1, cost: 0, turns: 1 } };
	};
	return Object.assign(run, { calls, open: () => unblock() });
}

async function until(cond: () => boolean, what: string): Promise<void> {
	const end = Date.now() + 5000;
	while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
	assert.ok(cond(), what);
}

function pushTrigger(cwd: string, over: Partial<Trigger> = {}): Trigger {
	return {
		...buildPeriodicCheckTrigger(cwd, 1),
		source: { kind: "mcp", serverName: "hub", method: "notifications/deploy" },
		sourceKind: "mcp",
		sourceLabel: "mcp:hub",
		eventLabel: "deploy finished",
		payloadSummary: "deploy 41 finished",
		...over,
	};
}

test("a loop run and a trigger check share one limit: together they exhaust max_concurrent_runs = 2", async () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-slots-")));
	// What the user configured: two sub-agents at once, of whatever kind.
	const slots = new SubagentSlots(() => 2);
	const checks = gatedRunner();
	const finished: unknown[] = [];
	const sched = new LoopScheduler({
		dir,
		slots,
		runner: fakeRunner(),
		getSession: () => ({ cwd: dir }),
		getSettings: () => ({ maxConcurrentRuns: 2, catchUp: true }),
	});
	const rt = new TriggerRuntime({
		store: new TriggerStore(dir),
		jobStore: sched.store,
		getSession: () => ({ sessionId: "s", cwd: dir }),
		runner: checks,
		pollIntervalSecs: 3600,
		slots,
		hooks: { onFinished: (o) => void finished.push(o) },
	});
	process.env.FAKE_PI_SLEEP = "30";
	try {
		await sched.store.add(makeJob(dir, { name: "hog" }));
		await sched.tick();
		await until(() => sched.runningCount === 1, "the loop run took the first slot");

		await rt.store.add({ condition: "c", action: "a", cwd: dir, fireOnce: false });
		await rt.tick(Date.now(), true);
		await until(() => checks.calls.length === 1, "the periodic check took the second slot");
		assert.equal(slots.inUseCount, 2, "one run and one check are two sub-agents, not one of each kind");

		// The scheduler's refusal: the tick is still owed, so the next one tries again.
		const starved = await sched.store.add(makeJob(dir, { name: "starved" }));
		await sched.tick();
		const after = sched.store.load().find((j) => j.id === starved.id)!;
		assert.match(after.lastError ?? "", /deferred: 2 sub-agent\(s\) already in flight \(max 2\)/);
		assert.equal(after.lastDueAt, undefined, "the slot is still owed, so the next tick tries again");
		assert.equal(after.runCount, 0);

		// The trigger runtime's refusal, which is deliberately a different one: a push is held,
		// a periodic check is dropped because the next poll re-asks the same question.
		assert.equal(await rt.handle(pushTrigger(dir, { traceId: "push-1" }), "sub_agent"), undefined, "no slot free: nothing is delivered now");
		assert.equal(rt.pendingPushCount, 1, "the event is kept: no server sends it twice");
		assert.equal(await rt.handle(buildPeriodicCheckTrigger(dir, 1, new Date(), "other"), "sub_agent"), undefined);
		assert.equal(rt.pendingPushCount, 1, "only pushes are held");
		assert.equal(checks.calls.length, 1, "and neither started a sub-agent");

		// Both sides hand their slot back when their sub-agent returns.
		checks.open();
		await until(() => finished.length === 1, "the blocking check finished");
		await until(() => slots.inUseCount === 1, "the check released its slot, leaving the loop run's");
	} finally {
		delete process.env.FAKE_PI_SLEEP;
		checks.open();
		await rt.stop();
		await sched.stop();
	}
});

test("work the user asked for directly is never refused a slot, so the count can exceed the limit", async () => {
	const slots = new SubagentSlots(() => 1);
	const run = slots.acquire();
	assert.ok(run, "the first sub-agent gets the only slot");
	assert.equal(slots.acquire(), undefined, "the second is refused");

	// `/cron run` and the /goal evaluator: counted, never refused. This is where `4 of 3 slots in
	// use` comes from.
	const evaluator = slots.occupy();
	assert.equal(slots.inUseCount, 2);
	assert.equal(slots.free, 0, "an overrun leaves no free slots, it does not go negative");

	// The release sites are `finally` blocks that can run on more than one path.
	evaluator.release();
	evaluator.release();
	assert.equal(slots.inUseCount, 1, "releasing twice frees one slot, not two");
	run.release();
	assert.equal(slots.inUseCount, 0);
});
