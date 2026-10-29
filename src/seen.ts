import * as fs from "node:fs";
import * as path from "node:path";
import { withFileLockSync, writeFileAtomic } from "./lock.ts";
import type { InboxEntry } from "./inbox.ts";
import type { RunRecord } from "./store.ts";

export interface SeenFile { v: 1; seen: Record<string, string> }
export interface SinceYouLooked { runs: number; failed: number; findings: number }

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

export function sinceYouLooked(runs: readonly RunRecord[], findings: readonly InboxEntry[], sessionId: string, seenAt?: string): SinceYouLooked {
	const after = seenAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(seenAt);
	const recent = runs.filter((run) => run.forSession === sessionId && Date.parse(run.finishedAt) > after);
	return {
		runs: recent.length,
		failed: recent.filter((run) => !run.ok).length,
		findings: findings.filter((entry) => entry.status === "new" && entry.session_id === sessionId && Date.parse(entry.created_at) > after).length,
	};
}

export function sinceYouLookedLine(c: SinceYouLooked): string | undefined {
	const parts: string[] = [];
	if (c.runs) parts.push(`${c.runs} loop run${c.runs === 1 ? "" : "s"}${c.failed ? ` (${c.failed} failed)` : ""}${c.findings ? "" : " from loops started in this conversation"}`);
	if (c.findings) parts.push(`${c.findings} new finding${c.findings === 1 ? "" : "s"} from loops started in this conversation`);
	return parts.length ? `[inbox] since you last looked: ${parts.join(", ")} — /inbox` : undefined;
}
