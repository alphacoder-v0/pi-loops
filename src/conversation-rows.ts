/**
 * The page's conversation list, as a file read: pi's session files under its sessions root, the
 * lease of each conversation, the request rows queued for it and the inbox's open decisions. Nothing
 * here starts a pi or writes a file, so showing the list costs no child of the page's six.
 *
 * pi keeps a project's conversations in `<sessions root>/<encoded cwd>/*.jsonl`. The encoding is
 * pi's, so a directory is never decoded here: a project is the `cwd` in the header of its newest
 * file, and every lookup from HTTP is an exact match against those, never a path that is read.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { holderDelivers, type LeaseHolder, type SessionLease, sessionFileName } from "./lease.ts";
import { stamp } from "./schedule.ts";
import { previewText, readSessionHead, type SessionHead } from "./session-head.ts";

/** Who has a conversation open, in the list's words: a terminal, the page, pi-loops in the background, or nobody. */
export type HolderKind = "terminal" | "page" | "background" | "none";

export interface ConversationRow {
	sessionId: string;
	cwd: string;
	/** `/name`, else the first thing said; undefined for a conversation with neither yet. */
	title?: string;
	/** The file's mtime, as a local stamp (`stamp()`). */
	lastActivityAt: string;
	holder: HolderKind;
	/** The page has a pi for it now. */
	open: boolean;
	/** Open decisions (new checkpoints) filed by loops this conversation created. */
	needsYou: number;
	/** Input rows waiting in `requests/<id>.jsonl`. */
	queued: number;
}

export interface ProjectRow {
	cwd: string;
	/** The cwd with the home directory written `~`: unique, as the cwd is. */
	label: string;
	/** The newest conversation's mtime; undefined for a project known only by a lease or a job. */
	lastActivityAt?: string;
	/** Session files in it. */
	conversations: number;
}

export type HeadReader = (file: string) => SessionHead | undefined;

/** What the rows need besides pi's files: each is read once per answer. */
export interface RowReaders {
	lease(sessionId: string): Partial<Pick<SessionLease, "holder" | "cwd">> | undefined;
	alive(holder: LeaseHolder): boolean;
	/** Whether the page has a pi for this conversation (the pool). */
	open(sessionId: string): boolean;
	needsYou(): ReadonlyMap<string, number>;
	queued(sessionId: string): number;
	/** Projects named by a lease or a job, which are offered even with no session file. */
	projectCwds(): readonly string[];
}

/** Rows in one answer; the rest are counted in `more`. */
export const ROW_CAP = 500;
/** Entries looked at in one directory, as `listSessionsHere` cuts them (src/page-children.ts). */
export const DIR_ENTRIES_CAP = 2000;
/** Heads kept in memory; past this the cache starts again. */
export const HEAD_CACHE_CAP = 2000;
/** Characters of a title. */
export const TITLE_CHARS = 60;

/**
 * The holder of a conversation, from its lease. The rule `sessionRows` applies (src/page-server.ts):
 * a live lease written by a page child is the page's, another live terminal lease is a terminal's, a
 * live host lease is pi-loops in the background. A pool child whose lease is not written yet is the
 * page's too. `delivers` is `holderDelivers`: whether that holder answers what the page sends.
 */
export function holderOf(lease: Partial<Pick<SessionLease, "holder">> | undefined, alive: (h: LeaseHolder) => boolean, openInPage: boolean): { kind: HolderKind; pid?: number; delivers: boolean } {
	const h = lease?.holder;
	if (h && alive(h)) {
		const kind: HolderKind = h.kind === "host" ? "background" : h.page === true ? "page" : "terminal";
		return { kind, pid: h.pid, delivers: holderDelivers(h) };
	}
	return openInPage ? { kind: "page", delivers: true } : { kind: "none", delivers: false };
}

/** The name someone gave a conversation, else the first thing said in it, as one line of 60 characters. */
export function titleOf(head: Pick<SessionHead, "name" | "first"> | undefined): string | undefined {
	const text = head?.name?.trim() || head?.first?.trim();
	return text ? previewText(text, TITLE_CHARS) : undefined;
}

