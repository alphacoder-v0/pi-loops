import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Inbox, findingId } from "../src/inbox.ts";
import { stamp } from "../src/schedule.ts";
import { personAnswers } from "../src/answers.ts";
import { RequestStore } from "../src/requests.ts";
import { JobStore } from "../src/store.ts";
import { TriggerStore } from "../src/triggers.ts";

/** `/inbox clear --all`: every new finding dismissed in one rewrite, through the surfaces' one writer. */
function clearAll(dir: string, inbox: Inbox): Promise<unknown> {
	const answers = personAnswers({ inbox, requests: new RequestStore(dir), jobs: new JobStore(dir), audit: new TriggerStore(dir), sessionFile: () => undefined, self: () => ({ pid: process.pid, instance: "test", version: "0" }), now: Date.now, log: () => undefined });
	return answers.clear(undefined, { by: "terminal", session: "s" });
}

test("a finding appended while another process rewrites the inbox is not lost", async () => {
	const dir = tmp("pi-loops-inbox-race-");
	const inbox = new Inbox(dir);
	for (let i = 0; i < 40; i++) await inbox.append({ source: "cron:seed", text: `seed ${i}`, run_id: "r", job_id: "j", cwd: dir });

	// A second process appends while this one dismisses everything (read-modify-rewrite).
	const script = `
	import { Inbox } from ${JSON.stringify(path.resolve("src/inbox.ts"))};
	const inbox = new Inbox(${JSON.stringify(dir)});
	const until = Date.now() + 3000;
	let i = 0;
	while (Date.now() < until && i < 200) await inbox.append({ source: "cron:child", text: "child " + i++, run_id: "r", job_id: "j", cwd: ${JSON.stringify(dir)} });
	process.stdout.write(String(i));
	`;
	const file = path.join(dir, "child.ts");
	fs.writeFileSync(file, script);
	const child = spawn(process.execPath, ["--import", path.resolve("src/register-pi.mjs"), file], { stdio: ["ignore", "pipe", "inherit"] });
	let appended = "";
	child.stdout.on("data", (d) => (appended += d));
	const exited = new Promise<number>((r) => child.on("exit", (c) => r(c ?? -1)));
	// Rewrite the whole file repeatedly while the child appends to it.
	for (let i = 0; i < 25; i++) {
		await clearAll(dir, inbox);
		await new Promise((r) => setTimeout(r, 10));
	}
	assert.equal(await exited, 0);
	const wrote = Number(appended);
	assert.ok(wrote > 0, "the child appended something");

	const all = inbox.list();
	assert.equal(all.filter((e) => e.source === "cron:child").length, wrote, "every appended finding survived the concurrent rewrites");
	assert.equal(all.filter((e) => e.source === "cron:seed").length, 40);
});

test("a leftover lock never blocks the event loop", async () => {
	const dir = tmp("pi-loops-inbox-lock-");
	const inbox = new Inbox(dir);
	// A lock directory left behind by a process that was killed while holding it.
	const lock = path.join(dir, "inbox.lock");
	fs.mkdirSync(lock, { recursive: true });
	// Make the lock almost stale (the default staleMs is 10 s), so the wait is about 300 ms.
	const almostStale = (Date.now() - 10_000 + 300) / 1000;
	fs.utimesSync(lock, almostStale, almostStale);

	let ticks = 0;
	const timer = setInterval(() => ticks++, 10);
	const started = Date.now();
	try {
		await inbox.append({ source: "cron:x", text: "still gets written", run_id: "r", job_id: "j", cwd: dir });
	} finally {
		clearInterval(timer);
	}
	const waited = Date.now() - started;
	assert.ok(waited >= 100, `it did wait for the stale lock (${waited}ms)`);
	assert.ok(ticks > 3, `the event loop kept running while waiting (${ticks} ticks in ${waited}ms)`);
	assert.equal(inbox.list().length, 1, "and the finding is written once the lock is broken");
});

