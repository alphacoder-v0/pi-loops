import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { LoopScheduler } from "../src/scheduler.ts";
import { TriggerStore } from "../src/triggers.ts";
import { createLoopJob } from "../src/tools.ts";
import { PLAN_ID, type WatchDecision, type WatchPlan, actionDanger, createWatchDesk, derivedId, outcomeLine, parseWatchDecision, planCard, scheduleWords, settleWatch, watchCommand, watchDecisionFrom } from "../src/watch-plan.ts";
import { fakeRunner } from "./fake-runner.ts";

const NOW = Date.parse("2026-11-05T10:00:00");
const rulePlan = (over: Partial<Extract<WatchPlan, { kind: "rule" }>> = {}): WatchPlan => ({ kind: "rule", rule: { condition: "~/build.done appears", action: "run cargo test and show me the result", cwd: "/p" }, where: "chat", once: true, ...over });
const schedulePlan = (over: Partial<Extract<WatchPlan, { kind: "schedule" }>> = {}): WatchPlan => ({ kind: "schedule", job: { schedule: { kind: "cron", expr: "0 9 * * *" }, prompt: "read TODO.md and tell me about new unchecked items", cwd: "/p" }, where: "inbox", ...over });

test("planCard says a schedule in words with its next run, and a rule with how often the background looks", () => {
	const daily = planCard(schedulePlan(), { now: NOW, pollSecs: 600 });
	assert.equal(daily.kind, "schedule");
	assert.equal(daily.when, "every day at 09:00");
	assert.ok(daily.next, "a next run");
	assert.equal(daily.does, "read TODO.md and tell me about new unchecked items");
	assert.equal(daily.command, '/cron add --stateful "0 9 * * *" read TODO.md and tell me about new unchecked items');
	assert.equal(daily.danger, undefined);

	const half = planCard(schedulePlan({ job: { schedule: { kind: "every", ms: 30 * 60_000 }, prompt: "看一下 CI，红了告诉我", cwd: "/p" }, where: "chat" }), { now: NOW, pollSecs: 600 });
	assert.equal(half.when, "every 30m");
	assert.equal(half.command, '/cron add "every 30m" 看一下 CI，红了告诉我', "a plain job has no --stateful");

	const rule = planCard(rulePlan(), { now: NOW, pollSecs: 600 });
	assert.equal(rule.kind, "rule");
	assert.equal(rule.when, "~/build.done appears");
	assert.equal(rule.looksEverySecs, 600);
	assert.equal(rule.next, undefined);
	assert.equal(rule.command, "/new-trigger when ~/build.done appears, run cargo test and show me the result");	assert.equal(rule.precheck, true, "a path-only condition is pre-checked");
	const model = planCard(rulePlan({ rule: { condition: "when a PR of mine gets a review", action: "tell me", cwd: "/p" } }), { now: NOW, pollSecs: 600 });
	assert.equal(model.precheck, undefined);
	assert.equal(model.command, "/new-trigger when a PR of mine gets a review, tell me", "one when, not two");
});

test("the card shows the whole action and condition, redacted, and says when a loop is checked", () => {
	// Cut to 400 characters without a word, the card consented to less than the loop would run.
	const long = `${"look at every open issue, ".repeat(40)}and report`;
	const card = planCard(schedulePlan({ job: { schedule: { kind: "every", ms: 60_000 }, prompt: long, cwd: "/p", verify: true } }), { now: NOW, pollSecs: 600 });
	assert.equal(card.does, long, "whole");
	assert.ok(card.command.endsWith(long), "and the command line carries it whole too");
	assert.equal(card.verify, true);
	assert.equal(planCard(schedulePlan(), { now: NOW, pollSecs: 600 }).verify, undefined, "unset when not asked for");
	const rule = planCard(rulePlan({ rule: { condition: `${"the build on branch x ".repeat(20)}finishes`, action: "export TOKEN=abcdefghijklmnop123 && run it", cwd: "/p" } }), { now: NOW, pollSecs: 600 });
	assert.match(rule.when, /^the build on branch x the build/, "a long condition is whole");
	assert.equal(rule.when.length, "the build on branch x ".length * 20 + "finishes".length);
	assert.doesNotMatch(rule.does, /abcdefghijklmnop123/, "and still redacted");
});

