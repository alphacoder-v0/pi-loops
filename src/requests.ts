/**
 * Requests addressed to a session: `requests/<lane>.jsonl`, private state. The file holds live
 * rows only; a row leaves it once its delivery is in the conversation, or as a dead letter in the
 * inbox. Rows are appended under that session's own lock (`requests/<lane>.lock`), and a
 * removal or an update is an atomic rewrite under it, so one conversation's rewrite never holds
 * another's writers. A person row's image bytes are in a file beside the queue, one per row, and
 * the row carries their digests. The engine (src/engine.ts) decides what each row gets; this file
 * only keeps them.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type ConversationId, type Lane, type LaneId, laneFileName, parseLane } from "./lane.ts";
import { type LockOptions, withFileLockSync, writeFileAtomic } from "./lock.ts";

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
	| `cron:${string}` // a plain job: the clock
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

interface RowBase {
	v: 3;
	/** Set by the reader on a row read from a version 2 line (a row an older version wrote), and never written. */
	line?: 2;
	/** pi-loops rows: the id inside `[Trigger <id>] `. Person rows: a UUID the page mints. With the lane, what the mark names (src/mark.ts). */
	id: string;
	lane: LaneId;
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
		slot?: string;
		catch_up?: true;
		requested_by?: string;
	};
	/** stop, cancel. Never "whatever runs next". */
	target?: { id: string } | { current: true; started_before: string };
	collapse_key?: string;
	/** Slots counted onto this queued row. Absent means zero. */
	collapsed?: number;
	/** The latest slot counted in `collapsed`. */
	collapsed_slot?: string;
	/**
	 * Of the slots in `collapsed`, those counted while this row's run was going: main's skipped
	 * overlaps. A slot counted while the row waited to start, or while its claim's process was gone,
	 * is no skip. Written by the writer that decides the overlap (the clock's collapse, the drain).
	 */
	skipped?: number;
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
	 * A loop's row only: why it does not start yet (`waiting: cwd …`, `paused: …`, `deferred: …`), in
	 * the words main wrote into `lastError`. Written by pi-loops in the background, which decides it,
	 * when it changes; every list reads it (src/job-status.ts `listedJob`).
	 */
	waiting?: string;
	/**
	 * Rows with no `[Trigger <id>] ` (a person's message, a claim, a recipe hand-off, `/new-trigger`, a
	 * goal continuation: src/engine.ts `carriesPrefix`): when the holder last handed the row to pi,
	 * written under the lock just before the call. The page reads it; for a row of a version 2 line it
	 * is still the start of the text proof (a message with the row's words at or after it). Not part
	 * of the fingerprint.
	 */
	handed_at?: string;
}

/** A row no run has claimed. Only this kind is appended, handed to pi, cancelled or failed. */
export interface UnclaimedRow extends RowBase {
	run?: undefined;
}

/**
 * A row a background run has claimed: `run` names the run and its process. `RequestStore.claim`
 * is its one writer, and a patch can only clear it. Only an input is ever a run.
 */
export interface ClaimedRow extends RowBase {
	kind: "input";
	run: { id: string; pid: number; procStart?: string; started_at: string };
}

declare const listed: unique symbol;
/**
 * A claim whose run is in the list of runs of the process that writes it. Only `RunList.claim`
 * (src/run-list.ts) makes one, so no claim is on disk without its run in that list.
 */
export type Listed = ClaimedRow["run"] & { readonly [listed]: true };

/** A request row. `if (row.run)` tells the two kinds apart. */
export type Row = UnclaimedRow | ClaimedRow;

/** What `RequestStore.removeIf` did with the row it was asked about. */
export type Taken = { outcome: "removed" | "kept"; row: Row } | { outcome: "missing" };

const ROW_VERSION = 3;
const KINDS: ReadonlySet<string> = new Set<RequestKind>(["input", "stop", "cancel"]);

/**
 * One line as a row, or undefined for a line this version does not act on: torn, not JSON, a newer
 * `v`, or an unknown `kind`. Such a line is kept in the file for the version that wrote it.
 */
export function parseRow(line: string): Row | undefined {
	return readLine(line)?.row;
}

