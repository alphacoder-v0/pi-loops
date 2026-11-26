import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { LeaseBinding, LeaseStore, type LeaseHolder, type ProcessProbe } from "../src/lease.ts";
import { olderPiLoops, replaceOlderBackground, stopOlderBackground, untilAlone, olderLine, type OlderPiLoops } from "../src/older.ts";
import { PI_LOOPS_VERSION } from "../src/version.ts";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const probe = (over: Partial<ProcessProbe> = {}): ProcessProbe => ({ alive: () => true, startTime: () => "start", bootedAt: () => Date.parse("2026-11-01T00:00:00Z"), ...over });

/** An entry as pi-loops 0.22.8 writes it under `presence/` (v0.22.8 src/presence.ts). */
function presence(dir: string, over: Record<string, unknown> = {}): void {
	const entry = { pid: 4242, host: os.hostname(), instance: "i1", sessionId: "s-old", cwd: "/home/p/proj", kind: "interactive", heartbeatAt: new Date(NOW - 10_000).toISOString(), ...over };
	fs.mkdirSync(path.join(dir, "presence"), { recursive: true });
	fs.writeFileSync(path.join(dir, "presence", `${String(entry.host)}-${String(entry.pid)}-${String(entry.instance)}.json`), `${JSON.stringify(entry)}\n`);
}

/** A lease as pi-loops 0.24.2 writes it: the same shape as this version's, with no `version`. */
function lease(dir: string, sessionId: string, holder: Partial<LeaseHolder> & { version?: string } = {}, cwd = "/home/p/other"): void {
	const h = { kind: "terminal", pid: 5151, instance: "t1", procStart: "start", acquiredAt: new Date(NOW - 60_000).toISOString(), pushServers: [], ...holder };
	fs.mkdirSync(path.join(dir, "leases"), { recursive: true });
	fs.writeFileSync(path.join(dir, "leases", `${sessionId}.json`), `${JSON.stringify({ v: 1, sessionId, cwd, epoch: 1, holder: h, updatedAt: h.acquiredAt })}\n`);
}

test("[older-presence] a fresh presence entry of a live 0.22 window is an older pi-loops; a stale, dead or leasing one is not", () => {
	const fresh = tmp();
	presence(fresh);
	assert.deepEqual(olderPiLoops(fresh, NOW, probe()), [{ version: "0.22", kind: "window", pid: 4242, where: "/home/p/proj" }]);

	const background = tmp();
	presence(background, { kind: "host", cwd: "" });
	assert.deepEqual(olderPiLoops(background, NOW, probe()), [{ version: "0.22", kind: "background", pid: 4242 }]);

	const stale = tmp();
	presence(stale, { heartbeatAt: new Date(NOW - 91_000).toISOString() });
	assert.deepEqual(olderPiLoops(stale, NOW, probe()), [], "0.22 itself prunes an entry older than 90 s");

	const dead = tmp();
	presence(dead);
	assert.deepEqual(olderPiLoops(dead, NOW, probe({ alive: () => false })), [], "a pid that is gone");

	const leasing = tmp();
	presence(leasing, { leases: true });
	assert.deepEqual(olderPiLoops(leasing, NOW, probe()), [], "an entry with `leases` was written by a build that takes leases");

	const elsewhere = tmp();
	presence(elsewhere, { host: "another-machine" });
	assert.deepEqual(olderPiLoops(elsewhere, NOW, probe({ alive: () => false })), [{ version: "0.22", kind: "window", pid: 4242, where: "/home/p/proj", elsewhere: "another-machine" }], "a pid on another machine cannot be probed: the heartbeat decides");

	const future = tmp();
	presence(future, { host: "another-machine", heartbeatAt: new Date(NOW + 91_000).toISOString() });
	assert.deepEqual(olderPiLoops(future, NOW, probe()), [], "0.22 prunes a heartbeat more than 90 s ahead too: a clock that is off, or a hand-written stamp, does not wait for ever");

	const dirty = tmp();
	presence(dirty, { cwd: `/p/\u001b]52;c;aGk=\u0007${"x".repeat(400)}` });
	const where = olderPiLoops(dirty, NOW, probe())[0]?.where ?? "";
	assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(where), false, "no control character of another process's file reaches a terminal");
	assert.equal(where.length, 200, "capped");

	const torn = tmp();
	fs.mkdirSync(path.join(torn, "presence"));
	fs.writeFileSync(path.join(torn, "presence", "x.json"), "{not json");
	fs.writeFileSync(path.join(torn, "presence", "y.json"), JSON.stringify({ pid: "1", heartbeatAt: new Date(NOW).toISOString() }));
	assert.deepEqual(olderPiLoops(torn, NOW, probe()), []);
	assert.deepEqual(olderPiLoops(tmp(), NOW, probe()), [], "no presence directory, no leases");
});

