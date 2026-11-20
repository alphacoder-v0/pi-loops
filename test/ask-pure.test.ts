import { test } from "node:test";
import assert from "node:assert/strict";
import {
	ANSWER_STEPS,
	BESIDE,
	PROTOCOL,
	WHY,
	type Answer,
	type AnswerClaim,
	type AnswerFrom,
	type AnswerStepId,
	type AnswerWrite,
	type Call,
	type Finding,
	type LaneFact,
	type MeetFacts,
	type StepInput,
	type StepRefusal,
	answerCap,
	answerRow,
	answerRowId,
	answerStatus,
	answerStep,
	askFindingId,
	askId,
	besideId,
	blockedCall,
	canonicalJson,
	closeOutcome,
	decideSay,
	inputHash,
	keptByRotation,
	laneFact,
	laneOf,
	meetAnswerRow,
	noRow,
	noRowId,
	questionFinding,
	readAskFields,
	repairRows,
} from "../src/ask.ts";
import { BACKOFF_MS } from "../src/backoff.ts";
import type { ClaimedRow, Row } from "../src/requests.ts";
import type { RunRecord } from "../src/store.ts";

const AT = "2026-11-20T10:00:00.000+08:00";
const LATER = "2026-11-20T11:00:00.000+08:00";
const SELF: Row["created_by"] = { pid: 4242, instance: "test", version: "0.24.3" };
const LOOP = "@cron-a1";
const CHECK = "@check-proj-1a2b3c4d";
const CONV = "01a1dce4-8ad1-77c0-89b0-475ccfeaf683";
const ID = `inb-${"a".repeat(32)}`;
const CLAIM: AnswerClaim = { id: "run-1", pid: 4242, started_at: AT };
const OTHER_CLAIM: AnswerClaim = { id: "run-2", pid: 4242, started_at: AT };
const CALL: Call = { tool: "bash", tool_call_id: "call-1", command: "git push --force origin main", input_sha256: inputHash({ command: "git push --force origin main" }), reason: "git push --force on main/master" };
const jobs = [
	{ id: "cron-a1", stateful: true },
	{ id: "cron-p1", stateful: false, sessionId: CONV },
	{ id: "cron-p2", stateful: false, sessionId: "@cron-x" },
];

function base(over: Partial<Finding> = {}): Finding {
	return { id: ID, created_at: AT, status: "new", kind: "checkpoint", source: "cron:cron-a1", run_id: "r1", cwd: "/proj", text: "ship it · waits: you · if not: it waits", verified: null, dismiss_reason: null, job_id: "cron-a1", lane: LOOP, transcript: "/s/a.jsonl", ...over };
}

function question(over: Partial<Finding> = {}): Finding {
	const ask = { kind: "call" as const, id: askId("/s/a.jsonl", CALL.tool_call_id), lane: LOOP, session_file: "/s/a.jsonl", title: "nightly asks to run a command", call: CALL, created_at: AT };
	return base({ ask, text: "Run `git push --force origin main`? (git push --force on main/master) · waits: nightly went on without it · if not: it stays undone", ...over });
}

const ARMS: Record<Exclude<AnswerFrom, "none">, Answer> = {
	pending: { state: "pending", at: AT },
	started: { state: "started", run: CLAIM, at: AT },
	done: { state: "done", run: CLAIM, at: AT },
	unfinished: { state: "unfinished", run: CLAIM, why: WHY.died, ending: "The command may or may not have run.", at: AT },
	not_run: { state: "not_run", why: WHY.loopRemoved, at: AT },
	cancelled: { state: "cancelled", at: AT },
};
const FROM: readonly (AnswerFrom | "unreadable")[] = ["none", "pending", "started", "done", "unfinished", "not_run", "cancelled", "unreadable"];

/** A finding at `state`: `new` with no answer for `none`, else a real yes with that answer. */
function at(state: AnswerFrom | "unreadable", over: Partial<Finding> = {}): Finding {
	if (state === "none") return question(over);
	const answer = state === "unreadable" ? { state: "unreadable" as const, raw: { state: "later" } } : ARMS[state];
	return question({ status: "claimed", answered_by: "terminal", claimed_by: CONV, answer, ...over });
}

const isWrite = (made: AnswerWrite | StepRefusal): made is AnswerWrite => !("refused" in made);
const ctx = { at: LATER, lane: LOOP };

