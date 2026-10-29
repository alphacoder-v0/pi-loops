import * as fs from "node:fs";
import * as path from "node:path";
import { withFileLockSync, writeFileAtomic } from "./lock.ts";
import type { InboxEntry } from "./inbox.ts";
import type { RunRecord } from "./store.ts";

export interface SeenFile { v: 1; seen: Record<string, string> }
export interface SinceYouLooked {
	runs: number;
	failed: number;
	/** New findings from this conversation's loops: in this project, and (`elsewhere`) in other projects. */
	findings: number;
	elsewhere?: number;
	/** Rule results for this conversation: appended to it while it was closed, or filed in the inbox for it. */
	results?: number;
}

const fileIn = (dir: string): string => path.join(dir, "seen.json");

export function readSeen(dir: string): SeenFile {
	try {
		const value: unknown = JSON.parse(fs.readFileSync(fileIn(dir), "utf8"));
		if (!value || typeof value !== "object" || (value as any).v !== 1 || !(value as any).seen || typeof (value as any).seen !== "object" || Array.isArray((value as any).seen)) return { v: 1, seen: {} };
		const seen: Record<string, string> = {};
		for (const [id, at] of Object.entries((value as any).seen)) if (typeof at === "string") seen[id] = at;
		return { v: 1, seen };
	} catch {
		return { v: 1, seen: {} };
	}
}

export function markSeen(dir: string, sessionId: string, at: string): void {
	const lock = path.join(dir, "seen.lock");
	withFileLockSync(lock, () => {
		const seen = readSeen(dir);
		seen.seen[sessionId] = at;
		writeFileAtomic(fileIn(dir), `${JSON.stringify(seen, null, 2)}\n`);
	});
}

/**
 * What happened for `sessionId` since `seenAt`. Loop runs only (a held turn's answer is already in
 * the conversation). `cwd` splits the findings into this project's and the rest, because `/inbox`
 * lists one project. `appended` is the audit trail of rule results the host wrote into the
 * conversation while it was closed: on disk but never on a screen, so they are counted here.
 */
/** Forget the cursors of conversations that are gone from everywhere else (the host's sweep). */
export function pruneSeen(dir: string, keep: (sessionId: string) => boolean): number {
	return withFileLockSync(path.join(dir, "seen.lock"), () => {
		const seen = readSeen(dir);
		const gone = Object.keys(seen.seen).filter((id) => !keep(id));
		if (!gone.length) return 0;
		for (const id of gone) delete seen.seen[id];
		writeFileAtomic(fileIn(dir), `${JSON.stringify(seen, null, 2)}\n`);
		return gone.length;
	});
}

export function sinceYouLooked(runs: readonly RunRecord[], findings: readonly InboxEntry[], sessionId: string, seenAt?: string, opts: { cwd?: string; inProject?: (entryCwd: string, cwd: string) => boolean; appended?: ReadonlyArray<{ ts: string; state: string; details?: Record<string, unknown> }> } = {}): SinceYouLooked {
	const after = seenAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(seenAt);
	const recent = runs.filter((run) => run.stateful && run.forSession === sessionId && Date.parse(run.finishedAt) > after);
	const fresh = findings.filter((entry) => entry.status === "new" && entry.session_id === sessionId && Date.parse(entry.created_at) > after);
	const isRule = (entry: InboxEntry) => entry.source.startsWith("trigger:");
	const loopFindings = fresh.filter((entry) => !isRule(entry));
	const here = opts.cwd && opts.inProject ? loopFindings.filter((entry) => opts.inProject!(entry.cwd, opts.cwd!)) : loopFindings;
	const appended = (opts.appended ?? []).filter((row) => row.state === "appended" && row.details?.session_id === sessionId && Date.parse(row.ts) > after).length;
	return {
		runs: recent.length,
		failed: recent.filter((run) => !run.ok).length,
		findings: here.length,
		...(loopFindings.length > here.length ? { elsewhere: loopFindings.length - here.length } : {}),
		...(appended + fresh.filter(isRule).length ? { results: appended + fresh.filter(isRule).length } : {}),
	};
}

export function sinceYouLookedLine(c: SinceYouLooked): string | undefined {
	const parts: string[] = [];
	if (c.runs) parts.push(`${c.runs} loop run${c.runs === 1 ? "" : "s"}${c.failed ? ` (${c.failed} failed)` : ""}${c.findings ? "" : " from loops started in this conversation"}`);
	if (c.findings) parts.push(`${c.findings} new finding${c.findings === 1 ? "" : "s"} from loops started in this conversation`);
	if (c.elsewhere) parts.push(`${c.elsewhere} more in other projects (/inbox --all)`);
	if (c.results) parts.push(`${c.results} rule result${c.results === 1 ? "" : "s"} for this conversation`);
	return parts.length ? `[inbox] since you last looked: ${parts.join(", ")} — /inbox` : undefined;
}
