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

	append(entry: Omit<InboxEntry, "id" | "createdAt" | "status">): InboxEntry {
		const full: InboxEntry = {
			id: `inb-${randomBytes(16).toString("hex")}`, // pie: inb-<uuid simple>
			createdAt: new Date().toISOString(),
			...entry,
			source: capChars(entry.source, 80),
			text: capChars(entry.text.replace(/\s+/g, " "), INBOX_TEXT_MAX_CHARS),
			status: "new",
		};
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		fs.appendFileSync(this.file, `${JSON.stringify(full)}\n`, "utf8");
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
				const e = JSON.parse(line) as InboxEntry;
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
		writeFileAtomic(this.file, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
	}
}

/** Resolve "<n>" (1-based in the new list) or an id / unique id prefix. */
export function resolveInboxRef(entries: InboxEntry[], ref: string): InboxEntry | undefined {
	const trimmed = ref.trim();
	if (!trimmed) return undefined;
	if (/^\d+$/.test(trimmed)) return entries[Number(trimmed) - 1];
	const matches = entries.filter((e) => e.id === trimmed || e.id.startsWith(trimmed));
	return matches.length === 1 ? matches[0] : undefined;
}
