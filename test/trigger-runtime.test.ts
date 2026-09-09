import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JobStore } from "../src/store.ts";
import { TriggerRuntime } from "../src/trigger-runtime.ts";
import { TriggerStore, buildPeriodicCheckTrigger, extractDynamicRuleIds } from "../src/triggers.ts";
import type { RunnerResult, SubagentRequest } from "../src/runner.ts";
import { fakeRunner } from "./fake-runner.ts";

/** A runner that matches whatever rules the prompt actually contains, so parallel checks differ. */
function matchingRunner(extra: Partial<RunnerResult> = {}) {
	const calls: SubagentRequest[] = [];
	const run = async (req: SubagentRequest): Promise<RunnerResult> => {
		calls.push(req);
		const ids = extractDynamicRuleIds(req.prompt);
		return { ok: true, exitCode: 0, timedOut: false, text: `matched ${ids.join(" ")}`, usage: { input: 1, output: 1, cost: 0, turns: 1 }, ...extra };
	};
	return Object.assign(run, { calls });
}


function setup() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-trt-"));
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
		// pie's DEFAULT_PROMOTE_SUMMARY_TEMPLATE (agent_harness.rs:2945): the chat says what fired.
		assert.match(promoted[0], /^\[Trigger [0-9a-f-]{36}\] local:dynamic fired dynamic periodic check\.\nResult: matched dyn-/);
		const audit = rt.store.listAudit(10);
		assert.deepEqual(audit.map((r) => `${r.type}:${r.state}`), ["trigger_promotion:promoted", "trigger_result:completed", "trigger_result:running", "trigger:accepted"]);
		// pie's TriggerRecord persists the envelope on every state (harness/trigger.rs:229-260), so
		// "which pushes collapsed into which" stays answerable from the audit alone.
		const keys = [...new Set(audit.map((r) => (r.details as any).idempotency_key))];
		assert.equal(keys.length, 1, `every row of one trigger carries the same idempotency key, got ${JSON.stringify(keys)}`);
		assert.equal(typeof keys[0], "string");
		assert.ok((keys[0] as string).startsWith(`local:dynamic:${dir}`), keys[0] as string);
		assert.ok(audit.every((r) => (r.details as any).replacement_policy === "drop" && (r.details as any).received_at));
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
		assert.equal(promoted[0], "[Trigger m1] tool list changed", "pie: inject_summary injects the bare payload summary");
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
		const mcp = { ...buildPeriodicCheckTrigger(dir, 1), traceId: "m9", idempotencyKey: "mcp:y:tools", sourceLabel: "mcp:y", eventLabel: "e", payloadSummary: "s", cwd: "/elsewhere" };
		const o2 = await rt.handle(mcp, "inject_and_run");
		assert.equal(o2?.promoted, false);
		assert.equal((rt.store.listAudit(1)[0].details as any).to, "inbox");
	} finally {
		delete process.env.FAKE_PI_REPLY;
		await rt.stop();
	}
});

test("sub-agent processes never act on triggers: hop ≥ 1 is cycle_suppressed, no pi is spawned", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-trt-"));
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

test("persistence failures never reject handle()/tick(): audit is best-effort, delivery still happens, errors are logged", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-trt-"));
	fs.mkdirSync(path.join(dir, "triggers-audit.jsonl")); // appendFileSync → EISDIR
	const logs: string[] = [];
	const promoted: string[] = [];
	const store = new TriggerStore(dir);
	const rt = new TriggerRuntime({ store, jobStore: new JobStore(dir), getSession: () => ({ sessionId: "s", cwd: dir }), runner: fakeRunner(), pollIntervalSecs: 1, hooks: { onPromote: (c) => { promoted.push(c); return "chat"; }, log: (m) => void logs.push(m) } });
	const t = { ...buildPeriodicCheckTrigger(dir, 1), traceId: "m1", idempotencyKey: "mcp:x:tools", sourceLabel: "mcp:x", eventLabel: "e", payloadSummary: "s", cwd: undefined };
	const out = await rt.handle(t, "inject_summary");
	assert.equal(out?.ok, true, "delivery happens even when the audit file cannot be written");
	assert.equal(promoted.length, 1);
	assert.match(store.lastPersistenceError ?? "", /EISDIR/);
	assert.ok(logs.some((m) => /audit/.test(m)), "the failure is reported through the log hook");
	assert.deepEqual(store.listAudit(5), [], "listAudit tolerates the broken file");

	// A dedup window that cannot be persisted: handle() resolves (undefined) instead of rejecting.
	const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-trt-"));
	fs.mkdirSync(path.join(dir2, "dedup.json")); // rename over a directory fails
	const logs2: string[] = [];
	const finished: any[] = [];
	const rt2 = new TriggerRuntime({ store: new TriggerStore(dir2), jobStore: new JobStore(dir2), getSession: () => ({ sessionId: "s", cwd: dir2 }), runner: fakeRunner(), pollIntervalSecs: 1, dedupFile: path.join(dir2, "dedup.json"), hooks: { onFinished: (o) => void finished.push(o), log: (m) => void logs2.push(m) } });
	await rt2.store.add({ condition: "c", action: "a", cwd: dir2 });
	assert.equal(await rt2.handle(buildPeriodicCheckTrigger(dir2, 1), "sub_agent"), undefined);
	assert.ok(logs2.some((m) => /dedup|trigger .* failed/i.test(m)), `expected a logged failure, got ${JSON.stringify(logs2)}`);
	await rt2.tick(Date.now(), true); // fire-and-forget path must not raise an unhandled rejection
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(finished.length, 0);
	await rt.stop();
	await rt2.stop();
});

