/**
 * Who does a conversation's automated work: one lease file per session, naming one extension
 * instance. A second window on the same session is a viewer. There is no heartbeat and no timeout:
 * a lease changes hands only when its holder's process is gone, so nothing here measures time and a
 * suspended laptop cannot move one. The epoch is the fencing token every claim checks.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pidAlive, withFileLockSync, writeFileAtomic } from "./lock.ts";
import { stamp } from "./schedule.ts";

export interface LeaseHolder {
	kind: "terminal" | "host";
	pid: number;
	instance: string;
	procStart?: string;
	acquiredAt: string;
	mode?: "tui" | "rpc" | "print" | "json" | "unbound";
	pushServers: string[];
}

export interface SessionLease {
	v: 1;
	sessionId: string;
	sessionFile?: string;
	cwd?: string;
	epoch: number;
	holder: LeaseHolder | null;
	updatedAt: string;
}

export interface ProcessProbe {
	alive(pid: number): boolean;
	startTime(pid: number): string | undefined;
	bootedAt(): number;
}

export function procStart(pid: number): string | undefined {
	try {
		if (process.platform === "linux") {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
			const close = stat.lastIndexOf(")");
			return stat.slice(close + 2).split(" ")[19];
		}
		if (process.platform === "darwin") return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
	} catch {
		return undefined; // the pid is gone, or this OS hides it: holderAlive falls back to the boot time
	}
	return undefined;
}

export const systemProbe: ProcessProbe = {
	alive: pidAlive,
	startTime: procStart,
	bootedAt: () => Date.now() - os.uptime() * 1000,
};

export function holderAlive(h: LeaseHolder, probe: ProcessProbe = systemProbe): boolean {
	if (!probe.alive(h.pid)) return false;
	const start = probe.startTime(h.pid);
	if (h.procStart !== undefined && start !== undefined && start !== h.procStart) return false;
	if ((h.procStart === undefined || start === undefined) && Date.parse(h.acquiredAt) < probe.bootedAt() - 60_000) return false;
	return true;
}

export function sameHolder(a: Pick<LeaseHolder, "pid" | "instance">, b: Pick<LeaseHolder, "pid" | "instance">): boolean {
	return a.pid === b.pid && a.instance === b.instance;
}

export type AcquireOutcome =
	| { outcome: "held"; lease: SessionLease }
	| { outcome: "acquired"; lease: SessionLease; tookFromPid?: number }
	| { outcome: "viewer"; lease: SessionLease; holderPid: number };

export function decideAcquire(current: SessionLease | undefined, sessionId: string, me: LeaseHolder, info: { sessionFile?: string; cwd?: string }, now: number, probe: ProcessProbe = systemProbe): AcquireOutcome & { write: boolean } {
	const updatedAt = stamp(now);
	const mergeInfo = (lease: SessionLease): SessionLease => ({ ...lease, ...info, updatedAt });
	if (!current || current.holder === null) return { outcome: "acquired", lease: { v: 1, sessionId, ...info, epoch: (current?.epoch ?? 0) + 1, holder: me, updatedAt }, write: true };
	if (sameHolder(current.holder, me)) {
		const lease = mergeInfo(current);
		return { outcome: "held", lease, write: lease.sessionFile !== current.sessionFile || lease.cwd !== current.cwd };
	}
	if (holderAlive(current.holder, probe)) return { outcome: "viewer", lease: current, holderPid: current.holder.pid, write: false };
	return { outcome: "acquired", lease: { ...current, ...info, epoch: current.epoch + 1, holder: me, updatedAt }, tookFromPid: current.holder.pid, write: true };
}

const validSessionId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A session id becomes a file name here and in the mailbox, so anything that could leave the directory is refused. */
export function sessionFileName(sessionId: string): string {
	if (!validSessionId.test(sessionId) || sessionId.includes("..")) throw new Error(`invalid session id: ${sessionId}`);
	return sessionId;
}

export class LeaseStore {
	readonly dir: string;
	private readonly probe: ProcessProbe;

	constructor(dir: string, probe: ProcessProbe = systemProbe) {
		this.dir = dir;
		this.probe = probe;
	}

	file(sessionId: string): string {
		return path.join(this.dir, "leases", `${sessionFileName(sessionId)}.json`);
	}

	read(sessionId: string): SessionLease | undefined {
		try {
			const value: unknown = JSON.parse(fs.readFileSync(this.file(sessionId), "utf8"));
			if (!value || typeof value !== "object") return undefined;
			const lease = value as SessionLease;
			return lease.v === 1 && lease.sessionId === sessionId && typeof lease.epoch === "number" ? lease : undefined;
		} catch {
			return undefined; // missing, torn or an invalid id: nobody holds it
		}
	}

	/** The fencing rule: write only if the epoch on disk is still the one this critical section read (a lock broken as stale while we slept loses here). */
	private writeIfCurrent(file: string, before: SessionLease | undefined, lease: SessionLease): boolean {
		const current = this.read(lease.sessionId);
		if ((current?.epoch ?? undefined) !== (before?.epoch ?? undefined)) return false;
		writeFileAtomic(file, `${JSON.stringify(lease, null, 2)}\n`);
		return true;
	}

	acquire(sessionId: string, me: LeaseHolder, info: { sessionFile?: string; cwd?: string } = {}): AcquireOutcome {
		const file = this.file(sessionId);
		return withFileLockSync(path.join(this.dir, "leases.lock"), () => {
			const before = this.read(sessionId);
			const decision = decideAcquire(before, sessionId, me, info, Date.now(), this.probe);
			if (!decision.write || this.writeIfCurrent(file, before, decision.lease)) return decision;
			return decideAcquire(this.read(sessionId), sessionId, me, info, Date.now(), this.probe);
		});
	}

