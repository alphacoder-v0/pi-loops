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
import { previewRedacted } from "./redact.ts";

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
	/** Who starts it, said by `pi-loops status`: its environment is theirs. Default: this process. */
	startedBy?: string;
	/** The handing-off pi's model and thinking level: the host's defaults for unpinned work. */
	model?: string;
	thinking?: string;
	node?: string;
	nodeVersion?: string;
}

/** An executable `node` in one of `pathEnv`'s directories, for a pi that is not running under node itself. */
export function nodeOnPath(pathEnv: string = process.env.PATH ?? "", isExecutable: (file: string) => boolean = (file) => {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return fs.statSync(file).isFile();
	} catch {
		return false; // not there, or not ours to run
	}
}): string | undefined {
	// Absolute entries only: a relative one (`.`, `node_modules/.bin`) resolves against the project pi
	// was opened in, and would run a binary from an untrusted checkout.
	return pathEnv.split(path.delimiter).filter((d) => d && path.isAbsolute(d)).map((d) => path.join(d, "node")).find(isExecutable);
}

/**
 * The command line that runs the host: node (the one on PATH under bun), pi's module resolver, the
 * entry, and the environment it needs. `spawnHost` starts it detached; `pi-loops start --foreground`
 * runs it in the terminal, for a service manager the person set up.
 */
export function hostCommand(opts: SpawnHostOptions): { node: string; args: string[]; env: NodeJS.ProcessEnv } {
	let node = opts.node ?? process.execPath;
	let nodeVersion = opts.nodeVersion ?? process.version;
	// Under bun the running binary is not node; the host needs node, so the one on PATH runs it.
	if ((process.versions as any).bun && !opts.node) {
		const onPath = nodeOnPath();
		if (!onPath) throw new Error("pi-loops needs node in the background, and pi is running under bun with no node on PATH");
		// The file that is probed is the file that is started: a shim or symlink is resolved once.
		const found = fs.realpathSync(onPath);
		const version = execFileSync(found, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, cwd: os.homedir() }).trim();
		if (!/^v\d+\./.test(version)) throw new Error(`pi-loops needs node in the background, and ${onPath} does not answer like node (${previewRedacted(version, 40)})`);
		node = found;
		nodeVersion = version;
	}
	return {
		node,
		args: hostSpawnArgs(nodeVersion, path.join(opts.packageDir, "src", "register-pi.mjs"), path.join(opts.packageDir, "src", "host-entry.mjs")),
		env: { ...process.env, PI_LOOPS_STARTED_BY: opts.startedBy ?? `pid ${process.pid}`, PI_LOOPS_DIR: opts.dir, ...(opts.piPackage ? { PI_LOOPS_PI_PACKAGE: opts.piPackage } : {}), ...(opts.model ? { PI_LOOPS_HOST_MODEL: opts.model } : {}), ...(opts.thinking ? { PI_LOOPS_HOST_THINKING: opts.thinking } : {}) },
	};
}

