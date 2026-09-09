/**
 * The headless host: a `node` process running `src/host.ts` that keeps the clock (loops,
 * trigger checks, MCP pushes) while no interactive pi is open on this machine. The last
 * interactive pi to quit starts it; the first to open takes the clock back and the host exits.
 * `host.json` under the loops dir names the running host; `host.log` is its output.
 */
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pidAlive, writeFileAtomic } from "./lock.ts";
import type { PresenceEntry } from "./presence.ts";

export interface HostRecord {
	pid: number;
	host: string;
	startedAt: string;
	node: string;
	/** The host entry as it appears in the process's argv, for an exact command-line match. */
	entry?: string;
}

export const HOST_FILE = "host.json";
export const HOST_LOG = "host.log";

export function readHost(dir: string): HostRecord | undefined {
	try {
		const rec = JSON.parse(fs.readFileSync(path.join(dir, HOST_FILE), "utf8")) as HostRecord;
		return rec && typeof rec.pid === "number" ? rec : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Is `pid` really our host? A record can outlive its process (SIGKILL, power loss) and the pid
 * be recycled, so besides liveness we require the record to postdate the last boot and, where
 * /proc exists, the command line to be the host entry.
 */
export function hostProcessMatches(rec: HostRecord): boolean {
	if (!pidAlive(rec.pid)) return false;
	const booted = Date.now() - os.uptime() * 1000;
	if (Number.isFinite(booted) && Date.parse(rec.startedAt) < booted - 60_000) return false;
	const isOurs = (argv: string[]) => (rec.entry ? argv.includes(rec.entry) : argv.some((a) => a.endsWith("host.ts")));
	try {
		return isOurs(fs.readFileSync(`/proc/${rec.pid}/cmdline`, "utf8").split("\0"));
	} catch {
		/* no /proc (macOS): ask ps */
	}
	try {
		const command = execFileSync("ps", ["-o", "command=", "-p", String(rec.pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		return isOurs(command.trim().split(/\s+/));
	} catch {
		return true; // liveness + boot time is all we can check
	}
}

/** The host process on this machine, if it is alive. A stale record is removed. */
export function liveHost(dir: string): HostRecord | undefined {
	const rec = readHost(dir);
	if (!rec) return undefined;
	if (rec.host !== os.hostname()) return undefined;
	if (hostProcessMatches(rec)) return rec;
	fs.rmSync(path.join(dir, HOST_FILE), { force: true });
	return undefined;
}

/** A record whose process is gone means the host crashed (it removes the record on a clean exit). */
export function crashedHost(dir: string): HostRecord | undefined {
	const rec = readHost(dir);
	if (!rec || rec.host !== os.hostname()) return undefined;
	if (hostProcessMatches(rec)) return undefined;
	fs.rmSync(path.join(dir, HOST_FILE), { force: true });
	return rec;
}

export function writeHostRecord(dir: string, rec: HostRecord): void {
	writeFileAtomic(path.join(dir, HOST_FILE), `${JSON.stringify(rec, null, 2)}\n`);
}

export function clearHostRecord(dir: string, pid?: number): void {
	const rec = readHost(dir);
	if (pid !== undefined && rec && rec.pid !== pid) return;
	fs.rmSync(path.join(dir, HOST_FILE), { force: true });
}

/** SIGTERM the host (it stops its scheduler and exits); returns the pid or undefined when none ran. */
export function stopHost(dir: string): number | undefined {
	const rec = liveHost(dir);
	if (!rec) return undefined;
	try {
		process.kill(rec.pid, "SIGTERM");
	} catch {
		/* already gone */
	}
	fs.rmSync(path.join(dir, HOST_FILE), { force: true });
	return rec.pid;
}

/**
 * Hand the clock to a headless host when the last interactive pi on this machine quits and
 * there is something for it to keep running. Pure, so the decision is testable.
 */
export function shouldHandOff(input: { auto: boolean; presence: PresenceEntry[]; selfPid: number; selfInstance?: string; hostName: string; enabledLoops: number; enabledRules: number; pushServers: number; hostAlive: boolean }): { handOff: boolean; reason: string } {
	if (!input.auto) return { handOff: false, reason: "[host] auto = false" };
	if (input.hostAlive) return { handOff: false, reason: "a host is already running" };
	const others = input.presence.filter((e) => e.host === input.hostName && e.kind !== "host" && !(e.pid === input.selfPid && (!input.selfInstance || e.instance === input.selfInstance)));
	if (others.length) return { handOff: false, reason: `${others.length} other interactive pi still open` };
	if (!input.enabledLoops && !input.enabledRules && !input.pushServers) return { handOff: false, reason: "nothing to keep running" };
	return { handOff: true, reason: `${input.enabledLoops} loop(s), ${input.enabledRules} rule(s), ${input.pushServers} push source(s)` };
}

/**
 * MCP servers the host can do something with: a push either injects (inbox) or is evaluated
 * against rules — a tool-only server with no rules is nothing to stay up for.
 */
export function hostPushWork(servers: Array<{ injectSummary?: boolean; injectAndRun?: boolean }>, enabledRules: number): number {
	return servers.filter((s) => s.injectSummary || s.injectAndRun || enabledRules > 0).length;
}

/** `node [--experimental-strip-types] --import <register> <host.ts>`: TypeScript needs the flag before Node 23.6. */
export function hostSpawnArgs(nodeVersion: string, registerPath: string, entryPath: string): string[] {
	const [major, minor] = nodeVersion.replace(/^v/, "").split(".").map(Number);
	const strip = major < 23 || (major === 23 && minor < 6) ? ["--experimental-strip-types"] : [];
	return [...strip, "--import", registerPath, entryPath];
}

/** Where pi itself lives, for the host's module resolver: `<pi package>/dist/bundle/cli.js` is what runs us. */
export function piPackageDir(argv1 = process.argv[1]): string | undefined {
	if (!argv1) return undefined;
	try {
		argv1 = fs.realpathSync(argv1); // `pi` is usually a bin symlink into the package
	} catch {
		/* keep as is */
	}
	let dir = path.dirname(argv1);
	for (let i = 0; i < 4; i++) {
		if (fs.existsSync(path.join(dir, "package.json")) && /pi-coding-agent/.test(dir)) return dir;
		dir = path.dirname(dir);
	}
	return undefined;
}

export interface SpawnHostOptions {
	dir: string;
	packageDir: string;
	piPackage?: string;
	/** The handing-off pi's model and thinking level: the host's defaults for unpinned work. */
	model?: string;
	thinking?: string;
	node?: string;
	nodeVersion?: string;
}

/** Start the host detached, logging to `host.log`; returns its pid. */
export function spawnHost(opts: SpawnHostOptions): number {
	if ((process.versions as any).bun) throw new Error("the headless host needs node (pi is running under bun)");
	const node = opts.node ?? process.execPath;
	const args = hostSpawnArgs(opts.nodeVersion ?? process.version, path.join(opts.packageDir, "src", "register-pi.mjs"), path.join(opts.packageDir, "src", "host.ts"));
	fs.mkdirSync(opts.dir, { recursive: true });
	const log = fs.openSync(path.join(opts.dir, HOST_LOG), "a");
	const child = spawn(node, args, {
		detached: true,
		stdio: ["ignore", log, log],
		cwd: os.homedir(),
		env: { ...process.env, PI_LOOPS_DIR: opts.dir, ...(opts.piPackage ? { PI_LOOPS_PI_PACKAGE: opts.piPackage } : {}), ...(opts.model ? { PI_LOOPS_HOST_MODEL: opts.model } : {}), ...(opts.thinking ? { PI_LOOPS_HOST_THINKING: opts.thinking } : {}) },
	});
	fs.closeSync(log);
	// A spawn failure surfaces on the next tick; without a listener it would crash the quitting pi.
	child.once("error", (err) => {
		try {
			fs.appendFileSync(path.join(opts.dir, HOST_LOG), `${new Date().toISOString()} could not start the host: ${err?.message ?? err}\n`);
		} catch {
			/* nothing left to tell */
		}
	});
	child.unref();
	if (!child.pid) throw new Error("could not start the headless host");
	// The host writes host.json itself, under a lock, once it knows no other host is running.
	return child.pid;
}

/**
 * Wait briefly for a spawned host to record itself. `spawn` returns a pid the instant it is called,
 * so a host that dies during module resolution (a `PI_LOOPS_PI_PACKAGE` pointing at the wrong pi,
 * a missing dependency) used to be announced as a successful hand-off, leaving all automation off
 * with nothing but a line in `host.log`.
 */
export async function waitForHost(dir: string, pid: number, timeoutMs = 3000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (readHost(dir)?.pid === pid) return true;
		if (!pidAlive(pid)) return false;
		await new Promise((r) => setTimeout(r, 100));
	}
	return readHost(dir)?.pid === pid;
}
