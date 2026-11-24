import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { EventLog } from "../src/events.ts";

/** A child process that appends `count` events to `dir` through its own EventLog, and exits 0. */
function appender(dir: string, name: string, count: number, maxBytes: number): Promise<number> {
	const file = path.join(dir, `${name}.ts`);
	fs.writeFileSync(
		file,
		`import { EventLog } from ${JSON.stringify(path.resolve("src/events.ts"))};
		const log = new EventLog(${JSON.stringify(dir)}, "background", { maxBytes: ${maxBytes} });
		for (let i = 0; i < ${count}; i++) log.append("mcp:${name}", "${name} " + i);
		`,
	);
	const child = spawn(process.execPath, ["--import", path.resolve("src/register-pi.mjs"), file], { stdio: ["ignore", "inherit", "inherit"] });
	return new Promise((r) => child.on("exit", (c) => r(c ?? -1)));
}

const lines = (file: string): string[] => fs.readFileSync(file, "utf8").split("\n").filter(Boolean);

test("[event-log] an appended event is found by get and since, with its source, receiver and time", () => {
	const dir = tmp("pi-loops-events-");
	const log = new EventLog(dir, "window");
	const before = Date.now() - 1000; // stamp() keeps milliseconds; a second of slack is for nothing else
	const a = log.append("mcp:github", '{"method":"x"}');
	const b = log.append("gate:job-1", "reading");
	assert.match(a.id, /^evt-[0-9a-f]{32}$/);
	assert.notEqual(a.id, b.id);
	assert.match(a.received_at, /[+-]\d\d:\d\d$/, "a local time with its offset, not UTC's Z");
	assert.deepEqual(a.receiver, { pid: process.pid, kind: "window" });

	const other = new EventLog(dir, "background");
	assert.deepEqual(other.get(a.id), a, "another reader of the same directory finds it");
	assert.deepEqual(other.get(b.id), b);
	assert.equal(other.get("evt-nothing"), undefined);
	assert.deepEqual(other.since(before), [a, b], "oldest first");
	assert.deepEqual(other.since(Date.now() + 60_000), [], "nothing was received in the future");
	assert.equal(lines(path.join(dir, "events.jsonl")).length, 2, "one line per event");
});

test("[event-log] raw is kept byte for byte: newlines, quotes, backslashes and non-ASCII", () => {
	const dir = tmp("pi-loops-events-raw-");
	const raw = 'line one\nline "two"\r\n\ttab \\ back\\slash 雪 🙂 \u2028 {"json":"in text"}  \n';
	const event = new EventLog(dir, "background").append("mcp:s", raw);
	const back = new EventLog(dir, "background").get(event.id);
	assert.ok(back);
	assert.ok(Buffer.from(back.raw, "utf8").equals(Buffer.from(raw, "utf8")), "the same bytes come back");
	assert.equal(lines(path.join(dir, "events.jsonl")).length, 1, "a raw newline does not split the line");
});

test("[event-log] an append waits while another process holds events.lock", async () => {
	const dir = tmp("pi-loops-events-lock-");
	fs.mkdirSync(path.join(dir, "events.lock"));
	const exited = appender(dir, "waiter", 1, 1_000_000);
	await new Promise((r) => setTimeout(r, 1500));
	assert.equal(fs.existsSync(path.join(dir, "events.jsonl")), false, "nothing written while the lock is held");
	fs.rmSync(path.join(dir, "events.lock"), { recursive: true });
	assert.equal(await exited, 0);
	assert.equal(new EventLog(dir, "window").since(0).length, 1, "written once the lock is free");
});

