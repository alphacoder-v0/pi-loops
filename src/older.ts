/**
 * An older pi-loops that works in this loops directory now (owner decision, 2026-11-26: one version
 * at a time). Two versions in one directory each write its files in their own shape: a claim or a
 * dismiss in 0.22.8 or 0.24.2 writes `inbox.jsonl` again and drops every field this version added,
 * and a 0.22 window checks its project's rules beside pi-loops in the background. So while one is
 * open, this version converts nothing and runs nothing here, and says so (`olderLine`).
 *
 * Three marks tell one apart, each read from a file that the older version writes on its own:
 *   - pi-loops 0.22 writes `presence/<host>-<pid>-<instance>.json` every 30 s, with no `leases`
 *     field. It prunes an entry whose heartbeat is more than 90 s from now, either way, or whose pid
 *     is gone, and so does this reader.
 *   - a pi terminal of pi-loops 0.24.2 or earlier holds a lease with no `version`. Every lease this
 *     version writes carries one (`LeaseBinding`, and the background's holder in src/host-runtime.ts).
 *   - pi-loops 0.24.2 or earlier in the background has a live `host-service.json` of its version.
 *
 * While an older window or terminal is open, the older version's own background goes on as before.
 * Once none is, a process of this version that waits replaces that background (`stopOlderBackground`).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { askHost } from "./host-control-channel.ts";
import { hostServiceAlive, readHostService } from "./host-control.ts";
import { holderAlive, LeaseStore, type ProcessProbe, systemProbe } from "./lease.ts";
import { compareVersions } from "./pi-floor.ts";
import { PI_LOOPS_VERSION } from "./version.ts";

/** pi-loops 0.22 prunes a presence entry whose heartbeat is further than this from now (v0.22.8 src/presence.ts). */
const PRESENCE_STALE_MS = 90_000;
/** A presence entry 0.22.8 writes is under 200 bytes: a bigger file is not one, and is not read. */
const PRESENCE_MAX_BYTES = 16 * 1024;
/** The longest project path a line shows. */
const WHERE_MAX_CHARS = 200;

export interface OlderPiLoops {
	/** "0.22": it writes `presence/`. "0.24": a lease holder with no `version`, or a service record, of 0.24.2 or earlier. */
	version: "0.22" | "0.24";
	/** A pi window or terminal, or pi-loops in the background. */
	kind: "window" | "background";
	pid: number;
	/** The project it has open, when its file names one. */
	where?: string;
	/** The machine of a 0.22 entry from another machine that shares this directory: its pid is not one here. */
	elsewhere?: string;
}

/** Each older pi-loops open in `dir` now, one per process: windows first, the 0.22 ones first among each. */
export function olderPiLoops(dir: string, now: number, probe: ProcessProbe = systemProbe, self: string = PI_LOOPS_VERSION): OlderPiLoops[] {
	const found: OlderPiLoops[] = [];
	const seen = new Set<string>();
	const add = (o: OlderPiLoops, key: string): void => {
		if (seen.has(key)) return;
		seen.add(key);
		found.push(o);
	};
	const machine = os.hostname();
	for (const entry of presenceEntries(dir)) {
		if (entry.leases === true) continue;
		const age = now - Date.parse(entry.heartbeatAt);
		if (!(Math.abs(age) <= PRESENCE_STALE_MS)) continue;
		// A pid on another machine that shares this directory cannot be probed: its heartbeat decides.
		if (entry.host === machine && !probe.alive(entry.pid)) continue;
		const where = shown(entry.cwd);
		add({ version: "0.22", kind: entry.kind === "host" ? "background" : "window", pid: entry.pid, ...(where ? { where } : {}), ...(entry.host === machine ? {} : { elsewhere: shown(entry.host) || "another machine" }) }, `${entry.host}:${entry.pid}`);
	}
	for (const lease of new LeaseStore(dir).list()) {
		const holder = lease.holder;
		// The background of 0.24.2 is told by its service record below, not by a lease it holds for one turn.
		if (!holder || holder.kind === "host" || holder.version !== undefined || !holderAlive(holder, probe)) continue;
		const where = shown(lease.cwd);
		add({ version: "0.24", kind: "window", pid: holder.pid, ...(where ? { where } : {}) }, `${machine}:${holder.pid}`);
	}
	const rec = readHostService(dir);
	if (rec && compareVersions(rec.version, self) < 0 && hostServiceAlive(rec)) add({ version: "0.24", kind: "background", pid: rec.pid }, `${machine}:${rec.pid}`);
	// A window first: that is the one a person has to close; pi-loops replaces an older background itself.
	return [...found.filter((o) => o.kind === "window"), ...found.filter((o) => o.kind === "background")];
}

