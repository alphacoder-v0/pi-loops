import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { tmp } from "./tmp.ts";
import { claimHostService, clearCrashes, decideEnsure, decideEviction, ensureHost, evictHost, heartbeatFresh, HOST_SERVICE_FILE, HOST_SPAWNS_FILE, hostServiceNames, hostCommand, nodeOnPath, readHostService, readSpawnLog, recentCrashes, recordCrash, recordSpawn, removeHostService, updateHostService, type EnsureInput, type HostServiceRecord } from "../src/host-control.ts";
import { spawn } from "node:child_process";
import { procStart } from "../src/lease.ts";
import { compareVersions } from "../src/pi-floor.ts";

const base = (over: Partial<EnsureInput> = {}): EnsureInput => ({ automation: { loops: 0, rules: 0, pushServers: 0 }, auto: true, stopped: false, envOff: false, now: 1_000_000, spawns: { attempts: [] }, myVersion: "1.0.0", ...over });
const record = (pid: number, over: Partial<HostServiceRecord> = {}): HostServiceRecord => ({ v: 1, pid, startedAt: "2026-10-29T00:00:00Z", version: "1.0.0", entry: "host-entry.mjs", node: "/node", dir: "/loops", socket: "/loops/host-service.sock", token: "secret", managed: "spawned", ...over });

test("decideEnsure starts only when automation exists", () => {
	assert.deepEqual(decideEnsure(base()), { kind: "none", reason: "nothing to run" });
	for (const key of ["loops", "rules", "pushServers"] as const) {
		assert.deepEqual(decideEnsure(base({ automation: { loops: 0, rules: 0, pushServers: 0, [key]: 1 } })), { kind: "spawn" });
	}
});

test("decideEnsure honors envOff before a running host", () => {
	assert.deepEqual(decideEnsure(base({ envOff: true, host: { version: "1.0.0" } })), { kind: "none", reason: "PI_LOOPS_HOST=off" });
});

test("auto and stopped prevent spawning but do not affect a running host", () => {
	const automation = { loops: 1, rules: 0, pushServers: 0 };
	assert.deepEqual(decideEnsure(base({ automation, auto: false })), { kind: "none", reason: "[host] auto = false" });
	assert.deepEqual(decideEnsure(base({ automation, stopped: true })), { kind: "none", reason: "stopped (/pi-loops start resumes it)" });
	for (const over of [{ auto: false }, { stopped: true }]) assert.deepEqual(decideEnsure(base({ ...over, host: { version: "1.0.0" } })), { kind: "none", reason: "running" });
});

test("a host asked for by name starts with nothing to run, auto off or a backoff pending, but not past a stop or PI_LOOPS_HOST=off", () => {
	const spawns = { attempts: [], notBefore: "2099-01-01T00:00:00Z" };
	assert.deepEqual(decideEnsure(base({ asked: true })), { kind: "spawn" });
	assert.deepEqual(decideEnsure(base({ asked: true, auto: false, spawns })), { kind: "spawn" });
	assert.deepEqual(decideEnsure(base({ asked: true, stopped: true })), { kind: "none", reason: "stopped (/pi-loops start resumes it)" });
	assert.deepEqual(decideEnsure(base({ asked: true, envOff: true })), { kind: "none", reason: "PI_LOOPS_HOST=off" });
	assert.deepEqual(decideEnsure(base({ asked: true, host: { version: "1.0.0" } })), { kind: "none", reason: "running" });
});

test("decideEnsure upgrades newer versions and leaves equal or older hosts alone", () => {
	const run = (host: EnsureInput["host"], over: Partial<EnsureInput> = {}) => decideEnsure(base({ host, ...over }));
	assert.deepEqual(run({ version: "0.9.0" }), { kind: "upgrade" });
	assert.deepEqual(run({ version: "1.0.0" }), { kind: "none", reason: "running" });
	assert.deepEqual(run({ version: "1.1.0" }), { kind: "none", reason: "running" });
	assert.deepEqual(run({ version: "1.0.0", piVersion: "0.84.3" }, { myPiVersion: "0.85.0" }), { kind: "upgrade" });
});

