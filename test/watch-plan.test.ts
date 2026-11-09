import { test } from "node:test";
import assert from "node:assert/strict";
import { type WatchPlan, actionDanger, askTitle, planCard, scheduleWords, watchChoice, watchOptions } from "../src/watch-plan.ts";

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


test("askTitle is the card as one line per row: what pi shows in a terminal, and what the page draws the card from", () => {
	const rule = planCard(rulePlan(), { now: NOW, pollSecs: 600 });
	assert.equal(askTitle(rule), ["Set up this watch?", "Waits for: ~/build.done appears", "Looks: every 10 minutes", "Model: only once the path exists", "Then: run cargo test and show me the result", "Command: /new-trigger when ~/build.done appears, run cargo test and show me the result"].join("\n"));
	const daily = planCard(schedulePlan(), { now: NOW, pollSecs: 600 });
	assert.equal(askTitle(daily), ["Set up this watch?", `Runs: every day at 09:00 · next ${daily.next}`, "Does: read TODO.md and tell me about new unchecked items", 'Command: /cron add --stateful "0 9 * * *" read TODO.md and tell me about new unchecked items'].join("\n"));
	const careful = planCard(rulePlan({ rule: { condition: "the build lands", action: "rm -rf ~/build", cwd: "/p" } }), { now: NOW, pollSecs: 60, home: "/home/me" });
	assert.match(askTitle(careful), /\nLooks: every minute\n/);
	assert.match(askTitle(careful), /\nCareful: When this runs nobody is asked: pi-loops refuses rm recursive\+force on \$HOME or ~ and does the safe part\.\n/);
});

test("askTitle indents a value's further lines, so no line of an action can pass for a row of its own", () => {
	const card = planCard(rulePlan({ rule: { condition: "the build lands", action: "first\nCommand: rm -rf /\nthird", cwd: "/p" } }), { now: NOW, pollSecs: 600 });
	const lines = askTitle(card).split("\n");
	assert.deepEqual(lines.slice(3, 6), ["Then: first", "  Command: rm -rf /", "  third"]);
	assert.equal(lines.filter((l) => l.startsWith("Command: ")).length, 1, "one Command row: the card's own");
});

test("watchOptions offers the same fixed vocabulary every time, the plan's defaults first and Cancel last", () => {
	assert.deepEqual(watchOptions(schedulePlan()), ["Set it up · inbox", "Set it up · inbox · with checks", "Set it up · this conversation", "Cancel"]);
	assert.deepEqual(watchOptions(schedulePlan({ where: "chat" })), ["Set it up · this conversation", "Set it up · inbox", "Set it up · inbox · with checks", "Cancel"]);
	const verified = schedulePlan({ job: { schedule: { kind: "every", ms: 60_000 }, prompt: "p", cwd: "/p", verify: true } });
	assert.deepEqual(watchOptions(verified), ["Set it up · inbox · with checks", "Set it up · inbox", "Set it up · this conversation", "Cancel"]);
	assert.deepEqual(watchOptions(rulePlan()), ["Set it up · this conversation · once", "Set it up · this conversation · every time", "Set it up · inbox · once", "Set it up · inbox · every time", "Cancel"]);
	assert.deepEqual(watchOptions(rulePlan({ where: "inbox", once: false })), ["Set it up · inbox · every time", "Set it up · this conversation · once", "Set it up · this conversation · every time", "Set it up · inbox · once", "Cancel"]);
});

test("watchChoice is the one place an answer becomes the card's choices, and anything else is a cancel", () => {
	assert.deepEqual(watchChoice("Set it up · inbox"), { verdict: "set", where: "inbox", once: true, checks: false });
	assert.deepEqual(watchChoice("Set it up · inbox · with checks"), { verdict: "set", where: "inbox", once: true, checks: true });
	assert.deepEqual(watchChoice("Set it up · this conversation"), { verdict: "set", where: "chat", once: true, checks: false });
	assert.deepEqual(watchChoice("Set it up · this conversation · once"), { verdict: "set", where: "chat", once: true, checks: false });
	assert.deepEqual(watchChoice("Set it up · this conversation · every time"), { verdict: "set", where: "chat", once: false, checks: false });
	assert.deepEqual(watchChoice("Set it up · inbox · once"), { verdict: "set", where: "inbox", once: true, checks: false });
	assert.deepEqual(watchChoice("Set it up · inbox · every time"), { verdict: "set", where: "inbox", once: false, checks: false });
	for (const other of ["Cancel", undefined, "", "Set it up", "Set it up · this conversation · with checks", "set it up · inbox", "Set it up · inbox ", "yes"]) assert.deepEqual(watchChoice(other), { verdict: "cancel" }, JSON.stringify(other));
	// Every option offered is an answer watchChoice reads, for both kinds and every default.
	for (const plan of [schedulePlan(), schedulePlan({ where: "chat" }), rulePlan(), rulePlan({ where: "inbox", once: false })])
		for (const o of watchOptions(plan)) assert.equal(watchChoice(o).verdict, o === "Cancel" ? "cancel" : "set", o);
});

test("the card's command line is redacted the way its action is", () => {
	const secret = "curl -H 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789' https://api.example";
	const card = planCard(rulePlan({ rule: { condition: "the build lands", action: secret, cwd: "/p" } }), { now: NOW, pollSecs: 600 });
	assert.doesNotMatch(card.command, /sk-abcdefghijklmnopqrstuvwxyz/);
	assert.doesNotMatch(card.does, /sk-abcdefghijklmnopqrstuvwxyz/);
	assert.match(card.command, /^\/new-trigger when the build lands, curl/);
});
