import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { JobStore } from "../src/store.ts";
import { Inbox } from "../src/inbox.ts";
import { attentionFrom } from "../src/activity.ts";
import { type CheckDeps, type CheckInput, TRIGGER_SESSIONS_KEPT, checkCap, checkSessionDir, lastChecks, promotionSummaryBody, promotionToInbox, runCheck, triggerSessionKey } from "../src/check-run.ts";
import { DEFAULT_TRIGGER_RUN_TIMEOUT_SECS } from "../src/config.ts";
import { checkLane } from "../src/lane.ts";
import { runHistory } from "../src/job-status.ts";
import { clockStore } from "../src/stores.ts";
import { type Trigger, TriggerStore, buildPeriodicCheckTrigger, extractDynamicRuleIds } from "../src/triggers.ts";
import type { RunnerResult, SubagentRequest } from "../src/runner.ts";
import { fakeRunner } from "./fake-runner.ts";
import { resolveCap } from "../src/ask.ts";
import { personAnswers } from "../src/answers.ts";
import { RequestStore } from "../src/requests.ts";

/** A runner that matches whatever rules the prompt actually contains. */
function matchingRunner(extra: Partial<RunnerResult> = {}) {
	const calls: SubagentRequest[] = [];
	const run = async (req: SubagentRequest): Promise<RunnerResult> => {
		calls.push(req);
		const ids = extractDynamicRuleIds(req.prompt);
		return { ok: true, exitCode: 0, timedOut: false, text: `matched ${ids.join(" ")}`, usage: { input: 1, output: 1, cost: 0, turns: 1 }, ...extra };
	};
	return Object.assign(run, { calls });
}

/** `runCheck` over the stores of `dir`, as a check of the project `dir` with every enabled rule. */
function checks(dir: string, over: Partial<CheckDeps> = {}) {
	const store = new TriggerStore(dir);
	const jobs = new JobStore(dir);
	const logs: string[] = [];
	const deps: CheckDeps = { runner: fakeRunner(), rules: store, jobs, clock: clockStore(dir), promote: () => "chat", session: { sessionId: "s", cwd: dir }, hop: 0, runTimeoutMs: DEFAULT_TRIGGER_RUN_TIMEOUT_SECS * 1000, log: (m) => void logs.push(m), now: Date.now, ...over };
	const check = (trigger: Trigger = buildPeriodicCheckTrigger(dir, 1), input: Partial<CheckInput> = {}) =>
		runCheck(deps, { trigger, rules: store.load().filter((r) => r.enabled), signal: new AbortController().signal, run: { id: trigger.traceId, cause: "check" }, ...input });
	return { store, jobs, logs, deps, check };
}

test("trigger checks honour a per-rule timeout (and the configurable default) instead of a fixed 15 minutes", async () => {
	const dir = tmp("pi-loops-trt-");
	const { store, check } = checks(dir, { runTimeoutMs: 60_000 });
	const r = await store.add({ condition: "c", action: "a", cwd: dir });
	await store.update(r.id, (rule) => void (rule.timeoutMs = 300));
	process.env.FAKE_PI_SLEEP = "2";
	try {
		const out = await check();
		assert.equal(out.ok, false);
		assert.match(out.error ?? "", /timed out after 0s|timed out/);
	} finally {
		delete process.env.FAKE_PI_SLEEP;
	}
});

test("a check killed by the run timeout still disarms the fire-once rules whose action it already ran", async () => {
	const dir = fs.realpathSync(tmp("pi-loops-trt-"));
	// The action (posting the comment, kicking the deploy) ran; the deadline hit before the reply finished.
	const { store, check } = checks(dir, { runner: matchingRunner({ ok: false, exitCode: 1, timedOut: true, errorMessage: "timed out after 900s" }) });
	const r = await store.add({ condition: "c", action: "post the comment", cwd: dir });
	const out = await check();
	assert.equal(out.ok, false);
	assert.equal(store.load().find((x) => x.id === r.id)?.enabled, false, "the fire-once rule does not run its action again on the next poll");
	const row = store.listAudit(5).find((a) => a.type === "trigger_result" && a.state !== "running")!;
	assert.equal(row.state, "failed", "and the non-ok state is what the audit records");
	assert.deepEqual((row.details as any).matched_rule_ids, [r.id]);
});

