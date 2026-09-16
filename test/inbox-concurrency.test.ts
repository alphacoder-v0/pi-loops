import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Inbox } from "../src/inbox.ts";

test("a finding appended while another process rewrites the inbox is not lost", async () => {
	const dir = tmp("pi-loops-inbox-race-");
	const inbox = new Inbox(dir);
	for (let i = 0; i < 40; i++) await inbox.append({ source: "cron:seed", text: `seed ${i}`, runId: "r", jobId: "j", cwd: dir });

	// A second process appends while this one dismisses everything (read-modify-rewrite).
	const script = `
	import { Inbox } from ${JSON.stringify(path.resolve("src/inbox.ts"))};
	const inbox = new Inbox(${JSON.stringify(dir)});
	const until = Date.now() + 3000;
	let i = 0;
	while (Date.now() < until && i < 200) await inbox.append({ source: "cron:child", text: "child " + i++, runId: "r", jobId: "j", cwd: ${JSON.stringify(dir)} });
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
		await inbox.dismissAllNew();
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
	fs.mkdirSync(path.join(dir, "inbox.lock"), { recursive: true });

	let ticks = 0;
	const timer = setInterval(() => ticks++, 10);
	const started = Date.now();
	try {
		await inbox.append({ source: "cron:x", text: "still gets written", runId: "r", jobId: "j", cwd: dir });
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
		for (let i = 0; i < 900; i++, appended++) await inbox.append({ source: "cron:old", text: `${filler} ${round}-${i}`, runId: "r", jobId: "j", cwd: dir });
		await inbox.dismissAllNew();
	}
	const keepers = [];
	for (let i = 0; i < 5; i++, appended++) keepers.push(await inbox.append({ source: "cron:new", text: `unread ${i}`, runId: "r", jobId: "j", cwd: dir }));

	assert.ok(fs.statSync(inbox.file).size < 1_200_000, `the file is kept bounded (${fs.statSync(inbox.file).size} after ${appended} appends)`);
	const after = inbox.list();
	assert.ok(after.length < appended, `older triaged entries were dropped (${after.length} of ${appended} kept)`);
	assert.equal(after.filter((e) => e.status === "new").length, 5, "every unread finding survives");
	for (const k of keepers) assert.ok(after.some((e) => e.id === k.id), `kept ${k.id}`);
	assert.ok(after.some((e) => e.status === "dismissed"), "and some triaged history is kept for /inbox all");
	const ids = after.map((e) => e.id);
	assert.deepEqual([...after].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).map((e) => e.id), ids, "still oldest-first");
});
