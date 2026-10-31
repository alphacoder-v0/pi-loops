/**
 * Requests addressed to a session: `requests/<sessionId>.jsonl`, private state. The file holds live
 * rows only; a row leaves it once its delivery is in the conversation, or as a dead letter in the
 * inbox. Rows are appended under that session's own lock (`requests/<sessionId>.lock`), and a
 * removal or an update is an atomic rewrite under it, so one conversation's rewrite never holds
 * another's writers. A person row's image bytes are in a file beside the queue, one per row, and
 * the row carries their digests. The engine (src/engine.ts) decides what each row gets; this file
 * only keeps them.
 */
import { createHash } from "node:crypto";
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

/**
 * An image of a person row as the queue file carries it: its type and a digest of its bytes. The
 * bytes are in the row's image file (`RequestStore.images`), so three screenshots are a line in the
 * queue, not thirty megabytes parsed at every listing and rewritten and synced at every update.
 */
export interface ImageRef {
	type: "image";
	mimeType: string;
	sha256: string;
}

export function imageRef(image: ImageContent): ImageRef {
	return { type: "image", mimeType: image.mimeType, sha256: createHash("sha256").update(image.data).digest("hex") };
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
		images?: ImageRef[]; // person rows only; the bytes are in the row's image file
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
	/**
	 * Person rows: when the holder last handed the row to pi, written under the lock just before the
	 * call. The proof of delivery is a user message with the row's text written at or after this; a
	 * row never handed over has none and is never done. Not part of the fingerprint.
	 */
	handed_at?: string;
	/** Person rows: when the page sent it again after a Stop (`/queue/send`); a row released after the hold began is not held by it. Not part of the fingerprint. */
	released_at?: string;
}