test("check transcripts are pruned where the checks actually write them", async () => {
	// The write path is `sessions/triggers-<project>`; the prune asked for `sessions/triggers/<project>`,
	// which does not exist, and the ENOENT was swallowed — so nothing was ever pruned and a project
	// polling every ten minutes kept every transcript it had ever produced.
	const dir = fs.realpathSync(tmp("pi-loops-trt-prune-"));
	const { store, check } = checks(dir);
	const sessions = path.join(dir, "sessions", triggerSessionKey(dir));
	fs.mkdirSync(sessions, { recursive: true });
	for (let i = 0; i < TRIGGER_SESSIONS_KEPT + 20; i++) fs.writeFileSync(path.join(sessions, `old-${i}.jsonl`), "{}\n");
	await store.add({ condition: "c", action: "a", cwd: dir, fireOnce: false });
	const out = await check();
	assert.equal(fs.readdirSync(sessions).filter((f) => f.endsWith(".jsonl")).length, TRIGGER_SESSIONS_KEPT, "the cap docs/configuration.md promises");
	assert.ok(out.sessionFile?.startsWith(sessions), "and that is the directory the check wrote into");
});

test("two projects with the same basename get two transcript directories and prune only their own", async () => {
	// The key was `triggers-<basename>`, so `~/a/web` and `~/b/web` shared one directory: one budget
	// of 40 between them, and each project's prune deleted the other's evidence.
	const dir = fs.realpathSync(tmp("pi-loops-trt-key-"));
	const a = path.join(dir, "a", "web");
	const b = path.join(dir, "b", "web");
	fs.mkdirSync(a, { recursive: true });
	fs.mkdirSync(b, { recursive: true });
	const keyA = triggerSessionKey(a);
	const keyB = triggerSessionKey(b);
	assert.match(keyA, /^triggers-web-[0-9a-f]{8}$/, "the basename still says which project it is");
	assert.notEqual(keyA, keyB);
	assert.equal(keyA, triggerSessionKey(a), "and the key is stable for a project");

	const store = new JobStore(dir);
	const dirA = store.sessionDirFor(keyA);
	const dirB = store.sessionDirFor(keyB);
	assert.notEqual(dirA, dirB);
	for (let i = 0; i < TRIGGER_SESSIONS_KEPT + 5; i++) {
		fs.writeFileSync(path.join(dirA, `a-${i}.jsonl`), "{}\n");
		fs.writeFileSync(path.join(dirB, `b-${i}.jsonl`), "{}\n");
	}
	store.pruneSessions(keyA, TRIGGER_SESSIONS_KEPT);
	const count = (d: string) => fs.readdirSync(d).filter((f) => f.endsWith(".jsonl")).length;
	assert.equal(count(dirA), TRIGGER_SESSIONS_KEPT);
	assert.equal(count(dirB), TRIGGER_SESSIONS_KEPT + 5, "the other project's transcripts are not this one's to delete");
});

test("every matched rule's result is one inbox finding, whatever promote_to_chat says; a quiet check files none", async () => {
	const dir = tmp("pi-loops-trt-inbox-");
	const inbox = new Inbox(dir);
	const promoted: string[] = [];
	// The promotion's inbox fallback, as both processes write it: it must find the check's finding.
	const promote = async (content: string, trigger: Trigger, forSession?: string) => {
		promoted.push(content);
		await inbox.appendOnce({ source: `trigger:${trigger.sourceLabel}`, text: content, run_id: trigger.traceId, job_id: trigger.sourceLabel, cwd: dir, session_id: forSession }, { run_id: trigger.traceId, source: `trigger:${trigger.sourceLabel}` });
		return "inbox" as const;
	};
	const { store, check } = checks(dir, { inbox, promote });
	try {
		const quietRule = await store.add({ condition: "q", action: "x", cwd: dir, sessionId: "creator", fireOnce: false });
		process.env.FAKE_PI_REPLY = "no dynamic trigger matched";
		await check();
		assert.equal(inbox.list().length, 0, "a quiet check files nothing");
		await store.remove(quietRule.id);

		const kept = await store.add({ condition: "~/build.done appears", action: "print it", cwd: dir, sessionId: "creator", fireOnce: false });
		process.env.FAKE_PI_REPLY = `matched ${kept.id}. hello, world; test result: ok`;
		const second = buildPeriodicCheckTrigger(dir, 2);
		await check(second);
		assert.equal(promoted.length, 0, "promote_to_chat false: nothing for the chat");
		const first = inbox.list();
		assert.equal(first.length, 1);
		assert.deepEqual(
			{ source: first[0].source, run_id: first[0].run_id, job_id: first[0].job_id, session_id: first[0].session_id, kind: first[0].kind, text: first[0].text, cwd: first[0].cwd, lane: first[0].lane },
			{ source: "trigger:local:dynamic", run_id: second.traceId, job_id: kept.id, session_id: "creator", kind: "news", text: `matched ${kept.id}. hello, world; test result: ok`, cwd: dir, lane: checkLane(dir) },
			"the finding's text is what the check said, unedited",
		);
		assert.equal(store.listAudit(1)[0].state, "skipped", "the promotion row still says why nothing reached the chat");

		await store.update(kept.id, (r) => { r.promoteToChat = true; });
		process.env.FAKE_PI_REPLY = `matched ${kept.id}. second result`;
		const third = buildPeriodicCheckTrigger(dir, 3);
		await check(third);
		assert.equal(promoted.length, 1, "promote_to_chat true: the result goes to the chat too");
		const mine = inbox.list().filter((e) => e.run_id === third.traceId);
		assert.equal(mine.length, 1, "and is still exactly one finding");
		assert.equal(mine[0].text, `matched ${kept.id}. second result`);
	} finally {
		delete process.env.FAKE_PI_REPLY;
	}
});