test("scheduleWords reads the common expressions and leaves the rest as they are", () => {
	assert.equal(scheduleWords({ kind: "cron", expr: "0 9 * * *" }), "every day at 09:00");
	assert.equal(scheduleWords({ kind: "cron", expr: "0 19 * * 1-5" }), "weekdays at 19:00");
	assert.equal(scheduleWords({ kind: "cron", expr: "*/30 * * * *" }), "every 30 minutes");
	assert.equal(scheduleWords({ kind: "cron", expr: "0 * * * *" }), "every hour");
	assert.equal(scheduleWords({ kind: "cron", expr: "5 4 1 * *" }), "5 4 1 * *");
	assert.equal(scheduleWords({ kind: "every", ms: 60_000 }), "every 1m");
});

test("a dangerous action is named on the card, in the action and in a code span", () => {
	assert.equal(actionDanger("rm -rf ~/build", "/home/me"), "rm recursive+force on $HOME or ~");
	assert.equal(actionDanger("clean up with `rm -rf /home/me/build` first", "/home/me"), "rm recursive+force on $HOME or ~");
	assert.equal(actionDanger("run cargo test", "/home/me"), undefined);
	assert.ok(planCard(rulePlan({ rule: { condition: "c", action: "rm -rf ~/build", cwd: "/p" } }), { now: NOW, pollSecs: 600, home: "/home/me" }).danger);
});

test("the desk: ids, dedupe, the cap, expiry, one-shot take, a settled answer, and another conversation's plan is gone", () => {
	const desk = createWatchDesk({ ttlMs: 1000, perSession: 2 });
	const a = desk.propose(rulePlan(), planCard(rulePlan(), { now: NOW, pollSecs: 600 }), "s1", NOW);
	assert.match(a.id, PLAN_ID);
	assert.equal(desk.propose(rulePlan(), a.card, "s1", NOW + 1).id, a.id, "the same plan is the same card");
	const b = desk.propose(schedulePlan(), planCard(schedulePlan(), { now: NOW, pollSecs: 600 }), "s1", NOW + 2);
	assert.notEqual(b.id, a.id);
	const c = desk.propose(rulePlan({ once: false }), a.card, "s1", NOW + 3);
	assert.deepEqual(desk.take(a.id, "s1", NOW + 4), { gone: true }, "the third plan dropped the oldest");
	assert.ok(desk.peek(b.id) && desk.peek(c.id));

	assert.deepEqual(desk.take(b.id, "s2", NOW + 5), { gone: true }, "another conversation cannot take it");
	assert.ok(desk.peek(b.id), "and did not consume it");
	const taken = desk.take(b.id, "s1", NOW + 6);
	assert.ok("proposal" in taken && taken.proposal.id === b.id);
	assert.deepEqual(desk.take(b.id, "s1", NOW + 7), { settled: { kind: "gone", planId: b.id } }, "a second take while the first is being applied");
	desk.settle({ kind: "created", planId: b.id, id: "cron-x", plan: schedulePlan() });
	assert.deepEqual(desk.take(b.id, "s1", NOW + 8), { settled: { kind: "created", planId: b.id, id: "cron-x", plan: schedulePlan() } }, "and after: the first outcome");

	assert.deepEqual(desk.take(c.id, "s1", NOW + 1004), { gone: true }, "expired");
	assert.deepEqual(desk.take(b.id, "s1", NOW + 1005), { gone: true }, "a settled answer lives as long as its plan did");
});

test("derived ids have the shape the stores expect, and the same plan gives the same id", () => {
	assert.match(derivedId("rule", "wp-0123456789abcdef"), /^dyn-[0-9a-f]{32}$/);
	assert.match(derivedId("schedule", "wp-0123456789abcdef"), /^cron-[0-9a-f]{32}$/);
	assert.equal(derivedId("rule", "wp-0123456789abcdef"), derivedId("rule", "wp-0123456789abcdef"));
	assert.notEqual(derivedId("rule", "wp-0123456789abcdef"), derivedId("rule", "wp-0123456789abcdee"));
});

test("the decision line the route writes is the one the handler reads, and nothing else parses", () => {
	const d: WatchDecision = { planId: "wp-0123456789abcdef", verdict: "set", where: "chat", once: true };
	assert.equal(watchCommand(d), "/pi-loops watch wp-0123456789abcdef set chat once");
	assert.deepEqual(parseWatchDecision(["wp-0123456789abcdef", "set", "chat", "once"]), d);
	assert.deepEqual(parseWatchDecision(["wp-0123456789abcdef", "cancel", "inbox", "every"]), { planId: "wp-0123456789abcdef", verdict: "cancel", where: "inbox", once: false });
	for (const bad of [["wp-short", "set", "chat", "once"], ["wp-0123456789abcdef", "yes", "chat", "once"], ["wp-0123456789abcdef", "set", "file", "once"], ["wp-0123456789abcdef", "set", "chat", "twice"], ["wp-0123456789abcdef", "set", "chat"], ["wp-0123456789abcdef", "set", "chat", "once", "anything"], []])
		assert.equal(parseWatchDecision(bad), undefined, JSON.stringify(bad));
});