/** Text from another process's file as a line shows it: on one line, no control characters, capped. */
function shown(text: string | undefined): string {
	return (text ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, WHERE_MAX_CHARS);
}

interface PresenceEntry {
	pid: number;
	host: string;
	cwd: string;
	kind?: string;
	leases?: unknown;
	heartbeatAt: string;
}

/** The entries of `presence/` that parse as 0.22.8 wrote them; a torn or foreign file is not one. */
function presenceEntries(dir: string): PresenceEntry[] {
	const root = path.join(dir, "presence");
	let names: string[];
	try { names = fs.readdirSync(root); }
	catch { return []; /* no presence directory: no 0.22 window ever ran here, or this version removed it */ }
	const out: PresenceEntry[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const file = path.join(root, name);
		let raw: unknown;
		try {
			// Only a regular file of an entry's size: a read of a FIFO or a device waits for ever, and a link may name either.
			const stat = fs.lstatSync(file);
			if (!stat.isFile() || stat.size > PRESENCE_MAX_BYTES) continue;
			raw = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch { continue; /* gone since the listing, or torn mid-write: the next look reads it again */ }
		if (!raw || typeof raw !== "object") continue;
		const e = raw as Record<string, unknown>;
		if (!Number.isInteger(e.pid) || (e.pid as number) <= 0 || typeof e.host !== "string" || typeof e.heartbeatAt !== "string") continue;
		out.push({ pid: e.pid as number, host: e.host, cwd: typeof e.cwd === "string" ? e.cwd : "", heartbeatAt: e.heartbeatAt, ...(typeof e.kind === "string" ? { kind: e.kind } : {}), ...(e.leases !== undefined ? { leases: e.leases } : {}) });
	}
	return out;
}

/** What every surface says while `older` is open: the first one, what to do about it, and how many more. */
export function olderLine(older: readonly OlderPiLoops[], self: string): string | undefined {
	const [first, ...rest] = older;
	if (!first) return undefined;
	const at = first.where ? `, ${first.where}` : "";
	const on = first.elsewhere ? ` on ${first.elsewhere}` : "";
	const starts = `pi-loops ${self} starts within a minute`;
	const named = first.version === "0.22" ? "0.22" : "0.24.2 or earlier";
	const line = first.kind === "background"
		? first.elsewhere
			? `pi-loops ${self} is waiting: pi-loops 0.22 in the background${on} (pid ${first.pid}) is still running. Stop it on that machine, and ${starts}.`
			: `pi-loops ${self} is waiting: pi-loops ${named} in the background (pid ${first.pid}) is still running. A pi window of ${self} that opens here, or \`pi-loops start\`, replaces it, and ${starts}.`
		: first.version === "0.22"
			? `pi-loops ${self} is waiting: a pi window with pi-loops 0.22${on} (pid ${first.pid}${at}) is still open. Close it, and ${starts}. Until then, that window runs your loops.`
			: `pi-loops ${self} is waiting: a pi terminal with pi-loops 0.24.2 or earlier (pid ${first.pid}${at}) is still open. Restart it, and ${starts}. Until then, pi-loops ${self} runs nothing here, and pi-loops 0.24.2 in the background, while it still runs, runs your loops.`;
	if (!rest.length) return line;
	return `${line} ${rest.length} more older pi-loops process${rest.length === 1 ? " is" : "es are"} open: pid${rest.length === 1 ? "" : "s"} ${rest.map((o) => o.pid).join(", ")}.`;
}

/** How often a process that waits looks again: one tick of pi-loops. */
export const WAIT_POLL_MS = 30_000;
/** How soon it looks again after it asked an older background to stop. */
export const AFTER_STOP_POLL_MS = 1_000;
/**
 * How long nothing older must be seen, once something was, before a process that waits goes on: a 0.22
 * window that closes removes its entry about 2 s before the background it starts writes one (R1).
 */
export const ALONE_CONFIRM_MS = 10_000;

/**
 * Resolves once no older pi-loops is open in `dir`. `say` gets the line each time it changes, and
 * `each` runs on every look and says whether it asked an older background to stop (pi-loops in the
 * background keeps its heartbeat with it, so a window does not take a process that waits for a wedged
 * one). After something older was seen, nothing must be seen for `ALONE_CONFIRM_MS`. The timer keeps
 * the process alive unless `unref` is set, as a window's must be.
 */
export async function untilAlone(dir: string, opts: { say: (line: string) => void; self: string; each?: (now: number) => boolean | Promise<boolean>; everyMs?: number; afterStopMs?: number; confirmMs?: number; unref?: boolean; probe?: ProcessProbe }): Promise<void> {
	let said: string | undefined;
	let confirming = false;
	const pause = (ms: number) => new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		if (opts.unref) timer.unref();
	});
	for (;;) {
		const now = Date.now();
		const line = olderLine(olderPiLoops(dir, now, opts.probe, opts.self), opts.self);
		if (line === undefined) {
			if (said === undefined || confirming) return;
			confirming = true;
			await pause(opts.confirmMs ?? ALONE_CONFIRM_MS);
			continue;
		}
		confirming = false;
		if (line !== said) opts.say(line);
		said = line;
		const asked = (await opts.each?.(now)) ?? false;
		await pause(asked ? (opts.afterStopMs ?? AFTER_STOP_POLL_MS) : (opts.everyMs ?? WAIT_POLL_MS));
	}
}