test("[older-lease] a live holder of a lease with no `version` is an older pi-loops; one with a version, or a dead holder, is not", () => {
	const old = tmp();
	lease(old, "s1");
	assert.deepEqual(olderPiLoops(old, NOW, probe()), [{ version: "0.24", kind: "window", pid: 5151, where: "/home/p/other" }]);

	const oldHost = tmp();
	lease(oldHost, "s1", { kind: "host" });
	assert.deepEqual(olderPiLoops(oldHost, NOW, probe()), [], "0.24.2 in the background is told by its service record, not by a lease it holds for one turn");

	const current = tmp();
	lease(current, "s1", { version: "0.24.3" });
	assert.deepEqual(olderPiLoops(current, NOW, probe()), []);

	const page = tmp();
	lease(page, "s1", { page: true } as Partial<LeaseHolder>);
	assert.deepEqual(olderPiLoops(page, NOW, probe()), [{ version: "0.24", kind: "window", pid: 5151, where: "/home/p/other", page: true }]);

	const recycled = tmp();
	lease(recycled, "s1");
	assert.deepEqual(olderPiLoops(recycled, NOW, probe({ startTime: () => "another start" })), [], "the pid is alive but is another process");

	const free = tmp();
	lease(free, "s1");
	const file = path.join(free, "leases", "s1.json");
	fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), holder: null }));
	assert.deepEqual(olderPiLoops(free, NOW, probe()), [], "a lease nobody holds");

	const both = tmp();
	presence(both);
	lease(both, "s1");
	lease(both, "s2", { pid: 5151, instance: "t1" }, "/home/p/third");
	assert.deepEqual(olderPiLoops(both, NOW, probe()).map((o) => `${o.version}:${o.pid}`), ["0.22:4242", "0.24:5151"], "one entry per process, 0.22 first");

	const order = tmp();
	presence(order, { pid: 1, kind: "host", cwd: "", instance: "bg" });
	presence(order, { pid: 2 });
	lease(order, "s1", { pid: 3 });
	assert.deepEqual(olderPiLoops(order, NOW, probe()).map((o) => `${o.version}:${o.kind}:${o.pid}`), ["0.22:window:2", "0.24:window:3", "0.22:background:1"], "a window first: the line names what a person has to close");
});

test("[older-record] a live service record of an older version is pi-loops 0.24.2 or earlier in the background; this version's own is not", async () => {
	const { spawn } = await import("node:child_process");
	// A live process with an entry of its own, as pi-loops in the background is, for the record to name.
	const entry = path.join(tmp(), "src", "host-entry.mjs");
	fs.mkdirSync(path.dirname(entry), { recursive: true });
	fs.writeFileSync(entry, "setInterval(() => {}, 1000);\n");
	const child = spawn(process.execPath, [entry], { stdio: "ignore" });
	try {
		await new Promise((r) => setTimeout(r, 300));
		const record = (dir: string, version: string, pid = child.pid!): void => fs.writeFileSync(path.join(dir, "host-service.json"), JSON.stringify({ v: 1, pid, startedAt: new Date().toISOString(), version, entry, node: process.execPath, dir, socket: path.join(dir, "s.sock"), token: "t", managed: "spawned" }));
		const older = tmp();
		record(older, "0.24.2");
		assert.deepEqual(olderPiLoops(older, NOW, probe(), "0.24.3"), [{ version: "0.24", kind: "background", pid: child.pid }]);
		const same = tmp();
		record(same, "0.24.3");
		assert.deepEqual(olderPiLoops(same, NOW, probe(), "0.24.3"), []);
		const gone = tmp();
		record(gone, "0.24.2", 2_000_000_000);
		assert.deepEqual(olderPiLoops(gone, NOW, probe(), "0.24.3"), [], "a record of a process that is gone");
	} finally {
		child.kill("SIGKILL");
	}
});