/** The row of the table holds: only its `from` is accepted, the state written is one of its `to`, and its news comes with it. */
function holdsRow<K extends AnswerStepId>(step: K, input: StepInput[K]): AnswerWrite {
	const rule = ANSWER_STEPS[step];
	let accepted: AnswerWrite | undefined;
	for (const state of FROM) {
		const made = answerStep(step, at(state), input, ctx);
		if (state !== rule.from) {
			assert.ok(!isWrite(made), `${step} from ${state} is refused`);
			continue;
		}
		assert.ok(isWrite(made), `${step} from ${state} writes`);
		const to = made.set.answer?.state ?? "none";
		assert.ok((rule.to as readonly string[]).includes(to), `${step} writes ${to}, which its row allows`);
		const beside = to === "none" ? undefined : BESIDE[to];
		assert.equal(made.beside?.id, beside && besideId(ID, beside), `${step} files ${beside ?? "nothing"} beside ${to}`);
		accepted = made;
	}
	assert.deepEqual(answerStep(step, undefined, input, ctx), { refused: "missing" });
	assert.ok(accepted);
	return accepted;
}

test("[Y1] a yes from a person: a new finding becomes claimed and pending, and a finding with no lane gets one", () => {
	const write = holdsRow("Y1", { to: "pending", by: "page", claimed_by: CONV, lane: LOOP });
	assert.deepEqual(write.set, { status: "claimed", claimed_by: CONV, answered_by: "page", answer: { state: "pending", at: LATER } });
	const noLane = answerStep("Y1", question({ lane: undefined }), { to: "pending", by: "terminal", claimed_by: CONV, lane: LOOP }, ctx);
	assert.ok(isWrite(noLane) && noLane.set.lane === LOOP, "the lane is written on a finding that has none");
	assert.deepEqual(answerStep("Y1", at("pending"), { to: "pending", by: "page", claimed_by: CONV, lane: LOOP }, ctx), { refused: "already", status: "claimed", by: CONV });
	assert.deepEqual(answerStep("Y1", question({ status: "dismissed" }), { to: "pending", by: "page", claimed_by: CONV, lane: LOOP }, ctx), { refused: "already", status: "dismissed" });
});

test("[Y2] a yes with no lane: claimed, not_run and its news in one write", () => {
	const write = holdsRow("Y2", { to: "not_run", by: "terminal", claimed_by: CONV, why: WHY.loopRemoved });
	assert.deepEqual(write.set, { status: "claimed", claimed_by: CONV, answered_by: "terminal", answer: { state: "not_run", why: WHY.loopRemoved, at: LATER } });
	assert.equal(write.beside?.entry.kind, "news");
	assert.equal(write.beside?.entry.text, "Your yes to `git push --force origin main` could not be started (the loop was removed). The command was not run.");
	assert.equal(write.beside?.entry.lane, LOOP);
});

test("[YC] a yes from the command line: claimed by the cli, no answer and no news", () => {
	const write = holdsRow("YC", { to: "none" });
	assert.deepEqual(write.set, { status: "claimed", answered_by: "cli" });
	assert.equal(write.beside, undefined);
});

test("[N1] a no: dismissed with its capped reason and when, and the surface that said it", () => {
	const write = holdsRow("N1", { to: "none", by: "page", reason: "  too\n risky  " });
	assert.deepEqual(write.set, { status: "dismissed", answered_by: "page", dismissed_at: LATER, dismiss_reason: "too risky" });
	const long = answerStep("N1", question(), { to: "none", by: "cli", reason: "x".repeat(900) }, ctx);
	assert.ok(isWrite(long) && Array.from(long.set.dismiss_reason ?? "").length === 501, "the reason is capped at 500 characters and an ellipsis");
	const bare = answerStep("N1", question(), { to: "none", by: "terminal" }, ctx);
	assert.ok(isWrite(bare) && !("dismiss_reason" in bare.set), "a bare no writes no reason");
});

test("[E2] a queued yes whose loop was removed: not_run and the news, from pending only", () => {
	const write = holdsRow("E2", { to: "not_run" });
	assert.deepEqual(write.set, { answer: { state: "not_run", why: WHY.loopRemoved, at: LATER } });
});

test("[E3] a queued yes whose call is not proved: not_run with which check failed", () => {
	const write = holdsRow("E3", { to: "not_run", why: "the run that asked is gone" });
	assert.deepEqual(write.set, { answer: { state: "not_run", why: "the run that asked is gone", at: LATER } });
	assert.match(write.beside?.entry.text ?? "", /could not be started \(the run that asked is gone\)\. The command was not run\.$/);
});

