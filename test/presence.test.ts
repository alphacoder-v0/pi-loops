import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PRESENCE_STALE_MS, PresenceRegistry, chooseCwdOwner, chooseRuleOwner, isSelf, withinProject } from "../src/presence.ts";


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

test("project identity is a realpath and includes subdirectories, so a pi below the rule's cwd still owns it", () => {
	const dir = fs.realpathSync(tmp("pi-loops-presence-"));
	const proj = path.join(dir, "proj");
	fs.mkdirSync(path.join(proj, "src"), { recursive: true });
	fs.symlinkSync(proj, path.join(dir, "link"));
	assert.equal(withinProject(proj, path.join(proj, "src")), true, "a subdirectory is the same project");
	assert.equal(withinProject(proj, path.join(dir, "link")), true, "so is a symlink to it");
	assert.equal(withinProject(proj, path.join(dir, "link", "src")), true);
	assert.equal(withinProject(path.join(proj, "src"), proj), false, "but the parent is not inside the project");
	assert.equal(withinProject(proj, path.join(dir, "other")), false);

	const at = new Date().toISOString();
	const entries = [{ pid: 20, host: "h", instance: "a", sessionId: "s1", cwd: path.join(dir, "link", "src"), heartbeatAt: at }];
	assert.equal(chooseCwdOwner(entries, proj, "h")?.pid, 20, "a rule created at the project root is still owned by a pi opened in a symlinked subdirectory");
});
