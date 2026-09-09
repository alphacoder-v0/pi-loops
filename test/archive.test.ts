import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ARCHIVE_SCHEMA, PIE_ARCHIVE_SCHEMA, defaultExportPath, exportSession, importSession, readTar, writeTar } from "../src/archive.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-arc-"));

/** An archive built by hand, so the transcript can be broken with a manifest that still matches it. */
function handmade(file: string, lines: string[], extra: Array<{ name: string; data: Buffer }> = [], schema = ARCHIVE_SCHEMA): string {
	const session = Buffer.from(`${lines.join("\n")}\n`);
	const manifest = {
		schema,
		created_at: "2026-09-08T10:00:00.000Z",
		pi_version: "0.85.1",
		pi_loops_version: "0.1.3",
		source: { session_id: "orig-id", cwd: "/old/project", session_path: "s.jsonl" },
		content: { session_jsonl_sha256: createHash("sha256").update(session).digest("hex"), entry_count: lines.length - 1, has_triggers: false, has_cron: false, loop_state_count: 0 },
		sensitivity: { session_transcript_preserved: true, separate_auth_stores_included: false, provider_credentials_included: false, mcp_config_included: false, inbox_included: false },
	};
	fs.writeFileSync(file, writeTar([{ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) }, { name: "session.jsonl", data: session }, ...extra]));
	return file;
}

const HEADER = JSON.stringify({ type: "session", version: 3, id: "orig-id", timestamp: "2026-09-08T10:00:00.000Z", cwd: "/old/project" });
const entry = (o: Record<string, unknown>) => JSON.stringify({ type: "message", message: { role: "user", content: "hi" }, ...o });

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
	// An unrelated job already holds the archive's id (same id, different provenance and prompt):
	// that is a collision, not a re-import, so the imported job takes a fresh id.
	const squatter: any = { id: "cron-aaaaaaaa", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "something else", cwd: "/new/project", enabled: true, catchUp: true, createdAt: "t", runCount: 0, skippedOverlap: 0 };
	const imp = importSession({ archivePath: out, sessionDir, targetCwd: "/new/project", activate: false, existingJobIds: new Set(["cron-aaaaaaaa"]), existingRuleIds: new Set(), existingJobs: [squatter], existingRules: [] });
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

test("an imported archive belongs to the machine that imported it, or its automation would never fire", () => {
	const dir = tmp();
	const sessionFile = fakeSession(dir);
	const job: any = { id: "cron-cccccccc", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "p", cwd: "/old", enabled: true, catchUp: true, createdAt: "t", runCount: 0, skippedOverlap: 0, host: "the-laptop" };
	const rule: any = { id: "dyn-" + "2".repeat(32), condition: "c", action: "a", enabled: true, fireOnce: true, promoteToChat: false, createdAt: "t", cwd: "/old", host: "the-laptop" };
	const out = defaultExportPath(dir, "orig-2");
	exportSession({ sessionFile, cwd: "/old", jobs: [job], rules: [rule], states: {}, outputPath: out, piVersion: "x", piLoopsVersion: "y" });
	const imp = importSession({ archivePath: out, sessionDir: path.join(dir, "sessions"), targetCwd: "/new", activate: true, existingJobIds: new Set(), existingRuleIds: new Set() });
	assert.equal(imp.jobs[0].host, os.hostname(), "the job is re-stamped for this machine");
	assert.equal(imp.rules[0].host, os.hostname());
	assert.equal(imp.jobs[0].enabled, true);
});