test("[deleted-conversation] GONE: a queued yes in a deleted conversation is not_run with its news", () => {
	const write = holdsRow("GONE", { to: "not_run" });
	assert.deepEqual(write.set, { answer: { state: "not_run", why: WHY.conversationDeleted, at: LATER } });
});

test("[E4] a queued yes starts: started with the claim, and nothing beside it", () => {
	const write = holdsRow("E4", { to: "started", run: CLAIM });
	assert.deepEqual(write.set, { answer: { state: "started", run: CLAIM, at: LATER } });
	for (const by of [undefined, "cli"] as const) assert.deepEqual(answerStep("E4", at("pending", { answered_by: by }), { to: "started", run: CLAIM }, ctx), { refused: "not-a-real-yes" }, `answered_by ${by}`);
	assert.deepEqual(answerStep("E4", at("pending", { status: "dismissed" }), { to: "started", run: CLAIM }, ctx), { refused: "not-a-real-yes" });
	assert.deepEqual(answerStep("E4", at("unreadable"), { to: "started", run: CLAIM }, ctx), { refused: "state", state: "unreadable" });
});

test("[F1] the third attempt that could not start: not_run with its news", () => {
	const write = holdsRow("F1", { to: "not_run" });
	assert.deepEqual(write.set, { answer: { state: "not_run", why: WHY.notStarted, at: LATER } });
});

test("[C3] a run closes: done keeps the claim; unfinished keeps it, with why, the ending and the news outcome", () => {
	const done = holdsRow("C3", { to: "done" });
	assert.deepEqual(done.set, { answer: { state: "done", run: CLAIM, at: LATER } });
	const unfinished = holdsRow("C3", { to: "unfinished", why: WHY.stopped, ending: "The command was not run." });
	assert.deepEqual(unfinished.set, { answer: { state: "unfinished", run: CLAIM, why: WHY.stopped, ending: "The command was not run.", at: LATER } });
	assert.equal(unfinished.beside?.entry.text, "Your yes to `git push --force origin main` was started and did not finish (it was stopped). The command was not run.");
	const plain = answerStep("C3", at("started", { ask: undefined, kind: "news", text: "CI is red on main" }), { to: "unfinished", why: WHY.died }, ctx);
	assert.ok(isWrite(plain));
	assert.equal(plain.beside?.entry.text, 'Your yes to "CI is red on main" was started and did not finish (the process running it stopped).', "a finding that is no question has no ending");
});

test("[V1] a cancel: cancelled and the successor, open again with the same text and ask", () => {
	const write = holdsRow("V1", { to: "cancelled" });
	assert.deepEqual(write.set, { answer: { state: "cancelled", at: LATER } });
	const again = write.beside?.entry;
	const was = at("pending");
	assert.deepEqual(again, { source: was.source, run_id: was.run_id, cwd: was.cwd, job_id: was.job_id, text: was.text, kind: was.kind, transcript: was.transcript, ask: was.ask, lane: LOOP });
	assert.deepEqual(answerStep("V1", at("started"), { to: "cancelled" }, ctx), { refused: "state", state: "started" }, "it has already started");
	assert.deepEqual(answerStep("V1", at("done"), { to: "cancelled" }, ctx), { refused: "state", state: "done" }, "it has already ended");
});

test("each derived id is stable for one input and differs for another", () => {
	assert.match(askId("/s/a.jsonl", "c1"), /^ask-[0-9a-f]{32}$/);
	assert.equal(askId("/s/a.jsonl", "c1"), askId("/s/a.jsonl", "c1"));
	assert.notEqual(askId("/s/a.jsonl", "c1"), askId("/s/a.jsonl", "c2"));
	assert.notEqual(askId("/s/a.jsonl", "c1"), askId("/s/b.jsonl", "c1"));
	assert.match(askFindingId("ask-1"), /^inb-[0-9a-f]{32}$/);
	assert.equal(askFindingId("ask-1"), askFindingId("ask-1"));
	assert.notEqual(askFindingId("ask-1"), askFindingId("ask-2"));
	assert.equal(besideId(ID, "again"), besideId(ID, "again"));
	assert.equal(new Set([besideId(ID, "again"), besideId(ID, "outcome"), besideId(ID, "not-run"), besideId(`inb-${"b".repeat(32)}`, "again")]).size, 4);
	assert.equal(answerRowId(ID), `ans-${"a".repeat(32)}`, "the 32 hex of the finding's id");
	assert.equal(noRowId(ID), `no-${"a".repeat(32)}`);
	assert.match(answerRowId("hand written"), /^ans-[0-9a-f]{32}$/, "an id of another shape is hashed");
	assert.equal(answerRowId("hand written"), answerRowId("hand written"));
	assert.notEqual(answerRowId("hand written"), answerRowId("hand written 2"));
	assert.equal(inputHash({ a: 1, b: [1, { d: 2, c: undefined }] }), inputHash({ b: [1, { d: 2 }], a: 1 }), "key order and undefined members do not count");
	assert.notEqual(inputHash({ command: "ls" }), inputHash({ command: "ls -a" }));
	assert.equal(canonicalJson({ b: 1, a: [undefined, "x", null] }), '{"a":[null,"x",null],"b":1}');
});

