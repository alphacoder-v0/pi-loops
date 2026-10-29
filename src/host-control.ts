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
import type { UnitKind, UnitSpec } from "./host-unit.ts";

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

/**
 * What the login unit runs: the command line `spawnHost` uses, and only the environment the host
 * needs to find pi and the commands its runs call. Provider keys exported in a shell are not copied
 * into a file on disk; keys saved with pi's `/login` are in pi's own store, which the host reads.
 */
export function hostUnitSpec(opts: { kind: UnitKind; dir: string; packageDir: string; piPackage?: string; node?: string; nodeVersion?: string; env?: NodeJS.ProcessEnv; home?: string }): UnitSpec {
	const env = opts.env ?? process.env;
	return {
		node: opts.node ?? process.execPath,
		args: hostSpawnArgs(opts.nodeVersion ?? process.version, path.join(opts.packageDir, "src", "register-pi.mjs"), path.join(opts.packageDir, "src", "host-entry.mjs")),
		env: {
			PI_LOOPS_HOST_MANAGED: opts.kind,
			...(env.PATH ? { PATH: env.PATH } : {}),
			...(opts.piPackage ? { PI_LOOPS_PI_PACKAGE: opts.piPackage } : {}),
			...(env.PI_CODING_AGENT_DIR ? { PI_CODING_AGENT_DIR: env.PI_CODING_AGENT_DIR } : {}),
		},
		logFile: path.join(opts.dir, HOST_LOG),
		home: opts.home ?? os.homedir(),
	};
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
	if ((process.versions as any).bun) throw new Error("the host needs node (pi is running under bun)");
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
		writeFileAtomic(file, `${JSON.stringify(rec, null, 2)}\n`, 0o600);
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

/** Add what the host learns after its claim (the status page's URL) to its own record, and only to its own. */
export function updateHostService(dir: string, pid: number, patch: Partial<Pick<HostServiceRecord, "url">>): boolean {
	return withFileLockSync(path.join(dir, HOST_SERVICE_LOCK), () => {
		const rec = readHostService(dir);
		if (rec?.pid !== pid) return false;
		const file = path.join(dir, HOST_SERVICE_FILE);
		writeFileAtomic(file, `${JSON.stringify({ ...rec, ...patch }, null, 2)}\n`, 0o600);
		fs.chmodSync(file, 0o600);
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
	/** `closedSessionJobs`: enabled plain jobs of conversations no window holds, which the host fires. */
	automation: { loops: number; rules: number; pushServers: number; closedSessionJobs?: number };
	auto: boolean;
	stopped: boolean;
	envOff: boolean;
	now: number;
	spawns: HostSpawnLog;
	host?: { version: string; piVersion?: string };
	myVersion: string;
	myPiVersion?: string;
	/** A person asked for the host by name (`/cron host start`, `pi-loops host start`): start it even with nothing to run, `[host] auto = false` or a backoff pending. */
	asked?: boolean;
}

export type EnsureAction = { kind: "none"; reason: string } | { kind: "spawn" } | { kind: "upgrade" };

export function decideEnsure(input: EnsureInput): EnsureAction {
	if (input.envOff) return { kind: "none", reason: "PI_LOOPS_HOST=off" };
	if (input.host) {
		const cmp = compareVersions(input.myVersion, input.host.version);
		if (cmp > 0 || (cmp === 0 && input.myPiVersion !== undefined && input.host.piVersion !== undefined && compareVersions(input.myPiVersion, input.host.piVersion) > 0)) return { kind: "upgrade" };
		return { kind: "none", reason: "running" };
	}
	if (!input.asked && !input.automation.loops && !input.automation.rules && !input.automation.pushServers && !input.automation.closedSessionJobs) return { kind: "none", reason: "nothing to run" };
	if (!input.asked && !input.auto) return { kind: "none", reason: "[host] auto = false" };
	if (input.stopped) return { kind: "none", reason: "stopped (/cron host start resumes it)" };
	if (!input.asked && input.spawns.notBefore && input.now < Date.parse(input.spawns.notBefore)) return { kind: "none", reason: `backing off until ${input.spawns.notBefore}` };
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
	/**
	 * Start the host through the login unit instead of spawning it, when one is installed: the
	 * process then belongs to systemd or launchd, which restart it after a crash. Throws when the
	 * unit cannot be started, and the host is then spawned as if there were none.
	 */
	startUnit?: () => void;
	/** How long to wait for a host the unit started to record itself (10 s; tests shorten it). */
	unitWaitMs?: number;
	automation: EnsureInput["automation"];
	auto: boolean;
	stopped: boolean;
	myVersion: string;
	myPiVersion?: string;
	asked?: boolean;
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
		host: alive ? { version: alive.version, piVersion: alive.piVersion } : undefined,
		myVersion: opts.myVersion,
		myPiVersion: opts.myPiVersion,
		asked: opts.asked,
	});
	if (action.kind === "upgrade") {
		// The host leaves; the next ensure (this window's next tick) starts this version's code.
		await askHost(opts.dir, { op: "upgrade" });
		return { action };
	}
	if (action.kind !== "spawn") return { action };
	recordSpawn(opts.dir, { kind: "attempt", by: process.pid });
	if (opts.startUnit) {
		let unitError: string | undefined;
		try {
			opts.startUnit();
		} catch (err: any) {
			unitError = err?.message ?? String(err);
		}
		if (unitError === undefined) {
			// The unit's process is not ours, so there is no pid to wait on: wait for any live host to record itself.
			const deadline = Date.now() + (opts.unitWaitMs ?? 10_000);
			let winner = readHostService(opts.dir);
			while (!(winner && hostServiceAlive(winner)) && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 100));
				winner = readHostService(opts.dir);
			}
			if (winner && hostServiceAlive(winner)) {
				recordSpawn(opts.dir, { kind: "outcome", by: process.pid, outcome: "up" });
				return { action, pid: winner.pid, up: true };
			}
			// The unit manager said yes and no host came: start one directly. If the unit's host is only
			// slow, the claim keeps one of the two and the other leaves.
			unitError = "it started no host";
		}
		fs.appendFileSync(path.join(opts.dir, HOST_LOG), `${stamp()} the login unit did not start the host (${unitError}); starting it directly\n`);
	}
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
