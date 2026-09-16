/**
 * The triage inbox — the routing layer. Global JSONL shared by every session and
 * project: loops run wherever they were created; the inbox is what you open in
 * the morning. Findings are one-liners with a new → claimed/dismissed lifecycle.
 *
 * Appends are line-atomic; status rewrites are serialized through a file lock.
 * Corrupt lines are skipped on read, never deleted.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { withFileLock, writeFileAtomic } from "./lock.ts";
import { INBOX_TEXT_MAX_CHARS, type FindingKind, capChars } from "./protocol.ts";
import { newId } from "./store.ts";
import { stamp } from "./schedule.ts";

export type InboxStatus = "new" | "claimed" | "dismissed";

/** Past this the inbox drops its oldest triaged entries (docs/configuration.md). */
export const INBOX_ROTATE_BYTES = 1_000_000;

/**
 * A finding, in memory and on disk: the ten fields of the contract first, in their order, then
 * pi-loops' own, which no interface names and which a line may be missing. This is the one shape —
 * a line of `inbox.jsonl` is `JSON.stringify` of this, and `pi-loops inbox --json` is the first ten
 * fields of it.
 */
export interface InboxEntry {
	id: string;
	/** RFC 3339, carrying this machine's UTC offset (`stamp()`). */
	created_at: string;
	status: InboxStatus;
	/**
	 * `checkpoint` when the finding asks a person to decide (`protocol.findingKind`, read off the
	 * text when the run's findings are appended), `news` otherwise. Checkpoints are listed first,
	 * counted apart.
	 */
	kind: FindingKind;
	/** Bounded origin label, e.g. "cron:check-issues" or "cron:cron-1a2b3c4d". */
	source: string;
	run_id: string;
	cwd: string;
	text: string;
	/** true = passed the checker; false = checker dropped it (never appended); null = no checker / unreviewed. */
	verified: boolean | null;
	/**
	 * Why a person dismissed it, when they said; null when they did not. A bare dismiss is silent; a
	 * reason goes back to the loop that reported the finding, in its next run's prompt
	 * (`Inbox.feedbackFor`).
	 */
	dismiss_reason: string | null;
	job_id?: string;
	/** Session that owned the loop when it reported; loops are machine-global here. */
	session_id?: string;
	claimed_by?: string;
	/** Checker's reason when it kept a finding, if it gave one. */
	verified_reason?: string;
	/** When it was dismissed — what decides whether the loop's next run is shown the reason. */
	dismissed_at?: string;
}

/** The fields a finding is, in their order — CONTRACT.md §2.2 and docs/downstream.md §3. */
export const FINDING_FIELDS = ["id", "created_at", "status", "kind", "source", "run_id", "cwd", "text", "verified", "dismiss_reason"] as const;

/** Reasons longer than a finding are a paragraph, and the prompt they go into is capped. */
const DISMISS_REASON_MAX_CHARS = INBOX_TEXT_MAX_CHARS;

export class Inbox {
	readonly file: string;
	private readonly lockPath: string;

	constructor(dir: string) {
		this.file = path.join(dir, "inbox.jsonl");
		this.lockPath = path.join(dir, "inbox.lock");
	}

	async append(entry: Omit<InboxEntry, "id" | "created_at" | "status" | "kind" | "verified" | "dismiss_reason"> & Partial<Pick<InboxEntry, "kind" | "verified">>): Promise<InboxEntry> {
		// Built in `FINDING_FIELDS` order, then pi-loops' own: the line is this object as it stands.
		const full: InboxEntry = {
			id: newId("inb"), // inb-<32 hex>, the shape every other id in pi-loops has
			created_at: stamp(),
			status: "new",
			kind: entry.kind ?? "news",
			source: capChars(entry.source, 80),
			run_id: entry.run_id,
			cwd: entry.cwd,
			text: capChars(entry.text.replace(/\s+/g, " "), INBOX_TEXT_MAX_CHARS),
			verified: entry.verified ?? null,
			dismiss_reason: null,
			job_id: entry.job_id,
			session_id: entry.session_id,
			claimed_by: entry.claimed_by,
			verified_reason: entry.verified_reason,
			dismissed_at: entry.dismissed_at,
		};
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		// Under the same lock as the triage rewrites: findings are appended by every pi window, the
		// headless host and up to `max_concurrent_runs` loop runs, while `/inbox dismiss|clear`
		// rewrites the whole file — an append landing mid-rewrite is a finding nobody ever sees.
		// The lock is awaited, never spun on: a leftover lock directory from a killed process would
		// otherwise block this process's event loop for the whole stale window.
		await withFileLock(this.lockPath, () => {
			fs.appendFileSync(this.file, `${JSON.stringify(full)}\n`, "utf8");
			this.rotate();
		});
		return full;
	}