test("[Q1] the finding of a blocked call: derived id, the ask, and a checkpoint text", () => {
	const made = questionFinding(CALL, { lane: LOOP, sessionFile: "/s/a.jsonl", cap: { cwd: "/proj", tools: ["bash"] } }, { source: "cron:cron-a1", run_id: "r1", cwd: "/proj", job_id: "cron-a1", who: "nightly" }, AT);
	assert.equal(made.id, askFindingId(askId("/s/a.jsonl", "call-1")));
	assert.equal(made.entry.text, "Run `git push --force origin main`? (git push --force on main/master) · waits: nightly went on without it · if not: it stays undone");
	assert.equal(made.entry.kind, "checkpoint");
	assert.equal(made.entry.transcript, "/s/a.jsonl");
	assert.equal(made.entry.lane, LOOP);
	assert.deepEqual(made.entry.ask, { kind: "call", id: askId("/s/a.jsonl", "call-1"), lane: LOOP, session_file: "/s/a.jsonl", title: "nightly asks to run a command", call: CALL, run: { cwd: "/proj", tools: ["bash"] }, created_at: AT });
	assert.equal(questionFinding(CALL, { lane: LOOP, sessionFile: "/s/a.jsonl", cap: { cwd: "/proj" } }, { source: "s", run_id: "r2", cwd: "/proj", who: "x" }, LATER).id, made.id, "one blocked call, one finding");
});

test("laneOf: a finding's lane, else its job's lane as jobs.json has it now, else none", () => {
	assert.equal(laneOf(base({ lane: CHECK, job_id: "cron-a1" }), jobs), CHECK, "the finding's lane first");
	assert.equal(laneOf(base({ lane: undefined, job_id: "cron-a1" }), jobs), "@cron-a1", "a loop's job");
	assert.equal(laneOf(base({ lane: undefined, job_id: "cron-p1" }), jobs), CONV, "a plain job whose sessionId is a conversation");
	assert.equal(laneOf(base({ lane: undefined, job_id: "cron-p2" }), jobs), undefined, "a plain job whose sessionId is no conversation");
	assert.equal(laneOf(base({ lane: undefined, job_id: "cron-gone" }), jobs), undefined, "a job that is gone");
	assert.equal(laneOf(base({ lane: undefined, job_id: undefined }), jobs), undefined, "neither");
	assert.equal(laneOf(base({ lane: "../x", job_id: "cron-a1" }), jobs), "@cron-a1", "a lane that is no lane id is passed over");
});

test("laneFact: a lane that is there, a removed loop, a deleted conversation, and nowhere", () => {
	const there = (id: string) => id === CONV;
	assert.deepEqual(laneFact(base(), jobs, there), { there: true, lane: LOOP });
	assert.deepEqual(laneFact(base({ lane: "@cron-gone" }), jobs, there), { there: false, lane: "@cron-gone", why: WHY.loopRemoved });
	assert.deepEqual(laneFact(base({ lane: CONV }), jobs, () => false), { there: false, lane: CONV, why: WHY.conversationDeleted });
	assert.deepEqual(laneFact(base({ lane: CHECK }), [], () => false), { there: true, lane: CHECK }, "a check lane is always there");
	assert.deepEqual(laneFact(base({ lane: undefined, job_id: undefined }), jobs, there), { there: false, why: WHY.nowhere });
});

