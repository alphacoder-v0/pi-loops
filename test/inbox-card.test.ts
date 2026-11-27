import { test } from "node:test";
import assert from "node:assert/strict";
import { questionFinding } from "../src/ask.ts";
import { type InboxEntry } from "../src/inbox.ts";
import { CANCELLED_LINE, DISMISS_CHIPS, backgroundOff, answerLine, answerWho, cancelRefusal, clearLeftTail, cardLine, cardLines, cardOrigin, cardsOf, dismissLine, dismissOutcome, dismissTail, inboxCard, noQuestionLine, questionActions, shellClaimOfQuestion, splitFinding, threadOrder, threadedLines, threads, yesPageLine, yesTerminalLine } from "../src/inbox-card.ts";
import type { LaneId } from "../src/lane.ts";
import type { Row } from "../src/requests.ts";
import { screenText } from "../src/redact.ts";

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
	assert.deepEqual([decision.verified, decision.verifiedReason, decision.origin, decision.loop], [true, "reproduced", "loop", { id: "cron-0123", name: "issue-triage", label: "issue-triage" }]);
	assert.deepEqual([decision.fromThisConversation, decision.hasTranscript], [true, true]);
	assert.equal(inboxCard(entry({ session_id: "session-b" }), ctx)!.fromThisConversation, false);
	assert.deepEqual(inboxCard(entry({ job_id: "cron-gone" }), ctx)!.loop, { id: "cron-gone", label: "cron-gone" }, "a loop that is gone keeps its id and has no name");
	assert.equal(inboxCard(entry({ job_id: "cron-15c11c9f364f92b42c49f6d15ea2bff6" }), ctx)!.loop?.label, "cron-15c11c9f", "a loop with no name is labelled as every surface labels it");
	const rule = inboxCard(entry({ source: "trigger:deploy", job_id: "deploy", transcript: "/x" }), ctx)!;
	assert.deepEqual([rule.origin, rule.loop, rule.hasTranscript], ["rule", undefined, false], "a rule's result has no loop and no transcript");
	assert.equal(inboxCard(entry({ text: "could not be delivered (the conversation is gone): run the tests", undelivered: true }), ctx)!.origin, "undelivered");
	assert.equal(inboxCard(entry({ text: "could not be delivered (the conversation is gone): run the tests" }), ctx)!.origin, "loop", "a loop that writes the words is still a loop");
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

test("the terminal names what filed a finding as every surface does: a loop by its label, a rule by its source", () => {
	assert.equal(cardOrigin(inboxCard(entry({}), ctx)!), "issue-triage", "a named loop: its name");
	assert.equal(cardOrigin(inboxCard(entry({ source: "cron:cron-5f1c0a2b9d3e4f60718293a4b5c6d7e8", job_id: "cron-5f1c0a2b9d3e4f60718293a4b5c6d7e8" }), ctx)!), "cron-5f1c0a2b", "an unnamed loop: the first 13 characters of its id, never cron:<whole id>");
	assert.equal(cardOrigin(inboxCard(entry({ source: "trigger:deploy", job_id: "deploy" }), ctx)!), "trigger:deploy");
});