	release(sessionId: string, me: Pick<LeaseHolder, "pid" | "instance">): boolean {
		const file = this.file(sessionId);
		return withFileLockSync(path.join(this.dir, "leases.lock"), () => {
			const before = this.read(sessionId);
			if (!before?.holder || !sameHolder(before.holder, me)) return false;
			const next = { ...before, holder: null, epoch: before.epoch + 1, updatedAt: stamp(Date.now()) };
			return this.writeIfCurrent(file, before, next);
		});
	}

	setPushServers(sessionId: string, me: Pick<LeaseHolder, "pid" | "instance">, epoch: number, servers: readonly string[]): boolean {
		const file = this.file(sessionId);
		return withFileLockSync(path.join(this.dir, "leases.lock"), () => {
			const before = this.read(sessionId);
			if (!before?.holder || !sameHolder(before.holder, me) || before.epoch !== epoch) return false;
			const next = { ...before, holder: { ...before.holder, pushServers: [...new Set(servers)].sort() }, updatedAt: stamp(Date.now()) };
			return this.writeIfCurrent(file, before, next);
		});
	}

	holds(sessionId: string, me: Pick<LeaseHolder, "pid" | "instance">, epoch?: number): boolean {
		const lease = this.read(sessionId);
		return !!lease?.holder && sameHolder(lease.holder, me) && (epoch === undefined || lease.epoch === epoch);
	}

	list(): SessionLease[] {
		let names: string[];
		try {
			names = fs.readdirSync(path.join(this.dir, "leases"));
		} catch {
			return []; // no lease was ever written
		}
		return names.filter((name) => name.endsWith(".json")).map((name) => this.read(name.slice(0, -5))).filter((lease): lease is SessionLease => lease !== undefined);
	}
}

/**
 * One extension instance's side of the leases: the session it binds, whether it holds it or only
 * views it, and the answers the scheduler and the lists ask (src/job-owner.ts). The decisions are
 * `decideAcquire`'s; this keeps what they returned.
 */
export class LeaseBinding {
	readonly store: LeaseStore;
	readonly instance: string;
	private readonly self: () => Omit<LeaseHolder, "acquiredAt">;
	private readonly probe: ProcessProbe;
	private sessionId: string | undefined;
	private info: { sessionFile?: string; cwd?: string } = {};
	private epoch: number | undefined;
	private pushServers: string[] = [];
	/** The pid of the live holder while this instance is a viewer. */
	viewerOf: number | undefined;

	constructor(store: LeaseStore, instance: string, self: () => Omit<LeaseHolder, "acquiredAt" | "instance">, probe: ProcessProbe = systemProbe) {
		this.store = store;
		this.instance = instance;
		this.self = () => ({ ...self(), instance });
		this.probe = probe;
	}

	private me(): LeaseHolder {
		return { ...this.self(), acquiredAt: stamp(Date.now()) };
	}

	/** Take `sessionId`'s lease, or become its viewer. A different session bound before is released first. */
	bind(sessionId: string, info: { sessionFile?: string; cwd?: string } = {}): AcquireOutcome {
		if (this.sessionId && this.sessionId !== sessionId) this.release();
		this.sessionId = sessionId;
		this.info = info;
		return this.take();
	}

	/**
	 * Every tick: a holder whose lease is still its own reads and returns nothing. A viewer retries,
	 * and a holder whose file was deleted re-acquires (deleting private state must not strand a session).
	 */
	refresh(): AcquireOutcome | undefined {
		if (!this.sessionId) return undefined;
		if (this.epoch !== undefined && this.store.holds(this.sessionId, this.self(), this.epoch)) return undefined;
		return this.take();
	}

	/** Rewrite the injecting MCP servers on the lease when the set changed. The epoch does not move. */
	setPushServers(servers: readonly string[]): void {
		const next = [...new Set(servers)].sort();
		if (!this.sessionId || this.epoch === undefined || next.join("\n") === this.pushServers.join("\n")) return;
		if (this.store.setPushServers(this.sessionId, this.self(), this.epoch, next)) this.pushServers = next;
	}

	release(): void {
		if (this.sessionId && this.epoch !== undefined) this.store.release(this.sessionId, this.self());
		this.sessionId = undefined;
		this.epoch = undefined;
		this.viewerOf = undefined;
	}

	/** The session bound, and whether this instance holds it (false for a viewer). */
	here(): { sessionId?: string; holds: boolean } {
		return { sessionId: this.sessionId, holds: this.sessionId !== undefined && this.heldEpoch(this.sessionId) !== undefined };
	}

	/** The epoch of this instance's lease on `sessionId`, read from disk so a lease taken away is seen at once. */
	heldEpoch(sessionId: string): number | undefined {
		if (sessionId !== this.sessionId || this.epoch === undefined) return undefined;
		return this.store.holds(sessionId, this.self(), this.epoch) ? this.epoch : undefined;
	}

	/** The pid of the live holder of `sessionId`, this process's included. */
	holderOf(sessionId: string): number | undefined {
		let lease: SessionLease | undefined;
		try {
			lease = this.store.read(sessionId);
		} catch {
			return undefined; // not a session id this store can name
		}
		return lease?.holder && holderAlive(lease.holder, this.probe) ? lease.holder.pid : undefined;
	}

	private take(): AcquireOutcome {
		const outcome = this.store.acquire(this.sessionId!, { ...this.me(), pushServers: this.pushServers }, this.info);
		this.epoch = outcome.outcome === "viewer" ? undefined : outcome.lease.epoch;
		this.viewerOf = outcome.outcome === "viewer" ? outcome.holderPid : undefined;
		if (outcome.outcome !== "viewer") this.pushServers = outcome.lease.holder?.pushServers ?? [];
		return outcome;
	}
}
