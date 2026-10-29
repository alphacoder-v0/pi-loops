import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { claimHostService, decideEnsure, decideEviction, evictHost, HOST_SERVICE_FILE, HOST_SPAWNS_FILE, hostServiceNames, readHostService, readSpawnLog, recordSpawn, removeHostService, type EnsureInput, type HostServiceRecord } from "../src/host-control.ts";
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
	assert.deepEqual(decideEnsure(base({ automation, stopped: true })), { kind: "none", reason: "stopped (/cron host start resumes it)" });
	for (const over of [{ auto: false }, { stopped: true }]) assert.deepEqual(decideEnsure(base({ ...over, host: { version: "1.0.0" } })), { kind: "none", reason: "running" });
});

test("decideEnsure upgrades newer versions and leaves equal, older or draining hosts alone", () => {
	const run = (host: EnsureInput["host"], over: Partial<EnsureInput> = {}) => decideEnsure(base({ host, ...over }));
	assert.deepEqual(run({ version: "0.9.0" }), { kind: "upgrade" });
	assert.deepEqual(run({ version: "1.0.0" }), { kind: "none", reason: "running" });
	assert.deepEqual(run({ version: "1.1.0" }), { kind: "none", reason: "running" });
	assert.deepEqual(run({ version: "1.0.0", piVersion: "0.84.3" }, { myPiVersion: "0.85.0" }), { kind: "upgrade" });
	assert.deepEqual(run({ version: "0.9.0", draining: true }), { kind: "none", reason: "draining" });
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
