import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../src/config.ts";
import { createHostRuntime } from "../src/host-runtime.ts";
import { RUNTIME_RIDERS } from "../src/ticker.ts";
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
	const dir = fs.realpathSync(tmp("pi-loops-slots-"));
	// What the user configured: two sub-agents at once, of whatever kind.
	fs.writeFileSync(path.join(dir, "config.toml"), "[cron]\nmax_concurrent_runs = 2\n");
	// Every sub-agent, a loop's run or a rule's check, is held until the end of the test.
	const calls: SubagentRequest[] = [];
	const held: Array<() => void> = [];
	const runner = async (req: SubagentRequest): Promise<RunnerResult> => {
		calls.push(req);
		await new Promise<void>((resolve) => held.push(resolve));
		return { ok: true, exitCode: 0, timedOut: false, text: "no match", usage: { input: 1, output: 1, cost: 0, turns: 1 } };
	};
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: dir }), runner, mcpTools: () => [], log: () => undefined });
	const tick = async () => { for (const name of RUNTIME_RIDERS) await host.riders[name](Date.now(), { startedAt: 0, tickMs: 30_000 }); };
	try {
		await host.stores.jobs.add(makeJob(dir, { id: "cron-0123456789abcdef0123456789abcd01", name: "hog" }));
		await tick();
		await until(() => calls.length === 1 && host.slotCount().inUse === 1, "the loop run took the first slot");

		await host.triggers.store.add({ condition: "c", action: "a", cwd: dir, fireOnce: false });
		await host.triggers.tick(Date.now(), true);
		await until(() => calls.length === 2 && host.slotCount().inUse === 2, "the periodic check took the second slot");

		// The loop's refusal: its row waits, and says why, until a slot is free.
		const starved = await host.stores.jobs.add(makeJob(dir, { id: "cron-0123456789abcdef0123456789abcd02", name: "starved" }));
		await tick();
		const waiting = host.stores.requests.list(`@${starved.id}`).filter((row) => !row.run);
		assert.deepEqual(waiting.map((row) => row.waiting), ["deferred: 2 sub-agent(s) already in flight (max 2)"]);
		assert.equal(calls.length, 2, "and no third sub-agent started");

		// The trigger runtime's refusal, which is deliberately a different one: a periodic check is
		// dropped because the next poll re-asks the same question. (A push waits as a row: test/check-lanes.test.ts.)
		assert.equal(await host.triggers.handle(buildPeriodicCheckTrigger(dir, 1, new Date(), "other"), "sub_agent"), undefined);
		assert.equal(calls.length, 2, "and it started no sub-agent");

		// Both sides hand their slot back when their sub-agent returns.
		for (const release of held.splice(0)) release();
		await until(() => host.slotCount().inUse === 0, "the run and the check released their slots");
	} finally {
		for (const release of held.splice(0)) release();
		await host.stop();
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
