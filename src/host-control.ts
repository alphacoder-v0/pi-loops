/**
 * The always-on host: a `node` process running `src/host.ts` that runs every loop, rule check and
 * MCP push for one loops directory. A pi window starts it when there is automation to run
 * (`ensureHost`), and it never yields to one. `host-service.json` names the running host;
 * `host.log` is its output.
 */
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pidAlive, withFileLockSync, writeFileAtomic } from "./lock.ts";
import { procStart } from "./lease.ts";
import { compareVersions } from "./pi-floor.ts";
import { askHost } from "./host-control-channel.ts";
import { stamp } from "./schedule.ts";

export const HOST_LOG = "host.log";

/**
 * MCP servers the host can do something with: a push either injects (inbox) or is evaluated
 * against rules — a tool-only server with no rules is nothing to stay up for.
 */
export function hostPushWork(servers: Array<{ injectSummary?: boolean; injectAndRun?: boolean }>, enabledRules: number): number {
	return servers.filter((s) => s.injectSummary || s.injectAndRun || enabledRules > 0).length;
}

/**
 * `node [--experimental-strip-types] --import <register> <host-entry.mjs>`: TypeScript needs the flag
 * before Node 23.6. The entry is the `.mjs` and not `host.ts` on purpose — under an npm install this
 * package sits below node_modules, where Node refuses to strip types at all and only the jiti route
 * inside src/ts-entry.mjs can open the file.
 */
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
	const args = hostSpawnArgs(opts.nodeVersion ?? process.version, path.join(opts.packageDir, "src", "register-pi.mjs"), path.join(opts.packageDir, "src", "host-entry.mjs"));
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
			fs.appendFileSync(path.join(opts.dir, HOST_LOG), `${stamp()} could not start the host: ${err?.message ?? err}\n`);
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
		if (readHostService(dir)?.pid === pid) return true;
		if (!pidAlive(pid)) return false;
		await new Promise((r) => setTimeout(r, 100));
	}
	return readHostService(dir)?.pid === pid;
}

export const HOST_SERVICE_FILE = "host-service.json";
export const HOST_SERVICE_LOCK = "host-service.lock";
export const HOST_SERVICE_SOCKET = "host-service.sock";
export const HOST_SPAWNS_FILE = "host-spawns.json";

export interface HostServiceRecord {
	v: 1;
	pid: number;
	/** OS process start time (src/lease.ts procStart), against pid recycling. */
	procStart?: string;
	startedAt: string;
	/** PI_LOOPS_VERSION of the running host. */
	version: string;
	piVersion?: string;
	/** argv entry, for the command-line match hostProcessMatches already does. */
	entry: string;
	node: string;
	/** The loops directory this host serves. */
	dir: string;
	socket: string;
	/** The status page, when its port could be bound. */
	url?: string;
	/** Bearer token for the status page. */
	token: string;
	managed: "spawned" | "systemd" | "launchd";
	/** Set while it drains for an upgrade or a stop: it dispatches nothing new. */
	draining?: { reason: "upgrade" | "stop"; since: string };
}

export function readHostService(dir: string): HostServiceRecord | undefined {
	try {
		const value: unknown = JSON.parse(fs.readFileSync(path.join(dir, HOST_SERVICE_FILE), "utf8"));
		if (!value || typeof value !== "object") return undefined;
		const rec = value as HostServiceRecord;
		return rec.v === 1 && typeof rec.pid === "number" ? rec : undefined;
	} catch {
		return undefined;
	}
}