/** The one reader of a line: its row, and the version the line was written in. */
function readLine(line: string): { row: Row; version: 2 | 3 } | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined; // a torn last line, or not ours
	}
	if (!value || typeof value !== "object") return undefined;
	const parsed = value as Record<string, unknown>;
	const lane = parsed.v === ROW_VERSION ? parsed.lane : parsed.v === 2 ? parsed.session_id : undefined;
	if ((parsed.v !== ROW_VERSION && parsed.v !== 2) || typeof parsed.id !== "string" || typeof lane !== "string" || typeof parsed.kind !== "string" || !KINDS.has(parsed.kind)) return undefined;
	const row = (parsed.v === 2 ? (({ session_id: _, ...rest }) => ({ ...rest, v: ROW_VERSION, lane }))(parsed) : parsed) as Partial<Row>;
	// The file is ours, but anything could have written it: a row whose fields are not the shape the
	// engine reads is skipped like a newer one, rather than thrown on in the middle of a drain.
	if (typeof row.source !== "string" || typeof row.mode !== "string") return undefined;
	const by = row.created_by as unknown as Record<string, unknown> | undefined;
	if (!by || typeof by !== "object" || typeof by.pid !== "number" || typeof by.instance !== "string" || (by.left !== undefined && typeof by.left !== "string")) return undefined;
	if (row.payload !== undefined && (!row.payload || typeof row.payload !== "object" || typeof row.payload.text !== "string")) return undefined;
	const images = row.payload?.images as unknown;
	if (images !== undefined && (!Array.isArray(images) || !images.every((i) => !!i && typeof i === "object" && typeof (i as ImageRef).mimeType === "string" && typeof (i as ImageRef).sha256 === "string"))) return undefined;
	if (typeof row.created_at !== "string" || (row.handed_at !== undefined && typeof row.handed_at !== "string")) return undefined;
	const requires = row.payload?.requires;
	if (requires !== undefined && (!Array.isArray(requires) || !requires.every((s) => typeof s === "string"))) return undefined;
	const target = row.target as unknown;
	if (target !== undefined && !(target && typeof target === "object" && (typeof (target as { id?: unknown }).id === "string" || ((target as { current?: unknown }).current === true && typeof (target as { started_before?: unknown }).started_before === "string")))) return undefined;
	// A claim of the wrong shape is not a free row: the line is kept, unread, as a newer one is. Only
	// an input is ever a run, so a claim on a stop or a cancel is a wrong shape too. So is a claim on
	// a version 2 line: no version writes one, and the version that reads such a line sees no claim.
	const run = (row as { run?: unknown }).run as Record<string, unknown> | null | undefined;
	if (run !== undefined && (parsed.v === 2 || row.kind !== "input" || !run || typeof run !== "object" || typeof run.id !== "string" || typeof run.pid !== "number" || typeof run.started_at !== "string" || (run.procStart !== undefined && typeof run.procStart !== "string"))) return undefined;
	const { line: _line, ...version3 } = row;
	return { row: { ...version3, ...(parsed.v === 2 ? { line: 2 } : {}), attempts: typeof row.attempts === "number" ? row.attempts : 0 } as Row, version: parsed.v === 2 ? 2 : 3 };
}

/**
 * The one writer of a row's line. A row is written as version 3, with one exception: a row that
 * was read from a version 2 line and is only patched stays a version 2 line, so that the version
 * that wrote it still reads it (its window may hold the conversation again; its background
 * process keeps the images of the rows it can read). A claimed row is always version 3: a claim
 * writes version 3, and a version 2 line that carries one is not read. An older version must not
 * read a claimed row, or it would hand the row to pi beside the run that has it. A rewrite puts
 * every line it does not change back as the bytes it read.
 */
