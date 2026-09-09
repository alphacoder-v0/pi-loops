import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LoopsLog, pruneLogs } from "../src/log.ts";

test("diagnostics survive the window they were printed in", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-log-"));
	const log = new LoopsLog(dir, "pi-123.log");
	log.info("session start: 2 enabled loop(s)");
	log.warn("cron nightly: disabled, cwd /gone no longer exists");
	log.error("state write failed: EACCES");

	const lines = log.tail();
	assert.equal(lines.length, 3);
	assert.match(lines[1], /warn\s+cron nightly: disabled/);
	assert.match(lines[0], /^\d{4}-\d\d-\d\dT/, "each line is timestamped");
	assert.ok(fs.existsSync(log.file), log.file);

	// Secrets never reach the file.
	log.warn("mcp hub: bearer sk-abcdefghijklmnopqrstuvwxyz012345 rejected");
	assert.equal(log.tail(1)[0].includes("sk-abcdefghijklmnopqrstuvwxyz012345"), false);
});

test("the log is rotated and old processes' logs are pruned", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-log2-"));
	// pids that no longer exist, so pruning is free to take them; low numbers like 1 are init.
	const dead = [4_100_001, 4_100_002, 4_100_003, 4_100_004, 4_100_005, 4_100_006, 4_100_007];
	const log = new LoopsLog(dir, `pi-${dead[0]}.log`);
	const filler = "y".repeat(500);
	for (let i = 0; i < 5000; i++) log.info(`${filler} ${i}`);
	assert.ok(fs.statSync(log.file).size < 2_500_000, `bounded (${fs.statSync(log.file).size})`);
	assert.match(log.tail(1)[0], /4999/, "and the newest line is still there");

	for (const n of dead.slice(1)) new LoopsLog(dir, `pi-${n}.log`).info("x");
	// The oldest log of all, but its process is this one — a host that has been up for days is
	// exactly the log someone goes looking for.
	new LoopsLog(dir, `pi-${process.pid}.log`).info("x");
	fs.utimesSync(path.join(dir, "logs", `pi-${process.pid}.log`), 0, 0);
	pruneLogs(dir, 3);
	const left = fs.readdirSync(path.join(dir, "logs")).filter((f) => f.endsWith(".log"));
	assert.equal(left.length, 4, `kept the newest 3 plus the live one, got ${left.join(", ")}`);
	assert.ok(left.includes(`pi-${process.pid}.log`), "a running process's log is never pruned");
});

test("a log directory that cannot be written is not itself a problem", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-log3-"));
	fs.writeFileSync(path.join(dir, "logs"), "not a directory");
	const log = new LoopsLog(dir, "pi-1.log");
	log.warn("this cannot be written anywhere"); // must not throw
	assert.deepEqual(log.tail(), []);
});
