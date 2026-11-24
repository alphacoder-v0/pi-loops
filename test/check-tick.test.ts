import { type TestContext, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { fakeRunner } from "./fake-runner.ts";
import { failurePause } from "../src/backoff.ts";
import { CHECK_SOURCE, checkRow, createCheckTick, ruleLook } from "../src/check-tick.ts";
import { loadConfig } from "../src/config.ts";
import { EventLog } from "../src/events.ts";
import { createHostRuntime } from "../src/host-runtime.ts";
import { runHistory } from "../src/job-status.ts";
import { checkLane } from "../src/lane.ts";
import { LeaseStore } from "../src/lease.ts";
import type { RunnerResult, SubagentRequest, SubagentRunner } from "../src/runner.ts";
import { stamp } from "../src/schedule.ts";
import { clockStore, openStores } from "../src/stores.ts";
import { TriggerStore, extractDynamicRuleIds } from "../src/triggers.ts";

const USAGE = { input: 1, output: 1, cost: 0, turns: 1 };
const BY = { pid: process.pid, instance: "test", version: "0" };
const FACTS = { startedAt: 0, tickMs: 30_000 };

/** A runner that matches whatever rules the prompt contains, so checks of two projects differ. */
function matchingRunner(before?: (req: SubagentRequest) => void | Promise<void>) {
	const calls: SubagentRequest[] = [];
	const run = async (req: SubagentRequest): Promise<RunnerResult> => {
		calls.push(req);
		await before?.(req);
		return { ok: true, exitCode: 0, timedOut: false, text: `matched ${extractDynamicRuleIds(req.prompt).join(" ")}`, usage: USAGE };
	};
	return Object.assign(run, { calls });
}

/**
 * pi-loops in the background over a fresh directory. `look` runs the `rule-checks` rider alone (the
 * rows it writes); `poll` runs it, then the `check-lanes` rider, and waits for the checks it started.
 */
function scene(t: TestContext, over: { runner?: SubagentRunner; pollSecs?: number; dir?: string } = {}) {
	const dir = over.dir ?? fs.realpathSync(tmp("pi-loops-check-tick-"));
	fs.writeFileSync(path.join(dir, "config.toml"), `[triggers]\npoll_interval_secs = ${over.pollSecs ?? 1}\n`);
	const runner = over.runner ?? matchingRunner();
	const logs: string[] = [];
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner, mcpTools: () => [], log: (line) => void logs.push(line) });
	t.after(() => host.stop());
	let now = Date.now();
	const lookAt = async (at: number) => {
		now = at;
		await host.riders["rule-checks"](now, FACTS);
	};
	const look = (step = 2000) => lookAt(now + step);
	const poll = async (step = 2000) => {
		await look(step);
		await host.riders["check-lanes"](Date.now(), FACTS);
		await host.drain(5000);
	};
	const project = (name = "proj") => {
		const p = path.join(dir, name);
		fs.mkdirSync(p, { recursive: true });
		return p;
	};
	const rows = (cwd: string) => host.stores.requests.list(checkLane(cwd)!);
	const audit = (state: string, type = "trigger_result") => host.stores.rules.listAudit(1000, (r) => r.type === type && r.state === state);
	const events = () => (fs.existsSync(path.join(dir, "events.jsonl")) ? fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
	const clock = () => JSON.parse(fs.readFileSync(path.join(dir, "clock.json"), "utf8"));
	return { dir, host, runner, logs, look, lookAt, poll, project, rows, audit, events, clock, now: () => now };
}

function failedCheck(lane: string, cwd: string, at: number, id: string, ok = false) {
	return { runId: id, jobId: lane, stateful: false, cwd, pid: 1, startedAt: stamp(at - 1000), finishedAt: stamp(at), ok, ...(ok ? {} : { error: "boom" }), findings: 0, droppedFindings: 0, stateUpdated: false, usage: USAGE, cause: "check" as const };
}