function rowLine(row: Row, version: 2 | 3 = ROW_VERSION): string {
	const { line: _line, ...withoutLine } = row;
	if (version === ROW_VERSION) return JSON.stringify(withoutLine);
	const { v: _, lane, ...rest } = withoutLine;
	return JSON.stringify({ v: 2, session_id: lane, ...rest });
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

	file(lane: LaneId): string {
		return path.join(this.dir, "requests", `${laneFileName(lane)}.jsonl`);
	}

	/** One conversation's lock, beside its file: a rewrite of one queue never holds another's writers. A `requests.lock` an older version left is nobody's. */
	private lockPath(lane: LaneId): string {
		return path.join(this.dir, "requests", `${laneFileName(lane)}.lock`);
	}

	/** Where a row's image bytes are: one file per row, its name derived from a digest of the row id, never from the id as written. */
	imageFile(lane: LaneId, rowId: string): string {
		return path.join(this.dir, "requests", `${laneFileName(lane)}.${createHash("sha256").update(rowId).digest("hex").slice(0, 32)}.images.json`);
	}

	/** Every line of the file, parsed where this version can: a removal keeps the lines it cannot. An id that is no lane has no lines. */
	private lines(lane: LaneId): Array<{ raw: string; row?: Row; version?: 2 | 3 }> {
		let data: string;
		try {
			// A regular file only: a FIFO or a device put here would block every reader on it.
			if (!fs.lstatSync(this.file(lane)).isFile()) return [];
			data = fs.readFileSync(this.file(lane), "utf8");
		} catch {
			return []; // no requests for this session
		}
		return data
			.split("\n")
			.filter((raw) => raw.length > 0)
			// A row that names another lane than this file's is not this file's: unread by every method.
			.map((raw) => {
				const read = readLine(raw);
				return read?.row.lane === lane ? { raw, row: read.row, version: read.version } : { raw };
			});
	}

	/**
	 * Append `row`; `images` are the bytes its `payload.images` digests name, written beside the queue
	 * first, so a row never names a file that is not there. An append that fails (a lock that timed
	 * out, a file that cannot be written) takes the image file with it: a file no row names is an orphan.
	 */
	append(row: UnclaimedRow, images?: ImageContent[]): void {
		const imageFile = images?.length ? this.imageFile(row.lane, row.id) : undefined;
		if (imageFile) writeFileAtomic(imageFile, JSON.stringify(images));
		try {
			withFileLockSync(this.lockPath(row.lane), () => this.appendLocked(row));
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
		for (const lane of this.sessions()) for (const row of this.list(lane)) if (row.payload?.images?.length) live.add(this.imageFile(lane, row.id));
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
	images(row: Row): ImageContent[] {
		const refs = row.payload?.images ?? [];
		if (!refs.length) return [];
		let value: unknown;
		try {
			value = JSON.parse(fs.readFileSync(this.imageFile(row.lane, row.id), "utf8"));
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
	 * next drain removes it. `lock` bounds the wait for this queue's lock: a caller that holds another
	 * lock meanwhile passes a timeout shorter than that lock's stale point, and a timeout throws.
	 */
	appendIfAbsent(row: UnclaimedRow, opts: { collapse?: boolean; done?: (queued: Row) => boolean } = {}, lock?: LockOptions): boolean {
		return withFileLockSync(this.lockPath(row.lane), () => {
			const queued = this.lines(row.lane);
			if (queued.some(({ row: q }) => q?.id === row.id)) return false;
			if (opts.collapse && row.collapse_key !== undefined && queued.some(({ row: q }) => q?.kind === "input" && q.collapse_key === row.collapse_key && !opts.done?.(q))) return false;
			this.appendLocked(row);
			return true;
		}, lock);
	}

	/** Count slot `slot` once on row `id`, under the lane lock, and as a skip when `overlap` (its run is going). The row keeps every other field, including its claim. */
	collapse(lane: LaneId, id: string, slot: string, overlap = false, lock?: LockOptions): "counted" | "counted-before" | "missing" {
		let result: "counted" | "counted-before" | "missing" = "missing";
		this.rewrite(lane, (lines) => lines.map(({ raw, row, version }) => {
			if (!row || row.id !== id) return { raw, row };
			if (row.collapsed_slot !== undefined && Date.parse(row.collapsed_slot) >= Date.parse(slot)) {
				result = "counted-before";
				return { raw, row };
			}
			result = "counted";
			return { raw: rowLine({ ...row, collapsed: (row.collapsed ?? 0) + 1, collapsed_slot: slot, ...(overlap ? { skipped: (row.skipped ?? 0) + 1 } : {}) }, version), row };
		}), lock);
		return result;
	}

	private appendLocked(row: UnclaimedRow): void {
		const file = this.file(row.lane);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		// A write cut short by a crash leaves a last line with no newline; appended to, it would take
		// this row down with it.
		fs.appendFileSync(file, `${endsTorn(file) ? "\n" : ""}${rowLine(row)}\n`, "utf8");
	}

	/** The rows of `lane` this version acts on, in file order. A read finds nothing for an id that is no lane; a write throws. */
	list(lane: LaneId): Row[] {
		return this.lines(lane).flatMap(({ row }) => (row ? [row] : []));
	}

	/** Rewrite the file without `ids`, under the lock; every line not ours stays. The file goes when nothing is left, and each removed row's image file with it. */
	remove(lane: LaneId, ids: Iterable<string>): void {
		const gone = new Set(ids);
		this.rewrite(lane, (lines) => lines.filter(({ row }) => !row || !gone.has(row.id)));
		for (const id of gone) fs.rmSync(this.imageFile(lane, id), { force: true });
	}

	/**
	 * Rewrite one row with `patch` applied, under the lock; a row removed meanwhile stays removed, and
	 * the result says so: false when no row `id` was in the file, so a hand-over whose stamp did not
	 * land knows the row is gone (cancelled, or sent from the page) and hands nothing over.
	 */
	update(lane: LaneId, id: string, patch: Partial<Pick<Row, "attempts" | "not_before" | "last_error" | "created_by" | "handed_at" | "waiting">> & { run?: undefined }): boolean {
		let found = false;
		this.rewrite(lane, (lines) =>
			lines.map(({ raw, row, version }) => {
				if (!row || row.id !== id) return { raw, row };
				found = true;
				return { raw: rowLine({ ...row, ...patch }, version), row };
			}),
		);
		return found;
	}

	/**
	 * Write `run` on row `id`, under the lane's lock, only if the row is there, is an input, and no
	 * run has claimed it. Returns whether this caller has the claim. A patch (`update`) can clear a claim and cannot
	 * set one: the condition is checked here, where no other writer can come between.
	 */
	claim(lane: LaneId, id: string, run: Listed): boolean {
		let claimed = false;
		this.rewrite(lane, (lines) =>
			lines.map(({ raw, row }) => {
				if (!row || row.id !== id || row.run || row.kind !== "input") return { raw, row };
				claimed = true;
				return { raw: rowLine({ ...row, kind: "input", run }), row };
			}),
		);
		return claimed;
	}

	/**
	 * Remove row `id` under the lock, but only if `when` holds for the row as it is in the file at that
	 * moment: the page takes a message back only while no holder has stamped it handed over, and the
	 * check and the removal are one critical section, so a stamp cannot land between them. Says what
	 * happened: `removed` with the row, `kept` with the row `when` refused, or `missing`.
	 */
	removeIf(lane: LaneId, id: string, when: (row: Row) => boolean): Taken {
		// Assigned inside the rewrite's callback, which the type checker does not follow: no narrowing here.
		let result = { outcome: "missing" } as Taken;
		this.rewrite(lane, (lines) =>
			lines.filter(({ row }) => {
				if (!row || row.id !== id) return true;
				result = when(row) ? { outcome: "removed", row } : { outcome: "kept", row };
				return result.outcome !== "removed";
			}),
		);
		if (result.outcome === "removed") fs.rmSync(this.imageFile(lane, id), { force: true });
		return result;
	}

	private rewrite(lane: LaneId, change: (lines: Array<{ raw: string; row?: Row; version?: 2 | 3 }>) => Array<{ raw: string }>, lock?: LockOptions): void {
		const file = this.file(lane);
		withFileLockSync(this.lockPath(lane), () => {
			const remaining = change(this.lines(lane));
			if (remaining.length) writeFileAtomic(file, `${remaining.map(({ raw }) => raw).join("\n")}\n`);
			else fs.rmSync(file, { force: true });
		}, lock);
	}

	/** The lane of every queue file, parsed. A file whose name is no lane is nobody's here, and stays. */
	private queues(): Lane[] {
		let names: string[];
		try {
			names = fs.readdirSync(path.join(this.dir, "requests"));
		} catch {
			return []; // no requests directory yet
		}
		return names.flatMap((f) => {
			const lane = f.endsWith(".jsonl") ? parseLane(f.slice(0, -".jsonl".length)) : undefined;
			return lane ? [lane] : [];
		});
	}

	/** The conversations with a queue file. */
	sessions(): ConversationId[] {
		return this.queues().flatMap((lane) => (lane.kind === "conversation" ? [lane.id] : []));
	}

	/** The other lanes with a queue file, parsed: what it lists is not a session id, and cannot go where one goes. */
	lanes(): Array<Exclude<Lane, { kind: "conversation" }>> {
		return this.queues().flatMap((lane) => (lane.kind === "conversation" ? [] : [lane]));
	}
}
