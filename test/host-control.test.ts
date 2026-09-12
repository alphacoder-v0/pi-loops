import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { HOST_FILE, crashedHost, hostPushWork, hostSpawnArgs, liveHost, piPackageDir, readHost, shouldHandOff, spawnHost, stopHost, writeHostRecord } from "../src/host-control.ts";
import { THINKING_LEVELS, requireThinkingLevel, thinkingLevelOrUndefined } from "../src/thinking.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-host-"));
const at = new Date().toISOString();

test("shouldHandOff: only the last interactive pi hands the clock to a host, and only when there is work", () => {
	const me = { pid: process.pid, host: "h", instance: "me", cwd: "/p", heartbeatAt: at };
	const base = { auto: true, presence: [me], selfPid: process.pid, selfInstance: "me", hostName: "h", enabledLoops: 1, enabledRules: 0, pushServers: 0, hostAlive: false };
	assert.equal(shouldHandOff(base).handOff, true);
	assert.equal(shouldHandOff({ ...base, auto: false }).handOff, false);
	assert.equal(shouldHandOff({ ...base, hostAlive: true }).handOff, false);
	assert.equal(shouldHandOff({ ...base, enabledLoops: 0 }).handOff, false, "nothing to keep running");
	assert.equal(shouldHandOff({ ...base, enabledLoops: 0, pushServers: 1 }).handOff, true, "MCP pushes are work too");
	assert.equal(hostPushWork([{ injectSummary: true }, {}, { injectAndRun: true }], 0), 2, "tool-only servers with no rules are nothing to stay up for");
	assert.equal(hostPushWork([{ injectSummary: true }, {}], 1), 2, "with rules, every push gets evaluated");
	assert.equal(shouldHandOff({ ...base, presence: [me, { pid: 4242, host: "h", instance: "x", cwd: "/q", heartbeatAt: at }] }).handOff, false, "another interactive pi is open");
	assert.equal(shouldHandOff({ ...base, presence: [me, { pid: 4242, host: "other", instance: "x", cwd: "/q", heartbeatAt: at }] }).handOff, true, "a pi on another host does not count");
	assert.equal(shouldHandOff({ ...base, presence: [me, { pid: 4243, host: "h", instance: "x", cwd: "", kind: "host", heartbeatAt: at }] }).handOff, true, "a stale host entry does not block (hostAlive decides)");
});

test("hostSpawnArgs: TypeScript stripping flag only before Node 23.6; piPackageDir walks up from pi's cli.js", () => {
	assert.deepEqual(hostSpawnArgs("v22.6.0", "/r.mjs", "/h.mjs"), ["--experimental-strip-types", "--import", "/r.mjs", "/h.mjs"]);
	assert.deepEqual(hostSpawnArgs("v24.14.1", "/r.mjs", "/h.mjs"), ["--import", "/r.mjs", "/h.mjs"]);
	const fake = path.join(tmp(), "node_modules", "@earendil-works", "pi-coding-agent");
	fs.mkdirSync(path.join(fake, "dist", "bundle"), { recursive: true });
	fs.writeFileSync(path.join(fake, "package.json"), "{}");
	fs.writeFileSync(path.join(fake, "dist", "bundle", "cli.js"), "");
	// It resolves `argv[1]` first, because `pi` is normally a bin symlink into the package — so the
	// answer is a real path, and on macOS that is not the path a temporary directory was handed out
	// under (/var is a link to /private/var). Compare like with like.
	const realFake = fs.realpathSync(fake);
	assert.equal(piPackageDir(path.join(fake, "dist", "bundle", "cli.js")), realFake);
	const bin = path.join(tmp(), "bin");
	fs.mkdirSync(bin);
	fs.symlinkSync(path.join(fake, "dist", "bundle", "cli.js"), path.join(bin, "pi"));
	assert.equal(piPackageDir(path.join(bin, "pi")), realFake, "the `pi` bin symlink resolves to the package");
	assert.equal(piPackageDir("/usr/bin/node"), undefined);
});