test("[check-timer-row] a project with enabled rules gets one check: row naming its rules; no row inside the poll interval; a proposed rule is not named", async (t) => {
	const s = scene(t, { pollSecs: 60 });
	const project = s.project();
	const a = await s.host.stores.rules.add({ condition: "a build fails", action: "x", cwd: project, fireOnce: false });
	const b = await s.host.stores.rules.add({ condition: "a deploy ends", action: "y", cwd: project });
	const proposed = await s.host.stores.rules.add({ condition: "a test flakes", action: "z", cwd: project, sessionId: "s", proposed: { at: new Date().toISOString(), session: "s" } });
	await s.look(0);
	const rows = s.rows(project);
	assert.equal(rows.length, 1, "one row for the project");
	const [row] = rows;
	assert.deepEqual([row.lane, row.source, row.run], [checkLane(project), CHECK_SOURCE, undefined]);
	assert.deepEqual([...(row.payload?.rules ?? [])].sort(), [a.id, b.id].sort(), "it names the enabled rules");
	assert.ok(!row.payload?.rules?.includes(proposed.id), "and not the proposed one");
	assert.equal(s.runner.calls.length, 0, "the tick writes the row; it runs nothing");
	s.host.stores.requests.remove(row.lane, [row.id]);
	await s.look(30_000);
	assert.deepEqual(s.rows(project), [], "inside the 60-second poll interval: no row");
	await s.look(31_000);
	assert.equal(s.rows(project).length, 1, "after it: the next row");
});

test("[check-active-collapse] a second tick while the first check row is queued or running writes no second row", async (t) => {
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	const runner = matchingRunner(() => held);
	const s = scene(t, { runner });
	const project = s.project();
	await s.host.stores.rules.add({ condition: "a build fails", action: "x", cwd: project, fireOnce: false });
	await s.look();
	const [queued] = s.rows(project);
	await s.look();
	assert.deepEqual(s.rows(project).map((r) => r.id), [queued.id], "queued: the next poll collapses into it");
	await s.host.riders["check-lanes"](Date.now(), FACTS);
	assert.equal(runner.calls.length, 1);
	assert.ok(s.rows(project)[0]?.run, "the row is claimed: its check runs");
	await s.look();
	assert.deepEqual(s.rows(project).map((r) => r.id), [queued.id], "running: the next poll collapses into it");
	release();
	await s.host.drain(5000);
	assert.deepEqual(s.rows(project), [], "the check ended and its row left");
	await s.look();
	assert.equal(s.rows(project).length, 1, "the next poll writes the next row");
});

test("[check-gate-held] a rule whose gate holds is left out of payload.rules; when every rule holds, no row", async (t) => {
	const s = scene(t);
	const mixed = s.project("mixed");
	const plain = await s.host.stores.rules.add({ condition: "a build fails", action: "x", cwd: mixed, fireOnce: false });
	const waits = await s.host.stores.rules.add({ condition: `${path.join(mixed, "build.done")} appears`, action: "y", cwd: mixed });
	assert.equal(waits.gate?.kind, "path");
	const only = s.project("only");
	await s.host.stores.rules.add({ condition: `${path.join(only, "build.done")} appears`, action: "y", cwd: only });
	await s.look();
	assert.deepEqual(s.rows(mixed).map((r) => r.payload?.rules), [[plain.id]], "the waiting rule is left out");
	assert.deepEqual(s.rows(only), [], "every rule holds: no row");
});