test("a dismiss tells the loop's next run, nobody, or says nothing", () => {
	const loop = { id: "cron-0123", name: "issue-triage" };
	assert.deepEqual(dismissOutcome({ job_id: "cron-0123" }, loop, "Not a bug"), { told: "loop", loop: "issue-triage" });
	assert.deepEqual(dismissOutcome({ job_id: "cron-0123" }, { id: "cron-0123" }, "x"), { told: "loop", loop: "cron-0123" }, "a loop with no name is told by its label");
	assert.deepEqual(dismissOutcome({ job_id: "cron-0123456789abcdef0123456789abcdef" }, { id: "cron-0123456789abcdef0123456789abcdef" }, "x"), { told: "loop", loop: "cron-01234567" }, "the label, not the whole id");
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

test("one line per finding, for a shell: the clauses on the finding's line, in the page's words", () => {
	const decision = inboxCard(entry({ kind: "checkpoint", text: "ship it · waits: the release · if not: it waits" }), ctx)!;
	assert.equal(cardLine(decision, "inb-1  ", "  (p, s, t)"), "inb-1  ⚑ ship it · waiting on: the release · if you don't: it waits  (p, s, t)");
	assert.equal(cardLine(inboxCard(entry({ kind: "checkpoint", text: "#4 brief posted · waits: your label" }), ctx)!, "", ""), "⚑ #4 brief posted · waiting on: your label");
	assert.equal(cardLine(inboxCard(entry({}), ctx)!, "", ""), "CI green on main again. Run 412 took 3m.");
});

test("a finding's terminal escape sequences and bidi overrides do not reach the card", () => {
	const card = inboxCard(entry({ kind: "checkpoint", text: "ship \u001b[2J\u001b[31mit\u001b[0m \u001b]0;title\u0007now‮ · waits: you\u0007 · if not: it waits", verified: true, verified_reason: "kept \u001b[1mbold\u001b[0m" }), ctx)!;
	assert.deepEqual([card.headline, card.waits, card.ifNot, card.verifiedReason], ["ship it now", "you", "it waits", "kept bold"]);
	assert.ok(!cardLines(card, "", "").join("\n").match(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/), "nothing a terminal would act on");
});

test("an escape introducer with no terminator hides nothing: the card reads the words", () => {
	assert.equal(screenText("a\u001b]0;x rest"), "a0;x rest", "the lone introducer goes, the words stay");
	const e = entry({ kind: "checkpoint", text: "Deploy? \u001b]0;x · waits: your yes · if not: nothing ships" });
	const card = inboxCard(e, ctx)!;
	assert.deepEqual([card.headline, card.waits, card.ifNot], ["Deploy? 0;x", "your yes", "nothing ships"]);
	assert.ok(inboxCard(entry({ text: "\u001b]0;all of it" }), ctx)!.headline.includes("all of it"), "a finding that is all introducer still has its words");
});

test("tag and zero-width characters are taken out of the card", () => {
	const tags = String.fromCodePoint(0xe0001, 0xe0041, 0xe0042, 0xe007f);
	const hidden = `ship\u200b it now\u2060\ufeff${tags}`;
	assert.equal(screenText(hidden), "ship it now");
	assert.equal(screenText(`a${String.fromCodePoint(0xe0080)}b`), `a${String.fromCodePoint(0xe0080)}b`, "a character past the tag block stays");
	const e = entry({ text: hidden, source: `cron:tri\u200bage${tags}`, cwd: `/home/u/api\ufeff` });
	assert.equal(inboxCard(e, ctx)!.headline, "ship it now");
});

test("every invisible character a variation or filler hides is taken out, and an emoji, a joined word and an ideographic variant keep theirs", () => {
	const cases: Array<[string, number[]]> = [
		["soft hyphen", [0xad]],
		["combining grapheme joiner", [0x34f]],
		["Arabic letter mark", [0x61c]],
		["Hangul fillers", [0x115f, 0x1160, 0x3164, 0xffa0]],
		["Mongolian vowel separator", [0x180e]],
		["left-to-right and right-to-left marks", [0x200e, 0x200f]],
		["invisible operators U+2061-2064", [0x2061, 0x2062, 0x2063, 0x2064]],
		["variation selectors U+FE00-FE0D", [0xfe00, 0xfe07, 0xfe0d]],
	];
	for (const [name, points] of cases) for (const p of points) assert.equal(screenText(`a${String.fromCodePoint(p)}b`), "ab", `${name}: U+${p.toString(16).toUpperCase()}`);
	assert.equal(screenText("ok \u2764\ufe0f \u2764\ufe0e"), "ok \u2764\ufe0f \u2764\ufe0e", "U+FE0F and U+FE0E choose how an emoji is drawn");
	// Joiners and ideographic variation selectors are part of ordinary text, a typed dismiss reason included.
	for (const text of ["\u{1f468}\u200d\u{1f469}\u200d\u{1f467} family", "\u{1f3f3}\ufe0f\u200d\u{1f308} flag", "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645", "\u0915\u094d\u200c\u0937", "\u845b\u{e0100}\u98fe"]) assert.equal(screenText(text), text, JSON.stringify(text));
});

test("a rule result's card names the rule's condition, redacted and clipped, and nothing when the rule is gone", () => {
	const withRules = { ...ctx, ruleCondition: (id: string) => (id === "dyn-1" ? `when ~/build.done appears ${"and more ".repeat(20)} sk-abcdefghijklmnopqrstuvwxyz012345` : undefined) };
	const card = inboxCard(entry({ source: "trigger:local:dynamic", job_id: "dyn-1", text: "hello, world. test result: ok" }), withRules)!;
	assert.equal(card.headline, "hello, world.", "the headline is what the check said");
	assert.equal(card.rule?.id, "dyn-1");
	assert.ok(card.rule!.condition!.startsWith("when ~/build.done appears"));
	assert.ok(card.rule!.condition!.length <= 80, `clipped: ${card.rule!.condition!.length}`);
	assert.doesNotMatch(card.rule!.condition!, /sk-abcdefghijklmnopqrstuvwxyz012345/);
	assert.deepEqual(inboxCard(entry({ source: "trigger:local:dynamic", job_id: "dyn-2", text: "x." }), withRules)!.rule, { id: "dyn-2" }, "a removed rule is named by its id");
	assert.equal(inboxCard(entry({ source: "trigger:mcp:hub", job_id: "mcp:hub", text: "x." }), withRules)!.rule, undefined, "a push with no rule names none");
});

test("a rule result's headline is what the check said after its `matched <rule-id>` token; the stored text keeps it", () => {
	const a = `dyn-${"a1".repeat(16)}`;
	const b = `dyn-${"b2".repeat(16)}`;
	const text = `matched ${a}. Ran cargo test in the project: test result: ok. 1 passed; 0 failed; 0 ignored.`;
	const found = entry({ source: "trigger:local:dynamic", job_id: a, text });
	const card = inboxCard(found, ctx)!;
	assert.equal(card.headline, "Ran cargo test in the project: test result: ok.");
	assert.equal(card.body, "1 passed; 0 failed; 0 ignored.");
	assert.equal(found.text, text, "the finding is what the run said (CONTRACT.md 2.5)");
	assert.equal(inboxCard(entry({ source: "trigger:local:dynamic", job_id: a, text: `matched \`${a}\`, ${b}: Contents of $HOME/helloworld: hello, world` }), ctx)!.headline, "Contents of $HOME/helloworld: hello, world", "two ids, quoted, then a colon");
	assert.equal(inboxCard(entry({ source: "trigger:local:dynamic", job_id: a, text: `matched ${a}.` }), ctx)!.headline, `matched ${a}.`, "nothing after the token: the token is the headline");
	assert.equal(inboxCard(entry({ source: "cron:x", job_id: "cron-0123", text: `matched ${a}. a loop said it` }), ctx)!.headline, `matched ${a}.`, "a loop's finding is not a rule result");
});

const QUESTION = { kind: "call" as const, id: `ask-${"b".repeat(32)}`, lane: "@cron-0123" as const, session_id: "sid-1", title: "nightly asks to run a command", call: { tool: "bash", tool_call_id: "c1", command: "git push --force origin fix/login", input_sha256: "a".repeat(64), reason: "git push --force on main/master" }, created_at: "2026-11-20T00:00:00.000+00:00" };
const RUN = { id: "ans-1", pid: 1, started_at: "2026-11-20T00:00:00.000+00:00" };
const AT = "2026-11-20T00:00:00.000+00:00";

test("an answer's state reads as design 6.1's table says, from the finding alone", () => {
	const claimed = (over: Partial<InboxEntry>) => entry({ status: "claimed", answered_by: "page", claimed_by: "s1", ...over });
	assert.equal(answerLine(claimed({ answer: { state: "pending", at: AT } })), "Waiting to run");
	const waiting = { waiting: "today's automation has cost $5.02 of the $5.00 budget" } as Row;
	assert.equal(answerLine(claimed({ answer: { state: "pending", at: AT } }), waiting), "Waiting to run: today's automation has cost $5.02 of the $5.00 budget", "why the lane is blocked, from the row");
	assert.equal(answerLine(claimed({ answer: { state: "started", run: RUN, at: AT } })), "Running");
	assert.equal(answerLine(claimed({ answer: { state: "done", run: RUN, at: AT } }), undefined, "\nClosed #412.\nmore"), "Done · Closed #412.", "the run's summary while the run log has the record");
	assert.equal(answerLine(claimed({ answer: { state: "done", run: RUN, at: AT } })), "Done", "then Done");
	assert.equal(answerLine(claimed({ ask: QUESTION, answer: { state: "unfinished", run: RUN, why: "stopped", ending: "The command was not run.", at: AT } })), "Started and did not finish (stopped). The command was not run.");
	assert.equal(answerLine(claimed({ ask: QUESTION, answer: { state: "unfinished", run: RUN, why: "the process died", at: AT } })), "Started and did not finish (the process died). The command may or may not have run.");
	assert.equal(answerLine(claimed({ answer: { state: "unfinished", run: RUN, why: "stopped", at: AT } })), "Started and did not finish (stopped).", "a finding that is not a question has no ending");
	assert.equal(answerLine(claimed({ answer: { state: "not_run", why: "the loop was removed", at: AT } })), "Not run (the loop was removed)");
	assert.equal(answerLine(entry({ status: "claimed", answered_by: "cli" })), "Claimed from the command line. Nothing ran");
	assert.equal(answerLine(entry({ status: "claimed", claimed_by: "s1" })), "Claimed before the upgrade.", "no answer and no answered_by: a claim 0.24.2 made");
	assert.equal(answerLine(entry({})), undefined, "a new finding has nothing to say");
	assert.equal(answerLine(entry({ status: "dismissed", answered_by: "page" })), undefined);
	assert.equal(answerLine(claimed({ answer: { state: "unreadable", raw: { state: "later" } } })), undefined, "an answer a newer version wrote says nothing");
	const key = "sk-ant-api03-" + "a".repeat(40);
	const said = answerLine(claimed({ answer: { state: "unfinished", run: RUN, why: `failed \u001b[31m${key}`, at: AT } }))!;
	assert.ok(!said.includes(key) && !said.includes("\u001b"), said);
});

test("a yes from the page whose row was not queued does not say it runs", () => {
	const news = entry({ status: "claimed" });
	for (const kept of [true, false]) {
		const line = yesPageLine({ said: "Y1", finding: news, queued: false }, "nightly", kept);
		assert.doesNotMatch(line, /running/i, `transcript kept: ${kept}`);
		assert.equal(line, "Your yes is saved, but its run could not be queued. pi-loops queues it again on its next tick.");
	}
	assert.equal(yesPageLine({ said: "Y1", finding: news, queued: true }, "nightly", true), "Running in the background, in the run that reported it.");
});

test("a cancel that comes too late is refused in design 6.2's words", () => {
	assert.equal(CANCELLED_LINE, "Cancelled. The question is open again");
	assert.equal(cancelRefusal({ refused: "state", state: "started" }), "it has already started: stop it instead");
	for (const state of ["done", "unfinished", "not_run"] as const) assert.equal(cancelRefusal({ refused: "state", state }), "it has already ended", state);
	assert.equal(cancelRefusal({ refused: "not-a-real-yes" }), "it has no queued answer to cancel");
	assert.equal(cancelRefusal({ refused: "state", state: "none" }), "it has no queued answer to cancel");
});

test("a yes and a no say what design 6.1 and 6.2 say, on each surface", () => {
	const news = entry({ status: "claimed" });
	const asked = entry({ status: "claimed", ask: QUESTION });
	assert.equal(yesTerminalLine({ said: "Y1", finding: news }, "nightly", true), "claimed: nightly picks this up in the run that reported it, in the background. A card comes here when it ends.");
	assert.equal(yesTerminalLine({ said: "Y1", finding: asked }, "nightly", true), "approved: nightly resumes the run that asked, with this one command allowed. A card comes here when it ends.");
	assert.equal(yesTerminalLine({ said: "Y2", finding: news, why: "the loop was removed" }, "nightly", true), "the loop was removed; nothing runs");
	assert.equal(yesTerminalLine({ said: "Y2", finding: news, why: "the conversation was deleted" }, "nightly", false), "the conversation was deleted; nothing runs", "a yes that runs nothing waits for nothing");
	assert.equal(yesPageLine({ said: "Y1", finding: news }, "nightly", true), "Running in the background, in the run that reported it.");
	assert.equal(yesPageLine({ said: "Y1", finding: news }, "nightly", false), "Running in the background. The run's transcript is gone, so nightly starts from the finding's text.");
	assert.equal(yesPageLine({ said: "Y1", finding: { ...asked, answered_by: "page", answer: { state: "pending", at: AT } } }, "nightly", true), "Waiting to run", "a question shows its state at once");
	assert.equal(yesPageLine({ said: "Y2", finding: news, why: "the loop was removed" }, "nightly", true), "Not run (the loop was removed)");
	assert.equal(noQuestionLine("terminal", "nightly"), "said no: nightly is told why on its next run; the same command is refused for 14 days");
	assert.equal(noQuestionLine("page", "nightly"), "You said no. nightly is told on its next run, and the same command is refused for 14 days.");
	assert.equal(noQuestionLine("page", "nightly", "@cron-nightly" as LaneId), "You said no. nightly is told on its next run, and the same command is refused for 14 days.", "a loop's lane: its next run");
	assert.equal(noQuestionLine("page", '"deploy-check"', "0199aaaa-0000-7000-8000-000000000001" as LaneId), 'You said no. "deploy-check" is told in this conversation, and the same command is refused for 14 days.', "a conversation's question (design 6.4)");
	assert.equal(noQuestionLine("terminal", '"deploy-check"', "0199aaaa-0000-7000-8000-000000000001" as LaneId), 'said no: "deploy-check" is told in this conversation; the same command is refused for 14 days');
	assert.equal(shellClaimOfQuestion("inb-3f2a9c1d", "nightly"), "inbox entry inb-3f2a9c1d is a question from nightly, and a claim from a shell allows no command: answer it on the page or in pi with /inbox");
});

test("[yes-waits] a yes said while pi-loops is not running in the background says it runs when pi-loops does", () => {
	const news = entry({ status: "claimed" });
	const asked = entry({ status: "claimed", ask: QUESTION });
	assert.equal(yesTerminalLine({ said: "Y1", finding: news }, "nightly", false), "claimed: nightly picks this up in the run that reported it, in the background. It runs once pi-loops runs in the background. Run pi-loops start (or /pi-loops start) to start it. A card comes here when it ends.");
	assert.equal(yesTerminalLine({ said: "Y1", finding: asked }, "nightly", false), "approved: nightly resumes the run that asked, with this one command allowed. It runs once pi-loops runs in the background. Run pi-loops start (or /pi-loops start) to start it. A card comes here when it ends.");
});

test("[yes-waits] a yes said while pi-loops is kept off says why, in the words of pi-loops status, and how to start it", () => {
	const asked = entry({ status: "claimed", ask: QUESTION });
	const line = (off: Parameters<typeof backgroundOff>[0]) => yesTerminalLine({ said: "Y1", finding: asked }, "nightly", false, undefined, backgroundOff(off));
	const head = "approved: nightly resumes the run that asked, with this one command allowed. It runs once pi-loops runs in the background.";
	const tail = "Run pi-loops start (or /pi-loops start) to start it. A card comes here when it ends.";
	assert.equal(line({ stopped: true, envOff: true, auto: false }), `${head} It does not run now: it was stopped by hand. ${tail}`, "a stop by hand first, as status checks it");
	assert.equal(line({ stopped: false, envOff: true, auto: false }), `${head} It does not run now: PI_LOOPS_HOST=off is set. ${tail}`);
	assert.equal(line({ stopped: false, envOff: false, auto: false }), `${head} It does not run now: [host] auto = false in config.toml. ${tail}`);
	assert.equal(line({ stopped: false, envOff: false, auto: true }), `${head} ${tail}`, "no known reason: none is said");
	assert.equal(yesTerminalLine({ said: "Y1", finding: asked }, "nightly", true, undefined, "stopped"), "approved: nightly resumes the run that asked, with this one command allowed. A card comes here when it ends.", "running: no reason is said");
});

test("[clear] /inbox clear says how many questions it left, and nothing when it left none", () => {
	assert.equal(clearLeftTail(0), "");
	assert.equal(clearLeftTail(1), "; left 1 question for you to answer: /inbox claim <n> or /inbox dismiss <n>");
	assert.equal(clearLeftTail(3), "; left 3 questions for you to answer: /inbox claim <n> or /inbox dismiss <n>");
});

test("[M5b.3] a question from a scheduled prompt in a conversation: the card's who-asks line and who waits name the prompt by its job's name; a loop's question names the loop", () => {
	const conversation = "0199aaaa-0000-7000-8000-0000000000a1";
	const command = "sudo systemctl restart api";
	const call = { tool: "bash", tool_call_id: "c1", command, input_sha256: "a".repeat(64), reason: "sudo invocation" };
	const cap = { cwd: "/home/u/acme-api", model: null, thinking: null, tools: "session", builtinTools: "session", timeoutMs: 1000 } as unknown as Parameters<typeof questionFinding>[1]["cap"];
	const origin = { source: "cron:deploy-check", run_id: "run-1", cwd: "/home/u/acme-api", job_id: "cron-0123", session_id: conversation, who: "deploy-check" };
	const made = questionFinding(call, { lane: conversation, sessionId: conversation, sessionFile: `/sessions/${conversation}.jsonl`, cap }, origin, "2026-11-20T00:00:00.000+00:00");
	const names = { ...ctx, loopName: (id: string) => (id === "cron-0123" ? "deploy-check" : undefined) };
	const card = inboxCard(entry({ ...made.entry, id: made.id, kind: "checkpoint" }), names)!;
	assert.deepEqual([card.headline, card.waits], ['The scheduled prompt "deploy-check" asks to run a command', 'the scheduled prompt "deploy-check" went on without it']);
	assert.deepEqual(cardLines(card, "  1. ", ""), ['  1. ⚑ The scheduled prompt "deploy-check" asks to run a command', `       command: ${command}`, "       why it asks: sudo invocation", '       waiting on: the scheduled prompt "deploy-check" went on without it', "       if you don't: it stays undone"]);
	const loop = questionFinding(call, { lane: "@cron-0123", sessionId: "sid-1", sessionFile: "/runs/sid-1.jsonl", cap }, { ...origin, session_id: undefined }, "2026-11-20T00:00:00.000+00:00");
	const loopCard = inboxCard(entry({ ...loop.entry, id: loop.id, kind: "checkpoint" }), names)!;
	assert.deepEqual([loopCard.headline, loopCard.waits], ["deploy-check asks to run a command", "deploy-check went on without it"], "a loop is no scheduled prompt in a conversation");
});

test("[6.4] a yes from the page to a question a conversation's turn asked says it runs in that conversation after the current turn, only while a window has the conversation open", () => {
	const conversation = "0199aaaa-0000-7000-8000-0000000000a1";
	const asked = entry({ status: "claimed", answered_by: "page", answer: { state: "pending", at: AT }, ask: { ...QUESTION, lane: conversation } });
	assert.equal(yesPageLine({ said: "Y1", finding: asked }, "deploy-check", true, true), "Approved. It runs in this conversation after the current turn.");
	assert.equal(yesPageLine({ said: "Y1", finding: asked }, "deploy-check", true, false), "Waiting to run", "a closed conversation has no current turn: the plain pending line");
	assert.equal(yesPageLine({ said: "Y1", finding: { ...asked, ask: QUESTION } }, "nightly", true, true), "Waiting to run", "a loop's question shows its state");
	assert.equal(answerLine(asked, undefined, undefined, true), "Approved. It runs in this conversation after the current turn.", "the card's line after the yes says the same, not Waiting to run");
	assert.equal(answerLine(asked), "Waiting to run", "and, while no window has the conversation open, the plain pending line");
	assert.equal(answerLine(asked, { waiting: "the job is disabled" } as Row, undefined, true), "Waiting to run: the job is disabled", "a row that says why it waits still says why");
	assert.equal(answerLine({ ...asked, ask: QUESTION }, undefined, undefined, true), "Waiting to run", "a loop's pending yes");
});

test("[6.4] /inbox claim on a question of this window's own conversation says it runs here after the current turn, with no card", () => {
	const conversation = "0199aaaa-0000-7000-8000-0000000000a1";
	const asked = entry({ status: "claimed", ask: { ...QUESTION, lane: conversation } });
	for (const background of [true, false]) assert.equal(yesTerminalLine({ said: "Y1", finding: asked }, '"deploy-check"', background, conversation), "approved: it runs in this conversation after the current turn, with this one command allowed.", `background: ${background}`);
	assert.equal(yesTerminalLine({ said: "Y1", finding: asked }, '"deploy-check"', true, "0199aaaa-0000-7000-8000-0000000000b2"), 'approved: "deploy-check" resumes the run that asked, with this one command allowed. A card comes here when it ends.', "another conversation's question");
	assert.equal(yesTerminalLine({ said: "Y1", finding: entry({ status: "claimed", ask: QUESTION }) }, "nightly", true, conversation), "approved: nightly resumes the run that asked, with this one command allowed. A card comes here when it ends.", "a loop's question");
});

test("[6.1] /inbox ends a new question with the two commands that answer it, by its number", () => {
	assert.equal(questionActions(1), "       /inbox claim 1 runs it once · /inbox dismiss 1 [reason] says no");
	assert.equal(questionActions(12), "       /inbox claim 12 runs it once · /inbox dismiss 12 [reason] says no");
});

test("[thread] a reply is listed under its root, numbered in that order; a root only in the inbox heads its replies unnumbered; a reply whose root is gone stands alone", () => {
	const id = (c: string) => `inb-${c.repeat(32)}`;
	const root = entry({ id: id("1"), kind: "checkpoint", text: "Run `x`? · waits: nightly went on without it", status: "claimed" });
	const listedRoot = entry({ id: id("2"), text: "Deploy failed. Logs attached." });
	const replyOfListed = entry({ id: id("3"), text: "Your yes to \"Deploy failed.\" could not be started (it could not be started).", re: id("2") });
	const replyOfClaimed = entry({ id: id("4"), text: "Your yes to `x` could not be started (the loop was removed). The command was not run.", re: id("1") });
	const orphan = entry({ id: id("5"), text: "Your yes to `y` was started and did not finish (it was stopped).", re: id("9") });
	const listed = [replyOfListed, replyOfClaimed, orphan, listedRoot];
	const rows = threads(listed, [root, ...listed]);
	assert.deepEqual(
		rows.map((r) => [r.entry.id.slice(4, 5), r.reply, r.listed]),
		[["1", false, false], ["4", true, true], ["5", false, true], ["2", false, true], ["3", true, true]],
	);
	assert.deepEqual(threadOrder(listed, [root, ...listed]).map((e) => e.id.slice(4, 5)), ["4", "5", "2", "3"], "the numbers /inbox claim resolves are the ones on screen");
	const lines = threadedLines(rows, (e, n) => [`  ${n === undefined ? `[${e.status}]` : `${n}.`} ${e.text.slice(0, 12)}`, "       more"]);
	assert.deepEqual(lines, [
		"  [claimed] Run `x`? · w",
		"       more",
		"      1. Your yes to ",
		"           more",
		"  2. Your yes to ",
		"       more",
		"  3. Deploy faile",
		"       more",
		"      4. Your yes to ",
		"           more",
	]);
	assert.deepEqual(threads([orphan], [orphan]).map((r) => [r.reply, r.listed]), [[false, true]], "a root that is gone: the reply is drawn on its own");
	assert.equal(inboxCard(replyOfClaimed, ctx)!.re, id("1"), "the card carries re, for the page");
	assert.equal("re" in inboxCard(root, ctx)!, false);
	const loopA = entry({ id: id("6"), re: id("7") });
	const loopB = entry({ id: id("7"), re: id("6") });
	assert.deepEqual(threads([loopA, loopB], [loopA, loopB]).map((r) => r.entry.id), [loopA.id, loopB.id], "a root that is itself a reply is no root: each stands alone");
});

test("who picks up a yes: the loop by its name, the check of the project, the job of a conversation, else the conversation", () => {
	const names = (id: string) => (id === "cron-0123" ? "night\u001b[31mly" : undefined);
	assert.equal(answerWho(entry({}), "@cron-0123", names), "nightly", "the loop's name, screened");
	assert.equal(answerWho(entry({}), "@cron-gone", names), "cron-gone", "a loop with no name in jobs.json: its id");
	assert.equal(answerWho(entry({ cwd: "/home/u/acme-api" }), "@check-0123456789abcdef", names), "the check of acme-api");
	assert.equal(answerWho(entry({ job_id: "cron-0123" }), "0199aaaa-0000-7000-8000-0000000000a1", names), "nightly", "a plain job's finding in its conversation");
	assert.equal(answerWho(entry({ job_id: undefined }), undefined, names), "its conversation");
});

test("a question's card is drawn from its ask: the command whole in its own field and on its own line, and the headline names who asks", () => {
	const command = "true · waits: your review · if not: nothing happens; git push --force origin main";
	const call = { tool: "bash", tool_call_id: "c1", command, input_sha256: "a".repeat(64), reason: "git push --force on main/master" };
	const asked = { lane: "@cron-0123" as const, sessionId: "sid-1", sessionFile: "/runs/sid-1.jsonl", cap: { cwd: "/p", model: null, thinking: null, tools: "session", builtinTools: "session", timeoutMs: 1000 } } as unknown as Parameters<typeof questionFinding>[1];
	const made = questionFinding(call, asked, { source: "cron:issue-triage", run_id: "run-1", cwd: "/home/u/acme-api", job_id: "cron-0123", who: "issue-triage" }, "2026-11-20T00:00:00.000+00:00");
	const card = inboxCard(entry({ ...made.entry, id: made.id, kind: "checkpoint" }), ctx)!;
	assert.deepEqual(
		{ kind: card.kind, headline: card.headline, question: card.question, waits: card.waits, ifNot: card.ifNot, body: card.body },
		{ kind: "decision", headline: "issue-triage asks to run a command", question: { tool: "bash", command, reason: "git push --force on main/master" }, waits: "issue-triage went on without it", ifNot: "it stays undone", body: undefined },
	);
	assert.deepEqual(cardLines(card, "  1. ", "  (acme-api)"), [
		"  1. ⚑ issue-triage asks to run a command  (acme-api)",
		`       command: ${command}`,
		"       why it asks: git push --force on main/master",
		"       waiting on: issue-triage went on without it",
		"       if you don't: it stays undone",
	]);
	const tool = inboxCard(entry({ ...made.entry, id: made.id, kind: "checkpoint", ask: { ...made.entry.ask!, title: "issue-triage asks to use write", call: { tool: "write", tool_call_id: "c2", input_sha256: "b".repeat(64), reason: "reads or writes pi-loops' own files" } } }), ctx)!;
	assert.deepEqual([tool.headline, tool.question], ["issue-triage asks to use write", { tool: "write", reason: "reads or writes pi-loops' own files" }], "a call with no command names its tool and no command");
	assert.deepEqual(inboxCard(entry({ kind: "checkpoint", text: "Close #412? · waits: the release · if not: it ships open" }), ctx)!.question, undefined, "a finding with no ask keeps today's card");
});