test("decideEnsure respects backoff and recent in-progress attempts", () => {
	const automation = { loops: 1, rules: 0, pushServers: 0 };
	const notBefore = "2026-10-29T00:20:00Z";
	assert.deepEqual(decideEnsure(base({ automation, spawns: { attempts: [], notBefore } })), { kind: "none", reason: `backing off until ${notBefore}` });
	assert.deepEqual(decideEnsure(base({ automation, spawns: { attempts: [{ at: "1970-01-01T00:16:35.000Z", by: 1 }] } })), { kind: "none", reason: "a start is in progress" });
	assert.deepEqual(decideEnsure(base({ automation, spawns: { attempts: [{ at: "1970-01-01T00:16:20.000Z", by: 1 }] } })), { kind: "spawn" });
});

test("recordSpawn grows backoff, clears on up, skips evictions and keeps twenty attempts", () => {
	const dir = tmp("pi-loops-spawns-");
	let log = recordSpawn(dir, { kind: "outcome", by: 1, outcome: "died" }, 1_000_000);
	assert.equal(Date.parse(log.notBefore!) - 1_000_000, 60_000);
	log = recordSpawn(dir, { kind: "outcome", by: 2, outcome: "no-node" }, 2_000_000);
	assert.equal(Date.parse(log.notBefore!) - 2_000_000, 300_000);
	log = recordSpawn(dir, { kind: "outcome", by: 3, outcome: "died" }, 3_000_000);
	assert.equal(Date.parse(log.notBefore!) - 3_000_000, 1_800_000);
	log = recordSpawn(dir, { kind: "outcome", by: 4, outcome: "evicted" }, 4_000_000);
	assert.equal(Date.parse(log.notBefore!) - 4_000_000, 1_800_000);
	log = recordSpawn(dir, { kind: "outcome", by: 5, outcome: "up" }, 5_000_000);
	assert.equal(log.notBefore, undefined);
	for (let by = 6; by < 30; by++) recordSpawn(dir, { kind: "attempt", by }, by * 1_000);
	assert.equal(readSpawnLog(dir).attempts.length, 20);
});

test("claimHostService serializes claims and writes a private record", () => {
	const dir = tmp("pi-loops-claim-");
	assert.deepEqual(claimHostService(dir, record(10), () => true), { claimed: true });
	assert.equal(fs.statSync(path.join(dir, HOST_SERVICE_FILE)).mode & 0o777, 0o600);
	assert.deepEqual(claimHostService(dir, record(11), () => true), { claimed: false, other: record(10) });
	assert.deepEqual(claimHostService(dir, record(11), () => false), { claimed: true });
	assert.equal(readHostService(dir)?.pid, 11);
	const raceDir = tmp("pi-loops-claim-race-");
	const results = [claimHostService(raceDir, record(20), () => true), claimHostService(raceDir, record(21), () => true)];
	assert.equal(results.filter((r) => r.claimed).length, 1);
});

test("removeHostService is pid guarded and hostServiceNames checks pid and start", () => {
	const dir = tmp("pi-loops-remove-");
	claimHostService(dir, record(31), () => false);
	assert.equal(removeHostService(dir, 32), false);
	assert.equal(hostServiceNames(dir, 31, record(31).startedAt), true);
	assert.equal(hostServiceNames(dir, 31, "other"), false);
	assert.equal(removeHostService(dir, 31), true);
});

test("decideEviction counts tick failures only and requires a matching pid", () => {
	assert.deepEqual(decideEviction({ failures: 2, probeOk: false, fromTick: true, pidMatches: true }), { failures: 0, evict: true });
	assert.deepEqual(decideEviction({ failures: 2, probeOk: false, fromTick: false, pidMatches: true }), { failures: 2, evict: false });
	assert.deepEqual(decideEviction({ failures: 2, probeOk: true, fromTick: true, pidMatches: true }), { failures: 0, evict: false });
	assert.deepEqual(decideEviction({ failures: 100, probeOk: false, fromTick: true, pidMatches: false }), { failures: 101, evict: false });
});

test("evictHost signals, removes only its record and records eviction", async () => {
	const dir = tmp("pi-loops-evict-");
	claimHostService(dir, record(41), () => false);
	const signals: NodeJS.Signals[] = [];
	await evictHost(dir, 41, { graceMs: 1, kill: (_pid, signal) => signals.push(signal), alive: () => true });
	assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
	assert.equal(readHostService(dir), undefined);
	assert.equal(readSpawnLog(dir).attempts.at(-1)?.outcome, "evicted");
	claimHostService(dir, record(42), () => false);
	await evictHost(dir, 41, { graceMs: 1, kill: (_pid, signal) => signals.push(signal), alive: () => false });
	assert.equal(readHostService(dir)?.pid, 42);
	const exits: NodeJS.Signals[] = [];
	await evictHost(dir, 42, { graceMs: 2, kill: (_pid, signal) => exits.push(signal), alive: () => exits.length === 0 });
	assert.deepEqual(exits, ["SIGTERM"]);
});