test("[check-streak-backoff] three failed check records of the lane hold the next row back for failurePause(3)", async (t) => {
	const s = scene(t);
	const project = s.project();
	const lane = checkLane(project)!;
	await s.host.stores.rules.add({ condition: "a build fails", action: "x", cwd: project, fireOnce: false });
	const t0 = Date.parse("2026-01-01T00:00:00.000Z");
	for (let i = 0; i < 3; i++) s.host.stores.jobs.appendRun(failedCheck(lane, project, t0 + i * 1000, `chk-fail-${i}`));
	const last = t0 + 2000;
	await s.lookAt(last + failurePause(3) - 1000);
	assert.deepEqual(s.rows(project), [], "three failures: no row a second before the pause ends");
	const backoffRows = () => s.host.stores.rules.listAudit(50, (r) => r.state === "backoff" && r.cwd === project);
	assert.equal(backoffRows().length, 1, "entering the backoff is audited as backoff");
	assert.equal((backoffRows()[0].details as any).consecutive_failures, 3);
	await s.lookAt(last + failurePause(3) - 500);
	assert.equal(backoffRows().length, 1, "once per failure, not at every poll");
	await s.lookAt(last + failurePause(3));
	assert.equal(s.rows(project).length, 1, "the pause ended: a row");
	s.host.stores.requests.remove(lane, s.rows(project).map((r) => r.id));

	const fourth = last + failurePause(3) + 1000;
	s.host.stores.jobs.appendRun(failedCheck(lane, project, fourth, "chk-fail-3"));
	await s.lookAt(fourth + failurePause(3));
	assert.deepEqual(s.rows(project), [], "four failures wait failurePause(4), not failurePause(3)");
	assert.ok(failurePause(4) > failurePause(3));
	s.host.stores.jobs.appendRun(failedCheck(lane, project, fourth + failurePause(3) + 1000, "chk-ok", true));
	await s.lookAt(fourth + failurePause(3) + 2000);
	assert.equal(s.rows(project).length, 1, "a check that did not fail ends the streak");
});

/* ------------------------------------------------- ported from test/trigger-runtime.test.ts */

test("periodic check: matched fire-once rule is disabled, promote_to_chat rule promotes, audit written", async (t) => {
	const s = scene(t, { runner: fakeRunner() });
	const project = s.project();
	new LeaseStore(s.dir).acquire("held", { kind: "terminal", pid: process.pid, instance: "w", acquiredAt: new Date().toISOString(), pushServers: [] });
	const a = await s.host.stores.rules.add({ condition: "a", action: "x", cwd: project });
	const b = await s.host.stores.rules.add({ condition: "b", action: "y", cwd: project, promoteToChat: true, fireOnce: false, sessionId: "held" });
	process.env.FAKE_PI_REPLY = `matched ${a.id} and ${b.id}: printed the file`;
	t.after(() => void delete process.env.FAKE_PI_REPLY);
	await s.poll();
	const records = s.host.stores.jobs.allRuns().filter((r) => r.jobId === checkLane(project));
	assert.equal(records.length, 1, "one check, one record under the project's lane");
	assert.deepEqual([records[0].ok, records[0].cause], [true, "check"]);
	const rules = s.host.stores.rules.load();
	assert.equal(rules.find((r) => r.id === a.id)?.enabled, false, "fire-once rule disabled");
	assert.equal(rules.find((r) => r.id === b.id)?.enabled, true, "repeat rule stays");
	const promoted = s.host.stores.requests.list("held");
	assert.equal(promoted.length, 1, "the promotion is queued for the conversation that created the rule");
	// The promoted body names the cause, not only the result: the chat says what fired.
	assert.match(promoted[0].payload?.text ?? "", /^\[Trigger [^\]]+\] local:dynamic fired dynamic periodic check\.\nResult: matched dyn-/);
	const audit = s.host.stores.rules.listAudit(10, (r) => r.traceId === records[0].row);
	assert.deepEqual(audit.map((r) => `${r.type}:${r.state}`), ["trigger_promotion:promoted", "trigger_result:completed", "trigger_result:running", "trigger:accepted"]);
	// The envelope is persisted on every state a trigger passes through, so
	// "which pushes collapsed into which" stays answerable from the audit alone.
	const keys = [...new Set(audit.map((r) => (r.details as any).idempotency_key))];
	assert.equal(keys.length, 1, `every row of one trigger carries the same idempotency key, got ${JSON.stringify(keys)}`);
	assert.ok((keys[0] as string).startsWith(`local:dynamic:${project}`), keys[0] as string);
	assert.ok(audit.every((r) => (r.details as any).replacement_policy === "drop" && (r.details as any).received_at));
	assert.ok(records[0].sessionFile && fs.existsSync(records[0].sessionFile), "check transcript kept");
	// Interval not elapsed → no second check
	await s.poll(100);
	assert.equal(s.host.stores.jobs.allRuns().filter((r) => r.jobId === checkLane(project)).length, 1);
});

