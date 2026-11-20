import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { FINDING_FIELDS, Inbox, type InboxEntry, findingId, resolveInboxRef, UNDER_INBOX_LOCK } from "../src/inbox.ts";
import { type AnswerWrite, answerStep } from "../src/ask.ts";
import { CLAIM_QUEUE_LOCK } from "../src/engine.ts";

test("listNew puts checkpoints first and keeps file order inside each group; list() is the file order", async () => {
	const inbox = new Inbox(tmp("pi-loops-inbox-"));
	const base = { source: "cron:demo", run_id: "r", job_id: "j", cwd: "/p" };
	await inbox.append({ ...base, text: "PR #20: merged" });
	await inbox.append({ ...base, text: "#14 brief posted · waits: your label · if not: stays needs-triage", kind: "checkpoint" });
	await inbox.append({ ...base, text: "CI red on main" });
	await inbox.append({ ...base, text: "promote research/007 · waits: your merge · if not: the branch stays", kind: "checkpoint" });
	assert.deepEqual(inbox.listNew().map((e) => e.text.slice(0, 8)), ["#14 brie", "promote ", "PR #20: ", "CI red o"]);
	assert.deepEqual(inbox.list().map((e) => e.text.slice(0, 8)), ["PR #20: ", "#14 brie", "CI red o", "promote "]);
	assert.deepEqual(inbox.listNew().map((e) => e.kind), ["checkpoint", "checkpoint", "news", "news"]);
	assert.equal(inbox.newCount(), 4);
	assert.equal(inbox.decisionCount(), 2);
	// Claimed and dismissed entries leave the triage order but keep their kind in the history.
	await inbox.decide(inbox.listNew()[0].id, "claimed", { by: "s1" });
	assert.equal(inbox.decisionCount(), 1);
	assert.equal(inbox.list().find((e) => e.status === "claimed")?.kind, "checkpoint");
});

test("an entry written before kind existed reads as news, and a kind that is not the word is ignored", () => {
	const dir = tmp("pi-loops-inbox-");
	const inbox = new Inbox(dir);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		inbox.file,
		[
			JSON.stringify({ id: "inb-1", created_at: "2026-09-15T00:00:00.000+00:00", source: "cron:old", text: "old finding · waits: you", trace_id: "r", status: "new", job_id: "j", cwd: "/p" }),
			JSON.stringify({ id: "inb-2", created_at: "2026-09-15T00:00:01.000+00:00", source: "cron:odd", text: "odd", trace_id: "r", status: "new", job_id: "j", cwd: "/p", kind: "urgent" }),
		].join("\n") + "\n",
	);
	assert.deepEqual(inbox.listNew().map((e) => e.kind), ["news", "news"], "the kind is what the run wrote at append time, never re-read from the text");
	assert.equal(inbox.decisionCount(), 0);
});

test("a loop's finding names the session that created the loop and its transcript", async () => {
	const inbox = new Inbox(tmp("pi-loops-inbox-"));
	const entry = await inbox.append({ source: "cron:demo", text: "finding", run_id: "r", job_id: "j", cwd: "/p", session_id: "session-a", transcript: "/loops/sessions/j/run.jsonl" });
	assert.equal(entry.session_id, "session-a");
	assert.equal(entry.transcript, "/loops/sessions/j/run.jsonl");
	assert.equal(inbox.list()[0].session_id, "session-a");
	assert.equal(inbox.list()[0].transcript, "/loops/sessions/j/run.jsonl");
});

test("newFor filters by status, session and time", async () => {
	const inbox = new Inbox(tmp("pi-loops-inbox-"));
	const base = { source: "cron:demo", run_id: "r", job_id: "j", cwd: "/p", session_id: "s" };
	const old = await inbox.append({ ...base, text: "old" });
	const oldAt = old.created_at;
	const target = await inbox.append({ ...base, text: "target" });
	target.created_at = new Date(Date.parse(oldAt) + 1000).toISOString();
	fs.writeFileSync(inbox.file, inbox.list().map((entry, i) => JSON.stringify(i === 1 ? { ...entry, created_at: target.created_at } : entry)).join("\n") + "\n");
	const other = await inbox.append({ ...base, session_id: "other", text: "other" });
	await inbox.decide(other.id, "claimed");
	assert.deepEqual(inbox.newFor("s", target.created_at).map((e) => e.text), []);
	assert.deepEqual(inbox.newFor("s", old.created_at).map((e) => e.text), ["target"]);
	assert.deepEqual(inbox.newFor("s").map((e) => e.text), ["old", "target"]);
});

