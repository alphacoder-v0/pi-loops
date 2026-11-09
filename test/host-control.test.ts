import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { HOST_SERVICE_FILE, type HostServiceRecord, LEAVE_WAIT_MS, PAGE_TURN_WAIT_MS, decideEnsure, ensureHost, stopWaitsForPage, waitForPageTurns, hostPushWork, hostServiceAlive, hostSpawnArgs, piPackageDir, readHostService, readSpawnLog, spawnHost } from "../src/host-control.ts";
import { procStart } from "../src/lease.ts";
import { THINKING_LEVELS, requireThinkingLevel, thinkingLevelOrUndefined } from "../src/thinking.ts";

const at = new Date().toISOString();

test("ensure: no loop, rule or push server means no host; any one of them is enough", () => {
	const base = { auto: true, stopped: false, envOff: false, now: Date.now(), spawns: { attempts: [] }, myVersion: "0.23.0" };
	const spawns = (automation: { loops: number; rules: number; pushServers: number }) => decideEnsure({ ...base, automation }).kind === "spawn";
	assert.equal(spawns({ loops: 0, rules: 0, pushServers: 0 }), false, "a throwaway directory with nothing to run starts no host");
	assert.equal(spawns({ loops: 1, rules: 0, pushServers: 0 }), true);
	assert.equal(spawns({ loops: 0, rules: 1, pushServers: 0 }), true);
	assert.equal(spawns({ loops: 0, rules: 0, pushServers: 1 }), true, "MCP pushes are work too");
	assert.equal(hostPushWork([{ injectSummary: true }, {}, { injectAndRun: true }], 0), 2, "tool-only servers with no rules are nothing to stay up for");
	assert.equal(hostPushWork([{ injectSummary: true }, {}], 1), 2, "with rules, every push gets evaluated");
});

test("hostSpawnArgs: TypeScript stripping flag only before Node 23.6; piPackageDir walks up from pi's cli.js", () => {
	assert.deepEqual(hostSpawnArgs("v22.6.0", "/r.mjs", "/h.mjs"), ["--experimental-strip-types", "--import", "/r.mjs", "/h.mjs"]);
	assert.deepEqual(hostSpawnArgs("v24.14.1", "/r.mjs", "/h.mjs"), ["--import", "/r.mjs", "/h.mjs"]);
	const fake = path.join(tmp("pi-loops-host-"), "node_modules", "@earendil-works", "pi-coding-agent");
	fs.mkdirSync(path.join(fake, "dist", "bundle"), { recursive: true });
	fs.writeFileSync(path.join(fake, "package.json"), "{}");
	fs.writeFileSync(path.join(fake, "dist", "bundle", "cli.js"), "");
	// It resolves `argv[1]` first, because `pi` is normally a bin symlink into the package — so the
	// answer is a real path, and on macOS that is not the path a temporary directory was handed out
	// under (/var is a link to /private/var). Compare like with like.
	const realFake = fs.realpathSync(fake);
	assert.equal(piPackageDir(path.join(fake, "dist", "bundle", "cli.js")), realFake);
	const bin = path.join(tmp("pi-loops-host-"), "bin");
	fs.mkdirSync(bin);
	fs.symlinkSync(path.join(fake, "dist", "bundle", "cli.js"), path.join(bin, "pi"));
	assert.equal(piPackageDir(path.join(bin, "pi")), realFake, "the `pi` bin symlink resolves to the package");
	assert.equal(piPackageDir("/usr/bin/node"), undefined);
});

test("host-service.json: a record is live only while its pid, start time and command line are that host's", async () => {
	const dir = tmp("pi-loops-host-");
	const { spawnSync } = await import("node:child_process");
	const reaped = spawnSync("true").pid!; // a pid that is certainly not alive any more
	const rec = (over: Partial<HostServiceRecord>): HostServiceRecord => ({ v: 1, pid: reaped, startedAt: at, version: "0.23.0", entry: "src/host.ts", node: "node", dir, socket: "", token: "t", managed: "spawned", ...over });
	assert.equal(readHostService(dir), undefined);
	fs.writeFileSync(path.join(dir, HOST_SERVICE_FILE), JSON.stringify(rec({})));
	assert.equal(readHostService(dir)?.pid, reaped);
	assert.equal(hostServiceAlive(rec({})), false, "a dead pid is not live");
	// A live process whose command line is not the host entry is never ours (pid recycled).
	const stranger = spawn("sleep", ["30"], { stdio: "ignore" });
	assert.equal(hostServiceAlive(rec({ pid: stranger.pid! })), false, "a recycled pid running something else is not our host");
	stranger.kill();
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "src/host.ts"], { stdio: "ignore" });
	try {
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(hostServiceAlive(rec({ pid: child.pid!, entry: "/elsewhere/src/host.ts" })), false, "a record naming another entry path is not this process");
		assert.equal(hostServiceAlive(rec({ pid: child.pid! })), true, "exact entry match");
		const start = procStart(child.pid!);
		if (start) {
			assert.equal(hostServiceAlive(rec({ pid: child.pid!, procStart: start })), true, "the recorded start time matches");
			assert.equal(hostServiceAlive(rec({ pid: child.pid!, procStart: `${start}0` })), false, "a different start time is another process under a reused pid");
		}
	} finally {
		child.kill();
	}
});

