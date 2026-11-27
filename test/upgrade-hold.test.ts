import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { tmp } from "./tmp.ts";
import { HOLD_FILE, HOLD_LINE, holdUpgrade, olderBackground, olderRunningLine, olderStillRunning, resumeUpgrade, upgradeHeld } from "../src/upgrade-hold.ts";
import { procStart } from "../src/lease.ts";
import { RunList } from "../src/run-list.ts";

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
	assert.equal(olderRunningLine([4242, 4343]), "an older pi-loops still runs here (pid 4242, 4343): close that pi, or end it (kill 4242 4343), then run `pi-loops resume` again.");
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

test("[upgrade-hold] resume refuses while an older pi-loops in the background still runs here, by host-service.json; a newer one, a dead one or a recycled pid is not it", () => {
	const dir = tmp();
	holdUpgrade(dir, NOW);
	const service = (over: Record<string, unknown>) => fs.writeFileSync(path.join(dir, "host-service.json"), JSON.stringify({ v: 1, pid: process.pid, procStart: procStart(process.pid), version: "0.22.8", startedAt: "x", entry: "e", node: "n", dir, socket: "s", token: "t", ...over }));
	// 0.22.8: lower than any version this is tested at (the release bumps package.json to 0.24.3).
	service({});
	assert.equal(olderBackground(dir, () => true), process.pid);
	assert.deepEqual(resumeUpgrade(dir, NOW, () => true), { resumed: false, olderPids: [process.pid] });
	service({ version: "99.0.0" });
	assert.equal(olderBackground(dir, () => true), undefined, "a newer one");
	service({});
	assert.equal(olderBackground(dir, () => false), undefined, "a dead one");
	service({ procStart: "another start" });
	assert.equal(olderBackground(dir, () => true), undefined, "a recycled pid");
	assert.deepEqual(resumeUpgrade(dir, NOW, () => true), { resumed: true, held: true });
});

test("[upgrade-hold] a run list that is held claims no row, and writes no claim", () => {
	let held = true;
	const list = new RunList(() => held);
	const claims: string[] = [];
	const requests = { claim: (_lane: string, id: string) => { claims.push(id); return true; } };
	const row = { id: "r1", lane: "@cron-a", kind: "input" } as any;
	const run = { jobId: "a", label: "a", promptPreview: "", ctrl: new AbortController() };
	assert.equal(list.claim(requests as any, row, { pid: 1, procStart: undefined }, run, NOW), undefined);
	assert.deepEqual([claims, list.all()], [[], []]);
	held = false;
	assert.ok(list.claim(requests as any, row, { pid: 1, procStart: undefined }, run, NOW));
	assert.deepEqual(claims, ["r1"]);
});
