import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JobStore } from "../src/store.ts";
import { TriggerRuntime } from "../src/trigger-runtime.ts";
import { deliverInjectSummary } from "../src/push.ts";
import { triggerSessionKey } from "../src/check-run.ts";
import { checkLane, parseLane } from "../src/lane.ts";
import { type Trigger, TriggerStore, buildPeriodicCheckTrigger, extractDynamicRuleIds } from "../src/triggers.ts";
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
		// The promoted body names the cause, not only the result: the chat says what fired.
		assert.match(promoted[0], /^\[Trigger [0-9a-f-]{36}\] local:dynamic fired dynamic periodic check\.\nResult: matched dyn-/);
		const audit = rt.store.listAudit(10);
		assert.deepEqual(audit.map((r) => `${r.type}:${r.state}`), ["trigger_promotion:promoted", "trigger_result:completed", "trigger_result:running", "trigger:accepted"]);
		// The envelope is persisted on every state a trigger passes through, so
		// "which pushes collapsed into which" stays answerable from the audit alone.
		const keys = [...new Set(audit.map((r) => (r.details as any).idempotency_key))];
		assert.equal(keys.length, 1, `every row of one trigger carries the same idempotency key, got ${JSON.stringify(keys)}`);
		assert.equal(typeof keys[0], "string");
		assert.ok((keys[0] as string).startsWith(`local:dynamic:${dir}`), keys[0] as string);
		assert.ok(audit.every((r) => (r.details as any).replacement_policy === "drop" && (r.details as any).received_at));
		assert.ok(finished[0].sessionFile && fs.existsSync(finished[0].sessionFile), "check transcript kept");
		assert.equal(rt.lastPoll?.outcome, "matched 2");
		// The host checks every project's rules; a window shows its own project's latest, not whichever ran last.
		assert.deepEqual([...rt.lastPolls.keys()], [dir]);
		assert.equal(rt.lastPolls.get(dir)?.outcome, "matched 2");
		// Interval not elapsed → no second check
		await rt.tick(Date.now(), true);
		assert.equal(finished.length, 1);
	} finally {
		delete process.env.FAKE_PI_REPLY;
		await rt.stop();
	}
});

test("a rule can be checked now, without waiting for its poll slot", async () => {
	const { dir, rt, finished } = setup();
	const rule = await rt.store.add({ condition: "a", action: "x", cwd: dir, fireOnce: false });
	process.env.FAKE_PI_REPLY = `matched ${rule.id}: now`;
	try {
		// A tick claims the poll slot, so the interval is spent for the next several seconds.
		await rt.tick(Date.now(), true);
		const first = Date.now() + 5000;
		while (finished.length < 1 && Date.now() < first) await new Promise((r) => setTimeout(r, 25));
		assert.equal(finished.length, 1);
		await rt.tick(Date.now(), true);
		assert.equal(finished.length, 1, "the slot is claimed: a second tick checks nothing");

		// Run-now goes through `handle` directly, which is what the command does.
		await rt.handle(buildPeriodicCheckTrigger(dir, 1, new Date(), "run-now"), "sub_agent", [rule]);
		assert.equal(finished.length, 2, "checked now regardless of the poll interval");
		assert.equal(finished[1].ok, true);
		assert.deepEqual(finished[1].matchedRules.map((r: any) => r.id), [rule.id]);
		// It is a real check, so it is audited like one rather than being invisible.
		assert.ok(rt.store.listAudit(20).some((r) => r.type === "trigger_result" && r.state === "completed"));
	} finally {
		delete process.env.FAKE_PI_REPLY;
		await rt.stop();
	}
});

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

test("persistence failures never reject handle()/tick(): audit is best-effort, delivery still happens, errors are logged", async () => {
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
	await rt2.tick(Date.now(), true); // fire-and-forget path must not raise an unhandled rejection
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(finished.length, 0);
	await rt.stop();
	await rt2.stop();
});

