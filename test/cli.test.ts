import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseCliArgs, cliRoute, isNewerVersion, isRemoteTty, listSessions, newestReleaseTag, pickSession, resolveUiMode, runCli, splitLaunchArgs } from "../src/cli.ts";

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

test("what bare `pi-loops` does, and what a typo does", () => {
	// Starting a session is the common case, so no arguments means start one — and so does anything
	// beginning with a flag, since `pi-loops --model x` should mean what `pi --model x` means.
	assert.equal(cliRoute([]), "launch");
	assert.equal(cliRoute(["--model", "anthropic/claude-opus-5"]), "launch");
	assert.equal(cliRoute(["--web"]), "launch");
	// A bare word never becomes an argument for pi: `pi-loops exprot` is a typo, and starting a
	// session instead of saying so hides it.
	assert.equal(cliRoute(["exprot"]), "subcommand");
	assert.equal(cliRoute(["export"]), "subcommand");
	assert.equal(cliRoute(["--help"]), "subcommand", "help is help, not a session");
	assert.equal(cliRoute(["-h"]), "subcommand");
});

test("usage and exit codes for the subcommand path", async () => {
	const lines: string[] = [];
	assert.equal(await runCli(["help"], (l) => lines.push(l)), 0);
	assert.match(lines.join("\n"), /pi-loops export/);
	assert.match(lines.join("\n"), /pi-loops import/);
	assert.match(lines.join("\n"), /pi-loops \[--web \| --tui\]/, "the launcher is in the usage");
	// Saying which command, and which version: a subcommand is usually unknown because the copy you
	// have predates it, and a bare usage list is exactly the wrong answer to that.
	const unknown: string[] = [];
	assert.equal(await runCli(["wat"], (l) => unknown.push(l)), 2);
	assert.match(unknown.join("\n"), /unknown command "wat"/);
	assert.match(unknown.join("\n"), /pi-loops v\d+\.\d+\.\d+/);
	assert.match(unknown.join("\n"), /older than the command/);
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

test("sessions and inspect answer the questions export and import assume", async () => {
	const { exportSession, defaultExportPath } = await import("../src/archive.ts");
	const { inspectArchive } = await import("../src/archive.ts");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-inspect-"));
	const sessionFile = path.join(dir, "s.jsonl");
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "01a08416-0000-0000-0000-00000000000a", cwd: "/work/api" })}\n${JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "hi" } })}\n`);
	const job: any = { id: "cron-" + "a".repeat(32), schedule: { kind: "cron", expr: "0 9 * * *" }, stateful: true, prompt: "watch the issues", cwd: "/work/api", enabled: true, catchUp: true, createdAt: "t", runCount: 0, skippedOverlap: 0 };
	const rule: any = { id: "dyn-" + "1".repeat(32), condition: "deploy finishes", action: "tell me", enabled: false, fireOnce: true, promoteToChat: true, createdAt: "t", cwd: "/work/api" };
	const out = defaultExportPath(dir, "01a08416");
	exportSession({ sessionFile, cwd: "/work/api", jobs: [job], rules: [rule], states: {}, outputPath: out, piVersion: "x", piLoopsVersion: "y" });

	const info = inspectArchive(out);
	assert.match(info.schema, /pi-loops\.session_export/);
	assert.equal(info.sourceCwd, "/work/api");
	assert.equal(info.entryCount, 1);
	assert.deepEqual(info.jobs, [{ schedule: "0 9 * * *", prompt: "watch the issues", enabled: true }]);
	assert.deepEqual(info.rules, [{ condition: "deploy finishes", action: "tell me", enabled: false }]);
	// Inspecting writes nothing.
	assert.deepEqual(fs.readdirSync(dir).sort(), ["s.jsonl", path.basename(out)].sort());
});

test("inspect does not hand an archive's escape sequences to the terminal", async () => {
	const { exportSession, defaultExportPath } = await import("../src/archive.ts");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-inspect-esc-"));
	const sessionFile = path.join(dir, "s.jsonl");
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "01a08416-0000-0000-0000-00000000000b", cwd: "/work/api" })}\n`);
	// `inspect` is the command you run before trusting a file someone sent you: an escape here could
	// clear the screen or repaint the lines above it, which is the listing you ran it for.
	const nasty = "innocent\u001b[2J\u001b[1;1Hcron  enabled  0 9 * * *  something else\r";
	const job: any = { id: "cron-" + "b".repeat(32), schedule: { kind: "cron", expr: "0 9 * * *" }, stateful: true, prompt: nasty, cwd: "/work/api", enabled: true, catchUp: true, createdAt: "t", runCount: 0, skippedOverlap: 0 };
	const out = defaultExportPath(dir, "01a08416");
	exportSession({ sessionFile, cwd: "/work/api", jobs: [job], rules: [], states: {}, outputPath: out, piVersion: "x", piLoopsVersion: "y" });

	const lines: string[] = [];
	const code = await runCli(["inspect", out], (l) => void lines.push(l));
	assert.equal(code, 0);
	const printed = lines.join("\n");
	assert.ok(printed.includes("innocent"), "the text itself is still shown");
	assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(printed), false, printed);
});