/** A project's label: its cwd, with the home directory written `~`. */
export function projectLabel(cwd: string, home: string = os.homedir()): string {
	if (home && home !== "/" && (cwd === home || cwd.startsWith(home + path.sep))) return `~${cwd.slice(home.length)}`;
	return cwd;
}

/** Open decisions in `inbox.jsonl`, by the session that created the loop that filed them. A torn line is skipped. */
export function countNeedsYou(text: string): Map<string, number> {
	const out = new Map<string, number>();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let e: any;
		try {
			e = JSON.parse(line);
		} catch {
			continue; // a torn line: the inbox skips it too
		}
		if ((e?.status ?? "new") !== "new" || e?.kind !== "checkpoint" || typeof e?.session_id !== "string") continue;
		out.set(e.session_id, (out.get(e.session_id) ?? 0) + 1);
	}
	return out;
}

/** `countNeedsYou` of one file, read again only when its size or mtime changed. */
export class NeedsYouCounts {
	private readonly file: string;
	private at?: { mtimeMs: number; size: number; counts: Map<string, number> };
	constructor(file: string) {
		this.file = file;
	}
	get(): ReadonlyMap<string, number> {
		let st: fs.Stats;
		try {
			st = fs.statSync(this.file);
		} catch {
			return new Map(); // no inbox yet
		}
		if (this.at && this.at.mtimeMs === st.mtimeMs && this.at.size === st.size) return this.at.counts;
		let text = "";
		try {
			text = fs.readFileSync(this.file, "utf8");
		} catch {
			return new Map(); // gone between the stat and the read
		}
		this.at = { mtimeMs: st.mtimeMs, size: st.size, counts: countNeedsYou(text) };
		return this.at.counts;
	}
}

interface SessionFile {
	file: string;
	mtimeMs: number;
	size: number;
}

interface Project {
	dirs: string[];
	lastMs: number;
	files: number;
}

/**
 * pi's session files, read for the list. One per page server, in memory; it reads nothing until it
 * is asked. Each file's head is kept with the size and mtime it was read at, so a warm answer reads
 * only the files that changed since (usually one: the conversation being written).
 *
 * `sessionsRoot` is pi's sessions directory. Without it, the only directories looked at are those of
 * the session files that leases name (`leaseFiles`), so a server built without it never reads the
 * person's real `~/.pi`.
 */
export class ConversationIndex {
	private readonly heads = new Map<string, { mtimeMs: number; size: number; head: SessionHead | undefined }>();
	private readonly sessionsRoot: string | undefined;
	private readonly read: HeadReader;
	private readonly leaseFiles: () => readonly string[];

	constructor(sessionsRoot: string | undefined, read: HeadReader = (file) => readSessionHead(file), leaseFiles: () => readonly string[] = () => []) {
		this.sessionsRoot = sessionsRoot;
		this.read = read;
		this.leaseFiles = leaseFiles;
	}

	/** The head of `f`, read only when it changed since the last read. */
	private head(f: SessionFile): SessionHead | undefined {
		const have = this.heads.get(f.file);
		if (have && have.mtimeMs === f.mtimeMs && have.size === f.size) return have.head;
		if (this.heads.size >= HEAD_CACHE_CAP) this.heads.clear();
		const head = this.read(f.file);
		this.heads.set(f.file, { mtimeMs: f.mtimeMs, size: f.size, head });
		return head;
	}

