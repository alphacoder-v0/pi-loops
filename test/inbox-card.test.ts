import { test } from "node:test";
import assert from "node:assert/strict";
import { type InboxEntry } from "../src/inbox.ts";
import { DISMISS_CHIPS, cardLines, cardsOf, claimPrompt, dismissLine, dismissOutcome, dismissTail, inboxCard, splitFinding } from "../src/inbox-card.ts";

const entry = (over: Partial<InboxEntry>): InboxEntry => ({
	id: "inb-3f2a9c1d00000000000000000000000a",
	created_at: "2026-11-04T09:12:00.000+08:00",
	status: "new",
	kind: "news",
	source: "cron:issue-triage",
	run_id: "run-1",
	cwd: "/home/u/acme-api",
	text: "CI green on main again. Run 412 took 3m.",
	verified: null,
	dismiss_reason: null,
	job_id: "cron-0123",
	...over,
});
const ctx = { here: "session-a", loopName: (id: string) => (id === "cron-0123" ? "issue-triage" : undefined) };

test("a decision splits into its headline, what waits on it and what happens if nobody acts", () => {
	const text = "#14 brief posted — recommend ready-for-agent · waits: the implement loop skips it until labeled · if not: stays needs-triage, no reminder";
	assert.deepEqual(splitFinding(text, "checkpoint"), { headline: "#14 brief posted — recommend ready-for-agent", waits: "the implement loop skips it until labeled", ifNot: "stays needs-triage, no reminder" });
	assert.deepEqual(splitFinding("Close #412? · WAITS: the release · If Not: it ships open", "checkpoint"), { headline: "Close #412?", waits: "the release", ifNot: "it ships open" }, "the marks are read case-insensitively, as findingKind reads them");
	assert.deepEqual(splitFinding("#4 brief posted · waits: your label", "checkpoint"), { headline: "#4 brief posted", waits: "your label" }, "a checkpoint with no if-not has no ifNot");
	assert.deepEqual(splitFinding("· waits: nothing before it", "checkpoint"), { headline: "· waits: nothing before it" }, "an empty headline falls back to the whole text");
	assert.deepEqual(splitFinding("a checkpoint whose clauses were cut", "checkpoint"), { headline: "a checkpoint whose clauses were cut" });
	assert.deepEqual(splitFinding("news with · waits: in it", "news"), { headline: "news with · waits: in it" }, "news is never split at the marks");
});

test("news splits after its first sentence, in English or Chinese, and not past 200 characters", () => {
	assert.deepEqual(splitFinding("CI green on main again. Run 412 took 3m.", "news"), { headline: "CI green on main again.", body: "Run 412 took 3m." });
	assert.deepEqual(splitFinding("主干又绿了。第 412 次运行用了 3 分钟。", "news"), { headline: "主干又绿了。", body: "第 412 次运行用了 3 分钟。" });
	assert.deepEqual(splitFinding("one sentence, no stop", "news"), { headline: "one sentence, no stop" });
	const long = `${"x".repeat(250)}. then more`;
	assert.deepEqual(splitFinding(long, "news"), { headline: long });
});

test("a card carries the finding's marks, origin, loop and owner, redacted and capped", () => {
	const decision = inboxCard(entry({ kind: "checkpoint", text: "ship it · waits: you · if not: it waits", verified: true, verified_reason: "reproduced", session_id: "session-a", transcript: "/loops/sessions/cron-0123/run.jsonl" }), ctx)!;
	assert.equal(decision.kind, "decision");
	assert.deepEqual([decision.headline, decision.waits, decision.ifNot], ["ship it", "you", "it waits"]);
	assert.deepEqual([decision.verified, decision.verifiedReason, decision.origin, decision.loop], [true, "reproduced", "loop", { id: "cron-0123", name: "issue-triage" }]);
	assert.deepEqual([decision.fromThisConversation, decision.hasTranscript, decision.claiming], [true, true, false]);
	assert.equal(inboxCard(entry({ session_id: "session-b" }), ctx)!.fromThisConversation, false);
	assert.deepEqual(inboxCard(entry({ job_id: "cron-gone" }), ctx)!.loop, { id: "cron-gone" }, "a loop that is gone keeps its id and has no name");
	const rule = inboxCard(entry({ source: "trigger:deploy", job_id: "deploy", transcript: "/x" }), ctx)!;
	assert.deepEqual([rule.origin, rule.loop, rule.hasTranscript], ["rule", undefined, false], "a rule's result has no loop and no transcript");
	assert.equal(inboxCard(entry({ text: "could not be delivered (the conversation is gone): run the tests" }), ctx)!.origin, "undelivered");
	assert.equal(inboxCard(entry({}), { ...ctx, claiming: () => true })!.claiming, true);
	assert.equal(inboxCard(entry({ status: "claimed" }), { ...ctx, claiming: () => true })!.claiming, false, "only a new finding is being claimed");
	const key = "sk-ant-api03-" + "a".repeat(40);
	assert.ok(!inboxCard(entry({ text: `leaked ${key} in the log` }), ctx)!.headline.includes(key), "a key in the text is redacted");
	const capped = inboxCard(entry({ kind: "checkpoint", text: `${"d".repeat(570)} · waits: you · if not: it waits` }), ctx)!;
	assert.equal(capped.headline, `${"d".repeat(500)}…`, "a 600-character line written by hand is capped to 500 plus an ellipsis, and the clauses cut off are missing");
	assert.equal(capped.waits, undefined);
});