test("[older-presence] a presence file that is not a regular file of an entry's size is not read, and reading the directory does not block", { skip: process.platform === "win32" }, async () => {
	const { spawnSync } = await import("node:child_process");
	const dir = tmp();
	fs.mkdirSync(path.join(dir, "presence"));
	assert.equal(spawnSync("mkfifo", [path.join(dir, "presence", "fifo.json")]).status, 0, "mkfifo");
	fs.symlinkSync("/dev/zero", path.join(dir, "presence", "zero.json"));
	fs.writeFileSync(path.join(dir, "presence", "big.json"), JSON.stringify({ pid: 4242, host: os.hostname(), cwd: "x".repeat(20_000), heartbeatAt: new Date().toISOString() }));
	// In a child: a read that blocks on the FIFO blocks the whole process, so the test cannot time it out from inside.
	const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
	const script = `import(${JSON.stringify(path.join(repo, "src/older.ts"))}).then((m) => { process.stdout.write(JSON.stringify(m.olderPiLoops(${JSON.stringify(dir)}, Date.now()))); process.exit(0); })`;
	const child = spawnSync(process.execPath, ["--import", path.join(repo, "src/register-pi.mjs"), "--input-type=module", "-e", script], { encoding: "utf8", timeout: 15_000, env: { ...process.env, PI_LOOPS_HOST: "off" } });
	assert.equal(child.signal, null, "the read returned instead of blocking");
	assert.equal(child.stdout, "[]");
});

test("[older-lease] every lease this version writes carries its version", () => {
	const dir = tmp();
	const store = new LeaseStore(dir);
	const binding = new LeaseBinding(store, "w1", () => ({ kind: "terminal", pid: process.pid, procStart: undefined, pushServers: [] }));
	binding.bind("s-new", { cwd: "/p" });
	assert.equal(store.read("s-new")?.holder?.version, PI_LOOPS_VERSION);
	assert.deepEqual(olderPiLoops(dir, Date.now()), [], "this process's own lease is not an older pi-loops");
});

