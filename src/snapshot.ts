/**
 * What change deserves a permanent entry in the session file.
 *
 * `/cron`'s snapshot is appended with `pi.appendEntry`, which is forever: it resumes with the session
 * and travels in archives. A snapshot per tick would grow the transcript for nobody, so the decision
 * has two halves — what counts as a change at all, and how often even a real change may be written.
 */

/** No more than one entry a minute, however often the numbers move. */
export const SNAPSHOT_MIN_GAP_MS = 60_000;

/**
 * What counts as a change worth an entry: which servers are connected and what they exposed, who
 * owns the clock, the tools, the hooks, how many jobs and rules there are. Deliberately not the
 * counters — a server pushing every ten seconds moves `queued` constantly, and writing the session
 * file four times a minute to record that is not observability, it is noise. The counters are still
 * in the entry; they just do not trigger one, and `/cron snapshot` forces a fresh entry whenever a
 * reader wants current numbers. The timestamp is excluded for the same reason.
 */
export function snapshotFingerprint(data: any): string {
	return JSON.stringify({
		scheduler: { running: data.scheduler?.running, leader: data.scheduler?.leader },
		counts: data.counts,
		mcp: (data.mcp ?? []).map((m: any) => ({ name: m.name, state: m.state, tools: m.tools, attention: m.attention, lastError: m.lastError })),
		mcpConfigError: data.mcpConfigError,
		hooks: data.hooks,
		tools: data.tools,
	});
}

/**
 * Whether to write the snapshot whose fingerprint is `next`. `force` is `/cron snapshot`: someone is
 * asking for the current numbers, and they get an entry even if nothing changed and the last one was
 * a second ago.
 */
export function shouldEmitSnapshot(prev: { fingerprint?: string; at: number }, next: string, now: number, force: boolean): boolean {
	if (force) return true;
	if (next === prev.fingerprint) return false;
	return now - prev.at >= SNAPSHOT_MIN_GAP_MS;
}
