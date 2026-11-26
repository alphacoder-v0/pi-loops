/**
 * An older pi-loops that works in this loops directory now (owner decision, 2026-11-26: one version
 * at a time). Two versions in one directory each write its files in their own shape: a claim or a
 * dismiss in 0.22.8 or 0.24.2 writes `inbox.jsonl` again and drops every field this version added,
 * and a 0.22 window checks its project's rules beside pi-loops in the background. So while one is
 * open, this version converts nothing and runs nothing here, and says so (`waitingLine`).
 *
 * Two marks tell one apart, both read from files that the older version writes on its own:
 *   - pi-loops 0.22 writes `presence/<host>-<pid>-<instance>.json` every 30 s, with no `leases`
 *     field. It prunes an entry after 90 s or when its pid is gone, and so does this reader.
 *   - pi-loops 0.24.2 and earlier hold a lease with no `version`. Every lease this version writes
 *     carries one (`LeaseBinding`, and the background's holder in src/host-runtime.ts).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { holderAlive, LeaseStore, type ProcessProbe, systemProbe } from "./lease.ts";

/** pi-loops 0.22 prunes a presence entry whose heartbeat is older than this (v0.22.8 src/presence.ts). */
const PRESENCE_STALE_MS = 90_000;

export interface OlderPiLoops {
	/** "0.22": it writes `presence/`. "0.24": a lease holder with no `version`, so 0.24.2 or earlier. */
	version: "0.22" | "0.24";
	/** A pi window or terminal, or pi-loops in the background. */
	kind: "window" | "background";
	pid: number;
	/** The project it has open, when its file names one. */
	where?: string;
}

/** Each older pi-loops open in `dir` now, one per process, the 0.22 ones first. */
export function olderPiLoops(dir: string, now: number, probe: ProcessProbe = systemProbe): OlderPiLoops[] {
	const found: OlderPiLoops[] = [];
	const seen = new Set<string>();
	const add = (o: OlderPiLoops, key: string): void => {
		if (seen.has(key)) return;
		seen.add(key);
		found.push(o);
	};
	const self = os.hostname();
	for (const entry of presenceEntries(dir)) {
		if (entry.leases === true) continue;
		const age = now - Date.parse(entry.heartbeatAt);
		if (!(age <= PRESENCE_STALE_MS)) continue;
		// A pid on another machine that shares this directory cannot be probed: its heartbeat decides.
		if (entry.host === self && !probe.alive(entry.pid)) continue;
		add({ version: "0.22", kind: entry.kind === "host" ? "background" : "window", pid: entry.pid, ...(entry.cwd ? { where: entry.cwd } : {}) }, `${entry.host}:${entry.pid}`);
	}
	for (const lease of new LeaseStore(dir).list()) {
		const holder = lease.holder;
		if (!holder || holder.version !== undefined || !holderAlive(holder, probe)) continue;
		add({ version: "0.24", kind: holder.kind === "host" ? "background" : "window", pid: holder.pid, ...(lease.cwd ? { where: lease.cwd } : {}) }, `${self}:${holder.pid}`);
	}
	return found;
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
		let raw: unknown;
		try { raw = JSON.parse(fs.readFileSync(path.join(root, name), "utf8")); }
		catch { continue; /* torn mid-write, or not a file: the next tick reads it again */ }
		if (!raw || typeof raw !== "object") continue;
		const e = raw as Record<string, unknown>;
		if (!Number.isInteger(e.pid) || typeof e.host !== "string" || typeof e.heartbeatAt !== "string") continue;
		out.push({ pid: e.pid as number, host: e.host, cwd: typeof e.cwd === "string" ? e.cwd : "", heartbeatAt: e.heartbeatAt, ...(typeof e.kind === "string" ? { kind: e.kind } : {}), ...(e.leases !== undefined ? { leases: e.leases } : {}) });
	}
	return out;
}

/** What every surface says while `older` is open: the first one, what to do about it, and how many more. */
export function waitingLine(older: readonly OlderPiLoops[], self: string): string | undefined {
	const [first, ...rest] = older;
	if (!first) return undefined;
	const at = first.where ? `, ${first.where}` : "";
	const starts = `pi-loops ${self} starts within 30 seconds`;
	const line = first.kind === "background"
		? `pi-loops ${self} is waiting: pi-loops ${first.version === "0.22" ? "0.22" : "0.24.2 or earlier"} in the background (pid ${first.pid}) is still running. End it (kill ${first.pid}), and ${starts}.`
		: first.version === "0.22"
			? `pi-loops ${self} is waiting: a pi window with pi-loops 0.22 (pid ${first.pid}${at}) is still open. Close it, and ${starts}. Until then, that window runs your loops.`
			: `pi-loops ${self} is waiting: a pi terminal with pi-loops 0.24.2 or earlier (pid ${first.pid}${at}) is still open. Restart it, and ${starts}. Until then, no loop or rule runs.`;
	if (!rest.length) return line;
	return `${line} ${rest.length} more older pi-loops process${rest.length === 1 ? " is" : "es are"} open: pid${rest.length === 1 ? "" : "s"} ${rest.map((o) => o.pid).join(", ")}.`;
}