test("[guard-seated] a check runs with a seat in its project's check lane; its result's finding records the check's transcript, which pruning keeps", async () => {
	const dir = tmp("pi-loops-trt-seat-");
	const inbox = new Inbox(dir);
	const runner = fakeRunner();
	const { store, jobs, check } = checks(dir, { runner, inbox });
	try {
		const rule = await store.add({ condition: "~/build.done appears", action: "print it", cwd: dir, sessionId: "creator", fireOnce: false });
		process.env.FAKE_PI_REPLY = `matched ${rule.id}. it is there`;
		const trigger = buildPeriodicCheckTrigger(dir, 1);
		const out = await check(trigger);
		const lane = checkLane(dir)!;
		assert.deepEqual(runner.calls[0].guard, { lane, origin: { source: "trigger:local:dynamic", run_id: trigger.traceId, cwd: dir, who: `the check of ${path.basename(dir)}` }, cap: resolveCap({ cwd: dir }, runner.calls[0].timeoutMs) });
		const [finding] = inbox.list();
		assert.ok(out.sessionFile, "the check wrote a transcript");
		assert.equal(finding.transcript, out.sessionFile, "the finding points at it");

		// Older than the newest TRIGGER_SESSIONS_KEPT: kept only because the finding pins it.
		const sessions = jobs.sessionDirFor(triggerSessionKey(dir));
		fs.utimesSync(out.sessionFile!, 1, 1);
		for (let i = 0; i < TRIGGER_SESSIONS_KEPT; i++) fs.writeFileSync(path.join(sessions, `newer-${i}.jsonl`), "{}\n");
		process.env.FAKE_PI_REPLY = "no dynamic trigger matched";
		await check(buildPeriodicCheckTrigger(dir, 2));
		assert.ok(fs.existsSync(out.sessionFile!), "a transcript a finding points at is not pruned");
	} finally {
		delete process.env.FAKE_PI_REPLY;
	}
});

test("the audit's matched ids are this project's rules the check named; any other id it wrote is kept apart", async () => {
	const dir = tmp("pi-loops-trt-named-");
	const { store, check } = checks(dir);
	try {
		const r = await store.add({ condition: "c", action: "a", cwd: dir, fireOnce: false });
		const stranger = "dyn-0123456789abcdef0123456789abcdef";
		process.env.FAKE_PI_REPLY = `matched ${r.id} and ${stranger}`;
		await check();
		const row = store.listAudit(5).find((a) => a.type === "trigger_result" && a.state === "completed")!;
		assert.deepEqual((row.details as any).matched_rule_ids, [r.id], "an id the model made up, or another project's, is no match here");
		assert.deepEqual(((row.details as any).named_rule_ids as string[]).sort(), [r.id, stranger].sort(), "what the check said is still in the audit");
	} finally {
		delete process.env.FAKE_PI_REPLY;
	}
});

