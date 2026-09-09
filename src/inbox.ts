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
import { INBOX_TEXT_MAX_CHARS, capChars } from "./protocol.ts";
import { randomBytes } from "node:crypto";

export type InboxStatus = "new" | "claimed" | "dismissed";

export interface InboxEntry {
	id: string;
	createdAt: string;
	/** Bounded origin label, e.g. "loop:check-issues" or "loop:loop-1a2b3c4d". */
	source: string;
	text: string;
	runId: string;
	jobId: string;
	cwd: string;
	/** Session that owned the loop when it reported (pie's session_id); loops are machine-global here. */
	sessionId?: string;
	status: InboxStatus;
	claimedBy?: string;
	/** true = passed the checker; false = checker dropped it (never appended); undefined = no checker / unreviewed. */
	verified?: boolean;
	/** Checker's reason when it kept a finding, if it gave one. */
	verifiedReason?: string;
}

export class Inbox {
	readonly file: string;
	private readonly lockPath: string;

	constructor(dir: string) {
		this.file = path.join(dir, "inbox.jsonl");
		this.lockPath = path.join(dir, "inbox.lock");
	}

	async append(entry: Omit<InboxEntry, "id" | "createdAt" | "status">): Promise<InboxEntry> {
		const full: InboxEntry = {
			id: `inb-${randomBytes(16).toString("hex")}`, // pie: inb-<uuid simple>
			createdAt: new Date().toISOString(),
			...entry,
			source: capChars(entry.source, 80),
			text: capChars(entry.text.replace(/\s+/g, " "), INBOX_TEXT_MAX_CHARS),
			status: "new",
		};
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		// Under the same lock as the triage rewrites: findings are appended by every pi window, the
		// headless host and up to `max_concurrent_runs` loop runs, while `/inbox dismiss|clear`
		// rewrites the whole file. pie takes its lock on append for the same reason (inbox.rs:71).
		// The lock is awaited, never spun on: a leftover lock directory from a killed process would
		// otherwise block this process's event loop for the whole stale window.
		await withFileLock(this.lockPath, () => fs.appendFileSync(this.file, `${JSON.stringify(toDisk(full))}\n`, "utf8"));
		return full;
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
				const e = fromDisk(JSON.parse(line));
				if (e && typeof e.id === "string" && typeof e.text === "string") out.push(e);
			} catch {
				/* skip corrupt line */
			}
		}
		return out;
	}

	listNew(): InboxEntry[] {
		return this.list().filter((e) => e.status === "new");
	}

	/** Count of new entries; 0 on any error (badge path must never throw). */
	newCount(): number {
		try {
			return this.listNew().length;
		} catch {
			return 0;
		}
	}

	async setStatus(id: string, status: InboxStatus, claimedBy?: string): Promise<InboxEntry | undefined> {
		return withFileLock(this.lockPath, () => {
			const entries = this.list();
			const entry = entries.find((e) => e.id === id);
			if (!entry) return undefined;
			entry.status = status;
			if (claimedBy) entry.claimedBy = claimedBy;
			this.rewrite(entries);
			return entry;
		});
	}

	async dismissAllNew(): Promise<number> {
		return withFileLock(this.lockPath, () => {
			const entries = this.list();
			let changed = 0;
			for (const e of entries) {
				if (e.status === "new") {
					e.status = "dismissed";
					changed++;
				}
			}
			if (changed) this.rewrite(entries);
			return changed;
		});
	}

	private rewrite(entries: InboxEntry[]): void {
		writeFileAtomic(this.file, entries.map((e) => JSON.stringify(toDisk(e))).join("\n") + (entries.length ? "\n" : ""));
	}
}

/**
 * On disk the file uses pie's record shape — `{id, created_at, source, text, trace_id, session_id,
 * status}` — plus pi-loops' extras (`job_id`, `cwd`, `claimed_by`, `verified`, `verified_reason`),
 * so tooling written for pie's inbox.jsonl reads it. Lines written by pi-loops ≤ 0.1.2 (camelCase)
 * are still understood.
 */
function toDisk(e: InboxEntry): Record<string, unknown> {
	return {
		id: e.id,
		created_at: e.createdAt,
		source: e.source,
		text: e.text,
		trace_id: e.runId,
		session_id: e.sessionId ?? null,
		status: e.status,
		job_id: e.jobId,
		cwd: e.cwd,
		...(e.claimedBy !== undefined ? { claimed_by: e.claimedBy } : {}),
		...(e.verified !== undefined ? { verified: e.verified } : {}),
		...(e.verifiedReason !== undefined ? { verified_reason: e.verifiedReason } : {}),
	};
}

function fromDisk(raw: any): InboxEntry | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const pick = <T>(...keys: string[]): T | undefined => {
		for (const k of keys) if (raw[k] !== undefined && raw[k] !== null) return raw[k] as T;
		return undefined;
	};
	const status = pick<string>("status");
	return {
		id: String(raw.id ?? ""),
		createdAt: pick<string>("created_at", "createdAt") ?? "",
		source: pick<string>("source") ?? "",
		text: String(raw.text ?? ""),
		runId: pick<string>("trace_id", "runId") ?? "",
		jobId: pick<string>("job_id", "jobId") ?? "",
		cwd: pick<string>("cwd") ?? "",
		sessionId: pick<string>("session_id", "sessionId"),
		status: status === "claimed" || status === "dismissed" ? status : "new",
		claimedBy: pick<string>("claimed_by", "claimedBy"),
		verified: pick<boolean>("verified"),
		verifiedReason: pick<string>("verified_reason", "verifiedReason"),
	};
}

/** Resolve "<n>" (1-based in the new list) or an id / unique id prefix. */
export function resolveInboxRef(entries: InboxEntry[], ref: string): InboxEntry | undefined {
	const trimmed = ref.trim();
	if (!trimmed) return undefined;
	if (/^\d+$/.test(trimmed)) return entries[Number(trimmed) - 1];
	const matches = entries.filter((e) => e.id === trimmed || e.id.startsWith(trimmed));
	return matches.length === 1 ? matches[0] : undefined;
}