test("import refuses a structurally broken transcript instead of truncating history when it is opened", () => {
	const dir = tmp();
	const sessionDir = path.join(dir, "sessions");
	const imp = (name: string, lines: string[]) => () =>
		importSession({ archivePath: handmade(path.join(dir, name), lines), sessionDir, targetCwd: dir, activate: false, existingJobIds: new Set(), existingRuleIds: new Set() });
	// pie rejects all three at parse time (session_archive.rs:363-397).
	assert.throws(imp("dup.pisession", [HEADER, entry({ id: "a" }), entry({ id: "a", parentId: "a" })]), /duplicate entry id/);
	assert.throws(imp("orphan.pisession", [HEADER, entry({ id: "a" }), entry({ id: "b", parentId: "nowhere" })]), /dangling parentId/);
	assert.throws(imp("label.pisession", [HEADER, entry({ id: "a" }), JSON.stringify({ type: "label", id: "b", parentId: "a", targetId: "nowhere", label: "x" })]), /dangling entry target/);
	assert.throws(imp("noid.pisession", [HEADER, entry({})]), /without an id/);
	assert.equal(fs.existsSync(sessionDir) ? fs.readdirSync(sessionDir).length : 0, 0, "nothing is written for a rejected transcript");
	// The same shapes, wired up correctly, still import.
	const ok = imp("ok.pisession", [HEADER, entry({ id: "a" }), entry({ id: "b", parentId: "a" }), JSON.stringify({ type: "label", id: "c", parentId: "b", targetId: "a", label: "x" })])();
	assert.equal(ok.entryCount, 3);
	assert.equal(ok.transcriptImported, true);
});

test("importing the same archive twice does not double the automation", () => {
	const dir = tmp();
	const sessionFile = fakeSession(dir);
	const job: any = { id: "cron-dddddddd", name: "watch", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "watch issues", cwd: "/old/project", enabled: true, catchUp: true, createdAt: "t", runCount: 0, skippedOverlap: 0 };
	const rule: any = { id: "dyn-" + "3".repeat(32), condition: "c", action: "a", enabled: true, fireOnce: true, promoteToChat: false, createdAt: "t", cwd: "/old/project" };
	const out = path.join(dir, "twice.pisession");
	exportSession({ sessionFile, cwd: "/old/project", jobs: [job], rules: [rule], states: { "cron-dddddddd": "seen" }, outputPath: out, piVersion: "x", piLoopsVersion: "y" });
	const sessionDir = path.join(dir, "sessions");
	const first = importSession({ archivePath: out, sessionDir, targetCwd: "/new/project", activate: true, existingJobIds: new Set(), existingRuleIds: new Set(), existingJobs: [], existingRules: [] });
	assert.equal(first.jobs.length, 1);
	assert.equal(first.skippedJobs, 0);

	const again = importSession({ archivePath: out, sessionDir, targetCwd: "/new/project", activate: true, existingJobIds: new Set(first.jobs.map((j) => j.id)), existingRuleIds: new Set(first.rules.map((r) => r.id)), existingJobs: first.jobs, existingRules: first.rules });
	assert.deepEqual(again.jobs, [], "the second import adds no second copy to run and to bill");
	assert.deepEqual(again.rules, []);
	assert.equal(again.skippedJobs, 1);
	assert.equal(again.skippedRules, 1);
	assert.deepEqual(again.states, {}, "and no loop state for a job that was not imported");
	assert.match(again.notes.join("\n"), /already imported from this archive/);

	// A different project is a different job, so `--cwd` still copies it.
	const elsewhere = importSession({ archivePath: out, sessionDir, targetCwd: "/other/project", activate: true, existingJobIds: new Set(first.jobs.map((j) => j.id)), existingRuleIds: new Set(), existingJobs: first.jobs, existingRules: first.rules });
	assert.equal(elsewhere.jobs.length, 1);
	assert.notEqual(elsewhere.jobs[0].id, first.jobs[0].id, "the taken id is regenerated");
});