test("[older-line] the line names the version, the pid, where it is open, and what to do", () => {
	const window22: OlderPiLoops = { version: "0.22", kind: "window", pid: 4242, where: "/home/p/proj" };
	const window24: OlderPiLoops = { version: "0.24", kind: "window", pid: 5151, where: "/home/p/other" };
	const background: OlderPiLoops = { version: "0.22", kind: "background", pid: 77 };
	const background24: OlderPiLoops = { version: "0.24", kind: "background", pid: 78 };
	const remote: OlderPiLoops = { version: "0.22", kind: "background", pid: 1, elsewhere: "laptop-b" };
	assert.equal(olderLine([], "0.24.3"), undefined);
	assert.equal(olderLine([window22], "0.24.3"), "pi-loops 0.24.3 is waiting: a pi window with pi-loops 0.22 (pid 4242, /home/p/proj) is still open. Close it, and pi-loops 0.24.3 starts. Until then, that window runs your loops.");
	assert.equal(olderLine([window24], "0.24.3"), "pi-loops 0.24.3 is waiting: a pi terminal with pi-loops 0.24.2 or earlier (pid 5151, /home/p/other) is still open. Restart it, and pi-loops 0.24.3 starts. Until then, pi-loops 0.24.3 runs nothing here, and pi-loops 0.24.2 in the background, while it still runs, runs your loops.");
	assert.equal(olderLine([background], "0.24.3"), "pi-loops 0.24.3 is waiting: pi-loops 0.22 in the background (pid 77) is still running. A pi window of 0.24.3 that opens here replaces it, and pi-loops 0.24.3 starts.");
	assert.equal(olderLine([background24], "0.24.3"), "pi-loops 0.24.3 is waiting: pi-loops 0.24.2 or earlier in the background (pid 78) is still running. A pi window of 0.24.3 that opens here replaces it, and pi-loops 0.24.3 starts.");
	assert.equal(olderLine([remote], "0.24.3"), "pi-loops 0.24.3 is waiting: pi-loops 0.22 in the background on laptop-b (pid 1) is still running. Stop it on that machine, and pi-loops 0.24.3 starts.", "no pid of another machine to kill here");
	assert.match(olderLine([{ ...window22, elsewhere: "laptop-b" }], "0.24.3") ?? "", /a pi window with pi-loops 0\.22 on laptop-b \(pid 4242/);
	assert.match(olderLine([{ ...window24, page: true }], "0.24.3") ?? "", /a conversation is open in the browser page of pi-loops 0\.24\.2 or earlier \(pid 5151, \/home\/p\/other\)\. Close it in the page/, "a 0.24.2 page child is no terminal of the person's");
	assert.equal(olderLine([window22, window24, background], "0.24.3"), `${olderLine([window22], "0.24.3")} 2 more older pi-loops processes are open: pids 5151, 77.`);
});

test("[older-wait] untilAlone says the line once, looks again on each poll, and resolves when the older one is gone", async () => {
	const dir = tmp();
	presence(dir, { heartbeatAt: new Date().toISOString() });
	const said: string[] = [];
	let looks = 0;
	await untilAlone(dir, {
		say: (line) => said.push(line),
		self: "0.24.3",
		everyMs: 5,
		confirmMs: 5,
		probe: probe(),
		each: () => {
			looks++;
			if (looks === 3) fs.rmSync(path.join(dir, "presence"), { recursive: true });
			return false;
		},
	});
	assert.equal(looks, 3);
	assert.deepEqual(said, [olderLine([{ version: "0.22", kind: "window", pid: 4242, where: "/home/p/proj" }], "0.24.3")]);
	let ran = false;
	await untilAlone(tmp(), { say: () => { ran = true; }, self: "0.24.3", each: () => { ran = true; return false; } });
	assert.equal(ran, false, "nothing older: it resolves at once and says nothing");
});

test("[older-wait] after the older window goes, nothing older must be seen for a while: the background a 0.22 window starts as it closes is caught; after a stop it looks again soon", async () => {
	const dir = tmp();
	presence(dir, { heartbeatAt: new Date().toISOString() });
	const said: string[] = [];
	const pauses: number[] = [];
	let looks = 0;
	const started = Date.now();
	await untilAlone(dir, {
		say: (line) => said.push(line),
		self: "0.24.3",
		everyMs: 5_000,
		afterStopMs: 5,
		confirmMs: 100,
		probe: probe(),
		each: () => {
			looks++;
			pauses.push(Date.now());
			fs.rmSync(path.join(dir, "presence"), { recursive: true });
			// The window's entry is gone; 0.22's background writes its own a moment later, while the wait confirms.
			if (looks === 1) setTimeout(() => presence(dir, { pid: 4343, kind: "host", cwd: "", instance: "bg", heartbeatAt: new Date().toISOString() }), 30);
			return true;
		},
	});
	assert.equal(looks, 2, "the background that appeared while it confirmed was seen and asked");
	assert.match(said[1] ?? "", /pi-loops 0\.22 in the background \(pid 4343\)/);
	assert.ok(Date.now() - started < 2_000, "after a stop it looked again at once, not after a whole poll");
});

test("[older-stop] once no older window is open, a waiting process replaces an older background on this machine, and nothing else", async () => {
	const { spawn } = await import("node:child_process");
	const dir = tmp();
	// A process that runs the entry 0.22.8's record names, as v0.22.8 starts it when its last window closes.
	const entry = path.join(tmp(), "src", "host-entry.mjs");
	fs.mkdirSync(path.dirname(entry), { recursive: true });
	fs.writeFileSync(entry, "setInterval(() => {}, 1000);\n");
	const child = spawn(process.execPath, [entry], { stdio: "ignore" });
	const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
	const background: OlderPiLoops = { version: "0.22", kind: "background", pid: child.pid! };
	try {
		await new Promise((r) => setTimeout(r, 300));
		const said: string[] = [];
		assert.equal(await stopOlderBackground(dir, [background], (l) => said.push(l)), false, "no host.json of 0.22.8 names it: it is not stopped");
		fs.writeFileSync(path.join(dir, "host.json"), JSON.stringify({ pid: child.pid, host: os.hostname(), startedAt: new Date().toISOString(), node: process.execPath, entry }));
		assert.equal(await stopOlderBackground(dir, [{ version: "0.22", kind: "window", pid: 11 }, background], (l) => said.push(l)), false, "a 0.22 window is still open: its background stays, as before");
		assert.equal(await stopOlderBackground(dir, [background], (l) => said.push(l)), true);
		assert.equal(await exited, "SIGTERM");
		assert.deepEqual(said, [`asked pi-loops 0.22 in the background (pid ${child.pid}) to stop, as an upgrade replaces an older pi-loops`]);
	} finally {
		child.kill("SIGKILL");
	}
	const killed: number[] = [];
	const kill = (pid: number) => void killed.push(pid);
	fs.writeFileSync(path.join(dir, "host.json"), JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString(), node: process.execPath, entry }));
	assert.equal(await stopOlderBackground(dir, [{ version: "0.22", kind: "background", pid: process.pid }], () => undefined, { kill }), false, "a pid that does not run the entry the record names (this test) is not stopped");
	assert.equal(await stopOlderBackground(dir, [{ version: "0.22", kind: "background", pid: 12, elsewhere: "laptop-b" }], () => undefined, { kill, isOldHost: () => true }), false, "another machine's process is not stopped here");
	assert.deepEqual(killed, []);
	const upgrades: string[] = [];
	const said: string[] = [];
	assert.equal(await stopOlderBackground(dir, [{ version: "0.24", kind: "background", pid: 13 }], (l) => said.push(l), { kill, askUpgrade: async () => { upgrades.push("asked"); return true; } }), true);
	assert.deepEqual([upgrades, said, killed], [["asked"], ["asked pi-loops 0.24.2 or earlier in the background (pid 13) to make way, as an upgrade does"], []], "0.24.2 in the background is asked over its socket, as an upgrade asks it");
});