function presenceOf(entries: Array<{ instance: string; cwd: string; sessionId?: string }>) {
	const at = new Date().toISOString();
	return entries.map((e) => ({ pid: process.pid, host: os.hostname(), heartbeatAt: at, ...e }));
}

test("per-project ownership: the pi open in a project runs its checks; the machine leader only covers projects with no pi", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-trt-"));
	const dirA = path.join(dir, "A"), dirB = path.join(dir, "B"), dirC = path.join(dir, "C");
	for (const d of [dirA, dirB, dirC]) fs.mkdirSync(d);
	const presence = () => presenceOf([{ instance: "a", cwd: dirA, sessionId: "sa" }, { instance: "b", cwd: dirB, sessionId: "sb" }]);
	const finished: any[] = [];
	const mk = (instance: string, cwd: string, sessionId: string) =>
		new TriggerRuntime({ store: new TriggerStore(dir), jobStore: new JobStore(dir), getSession: () => ({ sessionId, cwd }), runner: fakeRunner(), pollIntervalSecs: 1, dedupFile: path.join(dir, "dedup.json"), self: { pid: process.pid, host: os.hostname(), instance, sessionId, cwd }, presence, hooks: { onFinished: (o) => void finished.push([instance, o.trigger.cwd]) } });
	const A = mk("a", dirA, "sa"); // machine leader, in project A
	const B = mk("b", dirB, "sb"); // standby, in project B
	process.env.FAKE_PI_REPLY = "no dynamic trigger rule matched";
	try {
		await A.store.add({ condition: "b", action: "x", cwd: dirB, sessionId: "sb" });
		await A.store.add({ condition: "c", action: "x", cwd: dirC });
		const t0 = Date.now();
		await A.tick(t0, true);
		await B.tick(t0, false);
		const end = Date.now() + 5000;
		while (finished.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
		assert.deepEqual(finished.sort(), [["a", dirC], ["b", dirB]], "A (leader) covers C where nobody is open; B, though standby, runs its own project's check");
		// the shared poll ledger: a second tick inside the interval, by either process, checks nothing
		const soon = t0 + 100; // inside the 1 s interval whatever the fake-pi runs took
		await A.tick(soon, true);
		await B.tick(soon, false);
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(finished.length, 2);
	} finally {
		delete process.env.FAKE_PI_REPLY;
		await A.stop();
		await B.stop();
	}
});