test("compareVersions compares numeric components and treats invalid versions as zero", () => {
	assert.equal(compareVersions("0.23.0", "0.22.8"), 1);
	assert.equal(compareVersions("0.22.10", "0.22.9"), 1);
	assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
	assert.equal(compareVersions("garbage", "0.0.0"), 0);
});

test("updateHostService adds the page's URL to the host's own record and to no other", () => {
	const dir = tmp("pi-loops-host-");
	claimHostService(dir, record(1234), () => false);
	assert.equal(updateHostService(dir, 999, { url: "http://127.0.0.1:1/" }), false);
	assert.equal(readHostService(dir)?.url, undefined);
	assert.equal(updateHostService(dir, 1234, { url: "http://127.0.0.1:4174/" }), true);
	assert.deepEqual(readHostService(dir), { ...record(1234), url: "http://127.0.0.1:4174/" });
	assert.equal(fs.statSync(path.join(dir, HOST_SERVICE_FILE)).mode & 0o777, 0o600);
});

test("the background process's command line runs the entry through pi's resolver, in the loops directory", () => {
	const cmd = hostCommand({ dir: "/home/u/.pi/agent/loops", packageDir: "/pkg", piPackage: "/pi", node: "/usr/bin/node", nodeVersion: "v24.0.0" });
	assert.equal(cmd.node, "/usr/bin/node");
	assert.deepEqual(cmd.args, ["--import", "/pkg/src/register-pi.mjs", "/pkg/src/host-entry.mjs"]);
	assert.equal(cmd.env.PI_LOOPS_DIR, "/home/u/.pi/agent/loops");
	assert.equal(cmd.env.PI_LOOPS_PI_PACKAGE, "/pi");
});

test("three crashes at one window's pace pause the host, and it stays paused until a person starts it", () => {
	const dir = tmp("pi-loops-host-");
	const t0 = Date.parse("2026-10-29T12:00:00Z");
	// A single window respawns on its 30 s tick: three crashes take about a minute and a half.
	for (const dt of [0, 30_000, 60_000]) recordCrash(dir, "boom", t0 + dt);
	const spawns = readSpawnLog(dir);
	assert.ok(spawns.pausedAt, "the budget ran out");
	const automation = { loops: 1, rules: 0, pushServers: 0 };
	const paused = decideEnsure(base({ automation, spawns, now: t0 + 90_000 }));
	assert.equal(paused.kind, "none");
	assert.match((paused as any).reason, /^paused: pi-loops stopped unexpectedly 3 times within 5 minutes/);
	assert.equal(decideEnsure(base({ automation, spawns, now: t0 + 3_600_000 })).kind, "none", "an hour later it is still paused");
	assert.deepEqual(decideEnsure(base({ automation, spawns, now: t0 + 90_000, asked: true })), { kind: "spawn" }, "/pi-loops start overrides it");
	clearCrashes(dir);
	assert.deepEqual([readSpawnLog(dir).crashes, readSpawnLog(dir).pausedAt], [undefined, undefined]);
	const spread = tmp("pi-loops-host-");
	for (const dt of [0, 400_000, 800_000]) recordCrash(spread, "boom", t0 + dt);
	assert.equal(readSpawnLog(spread).pausedAt, undefined, "crashes far apart do not pause it");
});

test("an older client does not start its old host while the newer one that asked for the upgrade lives", () => {
	const automation = { loops: 1, rules: 0, pushServers: 0 };
	const upgrader = { pid: 4242, version: "1.1.0" };
	assert.deepEqual(decideEnsure(base({ automation, upgrader: { ...upgrader, alive: true } })), { kind: "none", reason: "a newer pi-loops (pid 4242) is already running" });
	assert.deepEqual(decideEnsure(base({ automation, upgrader: { ...upgrader, alive: false } })), { kind: "spawn" }, "once it is gone, the older one starts its own");
	assert.deepEqual(decideEnsure(base({ automation, myVersion: "1.1.0", upgrader: { ...upgrader, alive: true } })), { kind: "spawn" }, "the same version is not held back");
});