/** What `RequestStore.removeIf` did with the row it was asked about. */
export type Taken = { outcome: "removed" | "kept"; row: SessionRequest } | { outcome: "missing" };

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
	const images = row.payload?.images as unknown;
	if (images !== undefined && (!Array.isArray(images) || !images.every((i) => !!i && typeof i === "object" && typeof (i as ImageRef).mimeType === "string" && typeof (i as ImageRef).sha256 === "string"))) return undefined;
	if (row.handed_at !== undefined && typeof row.handed_at !== "string") return undefined;
	if (row.released_at !== undefined && typeof row.released_at !== "string") return undefined;
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

	constructor(dir: string) {
		this.dir = dir;
	}

	file(sessionId: string): string {
		return path.join(this.dir, "requests", `${sessionFileName(sessionId)}.jsonl`);
	}

	/** One conversation's lock, beside its file: a rewrite of one queue never holds another's writers. A `requests.lock` an older version left is nobody's. */
	private lockPath(sessionId: string): string {
		return path.join(this.dir, "requests", `${sessionFileName(sessionId)}.lock`);
	}

	/** Where a row's image bytes are: one file per row, its name derived from a digest of the row id, never from the id as written. */
	imageFile(sessionId: string, rowId: string): string {
		return path.join(this.dir, "requests", `${sessionFileName(sessionId)}.${createHash("sha256").update(rowId).digest("hex").slice(0, 32)}.images.json`);
	}

	/** Every line of the file, parsed where this version can: a removal keeps the lines it cannot. */
	private lines(sessionId: string): Array<{ raw: string; row?: SessionRequest }> {
		let data: string;
		try {
			// A regular file only: a FIFO or a device put here would block every reader on it.
			if (!fs.lstatSync(this.file(sessionId)).isFile()) return [];
			data = fs.readFileSync(this.file(sessionId), "utf8");
		} catch {
			return []; // no requests for this session
		}
		return data
			.split("\n")
			.filter((raw) => raw.length > 0)
			.map((raw) => ({ raw, row: parseRequestLine(raw) }));
	}

	/**
	 * Append `row`; `images` are the bytes its `payload.images` digests name, written beside the queue
	 * first, so a row never names a file that is not there. An append that fails (a lock that timed
	 * out, a file that cannot be written) takes the image file with it: a file no row names is an orphan.
	 */
	append(row: SessionRequest, images?: ImageContent[]): void {
		const imageFile = images?.length ? this.imageFile(row.session_id, row.id) : undefined;
		if (imageFile) writeFileAtomic(imageFile, JSON.stringify(images));
		try {
			withFileLockSync(this.lockPath(row.session_id), () => this.appendLocked(row));
		} catch (err) {
			if (imageFile) fs.rmSync(imageFile, { force: true });
			throw err;
		}
	}

	/**
	 * Image files no row names any more, older than `olderThanMs`: a crash between the image write and
	 * the append leaves one, and so would an older version's removal. Younger ones may belong to an
	 * append in flight, whose row is not in the file yet. Returns the files removed.
	 */
	sweepImages(now = Date.now(), olderThanMs = 60_000): string[] {
		const dir = path.join(this.dir, "requests");
		let names: string[];
		try {
			names = fs.readdirSync(dir);
		} catch {
			return []; // no requests directory yet
		}
		const live = new Set<string>();
		for (const sessionId of this.sessions()) for (const row of this.list(sessionId)) if (row.payload?.images?.length) live.add(this.imageFile(sessionId, row.id));
		const removed: string[] = [];
		for (const name of names) {
			if (!/^[^/]+\.[0-9a-f]{32}\.images\.json$/.test(name)) continue;
			const file = path.join(dir, name);
			if (live.has(file)) continue;
			try {
				if (now - fs.statSync(file).mtimeMs < olderThanMs) continue;
				fs.rmSync(file);
				removed.push(file);
			} catch {
				/* gone meanwhile, or not ours to remove: the next sweep looks again */
			}
		}
		return removed;
	}

	/**
	 * The bytes of a person row's images, checked against the digests the row carries: a file swapped
	 * under the row, or gone, is an error for the caller to report, never other bytes sent as the
	 * person's. The fingerprint the page rang with covers the digests, so this is the same check.
	 */
	images(row: SessionRequest): ImageContent[] {
		const refs = row.payload?.images ?? [];
		if (!refs.length) return [];
		let value: unknown;
		try {
			value = JSON.parse(fs.readFileSync(this.imageFile(row.session_id, row.id), "utf8"));
		} catch (err: any) {
			throw new Error(`the images of request ${row.id} cannot be read: ${err?.message ?? err}`);
		}
		const images = Array.isArray(value) ? (value as Array<Partial<ImageContent>>) : [];
		const same = images.length === refs.length && refs.every((ref, i) => typeof images[i]?.data === "string" && images[i].mimeType === ref.mimeType && imageRef(images[i] as ImageContent).sha256 === ref.sha256);
		if (!same) throw new Error(`the images of request ${row.id} are not the ones it was written with`);
		return images.map((image) => ({ type: "image", data: image.data!, mimeType: image.mimeType! }));
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
		return withFileLockSync(this.lockPath(row.session_id), () => {
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

	/** Rewrite the file without `ids`, under the lock; every line not ours stays. The file goes when nothing is left, and each removed row's image file with it. */
	remove(sessionId: string, ids: Iterable<string>): void {
		const gone = new Set(ids);
		this.rewrite(sessionId, (lines) => lines.filter(({ row }) => !row || !gone.has(row.id)));
		for (const id of gone) fs.rmSync(this.imageFile(sessionId, id), { force: true });
	}

	/**
	 * Rewrite one row with `patch` applied, under the lock; a row removed meanwhile stays removed, and
	 * the result says so: false when no row `id` was in the file, so a hand-over whose stamp did not
	 * land knows the row is gone (cancelled, or sent from the page) and hands nothing over.
	 */
	update(sessionId: string, id: string, patch: Partial<Pick<SessionRequest, "attempts" | "not_before" | "last_error" | "created_by" | "handed_at" | "released_at">>): boolean {
		let found = false;
		this.rewrite(sessionId, (lines) =>
			lines.map(({ raw, row }) => {
				if (!row || row.id !== id) return { raw, row };
				found = true;
				return { raw: JSON.stringify({ ...row, ...patch }), row };
			}),
		);
		return found;
	}

	/**
	 * Remove row `id` under the lock, but only if `when` holds for the row as it is in the file at that
	 * moment: the page takes a message back only while no holder has stamped it handed over, and the
	 * check and the removal are one critical section, so a stamp cannot land between them. Says what
	 * happened: `removed` with the row, `kept` with the row `when` refused, or `missing`.
	 */
	removeIf(sessionId: string, id: string, when: (row: SessionRequest) => boolean): Taken {
		// Assigned inside the rewrite's callback, which the type checker does not follow: no narrowing here.
		let result = { outcome: "missing" } as Taken;
		this.rewrite(sessionId, (lines) =>
			lines.filter(({ row }) => {
				if (!row || row.id !== id) return true;
				result = when(row) ? { outcome: "removed", row } : { outcome: "kept", row };
				return result.outcome !== "removed";
			}),
		);
		if (result.outcome === "removed") fs.rmSync(this.imageFile(sessionId, id), { force: true });
		return result;
	}

	private rewrite(sessionId: string, change: (lines: Array<{ raw: string; row?: SessionRequest }>) => Array<{ raw: string }>): void {
		const file = this.file(sessionId);
		withFileLockSync(this.lockPath(sessionId), () => {
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