test("[older-replace] a window that starts beside an older background alone asks it to make way and goes on once it is gone, or after the bound", async () => {
	const { spawn } = await import("node:child_process");
	const dir = tmp();
	const entry = path.join(tmp(), "src", "host-entry.mjs");
	fs.mkdirSync(path.dirname(entry), { recursive: true });
	fs.writeFileSync(entry, "setInterval(() => {}, 1000);\n");
	const child = spawn(process.execPath, [entry], { stdio: "ignore" });
	try {
		await new Promise((r) => setTimeout(r, 300));
		presence(dir, { pid: child.pid, kind: "host", cwd: "", instance: "bg", heartbeatAt: new Date().toISOString() });
		fs.writeFileSync(path.join(dir, "host.json"), JSON.stringify({ pid: child.pid, host: os.hostname(), startedAt: new Date().toISOString(), node: process.execPath, entry }));
		const said: string[] = [];
		const started = Date.now();
		assert.equal(await replaceOlderBackground(dir, (l) => said.push(l), { boundMs: 5_000, pollMs: 20 }), true, "gone once it stopped");
		assert.ok(Date.now() - started < 5_000);
		assert.match(said[0] ?? "", /asked pi-loops 0\.22 in the background/);
	} finally {
		child.kill("SIGKILL");
	}
	assert.equal(await replaceOlderBackground(tmp(), () => undefined), true, "nothing older: at once");
	const stays = tmp();
	presence(stays, { pid: process.pid, kind: "host", cwd: "", instance: "bg", heartbeatAt: new Date().toISOString() });
	assert.equal(await replaceOlderBackground(stays, () => undefined, { boundMs: 100, pollMs: 20 }), false, "one that does not go: not gone after the bound");
	const window = tmp();
	presence(window, { pid: process.pid, heartbeatAt: new Date().toISOString() });
	assert.equal(await replaceOlderBackground(window, () => undefined, { boundMs: 100 }), false, "an older window: nothing is replaced");
});
