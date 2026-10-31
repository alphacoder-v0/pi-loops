/**
 * Requests addressed to a session: `requests/<sessionId>.jsonl`, private state. The file holds live
 * rows only; a row leaves it once its delivery is in the conversation, or as a dead letter in the
 * inbox. Rows are appended under `requests.lock`, and a removal or an update is an atomic rewrite
 * under it. The engine (src/engine.ts) decides what each row gets; this file only keeps them.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { sessionFileName } from "./lease.ts";
import { withFileLockSync, writeFileAtomic } from "./lock.ts";

/** pi's image part, as `pi.sendUserMessage` takes it; pi does not export the type from its package. */
export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export type RequestKind = "input" | "stop" | "cancel";
export type RequestMode = "attended" | "unattended" | "none";
export type RequestSource =
	| `cron:${string}` // a plain job: the clock, `pi-loops run`, the cron_run tool
	| `cron-run:${string}` // `/cron run`, typed in the job's own conversation
	| `rule:${string}`
	| `push:${string}`
	| "goal"
	| `inbox:${string}`
	| `recipe:${string}`
	| "new-trigger"
	| "person"
	| "cli"
	| "window";

export interface SessionRequest {
	v: 2;
	/** pi-loops rows: the id inside `[Trigger <id>] `, the proof of delivery. Person rows: a UUID the page mints. */
	id: string;
	session_id: string;
	kind: RequestKind;
	source: RequestSource;
	/** modeOf(kind, source, wake), written by the producer, recomputed by the executor; a wider row is refused. */
	mode: RequestMode;
	/** input only: `turn` runs a model turn, `append` writes an entry without one. */
	wake?: "turn" | "append";
	payload?: {
		text: string; // pi-loops sources: ≤ 8 KB (docs/design.md decision 11), redacted, prefixed
		images?: ImageContent[]; // person rows only
		cwd: string;
		model?: string;
		thinking?: string;
		tools?: string[];
		builtin_tools?: string[];
		timeout_ms?: number;
		/** MCP servers the turn needs: the row waits for a connection. */
		requires?: string[];
	};
	/** stop, cancel. Never "whatever runs next". */
	target?: { id: string } | { current: true; started_before: string };
	collapse_key?: string;
	created_at: string;
	/**
	 * For a person row, the producer that must be alive for it to be sent; for a local row (a claim, a
	 * goal continuation), the window that runs it while it lives. `left` is the stamp at which that
	 * window left the conversation (`/new`, `/resume`, quitting) with the row still queued: the pid
	 * lives on, bound elsewhere, and the row is the holder's to run.
	 */
	created_by: { pid: number; instance: string; procStart?: string; version: string; left?: string };
	not_before?: string; // backoff after a failure only; scheduling stays in jobs.json
	attempts: number;
	last_error?: string;
}

export const REQUEST_VERSION = 2;
const KINDS: ReadonlySet<string> = new Set<RequestKind>(["input", "stop", "cancel"]);

/**
 * One line as a row, or undefined for a line this version does not act on: torn, not JSON, a newer
 * `v`, or an unknown `kind`. Such a line is kept in the file for the version that wrote it.
 */
export function parseRequestLine(line: string): SessionRequest | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined; // a torn last line, or not ours
	}
	if (!value || typeof value !== "object") return undefined;
	const row = value as Partial<SessionRequest>;
	if (row.v !== REQUEST_VERSION || typeof row.id !== "string" || typeof row.session_id !== "string" || typeof row.kind !== "string" || !KINDS.has(row.kind)) return undefined;
	// The file is ours, but anything could have written it: a row whose fields are not the shape the
	// engine reads is skipped like a newer one, rather than thrown on in the middle of a drain.
	if (typeof row.source !== "string" || typeof row.mode !== "string") return undefined;
	const by = row.created_by as unknown as Record<string, unknown> | undefined;
	if (!by || typeof by !== "object" || typeof by.pid !== "number" || typeof by.instance !== "string" || (by.left !== undefined && typeof by.left !== "string")) return undefined;
	if (row.payload !== undefined && (!row.payload || typeof row.payload !== "object" || typeof row.payload.text !== "string")) return undefined;
	const requires = row.payload?.requires;
	if (requires !== undefined && (!Array.isArray(requires) || !requires.every((s) => typeof s === "string"))) return undefined;
	const target = row.target as unknown;
	if (target !== undefined && !(target && typeof target === "object" && (typeof (target as { id?: unknown }).id === "string" || ((target as { current?: unknown }).current === true && typeof (target as { started_before?: unknown }).started_before === "string")))) return undefined;
	return { ...row, attempts: typeof row.attempts === "number" ? row.attempts : 0 } as SessionRequest;
}