test("a rule can be checked now, without waiting for its poll slot", async (t) => {
	const s = scene(t);
	const project = s.project();
	const rule = await s.host.stores.rules.add({ condition: "a", action: "x", cwd: project, fireOnce: false });
	await s.poll();
	assert.equal(s.runner.calls.length, 1);
	await s.poll(100);
	assert.equal(s.runner.calls.length, 1, "the slot is claimed: a second tick checks nothing");
	// What `/triggers run` writes: a row for that rule's project with that rule only.
	s.host.stores.requests.append(checkRow(project, [rule.id], BY, Date.now()));
	await s.host.riders["check-lanes"](Date.now(), FACTS);
	await s.host.drain(5000);
	assert.equal(s.runner.calls.length, 2, "checked now regardless of the poll interval");
	assert.ok(s.runner.calls[1].prompt.includes(rule.id));
	// It is a real check, so it is audited like one rather than being invisible.
	assert.equal(s.audit("completed").length, 2);
	assert.deepEqual(s.rows(project), []);
});

test("the host checks every rule; the promotion reaches the creating session's holder, and two windows in one repo each receive only their own rules' promotions", async (t) => {
	const s = scene(t);
	const repo = s.project("repo");
	const other = s.project("other");
	const leases = new LeaseStore(s.dir);
	for (const id of ["s1", "s2"]) leases.acquire(id, { kind: "terminal", pid: process.pid, instance: id, acquiredAt: new Date().toISOString(), pushServers: [] });
	const a = await s.host.stores.rules.add({ condition: "a", action: "x", cwd: repo, sessionId: "s1", promoteToChat: true, fireOnce: false });
	const b = await s.host.stores.rules.add({ condition: "b", action: "y", cwd: repo, sessionId: "s2", promoteToChat: true, fireOnce: false });
	const c = await s.host.stores.rules.add({ condition: "c", action: "z", cwd: other, promoteToChat: true, fireOnce: false }); // made from a shell: no creating session
	await s.poll();
	assert.deepEqual(s.runner.calls.map((r) => r.cwd).sort(), [repo, other].sort(), "one check per project, every rule, whoever has a window open");
	assert.deepEqual(s.host.stores.requests.list("s1").map((r) => r.payload?.text?.includes(a.id)), [true], "one promotion for s1");
	assert.deepEqual(s.host.stores.requests.list("s2").map((r) => r.payload?.text?.includes(b.id)), [true], "one promotion for s2");
	const audit = s.host.stores.rules.listAudit(50, (r) => r.type === "trigger_promotion");
	for (const rule of [a, b, c]) assert.ok(audit.some((r) => (r.details as any).rule_ids?.join() === rule.id), `${rule.id} audited with its own rules`);
	assert.equal(audit.find((r) => (r.details as any).rule_ids?.join() === c.id)?.state, "redirected", "no creating conversation: the inbox");
	// The poll ledger: a second tick inside the interval checks nothing.
	const before = s.runner.calls.length;
	await s.poll(100);
	assert.equal(s.runner.calls.length, before);
});

test("audit rows carry the project cwd and reach the session sink", async (t) => {
	const s = scene(t);
	const project = s.project();
	const sink: any[] = [];
	s.host.stores.rules.onAudit = (r) => void sink.push(r);
	await s.host.stores.rules.add({ condition: "c", action: "a", cwd: project });
	await s.poll();
	assert.equal(s.runner.calls.length, 1);
	assert.ok(sink.length >= 2, "every audit row is also handed to the session sink");
	assert.ok(sink.every((r) => r.cwd === project), "rows carry the project they belong to");
	assert.equal(s.host.stores.rules.listAudit(10, (r) => r.cwd === project).length, sink.length);
});