test("answerStatus for every state, read from the finding; a pending answer says why its row waits", () => {
	const waiting = { ...answerRow(at("pending"), LOOP, AT, SELF), waiting: "its job is disabled" };
	assert.deepEqual(answerStatus(at("pending"), undefined), { status: "pending" });
	assert.deepEqual(answerStatus(at("pending"), waiting), { status: "pending", why: "its job is disabled" });
	assert.deepEqual(answerStatus(at("started"), waiting), { status: "started" });
	assert.deepEqual(answerStatus(at("done"), undefined), { status: "done" });
	assert.deepEqual(answerStatus(at("unfinished"), undefined), { status: "unfinished", why: WHY.died, ending: "The command may or may not have run." });
	assert.deepEqual(answerStatus(at("not_run"), undefined), { status: "not_run", why: WHY.loopRemoved });
	assert.deepEqual(answerStatus(at("cancelled"), undefined), { status: "cancelled" });
	assert.deepEqual(answerStatus(question({ status: "claimed", answered_by: "cli" }), undefined), { status: "cli" });
	assert.equal(answerStatus(question({ status: "claimed" }), undefined), undefined, "a claim 0.24.2 made");
	assert.equal(answerStatus(question(), undefined), undefined, "nobody answered");
	assert.equal(answerStatus(question({ status: "dismissed", answered_by: "cli" }), undefined), undefined, "a no from the command line is no claim");
	assert.equal(answerStatus(at("unreadable"), undefined), undefined);
});

const fact: LaneFact = { there: true, lane: LOOP };
function facts(over: Partial<MeetFacts> = {}): MeetFacts {
	return { lane: fact, ownProject: true, proof: { ask: askId("/s/a.jsonl", CALL.tool_call_id), check: "there" }, live: false, at: LATER, ...over };
}
const queued = (finding: Finding = at("pending")): Row => answerRow(finding, LOOP, AT, SELF);
const claimed = (run: AnswerClaim = CLAIM, attempts = 0): ClaimedRow => ({ ...queued(), kind: "input", run, attempts });

test("[E1] a row that means nothing is stale: missing, not a real yes, wrong id or lane, unreadable, not pending, a claim that is not answer.run", () => {
	const stale = (row: Row, finding: Finding | undefined, f: MeetFacts = facts()) => assert.equal(meetAnswerRow(row, finding, f).case, "E1");
	stale(queued(), undefined);
	stale(queued(), at("pending", { status: "new" }));
	stale(queued(), at("pending", { status: "dismissed" }));
	stale(queued(), at("pending", { answered_by: "cli" }));
	stale({ ...queued(), id: `ans-${"b".repeat(32)}` }, at("pending"));
	stale({ ...queued(), lane: "@cron-other" }, at("pending"));
	stale(queued(), at("pending"), facts({ ownProject: false }));
	stale(queued(), at("unreadable"));
	for (const state of ["started", "done", "unfinished", "not_run", "cancelled"] as const) stale(queued(), at(state));
	stale(claimed(OTHER_CLAIM), at("started"), facts({ live: true }));
	stale(claimed(OTHER_CLAIM), at("done"));
	stale(claimed(OTHER_CLAIM), at("unfinished"));
	stale(queued(at("none")), question({ status: "claimed", answered_by: "cli" }), facts());
});

test("[E2] a queued yes in a removed loop's lane is not_run, also while the lane is blocked", () => {
	const met = meetAnswerRow(queued(), at("pending"), facts({ lane: { there: false, lane: LOOP, why: WHY.loopRemoved }, blocked: "the loop is disabled" }));
	assert.equal(met.case, "E2");
	assert.ok(met.case === "E2" && met.write.set.answer?.state === "not_run" && met.write.beside?.entry.kind === "news");
});

test("[E3] a question whose call is not proved is not_run; each check gives its reason and nothing runs", () => {
	for (const check of ["file-gone", "outside", "no-call", "another-tool", "another-input", "no-error-result"] as const) {
		const met = meetAnswerRow(queued(), at("pending"), facts({ proof: { ask: askId("/s/a.jsonl", CALL.tool_call_id), check } }));
		assert.ok(met.case === "E3" && met.check === check, check);
		assert.ok(met.case === "E3" && met.write.set.answer?.state === "not_run");
	}
	assert.equal(meetAnswerRow(queued(), at("pending"), facts({ proof: { ask: "ask-other", check: "there" } })).case, "hold", "a proof of another ask proves nothing");
});