function stores() {
	const dir = tmp("pi-loops-watch-");
	const project = path.join(dir, "p");
	fs.mkdirSync(project);
	const scheduler = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId: "s1", cwd: project }) });
	const triggers = new TriggerStore(dir);
	const host = { scheduler, session: () => ({ sessionId: "s1", cwd: project }) };
	const audited: string[] = [];
	const deps = {
		createJob: (input: Parameters<typeof createLoopJob>[1]) => createLoopJob(host, input),
		addRule: (input: Parameters<TriggerStore["add"]>[0]) => triggers.add(input),
		audit: (job: { id: string }) => void audited.push(job.id),
		jobs: () => scheduler.store.load(),
		rules: () => triggers.load(),
	};
	const bytes = () => [path.join(dir, "jobs.json"), path.join(dir, "triggers.json")].map((f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "absent"));
	return { dir, project, scheduler, triggers, deps, audited, bytes };
}

test("settleWatch maps the two choices onto the stores' fields, in all the combinations", async () => {
	const s = stores();
	try {
		const desk = createWatchDesk();
		const card = planCard(rulePlan(), { now: NOW, pollSecs: 600 });
		for (const [where, once, promoteToChat, fireOnce] of [["chat", true, true, true], ["chat", false, true, false], ["inbox", true, false, true], ["inbox", false, false, false]] as const) {
			const p = desk.propose(rulePlan({ rule: { condition: `c ${where} ${once}`, action: "a", cwd: s.project } }), card, "s1");
			const out = await settleWatch(desk, { planId: p.id, verdict: "set", where, once }, "s1", s.deps);
			assert.equal(out.kind, "created", JSON.stringify(out));
			const rule = s.triggers.load().find((r) => r.id === (out as { id: string }).id)!;
			assert.equal(rule.promoteToChat, promoteToChat, `${where} -> promote_to_chat`);
			assert.equal(rule.fireOnce, fireOnce, `${once} -> fire_once`);
			assert.equal(rule.id, derivedId("rule", p.id));
		}
		for (const [where, stateful] of [["inbox", true], ["chat", false]] as const) {
			const p = desk.propose(schedulePlan({ job: { schedule: { kind: "every", ms: 60_000 }, prompt: `p ${where}`, cwd: s.project, verify: true } }), card, "s1");
			const out = await settleWatch(desk, { planId: p.id, verdict: "set", where, once: true }, "s1", s.deps);
			assert.equal(out.kind, "created", JSON.stringify(out));
			const job = s.scheduler.store.load().find((j) => j.id === (out as { id: string }).id)!;
			assert.equal(job.stateful, stateful, `${where} -> stateful`);
			assert.equal(job.verify, stateful ? true : undefined, "verify only on a loop");
			assert.equal(job.sessionId, stateful ? undefined : "s1");
			assert.equal(job.id, derivedId("schedule", p.id));
			assert.ok(s.audited.includes(job.id), "the create is audited");
		}
	} finally {
		await s.scheduler.stop();
	}
});

test("cancel writes nothing, a plan nobody proposed is gone, and a failed apply is reported", async () => {
	const s = stores();
	try {
		const desk = createWatchDesk();
		const card = planCard(rulePlan(), { now: NOW, pollSecs: 600 });
		const before = s.bytes();
		const p = desk.propose(rulePlan({ rule: { condition: "c", action: "a", cwd: s.project } }), card, "s1");
		assert.deepEqual(s.bytes(), before, "proposing writes nothing");
		assert.deepEqual(await settleWatch(desk, { planId: p.id, verdict: "cancel", where: "chat", once: true }, "s1", s.deps), { kind: "cancelled", planId: p.id });
		assert.deepEqual(s.bytes(), before, "cancel writes nothing");
		assert.equal(await settleWatch(desk, { planId: p.id, verdict: "set", where: "chat", once: true }, "s1", s.deps), undefined, "a cancelled plan cannot be set afterwards, and nothing is said twice");
		assert.deepEqual(await settleWatch(desk, { planId: "wp-0123456789abcdef", verdict: "set", where: "chat", once: true }, "s1", s.deps), { kind: "gone", planId: "wp-0123456789abcdef" });
		assert.deepEqual(s.bytes(), before);

		// A name taken between the card and the click: the store refuses, the card says why.
		await s.scheduler.store.add({ id: "cron-taken", name: "nightly", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "p", cwd: s.project, enabled: true, catchUp: true, createdAt: new Date().toISOString(), runCount: 0, skippedOverlap: 0 });
		const q = desk.propose(schedulePlan({ job: { schedule: { kind: "every", ms: 60_000 }, prompt: "p", cwd: s.project, name: "nightly" } }), card, "s1");
		const failed = await settleWatch(desk, { planId: q.id, verdict: "set", where: "inbox", once: true }, "s1", s.deps);
		assert.equal(failed.kind, "failed");
		assert.match((failed as { error: string }).error, /already exists/);
		assert.equal(s.scheduler.store.load().length, 1, "and nothing was added");
	} finally {
		await s.scheduler.stop();
	}
});

