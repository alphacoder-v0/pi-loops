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
	/** Whether that holder answers what is sent to it (`holderDelivers`): a `pi -p` run or a window standing aside does not. */
	delivers: boolean;
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
/** A session file's header id, from its first line alone. */
export type IdReader = (file: string) => string | undefined;

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
/** Header ids kept in memory for `byId`; past this the oldest go first. */
export const ID_CACHE_CAP = 20_000;
/** Ids remembered as not in a directory, per directory, until its mtime changes. */
export const MISS_CAP = 1000;

/**
 * Text someone typed, made safe to draw as one line: terminal escape sequences, C0 and C1 controls,
 * and the bidi embeddings, overrides and isolates go, as the page's `plain()` takes them out
 * (src/web/page.js). Escaping stops markup; it does nothing about a U+202E that reorders the line.
 */
export function plainText(text: string): string {
	return String(text ?? "")
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b[[(][0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
		.replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
}

/** The id in a session file's first line, read from its first 4 KB; a longer first line is read whole by `readSessionHead`. */
export function readHeaderId(file: string): string | undefined {
	let text = "";
	try {
		const fd = fs.openSync(file, "r");
		try {
			const buf = Buffer.alloc(4096);
			text = buf.toString("utf8", 0, fs.readSync(fd, buf, 0, buf.length, 0));
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined; // gone, or not readable
	}
	const cut = text.indexOf("\n");
	if (cut < 0 && text.length >= 4000) return readSessionHead(file)?.id;
	try {
		const header = JSON.parse(cut < 0 ? text : text.slice(0, cut));
		return header?.type === "session" && typeof header.id === "string" ? header.id : undefined;
	} catch {
		return undefined; // a torn header: not a session file anyone can open
	}
}

/**
 * The pi arguments for a conversation the page starts with none recorded: those of the conversation
 * in the same project opened most recently with any, so a project whose pages load pi-loops with
 * `-e` loads it in this one too. Taken only from what the pool recorded, never from HTTP.
 */
export function projectArgs(cwd: string, candidates: ReadonlyArray<{ cwd?: string; at: number; args: readonly string[] }>): string[] {
	const best = candidates.filter((c) => c.cwd === cwd && c.args.length > 0).sort((a, b) => (b.at || 0) - (a.at || 0))[0];
	return best ? withoutConversation(best.args) : [];
}

/** pi's arguments that pick or name a conversation, and take a value: another conversation's are not this one's. */
const CONVERSATION_ARGS = new Set(["--session", "--session-id", "--fork", "--session-dir", "--name", "-n", "--export"]);
/**
 * And those that take none, with the person's one-time answers: `--approve` (`-a`) trusts a project
 * for that run, and a later conversation opened from the list must not inherit that answer.
 */
const CONVERSATION_FLAGS = new Set(["--continue", "-c", "--resume", "-r", "--no-session", "--approve", "-a"]);

/** `args` without the ones that say which conversation: what loads pi-loops (`-e`), a model, a flag stay. */
function withoutConversation(args: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (CONVERSATION_FLAGS.has(a)) continue;
		if (CONVERSATION_ARGS.has(a)) {
			i++;
			continue;
		}
		if ([...CONVERSATION_ARGS].some((k) => k.startsWith("--") && a.startsWith(`${k}=`))) continue;
		out.push(a);
	}
	return out;
}

/** A map used as a cache that drops its least recently used entry past `cap`. */
function lruGet<K, V>(map: Map<K, V>, key: K): V | undefined {
	const v = map.get(key);
	if (v !== undefined) {
		map.delete(key);
		map.set(key, v);
	}
	return v;
}
function lruSet<K, V>(map: Map<K, V>, key: K, v: V, cap: number): void {
	map.delete(key);
	map.set(key, v);
	while (map.size > cap) map.delete(map.keys().next().value as K);
}

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
	const text = plainText(head?.name ?? "").trim() || plainText(head?.first ?? "").trim();
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
		// As `Inbox.listNew` reads it: a finding with no id or no text is no card, so it is no count.
		if (typeof e.id !== "string" || !e.id || typeof e.text !== "string" || !e.text) continue;
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

/** One look at every directory: the projects found, by cwd. Asked once per answer and handed to both `projects` and `rows`. */
export type ProjectScan = ReadonlyMap<string, Project>;

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
	/** Header ids by file: a header is written once, so an id read stays the file's id. */
	private readonly ids = new Map<string, string | null>();
	/** Ids `byId` looked for in a directory and did not find, with the directory's mtime then. */
	private readonly misses = new Map<string, { mtimeMs: number; ids: Set<string> }>();
	private readonly sessionsRoot: string | undefined;
	private readonly read: HeadReader;
	private readonly leaseFiles: () => readonly string[];
	private readonly readId: IdReader;
	/** How many times every directory was looked at: one per answer. */
	scans = 0;

	constructor(sessionsRoot: string | undefined, read: HeadReader = (file) => readSessionHead(file), leaseFiles: () => readonly string[] = () => [], readId: IdReader = readHeaderId) {
		this.sessionsRoot = sessionsRoot;
		this.read = read;
		this.leaseFiles = leaseFiles;
		this.readId = readId;
	}

	/** The head of `f`, read only when it changed since the last read. */
	private head(f: SessionFile): SessionHead | undefined {
		const have = lruGet(this.heads, f.file);
		if (have && have.mtimeMs === f.mtimeMs && have.size === f.size) return have.head;
		const head = this.read(f.file);
		lruSet(this.heads, f.file, { mtimeMs: f.mtimeMs, size: f.size, head }, HEAD_CACHE_CAP);
		return head;
	}

	/** The header id of `file`: a head already read says it, else its first line, once. */
	private idOf(f: SessionFile): string | undefined {
		const head = this.heads.get(f.file);
		if (head && head.mtimeMs === f.mtimeMs && head.size === f.size) return head.head?.id;
		const have = lruGet(this.ids, f.file);
		if (have !== undefined) return have ?? undefined;
		const id = this.readId(f.file);
		// Only an id that was there: a header being written when it was read is read again next time,
		// not remembered as having none.
		if (id !== undefined) lruSet(this.ids, f.file, id, ID_CACHE_CAP);
		return id;
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
	scan(): ProjectScan {
		this.scans++;
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
	projects(readers: Pick<RowReaders, "projectCwds">, scanned: ProjectScan = this.scan()): ProjectRow[] {
		const rows: ProjectRow[] = [...scanned].sort((a, b) => b[1].lastMs - a[1].lastMs).map(([cwd, p]) => ({ cwd, label: projectLabel(cwd), lastActivityAt: stamp(p.lastMs), conversations: p.files }));
		const extra = [...new Set(readers.projectCwds().filter((c) => typeof c === "string" && c !== "" && !scanned.has(c)))].sort();
		return [...rows, ...extra.map((cwd) => ({ cwd, label: projectLabel(cwd), conversations: 0 }))];
	}

	/**
	 * The conversations of the project `cwd`, newest first, at most `ROW_CAP`. Undefined for a cwd
	 * that is not a project here: `cwd` is a key into what was found, and nothing else is looked up.
	 */
	rows(cwd: string, readers: RowReaders, scanned: ProjectScan = this.scan()): { rows: ConversationRow[]; more: number } | undefined {
		const project = scanned.get(cwd);
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
			const holder = holderOf(readers.lease(head.id), readers.alive, open);
			rows.push({
				sessionId: head.id,
				cwd,
				...(title !== undefined ? { title } : {}),
				lastActivityAt: stamp(f.mtimeMs),
				holder: holder.kind,
				delivers: holder.delivers,
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
	 * pi's sessions root only.
	 *
	 * Asked on every load of a conversation no lease names and no child has, the page's 8 s poll
	 * included, on the loop everything else runs on, so it is cheap when the answer is no. Files named
	 * after the id (`<stamp>_<id>.jsonl`, pi's own naming) are looked at first. Then the rest, by the
	 * header's first line alone, each read once; and an id not found in a directory is not looked for
	 * there again until a file is added to it or taken away (its mtime changes).
	 */
	byId(id: string): { sessionFile: string; cwd: string } | undefined {
		try {
			sessionFileName(id);
		} catch {
			return undefined; // `..`, a slash: not an id
		}
		const dirs = this.dirs();
		const found = (f: SessionFile) => {
			const head = this.head(f);
			return head?.id === id && head.cwd ? { sessionFile: f.file, cwd: head.cwd } : undefined;
		};
		const listed = new Map<string, SessionFile[]>();
		const filesOf = (dir: string) => {
			if (!listed.has(dir)) listed.set(dir, this.files(dir));
			return listed.get(dir) as SessionFile[];
		};
		for (const dir of dirs) {
			let names: string[];
			try {
				names = fs.readdirSync(dir).slice(0, DIR_ENTRIES_CAP);
			} catch {
				continue; // gone, or not a directory
			}
			if (!names.some((n) => n.endsWith(".jsonl") && n.includes(id))) continue;
			for (const f of filesOf(dir)) if (path.basename(f.file).includes(id)) {
				const hit = found(f);
				if (hit) return hit;
			}
		}
		for (const dir of dirs) {
			let mtimeMs: number;
			try {
				mtimeMs = fs.statSync(dir).mtimeMs;
			} catch {
				continue; // gone since it was listed
			}
			const missed = this.misses.get(dir);
			if (missed && missed.mtimeMs === mtimeMs && missed.ids.has(id)) continue;
			for (const f of filesOf(dir)) if (this.idOf(f) === id) {
				const hit = found(f);
				if (hit) return hit;
			}
			const keep = missed && missed.mtimeMs === mtimeMs ? missed : { mtimeMs, ids: new Set<string>() };
			if (keep.ids.size >= MISS_CAP) keep.ids.clear();
			keep.ids.add(id);
			this.misses.set(dir, keep);
		}
		return undefined;
	}
}
