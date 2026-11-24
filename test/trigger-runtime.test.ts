import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { JobStore } from "../src/store.ts";
import { TriggerRuntime } from "../src/trigger-runtime.ts";
import { deliverInjectSummary } from "../src/push.ts";
import { triggerSessionKey } from "../src/check-run.ts";
import { checkLane, parseLane } from "../src/lane.ts";
import { type Trigger, TriggerStore, buildPeriodicCheckTrigger } from "../src/triggers.ts";
import { fakeRunner } from "./fake-runner.ts";

function setup() {
	const dir = tmp("pi-loops-trt-");
	const promoted: string[] = [];
	const injected: string[] = [];
	const finished: any[] = [];
	const rt = new TriggerRuntime({
		store: new TriggerStore(dir),
		jobStore: new JobStore(dir),
		getSession: () => ({ sessionId: "s", cwd: dir }),
		runner: fakeRunner(),
		pollIntervalSecs: 1,
		hooks: { onPromote: (c) => { promoted.push(c); return "chat"; }, onInjectAndRun: (p) => { injected.push(p); return "chat"; }, onFinished: (o) => void finished.push(o) },
	});
	return { dir, rt, promoted, injected, finished };
}

test("quiet check and dedup", async () => {
	const { dir, rt, promoted, injected, finished } = setup();
	await rt.store.add({ condition: "c", action: "d", cwd: dir });
	process.env.FAKE_PI_REPLY = "no dynamic trigger rule matched";
	try {
		const t = buildPeriodicCheckTrigger(dir, 1);
		const out = await rt.handle(t, "sub_agent");
		assert.equal(out?.ok, true);
		assert.equal(out?.matchedRules.length, 0);
		assert.equal(rt.lastPoll?.outcome, "no match");
		assert.equal(await rt.handle({ ...t, traceId: "other" }, "sub_agent"), undefined, "same idempotency key inside the window is deduped");
		assert.equal(rt.dedupedCount, 1);
		assert.equal(finished.length, 1);
	} finally {
		delete process.env.FAKE_PI_REPLY;
		await rt.stop();
	}
});


test("promotion routed to the inbox is audited as redirected; checks carry the rule's model and a hop", async () => {
	const dir = tmp("pi-loops-trt-");
	const finished: any[] = [];
	const fake = fakeRunner();
	const rt = new TriggerRuntime({
		store: new TriggerStore(dir),
		jobStore: new JobStore(dir),
		getSession: () => ({ sessionId: "s", cwd: dir, model: "leader/model" }),
		runner: fake,
		hop: 0,
		hooks: { onPromote: () => "inbox", onInjectAndRun: () => "inbox", onFinished: (o) => void finished.push(o) },
	});
	try {
		const r = await rt.store.add({ condition: "c", action: "a", cwd: dir, promoteToChat: true, model: "creator/model", thinking: "high" });
		process.env.FAKE_PI_REPLY = `matched ${r.id}`;
		const out = await rt.handle(buildPeriodicCheckTrigger(dir, 1), "sub_agent");
		assert.equal(out?.promoted, false);
		assert.equal(rt.store.listAudit(1)[0].state, "redirected");
		assert.equal(fake.calls[0].model, "creator/model", "check ran with the rule creator's model, not the timer owner's");
		assert.equal(fake.calls[0].thinking, "high");
		assert.equal(fake.calls[0].hop, 1);
		assert.equal(fake.calls[0].parentSessionId, "s", "sub-agents know the session that runs them (plain cron jobs they create bind to it)");
		assert.equal(fake.calls[0].kind, "trigger");
	} finally {
		delete process.env.FAKE_PI_REPLY;
		await rt.stop();
	}
});