test("a plan whose create landed is not created twice", async () => {
	const s = stores();
	try {
		const desk = createWatchDesk();
		const p = desk.propose(rulePlan({ rule: { condition: "c", action: "a", cwd: s.project } }), planCard(rulePlan(), { now: NOW, pollSecs: 600 }), "s1");
		// The store already holds the rule this plan would make (a crash between the create and the note).
		await s.triggers.add({ condition: "c", action: "a", cwd: s.project, id: derivedId("rule", p.id) });
		const out = await settleWatch(desk, { planId: p.id, verdict: "set", where: "chat", once: true }, "s1", s.deps);
		assert.equal(out?.kind, "created");
		assert.equal(s.triggers.load().length, 1, "one rule, not two");
		assert.equal(await settleWatch(desk, { planId: p.id, verdict: "set", where: "chat", once: true }, "s1", s.deps), undefined, "a replayed answer: nothing, and nothing written");
		assert.equal(s.triggers.load().length, 1);
	} finally {
		await s.scheduler.stop();
	}
});

test("outcomeLine says what happened in one line, with the plan id the page looks for", () => {
	assert.equal(outcomeLine({ kind: "created", planId: "wp-0123456789abcdef", id: "dyn-x", plan: rulePlan() }), "watch plan wp-0123456789abcdef set up as dyn-x (shows in this conversation · once)");
	assert.equal(outcomeLine({ kind: "created", planId: "wp-0123456789abcdef", id: "dyn-x", plan: rulePlan({ where: "inbox", once: false }) }), "watch plan wp-0123456789abcdef set up as dyn-x (kept out of this conversation · every time)");
	assert.equal(outcomeLine({ kind: "created", planId: "wp-0123456789abcdef", id: "cron-x", plan: schedulePlan() }), "watch plan wp-0123456789abcdef set up as cron-x (reports to the inbox)");
	assert.equal(outcomeLine({ kind: "cancelled", planId: "wp-0123456789abcdef" }), "watch plan wp-0123456789abcdef not set up: cancelled");
	assert.equal(outcomeLine({ kind: "failed", planId: "wp-0123456789abcdef", error: "boom" }), "watch plan wp-0123456789abcdef not set up: boom");
	assert.equal(outcomeLine({ kind: "gone", planId: "wp-0123456789abcdef" }), "watch plan wp-0123456789abcdef is gone: read the sentence again");
});

test("watchDecisionFrom reads the route's body at the edge: four fields of the right shape, and nothing else", () => {
	const good = { planId: "wp-0123456789abcdef", verdict: "set", where: "chat", once: true };
	assert.deepEqual(watchDecisionFrom(good), good);
	assert.deepEqual(watchDecisionFrom({ planId: "wp-0123456789abcdef", verdict: "cancel", where: "inbox", once: false }), { planId: "wp-0123456789abcdef", verdict: "cancel", where: "inbox", once: false });
	for (const bad of [{ ...good, planId: "wp-x" }, { ...good, verdict: "yes" }, { ...good, where: "file" }, { ...good, once: "true" }, { ...good, extra: 1 }, { planId: good.planId }, [good], "x", null, undefined])
		assert.equal(watchDecisionFrom(bad), undefined, JSON.stringify(bad));
});

test("the card's command line is redacted the way its action is", () => {
	const secret = "curl -H 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789' https://api.example";
	const card = planCard(rulePlan({ rule: { condition: "the build lands", action: secret, cwd: "/p" } }), { now: NOW, pollSecs: 600 });
	assert.doesNotMatch(card.command, /sk-abcdefghijklmnopqrstuvwxyz/);
	assert.doesNotMatch(card.does, /sk-abcdefghijklmnopqrstuvwxyz/);
	assert.match(card.command, /^\/new-trigger when the build lands, curl/);
});