test("[event-log] two processes appending at once across a rotation lose no line", async () => {
	const dir = tmp("pi-loops-events-race-");
	// About 170 bytes a line, 300 lines: one rotation at 40 KB, and both generations hold them all.
	const maxBytes = 40_000;
	const [x, y] = await Promise.all([appender(dir, "one", 150, maxBytes), appender(dir, "two", 150, maxBytes)]);
	assert.equal(x, 0);
	assert.equal(y, 0);
	assert.ok(fs.existsSync(path.join(dir, "events.1.jsonl")), "the log rotated while both wrote");
	const all = new EventLog(dir, "window").since(0);
	assert.equal(new Set(all.map((e) => e.id)).size, 300);
	assert.deepEqual(all.map((e) => e.seq).sort((a, b) => a - b), Array.from({ length: 300 }, (_, i) => i + 1), "each event its own number, none skipped or given twice");
	for (const name of ["one", "two"]) {
		const raws = all.filter((e) => e.source === `mcp:${name}`).map((e) => e.raw);
		assert.deepEqual(raws, Array.from({ length: 150 }, (_, i) => `${name} ${i}`), `every event of ${name}, in its order`);
	}
});

test("[event-rotate] past the limit the log is renamed to events.1.jsonl, and get and since read both", () => {
	const dir = tmp("pi-loops-events-rotate-");
	const file = path.join(dir, "events.jsonl");
	const log = new EventLog(dir, "background", { maxBytes: 1000 });
	const first = log.append("mcp:s", "a".repeat(300));
	const size = fs.statSync(file).size;
	const written = [first];
	while (fs.statSync(file).size + size <= 1000) written.push(log.append("mcp:s", "a".repeat(300)));
	assert.equal(fs.existsSync(path.join(dir, "events.1.jsonl")), false, "not yet: the next line still fits");
	const before = fs.readFileSync(file, "utf8");
	const next = log.append("mcp:s", "b".repeat(300));
	assert.equal(fs.readFileSync(path.join(dir, "events.1.jsonl"), "utf8"), before, "the full file is renamed, unchanged");
	assert.equal(lines(file).length, 1, "a new file starts with the event that did not fit");
	assert.ok(fs.statSync(file).size <= 1000);
	assert.deepEqual(log.get(first.id), first, "get reads the older generation");
	assert.deepEqual(log.get(next.id), next);
	assert.deepEqual(log.since(0), [...written, next], "since reads both generations, oldest first");
});

test("[event-rotate] a third generation drops the oldest", () => {
	const dir = tmp("pi-loops-events-third-");
	const log = new EventLog(dir, "background", { maxBytes: 1000 });
	const all = Array.from({ length: 9 }, (_, i) => log.append("mcp:s", `${i}`.repeat(300)));
	// A line is about 465 bytes, so a file holds two: nine events fill five files, and only the last two are kept.
	assert.deepEqual(
		fs.readdirSync(dir).filter((f) => f.startsWith("events.") && f.endsWith(".jsonl")).sort(),
		["events.1.jsonl", "events.jsonl"],
		"one older generation, never more",
	);
	assert.deepEqual(log.since(0), all.slice(6), "the two newest files' events, the older ones gone");
	assert.equal(log.get(all[0].id), undefined);
	assert.ok(fs.statSync(path.join(dir, "events.jsonl")).size <= 1000);
	assert.ok(fs.statSync(path.join(dir, "events.1.jsonl")).size <= 1000);
});

test("[event-log] a torn last line is skipped, and the next append starts a line of its own", () => {
	const dir = tmp("pi-loops-events-torn-");
	const file = path.join(dir, "events.jsonl");
	const log = new EventLog(dir, "background");
	const whole = log.append("mcp:s", "whole");
	fs.appendFileSync(file, '{"id":"evt-torn","received_at":"2026-'); // a crash in the middle of an append
	assert.deepEqual(log.since(0), [whole], "read without throwing");
	const after = log.append("mcp:s", "after");
	assert.deepEqual(log.since(0), [whole, after], "the event after the torn line is whole");
	assert.deepEqual(log.get(after.id), after);
});