test("the host checks every rule; the promotion reaches the creating session's holder, and two windows in one repo each receive only their own rules' promotions", async () => {
	const dir = fs.realpathSync(tmp("pi-loops-trt-"));
	const other = path.join(dir, "other");
	fs.mkdirSync(other);
	const promoted: Array<[string | undefined, string]> = [];
	const finished: string[] = [];
	const runner = matchingRunner();
	const host = new TriggerRuntime({ store: new TriggerStore(dir), jobStore: new JobStore(dir), getSession: () => ({ cwd: "" }), runner, pollIntervalSecs: 1, dedupFile: path.join(dir, "dedup.json"), hooks: { onPromote: (c, _t, forSession) => { promoted.push([forSession, c]); return "queued"; }, onFinished: (o) => void finished.push(o.trigger.cwd ?? "") } });
	try {
		const a = await host.store.add({ condition: "a", action: "x", cwd: dir, sessionId: "s1", promoteToChat: true, fireOnce: false });
		const b = await host.store.add({ condition: "b", action: "y", cwd: dir, sessionId: "s2", promoteToChat: true, fireOnce: false });
		await host.store.add({ condition: "c", action: "z", cwd: other, promoteToChat: true, fireOnce: false }); // made from a shell: no creating session
		const t0 = Date.now();
		await host.tick(t0);
		const end = Date.now() + 5000;
		while (finished.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
		assert.deepEqual(finished.sort(), [dir, other].sort(), "one check per project, every rule, whoever has a window open");
		assert.deepEqual(promoted.map(([sid]) => sid ?? "-").sort(), ["-", "s1", "s2"], "one promotion per creating conversation");
		assert.ok(promoted.find(([sid, c]) => sid === "s1" && c.includes(a.id)) && promoted.find(([sid, c]) => sid === "s2" && c.includes(b.id)));
		const audit = host.store.listAudit(20).filter((r) => r.type === "trigger_promotion");
		assert.ok(audit.some((r) => (r.details as any).rule_ids?.join() === a.id) && audit.some((r) => (r.details as any).rule_ids?.join() === b.id), "each audited with its own rules");
		// The poll ledger: a second tick inside the interval checks nothing.
		const before = runner.calls.length;
		await host.tick(t0 + 100);
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(runner.calls.length, before);
	} finally {
		await host.stop();
	}
});

test("a project a pi-loops 0.22 window has just checked is skipped, and so are the rules of a session it checked itself", async () => {
	const dir = fs.realpathSync(tmp("pi-loops-trt-"));
	const runner = matchingRunner();
	const finished: any[] = [];
	const host = new TriggerRuntime({ store: new TriggerStore(dir), jobStore: new JobStore(dir), getSession: () => ({ cwd: "" }), runner, pollIntervalSecs: 60, dedupFile: path.join(dir, "dedup.json"), hooks: { onFinished: (o) => void finished.push(o) } });
	try {
		await host.store.add({ condition: "a", action: "x", cwd: dir, sessionId: "old-window", fireOnce: false });
		const mine = await host.store.add({ condition: "b", action: "y", cwd: dir, fireOnce: false });
		const t0 = Date.now();
		// The keys a 0.22 window claims (src/trigger-runtime.ts in 0.22.x): the session's own slot.
		const ledger = JSON.parse(fs.existsSync(path.join(dir, "polls.json")) ? fs.readFileSync(path.join(dir, "polls.json"), "utf8") : "{}");
		ledger[`${os.hostname()}:${dir}#old-window`] = t0;
		fs.writeFileSync(path.join(dir, "polls.json"), JSON.stringify(ledger));
		await host.tick(t0);
		const end = Date.now() + 5000;
		while (!finished.length && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
		assert.deepEqual(finished[0]?.matchedRules.map((r: any) => r.id), [mine.id], "the old window's session rules are left to it");
	} finally {
		await host.stop();
	}
});

test("audit rows carry the project cwd and reach the session sink", async () => {
	const dir = tmp("pi-loops-trt-");
	const store = new TriggerStore(dir);
	const sink: any[] = [];
	store.onAudit = (r) => void sink.push(r);
	const finished: any[] = [];
	const rt = new TriggerRuntime({ store, jobStore: new JobStore(dir), getSession: () => ({ sessionId: "s", cwd: dir }), runner: fakeRunner(), pollIntervalSecs: 1, hooks: { onFinished: (o) => void finished.push(o) } });
	process.env.FAKE_PI_REPLY = "no dynamic trigger rule matched";
	try {
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

test("rules whose project is gone are disabled instead of polling and billing forever", async () => {
	const dir = tmp("pi-loops-gone-");
	const alive = path.join(dir, "alive");
	const doomed = path.join(dir, "doomed");
	fs.mkdirSync(alive);
	fs.mkdirSync(doomed);
	const fake = fakeRunner();
	const store = new TriggerStore(dir);
	const rt = new TriggerRuntime({ store, jobStore: new JobStore(dir), getSession: () => ({ cwd: alive }), runner: fake, pollIntervalSecs: 0 });
	await store.add({ condition: "c", action: "a", cwd: alive });
	const gone = await store.add({ condition: "c2", action: "a2", cwd: doomed });

	fs.rmSync(doomed, { recursive: true, force: true });
	await rt.tick(Date.now(), true);
	await new Promise((r) => setTimeout(r, 50));

	assert.equal(store.load().find((r) => r.id === gone.id)!.enabled, false, "the rule for the missing checkout is disabled");
	assert.match(store.listAudit(5).map((a) => `${a.state} ${a.summary ?? ""}`).join("\n"), /disabled.*no longer exists/);
	assert.equal(fake.calls.every((c) => c.cwd !== doomed), true, "and no sub-agent was started in it");
	assert.ok(fake.calls.some((c) => c.cwd === alive), "the live project still gets its check");
});

/** A runner whose first call blocks until `open()`, so a test can hold the one concurrency slot. */
function gatedRunner() {
	const calls: SubagentRequest[] = [];
	let unblock!: () => void;
	const gate = new Promise<void>((r) => (unblock = r));
	const run = async (req: SubagentRequest): Promise<RunnerResult> => {
		calls.push(req);
		if (calls.length === 1) await gate;
		return { ok: true, exitCode: 0, timedOut: false, text: `matched ${extractDynamicRuleIds(req.prompt).join(" ")}`, usage: { input: 1, output: 1, cost: 0, turns: 1 } };
	};
	return Object.assign(run, { calls, open: () => unblock() });
}

async function until(cond: () => boolean, what: string): Promise<void> {
	const end = Date.now() + 5000;
	while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
	assert.ok(cond(), what);
}

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

test("a rule whose check keeps failing is polled with a widening gap instead of at every interval", async () => {
	const dir = fs.realpathSync(tmp("pi-loops-trt-"));
	let clock = Date.parse("2026-01-01T00:00:00.000Z");
	let failing = true;
	const calls: SubagentRequest[] = [];
	const runner = Object.assign(
		async (req: SubagentRequest): Promise<RunnerResult> => {
			calls.push(req);
			return failing
				? { ok: false, exitCode: 1, timedOut: false, text: "", errorMessage: "boom", usage: { input: 0, output: 0, cost: 0.01, turns: 1 } }
				: { ok: true, exitCode: 0, timedOut: false, text: "no dynamic trigger rule matched", usage: { input: 1, output: 1, cost: 0.01, turns: 1 } };
		},
		{ calls },
	);
	const finished: any[] = [];
	const rt = new TriggerRuntime({
		store: new TriggerStore(dir), jobStore: new JobStore(dir), getSession: () => ({ sessionId: "s", cwd: dir }), runner,
		// A poll interval far shorter than any pause: when a check below does not run, the pause is why.
		pollIntervalSecs: 10, now: () => clock, hooks: { onFinished: (o) => void finished.push(o) },
	});
	const poll = async () => {
		const n = finished.length;
		await rt.tick(clock, true);
		await until(() => finished.length > n, "the check ran");
	};
	const noCheck = async (why: string) => {
		const n = calls.length;
		await rt.tick(clock, true);
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(calls.length, n, why);
	};
	try {
		await rt.store.add({ condition: "c", action: "a", cwd: dir, fireOnce: false });
		for (let i = 0; i < 3; i++) {
			await poll();
			if (i < 2) clock += 60_000;
		}
		assert.equal(calls.length, 3);
		assert.equal(rt.store.load()[0].consecutiveFailures, 3);
		assert.ok(rt.store.listAudit(50).some((a) => a.state === "backoff"), "the audit says why the rule went quiet");

		// The fourth check waits one minute after the third failure.
		clock += 59_000;
		await noCheck("not checked 59 seconds after the third failure");
		clock += 1_000;
		await poll();
		assert.equal(calls.length, 4, "checked once one minute has passed");

		// The fifth waits five minutes after the fourth failure.
		clock += 5 * 60_000 - 1_000;
		await noCheck("four failures wait five minutes, not one");
		failing = false;
		clock += 1_000;
		await poll();
		assert.equal(calls.length, 5);
		assert.equal(rt.store.load()[0].consecutiveFailures, undefined, "a check that completes clears the count");
	} finally {
		await rt.stop();
	}
});

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

/* ------------------------------------------------- rules that wait for a path */

function waitingSetup(stat?: (p: string) => Promise<unknown>, beforeRun?: () => void) {
	const dir = tmp("pi-loops-trt-path-");
	const runner = matchingRunner();
	const finished: any[] = [];
	const run = (req: SubagentRequest) => {
		beforeRun?.();
		return runner(req);
	};
	const rt = new TriggerRuntime({ store: new TriggerStore(dir), jobStore: new JobStore(dir), getSession: () => ({ cwd: dir }), runner: run, pollIntervalSecs: 1, stat, hooks: { onFinished: (o) => void finished.push(o) } });
	let now = Date.now();
	/** One poll, and the check it started (if any) to its end. */
	const poll = async () => {
		now += 2000;
		const before = finished.length;
		const calls = runner.calls.length;
		await rt.tick(now);
		if (runner.calls.length === calls && rt.runningList().length === 0) return;
		const end = Date.now() + 5000;
		while (finished.length === before && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
	};
	const rows = (state: string, type = "trigger_result") => rt.store.listAudit(1000, (r) => r.type === type && r.state === state);
	return { dir, rt, runner, poll, rows, file: path.join(dir, "build.done") };
}

test("a rule that waits for a path: no model call and no running row while the file is absent, one waiting row; then it matches", async () => {
	const { rt, runner, poll, rows, file } = waitingSetup();
	const rule = await rt.store.add({ condition: `${file} appears`, action: "tell me", cwd: path.dirname(file) });
	assert.equal(rule.precheck?.resolved, file);
	for (let i = 0; i < 5; i++) await poll();
	assert.equal(runner.calls.length, 0, "no model call before the file exists");
	assert.equal(rows("running").length, 0, "no running row");
	assert.equal(rows("waiting", "trigger").length, 1, "one waiting row, on the change only");
	assert.match(rows("waiting", "trigger")[0].summary ?? "", /no model call until .*build\.done exists/);
	assert.equal(rt.ruleLook(rule.id)?.look, "absent");
	fs.writeFileSync(file, "");
	await poll();
	assert.equal(runner.calls.length, 1);
	assert.ok(runner.calls[0].prompt.includes(rule.id));
	assert.equal(rows("appeared", "trigger").length, 1);
	assert.deepEqual((rows("running")[0].details as any).prechecked, [rule.id], "the running row says the stat let it through");
	assert.equal(rt.store.load()[0].enabled, false, "a fire-once rule is disarmed by its match");
	await poll();
	assert.equal(runner.calls.length, 1, "disabled: no more checks");
});

test("a rule whose aside offers another way to be true is checked by the model while the file is absent", async () => {
	const { rt, runner, poll, file } = waitingSetup();
	const rule = await rt.store.add({ condition: `${file} exists (or ${file}.other exists)`, action: "tell me", cwd: path.dirname(file) });
	assert.equal(rule.precheck, undefined, "no path-only watch");
	await poll();
	assert.equal(runner.calls.length, 1, "the model reads the condition although the first path is absent");
});

test("a repeating rule that waits for a path matches while the file is there, stops when it is deleted, and matches again when it comes back", async () => {
	const { rt, runner, poll, rows, file } = waitingSetup();
	await rt.store.add({ condition: `${file} exists`, action: "tell me", cwd: path.dirname(file), fireOnce: false });
	fs.writeFileSync(file, "");
	await poll();
	await poll();
	assert.equal(runner.calls.length, 2, "checked every poll while the file stays, as before");
	fs.rmSync(file);
	await poll();
	await poll();
	assert.equal(runner.calls.length, 2, "no check once it is gone");
	assert.equal(rows("waiting", "trigger").length, 1, "the waiting row on present to absent");
	fs.writeFileSync(file, "");
	await poll();
	assert.equal(runner.calls.length, 3, "the next appearance is checked, and matches again");
	assert.equal(rows("completed").filter((r) => ((r.details as any).matched_rule_ids ?? []).length).length, 3);
});

test("a rule without a pre-check (made before it existed, or seeded by hand) is model-checked every poll; a mixed project leaves only the waiting rule out", async () => {
	const { rt, runner, poll, file } = waitingSetup();
	const dir = path.dirname(file);
	const old = await rt.store.add({ condition: "~/build.done appears", action: "tell me", cwd: dir, fireOnce: false });
	await rt.store.update(old.id, (r) => {
		delete r.gate;
		delete r.precheck;
	});
	const waiting = await rt.store.add({ condition: `${file} appears`, action: "tell me", cwd: dir, fireOnce: false });
	await poll();
	await poll();
	assert.equal(runner.calls.length, 2);
	for (const call of runner.calls) {
		assert.ok(call.prompt.includes(old.id), "the old rule is in the prompt");
		assert.ok(!call.prompt.includes(waiting.id), "the waiting rule is not");
	}
});

test("a look that cannot answer (a hung mount) asks the model, as before there was a pre-check", async () => {
	const { rt, runner, poll, rows, file } = waitingSetup(() => Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" })));
	const rule = await rt.store.add({ condition: `${file} appears`, action: "tell me", cwd: path.dirname(file), fireOnce: false });
	await poll();
	assert.equal(runner.calls.length, 1);
	assert.equal(rows("waiting", "trigger").length, 0, "no waiting row for an unknown look");
	assert.equal((rows("running")[0].details as any).prechecked, undefined);
	assert.equal(rt.ruleLook(rule.id)?.look, "unknown");
});

test("the next look the page shows is the last look plus the poll interval, and never sooner than the 30-second tick polls ride", async () => {
	const { rt, poll, file } = waitingSetup();
	const rule = await rt.store.add({ condition: `${file} appears`, action: "tell me", cwd: path.dirname(file) });
	await poll();
	const look = rt.ruleLook(rule.id)!;
	assert.equal(look.look, "absent");
	rt.pollIntervalSecs = 600;
	assert.equal(rt.ruleLook(rule.id)!.nextAt - look.nextAt, 600_000 - 30_000, "600 s after the look");
	assert.equal(rt.ruleLook("dyn-none"), undefined);
});

test("a rule 0.24.2 made, with only its precheck, is gated by the same path", async () => {
	const { rt, runner, poll, file } = waitingSetup();
	const rule = await rt.store.add({ condition: `${file} appears`, action: "tell me", cwd: path.dirname(file) });
	await rt.store.update(rule.id, (r) => void delete r.gate);
	await poll();
	assert.equal(runner.calls.length, 0, "held while the file is absent");
	fs.writeFileSync(file, "");
	await poll();
	assert.equal(runner.calls.length, 1);
});

test("[gate-raw-first] a reading that opens a check is in events.jsonl before the check runs, and the running row names it", async () => {
	let seenByCheck: any[] = [];
	const events = () => (fs.existsSync(path.join(dir, "events.jsonl")) ? fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
	const { dir, rt, runner, poll, rows, file } = waitingSetup(undefined, () => {
		seenByCheck = events();
	});
	const rule = await rt.store.add({ condition: `${file} appears`, action: "tell me", cwd: path.dirname(file) });
	await poll();
	assert.deepEqual(events(), [], "a held reading stores nothing");
	fs.writeFileSync(file, "");
	await poll();
	assert.equal(runner.calls.length, 1);
	assert.equal(seenByCheck.length, 1, "stored before the check ran");
	const [event] = seenByCheck;
	assert.equal(event.source, `gate:${rule.id}`);
	assert.deepEqual(JSON.parse(event.raw), { path: file, resolved: file, state: "present" });
	assert.deepEqual((rows("running")[0].details as any).events, [event.id], "the check names the reading it ran on");
});

test("[gate-held-count] a reading that holds adds one to the rule's look count in clock.json and stores nothing", async () => {
	const { dir, rt, runner, poll, file } = waitingSetup();
	const rule = await rt.store.add({ condition: `${file} appears`, action: "tell me", cwd: path.dirname(file), fireOnce: false });
	const clock = () => JSON.parse(fs.readFileSync(path.join(dir, "clock.json"), "utf8"));
	for (let i = 0; i < 3; i++) await poll();
	assert.equal(runner.calls.length, 0);
	assert.equal(clock().rules[rule.id].looks, 3);
	assert.equal(clock().rules[rule.id].last.state, "absent");
	assert.equal(fs.existsSync(path.join(dir, "events.jsonl")), false, "no reading stored");
	assert.equal(rule.consecutiveFailures, undefined);
	fs.writeFileSync(file, "");
	await poll();
	assert.equal(runner.calls.length, 1);
	assert.equal(clock().rules[rule.id].looks, 3, "a reading that opens the check is not a held look");
	assert.equal(clock().rules[rule.id].last.state, "present");
	assert.equal(rt.store.load()[0].gate?.resolved, file, "the rule itself is not written for a look");
});

test("a rule's last look outlives the process: a second runtime writes no second waiting row", async () => {
	const { dir, rt, poll, rows, file } = waitingSetup();
	await rt.store.add({ condition: `${file} appears`, action: "tell me", cwd: path.dirname(file) });
	await poll();
	const again = new TriggerRuntime({ store: new TriggerStore(dir), jobStore: new JobStore(dir), getSession: () => ({ cwd: dir }), runner: matchingRunner(), pollIntervalSecs: 1 });
	await again.tick(Date.now() + 60_000);
	assert.equal(rows("waiting", "trigger").length, 1);
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

test("a proposed rule is never checked: a periodic check and a push pass over it", async () => {
	const dir = tmp("pi-loops-trt-");
	const runner = fakeRunner();
	const rt = new TriggerRuntime({ store: new TriggerStore(dir), jobStore: new JobStore(dir), getSession: () => ({ sessionId: "s", cwd: dir }), runner, pollIntervalSecs: 1, hooks: { onPromote: () => "chat", onInjectAndRun: () => "chat" } });
	await rt.store.add({ condition: "c", action: "a", cwd: dir, sessionId: "s", proposed: { at: new Date().toISOString(), session: "s" } });
	try {
		await rt.tick(Date.now(), true);
		await rt.handle(pushTrigger(dir), "sub_agent");
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(runner.calls.length, 0, "no sub-agent was asked");
		assert.equal(rt.store.load()[0].enabled, false);
	} finally {
		await rt.stop();
	}
});

test("[gate-raw-first] a rule's command gate (from a proposal): looked at in the rule's project at most once a minute, stored first; a reading the last check that did not fail saw holds the rule, and a failed check leaves seen", async () => {
	const dir = tmp("pi-loops-trt-command-");
	const project = path.join(dir, "proj");
	fs.mkdirSync(project);
	fs.writeFileSync(path.join(project, "state.txt"), "3 open\n");
	let fails = true;
	const calls: SubagentRequest[] = [];
	const finished: unknown[] = [];
	const runner = async (req: SubagentRequest): Promise<RunnerResult> => {
		calls.push(req);
		return fails ? { ok: false, exitCode: 1, timedOut: false, text: "", errorMessage: "provider error", usage: { input: 1, output: 1, cost: 0, turns: 1 } } : { ok: true, exitCode: 0, timedOut: false, text: "NO_MATCH", usage: { input: 1, output: 1, cost: 0, turns: 1 } };
	};
	const rt = new TriggerRuntime({ store: new TriggerStore(dir), jobStore: new JobStore(dir), getSession: () => ({ cwd: project }), runner, pollIntervalSecs: 1, hooks: { onFinished: (o) => void finished.push(o) } });
	const rule = await rt.store.add({ condition: "a new pull request is opened", action: "review it", cwd: project, fireOnce: false, gate: { kind: "command", command: "cat state.txt" } });
	assert.deepEqual([rule.gate, rule.precheck], [{ kind: "command", command: "cat state.txt" }, undefined], "0.24.2 is given no precheck for a command gate");
	let now = Date.now();
	const poll = async (step: number) => {
		now += step;
		const before = finished.length;
		const ran = calls.length;
		await rt.tick(now);
		if (calls.length === ran) return;
		const end = Date.now() + 5000;
		while (finished.length === before && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
	};
	const events = () => (fs.existsSync(path.join(dir, "events.jsonl")) ? fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
	const clock = () => JSON.parse(fs.readFileSync(path.join(dir, "clock.json"), "utf8")).rules[rule.id];
	await poll(2000);
	assert.equal(calls.length, 1, "nothing seen yet: the reading opens the check");
	assert.deepEqual(events().map((e) => [e.source, JSON.parse(e.raw)]), [[`gate:${rule.id}`, { command: "cat state.txt", exit: 0, stdout: "3 open\n" }]]);
	assert.equal(clock().seen, undefined, "the check failed: seen is left");
	await poll(2000);
	assert.equal(calls.length, 1, "inside the minute: no look and no check");
	fails = false;
	await poll(61_000);
	assert.equal(calls.length, 2, "the same reading opens the check again, since the last one failed");
	assert.equal(events().length, 2);
	assert.equal(clock().seen?.at, events()[1].received_at, "a check that did not fail writes its reading as seen");
	await poll(61_000);
	assert.equal(calls.length, 2, "the reading the last check saw holds the rule");
	assert.deepEqual([clock().looks, events().length], [1, 2], "one held look counted, nothing stored");
	fs.writeFileSync(path.join(project, "state.txt"), "4 open\n");
	await poll(61_000);
	assert.equal(calls.length, 3, "a changed reading opens the check");
	assert.equal(rt.ruleLook(rule.id), undefined, "the page's path line is not drawn for a command gate");
});

test("[gate-held-count] a rule's command gate is looked at once a minute even when its state cannot be read, its reading cannot be stored, or its look time cannot be written", async () => {
	const { clockStore } = await import("../src/stores.ts");
	const { EventLog } = await import("../src/events.ts");
	for (const fail of ["read", "event", "write"] as const) {
		const dir = tmp("pi-loops-trt-minute-");
		const project = path.join(dir, "proj");
		fs.mkdirSync(project);
		const real = clockStore(dir);
		const broken = () => { throw new Error("disk full"); };
		const clock = {
			readGate: (id: string) => (fail === "read" ? broken() : real.readGate(id)),
			noteGate: (id: string, last: Parameters<typeof real.noteGate>[1], held: boolean) => (fail === "write" ? broken() : real.noteGate(id, last, held)),
			seeGate: (id: string, seen: { digest: string; at: string }) => real.seeGate(id, seen),
		};
		const log = new EventLog(dir, "background");
		const events = { append: (source: Parameters<typeof log.append>[0], raw: string) => (fail === "event" ? broken() : log.append(source, raw)) };
		const finished: unknown[] = [];
		const runner = matchingRunner();
		const rt = new TriggerRuntime({ store: new TriggerStore(dir), jobStore: new JobStore(dir), getSession: () => ({ cwd: project }), runner, pollIntervalSecs: 1, clock, events, hooks: { onFinished: (o) => void finished.push(o) } });
		await rt.store.add({ condition: "a new pull request is opened", action: "review it", cwd: project, fireOnce: false, gate: { kind: "command", command: "echo x >> looks.txt; echo 1" } });
		let now = Date.now();
		const poll = async (step: number) => {
			now += step;
			const before = finished.length;
			const ran = runner.calls.length;
			await rt.tick(now);
			if (runner.calls.length === ran) return;
			const end = Date.now() + 5000;
			while (finished.length === before && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
		};
		const looks = () => (fs.existsSync(path.join(project, "looks.txt")) ? fs.readFileSync(path.join(project, "looks.txt"), "utf8").split("\n").filter(Boolean).length : 0);
		await poll(2000);
		assert.equal(looks(), 1, fail);
		await poll(2000);
		await poll(2000);
		assert.equal(looks(), 1, `${fail}: no second look inside the minute`);
		await poll(61_000);
		assert.equal(looks(), 2, `${fail}: the next look after it`);
	}
});

test("[gate-policy] a rule's command gate written into triggers.json by hand that does not show as itself is never run: the look fails with the reason and the model checks the rule", async () => {
	const dir = tmp("pi-loops-trt-hand-");
	const project = path.join(dir, "proj");
	fs.mkdirSync(project);
	const runner = matchingRunner();
	const finished: unknown[] = [];
	const rt = new TriggerRuntime({ store: new TriggerStore(dir), jobStore: new JobStore(dir), getSession: () => ({ cwd: project }), runner, pollIntervalSecs: 1, hooks: { onFinished: (o) => void finished.push(o) } });
	const rule = await rt.store.add({ condition: "a pull request opens", action: "review it", cwd: project, gate: { kind: "command", command: "touch ran; echo ‮" } });
	await rt.tick(Date.now() + 2000);
	const end = Date.now() + 5000;
	while (!finished.length && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
	assert.equal(fs.existsSync(path.join(project, "ran")), false, "the gate was not run");
	assert.equal(runner.calls.length, 1, "a failed look lets the rule through to the model");
	const last = JSON.parse(fs.readFileSync(path.join(dir, "clock.json"), "utf8")).rules[rule.id].last;
	assert.equal(last.failed, "refused: a gate is one line a person can read: it holds a line break, a control character or an invisible one");
});