test("sub-agent processes never act on triggers: hop ≥ 1 is cycle_suppressed, no pi is spawned", async () => {
	const dir = tmp("pi-loops-trt-");
	const logs: string[] = [];
	const promoted: string[] = [];
	const fake = fakeRunner();
	const rt = new TriggerRuntime({ store: new TriggerStore(dir), jobStore: new JobStore(dir), getSession: () => ({ sessionId: "s", cwd: dir }), runner: fake, hop: 1, hooks: { onPromote: (c) => { promoted.push(c); return "chat"; }, log: (m) => void logs.push(m) } });
	try {
		await rt.store.add({ condition: "c", action: "a", cwd: dir });
		const t = buildPeriodicCheckTrigger(dir, 1);
		assert.equal(await rt.handle(t, "sub_agent"), undefined);
		assert.equal(fake.calls.length, 0, "no sub-agent started from a sub-agent");
		assert.equal(await rt.handle({ ...t, traceId: "m1", idempotencyKey: "mcp:x:tools" }, "inject_summary"), undefined, "pushes are not delivered from a sub-agent either");
		assert.equal(promoted.length, 0);
		assert.deepEqual(rt.store.listAudit(10).map((r) => `${r.type}:${r.state}`), ["trigger:cycle_suppressed", "trigger:cycle_suppressed"]);
		assert.equal((rt.store.listAudit(1)[0].details as any).hop_count, 1);
		assert.equal(rt.cycleSuppressedCount, 2);
		assert.ok(logs.some((m) => /cycle_suppressed/.test(m)));
	} finally {
		await rt.stop();
	}
});

test("persistence failures never reject handle(): audit is best-effort, delivery still happens, errors are logged", async () => {
	const dir = tmp("pi-loops-trt-");
	fs.mkdirSync(path.join(dir, "triggers-audit.jsonl")); // appendFileSync → EISDIR
	const logs: string[] = [];
	const promoted: string[] = [];
	const store = new TriggerStore(dir);
	const rt = new TriggerRuntime({ store, jobStore: new JobStore(dir), getSession: () => ({ sessionId: "s", cwd: dir }), runner: fakeRunner(), pollIntervalSecs: 1, hooks: { onPromote: (c) => { promoted.push(c); return "chat"; }, log: (m) => void logs.push(m) } });
	const t = { ...buildPeriodicCheckTrigger(dir, 1), traceId: "m1", idempotencyKey: "mcp:x:tools", sourceLabel: "mcp:x", eventLabel: "e", payloadSummary: "s", cwd: undefined };
	// An injecting push is delivered outside the runtime (src/push.ts); the runtime still reports the store's failure.
	const out = await deliverInjectSummary({ audit: store, budget: () => ({ spent: 0, cap: 0, over: false }), promote: (c) => { promoted.push(c); return "chat"; }, now: Date.now }, t);
	assert.equal(out?.ok, true, "delivery happens even when the audit file cannot be written");
	assert.equal(promoted.length, 1);
	assert.match(store.lastPersistenceError ?? "", /EISDIR/);
	assert.ok(logs.some((m) => /audit/.test(m)), "the failure is reported through the log hook");
	assert.deepEqual(store.listAudit(5), [], "listAudit tolerates the broken file");

	// A dedup window that cannot be persisted: handle() resolves (undefined) instead of rejecting.
	const dir2 = tmp("pi-loops-trt-");
	fs.mkdirSync(path.join(dir2, "dedup.json")); // rename over a directory fails
	const logs2: string[] = [];
	const finished: any[] = [];
	const rt2 = new TriggerRuntime({ store: new TriggerStore(dir2), jobStore: new JobStore(dir2), getSession: () => ({ sessionId: "s", cwd: dir2 }), runner: fakeRunner(), pollIntervalSecs: 1, dedupFile: path.join(dir2, "dedup.json"), hooks: { onFinished: (o) => void finished.push(o), log: (m) => void logs2.push(m) } });
	await rt2.store.add({ condition: "c", action: "a", cwd: dir2 });
	assert.equal(await rt2.handle(buildPeriodicCheckTrigger(dir2, 1), "sub_agent"), undefined);
	assert.ok(logs2.some((m) => /dedup|trigger .* failed/i.test(m)), `expected a logged failure, got ${JSON.stringify(logs2)}`);
	assert.equal(finished.length, 0);
	await rt.stop();
	await rt2.stop();
});

function pushTrigger(dir: string, over: Partial<Trigger> = {}): Trigger {
	return {
		...buildPeriodicCheckTrigger(dir, 1),
		source: { kind: "mcp", serverName: "hub", method: "notifications/deploy" },
		sourceKind: "mcp",
		sourceLabel: "mcp:hub",
		eventLabel: "deploy finished",
		payloadSummary: "deploy 41 finished",
		idempotencyKey: "mcp:hub:custom:deploy-41",
		cwd: dir,
		...over,
	};
}

