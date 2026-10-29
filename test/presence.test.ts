import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PRESENCE_STALE_MS, PresenceRegistry, chooseCwdOwner, chooseRuleOwner, isSelf, olderPiOnSession } from "../src/presence.ts";


test("presence: heartbeat, list, stale pruning, removal", () => {
	const dir = tmp("pi-loops-presence-");
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

test("chooseCwdOwner: a pi in the project wins over the machine leader; lowest pid breaks ties", () => {
	const at = new Date().toISOString();
	const entries = [
		{ pid: 30, host: "h", instance: "x", sessionId: "s3", cwd: "/p", heartbeatAt: at },
		{ pid: 20, host: "h", instance: "x", sessionId: "s2", cwd: "/p", heartbeatAt: at },
		{ pid: 10, host: "h", instance: "x", sessionId: "s1", cwd: "/q", heartbeatAt: at },
		{ pid: 5, host: "other", instance: "x", sessionId: "s0", cwd: "/p", heartbeatAt: at },
	];
	assert.equal(chooseCwdOwner(entries, "/p", "h")?.pid, 20, "lowest pid in the project on this host");
	assert.equal(chooseCwdOwner(entries, "/nowhere", "h"), undefined, "no pi there → caller uses the machine leader");
	assert.equal(isSelf(entries[1], { pid: 20, host: "h", instance: "x", cwd: "/p" }), true);
	assert.equal(isSelf(entries[1], { pid: 20, host: "h", instance: "y", cwd: "/p" }), false);
});

test("chooseRuleOwner: the session that created a rule owns it, whatever its pid; the cwd owner only inherits when it is gone", () => {
	const at = new Date().toISOString();
	const entries = [
		{ pid: 20, host: "h", instance: "a", sessionId: "s1", cwd: "/p", heartbeatAt: at },
		{ pid: 30, host: "h", instance: "b", sessionId: "s2", cwd: "/p", heartbeatAt: at },
	];
	assert.equal(chooseRuleOwner(entries, "/p", "h", "s2")?.pid, 30, "a rule created in the second window is checked there, not in the lower-pid one");
	assert.equal(chooseRuleOwner(entries, "/p", "h", "s1")?.pid, 20);
	assert.equal(chooseRuleOwner(entries, "/p", "h", "gone")?.pid, 20, "creating session closed → the project's cwd owner");
	assert.equal(chooseRuleOwner(entries, "/p", "h")?.pid, 20, "a rule with no recorded session (pre-0.1.3) → the cwd owner");
	assert.equal(chooseRuleOwner(entries, "/nowhere", "h", "gone"), undefined, "nobody → the machine leader");
});

test("a pi below the rule's cwd still owns it through a symlinked subdirectory", () => {
	const dir = fs.realpathSync(tmp("pi-loops-presence-"));
	const proj = path.join(dir, "proj");
	fs.mkdirSync(path.join(proj, "src"), { recursive: true });
	fs.symlinkSync(proj, path.join(dir, "link"));
	const at = new Date().toISOString();
	const entries = [{ pid: 20, host: "h", instance: "a", sessionId: "s1", cwd: path.join(dir, "link", "src"), heartbeatAt: at }];
	assert.equal(chooseCwdOwner(entries, proj, "h")?.pid, 20);
});

test("a presence entry with the same session and no leases flag produces the warning; one with the flag does not", () => {
	const self = { pid: 1, host: "h", instance: "me", sessionId: "s", cwd: "/p", leases: true as const };
	const entry = (over: Record<string, unknown>) => ({ pid: 2, host: "h", instance: "x", sessionId: "s", cwd: "/p", heartbeatAt: "2026-01-01T00:00:00Z", ...over }) as any;
	assert.equal(olderPiOnSession([entry({})], "s", self)?.pid, 2, "a 0.22.x pi on this conversation");
	assert.equal(olderPiOnSession([entry({ leases: true })], "s", self), undefined, "a lease-aware build is a viewer, not a second firer");
	assert.equal(olderPiOnSession([entry({ sessionId: "other" })], "s", self), undefined);
	assert.equal(olderPiOnSession([{ ...self, heartbeatAt: "x" }], "s", self), undefined, "not ourselves");
	assert.equal(olderPiOnSession([entry({ kind: "host" })], "s", self), undefined);
	assert.equal(olderPiOnSession([entry({})], undefined, self), undefined);
});
