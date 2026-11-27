/**
 * The upgrade's pause (owner decision, 2026-11-26). The first start of this version in a loops directory
 * an older pi-loops worked in converts it and writes `upgrade-hold.json` before the version 3
 * `jobs.json` (src/convert-v2.ts). While the file is there, nothing automated runs: no loop, plain job,
 * rule check, push check or answer; a person's own messages do. A window, `pi-loops status` and the page
 * say why, and `pi-loops resume` (or the page's Resume pi-loops) removes the file. Each job and rule keeps the on
 * or off it had: archives, a downgrade and the lists see them as they were.
 *
 * `resume` refuses while an older pi-loops still runs here. pi-loops 0.22: its `presence/` entry is fresh,
 * names a live pid on this machine and has no `leases` field; a window of 0.22 checks its project's rules
 * itself, so this version's checks beside it would run each rule twice. An older pi-loops in the
 * background: `host-service.json` names a live process of a lower version; 0.24.2 in the background
 * checks every rule that is on until the first window of this version replaces it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readHostService } from "./host-control.ts";
import { procStart } from "./lease.ts";
import { pidAlive, writeFileAtomic } from "./lock.ts";
import { compareVersions } from "./pi-floor.ts";
import { stamp } from "./schedule.ts";
import { PI_LOOPS_VERSION } from "./version.ts";

export const HOLD_FILE = "upgrade-hold.json";
/** pi-loops 0.22 prunes a presence entry whose heartbeat is further than this from now (v0.22.8 src/presence.ts). */
const PRESENCE_STALE_MS = 90_000;
/** An entry 0.22.8 writes is under 200 bytes: a bigger file, or one that is not a regular file, is not read. */
const PRESENCE_MAX_BYTES = 16 * 1024;

/** The line every surface shows while the upgrade's pause holds. */
export const HOLD_LINE = "pi-loops is paused after the upgrade, so that a pi that still runs an older pi-loops does not run your loops and rules a second time. Close every such pi, then run `pi-loops resume` (or Resume pi-loops on the page).";

/** Whether the upgrade's pause holds in `dir`. Only a regular file counts: a read of anything else could wait for ever. */
export function upgradeHeld(dir: string): boolean {
	try { return fs.lstatSync(path.join(dir, HOLD_FILE)).isFile(); }
	catch { return false; /* no file: nothing holds */ }
}

/** Writes the pause. The conversion calls it before its commit point, so a start that stops between the two holds anyway. */
export function holdUpgrade(dir: string, now = Date.now()): void {
	writeFileAtomic(path.join(dir, HOLD_FILE), `${JSON.stringify({ at: stamp(now) })}\n`);
}

export type Resumed = { readonly resumed: true; readonly held: boolean } | { readonly resumed: false; readonly olderPids: readonly number[] };

/** Ends the pause, unless an older pi-loops still runs here. Idempotent: with no pause it says so and changes nothing. */
export function resumeUpgrade(dir: string, now = Date.now(), alive: (pid: number) => boolean = pidAlive): Resumed {
	if (!upgradeHeld(dir)) return { resumed: true, held: false };
	const background = olderBackground(dir, alive);
	const olderPids = [...new Set([...olderStillRunning(dir, now, alive), ...(background === undefined ? [] : [background])])].sort((a, b) => a - b);
	if (olderPids.length) return { resumed: false, olderPids };
	fs.rmSync(path.join(dir, HOLD_FILE), { force: true });
	return { resumed: true, held: true };
}

/** What `resume` says when it refuses. */
export function olderRunningLine(pids: readonly number[]): string {
	return `an older pi-loops still runs here (pid ${pids.join(", ")}): close that pi, or end it (kill ${pids.join(" ")}), then run \`pi-loops resume\` again.`;
}

/** The pid of an older pi-loops in the background of `dir`, by `host-service.json`: a live process, the one the record names (its start time), of a lower version. */
export function olderBackground(dir: string, alive: (pid: number) => boolean = pidAlive): number | undefined {
	const rec = readHostService(dir);
	if (!rec || !Number.isInteger(rec.pid) || rec.pid <= 0 || typeof rec.version !== "string") return undefined;
	if (compareVersions(rec.version, PI_LOOPS_VERSION) >= 0 || !alive(rec.pid)) return undefined;
	// A recycled pid is not that process: the record's start time must match when it has one.
	if (rec.procStart !== undefined && procStart(rec.pid) !== rec.procStart) return undefined;
	return rec.pid;
}

/** The pids of pi-loops 0.22 that run in `dir` now, on this machine, by the presence entries 0.22.8 writes every 30 s. */
export function olderStillRunning(dir: string, now: number, alive: (pid: number) => boolean = pidAlive): number[] {
	const root = path.join(dir, "presence");
	let names: string[];
	try { names = fs.readdirSync(root); }
	catch { return []; /* no presence directory: no 0.22 runs here */ }
	const pids = new Set<number>();
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const file = path.join(root, name);
		let raw: unknown;
		try {
			const st = fs.lstatSync(file);
			if (!st.isFile() || st.size > PRESENCE_MAX_BYTES) continue;
			raw = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch { continue; /* gone since the listing, or torn mid-write */ }
		if (!raw || typeof raw !== "object") continue;
		const e = raw as Record<string, unknown>;
		if (e.leases !== undefined || !Number.isInteger(e.pid) || (e.pid as number) <= 0 || e.host !== os.hostname() || typeof e.heartbeatAt !== "string") continue;
		if (!(Math.abs(now - Date.parse(e.heartbeatAt)) <= PRESENCE_STALE_MS) || !alive(e.pid as number)) continue;
		pids.add(e.pid as number);
	}
	return [...pids].sort((a, b) => a - b);
}