test("every audit row of one delivery carries the same cwd, even when the session moves mid-check", async () => {
	// A check takes minutes; `/resume` or a project switch inside that window used to split one trace
	// across two projects in the audit, so `/triggers audit` showed the promotion under a cwd the
	// check never ran in.
	const dir = fs.realpathSync(tmp("pi-loops-trt-cwd-"));
	let sessionCwd = dir;
	const rt = new TriggerRuntime({
		store: new TriggerStore(dir),
		jobStore: new JobStore(dir),
		getSession: () => ({ sessionId: "s", cwd: sessionCwd }),
		runner: async () => {
			sessionCwd = path.join(dir, "elsewhere");
			return { ok: true, exitCode: 0, timedOut: false, text: `matched ${rule.id}`, usage: { input: 1, output: 1, cost: 0, turns: 1 } };
		},
		hooks: { onPromote: () => "chat" },
	});
	const rule = await rt.store.add({ condition: "c", action: "a", cwd: dir, promoteToChat: true });
	try {
		// No cwd on the envelope, so every row has to fall back to the session — once, not per row.
		const trigger: Trigger = {
			source: { kind: "local", subkind: "dynamic" },
			sourceKind: "local",
			sourceLabel: "local:dynamic",
			eventLabel: "dynamic periodic check",
			payloadSummary: "check",
			idempotencyKey: "local:dynamic:no-cwd",
			replacementPolicy: "drop",
			traceId: "trace-one",
			receivedAt: new Date().toISOString(),
		};
		await rt.handle(trigger, "sub_agent");
		const rows = rt.store.listAudit(20, (r) => r.traceId === "trace-one");
		assert.ok(rows.length >= 4, `expected the whole trace, got ${rows.map((r) => `${r.type}:${r.state}`).join(", ")}`);
		assert.deepEqual([...new Set(rows.map((r) => r.cwd))], [dir]);
	} finally {
		await rt.stop();
	}
});

test("[check-lane-symlink] a project reached through a symlink has one check lane, named for the real directory", () => {
	const root = fs.realpathSync(tmp("pi-loops-lane-link-"));
	const real = path.join(root, "proj");
	const link = path.join(root, "link");
	fs.mkdirSync(real);
	fs.symlinkSync(real, link);
	assert.equal(checkLane(link), checkLane(real));
	assert.match(checkLane(link)!, /^@check-proj-[0-9a-f]{8}$/);
});

test("a project's check lane is @check-, its directory's name and a digest of its path; two projects named alike have two lanes, and no project has none", () => {
	const a = fs.realpathSync(tmp("pi-loops-lane-"));
	const one = path.join(a, "one", "web");
	const two = path.join(a, "two", "web");
	fs.mkdirSync(one, { recursive: true });
	fs.mkdirSync(two, { recursive: true });
	assert.match(checkLane(one)!, /^@check-web-[0-9a-f]{8}$/);
	assert.notEqual(checkLane(one), checkLane(two));
	assert.equal(checkLane(one), checkLane(one), "stable for a project");
	assert.equal(checkLane(one), `@check-${triggerSessionKey(one).slice("triggers-".length)}`, "the key of the project's check transcripts, without its prefix");
	assert.equal(checkLane(""), undefined, "a rule with no project has no check lane");
	// Whatever the directory is called, the lane is one the grammar takes.
	for (const name of ["a b", "..", "a..b", "é", ".hidden", "x".repeat(250), "@cron-x"]) {
		const lane = checkLane(path.join(a, name));
		assert.equal(parseLane(lane!)?.kind, "check", `${name} -> ${lane}`);
	}
});

test("a proposed rule is never checked by a push", async () => {
	const dir = tmp("pi-loops-trt-");
	const runner = fakeRunner();
	const rt = new TriggerRuntime({ store: new TriggerStore(dir), jobStore: new JobStore(dir), getSession: () => ({ sessionId: "s", cwd: dir }), runner, pollIntervalSecs: 1, hooks: { onPromote: () => "chat", onInjectAndRun: () => "chat" } });
	await rt.store.add({ condition: "c", action: "a", cwd: dir, sessionId: "s", proposed: { at: new Date().toISOString(), session: "s" } });
	try {
		await rt.handle(pushTrigger(dir), "sub_agent");
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(runner.calls.length, 0, "no sub-agent was asked");
		assert.equal(rt.store.load()[0].enabled, false);
	} finally {
		await rt.stop();
	}
});

