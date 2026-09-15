import { test } from "node:test";
import assert from "node:assert/strict";
import { composeLoopPrompt, DISMISSED_OPEN, DISMISSED_PER_RUN, extractTagAll, extractTagBlock, INBOX_TAGS_PER_RUN, jobTextOf, LOOP_STATE_CLOSE, LOOP_STATE_MAX_CHARS, parseRunOutput, stripProtocolTags } from "../src/protocol.ts";

test("tag extraction: present, absent, truncated, capped", () => {
	const text = "did work\n<inbox>finding one</inbox>\nmore\n<inbox>finding two</inbox>\n<loop-state>seen: a,b</loop-state>";
	assert.equal(extractTagBlock(text, "loop-state"), "seen: a,b");
	assert.deepEqual(extractTagAll(text, "inbox", 16), ["finding one", "finding two"]);
	assert.equal(extractTagBlock("no tags here", "loop-state"), undefined);
	assert.equal(extractTagBlock("x <loop-state>cut off", "loop-state"), undefined);
	assert.deepEqual(extractTagAll("<inbox></inbox><inbox>  real </inbox>", "inbox", 16), ["real"]);
	const many = Array.from({ length: 20 }, (_, i) => `<inbox>f${i}</inbox>`).join("");
	assert.equal(extractTagAll(many, "inbox", 16).length, 16);
	// last loop-state wins
	assert.equal(extractTagBlock("<loop-state>old</loop-state> <loop-state>new</loop-state>", "loop-state"), "new");
});

test("parseRunOutput caps and counts drops", () => {
	const many = Array.from({ length: 20 }, (_, i) => `<inbox>f${i}</inbox>`).join("");
	const parsed = parseRunOutput(`${many}<loop-state>${"x".repeat(5000)}</loop-state>`);
	assert.equal(parsed.findings.length, INBOX_TAGS_PER_RUN);
	assert.equal(parsed.droppedFindings, 4);
	assert.equal(Array.from(parsed.state!).length, LOOP_STATE_MAX_CHARS + 1); // + ellipsis
	const quiet = parseRunOutput("all good <loop-state>baseline: 3</loop-state>");
	assert.deepEqual(quiet.findings, []);
	assert.equal(quiet.state, "baseline: 3");
	assert.equal(parseRunOutput("").state, undefined);
	// multi-line finding collapses to one line
	assert.deepEqual(parseRunOutput("<inbox>a\n  b</inbox>").findings, ["a b"]);
});

test("composeLoopPrompt injects previous state and protocol", () => {
	const p = composeLoopPrompt("check the issues", "baseline: #1 #2", { name: "issues" });
	assert.ok(p.includes("[loop-state]"));
	assert.ok(p.includes("baseline: #1 #2"));
	assert.ok(p.includes("check the issues"));
	assert.ok(p.includes("<loop-state>"));
	assert.ok(p.includes("<inbox>"));
	assert.ok(composeLoopPrompt("check", undefined).includes("(first run)"));
});

test("stripProtocolTags", () => {
	assert.equal(stripProtocolTags("summary\n\n<inbox>x</inbox>\n\n<loop-state>y</loop-state>\n"), "summary");
	assert.equal(stripProtocolTags("plain\n\ntext"), "plain\n\ntext");
});

test("checker prompt and verdict parsing (maker/checker)", async () => {
	const { composeCheckerPrompt, parseCheckerOutput } = await import("../src/protocol.ts");
	const p = composeCheckerPrompt("watch issues", "seen: #1", ["issue #9 is stuck", "PR #3 needs rebase"], { name: "issues" });
	assert.ok(p.includes("You are the checker for a recurring loop"));
	assert.ok(p.includes("1. issue #9 is stuck") && p.includes("2. PR #3 needs rebase"));
	const v = parseCheckerOutput('checked.\n<verdict n="1">keep — still open, last comment 2d ago</verdict>\n<rewrite n="1">issue #9 stuck for 2 days, no assignee</rewrite>\n<verdict n=2>drop: PR #3 was rebased an hour ago</verdict>\n<verdict n="9">keep</verdict><verdict n="3">maybe</verdict>');
	assert.equal(v.get(1)?.verdict, "keep");
	assert.equal(v.get(1)?.reason, "still open, last comment 2d ago");
	assert.equal(v.get(1)?.rewrite, "issue #9 stuck for 2 days, no assignee");
	assert.equal(v.get(2)?.verdict, "drop");
	assert.equal(v.get(2)?.reason, "PR #3 was rebased an hour ago");
	assert.equal(v.get(9)?.reason, "");
	assert.equal(v.get(3), undefined, "unknown verdict word ignored");
});

test("a loop is told how to write a time, because the clock its notes are read on may have changed", () => {
	// The notes this prompt asks for hold watermarks, and a watermark is a time the model writes in
	// whatever shape it likes. A job with no `host` runs on any machine sharing the $HOME — which
	// `/cron set <ref> --host -` asks for — so run N can write "checked up to 20:00" in Shanghai and
	// run N+1 read it in New York.
	const p = composeLoopPrompt("check the issues", undefined, { name: "issues", runAt: "2026-09-11 20:37 +08:00" });
	assert.match(p, /current run started 2026-09-11 20:37 \+08:00/, "the run time carries its offset");
	assert.match(p, /write any time in your notes with its offset/, "and the notes are asked for the same");
	// The protocol block is quoted verbatim; the addition lives in the line above it, which is ours.
	assert.match(p, /^Output protocol \(mandatory\):$/m);
	assert.match(p, /- End your reply with <loop-state>notes for the next run<\/loop-state>/);
});

test("a reason given with /inbox dismiss is shown to the next run, between the notes and the job text, and the transcript view leaves it out of the job text", () => {
	const dismissed = [
		{ text: "TODO.md: new unchecked item — cache the /search results", reason: "that item is mine, ignore it" },
		{ text: "second   finding", reason: "already\nfixed on main" },
	];
	const p = composeLoopPrompt("check the issues", "baseline: #1", { name: "issues", dismissed });
	const stateAt = p.indexOf(LOOP_STATE_CLOSE);
	const feedbackAt = p.indexOf(DISMISSED_OPEN);
	const jobAt = p.indexOf("check the issues");
	assert.ok(stateAt < feedbackAt && feedbackAt < jobAt, "notes, then the person's words, then the task");
	assert.ok(p.includes('- "TODO.md: new unchecked item — cache the /search results" — that item is mine, ignore it'));
	assert.ok(p.includes('- "second finding" — already fixed on main'), "whitespace collapsed to one line each");
	assert.ok(p.includes("do not report these again unless what they describe has changed"));
	assert.equal(jobTextOf(p).trim(), "check the issues", "the transcript shows the job text, not the feedback");
	assert.equal(jobTextOf(composeLoopPrompt("check the issues", undefined)).trim(), "check the issues");
	// No feedback, no block — the prompt is what it was.
	assert.ok(!composeLoopPrompt("check", undefined, { dismissed: [] }).includes(DISMISSED_OPEN));
	// More than the cap: the newest survive.
	const many = Array.from({ length: DISMISSED_PER_RUN + 3 }, (_, i) => ({ text: `f${i}`, reason: `r${i}` }));
	const capped = composeLoopPrompt("check", undefined, { dismissed: many });
	assert.ok(!capped.includes('"f0"') && !capped.includes('"f2"') && capped.includes('"f3"') && capped.includes(`"f${DISMISSED_PER_RUN + 2}"`));
});