test("which front end `pi-loops` opens when you do not say", () => {
	const local = { interactiveTty: true, remoteTty: false };
	const ssh = { interactiveTty: true, remoteTty: true };
	const pipe = { interactiveTty: false, remoteTty: false };
	// A browser is the better window when one is reachable, and useless when it is not.
	assert.equal(resolveUiMode({ web: false, tui: false, ...local }), "web");
	assert.equal(resolveUiMode({ web: false, tui: false, ...ssh }), "terminal", "opening a browser on the far end helps nobody");
	assert.equal(resolveUiMode({ web: false, tui: false, ...pipe }), "terminal", "no terminal means no browser to open either");
	// Saying so always wins, including over the ssh rule — port forwarding is a thing.
	assert.equal(resolveUiMode({ web: true, tui: false, ...ssh }), "web");
	assert.equal(resolveUiMode({ web: false, tui: true, ...local }), "terminal");
	assert.equal(resolveUiMode({ web: true, tui: true, ...local }), "web", "--web wins a contradiction rather than erroring");
});

test("ssh and mosh are recognised from the environment they set", () => {
	assert.equal(isRemoteTty({}), false);
	for (const k of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "MOSH_CONNECTION"]) assert.equal(isRemoteTty({ [k]: "x" }), true, k);
});

test("flags this command does not recognise belong to pi", () => {
	// The point of the launcher is that you can type what you would have typed after `pi`.
	assert.deepEqual(splitLaunchArgs(["--model", "anthropic/claude-opus-5"]), { ours: [], pi: ["--model", "anthropic/claude-opus-5"] });
	assert.deepEqual(splitLaunchArgs(["--web", "--port", "4200", "--model", "x"]), { ours: ["--web", "--port", "4200"], pi: ["--model", "x"] });
	// A flag the front end reads must not be handed to pi, which would refuse to start on it.
	assert.deepEqual(splitLaunchArgs(["--no-auth", "--continue"]), { ours: ["--no-auth"], pi: ["--continue"] });
	// A flag with a value has to take its value with it, or the address lands in pi's argv.
	assert.deepEqual(splitLaunchArgs(["--host", "0.0.0.0", "--model", "x"]), { ours: ["--host", "0.0.0.0"], pi: ["--model", "x"] });
	assert.deepEqual(splitLaunchArgs(["--tui", "-e", "."]), { ours: ["--tui"], pi: ["-e", "."] });
	assert.deepEqual(splitLaunchArgs(["--port=4200", "--resume"]), { ours: ["--port=4200"], pi: ["--resume"] });
	// An explicit `--` still separates, for anything ambiguous.
	assert.deepEqual(splitLaunchArgs(["--web", "--", "--tui"]), { ours: ["--web"], pi: ["--tui"] });
});

test("install-launcher writes a runnable launcher, and says when there is nowhere to put one", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-bin-"));
	const lines: string[] = [];
	assert.equal(await runCli(["install-launcher", "--dir", dir], (l) => void lines.push(l)), 0);
	const file = path.join(dir, "pi-loops");
	assert.ok(fs.existsSync(file));
	assert.equal(fs.statSync(file).mode & 0o111, 0o111, "executable");
	const script = fs.readFileSync(file, "utf8");
	assert.match(script, /^#!\/bin\/sh/);
	// It names this node and this checkout, so moving either does not silently break it.
	assert.ok(script.includes(JSON.stringify(process.execPath)));
	assert.match(script, /cli-entry\.mjs/);
	assert.match(script, /"\$@"/, "arguments reach the command");
	assert.match(lines.join("\n"), new RegExp(`wrote ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	// A directory that is not on PATH is written anyway, with a warning: the caller asked for it.
	assert.match(lines.join("\n"), /not on your PATH/);
});

test("which release is the newest one to offer", () => {
	// git ls-remote output, including the shapes that are not releases.
	const refs = [
		"709d8cd\trefs/tags/v0.5.0",
		"91c5cf7\trefs/tags/v0.6.0",
		"f8d9155\trefs/tags/v0.10.0",
		"aaaaaaa\trefs/tags/v0.9.0",
		"bbbbbbb\trefs/tags/v1.0.0-rc1",
		"ccccccc\trefs/tags/nightly",
		"ddddddd\trefs/tags/v0.6.1^{}",
	].join("\n");
	// Numeric, not lexical: v0.10.0 is later than v0.9.0, and a string sort disagrees.
	assert.equal(newestReleaseTag(refs), "v0.10.0");
	// A release candidate, a branch-shaped tag and a peeled ref are not things to upgrade someone to.
	assert.equal(newestReleaseTag("bbbbbbb\trefs/tags/v1.0.0-rc1"), undefined);
	assert.equal(newestReleaseTag("ccccccc\trefs/heads/main"), undefined);
	assert.equal(newestReleaseTag(""), undefined);

	assert.equal(isNewerVersion("v0.10.0", "v0.9.0"), true);
	assert.equal(isNewerVersion("v0.6.1", "v0.6.1"), false, "the same version is not an upgrade");
	assert.equal(isNewerVersion("v0.6.0", "v0.6.1"), false);
	assert.equal(isNewerVersion("v1.0.0", "v0.99.99"), true);
	assert.equal(isNewerVersion("nightly", "v0.6.1"), false, "unparseable is never newer");
});