test("rules whose project is gone are disabled instead of polling and billing forever", async (t) => {
	const s = scene(t);
	const alive = s.project("alive");
	const doomed = s.project("doomed");
	await s.host.stores.rules.add({ condition: "c", action: "a", cwd: alive });
	const gone = await s.host.stores.rules.add({ condition: "c2", action: "a2", cwd: doomed });
	fs.rmSync(doomed, { recursive: true, force: true });
	await s.poll();
	assert.equal(s.host.stores.rules.load().find((r) => r.id === gone.id)!.enabled, false, "the rule for the missing checkout is disabled");
	assert.match(s.host.stores.rules.listAudit(5).map((a) => `${a.state} ${a.summary ?? ""}`).join("\n"), /disabled.*no longer exists/);
	assert.ok(s.runner.calls.every((c) => c.cwd !== doomed), "and no sub-agent was started in it");
	assert.ok(s.runner.calls.some((c) => c.cwd === alive), "the live project still gets its check");
});

test("a persistence failure in the periodic part never rejects the tick: an audit that cannot be written is logged, the look is still counted", async () => {
	const dir = fs.realpathSync(tmp("pi-loops-check-tick-"));
	fs.mkdirSync(path.join(dir, "triggers-audit.jsonl")); // appendFileSync → EISDIR
	const project = path.join(dir, "proj");
	fs.mkdirSync(project);
	const stores = openStores(dir);
	const logs: string[] = [];
	stores.rules.onPersistenceError = (m) => void logs.push(m);
	const rule = await stores.rules.add({ condition: `${path.join(project, "build.done")} appears`, action: "tell me", cwd: project });
	const tick = createCheckTick({ rules: stores.rules, requests: stores.requests, clock: stores.clock, events: new EventLog(dir, "background"), gatePolicy: () => ({ loopsDir: dir, allowCommands: [] }), pollIntervalSecs: () => 1, history: () => runHistory(stores.jobs.allRuns()), createdBy: () => BY, log: (m) => void logs.push(m) });
	await tick.tick(Date.now());
	assert.match(stores.rules.lastPersistenceError ?? "", /EISDIR/, "the waiting row was not written");
	assert.equal(ruleLook(stores.clock, rule.id, 1)?.look, "absent", "the look is counted all the same");
	assert.ok(logs.some((m) => /EISDIR/.test(m)), "and the failure is logged");
});

/* ------------------------------------------------- rules that wait for a path */

test("a rule that waits for a path: no model call and no running row while the file is absent, one waiting row; then it matches", async (t) => {
	const s = scene(t);
	const file = path.join(s.project(), "build.done");
	const rule = await s.host.stores.rules.add({ condition: `${file} appears`, action: "tell me", cwd: path.dirname(file) });
	assert.equal(rule.precheck?.resolved, file);
	for (let i = 0; i < 5; i++) await s.poll();
	assert.equal(s.runner.calls.length, 0, "no model call before the file exists");
	assert.equal(s.audit("running").length, 0, "no running row");
	assert.equal(s.audit("waiting", "trigger").length, 1, "one waiting row, on the change only");
	assert.match(s.audit("waiting", "trigger")[0].summary ?? "", /no model call until .*build\.done exists/);
	assert.equal(ruleLook(s.host.stores.clock, rule.id, 1)?.look, "absent");
	fs.writeFileSync(file, "");
	await s.poll();
	assert.equal(s.runner.calls.length, 1);
	assert.ok(s.runner.calls[0].prompt.includes(rule.id));
	assert.equal(s.audit("appeared", "trigger").length, 1);
	assert.deepEqual((s.audit("running")[0].details as any).prechecked, [rule.id], "the running row says the stat let it through");
	assert.equal(s.host.stores.rules.load()[0].enabled, false, "a fire-once rule is disarmed by its match");
	await s.poll();
	assert.equal(s.runner.calls.length, 1, "disabled: no more checks");
});

test("a rule whose aside offers another way to be true is checked by the model while the file is absent", async (t) => {
	const s = scene(t);
	const file = path.join(s.project(), "build.done");
	const rule = await s.host.stores.rules.add({ condition: `${file} exists (or ${file}.other exists)`, action: "tell me", cwd: path.dirname(file) });
	assert.equal(rule.precheck, undefined, "no path-only watch");
	await s.poll();
	assert.equal(s.runner.calls.length, 1, "the model reads the condition although the first path is absent");
});