	/**
	 * Past `INBOX_ROTATE_BYTES`, drop the oldest already-triaged entries (`claimed`/`dismissed`) —
	 * never anything still `new`, which is the whole point of the inbox, and the reason this is not the
	 * blind halving the run log and the audit use. This file was the one that grew forever, and
	 * `newCount()` re-parses it on every badge refresh. Caller holds the lock.
	 */
	private rotate(): void {
		try {
			if (fs.statSync(this.file).size < INBOX_ROTATE_BYTES) return;
			const entries = this.list();
			const triaged = entries.filter((e) => e.status !== "new");
			const drop = Math.floor(triaged.length / 2);
			// Nothing triaged to drop means an inbox full of unread findings: rewriting it would
			// change nothing and would cost a full read+write on every append from here on.
			if (drop === 0) return;
			const dropped = new Set(triaged.slice(0, drop).map((e) => e.id));
			this.rewrite(entries.filter((e) => !dropped.has(e.id)));
		} catch {
			/* best effort: a rotation that fails must never lose the append that just succeeded */
		}
	}

	/** All entries, oldest first. Unparseable lines are skipped. */
	list(): InboxEntry[] {
		let text: string;
		try {
			text = fs.readFileSync(this.file, "utf8");
		} catch (err: any) {
			if (err?.code === "ENOENT") return [];
			throw err;
		}
		const out: InboxEntry[] = [];
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const e = readFinding(JSON.parse(line));
				if (e && typeof e.id === "string" && typeof e.text === "string") out.push(e);
			} catch {
				/* skip corrupt line */
			}
		}
		return out;
	}

	/**
	 * What is waiting, in triage order: the checkpoints first — a decision a person owes — then the
	 * news, each group in the order it arrived. `/inbox` numbers this list and `claim`/`dismiss`
	 * resolve numbers against it, so the order is decided once, here.
	 */
	listNew(): InboxEntry[] {
		const fresh = this.list().filter((e) => e.status === "new");
		return [...fresh.filter((e) => e.kind === "checkpoint"), ...fresh.filter((e) => e.kind !== "checkpoint")];
	}

	/** Count of new entries; 0 on any error (badge path must never throw). */
	newCount(): number {
		try {
			return this.listNew().length;
		} catch {
			return 0;
		}
	}

	/** How many of the new entries are checkpoints; 0 on any error, like `newCount`. */
	decisionCount(): number {
		try {
			return this.listNew().filter((e) => e.kind === "checkpoint").length;
		} catch {
			return 0;
		}
	}

	/** `reason` is only read for a dismiss: what the person said, kept for the loop's next run. */
	async setStatus(id: string, status: InboxStatus, claimedBy?: string, reason?: string): Promise<InboxEntry | undefined> {
		return withFileLock(this.lockPath, () => {
			const entries = this.list();
			const entry = entries.find((e) => e.id === id);
			if (!entry) return undefined;
			entry.status = status;
			if (claimedBy) entry.claimed_by = claimedBy;
			if (status === "dismissed") {
				entry.dismissed_at = stamp();
				const why = reason?.replace(/\s+/g, " ").trim();
				if (why) entry.dismiss_reason = capChars(why, DISMISS_REASON_MAX_CHARS);
			}
			this.rewrite(entries);
			return entry;
		});
	}

	/** `match` limits it to what the caller listed — `/inbox clear` must not dismiss findings it did not show. */
	async dismissAllNew(match?: (entry: InboxEntry) => boolean): Promise<number> {
		return withFileLock(this.lockPath, () => {
			const entries = this.list();
			const at = stamp();
			let changed = 0;
			for (const e of entries) {
				if (e.status === "new" && (!match || match(e))) {
					e.status = "dismissed";
					e.dismissed_at = at;
					changed++;
				}
			}
			if (changed) this.rewrite(entries);
			return changed;
		});
	}

	/**
	 * What a person told one loop by dismissing its findings with a reason, since `since` (the start
	 * of the loop's previous run: everything before it was already shown to that run). Oldest first.
	 * A dismiss without a reason is not feedback — "not interesting" is not something the next run can
	 * act on, and the person did not ask it to — so it is not here. A reason dismissed before pi-loops
	 * stamped `dismissed_at` has no time to compare and is left out too.
	 */
	feedbackFor(jobId: string, since?: string): InboxEntry[] {
		const after = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
		return this.list().filter((e) => e.job_id === jobId && e.status === "dismissed" && !!e.dismiss_reason && !!e.dismissed_at && Date.parse(e.dismissed_at) > after);
	}

	private rewrite(entries: InboxEntry[]): void {
		writeFileAtomic(this.file, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
	}
}

