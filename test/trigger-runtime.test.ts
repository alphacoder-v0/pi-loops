import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JobStore } from "../src/store.ts";
import { TriggerRuntime } from "../src/trigger-runtime.ts";
import { TriggerStore, buildPeriodicCheckTrigger } from "../src/triggers.ts";

const FAKE_PI = path.join(import.meta.dirname, "fake-pi.sh");

function setup() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-trt-"));
	const promoted: string[] = [];
	const injected: string[] = [];
	const finished: any[] = [];
	const rt = new TriggerRuntime({
		store: new TriggerStore(dir),
		jobStore: new JobStore(dir),
		getSession: () => ({ sessionId: "s", cwd: dir }),
		piBin: FAKE_PI,
		pollIntervalSecs: 1,
		hooks: { onPromote: (c) => { promoted.push(c); return "chat"; }, onInjectAndRun: (p) => { injected.push(p); return "chat"; }, onFinished: (o) => void finished.push(o) },
	});
	return { dir, rt, promoted, injected, finished };
}

test("periodic check: matched fire-once rule is disabled, promote_to_chat rule promotes, audit written", async () => {
	const { dir, rt, promoted, finished } = setup();
	const a = await rt.store.add({ condition: "a", action: "x", cwd: dir });
	const b = await rt.store.add({ condition: "b", action: "y", cwd: dir, promoteToChat: true, fireOnce: false });
	process.env.FAKE_PI_REPLY = `matched ${a.id} and ${b.id}: printed the file`;
	try {
		await rt.tick(Date.now(), false);
		assert.equal(finished.length, 0, "standby does not check");
		await rt.tick(Date.now(), true);
		const end = Date.now() + 5000;
		while (finished.length < 1 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
		assert.equal(finished.length, 1);
		assert.equal(finished[0].ok, true);
		assert.deepEqual(finished[0].matchedRules.map((r: any) => r.id).sort(), [a.id, b.id].sort());
		const rules = rt.store.load();
		assert.equal(rules.find((r) => r.id === a.id)?.enabled, false, "fire-once rule disabled");
		assert.equal(rules.find((r) => r.id === b.id)?.enabled, true, "repeat rule stays");
		assert.equal(promoted.length, 1);
		assert.match(promoted[0], /^\[Trigger [0-9a-f-]{36}\] local:dynamic fired dynamic periodic check\.\nResult: /);
		const audit = rt.store.listAudit(10);
		assert.deepEqual(audit.map((r) => `${r.type}:${r.state}`), ["trigger_promotion:promoted", "trigger_result:completed", "trigger_result:running", "trigger:accepted"]);
		assert.ok(finished[0].sessionFile && fs.existsSync(finished[0].sessionFile), "check transcript kept");
		assert.equal(rt.lastPoll?.outcome, "matched 2");
		// Interval not elapsed → no second check
		await rt.tick(Date.now(), true);
		assert.equal(finished.length, 1);
	} finally {
		delete process.env.FAKE_PI_REPLY;
		await rt.stop();
	}
});

test("quiet check, dedup, inject_summary and inject_and_run deliveries", async () => {
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
		const mcp = { ...t, traceId: "m1", idempotencyKey: "mcp:x:tools", sourceLabel: "mcp:x", eventLabel: "notifications/tools/listChanged", payloadSummary: "tool list changed", cwd: undefined };
		await rt.handle(mcp, "inject_summary");
		assert.equal(promoted.length, 1);
		assert.equal(promoted[0], "[Trigger m1] mcp:x fired notifications/tools/listChanged.\nResult: tool list changed");
		await rt.handle({ ...mcp, traceId: "m2", idempotencyKey: "mcp:x:custom:k" }, "inject_and_run");
		assert.equal(injected.length, 1);
		assert.equal(injected[0], "[Trigger m2] tool list changed");
		assert.equal(finished.length, 3);
	} finally {
		delete process.env.FAKE_PI_REPLY;
		await rt.stop();
	}
});


test("promotion routed to the inbox is audited as redirected; checks carry the rule's model and a hop", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-trt-"));
	const finished: any[] = [];
	const rt = new TriggerRuntime({
		store: new TriggerStore(dir),
		jobStore: new JobStore(dir),
		getSession: () => ({ sessionId: "s", cwd: dir, model: "leader/model" }),
		piBin: FAKE_PI,
		hop: 1,
		hooks: { onPromote: () => "inbox", onInjectAndRun: () => "inbox", onFinished: (o) => void finished.push(o) },
	});
	const argsFile = path.join(dir, "args.txt");
	const envFile = path.join(dir, "env.txt");
	process.env.FAKE_PI_ARGS_FILE = argsFile;
	process.env.FAKE_PI_ENV_FILE = envFile;
	try {
		const r = await rt.store.add({ condition: "c", action: "a", cwd: dir, promoteToChat: true, model: "creator/model", thinking: "high" });
		process.env.FAKE_PI_REPLY = `matched ${r.id}`;
		const out = await rt.handle(buildPeriodicCheckTrigger(dir, 1), "sub_agent");
		assert.equal(out?.promoted, false);
		assert.equal(rt.store.listAudit(1)[0].state, "redirected");
		const args = fs.readFileSync(argsFile, "utf8").split("\n");
		assert.ok(args.includes("creator/model") && args.includes("high"), "check ran with the rule creator's model, not the timer owner's");
		assert.match(fs.readFileSync(envFile, "utf8"), /PI_LOOPS_HOP=2/);
		const mcp = { ...buildPeriodicCheckTrigger(dir, 1), traceId: "m9", idempotencyKey: "mcp:y:tools", sourceLabel: "mcp:y", eventLabel: "e", payloadSummary: "s", cwd: "/elsewhere" };
		const o2 = await rt.handle(mcp, "inject_and_run");
		assert.equal(o2?.promoted, false);
		assert.equal((rt.store.listAudit(1)[0].details as any).to, "inbox");
	} finally {
		delete process.env.FAKE_PI_REPLY;
		delete process.env.FAKE_PI_ARGS_FILE;
		delete process.env.FAKE_PI_ENV_FILE;
		await rt.stop();
	}
});
