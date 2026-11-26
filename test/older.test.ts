import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { LeaseBinding, LeaseStore, type LeaseHolder, type ProcessProbe } from "../src/lease.ts";
import { olderPiLoops, waitingLine, type OlderPiLoops } from "../src/older.ts";
import { PI_LOOPS_VERSION } from "../src/version.ts";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const probe = (over: Partial<ProcessProbe> = {}): ProcessProbe => ({ alive: () => true, startTime: () => "start", bootedAt: () => Date.parse("2026-11-01T00:00:00Z"), ...over });

/** An entry as pi-loops 0.22.8 writes it under `presence/` (v0.22.8 src/presence.ts). */
function presence(dir: string, over: Record<string, unknown> = {}): void {
	const entry = { pid: 4242, host: os.hostname(), instance: "i1", sessionId: "s-old", cwd: "/home/p/proj", kind: "interactive", heartbeatAt: new Date(NOW - 10_000).toISOString(), ...over };
	fs.mkdirSync(path.join(dir, "presence"), { recursive: true });
	fs.writeFileSync(path.join(dir, "presence", `${String(entry.host)}-${String(entry.pid)}-${String(entry.instance)}.json`), `${JSON.stringify(entry)}\n`);
}

/** A lease as pi-loops 0.24.2 writes it: the same shape as this version's, with no `version`. */
function lease(dir: string, sessionId: string, holder: Partial<LeaseHolder> & { version?: string } = {}, cwd = "/home/p/other"): void {
	const h = { kind: "terminal", pid: 5151, instance: "t1", procStart: "start", acquiredAt: new Date(NOW - 60_000).toISOString(), pushServers: [], ...holder };
	fs.mkdirSync(path.join(dir, "leases"), { recursive: true });
	fs.writeFileSync(path.join(dir, "leases", `${sessionId}.json`), `${JSON.stringify({ v: 1, sessionId, cwd, epoch: 1, holder: h, updatedAt: h.acquiredAt })}\n`);
}

test("[older-presence] a fresh presence entry of a live 0.22 window is an older pi-loops; a stale, dead or leasing one is not", () => {
	const fresh = tmp();
	presence(fresh);
	assert.deepEqual(olderPiLoops(fresh, NOW, probe()), [{ version: "0.22", kind: "window", pid: 4242, where: "/home/p/proj" }]);

	const background = tmp();
	presence(background, { kind: "host", cwd: "" });
	assert.deepEqual(olderPiLoops(background, NOW, probe()), [{ version: "0.22", kind: "background", pid: 4242 }]);

	const stale = tmp();
	presence(stale, { heartbeatAt: new Date(NOW - 91_000).toISOString() });
	assert.deepEqual(olderPiLoops(stale, NOW, probe()), [], "0.22 itself prunes an entry older than 90 s");

	const dead = tmp();
	presence(dead);
	assert.deepEqual(olderPiLoops(dead, NOW, probe({ alive: () => false })), [], "a pid that is gone");

	const leasing = tmp();
	presence(leasing, { leases: true });
	assert.deepEqual(olderPiLoops(leasing, NOW, probe()), [], "an entry with `leases` was written by a build that takes leases");

	const elsewhere = tmp();
	presence(elsewhere, { host: "another-machine" });
	assert.deepEqual(olderPiLoops(elsewhere, NOW, probe({ alive: () => false })), [{ version: "0.22", kind: "window", pid: 4242, where: "/home/p/proj" }], "a pid on another machine cannot be probed: the heartbeat decides");

	const torn = tmp();
	fs.mkdirSync(path.join(torn, "presence"));
	fs.writeFileSync(path.join(torn, "presence", "x.json"), "{not json");
	fs.writeFileSync(path.join(torn, "presence", "y.json"), JSON.stringify({ pid: "1", heartbeatAt: new Date(NOW).toISOString() }));
	assert.deepEqual(olderPiLoops(torn, NOW, probe()), []);
	assert.deepEqual(olderPiLoops(tmp(), NOW, probe()), [], "no presence directory, no leases");
});

test("[older-lease] a live holder of a lease with no `version` is an older pi-loops; one with a version, or a dead holder, is not", () => {
	const old = tmp();
	lease(old, "s1");
	assert.deepEqual(olderPiLoops(old, NOW, probe()), [{ version: "0.24", kind: "window", pid: 5151, where: "/home/p/other" }]);

	const oldHost = tmp();
	lease(oldHost, "s1", { kind: "host" });
	assert.deepEqual(olderPiLoops(oldHost, NOW, probe()), [{ version: "0.24", kind: "background", pid: 5151, where: "/home/p/other" }]);

	const current = tmp();
	lease(current, "s1", { version: "0.24.3" });
	assert.deepEqual(olderPiLoops(current, NOW, probe()), []);

	const recycled = tmp();
	lease(recycled, "s1");
	assert.deepEqual(olderPiLoops(recycled, NOW, probe({ startTime: () => "another start" })), [], "the pid is alive but is another process");

	const free = tmp();
	lease(free, "s1");
	const file = path.join(free, "leases", "s1.json");
	fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), holder: null }));
	assert.deepEqual(olderPiLoops(free, NOW, probe()), [], "a lease nobody holds");

	const both = tmp();
	presence(both);
	lease(both, "s1");
	lease(both, "s2", { pid: 5151, instance: "t1" }, "/home/p/third");
	assert.deepEqual(olderPiLoops(both, NOW, probe()).map((o) => `${o.version}:${o.pid}`), ["0.22:4242", "0.24:5151"], "one entry per process, 0.22 first");
});

test("[older-lease] every lease this version writes carries its version", () => {
	const dir = tmp();
	const store = new LeaseStore(dir);
	const binding = new LeaseBinding(store, "w1", () => ({ kind: "terminal", pid: process.pid, procStart: undefined, pushServers: [] }));
	binding.bind("s-new", { cwd: "/p" });
	assert.equal(store.read("s-new")?.holder?.version, PI_LOOPS_VERSION);
	assert.deepEqual(olderPiLoops(dir, Date.now()), [], "this process's own lease is not an older pi-loops");
});

test("[older-line] the line names the version, the pid, where it is open, and what to do", () => {
	const window22: OlderPiLoops = { version: "0.22", kind: "window", pid: 4242, where: "/home/p/proj" };
	const window24: OlderPiLoops = { version: "0.24", kind: "window", pid: 5151, where: "/home/p/other" };
	const background: OlderPiLoops = { version: "0.22", kind: "background", pid: 77 };
	assert.equal(waitingLine([], "0.24.3"), undefined);
	assert.equal(waitingLine([window22], "0.24.3"), "pi-loops 0.24.3 is waiting: a pi window with pi-loops 0.22 (pid 4242, /home/p/proj) is still open. Close it, and pi-loops 0.24.3 starts within 30 seconds. Until then, that window runs your loops.");
	assert.equal(waitingLine([window24], "0.24.3"), "pi-loops 0.24.3 is waiting: a pi terminal with pi-loops 0.24.2 or earlier (pid 5151, /home/p/other) is still open. Restart it, and pi-loops 0.24.3 starts within 30 seconds. Until then, no loop or rule runs.");
	assert.equal(waitingLine([background], "0.24.3"), "pi-loops 0.24.3 is waiting: pi-loops 0.22 in the background (pid 77) is still running. End it (kill 77), and pi-loops 0.24.3 starts within 30 seconds.");
	assert.equal(waitingLine([window22, window24, background], "0.24.3"), `${waitingLine([window22], "0.24.3")} 2 more older pi-loops processes are open: pids 5151, 77.`);
});