test("resolveInboxRef takes a number only from a caller that printed a numbered list", () => {
	const entry = (id: string): InboxEntry => ({ id, created_at: "2026-09-16T09:00:00.000+08:00", status: "new", kind: "news", source: "cron:demo", run_id: "run-1", cwd: "/p", text: id, verified: null, dismiss_reason: null });
	const entries = [entry("inb-aa11"), entry("inb-aa22"), entry("inb-bb33")];
	// The default is the contract's rule: a finding is named by its id, never by a number.
	assert.equal(resolveInboxRef(entries, "1"), undefined);
	assert.equal(resolveInboxRef(entries, "1", { ordinals: false }), undefined);
	assert.equal(resolveInboxRef(entries, "1", { ordinals: true })?.id, "inb-aa11", "the position in the list the caller printed");
	// An id and a unique prefix resolve either way; an ambiguous prefix resolves to nothing.
	assert.equal(resolveInboxRef(entries, "inb-bb33")?.id, "inb-bb33");
	assert.equal(resolveInboxRef(entries, "inb-bb33", { ordinals: true })?.id, "inb-bb33");
	assert.equal(resolveInboxRef(entries, "inb-b")?.id, "inb-bb33");
	assert.equal(resolveInboxRef(entries, "inb-b", { ordinals: true })?.id, "inb-bb33");
	assert.equal(resolveInboxRef(entries, "inb-aa"), undefined);
	assert.equal(resolveInboxRef(entries, "inb-aa", { ordinals: true }), undefined);
});

test("decide changes a new finding once and refuses one already decided", async () => {
	const inbox = new Inbox(tmp("pi-loops-inbox-"));
	const base = { source: "cron:demo", run_id: "r", job_id: "j", cwd: "/p" };
	const a = await inbox.append({ ...base, text: "a" });
	const b = await inbox.append({ ...base, text: "b" });
	const claimed = await inbox.decide(a.id, "claimed", { by: "session-1", reason: "a claim carries no reason" });
	assert.ok("ok" in claimed);
	assert.equal(claimed.ok.status, "claimed");
	assert.equal(claimed.ok.claimed_by, "session-1");
	assert.equal(claimed.ok.dismiss_reason, null, "only a dismiss records a reason");
	assert.deepEqual(await inbox.decide(a.id, "claimed", { by: "session-2" }), { already: "claimed", by: "session-1" }, "a second claim is refused, and told who won");
	assert.deepEqual(await inbox.decide(a.id, "dismissed"), { already: "claimed", by: "session-1" }, "and so is a dismiss of a claimed finding");
	let ran = false;
	await inbox.decide(a.id, "claimed", { before: () => void (ran = true) });
	assert.equal(ran, false, "a claim that loses runs nothing under the lock");
	assert.equal(inbox.list().find((e) => e.id === a.id)?.claimed_by, "session-1", "the first claim stands");

	const dismissed = await inbox.decide(b.id, "dismissed", { reason: "  not\n a bug " });
	assert.ok("ok" in dismissed);
	assert.equal(dismissed.ok.dismiss_reason, "not a bug");
	assert.ok(dismissed.ok.dismissed_at);
	assert.deepEqual(await inbox.decide(b.id, "claimed", { by: "s" }), { already: "dismissed" });
	assert.deepEqual(await inbox.decide("inb-0000", "claimed"), { missing: true });
});

test("a line the inbox cannot read survives every rewrite, byte for byte, in its place", async () => {
	const dir = tmp("pi-loops-inbox-");
	const inbox = new Inbox(dir);
	const base = { source: "cron:demo", run_id: "r", job_id: "j", cwd: "/p" };
	const a = await inbox.append({ ...base, text: "a" });
	const torn = '{"id":"inb-torn","text":"cut sho';
	fs.appendFileSync(inbox.file, `${torn}\n`);
	const b = await inbox.append({ ...base, text: "b" });
	await inbox.decide(a.id, "dismissed", { reason: "noise" });
	await inbox.decide(b.id, "claimed", { by: "s" });
	const lines = () => fs.readFileSync(inbox.file, "utf8").split("\n");
	assert.equal(lines()[1], torn, "kept verbatim, between the two lines it was between");
	assert.deepEqual(inbox.list().map((e) => e.status), ["dismissed", "claimed"]);
	await inbox.append({ ...base, text: "c" });
	await inbox.dismissAllNew();
	assert.equal(lines()[1], torn, "a clear keeps it too");
});