function commandMatches(pid: number, entry: string): boolean {
	const isOurs = (argv: string[]) => argv.includes(entry);
	try {
		return isOurs(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"));
	} catch {
		/* no /proc (macOS): ask ps */
	}
	try {
		const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		return isOurs(command.trim().split(/\s+/));
	} catch {
		return true; // liveness is all we can check
	}
}

export function hostServiceAlive(rec: HostServiceRecord): boolean {
	if (!pidAlive(rec.pid)) return false;
	if (rec.procStart !== undefined && procStart(rec.pid) !== rec.procStart) return false;
	return commandMatches(rec.pid, rec.entry);
}

export function claimHostService(dir: string, rec: HostServiceRecord, alive: (r: HostServiceRecord) => boolean = hostServiceAlive): { claimed: true } | { claimed: false; other: HostServiceRecord } {
	return withFileLockSync(path.join(dir, HOST_SERVICE_LOCK), () => {
		const other = readHostService(dir);
		if (other && other.pid !== rec.pid && alive(other)) return { claimed: false, other };
		const file = path.join(dir, HOST_SERVICE_FILE);
		writeFileAtomic(file, `${JSON.stringify(rec, null, 2)}\n`);
		fs.chmodSync(file, 0o600);
		return { claimed: true };
	});
}

export function removeHostService(dir: string, pid: number): boolean {
	return withFileLockSync(path.join(dir, HOST_SERVICE_LOCK), () => {
		if (readHostService(dir)?.pid !== pid) return false;
		fs.rmSync(path.join(dir, HOST_SERVICE_FILE), { force: true });
		return true;
	});
}

export function hostServiceNames(dir: string, pid: number, startedAt: string): boolean {
	const rec = readHostService(dir);
	return rec?.pid === pid && rec.startedAt === startedAt;
}

export type SpawnOutcome = "up" | "died" | "no-node" | "evicted";
export interface HostSpawnLog {
	attempts: Array<{ at: string; by: number; outcome?: SpawnOutcome }>;
	notBefore?: string;
	lastError?: string;
}

export function readSpawnLog(dir: string): HostSpawnLog {
	try {
		const value: unknown = JSON.parse(fs.readFileSync(path.join(dir, HOST_SPAWNS_FILE), "utf8"));
		const log = value as HostSpawnLog;
		return log && Array.isArray(log.attempts) ? log : { attempts: [] };
	} catch {
		return { attempts: [] };
	}
}

export function recordSpawn(dir: string, event: { kind: "attempt"; by: number } | { kind: "outcome"; by: number; outcome: SpawnOutcome; error?: string }, now = Date.now()): HostSpawnLog {
	return withFileLockSync(path.join(dir, "host-spawns.lock"), () => {
		const log = readSpawnLog(dir);
		if (event.kind === "attempt") log.attempts.push({ at: stamp(now), by: event.by });
		else {
			let attempt = [...log.attempts].reverse().find((a) => a.by === event.by && a.outcome === undefined);
			if (!attempt) {
				attempt = { at: stamp(now), by: event.by };
				log.attempts.push(attempt);
			}
			attempt.outcome = event.outcome;
			if (event.error !== undefined) log.lastError = event.error;
			let failures = 0;
			for (const a of [...log.attempts].reverse()) {
				if (a.outcome === "evicted") continue;
				if (a.outcome === "died" || a.outcome === "no-node") failures++;
				else break;
			}
			if (!failures) {
				delete log.notBefore;
				if (event.outcome === "up") delete log.lastError;
			} else log.notBefore = stamp(now + (failures === 1 ? 60_000 : failures === 2 ? 300_000 : 1_800_000));
		}
		log.attempts = log.attempts.slice(-20);
		writeFileAtomic(path.join(dir, HOST_SPAWNS_FILE), `${JSON.stringify(log, null, 2)}\n`);
		return log;
	});
}

export interface EnsureInput {
	automation: { loops: number; rules: number; pushServers: number };
	auto: boolean;
	stopped: boolean;
	envOff: boolean;
	now: number;
	spawns: HostSpawnLog;
	host?: { version: string; piVersion?: string; draining?: boolean };
	myVersion: string;
	myPiVersion?: string;
}

export type EnsureAction = { kind: "none"; reason: string } | { kind: "spawn" } | { kind: "upgrade" };

export function decideEnsure(input: EnsureInput): EnsureAction {
	if (input.envOff) return { kind: "none", reason: "PI_LOOPS_HOST=off" };
	if (input.host) {
		if (input.host.draining) return { kind: "none", reason: "draining" };
		const cmp = compareVersions(input.myVersion, input.host.version);
		if (cmp > 0 || (cmp === 0 && input.myPiVersion !== undefined && input.host.piVersion !== undefined && compareVersions(input.myPiVersion, input.host.piVersion) > 0)) return { kind: "upgrade" };
		return { kind: "none", reason: "running" };
	}
	if (!input.automation.loops && !input.automation.rules && !input.automation.pushServers) return { kind: "none", reason: "nothing to run" };
	if (!input.auto) return { kind: "none", reason: "[host] auto = false" };
	if (input.stopped) return { kind: "none", reason: "stopped (/cron host start resumes it)" };
	if (input.spawns.notBefore && input.now < Date.parse(input.spawns.notBefore)) return { kind: "none", reason: `backing off until ${input.spawns.notBefore}` };
	if (input.spawns.attempts.some((a) => a.outcome === undefined && input.now - Date.parse(a.at) < 10_000 && input.now >= Date.parse(a.at))) return { kind: "none", reason: "a start is in progress" };
	return { kind: "spawn" };
}

export function decideEviction(input: { failures: number; probeOk: boolean; fromTick: boolean; pidMatches: boolean }): { failures: number; evict: boolean } {
	if (input.probeOk) return { failures: 0, evict: false };
	if (!input.fromTick) return { failures: input.failures, evict: false };
	const failures = input.failures + 1;
	return failures >= 3 && input.pidMatches ? { failures: 0, evict: true } : { failures, evict: false };
}

export async function evictHost(dir: string, pid: number, opts: { graceMs?: number; kill?: (pid: number, signal: NodeJS.Signals) => void; alive?: (pid: number) => boolean } = {}): Promise<void> {
	const kill = opts.kill ?? ((target, signal) => process.kill(target, signal));
	const alive = opts.alive ?? pidAlive;
	try {
		kill(pid, "SIGTERM");
	} catch (err: any) {
		if (err?.code !== "ESRCH") throw err;
		/* ESRCH means it exited before the signal arrived. */
	}
	const deadline = Date.now() + (opts.graceMs ?? 10_000);
	while (alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
	if (alive(pid)) {
		try {
			kill(pid, "SIGKILL");
		} catch (err: any) {
			if (err?.code !== "ESRCH") throw err;
			/* ESRCH means it exited before the signal arrived. */
		}
	}
	removeHostService(dir, pid);
	recordSpawn(dir, { kind: "outcome", by: process.pid, outcome: "evicted" });
}

export interface EnsureHostOptions extends SpawnHostOptions {
	automation: EnsureInput["automation"];
	auto: boolean;
	stopped: boolean;
	myVersion: string;
	myPiVersion?: string;
}

/**
 * Make sure the host is running when there is automation for it: start it, ask an older one to make
 * way for this version, or leave it alone (src/host-control.ts decideEnsure decides which). Never
 * throws: a host that cannot start is a result, recorded in the spawn log with its backoff.
 */
export async function ensureHost(opts: EnsureHostOptions): Promise<{ action: EnsureAction; pid?: number; up?: boolean; error?: string }> {
	const rec = readHostService(opts.dir);
	const alive = rec && hostServiceAlive(rec) ? rec : undefined;
	const action = decideEnsure({
		automation: opts.automation,
		auto: opts.auto,
		stopped: opts.stopped,
		envOff: process.env.PI_LOOPS_HOST?.toLowerCase() === "off",
		now: Date.now(),
		spawns: readSpawnLog(opts.dir),
		host: alive ? { version: alive.version, piVersion: alive.piVersion, draining: !!alive.draining } : undefined,
		myVersion: opts.myVersion,
		myPiVersion: opts.myPiVersion,
	});
	if (action.kind === "upgrade") {
		// The host leaves; the next ensure (this window's next tick) starts this version's code.
		await askHost(opts.dir, { op: "upgrade" });
		return { action };
	}
	if (action.kind !== "spawn") return { action };
	recordSpawn(opts.dir, { kind: "attempt", by: process.pid });
	let pid: number;
	try {
		pid = spawnHost(opts);
	} catch (err: any) {
		const error = err?.message ?? String(err);
		recordSpawn(opts.dir, { kind: "outcome", by: process.pid, outcome: "no-node", error });
		return { action, error };
	}
	const up = await waitForHost(opts.dir, pid, 10_000);
	// A second host that lost the claim exits 0 at once: it is not a failed start, the winner is up.
	const winner = readHostService(opts.dir);
	const ok = up || (!!winner && hostServiceAlive(winner));
	recordSpawn(opts.dir, { kind: "outcome", by: process.pid, outcome: ok ? "up" : "died", error: ok ? undefined : `the host (pid ${pid}) exited during startup; see ${HOST_LOG}` });
	return { action, pid, up: ok };
}
