import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseCliArgs, listSessions, pickSession, runCli } from "../src/cli.ts";

test("the CLI parses pie's flag forms", () => {
	const a = parseCliArgs(["export", "--session", "abc", "--output=out.pisession", "--exclude-triggers"]);
	assert.equal(a.command, "export");
	assert.equal(a.flags.get("session"), "abc");
	assert.equal(a.flags.get("output"), "out.pisession");
	assert.equal(a.flags.get("exclude-triggers"), true);
	const b = parseCliArgs(["import", "backup.pisession", "--activate-triggers=on"]);
	assert.deepEqual(b.positional, ["backup.pisession"]);
	assert.equal(b.flags.get("activate-triggers"), "on");
});

test("a session is picked by id, unique prefix, or newest-for-this-project", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-sessions-"));
	const proj = path.join(root, "proj");
	fs.mkdirSync(proj);
	const write = (id: string, cwd: string, ageMs: number) => {
		const f = path.join(proj, `${id}.jsonl`);
		fs.writeFileSync(f, `${JSON.stringify({ type: "session", version: 3, id, cwd })}\n`);
		const t = new Date(Date.now() - ageMs);
		fs.utimesSync(f, t, t);
	};
	write("01a08416-0000-0000-0000-000000000001", "/work/api", 60_000);
	write("01a08416-0000-0000-0000-000000000002", "/work/api", 10_000);
	write("01a08416-0000-0000-0000-0000000000ff", "/work/web", 5_000);

	const sessions = listSessions(root);
	assert.equal(sessions.length, 3);
	assert.equal(pickSession(sessions, { cwd: "/work/api" }).id.endsWith("2"), true, "newest of that project");
	assert.equal(pickSession(sessions, { cwd: "/work/web" }).id.endsWith("ff"), true);
	assert.equal(pickSession(sessions, { id: "01a08416-0000-0000-0000-0000000000ff", cwd: "/work/api" }).cwd, "/work/web", "an explicit id wins over cwd");
	assert.equal(pickSession(sessions, { id: "01a08416-0000-0000-0000-0000000000f", cwd: "/x" }).cwd, "/work/web", "a unique prefix works");
	assert.throws(() => pickSession(sessions, { id: "01a08416", cwd: "/x" }), /ambiguous/);
	assert.throws(() => pickSession(sessions, { id: "nope", cwd: "/x" }), /no session with id/);
	assert.throws(() => pickSession(sessions, { cwd: "/never/used" }), /no sessions recorded/);
	assert.deepEqual(listSessions(path.join(root, "missing")), []);
});

test("no command prints the usage and exits 0; an unknown one exits 2", async () => {
	const lines: string[] = [];
	assert.equal(await runCli([], (l) => lines.push(l)), 0);
	assert.match(lines.join("\n"), /pi-loops export/);
	assert.match(lines.join("\n"), /pi-loops import/);
	assert.equal(await runCli(["wat"], () => undefined), 2);
	await assert.rejects(runCli(["import"], () => undefined), /needs an archive path/);
	await assert.rejects(runCli(["import", "x.pisession", "--activate-triggers=maybe"], () => undefined), /must be off, ask or on/);
});

test("an imported session lands where pi looks for it, not in a hand-rolled directory", async () => {
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const cwd = "/home/u/proj";
	// What pi's own resume path reads (session-manager.js `getDefaultSessionDirPath`).
	const piDir = SessionManager.create(cwd).getSessionDir();
	assert.match(path.basename(piDir), /^--home-u-proj--$/, "pi's encoding is --path--, not percent-encoded");
	assert.notEqual(path.basename(piDir), encodeURIComponent(cwd), "the two encodings genuinely differ");

	// The CLI must produce exactly that directory; anything else is invisible to `pi --resume`.
	const src = fs.readFileSync("src/cli.ts", "utf8");
	assert.equal(/encodeURIComponent\(cwd\)/.test(src), false, "the CLI must not hand-roll pi's session directory name");
	assert.match(src, /SessionManager\.create\(cwd\)\.getSessionDir\(\)/);
});