test("two processes deciding one finding: exactly one succeeds", async () => {
	const dir = tmp("pi-loops-inbox-race-");
	const inbox = new Inbox(dir);
	const entry = await inbox.append({ source: "cron:demo", text: "one finding", run_id: "r", job_id: "j", cwd: dir });
	const script = `
	import { Inbox } from ${JSON.stringify(path.resolve("src/inbox.ts"))};
	const outcome = await new Inbox(${JSON.stringify(dir)}).decide(process.argv[2], process.argv[3], { by: "child" });
	process.stdout.write("ok" in outcome ? "ok" : JSON.stringify(outcome));
	`;
	const file = path.join(dir, "child.ts");
	fs.writeFileSync(file, script);
	const run = (to: string) =>
		new Promise<string>((resolve) => {
			const child = spawn(process.execPath, ["--import", path.resolve("src/register-pi.mjs"), file, entry.id, to], { stdio: ["ignore", "pipe", "inherit"] });
			let out = "";
			child.stdout.on("data", (d) => (out += d));
			child.on("exit", () => resolve(out));
		});
	const outcomes = await Promise.all([run("claimed"), run("dismissed"), run("claimed")]);
	assert.equal(outcomes.filter((o) => o === "ok").length, 1, `one winner: ${outcomes.join(", ")}`);
	assert.equal(outcomes.filter((o) => o.startsWith('{"already"')).length, 2);
	assert.notEqual(inbox.list()[0].status, "new");
});

test("a line with fields of the wrong type reads as strings and a boolean, and an empty one is not counted", () => {
	const dir = tmp("pi-loops-inbox-");
	const inbox = new Inbox(dir);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		inbox.file,
		[
			JSON.stringify({ id: "inb-1", status: "new", source: 5, job_id: ["x"], cwd: {}, run_id: 7, session_id: 1, verified: "yes", text: "typed by hand", created_at: 3, transcript: 9 }),
			JSON.stringify({ id: "inb-2", status: "new", text: "" }),
			JSON.stringify({ status: "new", kind: "checkpoint", text: "no id · waits: you" }),
		].join("\n") + "\n",
	);
	const [e] = inbox.list();
	assert.deepEqual([e.source, e.job_id, e.cwd, e.run_id, e.session_id, e.verified, e.created_at, e.transcript], ["", undefined, "", "", undefined, null, "", undefined]);
	assert.deepEqual(inbox.listNew().map((x) => x.id), ["inb-1"], "a finding with no id or no text is not listed");
	assert.equal(inbox.newCount(), 1, "nor counted by the badge");
	assert.equal(inbox.decisionCount(), 0);
});

test("appendOnce files one finding for one result, however many writers race for it", async () => {
	const inbox = new Inbox(tmp("pi-loops-inbox-once-"));
	const entry = { source: "trigger:local:dynamic", text: "matched dyn-1. done", run_id: "trace-1", job_id: "dyn-1", cwd: "/p", session_id: "s" };
	const all = await Promise.all(Array.from({ length: 6 }, (_, i) => inbox.appendOnce({ ...entry, text: `${entry.text} ${i}` }, { run_id: "trace-1", source: entry.source })));
	assert.equal(inbox.list().length, 1);
	assert.equal(new Set(all.map((e) => e.id)).size, 1, "every writer is given the one finding");
	await inbox.appendOnce({ ...entry, session_id: "other" }, { run_id: "trace-1", source: entry.source, session_id: "other" });
	assert.equal(inbox.list().length, 2, "a key that names a session files that conversation's own finding");
	await inbox.appendOnce({ ...entry, source: "cron:x" }, { run_id: "trace-1", source: "cron:x" });
	assert.equal(inbox.list().length, 3, "another source is another finding");
});

const once = { source: "cron:demo", run_id: "r1", cwd: "/p", text: "the first text", undelivered: true as const };

