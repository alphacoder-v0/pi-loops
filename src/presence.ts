/**
 * Presence registry: which pi processes are alive on this machine, in which project and
 * session. One small file per process under `<dir>/presence/`, refreshed on every scheduler
 * tick and removed on shutdown; stale entries (no heartbeat for 90 s, or a dead pid on this
 * host) are ignored and pruned.
 *
 * It restores what session scoping would give for free: a dynamic rule is checked by the pi
 * session that created it, and failing that by a pi that is *in that project*, so promotions land
 * in the right chat. Only when no pi is open there does the machine leader step in (and the result
 * goes to the inbox).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pidAlive, writeFileAtomic } from "./lock.ts";
import { realpathish } from "./paths.ts";
import { stamp } from "./schedule.ts";

export const PRESENCE_STALE_MS = 90_000;

export type PresenceKind = "interactive" | "host";

export interface PresenceEntry {
	pid: number;
	host: string;
	/** Distinguishes scheduler instances inside one process (reload, tests). */
	instance: string;
	sessionId?: string;
	cwd: string;
	/** "host" = the headless process that keeps the clock while no interactive pi is open. */
	kind?: PresenceKind;
	heartbeatAt: string;
}

export type PresenceSelf = Omit<PresenceEntry, "heartbeatAt">;

export class PresenceRegistry {
	readonly dir: string;
	readonly file: string;
	private readonly self: PresenceSelf;

	constructor(dir: string, self: PresenceSelf) {
		this.dir = path.join(dir, "presence");
		this.self = self;
		this.file = path.join(this.dir, `${self.host.replace(/[^A-Za-z0-9._-]/g, "_")}-${self.pid}-${self.instance}.json`);
	}

	/** Refresh this process's entry (session and cwd may change between ticks). */
	heartbeat(now: number, current?: Partial<Pick<PresenceEntry, "sessionId" | "cwd">>): void {
		const entry: PresenceEntry = { ...this.self, ...current, heartbeatAt: stamp(now) };
		writeFileAtomic(this.file, `${JSON.stringify(entry)}\n`);
	}

	remove(): void {
		fs.rmSync(this.file, { force: true });
	}

	/** Live entries on every host; stale ones are pruned as a side effect (best effort). */
	list(now: number): PresenceEntry[] {
		let names: string[];
		try {
			names = fs.readdirSync(this.dir);
		} catch {
			return [];
		}
		const out: PresenceEntry[] = [];
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const file = path.join(this.dir, name);
			let e: PresenceEntry | undefined;
			try {
				e = JSON.parse(fs.readFileSync(file, "utf8")) as PresenceEntry;
			} catch {
				continue;
			}
			if (!e || typeof e.pid !== "number" || typeof e.cwd !== "string") continue;
			const age = now - Date.parse(e.heartbeatAt);
			const mine = e.pid === this.self.pid && e.host === this.self.host && e.instance === this.self.instance;
			// A negative age means that machine's clock is ahead of ours; such an entry would never
			// age out and would keep a dead session's plain jobs from ever being parked.
			const stale = !mine && (Number.isNaN(age) || age > PRESENCE_STALE_MS || age < -PRESENCE_STALE_MS || (e.host === this.self.host && !pidAlive(e.pid)));
			if (stale) {
				fs.rmSync(file, { force: true });
				continue;
			}
			out.push(e);
		}
		return out;
	}
}

/** A root so broad that containment would mean "everything": never treated as one project. */
function tooBroad(dir: string): boolean {
	return dir === "/" || dir === os.homedir() || path.dirname(dir) === dir;
}

/** True when `p` is the project rooted at `root` or a directory inside it, symlinks resolved. */
export function withinProject(root: string, p: string): boolean {
	const a = realpathish(root);
	const b = realpathish(p);
	if (!a || !b) return false;
	if (a === b) return true;
	// Containment is what makes a worktree or a subdirectory the same project. `/` and `$HOME`
	// contain everything, so a rule created with one of those as its cwd governs only itself.
	if (tooBroad(a)) return false;
	const rel = path.relative(a, b);
	return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * The process that should act for the project rooted at `cwd` on `host`: a live pi opened in it —
 * or in a subdirectory of it, or through a symlink to it — lowest pid as the tie-break so every
 * process computes the same answer. `undefined` when no pi is open there: the caller falls back
 * to the machine leader.
 */
export function chooseCwdOwner(entries: PresenceEntry[], cwd: string, host: string): PresenceEntry | undefined {
	const here = entries.filter((e) => e.host === host && e.kind !== "host" && withinProject(cwd, e.cwd));
	if (!here.length) return undefined;
	return [...here].sort((a, b) => a.pid - b.pid || a.instance.localeCompare(b.instance))[0];
}

/**
 * The process that evaluates one rule of the project rooted at `cwd`.
 *
 * Rules are machine-global, which is what lets them outlive the session that created them — and it
 * costs the one thing a per-session file would have given away: knowing whose conversation a
 * promotion belongs in. This is how that is won back. While the creating session is open on this
 * host it owns its rule; once that session is gone the project's cwd owner takes it, and only with
 * no pi open in the project at all does the machine leader (whose results go to the inbox, having
 * no conversation to claim).
 */
export function chooseRuleOwner(entries: PresenceEntry[], cwd: string, host: string, sessionId?: string): PresenceEntry | undefined {
	const session = sessionId ? entries.find((e) => e.sessionId === sessionId && e.host === host && e.kind !== "host") : undefined;
	return session ?? chooseCwdOwner(entries, cwd, host);
}

export function isSelf(entry: PresenceEntry | undefined, self: PresenceSelf): boolean {
	return !!entry && entry.pid === self.pid && entry.host === self.host && entry.instance === self.instance;
}

export function localHost(): string {
	return os.hostname();
}