test("a pie .piesession gives up its transcript but not its automation sidecars", () => {
	const dir = tmp();
	const cron = [
		"[[jobs]]",
		'id = "cron-11111111"',
		'schedule = "0 9 * * *"',
		'action = "check the deploy queue"',
		"enabled = true",
		"stateful = true",
		'created_at = "2026-09-01T08:00:00Z"',
		"",
		"[[jobs]]",
		'id = "cron-22222222"',
		'schedule = "*/30 * * * *"',
		'action = "remind me"',
		"enabled = true",
		"stateful = false",
		'created_at = "2026-09-01T08:00:00Z"',
	].join("\n");
	const triggers = JSON.stringify({ version: 1, rules: [{ id: "dyn-" + "4".repeat(32), condition: "CI goes red", action: "tell me", enabled: true, fire_once: false, promote_to_chat: true, created_at: "2026-09-01T08:00:00Z" }] });
	const archive = handmade(
		path.join(dir, "pie.piesession"),
		[HEADER, entry({ id: "a" })],
		[
			{ name: "sidecars/cron.toml", data: Buffer.from(cron) },
			{ name: "sidecars/triggers.json", data: Buffer.from(triggers) },
		],
		PIE_ARCHIVE_SCHEMA,
	);
	const sessionDir = path.join(dir, "sessions");
	const imp = importSession({ archivePath: archive, sessionDir, targetCwd: "/new/project", activate: true, existingJobIds: new Set(), existingRuleIds: new Set(), existingJobs: [], existingRules: [] });
	assert.equal(imp.transcriptImported, false);
	assert.equal(imp.sessionPath, "", "no pi session file is written for a pie transcript");
	assert.equal(fs.existsSync(sessionDir) ? fs.readdirSync(sessionDir).length : 0, 0);
	assert.match(imp.notes.join("\n"), /pie's transcript format cannot be opened by pi/);
	assert.match(imp.notes.join("\n"), /1 inject-mode cron job\(s\) were skipped/);

	assert.equal(imp.jobs.length, 1, "the loop comes across; the inject job cannot without its session");
	assert.deepEqual(imp.jobs[0].schedule, { kind: "cron", expr: "0 9 * * *" });
	assert.equal(imp.jobs[0].prompt, "check the deploy queue");
	assert.equal(imp.jobs[0].stateful, true);
	assert.equal(imp.jobs[0].cwd, "/new/project");
	assert.equal(imp.jobs[0].host, os.hostname());
	assert.equal(imp.jobs[0].enabled, true);
	assert.deepEqual(imp.originallyEnabledJobs, [imp.jobs[0].id]);
	assert.equal(imp.rules.length, 1);
	assert.equal(imp.rules[0].condition, "CI goes red");
	assert.equal(imp.rules[0].fireOnce, false, "pie's snake_case fields are translated");
	assert.equal(imp.rules[0].promoteToChat, true);

	// And it is idempotent the same way a pi archive is.
	const again = importSession({ archivePath: archive, sessionDir, targetCwd: "/new/project", activate: true, existingJobIds: new Set(), existingRuleIds: new Set(), existingJobs: imp.jobs, existingRules: imp.rules });
	assert.deepEqual([again.jobs.length, again.rules.length], [0, 0]);
});

test("an archive cannot smuggle in a schedule that would break every tick", () => {
	const dir = tmp();
	const sessionFile = fakeSession(dir);
	const hostile = (schedule: unknown, n: number): string => {
		const out = defaultExportPath(dir, `hostile${n}`);
		const job: any = { id: `cron-${String(n).repeat(32).slice(0, 32)}`, schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "p", cwd: "/old", enabled: true, catchUp: true, createdAt: "t", runCount: 0, skippedOverlap: 0 };
		exportSession({ sessionFile, cwd: "/old", jobs: [job], rules: [], states: {}, outputPath: out, piVersion: "x", piLoopsVersion: "y" });
		// Rewrite the sidecar with a hostile schedule and re-checksum it, as a hand-made archive would.
		const files = readTar(fs.readFileSync(out));
		const sidecar = JSON.parse(files.get("sidecars/cron.json")!.toString("utf8"));
		sidecar.jobs[0].schedule = schedule;
		const bytes = Buffer.from(JSON.stringify(sidecar));
		files.set("sidecars/cron.json", bytes);
		const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8"));
		manifest.content.cron_json_sha256 = createHash("sha256").update(bytes).digest("hex");
		files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
		const path2 = `${out}.hostile`;
		fs.writeFileSync(path2, writeTar([...files].map(([name, data]) => ({ name, data }))));
		return path2;
	};
	const shapes: unknown[] = [{ kind: "cron", expr: "nope" }, { kind: "every", ms: 0 }, { kind: "cron", expr: 5 }, { kind: "wat" }, null];
	shapes.forEach((schedule, i) => {
		const archive = hostile(schedule, i);
		assert.throws(
			() => importSession({ archivePath: archive, sessionDir: path.join(dir, "sessions"), targetCwd: "/new", activate: true, existingJobIds: new Set(), existingRuleIds: new Set() }),
			/invalid schedule|invalid job/,
			`should refuse ${JSON.stringify(schedule)}`,
		);
	});
});