/**
 * Once no older window or terminal is open, a process of this version that waits replaces an older
 * pi-loops in the background on this machine, as an upgrade does, and says so:
 *   - 0.24.2 or earlier: its own upgrade request over its socket, which it answers by leaving.
 *   - 0.22: SIGTERM. A 0.22 window that closes starts it to keep its loops, and nobody sees it. Only
 *     the pid that 0.22.8's own record (`host.json`) names, on this machine, with the entry that record
 *     names on its command line: the pid of a presence entry may be another program by now.
 * Returns how many it asked.
 */
export async function stopOlderBackground(dir: string, older: readonly OlderPiLoops[], say: (line: string) => void, opts: { kill?: (pid: number, signal: NodeJS.Signals) => void; isOldHost?: (pid: number) => boolean; askUpgrade?: () => Promise<boolean> } = {}): Promise<boolean> {
	if (older.some((o) => o.kind === "window")) return false;
	const kill = opts.kill ?? ((pid, signal) => process.kill(pid, signal));
	const isOldHost = opts.isOldHost ?? ((pid) => runsOldHost(dir, pid));
	const askUpgrade = opts.askUpgrade ?? (async () => (await askHost(dir, { op: "upgrade" })) !== undefined);
	let asked = false;
	for (const o of older) {
		if (o.kind !== "background" || o.elsewhere) continue;
		if (o.version === "0.24") {
			if (await askUpgrade()) {
				asked = true;
				say(`asked pi-loops 0.24.2 or earlier in the background (pid ${o.pid}) to make way, as an upgrade does`);
			}
			continue;
		}
		if (!isOldHost(o.pid)) continue;
		try {
			kill(o.pid, "SIGTERM");
			asked = true;
			say(`asked pi-loops 0.22 in the background (pid ${o.pid}) to stop, as an upgrade replaces an older pi-loops`);
		} catch (err: any) {
			say(`could not stop pi-loops 0.22 in the background (pid ${o.pid}): ${err?.message ?? err}`);
		}
	}
	return asked;
}

/** Whether `pid` is the one 0.22.8's `host.json` names for this machine, and runs the entry it names. Unknown is no. */
function runsOldHost(dir: string, pid: number): boolean {
	let rec: { pid?: unknown; host?: unknown; entry?: unknown };
	try {
		const file = path.join(dir, "host.json");
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.size > PRESENCE_MAX_BYTES) return false;
		rec = JSON.parse(fs.readFileSync(file, "utf8")) as typeof rec;
	} catch { return false; /* no record of 0.22.8 in the background: nothing to stop by it */ }
	const entry = rec.entry;
	if (rec.pid !== pid || rec.host !== os.hostname() || typeof entry !== "string" || !entry.endsWith(`${path.sep}host-entry.mjs`)) return false;
	try {
		return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(entry);
	} catch {
		/* no /proc (macOS): ask ps */
	}
	try {
		return ` ${execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()} `.includes(` ${entry} `);
	} catch {
		return false; // not known to be that process: it is not stopped
	}
}
