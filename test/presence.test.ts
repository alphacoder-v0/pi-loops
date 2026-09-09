import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PRESENCE_STALE_MS, PresenceRegistry, chooseCwdOwner, isSelf } from "../src/presence.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-presence-"));

test("presence: heartbeat, list, stale pruning, removal", () => {
	const dir = tmp();
	const host = os.hostname();
	const a = new PresenceRegistry(dir, { pid: process.pid, host, instance: "a", sessionId: "s-a", cwd: "/p" });
	const b = new PresenceRegistry(dir, { pid: process.pid, host, instance: "b", sessionId: "s-b", cwd: "/q" });
	const t0 = 1_000_000;
	a.heartbeat(t0);
	b.heartbeat(t0);
	assert.deepEqual(a.list(t0).map((e) => e.instance).sort(), ["a", "b"]);
	// a dead pid on this host is dropped and its file pruned
	fs.writeFileSync(path.join(dir, "presence", `${host}-999999-z.json`), JSON.stringify({ pid: 999999, host, instance: "z", cwd: "/p", heartbeatAt: new Date(t0).toISOString() }));
	assert.deepEqual(a.list(t0).map((e) => e.instance).sort(), ["a", "b"]);
	assert.equal(fs.existsSync(path.join(dir, "presence", `${host}-999999-z.json`)), false);
	// another host is trusted by heartbeat age only
	fs.writeFileSync(path.join(dir, "presence", `other-1-o.json`), JSON.stringify({ pid: 1, host: "other", instance: "o", cwd: "/p", heartbeatAt: new Date(t0).toISOString() }));
	assert.equal(a.list(t0).some((e) => e.host === "other"), true);
	assert.equal(a.list(t0 + PRESENCE_STALE_MS + 1).some((e) => e.host === "other"), false, "stale heartbeat");
	b.remove();
	assert.deepEqual(a.list(t0).map((e) => e.instance), ["a"]);
	a.heartbeat(t0 + 10, { cwd: "/moved", sessionId: "s-a2" });
	assert.deepEqual(a.list(t0 + 10).map((e) => [e.cwd, e.sessionId]), [["/moved", "s-a2"]]);
});

test("chooseCwdOwner: a pi in the project wins over the machine leader; the rules' creating session is preferred; lowest pid breaks ties", () => {
	const at = new Date().toISOString();
	const entries = [
		{ pid: 30, host: "h", instance: "x", sessionId: "s3", cwd: "/p", heartbeatAt: at },
		{ pid: 20, host: "h", instance: "x", sessionId: "s2", cwd: "/p", heartbeatAt: at },
		{ pid: 10, host: "h", instance: "x", sessionId: "s1", cwd: "/q", heartbeatAt: at },
		{ pid: 5, host: "other", instance: "x", sessionId: "s0", cwd: "/p", heartbeatAt: at },
	];
	assert.equal(chooseCwdOwner(entries, "/p", "h")?.pid, 20, "lowest pid in the project on this host");
	assert.equal(chooseCwdOwner(entries, "/p", "h", ["s3"])?.pid, 30, "the session that created the rules is preferred");
	assert.equal(chooseCwdOwner(entries, "/p", "h", ["nope"])?.pid, 20, "unknown preference falls back to lowest pid");
	assert.equal(chooseCwdOwner(entries, "/nowhere", "h"), undefined, "no pi there → caller uses the machine leader");
	assert.equal(isSelf(entries[1], { pid: 20, host: "h", instance: "x", cwd: "/p" }), true);
	assert.equal(isSelf(entries[1], { pid: 20, host: "h", instance: "y", cwd: "/p" }), false);
});
