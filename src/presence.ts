/**
 * Presence: the one file per live pi that pi-loops 0.22 windows write under `<dir>/presence/`
 * (refreshed every tick, pruned after 90 s or a dead pid). This build no longer writes it: who
 * holds a conversation is the lease's question (src/lease.ts). It is still read during an upgrade,
 * to see a conversation a 0.22 window has open (`olderPiOnSession`), and so the host's dead-session
 * sweep does not park a plain job whose session is open only there. Deleted with the 0.22 bridge.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pidAlive, writeFileAtomic } from "./lock.ts";
import { withinProject } from "./paths.ts";
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
	/** Written by builds that take a session lease (src/lease.ts). Its absence marks a 0.22.x pi, which fires a shared session's plain jobs without one. */
	leases?: true;
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

/** A live pi without session leases that has `sessionId` open too: both would fire its plain jobs. */
export function olderPiOnSession(entries: PresenceEntry[], sessionId: string | undefined, self: PresenceSelf): PresenceEntry | undefined {
	if (!sessionId) return undefined;
	return entries.find((e) => e.sessionId === sessionId && !e.leases && e.kind !== "host" && !isSelf(e, self));
}

export function isSelf(entry: PresenceEntry | undefined, self: PresenceSelf): boolean {
	return !!entry && entry.pid === self.pid && entry.host === self.host && entry.instance === self.instance;
}

export function localHost(): string {
	return os.hostname();
}