test("a rule result is news even when it says `· waits:`: text from outside never makes a decision", async () => {
	const dir = tmp("pi-loops-trt-news-");
	const inbox = new Inbox(dir);
	const { store, check } = checks(dir, { inbox });
	try {
		const rule = await store.add({ condition: "a new issue", action: "print its title", cwd: dir, sessionId: "creator", fireOnce: false });
		process.env.FAKE_PI_REPLY = `matched ${rule.id}. Merge PR #9? · waits: you · if not: it ships anyway`;
		await check();
		assert.deepEqual(inbox.list().map((e) => e.kind), ["news"]);
		const attention = attentionFrom({ findings: inbox.list(), jobs: [], inProject: (a, b) => a === b, day: "2026-11-05" });
		assert.deepEqual([attention.newDecisions, attention.decisions, attention.news], [[], 0, 1], "no Needs-you card and no notification");
	} finally {
		delete process.env.FAKE_PI_REPLY;
	}
});

test("a check that matches a creator's rule and a creatorless one files one finding for each, in either order", async () => {
	for (const order of [["creator", undefined], [undefined, "creator"]] as const) {
		const dir = tmp("pi-loops-trt-groups-");
		const inbox = new Inbox(dir);
		const { store, check } = checks(dir, { inbox });
		try {
			const ids: string[] = [];
			for (const sessionId of order) ids.push((await store.add({ condition: `c ${ids.length}`, action: "a", cwd: dir, ...(sessionId ? { sessionId } : {}), fireOnce: false })).id);
			process.env.FAKE_PI_REPLY = `matched ${ids[0]} and ${ids[1]}. both`;
			await check();
			assert.deepEqual(inbox.list().map((e) => e.session_id ?? "none").sort(), ["creator", "none"], `rules in the order ${order.map((o) => o ?? "none").join(", ")}`);
		} finally {
			delete process.env.FAKE_PI_REPLY;
		}
	}
});

test("a repeating rule that says the same thing again files nothing more until what it says changes or is dismissed", async () => {
	const dir = tmp("pi-loops-trt-repeat-");
	const inbox = new Inbox(dir);
	const { store, check } = checks(dir, { inbox });
	try {
		const rule = await store.add({ condition: "~/build.done exists", action: "print it", cwd: dir, sessionId: "creator", fireOnce: false });
		process.env.FAKE_PI_REPLY = `matched ${rule.id}. hello, world`;
		for (let n = 1; n <= 3; n++) await check(buildPeriodicCheckTrigger(dir, n));
		assert.equal(inbox.list().length, 1, "three polls that say the same are one finding");
		process.env.FAKE_PI_REPLY = `matched ${rule.id}. hello, world 2`;
		await check(buildPeriodicCheckTrigger(dir, 4));
		assert.equal(inbox.list().length, 2, "a new text is a new finding");
		process.env.FAKE_PI_REPLY = `matched ${rule.id}. hello, world`;
		await check(buildPeriodicCheckTrigger(dir, 5));
		assert.equal(inbox.list().length, 3, "only the latest new finding is compared");
		const dirOf = path.dirname(inbox.file);
		await personAnswers({ inbox, requests: new RequestStore(dirOf), jobs: new JobStore(dirOf), audit: new TriggerStore(dirOf), sessionFile: () => undefined, self: () => ({ pid: process.pid, instance: "test", version: "0" }), now: Date.now, log: () => undefined }).say(inbox.list().at(-1)!.id, "no", { by: "cli" }, { reason: "seen" });
		await check(buildPeriodicCheckTrigger(dir, 6));
		assert.equal(inbox.list().filter((e) => e.status === "new").length, 3, "once dismissed, the same text is news again");
	} finally {
		delete process.env.FAKE_PI_REPLY;
	}
});