test("a repeating rule that waits for a path matches while the file is there, stops when it is deleted, and matches again when it comes back", async (t) => {
	const s = scene(t);
	const file = path.join(s.project(), "build.done");
	await s.host.stores.rules.add({ condition: `${file} exists`, action: "tell me", cwd: path.dirname(file), fireOnce: false });
	fs.writeFileSync(file, "");
	await s.poll();
	await s.poll();
	assert.equal(s.runner.calls.length, 2, "checked every poll while the file stays, as before");
	fs.rmSync(file);
	await s.poll();
	await s.poll();
	assert.equal(s.runner.calls.length, 2, "no check once it is gone");
	assert.equal(s.audit("waiting", "trigger").length, 1, "the waiting row on present to absent");
	fs.writeFileSync(file, "");
	await s.poll();
	assert.equal(s.runner.calls.length, 3, "the next appearance is checked, and matches again");
	assert.equal(s.audit("completed").filter((r) => ((r.details as any).matched_rule_ids ?? []).length).length, 3);
});

test("a rule without a pre-check (made before it existed, or seeded by hand) is model-checked every poll; a mixed project leaves only the waiting rule out", async (t) => {
	const s = scene(t);
	const dir = s.project();
	const file = path.join(dir, "build.done");
	const old = await s.host.stores.rules.add({ condition: "~/build.done appears", action: "tell me", cwd: dir, fireOnce: false });
	await s.host.stores.rules.update(old.id, (r) => {
		delete r.gate;
		delete r.precheck;
	});
	const waiting = await s.host.stores.rules.add({ condition: `${file} appears`, action: "tell me", cwd: dir, fireOnce: false });
	await s.poll();
	await s.poll();
	assert.equal(s.runner.calls.length, 2);
	for (const call of s.runner.calls) {
		assert.ok(call.prompt.includes(old.id), "the old rule is in the prompt");
		assert.ok(!call.prompt.includes(waiting.id), "the waiting rule is not");
	}
});

test("a look that cannot answer (a hung mount) asks the model, as before there was a pre-check", async () => {
	const dir = fs.realpathSync(tmp("pi-loops-check-tick-"));
	const project = path.join(dir, "proj");
	fs.mkdirSync(project);
	const stores = openStores(dir);
	const file = path.join(project, "build.done");
	const rule = await stores.rules.add({ condition: `${file} appears`, action: "tell me", cwd: project, fireOnce: false });
	const tick = createCheckTick({
		rules: stores.rules, requests: stores.requests, clock: stores.clock, events: new EventLog(dir, "background"), gatePolicy: () => ({ loopsDir: dir, allowCommands: [] }),
		pollIntervalSecs: () => 1, history: () => runHistory(stores.jobs.allRuns()), createdBy: () => BY, log: () => undefined,
		stat: () => Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" })),
	});
	await tick.tick(Date.now());
	const [row] = stores.requests.list(checkLane(project)!);
	assert.deepEqual(row?.payload?.rules, [rule.id], "the rule goes to the model");
	assert.equal(row.payload?.prechecked, undefined, "not as prechecked");
	assert.equal(stores.rules.listAudit(10, (r) => r.state === "waiting").length, 0, "no waiting row for an unknown look");
	assert.equal(ruleLook(stores.clock, rule.id, 1)?.look, "unknown");
});

test("the next look the page shows is the last look plus the poll interval, and never sooner than the 30-second tick polls ride", async (t) => {
	const s = scene(t);
	const file = path.join(s.project(), "build.done");
	const rule = await s.host.stores.rules.add({ condition: `${file} appears`, action: "tell me", cwd: path.dirname(file) });
	await s.poll();
	const look = ruleLook(s.host.stores.clock, rule.id, 1)!;
	assert.equal(look.look, "absent");
	assert.equal(ruleLook(s.host.stores.clock, rule.id, 600)!.nextAt - look.nextAt, 600_000 - 30_000, "600 s after the look");
	assert.equal(ruleLook(s.host.stores.clock, "dyn-none", 1), undefined);
});