test("spawnHost: detached node process with the loops dir and pi's package in its environment, record pre-written", async () => {
	const dir = tmp("pi-loops-host-");
	const pkg = tmp("pi-loops-host-");
	fs.mkdirSync(path.join(pkg, "src"));
	fs.writeFileSync(path.join(pkg, "src", "register-pi.mjs"), "export {};\n");
	const out = path.join(dir, "seen.json");
	// The entry is `host-entry.mjs`, which is what loads host.ts: see src/ts-entry.mjs for why.
	fs.writeFileSync(path.join(pkg, "src", "host-entry.mjs"), `import * as fs from "node:fs"; fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ dir: process.env.PI_LOOPS_DIR, pi: process.env.PI_LOOPS_PI_PACKAGE, model: process.env.PI_LOOPS_HOST_MODEL, thinking: process.env.PI_LOOPS_HOST_THINKING, cwd: process.cwd(), argv: process.argv.slice(1) }));\n`);
	const pid = spawnHost({ dir, packageDir: pkg, piPackage: "/fake/pi", model: "p/m", thinking: "low" });
	assert.ok(pid > 0);
	assert.equal(readHostService(dir), undefined, "the host writes its own record once it knows it is the only one");
	const end = Date.now() + 5000;
	while (!fs.existsSync(out) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
	const seen = JSON.parse(fs.readFileSync(out, "utf8"));
	assert.equal(seen.dir, dir);
	assert.equal(seen.pi, "/fake/pi");
	assert.equal(seen.model, "p/m", "a model handed over in the environment is still honoured");
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

test("a start that a person's stop overtook is recorded as stopped, not as a failed start to back off from", { timeout: 20_000 }, async () => {
	// The process finds the stop mark after its claim and leaves (src/host.ts); the window that started
	// it saw it go and wrote "exited during startup" with a backoff.
	const dir = tmp("pi-loops-host-");
	const pkg = tmp("pi-loops-host-");
	fs.mkdirSync(path.join(pkg, "src"));
	fs.writeFileSync(path.join(pkg, "src", "register-pi.mjs"), "export {};\n");
	fs.writeFileSync(path.join(pkg, "src", "host-entry.mjs"), `import * as fs from "node:fs"; fs.writeFileSync(${JSON.stringify(path.join(dir, "ui.json"))}, JSON.stringify({ host: "stopped" }));\n`);
	// `npm test` sets PI_LOOPS_HOST=off so that no test starts a real one; this one starts a stand-in.
	const off = process.env.PI_LOOPS_HOST;
	delete process.env.PI_LOOPS_HOST;
	let out: Awaited<ReturnType<typeof ensureHost>>;
	try {
		out = await ensureHost({ dir, packageDir: pkg, automation: { loops: 1, rules: 0, pushServers: 0 }, auto: true, stopped: false, myVersion: "1.0.0" });
	} finally {
		if (off === undefined) delete process.env.PI_LOOPS_HOST;
		else process.env.PI_LOOPS_HOST = off;
	}
	assert.equal(out.action.kind, "spawn");
	assert.equal(out.up, false);
	const spawns = readSpawnLog(dir);
	assert.equal(spawns.attempts.at(-1)?.outcome, "stopped");
	assert.equal(spawns.notBefore, undefined, "no backoff");
	assert.equal(spawns.lastError, undefined);
});

test("a start asked not to wait returns once the process is spawned, and the start stays in progress for the next window", { timeout: 20_000 }, async () => {
	// Quitting a terminal with plain jobs and nothing in the background started pi-loops and waited up
	// to 3 s for it to register: quitting took 1.7 to 2.9 s longer than in 0.22.8.
	const dir = tmp("pi-loops-host-");
	const pkg = tmp("pi-loops-host-");
	fs.mkdirSync(path.join(pkg, "src"));
	fs.writeFileSync(path.join(pkg, "src", "register-pi.mjs"), "export {};\n");
	// A process slow to register: a waiting start would sit here the whole 10 s.
	fs.writeFileSync(path.join(pkg, "src", "host-entry.mjs"), "setTimeout(() => {}, 3000);\n");
	const off = process.env.PI_LOOPS_HOST;
	delete process.env.PI_LOOPS_HOST;
	const opts = { dir, packageDir: pkg, automation: { loops: 0, rules: 0, pushServers: 0, closedSessionJobs: 1 }, auto: true, stopped: false, myVersion: "1.0.0" };
	let out: Awaited<ReturnType<typeof ensureHost>>;
	const began = Date.now();
	try {
		out = await ensureHost({ ...opts, wait: false });
	} finally {
		if (off === undefined) delete process.env.PI_LOOPS_HOST;
		else process.env.PI_LOOPS_HOST = off;
	}
	const took = Date.now() - began;
	assert.equal(out.action.kind, "spawn");
	assert.ok(out.pid, "the pid of the process it started");
	assert.equal(out.up, undefined, "whether it came up is not known: nobody waited");
	assert.ok(took < 1000, `returned without waiting for it to register: ${took} ms`);
	const spawns = readSpawnLog(dir);
	assert.equal(spawns.attempts.at(-1)?.outcome, undefined, "the attempt is open, so a window in the next 10 s sees a start in progress, not a failure");
	assert.equal(spawns.notBefore, undefined, "and no backoff");
	try { process.kill(out.pid!, "SIGKILL"); } catch { /* already gone */ }
});

test("a restart and an upgrade wait for the page's turns; a plain stop does not", () => {
	assert.equal(stopWaitsForPage("restart"), true);
	assert.equal(stopWaitsForPage("upgrade"), true);
	assert.equal(stopWaitsForPage("stop"), false, "a person's pi-loops stop ends a turn at once");
});

/** A clock that only moves when the wait sleeps, and the page's busy count at each moment. */
function fakeClock(busyUntil: number) {
	let t = 0;
	const lines: string[] = [];
	return {
		lines,
		at: () => t,
		opts: { busy: () => (t < busyUntil ? 1 : 0), log: (l: string) => void lines.push(l), boundMs: 1000, pollMs: 100, now: () => t, sleep: async (ms: number) => void (t += ms) },
	};
}

test("an upgrade stop with a busy page waits until it goes idle, then leaves", async () => {
	const clock = fakeClock(450);
	assert.equal(await waitForPageTurns(clock.opts), "idle");
	assert.equal(clock.at(), 500, "left at the first look after the turn finished");
	assert.deepEqual(clock.lines, ["waiting up to 1 s for a turn in the browser page to finish"]);
});

test("a page busy past the bound is left at the bound, and that is said", async () => {
	const clock = fakeClock(Infinity);
	assert.equal(await waitForPageTurns(clock.opts), "gave up");
	assert.equal(clock.at(), 1000);
	assert.equal(clock.lines.length, 2);
	assert.match(clock.lines[1], /^gave up waiting: a turn in the browser page still running after 1 s; leaving$/);
});

test("with nothing busy in the page, nothing waits and nothing is said", async () => {
	const clock = fakeClock(0);
	assert.equal(await waitForPageTurns(clock.opts), "idle");
	assert.equal(clock.at(), 0);
	assert.deepEqual(clock.lines, []);
});

test("the side that asked waits longer than the page's turns may take, and reports no failure meanwhile", async () => {
	assert.equal(PAGE_TURN_WAIT_MS, 120_000);
	assert.ok(LEAVE_WAIT_MS >= PAGE_TURN_WAIT_MS + 60_000, "the bound, the 10 s shutdown and room to spare");
	// An older process still letting a turn finish: the newer one asks, waits, and says nothing failed.
	const dir = tmp("pi-loops-host-");
	const old = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "src/host.ts"], { stdio: "ignore" });
	try {
		await new Promise((r) => setTimeout(r, 100));
		const rec: HostServiceRecord = { v: 1, pid: old.pid!, startedAt: new Date().toISOString(), version: "0.9.0", entry: "src/host.ts", node: "node", dir, socket: "", token: "t", managed: "spawned" };
		fs.writeFileSync(path.join(dir, HOST_SERVICE_FILE), JSON.stringify(rec));
		const began = Date.now();
		// `npm test` sets PI_LOOPS_HOST=off; this one asks a stand-in that never answers its socket.
		const off = process.env.PI_LOOPS_HOST;
		delete process.env.PI_LOOPS_HOST;
		let out: Awaited<ReturnType<typeof ensureHost>>;
		try {
			out = await ensureHost({ dir, packageDir: "/nowhere", automation: { loops: 1, rules: 0, pushServers: 0 }, auto: true, stopped: false, myVersion: "1.0.0", leaveWaitMs: 600 });
		} finally {
			if (off === undefined) delete process.env.PI_LOOPS_HOST;
			else process.env.PI_LOOPS_HOST = off;
		}
		assert.ok(Date.now() - began >= 600, "it waited its whole bound");
		assert.deepEqual(out, { action: { kind: "upgrade" } }, "no error while the old one is still leaving");
		assert.equal(readSpawnLog(dir).attempts.length, 0, "and it started nothing beside it");
	} finally {
		old.kill();
	}
});