test("[fileOnce] filing twice under one id leaves one finding and returns the first", async () => {
	const inbox = new Inbox(tmp("pi-loops-inbox-"));
	const id = findingId("dead | r1");
	const first = await inbox.fileOnce(once, id);
	const second = await inbox.fileOnce({ ...once, text: "another text" }, id);
	assert.deepEqual([first.id, first.text, first.status], [id, "the first text", "new"]);
	// As lines: the first call returns what it built, the second what it read, and an absent key reads as undefined.
	const line = (e: InboxEntry) => JSON.parse(JSON.stringify(e));
	assert.deepEqual(line(second), line(first), "the second caller gets the finding that is there");
	assert.deepEqual(inbox.list().map((e) => [e.id, e.text]), [[id, "the first text"]]);
});

test("[fileOnce] two calls that wait for the lock together leave one finding: each looks while it holds the lock", async () => {
	const dir = tmp("pi-loops-inbox-");
	const inbox = new Inbox(dir);
	const id = findingId("dead | r2");
	// Somebody holds the inbox lock (a triage rewrite): both callers are waiting before either looks.
	const lock = path.join(dir, "inbox.lock");
	fs.mkdirSync(lock, { recursive: true });
	const both = Promise.all([inbox.fileOnce({ ...once, text: "a" }, id), inbox.fileOnce({ ...once, text: "b" }, id)]);
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(fs.existsSync(inbox.file), false, "neither wrote while the lock was held");
	fs.rmdirSync(lock);
	const [a, b] = await both;
	assert.equal(inbox.list().length, 1);
	assert.deepEqual([a.id, a.text], [b.id, b.text], "both callers get the one that was written");
	assert.equal(inbox.list()[0].text, a.text);
	assert.equal(fs.readFileSync(inbox.file, "utf8").trim().split("\n").length, 1);
});

test("[fileOnce] a finding that was claimed is returned as it is and is not filed again", async () => {
	const inbox = new Inbox(tmp("pi-loops-inbox-"));
	const id = findingId("dead | r3");
	await inbox.fileOnce(once, id);
	await inbox.decide(id, "claimed", { by: "s1" });
	const again = await inbox.fileOnce(once, id);
	assert.deepEqual([again.status, again.claimed_by], ["claimed", "s1"]);
	assert.equal(inbox.list().length, 1);
	assert.equal(inbox.newCount(), 0, "a repeat does not open the question again");
});

test("[fileOnce] an id that is not inb- and 32 hex throws and files nothing", async () => {
	const inbox = new Inbox(tmp("pi-loops-inbox-"));
	for (const id of ["inb-123", "x", "", `inb-${"g".repeat(32)}`, `inb-${"a".repeat(33)}`, `INB-${"a".repeat(32)}`, ` ${findingId("x")}`]) {
		await assert.rejects(inbox.fileOnce(once, id), /not a finding id/, JSON.stringify(id));
	}
	assert.equal(fs.existsSync(inbox.file), false);
});

test("[fileOnce] findingId gives inb- and 32 hex, the same for the same seed and another for another", () => {
	assert.equal(findingId("dead | r1"), `inb-${createHash("sha256").update("dead | r1").digest("hex").slice(0, 32)}`);
	assert.match(findingId("dead | r1"), /^inb-[0-9a-f]{32}$/);
	assert.equal(findingId("dead | r1"), findingId("dead | r1"));
	assert.notEqual(findingId("dead | r1"), findingId("dead | r2"));
	assert.notEqual(findingId("dead | r1"), findingId("ask | r1"), "the seed's first word is part of it");
});

test("[fileOnce] a finding filed once has the fields an appended one has, in the same order", async () => {
	const inbox = new Inbox(tmp("pi-loops-inbox-"));
	const appended = await inbox.append({ ...once, lane: "s1", session_id: "s1" });
	const filed = await inbox.fileOnce({ ...once, lane: "s1", session_id: "s1" }, findingId("dead | r9"));
	assert.deepEqual(Object.keys(filed), Object.keys(appended));
	assert.deepEqual({ ...filed, id: "", created_at: "" }, { ...appended, id: "", created_at: "" });
});