test("a line with no id or no text makes no card", () => {
	assert.equal(inboxCard(entry({ id: "" }), ctx), undefined);
	assert.equal(inboxCard(entry({ text: "" }), ctx), undefined);
	const cards = cardsOf([entry({ id: "" }), entry({ id: "inb-b" }), entry({ id: "inb-c", kind: "checkpoint", text: "do it · waits: you" })], ctx);
	assert.deepEqual(cards.map((c) => c.id), ["inb-c", "inb-b"], "decisions first; the empty one dropped");
});

test("the terminal lines put a decision's clauses under it, in the page's words", () => {
	const decision = inboxCard(entry({ kind: "checkpoint", text: "#14 brief posted — recommend ready-for-agent · waits: the implement loop skips it until labeled · if not: stays needs-triage, no reminder" }), ctx)!;
	assert.deepEqual(cardLines(decision, "  1. [inb-3f2a9c1d] ", "  (acme-api, cron:issue-triage, 2026-11-04 09:12)"), [
		"  1. [inb-3f2a9c1d] ⚑ #14 brief posted — recommend ready-for-agent  (acme-api, cron:issue-triage, 2026-11-04 09:12)",
		"       waiting on: the implement loop skips it until labeled",
		"       if you don't: stays needs-triage, no reminder",
	]);
	const news = inboxCard(entry({ id: "inb-77e0b2aa", verified: true }), ctx)!;
	assert.deepEqual(cardLines(news, "  2. [inb-77e0b2aa] ", "  (acme-api, cron:ci-watch, 2026-11-04 09:40)"), ["  2. [inb-77e0b2aa] ✓ CI green on main again. Run 412 took 3m.  (acme-api, cron:ci-watch, 2026-11-04 09:40)"], "news reads whole on one line");
	const noIfNot = inboxCard(entry({ kind: "checkpoint", text: "#4 brief posted · waits: your label" }), ctx)!;
	assert.deepEqual(cardLines(noIfNot, "", ""), ["⚑ #4 brief posted", "       waiting on: your label"], "a missing if-not prints nothing");
	assert.deepEqual(cardLines(inboxCard(entry({ text: "主干又绿了。第 412 次运行。" }), ctx)!, "", ""), ["主干又绿了。第 412 次运行。"]);
});

test("a dismiss tells the loop's next run, nobody, or says nothing", () => {
	const loop = { id: "cron-0123", name: "issue-triage" };
	assert.deepEqual(dismissOutcome({ job_id: "cron-0123" }, loop, "Not a bug"), { told: "loop", loop: "issue-triage" });
	assert.deepEqual(dismissOutcome({ job_id: "cron-0123" }, { id: "cron-0123" }, "x"), { told: "loop", loop: "cron-0123" }, "a loop with no name is told by its id");
	assert.deepEqual(dismissOutcome({ job_id: "cron-gone" }, undefined, "x"), { told: "nobody", why: "loop-gone" });
	assert.deepEqual(dismissOutcome({ job_id: "deploy" }, undefined, "x"), { told: "nobody", why: "rule" });
	assert.deepEqual(dismissOutcome({ job_id: "cron-0123" }, loop, "  "), { told: "silent" });
	assert.deepEqual(dismissOutcome({ job_id: "cron-0123" }, loop), { told: "silent" });
	assert.equal(dismissLine({ told: "loop", loop: "issue-triage" }), "Dismissed. Your reason goes to issue-triage's next run.");
	assert.equal(dismissLine({ told: "nobody", why: "loop-gone" }), "Dismissed. The loop that reported it is gone, so nobody is told.");
	assert.equal(dismissLine({ told: "nobody", why: "rule" }), "Dismissed. A rule reported it and keeps no notes, so nobody is told.");
	assert.equal(dismissLine({ told: "silent" }), "Dismissed.");
	assert.equal(dismissTail({ told: "loop", loop: "issue-triage" }), " — issue-triage is told why on its next run");
	assert.equal(dismissTail({ told: "nobody", why: "loop-gone" }), " — the loop that reported it is gone, so nobody is told");
	assert.equal(dismissTail({ told: "nobody", why: "rule" }), " — a trigger reported it, and a trigger keeps no notes, so nobody is told");
	assert.equal(dismissTail({ told: "silent" }), "");
	assert.deepEqual([...DISMISS_CHIPS], ["Not a bug", "Already fixed", "Duplicate", "Too noisy", "Not now"]);
});

test("a claim's prompt is the finding, where it came from, and what a checkpoint's claim means", () => {
	assert.equal(claimPrompt(entry({})), "A recurring loop (cron:issue-triage, running in /home/u/acme-api) reported this finding — investigate and address it:\nCI green on main again. Run 412 took 3m.");
	assert.match(claimPrompt(entry({ kind: "checkpoint", verified: true, verified_reason: "reproduced" })), /kept this finding: reproduced\.\)\nThis finding is a checkpoint: claiming it is the person's approval/);
	assert.equal(claimPrompt(entry({ text: "could not be delivered (pi stopped): run the tests" })), "This prompt (cron:issue-triage, for /home/u/acme-api) could not be delivered earlier (pi stopped). Do what it asks now:\nrun the tests");
});