test("an unanswered socket evicts only a host whose heartbeat stopped too", () => {
	const third = { failures: 2, probeOk: false, fromTick: true, pidMatches: true };
	assert.deepEqual(decideEviction({ ...third, heartbeatFresh: true }), { failures: 3, evict: false, channelBroken: true }, "running, channel broken: left alone");
	assert.deepEqual(decideEviction({ ...third, heartbeatFresh: false }), { failures: 0, evict: true });
	const now = Date.parse("2026-10-29T12:00:00Z");
	assert.equal(heartbeatFresh({ tickAt: "2026-10-29T11:59:00Z" }, now), true);
	assert.equal(heartbeatFresh({ tickAt: "2026-10-29T11:58:00Z" }, now), false);
	assert.equal(heartbeatFresh({}, now), false);
});

test("a record naming a dead host counts as a crash once and is cleared", async () => {
	const dir = tmp("pi-loops-host-");
	const { spawnSync } = await import("node:child_process");
	const dead = spawnSync("true").pid!;
	claimHostService(dir, record(dead), () => false);
	await ensureHost({ dir, packageDir: "/nowhere", automation: { loops: 0, rules: 0, pushServers: 0 }, auto: true, stopped: false, myVersion: "1.0.0" });
	assert.equal(readHostService(dir), undefined, "the stale record is gone");
	assert.equal(readSpawnLog(dir).crashes?.length, 1);
	await ensureHost({ dir, packageDir: "/nowhere", automation: { loops: 0, rules: 0, pushServers: 0 }, auto: true, stopped: false, myVersion: "1.0.0" });
	assert.equal(readSpawnLog(dir).crashes?.length, 1, "and is not counted twice");
	// Several windows finding the same dead record at once: only the one that removes it counts it.
	claimHostService(dir, record(dead), () => false);
	assert.equal(removeHostService(dir, dead), true);
	assert.equal(removeHostService(dir, dead), false, "the second finder removes nothing, so counts nothing");
});

test("a new host that claims over a dead host's record counts that crash", async () => {
	const dir = tmp("pi-loops-host-");
	const { spawnSync } = await import("node:child_process");
	claimHostService(dir, record(spawnSync("true").pid!), () => false);
	claimHostService(dir, record(process.pid), () => false);
	assert.equal(readSpawnLog(dir).crashes?.length, 1);
});

test("under bun the host runs on the node found on PATH", () => {
	const pathEnv = ["/opt/bun/bin", "/usr/local/bin", "/usr/bin"].join(":");
	assert.equal(nodeOnPath(pathEnv, (f) => f === "/usr/local/bin/node" || f === "/usr/bin/node"), "/usr/local/bin/node");
	assert.equal(nodeOnPath(pathEnv, () => false), undefined);
	assert.equal(nodeOnPath(["node_modules/.bin", ".", "", "/usr/bin"].join(":"), () => true), "/usr/bin/node", "a relative entry would run a project's binary: skipped");
	// `bun run`, `npx` and direnv put absolute project paths on PATH too: those are the project's binaries as well.
	assert.equal(nodeOnPath(["/work/repo/node_modules/.bin", "/work/repo/bin", "/home/u/x/node_modules/.bin", "/usr/bin"].join(":"), () => true, "/work/repo"), "/usr/bin/node", "inside the project, or any node_modules: skipped");
	// From a subdirectory, the project's root `bin` (direnv's `PATH_add bin`) and a symlink to it are the project's too.
	const repo = tmp("pi-loops-repo-");
	fs.mkdirSync(path.join(repo, ".git"));
	fs.mkdirSync(path.join(repo, "bin"));
	fs.mkdirSync(path.join(repo, "sub"));
	const link = path.join(tmp("pi-loops-link-"), "bin");
	fs.symlinkSync(path.join(repo, "bin"), link);
	assert.equal(nodeOnPath([path.join(repo, "bin"), link, "/usr/bin"].join(":"), () => true, path.join(repo, "sub")), "/usr/bin/node", "the repository root, and a link into it: skipped");
	const home = os.homedir();
	assert.equal(nodeOnPath([path.join(home, ".nvm", "versions", "node", "v24", "bin")].join(":"), () => true, home), path.join(home, ".nvm", "versions", "node", "v24", "bin", "node"), "opened in the home directory: that is no project, and nvm lives there");
});