test("[E4] a queued yes starts: a grant for a question, none for a plain finding; a disabled loop holds it", () => {
	const met = meetAnswerRow(queued(), at("pending"), facts());
	assert.ok(met.case === "E4" && met.grant?.call === CALL && met.grant.finding === ID);
	const plain = at("pending", { ask: undefined });
	assert.deepEqual(meetAnswerRow(queued(plain), plain, facts({ proof: undefined })), { case: "E4" });
	assert.deepEqual(meetAnswerRow(queued(), at("pending"), facts({ blocked: "the loop is disabled" })), { case: "hold", why: "the loop is disabled" });
	assert.equal(meetAnswerRow(queued(), at("pending"), facts({ blocked: "the loop is disabled", proof: { ask: askId("/s/a.jsonl", CALL.tool_call_id), check: "no-call" } })).case, "E3", "a blocked lane holds E4 only");
});

test("[W1] a live claim waits beside pending, started and a final state, before F1", () => {
	assert.deepEqual(meetAnswerRow(claimed(), at("pending"), facts({ live: true })), { case: "W1" });
	assert.deepEqual(meetAnswerRow(claimed(), at("started"), facts({ live: true })), { case: "W1" });
	assert.deepEqual(meetAnswerRow(claimed(), at("done"), facts({ live: true })), { case: "W1" });
	assert.deepEqual(meetAnswerRow(claimed(), at("not_run"), facts({ live: true })), { case: "W1" });
});

test("[F1] a dead claim beside pending counts an attempt with the backoff; the third is not_run", () => {
	assert.deepEqual(meetAnswerRow(claimed(CLAIM, 0), at("pending"), facts()), { case: "F1", attempts: 1, waitMs: BACKOFF_MS[0] });
	assert.deepEqual(meetAnswerRow(claimed(CLAIM, 1), at("pending"), facts()), { case: "F1", attempts: 2, waitMs: BACKOFF_MS[1] });
	const dead = meetAnswerRow(claimed(CLAIM, 2), at("pending"), facts());
	assert.ok(dead.case === "F1-dead" && dead.write.set.answer?.state === "not_run" && dead.write.set.answer.why === WHY.notStarted);
});

test("[F2] a dead claim beside started with that claim closes the run", () => {
	assert.deepEqual(meetAnswerRow(claimed(), at("started"), facts()), { case: "F2" });
});

test("[F3] [C2] a dead claim beside a final state: run_end only for an answer with a claim", () => {
	assert.deepEqual(meetAnswerRow(claimed(), at("done"), facts()), { case: "F3", runEnd: true });
	assert.deepEqual(meetAnswerRow(claimed(), at("unfinished"), facts()), { case: "F3", runEnd: true });
	assert.deepEqual(meetAnswerRow(claimed(), at("not_run"), facts()), { case: "F3", runEnd: false });
	assert.deepEqual(meetAnswerRow(claimed(), at("cancelled"), facts()), { case: "F3", runEnd: false });
});

test("[deleted-conversation] a queued yes in a deleted conversation's lane is GONE, before E3", () => {
	const gone: LaneFact = { there: false, lane: CONV, why: WHY.conversationDeleted };
	const finding = at("pending", { lane: CONV });
	const met = meetAnswerRow({ ...queued(finding), lane: CONV }, finding, facts({ lane: gone, proof: { ask: "x", check: "file-gone" } }));
	assert.ok(met.case === "GONE" && met.write.set.answer?.state === "not_run" && met.write.set.answer.why === WHY.conversationDeleted);
});

test("[deleted-conversation-blocked-lane] the deleted conversation applies while the lane is blocked", () => {
	const gone: LaneFact = { there: false, lane: CONV, why: WHY.conversationDeleted };
	const finding = at("pending", { lane: CONV });
	assert.equal(meetAnswerRow({ ...queued(finding), lane: CONV }, finding, facts({ lane: gone, blocked: "a window holds the conversation" })).case, "GONE");
});

test("[H1] repairRows puts back a missing row for pending and started, and nothing else", () => {
	const open = [
		at("pending", { id: `inb-${"1".repeat(32)}` }),
		at("started", { id: `inb-${"2".repeat(32)}` }),
		at("pending", { id: `inb-${"3".repeat(32)}`, lane: "@cron-gone" }),
	];
	const closed = (["none", "done", "unfinished", "not_run", "cancelled", "unreadable"] as const).map((s, i) => at(s, { id: `inb-${String(i + 4).repeat(32)}` }));
	const there = at("pending", { id: `inb-${"f".repeat(32)}` });
	const lanes = new Map<string, readonly Row[]>([
		[LOOP, [{ ...queued(there), run: OTHER_CLAIM, kind: "input" } as ClaimedRow]],
		["@cron-gone", []],
	]);
	const rows = repairRows([...open, ...closed, there, at("pending", { id: `inb-${"9".repeat(32)}`, lane: "@cron-elsewhere" })], lanes, { at: LATER, self: SELF });
	assert.deepEqual(rows.map((r) => r.id), [answerRowId(open[0].id), answerRowId(open[1].id), answerRowId(open[2].id)], "the row that is there is left as it is, whatever its run");
	assert.equal(rows[0].run, undefined, "pending: an unclaimed row");
	assert.deepEqual(rows[1].run, CLAIM, "started: the claim the finding records");
	assert.equal(rows[2].lane, "@cron-gone", "the lane is read from the finding, with no job");
});

