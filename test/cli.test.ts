import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyRememberedModel, configuredNpmSource, installLauncherWithConfirm, launcherTarget, loopsDir, parseCliArgs, cliRoute, isNewerVersion, isRemoteTty, listSessions, newestReleaseTag, pickSession, resolveUiMode, runCli, splitLaunchArgs, upgradeSpec } from "../src/cli.ts";

test("the CLI parses every flag form", () => {
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

/** Run `body` with some environment variables set or removed, and put them back however it ends. */
async function withEnv<T>(vars: Record<string, string | undefined>, body: () => T | Promise<T>): Promise<T> {
	const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
	const put = (values: Record<string, string | undefined>) => {
		for (const [k, v] of Object.entries(values)) {
			// Assigning undefined would store the string "undefined".
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	};
	put(vars);
	try {
		return await body();
	} finally {
		put(saved);
	}
}

test("/pi-loops install-launcher asks about the directory it will write, and --dir is that directory", async () => {
	// Found by following the README: `/pi-loops install-launcher --dir <dir>` ignored the flag, and the
	// question it asked first named ~/.local/bin whatever was about to happen. Answering yes to a
	// question about a directory you did not ask for replaced the launcher you already had there.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-bin-"));
	const asked: string[] = [];
	const yes = async (title: string, body: string) => (asked.push(`${title}\n${body}`), true);
	const lines: string[] = [];
	assert.equal(await installLauncherWithConfirm(["--dir", dir], yes, (l) => void lines.push(l)), 0);
	assert.ok(fs.existsSync(path.join(dir, "pi-loops")), "written where --dir said");
	assert.equal(asked.length, 1);
	assert.ok(asked[0].includes(dir), `the question names ${dir}, got:\n${asked[0]}`);
	assert.equal(asked[0].includes(".local"), false, "and no other directory");
	// Not on PATH, so the promise that `pi-loops` works from anywhere would be false; it says so instead.
	assert.match(asked[0], /not on your PATH/);

	// The question is answered before the write, and the write goes where the question said even if
	// the working directory moves in between: a relative --dir is fixed when it is asked about.
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-cwd-"));
	const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-cwd-"));
	const startedIn = process.cwd();
	process.chdir(base);
	try {
		const moving = async () => (process.chdir(elsewhere), true);
		assert.equal(await installLauncherWithConfirm(["--dir", "rel-bin"], moving, () => {}), 0);
	} finally {
		process.chdir(startedIn);
	}
	assert.ok(fs.existsSync(path.join(base, "rel-bin", "pi-loops")), "written where it was asked about");
	assert.equal(fs.existsSync(path.join(elsewhere, "rel-bin")), false);

	// No shell stands between pi's command line and this, so `~` is expanded here or not at all — and
	// not at all meant a directory literally called `~` under wherever pi was started.
	await withEnv({ HOME: base }, async () => {
		let question = "";
		assert.equal(await installLauncherWithConfirm(["--dir", "~/tilde-bin"], async (_t, body) => ((question = body), true), () => {}), 0);
		assert.ok(fs.existsSync(path.join(base, "tilde-bin", "pi-loops")));
		assert.ok(question.includes(path.join(base, "tilde-bin")), question);
	});

	// No is no: nothing written, and the caller is told nothing was installed.
	const other = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-bin-"));
	assert.equal(await installLauncherWithConfirm([`--dir=${other}`], async () => false, () => {}), undefined);
	assert.equal(fs.existsSync(path.join(other, "pi-loops")), false);

	// Nowhere to put it: there is nothing to ask about, and the refusal explains itself.
	await withEnv({ PATH: "/nonexistent-bin" }, async () => {
		const refused: string[] = [];
		let questions = 0;
		const code = await installLauncherWithConfirm([], async () => (questions++, true), (l) => void refused.push(l));
		assert.equal(code, 1);
		assert.equal(questions, 0);
		assert.match(refused.join("\n"), /--dir/);
	});
});

test("the launcher goes to the first of ~/.local/bin and /usr/local/bin on PATH, or where --dir says", () => {
	const local = path.join(os.homedir(), ".local", "bin");
	assert.equal(launcherTarget("rel/bin", ""), path.resolve("rel/bin"));
	assert.equal(launcherTarget(undefined, ["/usr/local/bin", "/usr/bin"].join(path.delimiter)), "/usr/local/bin");
	// ~/.local/bin wins even when PATH lists it second: it needs no root, which is why it is first.
	assert.equal(launcherTarget(undefined, ["/usr/local/bin", local].join(path.delimiter)), local);
	assert.equal(launcherTarget(undefined, "/usr/bin"), undefined);
});

test("the browser window reads the loops directory the extension writes, wherever pi's agent directory is", async () => {
	// `PI_CODING_AGENT_DIR` moves everything pi keeps, and the extension follows it. The launcher did
	// not: it read `ui.json` from ~/.pi/agent/loops, so a session in a moved agent directory opened on
	// the model remembered by a different setup.
	await withEnv({ PI_LOOPS_DIR: undefined, PI_CODING_AGENT_DIR: "/tmp/elsewhere/agent" }, () => {
		assert.equal(loopsDir([]), path.join("/tmp/elsewhere/agent", "loops"));
	});
	await withEnv({ PI_LOOPS_DIR: undefined, PI_CODING_AGENT_DIR: "~/moved" }, () => {
		assert.equal(loopsDir([]), path.join(os.homedir(), "moved", "loops"), "a ~ is expanded the way pi expands it");
	});
	await withEnv({ PI_LOOPS_DIR: "/tmp/explicit", PI_CODING_AGENT_DIR: "/tmp/elsewhere/agent" }, () => {
		assert.equal(loopsDir([]), "/tmp/explicit", "PI_LOOPS_DIR still says where the loops are");
		assert.equal(loopsDir(["--loops-dir", "/tmp/flag"]), "/tmp/flag", "and the flag says it louder");
	});
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

// The four below are about one question: `upgrade` offers a `pi install` argument, and an argument
// naming a source this copy did not come from installs a *second* package rather than replacing
// this one. Both then register `cron_create`, pi refuses to load the second and exits — the failure
// both READMEs and docs/troubleshooting.md are about.
const AGENT_DIR = "/home/u/.pi/agent";
const NAME = "@alphacoder-v0/pi-loops";

test("a copy pi installed from npm is upgraded by the npm spec, with the tag spelled as a version", () => {
	// `pi install npm:<name>` lands in the managed `<agent dir>/npm/node_modules/<name>`, scope
	// segment and all. Release tags are `v0.17.0`; npm knows the same release as `0.17.0`.
	const managed = `${AGENT_DIR}/npm/node_modules/@alphacoder-v0/pi-loops`;
	assert.equal(upgradeSpec(managed, NAME, AGENT_DIR, "v0.17.0"), "npm:@alphacoder-v0/pi-loops@0.17.0");
	// An older pi installed into the global node_modules instead, which is still an npm install.
	assert.equal(upgradeSpec("/usr/lib/node_modules/@alphacoder-v0/pi-loops", NAME, AGENT_DIR, "v0.17.0"), "npm:@alphacoder-v0/pi-loops@0.17.0");
	// An unscoped name is one segment, and works the same.
	assert.equal(upgradeSpec(`${AGENT_DIR}/npm/node_modules/pi-loops`, "pi-loops", AGENT_DIR, "v1.0.0"), "npm:pi-loops@1.0.0");
});

test("an npm install that follows the latest release is not pinned by upgrading it", () => {
	// pi skips an exact npm version in `pi update --extensions`, and treats anything else — a bare
	// name, `@latest`, a range — as a package that moves. Answering a bare install with
	// `npm:<name>@0.17.4` would pin it: the upgrade works once, and every update after it is skipped.
	// Nor can the answer be the bare name: `npm install <name>` over an existing install keeps the
	// range npm saved the first time and installs nothing, so "upgraded" would be printed over the
	// same version. `@latest` is what pi's own update asks npm for, and pi does not count it as a pin.
	const managed = `${AGENT_DIR}/npm/node_modules/@alphacoder-v0/pi-loops`;
	for (const configured of ["npm:@alphacoder-v0/pi-loops", "npm:@alphacoder-v0/pi-loops@latest", "npm:@alphacoder-v0/pi-loops@^0.17"]) {
		assert.equal(upgradeSpec(managed, NAME, AGENT_DIR, "v0.17.4", configured), "npm:@alphacoder-v0/pi-loops@latest", configured);
	}
	// An exact pin was a decision, so it stays one, moved to the new release.
	assert.equal(upgradeSpec(managed, NAME, AGENT_DIR, "v0.17.4", "npm:@alphacoder-v0/pi-loops@0.17.3"), "npm:@alphacoder-v0/pi-loops@0.17.4");
	assert.equal(upgradeSpec(managed, NAME, AGENT_DIR, "v0.17.4", "npm:@alphacoder-v0/pi-loops@v0.17.3"), "npm:@alphacoder-v0/pi-loops@0.17.4");
	// A git copy is a git copy whatever is passed: the route is the path's to decide.
	assert.equal(upgradeSpec(`${AGENT_DIR}/git/github.com/alphacoder-v0/pi-loops`, NAME, AGENT_DIR, "v0.17.4", "npm:@alphacoder-v0/pi-loops"), "git:github.com/alphacoder-v0/pi-loops@v0.17.4");
});

test("the npm source an install was made from is read from the settings beside its install root", () => {
	// `<agent dir>/npm` records into `<agent dir>/settings.json`, and a project's `.pi/npm` into
	// `.pi/settings.json` — one rule, the directory above the install root.
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-upgrade-"));
	const agentDir = path.join(root, "agent");
	const packageDir = path.join(agentDir, "npm", "node_modules", "@alphacoder-v0", "pi-loops");
	fs.mkdirSync(packageDir, { recursive: true });
	const settings = (packages: unknown[]) => fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages }));

	settings(["npm:other-pkg@1.0.0", "npm:@alphacoder-v0/pi-loops"]);
	assert.equal(configuredNpmSource(packageDir, NAME), "npm:@alphacoder-v0/pi-loops");
	// A filtered entry is an object, and its source is the same fact.
	settings([{ source: "npm:@alphacoder-v0/pi-loops@0.17.3", extensions: [] }]);
	assert.equal(configuredNpmSource(packageDir, NAME), "npm:@alphacoder-v0/pi-loops@0.17.3");
	// A name that merely starts with ours is somebody else's package.
	settings(["npm:@alphacoder-v0/pi-loops-extra"]);
	assert.equal(configuredNpmSource(packageDir, NAME), undefined);
	// A project's `.pi/settings.json` can come from a cloned repository. An entry built to make a
	// backtracking spec parser go quadratic has to cost what its length costs, not a hung upgrade.
	const started = Date.now();
	settings([`npm:${"a/".repeat(500_000)}@`, `npm:${NAME}${"a/".repeat(500_000)}@`]);
	assert.equal(configuredNpmSource(packageDir, NAME), undefined);
	assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);

	const projectPackage = path.join(root, "project", ".pi", "npm", "node_modules", "@alphacoder-v0", "pi-loops");
	fs.mkdirSync(projectPackage, { recursive: true });
	fs.writeFileSync(path.join(root, "project", ".pi", "settings.json"), JSON.stringify({ packages: ["npm:@alphacoder-v0/pi-loops@^0.17"] }));
	assert.equal(configuredNpmSource(projectPackage, NAME), "npm:@alphacoder-v0/pi-loops@^0.17");

	// No settings, or settings that do not parse: nothing is known, and the caller keeps the exact pin.
	fs.rmSync(path.join(agentDir, "settings.json"));
	assert.equal(configuredNpmSource(packageDir, NAME), undefined);
	fs.writeFileSync(path.join(agentDir, "settings.json"), "{ not json");
	assert.equal(configuredNpmSource(packageDir, NAME), undefined);
	fs.rmSync(root, { recursive: true, force: true });
});

test("a copy pi installed from git is upgraded by the git spec, host and owner intact", () => {
	// `<agent dir>/git/<host>/<owner>/<repo>` is the spec it was installed by, spelled as a path, so
	// a fork on another host gets its own repository back rather than this project's.
	assert.equal(upgradeSpec(`${AGENT_DIR}/git/github.com/alphacoder-v0/pi-loops`, NAME, AGENT_DIR, "v0.17.0"), "git:github.com/alphacoder-v0/pi-loops@v0.17.0");
	assert.equal(upgradeSpec(`${AGENT_DIR}/git/gitlab.example.com/team/loops`, NAME, AGENT_DIR, "v2.3.4"), "git:gitlab.example.com/team/loops@v2.3.4");
	// The tag keeps its `v` here: that is what the ref is called.
	assert.match(upgradeSpec(`${AGENT_DIR}/git/github.com/alphacoder-v0/pi-loops`, NAME, AGENT_DIR, "v0.17.0")!, /@v0\.17\.0$/);
});

test("a local checkout is offered no install spec at all", () => {
	// There is nothing for `pi install` to redo: the user has a remote, and `git pull` is the
	// upgrade. Installing on top of a checkout is how you end up running two of these.
	assert.equal(upgradeSpec("/home/u/code/piz", NAME, AGENT_DIR, "v0.17.0"), undefined);
	// A checkout that happens to live under some other directory called `git` is still a checkout.
	assert.equal(upgradeSpec("/home/u/git/github.com/alphacoder-v0/pi-loops", NAME, AGENT_DIR, "v0.17.0"), undefined);
	// And a path under pi's git root that is not host/owner/repo is not a package pi installed.
	assert.equal(upgradeSpec(`${AGENT_DIR}/git/github.com/alphacoder-v0`, NAME, AGENT_DIR, "v0.17.0"), undefined);
});

test("an npm install is never offered a git spec, and a git install never an npm one", () => {
	// The regression that matters. `upgrade` used to answer every copy with a git spec, whatever it
	// had been installed from, so a copy from anywhere else ended up installed twice and pi stopped
	// loading it: `Tool "cron_create" conflicts with …`.
	for (const dir of [`${AGENT_DIR}/npm/node_modules/@alphacoder-v0/pi-loops`, "/usr/lib/node_modules/@alphacoder-v0/pi-loops"]) {
		const spec = upgradeSpec(dir, NAME, AGENT_DIR, "v0.17.0");
		assert.equal(spec?.startsWith("npm:"), true, dir);
		assert.equal(spec?.includes("git:"), false, dir);
	}
	const fromGit = upgradeSpec(`${AGENT_DIR}/git/github.com/alphacoder-v0/pi-loops`, NAME, AGENT_DIR, "v0.17.0");
	assert.equal(fromGit?.startsWith("git:"), true);
	assert.equal(fromGit?.includes("npm:"), false);
});

test("the model you chose last time starts the next session, unless you said otherwise", () => {
	/**
	 * A session opens on pi's default, which is why picking the same model every morning was the
	 * first thing anybody asked for. It is applied to a session that has no opinion of its own —
	 * not to one being resumed, which already has the model it was talking to.
	 */
	const prefs = { model: "anthropic/claude-opus-5", thinking: "high" };
	assert.deepEqual(applyRememberedModel([], prefs), ["--model", "anthropic/claude-opus-5", "--thinking", "high"]);
	assert.deepEqual(applyRememberedModel(["-e", "."], prefs), ["-e", ".", "--model", "anthropic/claude-opus-5", "--thinking", "high"]);

	// You said which one: that is the answer, in either spelling.
	assert.deepEqual(applyRememberedModel(["--model", "openai/gpt-5"], prefs), ["--model", "openai/gpt-5", "--thinking", "high"]);
	assert.deepEqual(applyRememberedModel(["--model=openai/gpt-5"], prefs), ["--model=openai/gpt-5", "--thinking", "high"]);

	// A session that already exists brought its own model with it.
	for (const resume of [["--continue"], ["-c"], ["--resume"], ["-r"], ["--session", "01a0"], ["--session-id", "x"]]) {
		assert.deepEqual(applyRememberedModel(resume, prefs), resume, `${resume[0]} keeps the session's own model`);
	}

	// Nothing remembered yet is nothing to apply.
	assert.deepEqual(applyRememberedModel(["-e", "."], {}), ["-e", "."]);
});

test("pi-loops recipe: list, show, and an add that copies but creates no job", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-recipe-cli-"));
	const project = path.join(root, "project");
	fs.mkdirSync(project);
	const lines: string[] = [];
	const out = (l: string) => lines.push(l);
	await withEnv({ PI_LOOPS_DIR: path.join(root, "loops"), PI_CODING_AGENT_DIR: path.join(root, "agent") }, async () => {
		assert.equal(await runCli(["recipe", "list", "--cwd", project], out), 0);
		assert.match(lines.join("\n"), /^issue-loop\s+—\s+/m, "packaged, not installed");
		assert.match(lines.join("\n"), /^changelog-draft\s/m);
		lines.length = 0;
		assert.equal(await runCli(["recipe", "show", "issue-loop", "--cwd", project], out), 0);
		assert.match(lines.join("\n"), /\/cron add --stateful --name issue-triage/);
		assert.match(lines.join("\n"), /needs docs\/agents\/issue-tracker\.md/);
		lines.length = 0;
		assert.equal(await runCli(["recipe", "add", "issue-loop", "--cwd", project], out), 0);
		const text = lines.join("\n");
		assert.match(text, /copied \d+ file\(s\)/);
		assert.match(text, /level propose, the lowest/);
		assert.match(text, /not a git repository/);
		assert.match(text, /has none: \/recipe add issue-loop in pi/, "the tracker step is pointed at, not skipped");
		assert.match(text, /no jobs created/);
		assert.ok(fs.existsSync(path.join(project, ".agents", "skills", "issue-loop", "triage.md")));
		assert.ok(fs.existsSync(path.join(project, ".agents", "skills", "issue-loop", "labels.sh")));
		assert.ok(!fs.existsSync(path.join(root, "loops", "jobs.json")), "nothing scheduled from the shell");
		lines.length = 0;
		assert.equal(await runCli(["recipe", "list", "--cwd", project], out), 0);
		assert.match(lines.join("\n"), /^issue-loop\s+installed: propose, 0 job\(s\)/m);
		await assert.rejects(runCli(["recipe", "add", "issue-loop", "--cwd", project, "--level", "report"], out), /supports propose, act, not "report"/);
		lines.length = 0;
		assert.equal(await runCli(["recipe", "nope", "--cwd", project], out), 2);
		assert.match(lines.join("\n"), /unknown recipe command "nope"/);
		lines.length = 0;
		assert.equal(await runCli(["help"], out), 0);
		assert.match(lines.join("\n"), /pi-loops recipe list/);
	});
});

