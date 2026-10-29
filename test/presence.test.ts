import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PRESENCE_STALE_MS, PresenceRegistry, isSelf, olderPiOnSession } from "../src/presence.ts";


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