test("a promoted result that falls back to the inbox is one finding, and a repeat files nothing more", async () => {
	const dir = tmp("pi-loops-trt-fallback-");
	const inbox = new Inbox(dir);
	const audit = new TriggerStore(dir);
	const contents: string[] = [];
	// The fallback both processes use when no conversation can take the result.
	const promote = async (content: string, trigger: Trigger, forSession?: string) => {
		contents.push(content);
		await promotionToInbox(inbox, audit, content, trigger, { cwd: dir, sessionId: forSession });
		return "inbox" as const;
	};
	const { store, check } = checks(dir, { inbox, promote });
	try {
		const rule = await store.add({ condition: "~/build.done exists", action: "print it", cwd: dir, sessionId: "creator", fireOnce: false, promoteToChat: true });
		process.env.FAKE_PI_REPLY = `matched ${rule.id}. hello, world`;
		const first = buildPeriodicCheckTrigger(dir, 1);
		await check(first);
		assert.equal(contents[0], promotionSummaryBody(first, `matched ${rule.id}. hello, world`), "the fallback is handed the real promotion body");
		assert.equal(inbox.list().filter((e) => e.run_id === first.traceId).length, 1, "a first result is exactly one finding");
		assert.equal(inbox.list().length, 1);
		await check(buildPeriodicCheckTrigger(dir, 2));
		assert.equal(contents.length, 2, "the repeat was promoted and fell back too");
		assert.equal(inbox.list().length, 1, "a repeat files nothing more through the fallback");
		// A push no rule check decided: the fallback is its only writer.
		const push = { traceId: "push-1", sourceLabel: "mcp:hub", eventLabel: "issue opened", cwd: dir } as Trigger;
		await promotionToInbox(inbox, audit, promotionSummaryBody(push, "issue #9 opened"), push, { cwd: dir });
		await promotionToInbox(inbox, audit, promotionSummaryBody(push, "issue #9 opened"), push, { cwd: dir });
		assert.deepEqual(inbox.list().filter((e) => e.run_id === "push-1").map((e) => e.source), ["trigger:mcp:hub"], "filed once, by its run");
	} finally {
		delete process.env.FAKE_PI_REPLY;
	}
});

test("what a promotion files in the inbox names the project's check lane, and a result with no project names none", async () => {
	const dir = fs.realpathSync(tmp("pi-loops-trt-"));
	const inbox = new Inbox(dir);
	const audit = new TriggerStore(dir);
	await promotionToInbox(inbox, audit, "[Trigger t-1] the build is red", { sourceLabel: "local:dynamic", traceId: "t-1" }, { cwd: dir, sessionId: "s1" });
	await promotionToInbox(inbox, audit, "[Trigger t-2] no project", { sourceLabel: "local:dynamic", traceId: "t-2" }, { cwd: "" });
	const [withProject, without] = inbox.list();
	assert.deepEqual([withProject.lane, withProject.session_id, withProject.text], [checkLane(dir), "s1", "the build is red"]);
	assert.equal("lane" in without, false);
});

test("[check-dir-symlink] a project reached through a symlink keeps its check transcripts in its real path's directory; a real path's directory keeps its name", () => {
	const root = tmp("pi-loops-trt-link-");
	const real = path.join(root, "real-proj");
	fs.mkdirSync(real);
	const link = path.join(root, "link-proj");
	fs.symlinkSync(real, link);
	assert.equal(triggerSessionKey(link), triggerSessionKey(real), "one directory for one project");
	assert.match(triggerSessionKey(real), /^triggers-real-proj-[0-9a-f]{8}$/, "named for the real directory, as before");
	const jobs = new JobStore(root);
	assert.equal(checkSessionDir(jobs, link), checkSessionDir(jobs, real));
});

test("[check-cap] checkCap: the longest timeout the rules name, else run_timeout_secs; the model and thinking level of the first rule that pins a model", () => {
	assert.deepEqual(checkCap("/p", [], 60_000), resolveCap({ cwd: "/p" }, 60_000));
	assert.deepEqual(checkCap("/p", [{ timeoutMs: 30_000 }, { timeoutMs: 120_000, model: "a/b", thinking: "high" }, { model: "c/d" }], 60_000), resolveCap({ cwd: "/p", model: "a/b", thinking: "high", timeoutMs: 120_000 }, 60_000));
});

/* ------------------------------------------------- the check's run record */