/** Whether `file` ends in the middle of a line. */
function endsTorn(file: string): boolean {
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, "r");
		const size = fs.fstatSync(fd).size;
		if (size === 0) return false;
		const last = Buffer.alloc(1);
		fs.readSync(fd, last, 0, 1, size - 1);
		return last[0] !== 0x0a;
	} catch {
		return false; // no file yet
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

export class RequestStore {
	readonly dir: string;
	private readonly lockPath: string;

	constructor(dir: string) {
		this.dir = dir;
		this.lockPath = path.join(dir, "requests.lock");
	}

	file(sessionId: string): string {
		return path.join(this.dir, "requests", `${sessionFileName(sessionId)}.jsonl`);
	}

	/** Every line of the file, parsed where this version can: a removal keeps the lines it cannot. */
	private lines(sessionId: string): Array<{ raw: string; row?: SessionRequest }> {
		let data: string;
		try {
			data = fs.readFileSync(this.file(sessionId), "utf8");
		} catch {
			return []; // no requests for this session
		}
		return data
			.split("\n")
			.filter((raw) => raw.length > 0)
			.map((raw) => ({ raw, row: parseRequestLine(raw) }));
	}

	append(row: SessionRequest): void {
		withFileLockSync(this.lockPath, () => this.appendLocked(row));
	}

	/**
	 * Append `row` unless a row with its id is already queued; returns whether it was written. Two
	 * producers of one slot (a window's clock and the one before it crashed) derive the same id, so
	 * the second append is a no-op instead of a second prompt. With `collapse`, a queued input row
	 * with the same `collapse_key` also makes it a no-op (collapse, never replay); the check is under
	 * the same lock as the write, so two producers cannot both find the key free. A row `done` says
	 * is already in the conversation does not collapse anything: it is in the file only until the
	 * next drain removes it.
	 */
	appendIfAbsent(row: SessionRequest, opts: { collapse?: boolean; done?: (queued: SessionRequest) => boolean } = {}): boolean {
		return withFileLockSync(this.lockPath, () => {
			const queued = this.lines(row.session_id);
			if (queued.some(({ row: q }) => q?.id === row.id)) return false;
			if (opts.collapse && row.collapse_key !== undefined && queued.some(({ row: q }) => q?.kind === "input" && q.collapse_key === row.collapse_key && !opts.done?.(q))) return false;
			this.appendLocked(row);
			return true;
		});
	}

	private appendLocked(row: SessionRequest): void {
		const file = this.file(row.session_id);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		// A write cut short by a crash leaves a last line with no newline; appended to, it would take
		// this row down with it.
		fs.appendFileSync(file, `${endsTorn(file) ? "\n" : ""}${JSON.stringify(row)}\n`, "utf8");
	}

	/** The rows of `sessionId` this version acts on, in file order. A row naming another session is not this file's to act on. */
	list(sessionId: string): SessionRequest[] {
		return this.lines(sessionId).flatMap(({ row }) => (row && row.session_id === sessionId ? [row] : []));
	}

	/** Rewrite the file without `ids`, under the lock; every line not ours stays. The file goes when nothing is left. */
	remove(sessionId: string, ids: Iterable<string>): void {
		const gone = new Set(ids);
		this.rewrite(sessionId, (lines) => lines.filter(({ row }) => !row || !gone.has(row.id)));
	}

	/** Rewrite one row with `patch` applied, under the lock; a row removed meanwhile stays removed. */
	update(sessionId: string, id: string, patch: Partial<Pick<SessionRequest, "attempts" | "not_before" | "last_error" | "created_by">>): void {
		this.rewrite(sessionId, (lines) => lines.map(({ raw, row }) => (row && row.id === id ? { raw: JSON.stringify({ ...row, ...patch }), row } : { raw, row })));
	}

	private rewrite(sessionId: string, change: (lines: Array<{ raw: string; row?: SessionRequest }>) => Array<{ raw: string }>): void {
		const file = this.file(sessionId);
		withFileLockSync(this.lockPath, () => {
			const remaining = change(this.lines(sessionId));
			if (remaining.length) writeFileAtomic(file, `${remaining.map(({ raw }) => raw).join("\n")}\n`);
			else fs.rmSync(file, { force: true });
		});
	}

	/** The sessions with a request file. */
	sessions(): string[] {
		try {
			return fs
				.readdirSync(path.join(this.dir, "requests"))
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => f.slice(0, -".jsonl".length));
		} catch {
			return []; // no requests directory yet
		}
	}
}