test("pi-loops sessions prints one line a person can tell sessions apart by", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-sessions-out-"));
	const agent = path.join(root, "agent");
	const proj = path.join(agent, "sessions", "--work-api--");
	fs.mkdirSync(proj, { recursive: true });
	const loops = path.join(root, "loops");
	fs.mkdirSync(loops);
	const id = "01a08416-1111-2222-3333-444444444444";
	fs.writeFileSync(path.join(proj, "a.jsonl"), [
		JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-14T13:48:39.061Z", cwd: "/work/api" }),
		JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "check the\nlogin flow, please, and tell me what is off about the redirect after a password reset on mobile" } }),
	].join("\n") + "\n");
	fs.writeFileSync(path.join(loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [{ id: "cron-" + "a".repeat(32), schedule: { kind: "every", everyMs: 60_000 }, stateful: false, prompt: "p", cwd: "/work/api", enabled: true, catchUp: false, createdAt: "t", runCount: 0, skippedOverlap: 0, sessionId: id }] }));
	const lines: string[] = [];
	await withEnv({ PI_LOOPS_DIR: loops, PI_CODING_AGENT_DIR: agent }, async () => {
		assert.equal(await runCli(["sessions", "--cwd", "/work/api"], (l) => lines.push(l)), 0);
	});
	assert.equal(lines.length, 1);
	assert.equal(lines[0], "01a08416-1111-22  2026-09-14T13:48  [1 cron]  check the login flow, please, and tell me what is off about the redirect after a…");
	const all: string[] = [];
	await withEnv({ PI_LOOPS_DIR: loops, PI_CODING_AGENT_DIR: agent }, async () => {
		assert.equal(await runCli(["sessions", "--all"], (l) => all.push(l)), 0);
	});
	assert.match(all[0], /^01a08416-1111-22  \/work\/api  2026-09-14T13:48/, "--all puts the cwd after the id");
});