/** Start the host detached, logging to `host.log`; returns its pid. */
export function spawnHost(opts: SpawnHostOptions): number {
	const { node, args, env } = hostCommand(opts);
	fs.mkdirSync(opts.dir, { recursive: true });
	const log = fs.openSync(path.join(opts.dir, HOST_LOG), "a");
	const child = spawn(node, args, {
		detached: true,
		stdio: ["ignore", log, log],
		cwd: os.homedir(),
		env,
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
	if (!child.pid) throw new Error("could not start pi-loops");
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
	/** Written by the host on every tick: its loop is turning, whatever its socket says (see decideEviction). */
	tickAt?: string;
	/** "foreground": `pi-loops start --foreground`, under a service manager the person set up. */
	managed: "spawned" | "foreground";
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
		// A record naming a dead host is one that never got to its clean exit: counted here when the new
		// host is the first to find it (a window that found it first removed it and counted it).
		if (other && other.pid !== rec.pid) recordCrash(dir, `pi-loops (pid ${other.pid}) went away without a clean exit; see ${HOST_LOG}`);
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
export function updateHostService(dir: string, pid: number, patch: Partial<Pick<HostServiceRecord, "url" | "tickAt">>): boolean {
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
	/**
	 * When a host that had started went away without a clean exit: it crashed (and said so first), a
	 * window found its record naming a dead pid, or a window evicted it. The crash budget: three within
	 * `CRASH_BUDGET.windowMs` pause the host until a person starts it (`/cron host start`), instead of a
	 * restart every tick that aborts every run in flight each time.
	 */
	crashes?: string[];
	/** Set when the crash budget ran out; only a person starting the host (`clearCrashes`) clears it. */
	pausedAt?: string;
	/** A newer pi-loops asked the host to make way: older clients do not start their own while it lives. */
	upgradedBy?: { pid: number; version: string; procStart?: string };
}

/**
 * Crashes inside this window that pause the host. Sized to the respawn cadence: a pi window restarts
 * a dead host on its 30 s tick, so three back-to-back crashes take about 90 s, and a 60 s window
 * could never catch them.
 */
export const CRASH_BUDGET = { count: 3, windowMs: 5 * 60_000 };

/** How many crashes count against the budget at `now`; the host is paused when that reaches the count. */
export function recentCrashes(log: HostSpawnLog, now: number): number {
	return (log.crashes ?? []).filter((at) => now - Date.parse(at) < CRASH_BUDGET.windowMs).length;
}

/** Record a host going away uncleanly, with why. Synchronous and locked: the crashing host calls it on its way out. */
export function recordCrash(dir: string, reason: string, now = Date.now()): HostSpawnLog {
	return withFileLockSync(path.join(dir, "host-spawns.lock"), () => {
		const log = readSpawnLog(dir);
		log.crashes = [...(log.crashes ?? []), stamp(now)].slice(-10);
		log.lastError = reason;
		if (recentCrashes(log, now) >= CRASH_BUDGET.count) log.pausedAt ??= stamp(now);
		writeFileAtomic(path.join(dir, HOST_SPAWNS_FILE), `${JSON.stringify(log, null, 2)}\n`);
		return log;
	});
}

/** A person started the host by name: the crash budget and any upgrade claim start over. */
export function clearCrashes(dir: string): void {
	withFileLockSync(path.join(dir, "host-spawns.lock"), () => {
		const log = readSpawnLog(dir);
		if (!log.crashes?.length && !log.upgradedBy && !log.pausedAt) return;
		delete log.crashes;
		delete log.pausedAt;
		delete log.upgradedBy;
		writeFileAtomic(path.join(dir, HOST_SPAWNS_FILE), `${JSON.stringify(log, null, 2)}\n`);
	});
}

/** Record which newer pi-loops asked the host to make way (see `HostSpawnLog.upgradedBy`). */
export function recordUpgrader(dir: string, upgrader: { pid: number; version: string; procStart?: string } | undefined): void {
	withFileLockSync(path.join(dir, "host-spawns.lock"), () => {
		const log = readSpawnLog(dir);
		if (upgrader) log.upgradedBy = upgrader;
		else if (!log.upgradedBy) return;
		else delete log.upgradedBy;
		writeFileAtomic(path.join(dir, HOST_SPAWNS_FILE), `${JSON.stringify(log, null, 2)}\n`);
	});
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
	automation: { loops: number; rules: number; pushServers: number; closedSessionJobs?: number; closedMailboxes?: number };
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
	/** The newer pi-loops that last asked a host to make way, and whether its process is alive. */
	upgrader?: { pid: number; version: string; alive: boolean };
}

export type EnsureAction = { kind: "none"; reason: string } | { kind: "spawn" } | { kind: "upgrade" };

export function decideEnsure(input: EnsureInput): EnsureAction {
	if (input.envOff) return { kind: "none", reason: "PI_LOOPS_HOST=off" };
	if (input.host) {
		const cmp = compareVersions(input.myVersion, input.host.version);
		if (cmp > 0 || (cmp === 0 && input.myPiVersion !== undefined && input.host.piVersion !== undefined && compareVersions(input.myPiVersion, input.host.piVersion) > 0)) return { kind: "upgrade" };
		return { kind: "none", reason: "running" };
	}
	const work = input.automation;
	if (!input.asked && !work.loops && !work.rules && !work.pushServers && !work.closedSessionJobs && !work.closedMailboxes) return { kind: "none", reason: "nothing to run" };
	// The newer client that asked the old host to make way starts its own; an older one starting the
	// old code in the gap is how two versions traded the host back and forth, aborting runs each time.
	if (input.upgrader?.alive && compareVersions(input.myVersion, input.upgrader.version) < 0) return { kind: "none", reason: `a newer pi-loops (pid ${input.upgrader.pid}) is already running` };
	if (!input.asked && input.spawns.pausedAt) return { kind: "none", reason: `paused: pi-loops stopped unexpectedly ${CRASH_BUDGET.count} times within ${CRASH_BUDGET.windowMs / 60_000} minutes — see ${HOST_LOG}; /pi-loops start resumes it` };
	if (!input.asked && !input.auto) return { kind: "none", reason: "[host] auto = false" };
	if (input.stopped) return { kind: "none", reason: "stopped (/pi-loops start resumes it)" };
	if (!input.asked && input.spawns.notBefore && input.now < Date.parse(input.spawns.notBefore)) return { kind: "none", reason: `backing off until ${input.spawns.notBefore}` };
	if (input.spawns.attempts.some((a) => a.outcome === undefined && input.now - Date.parse(a.at) < 10_000 && input.now >= Date.parse(a.at))) return { kind: "none", reason: "a start is in progress" };
	return { kind: "spawn" };
}

/**
 * Whether three unanswered probes mean a wedged host. Only with a second signal: the host writes a
 * heartbeat into its record every tick, so a socket that does not answer while the heartbeat is
 * fresh is a host that runs with a broken control channel (a removed socket, a temp-dir cleaner) —
 * killing that one only to start another with the same broken channel looped every ~100 s.
 */
export function decideEviction(input: { failures: number; probeOk: boolean; fromTick: boolean; pidMatches: boolean; heartbeatFresh?: boolean }): { failures: number; evict: boolean; channelBroken?: boolean } {
	if (input.probeOk) return { failures: 0, evict: false };
	if (!input.fromTick) return { failures: input.failures, evict: false };
	const failures = input.failures + 1;
	if (failures < 3 || !input.pidMatches) return { failures, evict: false };
	if (input.heartbeatFresh) return { failures, evict: false, channelBroken: true };
	return { failures: 0, evict: true };
}

/** A heartbeat younger than three ticks is a host whose loop still turns. */
export function heartbeatFresh(rec: Pick<HostServiceRecord, "tickAt">, now: number, tickMs = 30_000): boolean {
	return !!rec.tickAt && now - Date.parse(rec.tickAt) < 3 * tickMs;
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
	recordCrash(dir, `pi-loops (pid ${pid}) stopped answering and its heartbeat stopped; it was replaced`);
}

export interface EnsureHostOptions extends SpawnHostOptions {
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
	let rec = readHostService(opts.dir);
	// A clean exit removes the record, so one naming a dead process is a host that crashed, was killed
	// (SIGKILL, OOM) or lost power: counted against the crash budget once, then cleared.
	if (rec && !hostServiceAlive(rec)) {
		// Only the caller that removes it counts it: several windows find the same dead record at once.
		if (removeHostService(opts.dir, rec.pid)) recordCrash(opts.dir, `pi-loops (pid ${rec.pid}) went away without a clean exit; see ${HOST_LOG}`);
		rec = undefined;
	}
	const spawns = readSpawnLog(opts.dir);
	const action = decideEnsure({
		automation: opts.automation,
		auto: opts.auto,
		stopped: opts.stopped,
		envOff: process.env.PI_LOOPS_HOST?.toLowerCase() === "off",
		now: Date.now(),
		spawns,
		host: rec ? { version: rec.version, piVersion: rec.piVersion } : undefined,
		myVersion: opts.myVersion,
		myPiVersion: opts.myPiVersion,
		asked: opts.asked,
		upgrader: spawns.upgradedBy ? { ...spawns.upgradedBy, alive: spawns.upgradedBy.pid === process.pid || (pidAlive(spawns.upgradedBy.pid) && (spawns.upgradedBy.procStart === undefined || procStart(spawns.upgradedBy.pid) === spawns.upgradedBy.procStart)) } : undefined,
	});
	if (action.kind === "upgrade") {
		recordUpgrader(opts.dir, { pid: process.pid, version: opts.myVersion, procStart: procStart(process.pid) });
		await askHost(opts.dir, { op: "upgrade" });
		// Wait for it to go and start this version at once: the gap until the next tick is where an
		// older window used to start the old code again.
		const old = rec!.pid;
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const now = readHostService(opts.dir);
			if (!now || now.pid !== old || !hostServiceAlive(now)) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		const still = readHostService(opts.dir);
		if (still && hostServiceAlive(still)) return { action };
		const started = await startHost(opts, action);
		// This version's host is up: the claim that held older clients back has done its job.
		if (started.up) recordUpgrader(opts.dir, undefined);
		return started;
	}
	if (action.kind !== "spawn") return { action };
	if (opts.asked) clearCrashes(opts.dir);
	return startHost(opts, action);
}

/** Start the host and wait for it to record itself. */
async function startHost(opts: EnsureHostOptions, action: EnsureAction): Promise<{ action: EnsureAction; pid?: number; up?: boolean; error?: string }> {
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
	recordSpawn(opts.dir, { kind: "outcome", by: process.pid, outcome: ok ? "up" : "died", error: ok ? undefined : `pi-loops (pid ${pid}) exited during startup; see ${HOST_LOG}` });
	return { action, pid, up: ok };
}
