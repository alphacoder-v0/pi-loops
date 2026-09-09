/**
 * Presence registry: which pi processes are alive on this machine, in which project and
 * session. One small file per process under `<dir>/presence/`, refreshed on every scheduler
 * tick and removed on shutdown; stale entries (no heartbeat for 90 s, or a dead pid on this
 * host) are ignored and pruned.
 *
 * It restores what pie gets for free from session scoping: a project's dynamic checks and
 * push-triggered evaluations are run by a pi that is *in that project* (preferring the session
 * that created the rules), so promotions land in the right chat. Only when no pi is open there
 * does the machine leader step in (and the result goes to the inbox).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pidAlive, writeFileAtomic } from "./lock.ts";

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
		const entry: PresenceEntry = { ...this.self, ...current, heartbeatAt: new Date(now).toISOString() };
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
			const stale = !mine && (Number.isNaN(age) || age > PRESENCE_STALE_MS || (e.host === this.self.host && !pidAlive(e.pid)));
			if (stale) {
				fs.rmSync(file, { force: true });
				continue;
			}
			out.push(e);
		}
		return out;
	}
}

/**
 * The process that should act for `cwd` on `host`: a live pi in that project, preferring one
 * whose session is in `preferredSessionIds` (the sessions that created the rules), lowest pid
 * as the tie-break so every process computes the same answer. `undefined` when no pi is open
 * there — the caller falls back to the machine leader.
 */
export function chooseCwdOwner(entries: PresenceEntry[], cwd: string, host: string, preferredSessionIds: string[] = []): PresenceEntry | undefined {
	const here = entries.filter((e) => e.cwd === cwd && e.host === host && e.kind !== "host");
	if (!here.length) return undefined;
	const preferred = here.filter((e) => e.sessionId && preferredSessionIds.includes(e.sessionId));
	const pool = preferred.length ? preferred : here;
	return [...pool].sort((a, b) => a.pid - b.pid || a.instance.localeCompare(b.instance))[0];
}

export function isSelf(entry: PresenceEntry | undefined, self: PresenceSelf): boolean {
	return !!entry && entry.pid === self.pid && entry.host === self.host && entry.instance === self.instance;
}

export function localHost(): string {
	return os.hostname();
}