test("[check-run-record] a check writes one record in its project's check lane: what it found, what it cost, how it ended; never two for one run id", async () => {
	const dir = fs.realpathSync(tmp("pi-loops-check-record-"));
	const inbox = new Inbox(dir);
	const { store, jobs, check } = checks(dir, { inbox });
	const lane = checkLane(dir)!;
	const ofRun = (id: string) => jobs.allRuns().filter((r) => r.runId === id);
	try {
		const rule = await store.add({ condition: "c", action: "a", cwd: dir, fireOnce: false });
		const said = `matched ${rule.id}. ${"x".repeat(300)}`;
		process.env.FAKE_PI_REPLY = said;
		const matched = buildPeriodicCheckTrigger(dir, 1);
		const out = await check(matched, { run: { id: matched.traceId, row: "row-1", cause: "check" } });
		const [record] = ofRun(matched.traceId);
		assert.ok(record, "the check wrote its record");
		assert.deepEqual(out.record, record, "and returns it");
		const { startedAt, finishedAt, usage, sessionId, sessionFile, ...rest } = record;
		assert.deepEqual(rest, { runId: matched.traceId, jobId: lane, stateful: false, cwd: dir, pid: process.pid, ok: true, findings: 1, droppedFindings: 0, stateUpdated: false, model: "fake/model", summary: said.slice(0, 200), cause: "check", row: "row-1" });
		assert.ok(Date.parse(startedAt) <= Date.parse(finishedAt));
		assert.deepEqual(usage, { input: 10, output: 5, cost: 0.001, turns: 1 });
		assert.equal(sessionFile, out.sessionFile);
		assert.ok(sessionId);

		await check(matched, { run: { id: matched.traceId, cause: "check" } });
		assert.equal(ofRun(matched.traceId).length, 1, "a second check with the same run id writes no second record");

		process.env.FAKE_PI_FAIL = "1";
		const failed = buildPeriodicCheckTrigger(dir, 2);
		await check(failed, { run: { id: failed.traceId, cause: "push" } });
		const [bad] = ofRun(failed.traceId);
		assert.deepEqual([bad.ok, bad.error, bad.findings, bad.cause, "aborted" in bad, "row" in bad], [false, "boom", 0, "push", false, false]);
		delete process.env.FAKE_PI_FAIL;

		process.env.FAKE_PI_SLEEP = "5";
		const ctrl = new AbortController();
		const stopped = buildPeriodicCheckTrigger(dir, 3);
		const running = check(stopped, { signal: ctrl.signal });
		setTimeout(() => ctrl.abort(), 50);
		const ended = await running;
		assert.equal(ended.state, "aborted");
		const [abortedRecord] = ofRun(stopped.traceId);
		assert.deepEqual([abortedRecord.aborted, abortedRecord.ok, "error" in abortedRecord], [true, false, false]);
	} finally {
		delete process.env.FAKE_PI_REPLY;
		delete process.env.FAKE_PI_FAIL;
		delete process.env.FAKE_PI_SLEEP;
	}
});

test("[check-run-record] runHistory folds a project's checks under its check lane: two failed checks are a streak of 2, a good one ends it", async () => {
	const dir = fs.realpathSync(tmp("pi-loops-check-streak-"));
	const { store, jobs, check } = checks(dir);
	const lane = checkLane(dir)!;
	try {
		await store.add({ condition: "c", action: "a", cwd: dir, fireOnce: false });
		process.env.FAKE_PI_FAIL = "1";
		await check(buildPeriodicCheckTrigger(dir, 1));
		await check(buildPeriodicCheckTrigger(dir, 2));
		assert.equal(runHistory(jobs.allRuns()).get(lane)?.streak, 2);
		delete process.env.FAKE_PI_FAIL;
		await check(buildPeriodicCheckTrigger(dir, 3));
		assert.equal(runHistory(jobs.allRuns()).get(lane)?.streak, 0);
	} finally {
		delete process.env.FAKE_PI_FAIL;
	}
});

test("[check-lane-finding] a finding a check files carries the project's check lane", async () => {
	const dir = fs.realpathSync(tmp("pi-loops-check-lane-"));
	const inbox = new Inbox(dir);
	const { store, check } = checks(dir, { inbox });
	try {
		const rule = await store.add({ condition: "c", action: "a", cwd: dir, sessionId: "creator", fireOnce: false });
		process.env.FAKE_PI_REPLY = `matched ${rule.id}. the build is red`;
		await check();
		assert.deepEqual(inbox.list().map((f) => f.lane), [checkLane(dir)]);
	} finally {
		delete process.env.FAKE_PI_REPLY;
	}
});

