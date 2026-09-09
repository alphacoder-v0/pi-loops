import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ARCHIVE_SCHEMA, defaultExportPath, exportSession, importSession, readTar, writeTar } from "../src/archive.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-arc-"));

test("tar round trip is readable by GNU tar and by readTar", async () => {
	const dir = tmp();
	const buf = writeTar([{ name: "a.txt", data: Buffer.from("hello") }, { name: "d/b.bin", data: Buffer.alloc(1000, 7) }]);
	fs.writeFileSync(path.join(dir, "t.tar"), buf);
	const back = readTar(buf);
	assert.equal(back.get("a.txt")!.toString(), "hello");
	assert.equal(back.get("d/b.bin")!.length, 1000);
	const { execFileSync } = await import("node:child_process");
	const listing = execFileSync("tar", ["tf", path.join(dir, "t.tar")]).toString().trim().split("\n");
	assert.deepEqual(listing, ["a.txt", "d/b.bin"]);
});

function fakeSession(dir: string): string {
	const file = path.join(dir, "2026-09-08T10-00-00-000Z_orig-id.jsonl");
	fs.writeFileSync(file, [JSON.stringify({ type: "session", version: 3, id: "orig-id", timestamp: "2026-09-08T10:00:00.000Z", cwd: "/old/project" }), JSON.stringify({ type: "message", id: "a", message: { role: "user", content: "hi" } }), JSON.stringify({ type: "message", id: "b", parentId: "a", message: { role: "assistant", content: [{ type: "text", text: "yo" }] } })].join("\n") + "\n");
	return file;
}

test("export bundles session + cron + triggers + loop state; import rewrites like pie and restores state", () => {
	const dir = tmp();
	const sessionFile = fakeSession(dir);
	const job: any = { id: "cron-aaaaaaaa", name: "watch", schedule: { kind: "cron", expr: "0 9 * * *" }, stateful: true, prompt: "watch issues", cwd: "/old/project", enabled: true, catchUp: true, createdAt: "t", runCount: 3, skippedOverlap: 2, lastError: "boom", running: { runId: "r", pid: 1, startedAt: "t" }, lastDueAt: "t" };
	const inject: any = { ...job, id: "cron-bbbbbbbb", name: "ping", stateful: false, sessionId: "orig-id", enabled: false };
	const rule: any = { id: "dyn-" + "1".repeat(32), condition: "c", action: "a", enabled: true, fireOnce: true, promoteToChat: false, createdAt: "t", cwd: "/old/project" };
	const out = defaultExportPath(dir, "orig-id");
	const summary = exportSession({ sessionFile, cwd: "/old/project", jobs: [job, inject], rules: [rule], states: { "cron-aaaaaaaa": "seen: #1 #2", "cron-bbbbbbbb": "ignored (not stateful)" }, outputPath: out, piVersion: "0.85.1", piLoopsVersion: "0.1.0" });
	assert.equal(summary.entryCount, 2);
	assert.equal(summary.loopStateCount, 1, "only stateful jobs carry state");
	assert.deepEqual([...readTar(fs.readFileSync(out)).keys()].sort(), ["loops/cron-aaaaaaaa.md", "manifest.json", "session.jsonl", "sidecars/cron.json", "sidecars/triggers.json"]);
	assert.equal(fs.statSync(out).mode & 0o777, 0o600);
	assert.throws(() => exportSession({ sessionFile, cwd: "/old/project", jobs: [], rules: [], states: {}, outputPath: out, piVersion: "x", piLoopsVersion: "y" }), /EEXIST/, "never overwrites");

	const sessionDir = path.join(dir, "sessions");
	const imp = importSession({ archivePath: out, sessionDir, targetCwd: "/new/project", activate: false, existingJobIds: new Set(["cron-aaaaaaaa"]), existingRuleIds: new Set() });
	assert.notEqual(imp.sessionId, "orig-id");
	assert.ok(fs.existsSync(imp.sessionPath));
	const header = JSON.parse(fs.readFileSync(imp.sessionPath, "utf8").split("\n")[0]);
	assert.equal(header.cwd, "/new/project");
	assert.equal(header.id, imp.sessionId);
	assert.equal(header.importedFrom.session_id, "orig-id");
	assert.equal(imp.entryCount, 2);
	assert.equal(imp.jobs.length, 2);
	const watch = imp.jobs.find((j) => j.name === "watch")!;
	assert.notEqual(watch.id, "cron-aaaaaaaa", "colliding id regenerated");
	assert.equal(watch.enabled, false, "automation disabled until activated");
	assert.equal(watch.running, undefined);
	assert.equal(watch.lastError, undefined);
	assert.equal(watch.skippedOverlap, 0);
	assert.equal(watch.cwd, "/new/project");
	assert.equal(imp.states[watch.id], "seen: #1 #2", "loop state follows the regenerated id");
	const ping = imp.jobs.find((j) => j.name === "ping")!;
	assert.equal(ping.sessionId, imp.sessionId, "inject jobs rebind to the imported session");
	assert.deepEqual(imp.originallyEnabledJobs, [watch.id]);
	assert.equal(imp.rules[0].enabled, false);
	assert.deepEqual(imp.originallyEnabledRules, [imp.rules[0].id]);

	const active = importSession({ archivePath: out, sessionDir, targetCwd: "/new/project", activate: true, existingJobIds: new Set(), existingRuleIds: new Set() });
	assert.equal(active.jobs.find((j) => j.name === "watch")!.enabled, true);
	assert.equal(active.jobs.find((j) => j.name === "ping")!.enabled, false, "originally disabled stays disabled");
	assert.equal(active.manifest.schema, ARCHIVE_SCHEMA);
});

