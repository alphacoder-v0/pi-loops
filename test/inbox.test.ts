import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { Inbox, type InboxEntry, resolveInboxRef } from "../src/inbox.ts";

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