test("promotion routed to the inbox is audited as redirected; checks carry the rule's model and a hop", async () => {
	const dir = tmp("pi-loops-trt-");
	const fake = fakeRunner();
	const { store, check } = checks(dir, { runner: fake, promote: () => "inbox", session: { sessionId: "s", cwd: dir, model: "leader/model" } });
	try {
		const r = await store.add({ condition: "c", action: "a", cwd: dir, promoteToChat: true, model: "creator/model", thinking: "high" });
		process.env.FAKE_PI_REPLY = `matched ${r.id}`;
		const out = await check();
		assert.equal(out.promoted, false);
		assert.equal(store.listAudit(1)[0].state, "redirected");
		assert.equal(fake.calls[0].model, "creator/model", "check ran with the rule creator's model, not the timer owner's");
		assert.equal(fake.calls[0].thinking, "high");
		assert.equal(fake.calls[0].hop, 1);
		assert.equal(fake.calls[0].parentSessionId, "s", "sub-agents know the session that runs them (plain cron jobs they create bind to it)");
		assert.equal(fake.calls[0].kind, "trigger");
	} finally {
		delete process.env.FAKE_PI_REPLY;
	}
});

test("every audit row of one check carries the same cwd: the envelope's, else the session's", async () => {
	const dir = fs.realpathSync(tmp("pi-loops-trt-cwd-"));
	const { store, check } = checks(dir, { runner: matchingRunner() });
	await store.add({ condition: "c", action: "a", cwd: dir, promoteToChat: true });
	// No cwd on the envelope, so every row falls back to the session's.
	const trigger: Trigger = { ...buildPeriodicCheckTrigger(dir, 1), cwd: undefined, traceId: "trace-one" };
	await check(trigger);
	const rows = store.listAudit(20, (r) => r.traceId === "trace-one");
	assert.ok(rows.length >= 3, `expected the whole trace, got ${rows.map((r) => `${r.type}:${r.state}`).join(", ")}`);
	assert.deepEqual([...new Set(rows.map((r) => r.cwd))], [dir]);
});

test("[last-checks] lastChecks: each project's newest periodic check from the run log, as no match, matched N, failed or aborted", async () => {
	const one = fs.realpathSync(tmp("pi-loops-last-a-"));
	const two = fs.realpathSync(tmp("pi-loops-last-b-"));
	const a = checks(one);
	const b = checks(two, { jobs: a.jobs });
	try {
		const rule = await a.store.add({ condition: "c", action: "a", cwd: one, fireOnce: false });
		await b.store.add({ condition: "c", action: "a", cwd: two, fireOnce: false });
		process.env.FAKE_PI_REPLY = "no dynamic trigger rule matched";
		const quiet = buildPeriodicCheckTrigger(one, 1);
		await a.check(quiet);
		assert.deepEqual(lastChecks(a.jobs.allRuns()).map((p) => [p.cwd, p.outcome, p.traceId, p.sourceLabel, p.eventLabel, p.summary]), [[one, "no match", quiet.traceId, "local:dynamic", "dynamic periodic check", "no dynamic trigger rule matched"]]);
		process.env.FAKE_PI_REPLY = `matched ${rule.id}`;
		const matched = buildPeriodicCheckTrigger(one, 2);
		await a.check(matched);
		process.env.FAKE_PI_FAIL = "1";
		const failed = buildPeriodicCheckTrigger(two, 1);
		await b.check(failed, { rules: b.store.load().filter((r) => r.cwd === two) });
		delete process.env.FAKE_PI_FAIL;
		const byCwd = new Map(lastChecks(a.jobs.allRuns()).map((p) => [p.cwd, p]));
		assert.deepEqual([byCwd.get(one)?.outcome, byCwd.get(one)?.traceId], ["matched 1", matched.traceId], "the newest check of the project");
		assert.deepEqual([byCwd.get(two)?.outcome, byCwd.get(two)?.summary], ["failed", "boom"]);
		// A push's check is not a poll, and an aborted one says so.
		await a.check(buildPeriodicCheckTrigger(one, 3), { run: { id: "push-1", cause: "push" } });
		assert.equal(new Map(lastChecks(a.jobs.allRuns()).map((p) => [p.cwd, p])).get(one)?.traceId, matched.traceId, "a push's check is not the last poll");
		process.env.FAKE_PI_SLEEP = "5";
		const ctrl = new AbortController();
		const stopped = buildPeriodicCheckTrigger(one, 4);
		const running = a.check(stopped, { signal: ctrl.signal });
		setTimeout(() => ctrl.abort(), 50);
		await running;
		assert.equal(new Map(lastChecks(a.jobs.allRuns()).map((p) => [p.cwd, p])).get(one)?.outcome, "aborted");
	} finally {
		delete process.env.FAKE_PI_REPLY;
		delete process.env.FAKE_PI_FAIL;
		delete process.env.FAKE_PI_SLEEP;
	}
});