test("import rejects tampered, unsafe, or foreign archives", () => {
	const dir = tmp();
	const bad = path.join(dir, "bad.pisession");
	fs.writeFileSync(bad, writeTar([{ name: "manifest.json", data: Buffer.from(JSON.stringify({ schema: "other" })) }, { name: "session.jsonl", data: Buffer.from("{}") }]));
	assert.throws(() => importSession({ archivePath: bad, sessionDir: dir, targetCwd: dir, activate: false, existingJobIds: new Set(), existingRuleIds: new Set() }), /unsupported archive schema/);
	const evil = path.join(dir, "evil.pisession");
	fs.writeFileSync(evil, writeTar([{ name: "../x", data: Buffer.from("x") }]));
	assert.throws(() => importSession({ archivePath: evil, sessionDir: dir, targetCwd: dir, activate: false, existingJobIds: new Set(), existingRuleIds: new Set() }), /unsafe path/);
	const sessionFile = fakeSession(dir);
	const out = path.join(dir, "ok.pisession");
	exportSession({ sessionFile, cwd: dir, jobs: [], rules: [], states: {}, outputPath: out, piVersion: "x", piLoopsVersion: "y" });
	const files = readTar(fs.readFileSync(out));
	files.set("session.jsonl", Buffer.from(files.get("session.jsonl")!.toString() + JSON.stringify({ type: "message", id: "z" }) + "\n"));
	const tampered = path.join(dir, "tampered.pisession");
	fs.writeFileSync(tampered, writeTar([...files].map(([name, data]) => ({ name, data }))));
	assert.throws(() => importSession({ archivePath: tampered, sessionDir: dir, targetCwd: dir, activate: false, existingJobIds: new Set(), existingRuleIds: new Set() }), /checksum/);
});

test("--exclude-triggers drops cron jobs and loop state too (pie: neither automation sidecar is bundled)", () => {
	const dir = tmp();
	const sessionFile = fakeSession(dir);
	const job: any = { id: "cron-aaaaaaaa", schedule: { kind: "cron", expr: "0 9 * * *" }, stateful: true, prompt: "watch", cwd: dir, enabled: true, createdAt: "t", runCount: 0, skippedOverlap: 0 };
	const rule: any = { id: "dyn-" + "2".repeat(32), condition: "c", action: "a", enabled: true, fireOnce: true, promoteToChat: false, createdAt: "t", cwd: dir };
	const out = path.join(dir, "bare.pisession");
	const summary = exportSession({ sessionFile, cwd: dir, jobs: [job], rules: [rule], states: { "cron-aaaaaaaa": "seen" }, outputPath: out, piVersion: "x", piLoopsVersion: "y", excludeTriggers: true });
	assert.equal(summary.hasCron, false);
	assert.equal(summary.hasTriggers, false);
	assert.equal(summary.loopStateCount, 0);
	assert.deepEqual([...readTar(fs.readFileSync(out)).keys()].sort(), ["manifest.json", "session.jsonl"]);
});

test("import validates every sidecar before it writes anything: a corrupt sidecar leaves no orphan session file", () => {
	const dir = tmp();
	const sessionFile = fakeSession(dir);
	const good = path.join(dir, "good.pisession");
	exportSession({ sessionFile, cwd: dir, jobs: [], rules: [], states: {}, outputPath: good, piVersion: "x", piLoopsVersion: "y" });
	const files = readTar(fs.readFileSync(good));
	files.set("sidecars/cron.json", Buffer.from(JSON.stringify({ jobs: "nope" })));
	const broken = path.join(dir, "broken.pisession");
	fs.writeFileSync(broken, writeTar([...files].map(([name, data]) => ({ name, data }))));
	const sessionDir = path.join(dir, "sessions");
	assert.throws(() => importSession({ archivePath: broken, sessionDir, targetCwd: dir, activate: false, existingJobIds: new Set(), existingRuleIds: new Set() }), /cron sidecar/);
	assert.equal(fs.existsSync(sessionDir) ? fs.readdirSync(sessionDir).length : 0, 0, "no session file written for a rejected archive");

	// Ids become file names (state/<id>.md, sessions/<id>/): anything but a plain token is rejected.
	for (const id of ["../x", "a/b", ".", "", "a.md/b"]) {
		files.set("sidecars/cron.json", Buffer.from(JSON.stringify({ jobs: [{ id, prompt: "p", schedule: { kind: "cron", expr: "* * * * *" }, enabled: true, stateful: true, cwd: dir, createdAt: "t" }] })));
		fs.writeFileSync(broken, writeTar([...files].map(([name, data]) => ({ name, data }))));
		assert.throws(() => importSession({ archivePath: broken, sessionDir, targetCwd: dir, activate: false, existingJobIds: new Set(), existingRuleIds: new Set() }), /invalid job id/, `job id ${JSON.stringify(id)}`);
	}
	files.delete("sidecars/cron.json");
	files.set("sidecars/triggers.json", Buffer.from(JSON.stringify({ rules: [{ id: "../r", condition: "c", action: "a", enabled: true, fireOnce: true, promoteToChat: false, createdAt: "t", cwd: dir }] })));
	fs.writeFileSync(broken, writeTar([...files].map(([name, data]) => ({ name, data }))));
	assert.throws(() => importSession({ archivePath: broken, sessionDir, targetCwd: dir, activate: false, existingJobIds: new Set(), existingRuleIds: new Set() }), /invalid rule id/);
	assert.equal(fs.existsSync(sessionDir) ? fs.readdirSync(sessionDir).length : 0, 0);
});