test("the inbox is rotated past 1 MB, keeping every new finding", async () => {
	const dir = tmp("pi-loops-rotate-");
	const inbox = new Inbox(dir);
	const filler = "x".repeat(400);
	// Triaged history is what rotation is allowed to drop; unread findings never are.
	let appended = 0;
	for (let round = 0; round < 3; round++) {
		for (let i = 0; i < 900; i++, appended++) await inbox.append({ source: "cron:old", text: `${filler} ${round}-${i}`, run_id: "r", job_id: "j", cwd: dir });
		await clearAll(dir, inbox);
	}
	const keepers = [];
	for (let i = 0; i < 5; i++, appended++) keepers.push(await inbox.append({ source: "cron:new", text: `unread ${i}`, run_id: "r", job_id: "j", cwd: dir }));

	assert.ok(fs.statSync(inbox.file).size < 1_200_000, `the file is kept bounded (${fs.statSync(inbox.file).size} after ${appended} appends)`);
	const after = inbox.list();
	assert.ok(after.length < appended, `older triaged entries were dropped (${after.length} of ${appended} kept)`);
	assert.equal(after.filter((e) => e.status === "new").length, 5, "every unread finding survives");
	for (const k of keepers) assert.ok(after.some((e) => e.id === k.id), `kept ${k.id}`);
	assert.ok(after.some((e) => e.status === "dismissed"), "and some triaged history is kept for /inbox all");
	const ids = after.map((e) => e.id);
	assert.deepEqual([...after].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).map((e) => e.id), ids, "still oldest-first");
});

test("[rotation] rotation keeps an open answer, an unreadable one and a no that still holds, and drops only what keptByRotation does not keep", async () => {
	const dir = tmp("pi-loops-rotate-");
	const inbox = new Inbox(dir);
	const now = Date.now();
	const ago = (days: number) => stamp(now - days * 86_400_000);
	const ask = { kind: "call", id: `ask-${"b".repeat(32)}`, lane: "@cron-abc", session_file: "/s/a.jsonl", title: "t", call: { tool: "bash", tool_call_id: "c", command: "rm -rf /tmp/x", input_sha256: "a".repeat(64), reason: "r" }, created_at: ago(30) };
	const claim = { id: "ans-1", pid: 1, started_at: ago(30) };
	const f = (n: string, over: Record<string, unknown>): Record<string, unknown> => ({ id: findingId(n), created_at: ago(30), status: "claimed", kind: "news", source: "cron:x", run_id: "r", cwd: dir, text: n, verified: null, dismiss_reason: null, answered_by: "page", ...over });
	// The oldest lines: what rotation reaches first.
	const special = [
		f("pending", { answer: { state: "pending", at: ago(30) }, later: 1 }),
		f("started", { answer: { state: "started", run: claim, at: ago(30) } }),
		f("unreadable", { answer: { state: "later", at: ago(30) } }),
		f("recent no", { status: "dismissed", answered_by: "terminal", dismissed_at: ago(3), ask }),
		f("old no", { status: "dismissed", answered_by: "terminal", dismissed_at: ago(20), ask }),
		f("done", { answer: { state: "done", run: claim, at: ago(30) } }),
		f("plain claim", { answered_by: undefined }),
	];
	const filler = "x".repeat(480);
	const history = Array.from({ length: 1_600 }, (_, i) => f(`history ${i} ${filler}`, { status: "dismissed", answered_by: undefined, created_at: ago(29) }));
	fs.writeFileSync(inbox.file, [...special, ...history].map((l) => JSON.stringify(l)).join("\n") + "\n");
	assert.ok(fs.statSync(inbox.file).size > 1_000_000, "past the rotation size");

	await inbox.append({ source: "cron:new", text: "unread", run_id: "r", job_id: "j", cwd: dir });

	const after = inbox.list();
	const kept = (n: string) => after.some((e) => e.id === findingId(n));
	for (const n of ["pending", "started", "unreadable", "recent no"]) assert.ok(kept(n), `kept ${n}`);
	for (const n of ["old no", "done", "plain claim"]) assert.ok(!kept(n), `dropped ${n}`);
	assert.ok(after.length < special.length + history.length, "history was dropped");
	const droppable = [special[4], special[5], special[6], ...history];
	const dropped = [...special, ...history].filter((l) => !after.some((e) => e.id === l.id));
	assert.deepEqual(dropped.map((l) => l.id), droppable.slice(0, Math.floor(droppable.length / 2)).map((l) => l.id), "the oldest half of what keptByRotation does not keep, and nothing else");
	const pending = JSON.parse(fs.readFileSync(inbox.file, "utf8").split("\n")[0]);
	assert.deepEqual([pending.id, pending.answer, pending.later], [findingId("pending"), special[0].answer, 1], "a kept line keeps every field, the unknown one too");
	const unreadable = JSON.parse(fs.readFileSync(inbox.file, "utf8").split("\n")[2]);
	assert.deepEqual(unreadable.answer, special[2].answer, "an answer a newer version wrote is written back as it was");
});