test("answerRow and noRow: the payload names the finding, and a no tells only a conversation", () => {
	const row = answerRow(at("pending"), LOOP, AT, SELF);
	assert.deepEqual(row, { v: 3, id: answerRowId(ID), lane: LOOP, kind: "input", source: "answer", mode: "unattended", wake: "turn", payload: { text: `[Trigger ${answerRowId(ID)}] ${at("pending").text}`, cwd: "/proj", requested_by: CONV, finding: ID }, created_at: AT, created_by: SELF, attempts: 0 } as unknown as Row);
	assert.equal(noRow(question(), AT, SELF), undefined, "a loop reads the no under [reported]");
	const asked = question();
	const told = noRow(question({ ask: { ...asked.ask!, lane: CONV } }), AT, SELF);
	assert.ok(told && told.id === noRowId(ID) && told.lane === CONV && told.mode === "none" && told.wake === "append");
});

test("decideSay: a yes is Y1 with its row, Y2 with no lane, YC from the cli; a no is N1", () => {
	const said = decideSay(question({ lane: undefined }), "yes", { by: "page", session: CONV }, fact, { at: LATER, self: SELF });
	assert.ok(said.step === "Y1" && said.write.set.lane === LOOP && said.row.id === answerRowId(ID) && said.row.payload?.requested_by === CONV);
	const nowhere = decideSay(question(), "yes", { by: "terminal", session: CONV }, { there: false, why: WHY.nowhere }, { at: LATER, self: SELF });
	assert.ok(nowhere.step === "Y2" && nowhere.why === WHY.nowhere);
	assert.equal(decideSay(question(), "yes", { by: "cli" }, fact, { at: LATER, self: SELF }).step, "YC");
	const no = decideSay(question(), "no", { by: "page", session: CONV }, fact, { at: LATER, self: SELF, reason: "risky" });
	assert.ok(no.step === "N1" && no.row === undefined && no.write.set.dismiss_reason === "risky");
	assert.deepEqual(decideSay(at("pending"), "yes", { by: "page", session: CONV }, fact, { at: LATER, self: SELF }), { step: "none", refusal: { refused: "already", status: "claimed", by: CONV } });
});

test("blockedCall: one result per check over a session file's entries", () => {
	const callEntry = (name: string, args: unknown) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name, arguments: args }] } });
	const result = (isError: boolean) => ({ type: "message", message: { role: "toolResult", toolCallId: "call-1", isError } });
	const args = { command: "git push --force origin main" };
	assert.equal(blockedCall([callEntry("bash", args), result(true)], CALL), "there");
	assert.equal(blockedCall([result(true)], CALL), "no-call");
	assert.equal(blockedCall([callEntry("read", args), result(true)], CALL), "another-tool");
	assert.equal(blockedCall([callEntry("bash", { command: "ls" }), result(true)], CALL), "another-input");
	assert.equal(blockedCall([callEntry("bash", args), result(false)], CALL), "no-error-result");
	assert.equal(blockedCall([result(true), callEntry("bash", args)], CALL), "no-error-result", "the result follows the call");
});