test("push routing: injected pushes reach every window (pie), rule evaluation happens once per project by its owner", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-trt-"));
	const presence = () => presenceOf([{ instance: "w1", cwd: dir, sessionId: "s1" }, { instance: "w2", cwd: dir, sessionId: "s2" }]);
	const promoted: string[] = [];
	const finished: any[] = [];
	const mk = (instance: string, sessionId: string) =>
		new TriggerRuntime({ store: new TriggerStore(dir), jobStore: new JobStore(dir), getSession: () => ({ sessionId, cwd: dir }), runner: fakeRunner(), dedupFile: path.join(dir, "dedup.json"), deferredTakeoverMs: 50, self: { pid: process.pid, host: os.hostname(), instance, sessionId, cwd: dir }, presence, hooks: { onPromote: (c) => { promoted.push(`${instance}:${c}`); return "chat"; }, onFinished: (o) => void (o.delivery === "sub_agent" && finished.push(instance)) } });
	const w1 = mk("w1", "s1"), w2 = mk("w2", "s2"); // two windows in the same project; w1 is the owner (lower instance)
	process.env.FAKE_PI_REPLY = "no dynamic trigger rule matched";
	try {
		await w1.store.add({ condition: "c", action: "a", cwd: dir });
		const push = { ...buildPeriodicCheckTrigger(dir, 1), source: { kind: "mcp" as const, serverName: "hub", method: "notifications/x" }, sourceKind: "mcp" as const, sourceLabel: "mcp:hub", eventLabel: "notifications/x", payloadSummary: "deploy finished", idempotencyKey: "mcp:hub:custom:k1", cwd: dir };
		await w1.handle({ ...push, traceId: "t1" }, "inject_summary");
		await w2.handle({ ...push, traceId: "t2" }, "inject_summary");
		assert.deepEqual(promoted, ["w1:[Trigger t1] deploy finished", "w2:[Trigger t2] deploy finished"], "both windows inject (per-process dedup only)");
		assert.equal(await w1.handle({ ...push, traceId: "t1b" }, "inject_summary"), undefined, "the same push twice in one process is deduplicated");
		const evalPush = { ...push, idempotencyKey: "mcp:hub:custom:k2" };
		const out = await w1.handle({ ...evalPush, traceId: "e1" }, "sub_agent");
		assert.equal(out?.ok, true, "the owner evaluates the project's rules once");
		assert.equal(await w2.handle({ ...evalPush, traceId: "e2" }, "sub_agent"), undefined, "the non-owner window defers, and the owner's claim keeps it deduped");
		assert.deepEqual(w2.store.listAudit(2).map((r) => r.state), ["deduped", "deferred"]);
		assert.deepEqual(finished, ["w1"]);
	} finally {
		delete process.env.FAKE_PI_REPLY;
		await w1.stop();
		await w2.stop();
	}
});

test("trigger checks honour a per-rule timeout (and the configurable default) instead of a fixed 15 minutes", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-trt-"));
	const finished: any[] = [];
	const rt = new TriggerRuntime({ store: new TriggerStore(dir), jobStore: new JobStore(dir), getSession: () => ({ sessionId: "s", cwd: dir }), runner: fakeRunner(), runTimeoutMs: 60_000, hooks: { onFinished: (o) => void finished.push(o) } });
	const r = await rt.store.add({ condition: "c", action: "a", cwd: dir });
	await rt.store.update(r.id, (rule) => void (rule.timeoutMs = 300));
	process.env.FAKE_PI_SLEEP = "2";
	try {
		const out = await rt.handle(buildPeriodicCheckTrigger(dir, 1), "sub_agent");
		assert.equal(out?.ok, false);
		assert.match(out?.error ?? "", /timed out after 0s|timed out/);
	} finally {
		delete process.env.FAKE_PI_SLEEP;
		await rt.stop();
	}
});

test("rules of another host are ignored; audit rows carry the project cwd and reach the session sink", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-trt-"));
	const store = new TriggerStore(dir);
	const sink: any[] = [];
	store.onAudit = (r) => void sink.push(r);
	const finished: any[] = [];
	const rt = new TriggerRuntime({ store, jobStore: new JobStore(dir), getSession: () => ({ sessionId: "s", cwd: dir }), runner: fakeRunner(), pollIntervalSecs: 1, hooks: { onFinished: (o) => void finished.push(o) } });
	process.env.FAKE_PI_REPLY = "no dynamic trigger rule matched";
	try {
		await store.add({ condition: "c", action: "a", cwd: "/elsewhere", host: "another-host" });
		await rt.tick(Date.now(), true);
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(finished.length, 0, "the other host runs its own rules");
		await store.add({ condition: "c", action: "a", cwd: dir });
		await rt.tick(Date.now() + 5000, true);
		const end = Date.now() + 5000;
		while (finished.length < 1 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
		assert.equal(finished.length, 1);
		assert.ok(sink.length >= 3, "every audit row is also handed to the session sink");
		assert.ok(sink.every((r) => r.cwd === dir), "rows carry the project they belong to");
		assert.deepEqual(store.listAudit(10, (r) => r.cwd === dir).length, sink.length);
	} finally {
		delete process.env.FAKE_PI_REPLY;
		await rt.stop();
	}
});