test("a finding keeps its lane through a rewrite, and a lane that is not a string reads as missing", async () => {
	const inbox = new Inbox(tmp("pi-loops-inbox-"));
	const withLane = await inbox.append({ ...once, lane: "@cron-abc" });
	const other = await inbox.append({ ...once, text: "another" });
	assert.equal(Object.keys(withLane).at(-1), "lane", "written last");
	assert.equal("lane" in other, false, "and only when it is set");
	await inbox.decide(other.id, "dismissed");
	assert.equal(inbox.list().find((e) => e.id === withLane.id)?.lane, "@cron-abc", "the rewrite of the file kept it");
	assert.match(fs.readFileSync(inbox.file, "utf8").split("\n")[0], /"lane":"@cron-abc"\}$/);
	fs.appendFileSync(inbox.file, `${JSON.stringify({ id: "inb-x", created_at: "2026-11-01T00:00:00.000+00:00", status: "new", source: "s", run_id: "r", cwd: "/p", text: "t", lane: 5 })}\n`);
	assert.equal("lane" in inbox.list().find((e) => e.id === "inb-x")!, false);
});

test("pi-loops inbox --json fields do not gain lane", () => {
	assert.equal((FINDING_FIELDS as readonly string[]).includes("lane"), false);
	assert.equal(FINDING_FIELDS.length, 10);
});

const AT = "2026-11-20T00:00:00.000+00:00";
const CALL = { tool: "bash", tool_call_id: "call-1", command: "git push --force origin main", input_sha256: "a".repeat(64), reason: "git push --force on main/master" };
const ASK = { kind: "call", id: `ask-${"b".repeat(32)}`, lane: "@cron-abc", session_id: "0199aaaa-0000-7000-8000-0000000000a1", title: "nightly asks to run a command", call: CALL, created_at: AT };
const CLAIM = { id: "ans-1", pid: 1, started_at: AT };

/** The lines a rewrite must keep as they are: a pending answer, an answer a newer version wrote, an ask of another shape, and fields nobody here reads. */
const KEPT = [
	{ id: findingId("kept-1"), created_at: AT, status: "claimed", kind: "checkpoint", source: "cron:x", run_id: "r", cwd: "/p", text: "kept one", verified: null, dismiss_reason: null, claimed_by: "s1", ask: ASK, answered_by: "page", answer: { state: "pending", at: AT }, later: { nested: [1, "two"] } },
	{ id: findingId("kept-2"), created_at: AT, status: "claimed", kind: "news", source: "cron:x", run_id: "r", cwd: "/p", text: "kept two", verified: null, dismiss_reason: null, ask: { kind: "repo", url: "x" }, answered_by: "pager", answer: { state: "later", at: AT, extra: 1 }, later: "z" },
];
const KEPT_FIELDS = ["ask", "answered_by", "answer", "later"] as const;

function seedKept(inbox: Inbox): void {
	fs.mkdirSync(path.dirname(inbox.file), { recursive: true });
	fs.writeFileSync(inbox.file, KEPT.map((k) => JSON.stringify(k)).join("\n") + "\n");
}