/**
 * A line as an entry. For a line this version wrote it is the identity; the two older shapes it
 * still reads are pi-loops ≤ 0.1.2 (camelCase throughout) and the shape written until 0.21.0
 * (`trace_id` for the run id, absent optional keys, no `kind` on news). A line in either is
 * rewritten in this shape the next time its status changes.
 */
function readFinding(raw: any): InboxEntry | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const pick = <T>(...keys: string[]): T | undefined => {
		for (const k of keys) if (raw[k] !== undefined && raw[k] !== null) return raw[k] as T;
		return undefined;
	};
	const status = pick<string>("status");
	return {
		id: String(raw.id ?? ""),
		created_at: pick<string>("created_at", "createdAt") ?? "",
		status: status === "claimed" || status === "dismissed" ? status : "new",
		kind: raw.kind === "checkpoint" ? "checkpoint" : "news",
		source: pick<string>("source") ?? "",
		run_id: pick<string>("run_id", "trace_id", "runId") ?? "",
		cwd: pick<string>("cwd") ?? "",
		text: String(raw.text ?? ""),
		verified: pick<boolean>("verified") ?? null,
		dismiss_reason: pick<string>("dismiss_reason") ?? null,
		job_id: pick<string>("job_id", "jobId"),
		session_id: pick<string>("session_id", "sessionId"),
		claimed_by: pick<string>("claimed_by", "claimedBy"),
		verified_reason: pick<string>("verified_reason", "verifiedReason"),
		dismissed_at: pick<string>("dismissed_at"),
	};
}

/**
 * The findings that belong to one project, in list order. The inbox is machine-wide because loops
 * are; triage is not — a finding about another repository read in this one is guesswork, and
 * claiming it runs it in the wrong directory. `/inbox` lists these the way `/cron` lists this
 * project's jobs, with `--all` for the machine.
 *
 * `sameProject` is the caller's test (a worktree, a symlink or a subdirectory is the same project).
 * A finding written without a cwd belongs to no project and is never hidden by the filter.
 */
export function inProject(entries: InboxEntry[], cwd: string, sameProject: (a: string, b: string) => boolean): InboxEntry[] {
	return entries.filter((e) => belongsToProject(e, cwd, sameProject));
}

/** The same test for one finding — `/inbox clear` dismisses exactly what `/inbox` listed. */
export function belongsToProject(entry: InboxEntry, cwd: string, sameProject: (a: string, b: string) => boolean): boolean {
	return !entry.cwd || sameProject(entry.cwd, cwd);
}

/** Resolve "<n>" (1-based in the new list) or an id / unique id prefix. */
export function resolveInboxRef(entries: InboxEntry[], ref: string): InboxEntry | undefined {
	const trimmed = ref.trim();
	if (!trimmed) return undefined;
	if (/^\d+$/.test(trimmed)) return entries[Number(trimmed) - 1];
	const matches = entries.filter((e) => e.id === trimmed || e.id.startsWith(trimmed));
	return matches.length === 1 ? matches[0] : undefined;
}