test("a rule belongs to the session that created it: two windows in one repo each check their own rules and promote into their own chat", async () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-trt-")));
	// w1 sorts first (same pid, lower instance), so under directory ownership it evaluated w2's rule too.
	const presence = () => presenceOf([{ instance: "w1", cwd: dir, sessionId: "s1" }, { instance: "w2", cwd: dir, sessionId: "s2" }]);
	const promoted: string[] = [];
	const finished: any[] = [];
	const runner = matchingRunner();
	const mk = (instance: string, sessionId: string) =>
		new TriggerRuntime({ store: new TriggerStore(dir), jobStore: new JobStore(dir), getSession: () => ({ sessionId, cwd: dir }), runner, pollIntervalSecs: 1, dedupFile: path.join(dir, "dedup.json"), self: { pid: process.pid, host: os.hostname(), instance, sessionId, cwd: dir }, presence, hooks: { onPromote: (c) => { promoted.push(`${instance}:${c}`); return "chat"; }, onFinished: (o) => void finished.push([instance, o.matchedRules.map((r: any) => r.id)]) } });
	const w1 = mk("w1", "s1"), w2 = mk("w2", "s2");
	try {
		const a = await w1.store.add({ condition: "a", action: "x", cwd: dir, sessionId: "s1", promoteToChat: true, fireOnce: false });
		const b = await w1.store.add({ condition: "b", action: "y", cwd: dir, sessionId: "s2", promoteToChat: true, fireOnce: false });
		const t0 = Date.now();
		await w1.tick(t0, true); // w1 is also the machine leader
		await w2.tick(t0, false);
		const end = Date.now() + 5000;
		while (finished.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
		assert.deepEqual(finished.sort(), [["w1", [a.id]], ["w2", [b.id]]], "each window checks only the rules its own session created");
		assert.equal(promoted.length, 2);
		assert.ok(promoted.find((p) => p.startsWith("w1:") && p.includes(a.id)), "w1 gets its own result");
		assert.ok(promoted.find((p) => p.startsWith("w2:") && p.includes(b.id)), "and w2's answer appears in w2, not in the lower-pid window");
		assert.equal(promoted.filter((p) => p.startsWith("w1:") && p.includes(b.id)).length, 0);
		// The poll ledger is per ownership slot, so neither window re-checks inside the interval.
		const before = runner.calls.length;
		await w1.tick(t0 + 100, true);
		await w2.tick(t0 + 100, false);
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(runner.calls.length, before, "no double check machine-wide");
	} finally {
		await w1.stop();
		await w2.stop();
	}
});

test("a pi opened in a subdirectory (or through a symlink) still owns the project's rules instead of diverting them to the inbox", async () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-trt-")));
	const proj = path.join(dir, "proj");
	fs.mkdirSync(path.join(proj, "src"), { recursive: true });
	fs.symlinkSync(proj, path.join(dir, "link"));
	const here = path.join(dir, "link", "src"); // where the user opened pi today
	const finished: any[] = [];
	const runner = matchingRunner();
	const rt = new TriggerRuntime({
		store: new TriggerStore(dir), jobStore: new JobStore(dir), getSession: () => ({ sessionId: "s1", cwd: here }), runner, pollIntervalSecs: 1,
		dedupFile: path.join(dir, "dedup.json"), self: { pid: process.pid, host: os.hostname(), instance: "w1", sessionId: "s1", cwd: here },
		presence: () => presenceOf([{ instance: "w1", cwd: here, sessionId: "s1" }]),
		isLeader: () => false, hooks: { onFinished: (o) => void finished.push(o) },
	});
	try {
		const r = await rt.store.add({ condition: "c", action: "a", cwd: proj, fireOnce: false }); // created yesterday, at the project root
		await rt.tick(Date.now(), false); // standby: only project ownership can make this run
		const end = Date.now() + 5000;
		while (!finished.length && Date.now() < end) await new Promise((r2) => setTimeout(r2, 25));
		assert.equal(finished.length, 1, "the pi below the rule's cwd is the project's owner");
		assert.deepEqual(finished[0].matchedRules.map((x: any) => x.id), [r.id]);
		assert.equal(runner.calls[0].cwd, proj, "the check still runs in the project the rule was created in");
		// A push arriving in the subdirectory finds the project's rules too.
		const push = { ...buildPeriodicCheckTrigger(here, 1), source: { kind: "mcp" as const, serverName: "hub", method: "notifications/x" }, sourceKind: "mcp" as const, sourceLabel: "mcp:hub", eventLabel: "e", idempotencyKey: "mcp:hub:custom:k1", traceId: "p1", cwd: here };
		const out = await rt.handle(push, "sub_agent");
		assert.equal(out?.ok, true);
		assert.deepEqual(out?.matchedRules.map((x) => x.id), [r.id], "not audited as no_rules because the strings differ");
	} finally {
		await rt.stop();
	}
});

