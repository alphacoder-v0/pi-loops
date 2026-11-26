import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { tmp } from "./tmp.ts";
import { HOLD_FILE, HOLD_LINE, holdUpgrade, olderRunningLine, olderStillRunning, resumeUpgrade, upgradeHeld } from "../src/upgrade-hold.ts";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
/** An entry as pi-loops 0.22.8 writes it under `presence/`. */
function presence(dir: string, name: string, over: Record<string, unknown> = {}): void {
	fs.mkdirSync(path.join(dir, "presence"), { recursive: true });
	fs.writeFileSync(path.join(dir, "presence", name), JSON.stringify({ pid: 4242, host: os.hostname(), instance: "i", cwd: "/p", kind: "interactive", heartbeatAt: new Date(NOW - 10_000).toISOString(), ...over }));
}

test("[upgrade-hold] the pause holds while its file is there; resume removes it, and a second resume says nothing was paused", () => {
	const dir = tmp();
	assert.equal(upgradeHeld(dir), false);
	holdUpgrade(dir, NOW);
	assert.equal(upgradeHeld(dir), true);
	assert.deepEqual(resumeUpgrade(dir, NOW, () => false), { resumed: true, held: true });
	assert.equal(upgradeHeld(dir), false);
	assert.deepEqual(resumeUpgrade(dir, NOW, () => false), { resumed: true, held: false });
	assert.match(HOLD_LINE, /pi-loops resume/);
});

test("[upgrade-hold] a hold file that is not a regular file holds nothing, and reading it does not block", { skip: process.platform === "win32" }, () => {
	const dir = tmp();
	assert.equal(spawnSync("mkfifo", [path.join(dir, HOLD_FILE)]).status, 0, "mkfifo");
	assert.equal(upgradeHeld(dir), false);
});

test("[upgrade-hold] resume refuses while pi-loops 0.22 still runs here, by a fresh presence entry of a live pid on this machine", () => {
	const dir = tmp();
	holdUpgrade(dir, NOW);
	presence(dir, "a.json");
	presence(dir, "b.json", { pid: 4343, kind: "host" });
	const refused = resumeUpgrade(dir, NOW, () => true);
	assert.deepEqual(refused, { resumed: false, olderPids: [4242, 4343] });
	assert.equal(upgradeHeld(dir), true, "still paused");
	assert.equal(olderRunningLine([4242, 4343]), "pi-loops 0.22 still runs here (pid 4242, 4343): close that pi, or end it (kill 4242 4343), then run `pi-loops resume` again.");
	assert.deepEqual(resumeUpgrade(dir, NOW, () => false), { resumed: true, held: true }, "the pids are gone: it resumes");
});

test("[upgrade-hold] a stale, future, dead, leasing, foreign, torn, oversized or non-regular presence entry is not pi-loops 0.22 running here", { skip: process.platform === "win32" }, () => {
	const dir = tmp();
	presence(dir, "stale.json", { heartbeatAt: new Date(NOW - 91_000).toISOString() });
	presence(dir, "future.json", { heartbeatAt: new Date(NOW + 91_000).toISOString() });
	presence(dir, "leasing.json", { leases: true });
	presence(dir, "elsewhere.json", { host: "another-machine" });
	presence(dir, "zero.json", { pid: 0 });
	fs.writeFileSync(path.join(dir, "presence", "torn.json"), "{not json");
	fs.writeFileSync(path.join(dir, "presence", "big.json"), JSON.stringify({ pid: 4242, host: os.hostname(), heartbeatAt: new Date(NOW).toISOString(), cwd: "x".repeat(20_000) }));
	assert.equal(spawnSync("mkfifo", [path.join(dir, "presence", "fifo.json")]).status, 0, "mkfifo");
	fs.symlinkSync("/dev/zero", path.join(dir, "presence", "zero-link.json"));
	assert.deepEqual(olderStillRunning(dir, NOW, () => true), []);
	presence(dir, "dead.json");
	assert.deepEqual(olderStillRunning(dir, NOW, () => false), [], "a pid that is gone");
	assert.deepEqual(olderStillRunning(tmp(), NOW, () => true), [], "no presence directory");
});