test("[push-crash-none-lost] a rotation carries the events a queued row still names into the new file; a flood of pushes does not take them", () => {
	const dir = tmp("pi-loops-events-keep-");
	const kept = new Set<string>();
	const log = new EventLog(dir, "background", { maxBytes: 2_000, keep: () => kept });
	const waiting = log.append("mcp:ci", "a push whose row waits for a slot");
	kept.add(waiting.id);
	const other = log.append("mcp:ci", "a push already checked");
	for (let i = 0; i < 40; i++) log.append("mcp:flood", "x".repeat(200));
	assert.equal(log.get(waiting.id)?.raw, "a push whose row waits for a slot", "still readable after many rotations");
	assert.equal(log.get(other.id), undefined, "an event no row names goes with its generation");
	const lines = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	assert.equal(lines.filter((e) => e.id === waiting.id).length, 1, "carried once, as it was");
	assert.deepEqual(lines.find((e) => e.id === waiting.id), JSON.parse(JSON.stringify(waiting)));
	kept.clear();
	for (let i = 0; i < 40; i++) log.append("mcp:flood", "x".repeat(200));
	assert.equal(log.get(waiting.id), undefined, "once no row names it, it ages out");
});

test("[event-log] a push's receipt is stored beside it: the project its own server pushed for, and its delivery", () => {
	const dir = tmp("pi-loops-events-receipt-");
	const log = new EventLog(dir, "background");
	const own = log.append("mcp:repo", "{}", { project: "/work/a", delivery: "sub_agent" });
	const plain = log.append("gate:dyn-1", "reading");
	assert.deepEqual([log.get(own.id)?.project, log.get(own.id)?.delivery], ["/work/a", "sub_agent"]);
	assert.equal("project" in (log.get(plain.id) ?? {}), false);
	assert.equal("delivery" in (log.get(plain.id) ?? {}), false);
});

test("[push-crash-none-lost] an event a rotation carried is read once, in the place it was first appended", () => {
	const dir = tmp("pi-loops-events-carried-");
	const kept = new Set<string>();
	const log = new EventLog(dir, "background", { maxBytes: 600, keep: () => kept });
	const waiting = log.append("mcp:ci", "a push whose row waits");
	kept.add(waiting.id);
	const after = log.append("mcp:ci", "a push after it");
	const rotated = log.append("gate:x", "x".repeat(400));
	assert.ok(fs.existsSync(path.join(dir, "events.1.jsonl")), "the log rotated");
	assert.deepEqual(log.since(0).map((e) => e.id), [waiting.id, after.id, rotated.id], "each id once, oldest first");
});


test("[push-rederive-on-start] each event gets the number after the last; a rotation's copy keeps its number; with events.seq lost, the numbers go on from the largest in the log", () => {
	const dir = tmp("pi-loops-events-seq-");
	const kept = new Set<string>();
	const log = new EventLog(dir, "background", { maxBytes: 600, keep: () => kept });
	assert.equal(log.lastSeq(), 0, "none stored");
	const a = log.append("mcp:ci", "a");
	kept.add(a.id);
	const b = log.append("mcp:ci", "b");
	assert.deepEqual([a.seq, b.seq, log.lastSeq()], [1, 2, 2]);
	const c = log.append("gate:x", "x".repeat(400));
	assert.ok(fs.existsSync(path.join(dir, "events.1.jsonl")), "the log rotated");
	const copy = lines(path.join(dir, "events.jsonl")).map((l) => JSON.parse(l)).find((e) => e.id === a.id);
	assert.equal(copy?.seq, 1, "the copy keeps its number");
	assert.deepEqual(log.after(1, 0).map((e) => e.id), [b.id, c.id], "after the number, in the order stored");
	assert.deepEqual(log.after(0, Date.now() + 60_000), [], "none received in the window");
	fs.rmSync(path.join(dir, "events.seq"));
	assert.equal(log.append("mcp:ci", "d").seq, 4, "events.seq lost: one more than the largest in the log");
});