test("a push deferred to a window that never claims it is taken back instead of being lost", async () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-trt-")));
	// w1 owns the rules but (as when its MCP server failed to authenticate) never sees the push.
	const presence = () => presenceOf([{ instance: "w1", cwd: dir, sessionId: "s1" }, { instance: "w2", cwd: dir, sessionId: "s2" }]);
	const finished: any[] = [];
	const runner = matchingRunner();
	const w2 = new TriggerRuntime({
		store: new TriggerStore(dir), jobStore: new JobStore(dir), getSession: () => ({ sessionId: "s2", cwd: dir }), runner,
		dedupFile: path.join(dir, "dedup.json"), deferredTakeoverMs: 50,
		self: { pid: process.pid, host: os.hostname(), instance: "w2", sessionId: "s2", cwd: dir }, presence,
		isLeader: () => false, hooks: { onFinished: (o) => void finished.push(o) },
	});
	try {
		const r = await w2.store.add({ condition: "c", action: "a", cwd: dir, sessionId: "s1", fireOnce: false }); // created in w1
		const push = { ...buildPeriodicCheckTrigger(dir, 1), source: { kind: "mcp" as const, serverName: "hub", method: "notifications/x" }, sourceKind: "mcp" as const, sourceLabel: "mcp:hub", eventLabel: "e", payloadSummary: "deploy finished", idempotencyKey: "mcp:hub:custom:k1", traceId: "p1", cwd: dir };
		const out = await w2.handle(push, "sub_agent");
		assert.equal(out?.ok, true, "the receiving process runs it after the owner does not");
		assert.deepEqual(out?.matchedRules.map((x) => x.id), [r.id]);
		const states = w2.store.listAudit(20).map((a) => `${a.type}:${a.state}`).reverse();
		assert.deepEqual(states.slice(0, 3), ["trigger:deferred", "trigger:taken_over", "trigger:accepted"]);
		assert.equal((w2.store.listAudit(20).find((a) => a.state === "deferred")!.details as any).takeover_after_ms, 50);
		// The claim is machine-wide, so the same push cannot then run twice.
		assert.equal(await w2.handle({ ...push, traceId: "p2" }, "sub_agent"), undefined);
		assert.equal(finished.length, 1);
	} finally {
		await w2.stop();
	}
});

test("a check killed by the run timeout still disarms the fire-once rules whose action it already ran", async () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-trt-")));
	const finished: any[] = [];
	const rt = new TriggerRuntime({
		store: new TriggerStore(dir), jobStore: new JobStore(dir), getSession: () => ({ sessionId: "s", cwd: dir }), pollIntervalSecs: 1,
		// The action (posting the comment, kicking the deploy) ran; the deadline hit before the reply finished.
		runner: matchingRunner({ ok: false, exitCode: 1, timedOut: true, errorMessage: "timed out after 900s" }),
		hooks: { onFinished: (o) => void finished.push(o) },
	});
	try {
		const r = await rt.store.add({ condition: "c", action: "post the comment", cwd: dir });
		const out = await rt.handle(buildPeriodicCheckTrigger(dir, 1), "sub_agent");
		assert.equal(out?.ok, false);
		assert.equal(rt.store.load().find((x) => x.id === r.id)?.enabled, false, "the fire-once rule does not run its action again on the next poll");
		const row = rt.store.listAudit(5).find((a) => a.type === "trigger_result" && a.state !== "running")!;
		assert.equal(row.state, "failed", "and the non-ok state is what the audit records");
		assert.deepEqual((row.details as any).matched_rule_ids, [r.id]);
	} finally {
		await rt.stop();
	}
});