test("closeOutcome: done needs a run that ended ok and, for a question, a used grant; each ending", () => {
	const rec = (over: Partial<RunRecord> & { grant_used?: boolean } = {}) => ({ runId: "run-1", jobId: "cron-a1", stateful: true, cwd: "/proj", pid: 1, startedAt: AT, finishedAt: LATER, ok: true, findings: 0, droppedFindings: 0, stateUpdated: false, ...over });
	const proved = { check: "there" as const, prompt: false };
	assert.deepEqual(closeOutcome(at("started"), rec({ grant_used: true }), proved), { to: "done" });
	assert.deepEqual(closeOutcome(at("started"), rec(), proved), { to: "unfinished", why: WHY.unused, ending: "The command was not run." });
	assert.deepEqual(closeOutcome(at("started"), rec({ aborted: true }), { check: "there", prompt: true }), { to: "unfinished", why: WHY.stopped, ending: "The command may or may not have run." });
	assert.deepEqual(closeOutcome(at("started"), rec({ ok: false, interrupted: true }), undefined), { to: "unfinished", why: WHY.died, ending: "The command may or may not have run." });
	assert.deepEqual(closeOutcome(at("started"), rec({ ok: false, error: "model\nerror" }), { check: "file-gone", prompt: false }), { to: "unfinished", why: "model error", ending: "The command may or may not have run." });
	const plain = at("started", { ask: undefined });
	assert.deepEqual(closeOutcome(plain, rec(), undefined), { to: "done" });
	assert.deepEqual(closeOutcome(plain, rec({ aborted: true }), undefined), { to: "unfinished", why: WHY.stopped });
});

test("readAskFields: a strict ask and answered_by; an answer it cannot read is kept raw", () => {
	const ask = question().ask;
	assert.deepEqual(readAskFields({ ask, answered_by: "page", answer: { state: "pending", at: AT } }), { ask, answered_by: "page", answer: { state: "pending", at: AT } });
	assert.deepEqual(readAskFields({ ask: { ...ask, call: { ...CALL, tool: 5 } }, answered_by: "robot" }), {});
	assert.deepEqual(readAskFields({ ask: { ...ask, run: { cwd: "/p", tools: "bash" } } }), {}, "a cap of the wrong shape is no ask");
	for (const raw of [{ state: "later", at: AT }, { state: "started", at: AT }, { state: "not_run", at: AT }, null]) assert.deepEqual(readAskFields({ answer: raw }), { answer: { state: "unreadable", raw } });
	assert.deepEqual(readAskFields({ answer: ARMS.unfinished }), { answer: ARMS.unfinished });
});

test("answerCap: the job now, narrowed by the asking turn; the model is the job's", () => {
	assert.deepEqual(answerCap({ cwd: "/now", tools: ["bash", "read"], timeoutMs: 60_000, model: "a/b" }, { cwd: "/then", tools: ["bash", "edit"], timeout_ms: 30_000, model: "c/d" }), { cwd: "/now", model: "a/b", tools: ["bash"], timeout_ms: 30_000 });
	assert.deepEqual(answerCap({ cwd: "/now" }, { cwd: "/then", builtin_tools: ["read"] }), { cwd: "/now", builtin_tools: ["read"] });
	assert.deepEqual(answerCap({ cwd: "/now" }, undefined), { cwd: "/now" });
});

test("keptByRotation: new, open, unreadable, and a no that still holds", () => {
	const now = Date.parse(LATER);
	assert.equal(keptByRotation(question(), now), true);
	assert.equal(keptByRotation(at("pending"), now), true);
	assert.equal(keptByRotation(at("started"), now), true);
	assert.equal(keptByRotation(at("unreadable"), now), true);
	assert.equal(keptByRotation(at("done"), now), false);
	assert.equal(keptByRotation(question({ status: "dismissed", dismissed_at: AT }), now), true);
	assert.equal(keptByRotation(question({ status: "dismissed", dismissed_at: "2026-10-01T10:00:00.000+08:00" }), now), false);
	assert.equal(keptByRotation(base({ ask: undefined, status: "dismissed", dismissed_at: AT }), now), false);
});

test("[C1] [C3] [C4] [V2] [removed-job] [K1] [K2] PROTOCOL orders the writes of each transition", () => {
	const ids = (key: keyof typeof PROTOCOL) => PROTOCOL[key].map((w) => w.id);
	assert.deepEqual(ids("C"), ["C1", "C2", "C3", "C4"]);
	assert.deepEqual(ids("F2"), ids("C"), "F2 is the closing");
	assert.deepEqual(ids("E4"), ["E4a", "E4b"]);
	assert.deepEqual(ids("V"), ["V1", "V2", "V2.audit"]);
	assert.deepEqual(ids("removed-job"), ["removed-job"]);
	assert.deepEqual(ids("K2"), ["K2", "K2.row", "K2.audit"]);
	assert.deepEqual(ids("K1"), ["K1", "K1.audit"]);
	for (const [key, writes] of Object.entries(PROTOCOL)) {
		for (const w of writes) if (w.write === "finding") assert.ok(w.lock === "inbox" || w.lock === "inbox+lane", `${key}: a rewrite of the inbox holds inbox.lock`);
	}
});