test("a rule 0.24.2 made, with only its precheck, is gated by the same path", async (t) => {
	const s = scene(t);
	const file = path.join(s.project(), "build.done");
	const rule = await s.host.stores.rules.add({ condition: `${file} appears`, action: "tell me", cwd: path.dirname(file) });
	await s.host.stores.rules.update(rule.id, (r) => void delete r.gate);
	await s.poll();
	assert.equal(s.runner.calls.length, 0, "held while the file is absent");
	fs.writeFileSync(file, "");
	await s.poll();
	assert.equal(s.runner.calls.length, 1);
});

test("[gate-raw-first] a reading that opens a check is in events.jsonl before the check runs, and the running row names it", async (t) => {
	let seenByCheck: any[] = [];
	const s = scene(t, { runner: matchingRunner(() => void (seenByCheck = s.events())) });
	const file = path.join(s.project(), "build.done");
	const rule = await s.host.stores.rules.add({ condition: `${file} appears`, action: "tell me", cwd: path.dirname(file) });
	await s.poll();
	assert.deepEqual(s.events(), [], "a held reading stores nothing");
	fs.writeFileSync(file, "");
	await s.poll();
	assert.equal(s.runner.calls.length, 1);
	assert.equal(seenByCheck.length, 1, "stored before the check ran");
	const [event] = seenByCheck;
	assert.equal(event.source, `gate:${rule.id}`);
	assert.deepEqual(JSON.parse(event.raw), { path: file, resolved: file, state: "present" });
	assert.deepEqual((s.audit("running")[0].details as any).events, [event.id], "the check names the reading it ran on");
});

test("[gate-held-count] a reading that holds adds one to the rule's look count in clock.json and stores nothing", async (t) => {
	const s = scene(t);
	const file = path.join(s.project(), "build.done");
	const rule = await s.host.stores.rules.add({ condition: `${file} appears`, action: "tell me", cwd: path.dirname(file), fireOnce: false });
	for (let i = 0; i < 3; i++) await s.poll();
	assert.equal(s.runner.calls.length, 0);
	assert.equal(s.clock().rules[rule.id].looks, 3);
	assert.equal(s.clock().rules[rule.id].last.state, "absent");
	assert.equal(fs.existsSync(path.join(s.dir, "events.jsonl")), false, "no reading stored");
	fs.writeFileSync(file, "");
	await s.poll();
	assert.equal(s.runner.calls.length, 1);
	assert.equal(s.clock().rules[rule.id].looks, 3, "a reading that opens the check is not a held look");
	assert.equal(s.clock().rules[rule.id].last.state, "present");
	assert.equal(s.host.stores.rules.load()[0].gate?.resolved, file, "the rule itself is not written for a look");
});

test("a rule's last look outlives the process: a second runtime writes no second waiting row", async (t) => {
	const s = scene(t);
	const file = path.join(s.project(), "build.done");
	await s.host.stores.rules.add({ condition: `${file} appears`, action: "tell me", cwd: path.dirname(file) });
	await s.poll();
	const again = scene(t, { dir: s.dir });
	await again.lookAt(s.now() + 60_000);
	assert.equal(s.audit("waiting", "trigger").length, 1);
});

/* ------------------------------------------------- rules with a command gate */