	/** The directories a conversation can be in: the sessions root's own, else the ones leases name. */
	private dirs(): string[] {
		if (this.sessionsRoot === undefined) {
			return [...new Set(this.leaseFiles().filter((f) => typeof f === "string" && path.isAbsolute(f)).map((f) => path.dirname(f)))];
		}
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(this.sessionsRoot, { withFileTypes: true });
		} catch {
			return []; // pi has saved nothing yet
		}
		return entries
			.slice(0, DIR_ENTRIES_CAP)
			.filter((e) => e.isDirectory())
			.map((e) => path.join(this.sessionsRoot as string, e.name));
	}

	/** The session files in `dir`, newest first. A link is not one: it could point anywhere. */
	private files(dir: string): SessionFile[] {
		let names: string[];
		try {
			names = fs.readdirSync(dir);
		} catch {
			return []; // gone, or not a directory
		}
		const out: SessionFile[] = [];
		for (const name of names.slice(0, DIR_ENTRIES_CAP)) {
			if (!name.endsWith(".jsonl")) continue;
			const file = path.join(dir, name);
			let st: fs.Stats;
			try {
				st = fs.lstatSync(file);
			} catch {
				continue; // removed while listed
			}
			if (st.isFile()) out.push({ file, mtimeMs: st.mtimeMs, size: st.size });
		}
		return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
	}

	/** Every directory, keyed by the cwd in its newest readable header. */
	private scan(): Map<string, Project> {
		const out = new Map<string, Project>();
		for (const dir of this.dirs()) {
			const files = this.files(dir);
			let cwd: string | undefined;
			// The newest file says which project this is; a torn or foreign newest file passes the
			// question to the next one, a few times at most.
			for (const f of files.slice(0, 5)) {
				cwd = this.head(f)?.cwd || undefined;
				if (cwd) break;
			}
			if (!cwd) continue;
			const have = out.get(cwd);
			const lastMs = files[0]?.mtimeMs ?? 0;
			if (have) {
				have.dirs.push(dir);
				have.lastMs = Math.max(have.lastMs, lastMs);
				have.files += files.length;
			} else out.set(cwd, { dirs: [dir], lastMs, files: files.length });
		}
		return out;
	}

	/** The projects to offer, newest first: those with conversations, then those only a lease or a job names. */
	projects(readers: Pick<RowReaders, "projectCwds">): ProjectRow[] {
		const scanned = this.scan();
		const rows: ProjectRow[] = [...scanned].sort((a, b) => b[1].lastMs - a[1].lastMs).map(([cwd, p]) => ({ cwd, label: projectLabel(cwd), lastActivityAt: stamp(p.lastMs), conversations: p.files }));
		const extra = [...new Set(readers.projectCwds().filter((c) => typeof c === "string" && c !== "" && !scanned.has(c)))].sort();
		return [...rows, ...extra.map((cwd) => ({ cwd, label: projectLabel(cwd), conversations: 0 }))];
	}

	/**
	 * The conversations of the project `cwd`, newest first, at most `ROW_CAP`. Undefined for a cwd
	 * that is not a project here: `cwd` is a key into what was found, and nothing else is looked up.
	 */
	rows(cwd: string, readers: RowReaders): { rows: ConversationRow[]; more: number } | undefined {
		const project = this.scan().get(cwd);
		if (!project) return readers.projectCwds().includes(cwd) ? { rows: [], more: 0 } : undefined;
		const files = project.dirs.flatMap((dir) => this.files(dir)).sort((a, b) => b.mtimeMs - a.mtimeMs);
		const needsYou = readers.needsYou();
		const seen = new Set<string>();
		const rows: ConversationRow[] = [];
		let at = 0;
		for (; at < files.length && rows.length < ROW_CAP; at++) {
			const f = files[at];
			const head = this.head(f);
			// Not a session file, or a torn header: not a conversation anyone can open.
			if (!head || seen.has(head.id)) continue;
			seen.add(head.id);
			const open = readers.open(head.id);
			const title = titleOf(head);
			rows.push({
				sessionId: head.id,
				cwd,
				...(title !== undefined ? { title } : {}),
				lastActivityAt: stamp(f.mtimeMs),
				holder: holderOf(readers.lease(head.id), readers.alive, open).kind,
				open,
				needsYou: needsYou.get(head.id) ?? 0,
				queued: readers.queued(head.id),
			});
		}
		return { rows, more: files.length - at };
	}

	/**
	 * The session file whose header id is `id`, and the cwd that header names; undefined for an id
	 * that is not a usable file name or that no file here has. What `pi --session <id>` accepts, under
	 * pi's sessions root only. Files named after the id are tried first, which is how pi names them.
	 */
	byId(id: string): { sessionFile: string; cwd: string } | undefined {
		try {
			sessionFileName(id);
		} catch {
			return undefined; // `..`, a slash: not an id
		}
		const files = this.dirs().flatMap((dir) => this.files(dir));
		const named = files.filter((f) => path.basename(f.file).includes(id));
		for (const f of [...named, ...files.filter((f) => !named.includes(f))]) {
			const head = this.head(f);
			if (head?.id === id && head.cwd) return { sessionFile: f.file, cwd: head.cwd };
		}
		return undefined;
	}
}