function assertKept(inbox: Inbox, after: string): void {
	const lines = fs.readFileSync(inbox.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	for (const k of KEPT) {
		const line = lines.find((l) => l.id === k.id);
		assert.ok(line, `${k.text} is still there after ${after}`);
		for (const field of KEPT_FIELDS) assert.equal(JSON.stringify(line[field]), JSON.stringify((k as Record<string, unknown>)[field]), `${k.text}: ${field} as it was after ${after}`);
	}
}

test("[keep-fields] decide, dismissAllNew and section.write keep ask, answered_by, answer and an unknown field of another finding as they were", async () => {
	const inbox = new Inbox(tmp("pi-loops-inbox-"));
	seedKept(inbox);
	const base = { source: "cron:demo", run_id: "r", job_id: "j", cwd: "/p" };
	const a = await inbox.append({ ...base, text: "a" });
	await inbox.decide(a.id, "dismissed", { reason: "noise" });
	assertKept(inbox, "decide");
	await inbox.append({ ...base, text: "b" });
	assert.equal(await inbox.dismissAllNew(), 1);
	assertKept(inbox, "dismissAllNew");
	const c = await inbox.append({ ...base, text: "c" });
	const write = answerStep("N1", inbox.list().find((e) => e.id === c.id), { to: "none", by: "terminal" }, { at: AT, lane: undefined }) as AnswerWrite;
	await inbox.section((tx) => tx.write(write));
	assertKept(inbox, "section.write");
	assert.deepEqual(inbox.list().find((e) => e.id === KEPT[1].id)?.answer, { state: "unreadable", raw: KEPT[1].answer }, "an answer a newer version wrote reads as unreadable");
	assert.equal(inbox.list().find((e) => e.id === KEPT[1].id)?.ask, undefined, "an ask of another shape reads as absent");
	assert.deepEqual(inbox.list().find((e) => e.id === KEPT[0].id)?.answer, KEPT[0].answer);
});

test("[keep-fields] a finding the section writes keeps its own unknown field, and a field it now carries is the one written", async () => {
	const inbox = new Inbox(tmp("pi-loops-inbox-"));
	fs.mkdirSync(path.dirname(inbox.file), { recursive: true });
	const id = findingId("own");
	fs.writeFileSync(inbox.file, `${JSON.stringify({ id, created_at: AT, status: "new", kind: "news", source: "cron:x", run_id: "r", cwd: "/p", text: "t", verified: null, dismiss_reason: null, lane: 5, later: true })}\n`);
	const write = answerStep("Y1", inbox.list()[0], { to: "pending", by: "page", claimed_by: "s1", lane: "@cron-abc" }, { at: AT, lane: "@cron-abc" }) as AnswerWrite;
	await inbox.section((tx) => tx.write(write));
	const line = JSON.parse(fs.readFileSync(inbox.file, "utf8"));
	assert.equal(line.later, true, "kept");
	assert.equal(line.lane, "@cron-abc", "the lane the write set, not the one that did not read");
	assert.deepEqual(line.answer, { state: "pending", at: AT });
	assert.equal(line.answered_by, "page");
});

test("[section] a body that returns a promise does not compile, and a throw before write leaves the file as it was", async () => {
	const inbox = new Inbox(tmp("pi-loops-inbox-"));
	seedKept(inbox);
	const a = await inbox.append({ source: "cron:demo", run_id: "r", job_id: "j", cwd: "/p", text: "a" });
	const typeOnly = () =>
		// @ts-expect-error a section is synchronous: inbox.lock is never held across an await
		inbox.section(async () => 1);
	assert.equal(typeof typeOnly, "function");
	const before = fs.readFileSync(inbox.file, "utf8");
	await assert.rejects(inbox.section((tx) => {
		tx.find(a.id);
		throw new Error("before the write");
	}), /before the write/);
	assert.equal(fs.readFileSync(inbox.file, "utf8"), before);
	const write = answerStep("N1", inbox.list().find((e) => e.id === a.id), { to: "none", by: "page" }, { at: AT, lane: undefined }) as AnswerWrite;
	const missing = { ...write, id: findingId("not there") } as AnswerWrite;
	assert.throws(() => inbox.sectionSync((tx) => tx.write(write, missing)), /no finding/);
	assert.equal(fs.readFileSync(inbox.file, "utf8"), before, "a change whose finding is missing writes none of the changes");
	assert.equal(await inbox.section((tx) => tx.list().length), 3, "a body's value is the section's");
});

test("[section] write sets the finding and appends beside once", async () => {
	const inbox = new Inbox(tmp("pi-loops-inbox-"));
	const a = await inbox.append({ source: "cron:demo", run_id: "r", job_id: "j", cwd: "/p", text: "a" });
	const write = answerStep("Y2", inbox.list()[0], { to: "not_run", by: "terminal", claimed_by: "s1", why: "there is nowhere to run it" }, { at: AT, lane: undefined }) as AnswerWrite;
	assert.ok(write.beside);
	const written = await inbox.section((tx) => tx.write(write));
	assert.equal(written.id, a.id);
	assert.equal(written.status, "claimed");
	assert.deepEqual(written.answer, { state: "not_run", why: "there is nowhere to run it", at: AT });
	await inbox.section((tx) => tx.write(write));
	const all = inbox.list();
	assert.deepEqual(all.map((e) => e.id), [a.id, write.beside.id], "the news is filed once, after the finding");
	assert.equal(all[1].status, "new");
	assert.match(all[1].text, /could not be started/);
	assert.equal(fs.readFileSync(inbox.file, "utf8").split("\n").filter(Boolean).length, 2);
});

test("[section] fileOnce inside a section files once and carries ask", async () => {
	const inbox = new Inbox(tmp("pi-loops-inbox-"));
	const id = findingId("ask | one");
	const entry = { source: "cron:x", run_id: "r", cwd: "/p", text: "Run it?", ask: ASK as InboxEntry["ask"] };
	const [first, second] = await inbox.section((tx) => [tx.fileOnce(entry, id), tx.fileOnce({ ...entry, text: "other" }, id)]);
	assert.equal(first, second);
	assert.deepEqual(inbox.list().map((e) => [e.id, e.text]), [[id, "Run it?"]]);
	assert.deepEqual(inbox.list()[0].ask, ASK);
	assert.equal(Object.keys(inbox.list()[0]).at(-1), "ask", "written after lane");
	assert.deepEqual((await inbox.fileOnce(entry, findingId("ask | two"))).ask, ASK);
});

test("[pins] pinnedTranscripts keeps the transcripts of new findings and of open answers, by job or by lane", () => {
	const inbox = new Inbox(tmp("pi-loops-inbox-"));
	fs.mkdirSync(path.dirname(inbox.file), { recursive: true });
	const f = (n: string, over: Record<string, unknown>) => ({ id: findingId(n), created_at: AT, status: "claimed", kind: "news", source: "cron:j", run_id: "r", cwd: "/p", text: n, verified: null, dismiss_reason: null, job_id: "j", transcript: `/t/${n}.jsonl`, answered_by: "page", ...over });
	const lines = [
		f("new", { status: "new", answered_by: undefined }),
		f("pending", { answer: { state: "pending", at: AT } }),
		f("started", { answer: { state: "started", run: CLAIM, at: AT } }),
		f("done", { answer: { state: "done", run: CLAIM, at: AT } }),
		f("claimed", {}),
		f("check-pending", { job_id: "rule-1", lane: "@check-abc", answer: { state: "pending", at: AT } }),
		f("check-done", { job_id: "rule-1", lane: "@check-abc", answer: { state: "done", run: CLAIM, at: AT } }),
	];
	fs.writeFileSync(inbox.file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	assert.deepEqual([...inbox.pinnedTranscripts({ job: "j" }, "/t")].sort(), ["/t/new.jsonl", "/t/pending.jsonl", "/t/started.jsonl"]);
	assert.deepEqual([...inbox.pinnedTranscripts("j", "/t")].sort(), ["/t/new.jsonl", "/t/pending.jsonl", "/t/started.jsonl"], "a job's id as before");
	assert.deepEqual([...inbox.pinnedTranscripts({ lane: "@check-abc" }, "/t")], ["/t/check-pending.jsonl"]);
});

test("[pins-by-id] pinnedTranscripts finds a finding's transcript in the lane's directory by its session id, never by the path the finding names", () => {
	const root = tmp("pi-loops-pins-");
	const inbox = new Inbox(path.join(root, "loops"));
	const lane = path.join(root, "sessions", "j");
	const header = (file: string, id: string) => (fs.mkdirSync(path.dirname(file), { recursive: true }), fs.writeFileSync(file, `${JSON.stringify({ type: "session", id })}\n`), file);
	const runs = header(path.join(lane, "run.jsonl"), "sid-run");
	const asked = header(path.join(lane, "asked.jsonl"), "sid-asked");
	const elsewhere = header(path.join(root, "elsewhere", "conv.jsonl"), "sid-elsewhere");
	fs.symlinkSync(elsewhere, path.join(lane, "link.jsonl"));
	const f = (n: string, over: Record<string, unknown>) => ({ id: findingId(n), created_at: AT, status: "new", kind: "news", source: "cron:j", run_id: "r", cwd: "/p", text: n, verified: null, dismiss_reason: null, job_id: "j", ...over });
	const lines = [
		f("run", { transcript: "/hand/edited.jsonl", transcript_id: "sid-run" }),
		f("asked", { transcript: elsewhere, ask: { ...ASK, session_id: "sid-asked" } }),
		f("through-a-link", { transcript: path.join(lane, "link.jsonl"), transcript_id: "sid-elsewhere" }),
	];
	fs.mkdirSync(path.dirname(inbox.file), { recursive: true });
	fs.writeFileSync(inbox.file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	assert.deepEqual([...inbox.pinnedTranscripts({ job: "j" }, lane)].sort(), [asked, runs].sort(), "the files whose headers name the ids; not a named path, and not a symlink");
});

test("[lock] UNDER_INBOX_LOCK is five seconds, and the claim lock is that value", () => {
	assert.deepEqual(UNDER_INBOX_LOCK, { timeoutMs: 5_000 });
	assert.equal(CLAIM_QUEUE_LOCK, UNDER_INBOX_LOCK);
});