test("[gate-raw-first] a rule's command gate (from a proposal): looked at in the rule's project at most once a minute, stored first; a reading the last check that did not fail saw holds the rule, and a failed check leaves seen", async (t) => {
	let fails = true;
	const calls: SubagentRequest[] = [];
	const runner = async (req: SubagentRequest): Promise<RunnerResult> => {
		calls.push(req);
		return fails ? { ok: false, exitCode: 1, timedOut: false, text: "", errorMessage: "provider error", usage: USAGE } : { ok: true, exitCode: 0, timedOut: false, text: "NO_MATCH", usage: USAGE };
	};
	const s = scene(t, { runner });
	const project = s.project();
	fs.writeFileSync(path.join(project, "state.txt"), "3 open\n");
	const rule = await s.host.stores.rules.add({ condition: "a new pull request is opened", action: "review it", cwd: project, fireOnce: false, gate: { kind: "command", command: "cat state.txt" } });
	assert.deepEqual([rule.gate, rule.precheck], [{ kind: "command", command: "cat state.txt" }, undefined], "0.24.2 is given no precheck for a command gate");
	const clock = () => s.clock().rules[rule.id];
	await s.poll(2000);
	assert.equal(calls.length, 1, "nothing seen yet: the reading opens the check");
	assert.deepEqual(s.events().map((e) => [e.source, JSON.parse(e.raw)]), [[`gate:${rule.id}`, { command: "cat state.txt", exit: 0, stdout: "3 open\n" }]]);
	assert.equal(clock().seen, undefined, "the check failed: seen is left");
	await s.poll(2000);
	assert.equal(calls.length, 1, "inside the minute: no look and no check");
	fails = false;
	await s.poll(61_000);
	assert.equal(calls.length, 2, "the same reading opens the check again, since the last one failed");
	assert.equal(s.events().length, 2);
	assert.equal(clock().seen?.at, s.events()[1].received_at, "a check that did not fail writes its reading as seen");
	await s.poll(61_000);
	assert.equal(calls.length, 2, "the reading the last check saw holds the rule");
	assert.deepEqual([clock().looks, s.events().length], [1, 2], "one held look counted, nothing stored");
	fs.writeFileSync(path.join(project, "state.txt"), "4 open\n");
	await s.poll(61_000);
	assert.equal(calls.length, 3, "a changed reading opens the check");
	assert.equal(ruleLook(s.host.stores.clock, rule.id, 1), undefined, "the page's path line is not drawn for a command gate");
});

test("[gate-held-count] a rule's command gate is looked at once a minute even when its state cannot be read, its reading cannot be stored, or its look time cannot be written", async () => {
	for (const fail of ["read", "event", "write"] as const) {
		const dir = tmp("pi-loops-check-tick-minute-");
		const project = path.join(dir, "proj");
		fs.mkdirSync(project);
		const real = clockStore(dir);
		const broken = () => { throw new Error("disk full"); };
		const clock = {
			readGate: (id: string) => (fail === "read" ? broken() : real.readGate(id)),
			noteGate: (id: string, last: Parameters<typeof real.noteGate>[1], held: boolean) => (fail === "write" ? broken() : real.noteGate(id, last, held)),
			seeGate: (id: string, seen: { digest: string; at: string }) => real.seeGate(id, seen),
			claimCheck: (lane: string, at: number, ms: number) => real.claimCheck(lane, at, ms),
		};
		const log = new EventLog(dir, "background");
		const events = { append: (source: Parameters<typeof log.append>[0], raw: string) => (fail === "event" ? broken() : log.append(source, raw)) };
		const rules = new TriggerStore(dir);
		const stores = openStores(dir);
		const tick = createCheckTick({ rules, requests: stores.requests, clock, events, gatePolicy: () => ({ loopsDir: dir, allowCommands: [] }), pollIntervalSecs: () => 1, history: () => new Map(), createdBy: () => BY, log: () => undefined });
		await rules.add({ condition: "a new pull request is opened", action: "review it", cwd: project, fireOnce: false, gate: { kind: "command", command: "echo x >> looks.txt; echo 1" } });
		let now = Date.now();
		const poll = async (step: number) => {
			now += step;
			await tick.tick(now);
			stores.requests.remove(checkLane(project)!, stores.requests.list(checkLane(project)!).map((r) => r.id));
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

test("[gate-policy] a rule's command gate written into triggers.json by hand that does not show as itself is never run: the look fails with the reason and the model checks the rule", async (t) => {
	const s = scene(t);
	const project = s.project();
	const rule = await s.host.stores.rules.add({ condition: "a pull request opens", action: "review it", cwd: project, gate: { kind: "command", command: "touch ran; echo ‮" } });
	await s.poll();
	assert.equal(fs.existsSync(path.join(project, "ran")), false, "the gate was not run");
	assert.equal(s.runner.calls.length, 1, "a failed look lets the rule through to the model");
	assert.equal(s.clock().rules[rule.id].last.failed, "refused: a gate is one line a person can read: it holds a line break, a control character or an invisible one");
});