test("host.json: live detection with pid-recycling guards, stale cleanup, crash detection, stop sends SIGTERM", async () => {
	const dir = tmp();
	const { spawnSync } = await import("node:child_process");
	const reaped = spawnSync("true").pid!; // a pid that is certainly not alive any more
	assert.equal(liveHost(dir), undefined);
	writeHostRecord(dir, { pid: reaped, host: os.hostname(), startedAt: at, node: "node" });
	assert.equal(liveHost(dir), undefined, "a dead pid is not live");
	assert.equal(fs.existsSync(path.join(dir, HOST_FILE)), false, "…and its record is cleaned up");
	writeHostRecord(dir, { pid: reaped, host: os.hostname(), startedAt: at, node: "node" });
	assert.equal(crashedHost(dir)?.pid, reaped, "a leftover record with no process behind it = the host died");
	assert.equal(readHost(dir), undefined);
	// A live process whose command line is not the host entry is never ours (pid recycled).
	const stranger = spawn("sleep", ["30"], { stdio: "ignore" });
	writeHostRecord(dir, { pid: stranger.pid!, host: os.hostname(), startedAt: at, node: "node" });
	assert.equal(liveHost(dir), undefined, "a recycled pid running something else is not our host");
	stranger.kill();
	// A record older than the last boot cannot be alive either.
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "src/host.ts"], { stdio: "ignore" });
	writeHostRecord(dir, { pid: child.pid!, host: os.hostname(), startedAt: "2000-01-01T00:00:00.000Z", node: "node" });
	assert.equal(liveHost(dir), undefined, "predates the boot");
	writeHostRecord(dir, { pid: child.pid!, host: os.hostname(), startedAt: at, node: "node", entry: "/elsewhere/src/host.ts" });
	assert.equal(liveHost(dir), undefined, "a record naming another entry path is not this process");
	writeHostRecord(dir, { pid: child.pid!, host: os.hostname(), startedAt: at, node: "node", entry: "src/host.ts" });
	assert.equal(liveHost(dir)?.pid, child.pid, "exact entry match");
	writeHostRecord(dir, { pid: child.pid!, host: os.hostname(), startedAt: at, node: "node" });
	assert.equal(liveHost(dir)?.pid, child.pid, "records without an entry fall back to the file name");
	const exited = new Promise<number | null>((r) => child.on("exit", (code, signal) => r(signal === "SIGTERM" ? -15 : code)));
	assert.equal(stopHost(dir), child.pid);
	assert.equal(await exited, -15, "stopHost SIGTERMs the host");
	assert.equal(liveHost(dir), undefined);
	writeHostRecord(dir, { pid: 1, host: "another-host", startedAt: at, node: "node" });
	assert.equal(liveHost(dir), undefined, "a host on another machine (shared $HOME) is not ours");
});

test("spawnHost: detached node process with the loops dir and pi's package in its environment, record pre-written", async () => {
	const dir = tmp();
	const pkg = tmp();
	fs.mkdirSync(path.join(pkg, "src"));
	fs.writeFileSync(path.join(pkg, "src", "register-pi.mjs"), "export {};\n");
	const out = path.join(dir, "seen.json");
	// The entry is `host-entry.mjs`, which is what loads host.ts: see src/ts-entry.mjs for why.
	fs.writeFileSync(path.join(pkg, "src", "host-entry.mjs"), `import * as fs from "node:fs"; fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ dir: process.env.PI_LOOPS_DIR, pi: process.env.PI_LOOPS_PI_PACKAGE, model: process.env.PI_LOOPS_HOST_MODEL, thinking: process.env.PI_LOOPS_HOST_THINKING, cwd: process.cwd(), argv: process.argv.slice(1) }));\n`);
	const pid = spawnHost({ dir, packageDir: pkg, piPackage: "/fake/pi", model: "p/m", thinking: "low" });
	assert.ok(pid > 0);
	assert.equal(readHost(dir), undefined, "the host writes its own record once it knows it is the only one");
	const end = Date.now() + 5000;
	while (!fs.existsSync(out) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
	const seen = JSON.parse(fs.readFileSync(out, "utf8"));
	assert.equal(seen.dir, dir);
	assert.equal(seen.pi, "/fake/pi");
	assert.equal(seen.model, "p/m", "the host defaults to the handing-off pi's model");
	assert.equal(seen.thinking, "low");
	assert.equal(seen.cwd, os.homedir(), "the host never runs inside a project");
	assert.equal(seen.argv[0], path.join(pkg, "src", "host-entry.mjs"));
	assert.ok(fs.existsSync(path.join(dir, "host.log")));
});

test("a thinking level handed to the host in the environment is one pi knows, or nothing", () => {
	for (const level of THINKING_LEVELS) assert.equal(thinkingLevelOrUndefined(level), level);
	// What the host does with these is fall back to the settings' default and say so in its log.
	assert.equal(thinkingLevelOrUndefined("hgih"), undefined, "a typo is not a level");
	assert.equal(thinkingLevelOrUndefined("HIGH"), undefined, "and neither is one in the wrong case");
	assert.equal(thinkingLevelOrUndefined(""), undefined);
	assert.equal(thinkingLevelOrUndefined(undefined), undefined);
	// Where a person typed it there is nobody to fall back for: the refusal lists the levels.
	assert.equal(requireThinkingLevel("high"), "high");
	assert.throws(() => requireThinkingLevel("hgih"), /unknown thinking level "hgih"; pick one of off, minimal, low, medium, high, xhigh, max/);
});
