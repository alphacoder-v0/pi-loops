/**
 * The triage inbox — the routing layer. Global JSONL shared by every session and
 * project: loops run wherever they were created; the inbox is what you open in
 * the morning. Findings are one-liners with a new → claimed/dismissed lifecycle.
 *
 * Appends are line-atomic; status rewrites are serialized through a file lock.
 * Corrupt lines are skipped on read and written back verbatim by every rewrite, never deleted.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type AnswerWrite, type AskFields, keptByRotation, readAskFields, screenAskFields } from "./ask.ts";
import type { LaneId } from "./lane.ts";
import { type LockOptions, withFileLock, withFileLockSync, writeFileAtomic } from "./lock.ts";
import { INBOX_TEXT_MAX_CHARS, type FindingKind, capChars } from "./protocol.ts";
import { cardText, redact, screenText } from "./redact.ts";
import { newId } from "./store.ts";
import { stamp } from "./schedule.ts";
import { laneTranscripts } from "./session-head.ts";

export type InboxStatus = "new" | "claimed" | "dismissed";

/** Past this the inbox drops its oldest triaged entries (docs/configuration.md). */
export const INBOX_ROTATE_BYTES = 1_000_000;

/**
 * A finding, in memory and on disk: the ten fields of the contract first, in their order, then
 * pi-loops' own, which no interface names and which a line may be missing. This is the one shape —
 * a line of `inbox.jsonl` is `JSON.stringify` of this, and `pi-loops inbox --json` is the first ten
 * fields of it. What the inbox gives a reader has its words screened (`screenFinding`); the file
 * keeps them as they were written.
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
	/** The session that created the loop that filed this finding. */
	session_id?: string;
	claimed_by?: string;
	/** Checker's reason when it kept a finding, if it gave one. */
	verified_reason?: string;
	/** When it was dismissed — what decides whether the loop's next run is shown the reason. */
	dismissed_at?: string;
	/** The transcript of the run that filed this finding (RunRecord.sessionFile), for a person to open. */
	transcript?: string;
	/**
	 * pi's session id of that transcript (RunRecord.sessionId), from the header pi wrote. An answer's
	 * run finds the transcript to resume by it in its lane's own directory (`laneTranscript`), never
	 * by `transcript`. Absent on a finding an older version wrote: its answer starts a new session.
	 */
	transcript_id?: string;
	/**
	 * Set by the engine's dead letter alone: a prompt that never reached its conversation. The text
	 * says so too, but the text is anyone's to write, and a claim of this finding carries it out.
	 */
	undelivered?: true;
	/** The lane the finding was filed from (src/lane.ts). Absent on a finding an older version wrote. */
	lane?: LaneId;
	/** This finding is a question about one blocked call (src/ask.ts). Written when it is filed and never changed. */
	ask?: AskFields["ask"];
	/** The surface that claimed or dismissed it. Written only through `AnswerWrite`. */
	answered_by?: AskFields["answered_by"];
	/** The answer to a claim from a terminal or the page. Written only through `AnswerWrite`. */
	answer?: AskFields["answer"];
	/**
	 * The root of this finding's thread: the `inb-` id of the finding a news `not-run` or `outcome`
	 * is about (src/ask.ts `newsEntry`). A surface draws this finding under its root while the root
	 * is listed, and on its own when it is not.
	 */
	re?: string;
}

/** The fields a finding is, in their order — CONTRACT.md §2.2 and docs/downstream.md §3. */
export const FINDING_FIELDS = ["id", "created_at", "status", "kind", "source", "run_id", "cwd", "text", "verified", "dismiss_reason"] as const;

/** What a writer gives for a new finding; the inbox fills in the id, the time and the status. A new finding has no answer. */
export type NewFinding = Omit<InboxEntry, "id" | "created_at" | "status" | "kind" | "verified" | "dismiss_reason" | "answered_by" | "answer"> & Partial<Pick<InboxEntry, "kind" | "verified">>;

/** A value that is not a promise: the body of a section is synchronous, so `inbox.lock` is never held across an await. */
export type Sync<T> = T extends PromiseLike<unknown> ? never : T;

/**
 * `inbox.jsonl` while `inbox.lock` is held. It lives for one call of `Inbox.section`. `list` and
 * `find` give the findings with their words as the file has them: the protocol's steps read those,
 * so a finding they file beside another carries its words, not a reader's copy. What the section
 * gives back out of it is screened (`screenFinding`), as `write` and `fileOnce` return it.
 */
export interface InboxSection {
	/** Every finding, as the file has it now. Read once for the section. */
	list(): readonly InboxEntry[];
	find(id: string): InboxEntry | undefined;
	/**
	 * One atomic rewrite, made at once: `change.set` on its finding, `change.unset` taken off it, and `change.beside` appended
	 * unless a finding has that id. `more` are further changes of the same rewrite. Returns the first
	 * finding as written, screened. A change whose finding is not in the file throws, and nothing is written.
	 */
	write(change: AnswerWrite, ...more: AnswerWrite[]): InboxEntry;
	/** `Inbox.fileOnce`, inside the section: a finding with this id is returned as it is, else `entry` is written with it. Screened. */
	fileOnce(entry: NewFinding, id: string): InboxEntry;
}

/**
 * How long a lane write waits for the lane's lock while `inbox.lock` is held: well inside the inbox
 * lock's ten-second stale point, so a stuck lane lock makes the section throw and no other process
 * breaks `inbox.lock` under its rewrite.
 */
export const UNDER_INBOX_LOCK: LockOptions = { timeoutMs: 5_000 };

/**
 * One line of `inbox.jsonl`: its text, and the finding it reads as, with the words as the file has
 * them. A reader outside a section gets `screenFinding` of it. A rewrite writes a line nothing
 * `changed` as `raw`, byte for byte, and a changed one from `stored`, so that reading never changes
 * the file.
 */
type Line =
	| { raw: string; stored?: undefined }
	| {
			raw: string;
			stored: InboxEntry;
			/** The fields of the line this version does not read: written back as they were. */
			rest?: Record<string, unknown>;
			/** A write set fields on it, or it is new: `raw` is not what it is now. */
			changed?: true;
	  };
type FindingLine = Extract<Line, { stored: InboxEntry }>;
const isFindingLine = (line: Line): line is FindingLine => line.stored !== undefined;

/**
 * The id of a finding that is filed once: `inb-` and the first 32 hex of SHA-256(`seed`). It has
 * the shape of every other finding id. Pure.
 */
export function findingId(seed: string): string {
	return `inb-${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
}

/** The shape of every finding's id, `newId("inb")`'s and `findingId`'s alike. */
const FINDING_ID = /^inb-[0-9a-f]{32}$/;

export class Inbox {
	readonly file: string;
	private readonly lockPath: string;

	constructor(dir: string) {
		this.file = path.join(dir, "inbox.jsonl");
		this.lockPath = path.join(dir, "inbox.lock");
	}

	async append(entry: NewFinding): Promise<InboxEntry> {
		const full = this.build(entry);
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		// Under the same lock as the triage rewrites: findings are appended by every pi window, the
		// headless host and up to `max_concurrent_runs` loop runs, while `/inbox dismiss|clear`
		// rewrites the whole file — an append landing mid-rewrite is a finding nobody ever sees.
		// The lock is awaited, never spun on: a leftover lock directory from a killed process would
		// otherwise block this process's event loop for the whole stale window.
		await withFileLock(this.lockPath, () => this.write(full));
		return screenFinding(full);
	}

	/**
	 * Append `entry` unless a finding with the key's `run_id` and `source` is in the inbox already, and
	 * return the finding that is there either way. A key that has `session_id`, even undefined, names
	 * one creating conversation's group and matches only its finding; a key without it matches any.
	 * The look and the append are one step under the inbox lock. A rule check files its result this
	 * way, and the promotion's inbox fallback and the dead letter of its row then find it: one result,
	 * one finding, whichever writer comes first. With `unlessRepeat`, the latest new finding of the
	 * same `job_id`, `cwd` and source with the same text is the one that is there.
	 */
	async appendOnce(entry: NewFinding, key: { run_id: string; source: string } | { run_id: string; source: string; session_id: string | undefined }, opts: { unlessRepeat?: boolean } = {}): Promise<InboxEntry> {
		const full = this.build(entry);
		const source = capChars(key.source, LABEL_MAX_CHARS);
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		return withFileLock(this.lockPath, () => {
			// Compared by the stored words: a key is what a writer gave, before any screening.
			const all = this.lines().filter(isFindingLine);
			const there = all.find(({ stored: e }) => e.run_id === key.run_id && e.source === source && (!("session_id" in key) || e.session_id === key.session_id));
			if (there) return screenFinding(there.stored);
			const latest = opts.unlessRepeat ? all.filter(({ stored: e }) => e.status === "new" && e.job_id === full.job_id && e.cwd === full.cwd && e.source === full.source).at(-1) : undefined;
			if (latest && latest.stored.text === full.text) return screenFinding(latest.stored);
			this.write(full);
			return screenFinding(full);
		});
	}

	/**
	 * Under `inbox.lock`: a finding with this id is returned as it is in the file, whatever its status
	 * and whatever `entry` says; otherwise `entry` is written with this id and returned. One finding
	 * per id, the first one to a second caller. For a writer that may crash and run again (a dead
	 * letter): the caller derives the id with `findingId`, and an id that is not `inb-` and 32 hex
	 * throws, because a hand-made id is a second way to file twice. A finding that rotation took out
	 * of the file is not there to find: a repeat that late files again.
	 */
	async fileOnce(entry: NewFinding, id: string): Promise<InboxEntry> {
		if (!FINDING_ID.test(id)) throw new Error(`not a finding id: ${JSON.stringify(id)}`);
		return this.section((tx) => tx.fileOnce(entry, id));
	}

	/**
	 * Run `fn` under `inbox.lock`. `fn` is synchronous. It may take one lane's lock inside (a
	 * `RequestStore` write with `UNDER_INBOX_LOCK`), and no other lock. A throw from `fn` before
	 * `write` leaves the file as it was.
	 */
	async section<T>(fn: (tx: InboxSection) => Sync<T>): Promise<T> {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		return withFileLock(this.lockPath, () => fn(this.openSection()));
	}

	/** The same section behind the synchronous lock: for the conversion at start, which runs before anything else and holds no lock. */
	sectionSync<T>(fn: (tx: InboxSection) => Sync<T>): T {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		return withFileLockSync(this.lockPath, () => fn(this.openSection()));
	}

	/** The section over the file as it is now. Caller holds the lock. */
	private openSection(): InboxSection {
		let lines = this.lines();
		const lineOf = (id: string): FindingLine | undefined => lines.filter(isFindingLine).find((l) => l.stored.id === id);
		const find = (id: string): InboxEntry | undefined => lineOf(id)?.stored;
		// An append past the rotation size rotates, as `append` does, and the section goes on with what is left.
		const rotated = (): void => {
			const kept = this.rotate(() => lines);
			if (kept) lines = kept;
		};
		return {
			list: () => lines.flatMap(({ stored }) => (stored ? [stored] : [])),
			find,
			write: (change, ...more) => {
				const changes = [change, ...more];
				const targets = changes.map((c) => {
					const target = lineOf(c.id);
					if (!target) throw new Error(`no finding ${c.id} to write`);
					return target;
				});
				let appended = false;
				changes.forEach((c, i) => {
					const target = targets[i];
					Object.assign(target.stored, c.set);
					for (const key of c.unset ?? []) delete target.stored[key];
					target.changed = true;
					if (c.beside && !find(c.beside.id)) {
						lines.push({ raw: "", stored: this.build(c.beside.entry, c.beside.id), changed: true });
						appended = true;
					}
				});
				this.rewrite(lines);
				if (appended) rotated();
				return screenFinding(targets[0].stored);
			},
			fileOnce: (entry, id) => {
				if (!FINDING_ID.test(id)) throw new Error(`not a finding id: ${JSON.stringify(id)}`);
				const there = find(id);
				if (there) return screenFinding(there);
				const stored = this.build(entry, id);
				const raw = JSON.stringify(stored);
				fs.appendFileSync(this.file, `${raw}\n`, "utf8");
				lines.push({ raw, stored });
				rotated();
				return screenFinding(stored);
			},
		};
	}

	/** The line a new finding is: built in `FINDING_FIELDS` order, then pi-loops' own. */
	private build(entry: NewFinding, id = newId("inb")): InboxEntry {
		return {
			id, // inb-<32 hex>, the shape every other id in pi-loops has
			created_at: stamp(),
			status: "new",
			kind: entry.kind ?? "news",
			source: capChars(entry.source, LABEL_MAX_CHARS),
			run_id: entry.run_id,
			cwd: entry.cwd,
			text: capChars(entry.text.replace(/\s+/g, " "), INBOX_TEXT_MAX_CHARS),
			verified: entry.verified ?? null,
			dismiss_reason: null,
			job_id: entry.job_id,
			claimed_by: entry.claimed_by,
			verified_reason: entry.verified_reason,
			dismissed_at: entry.dismissed_at,
			...(entry.session_id === undefined ? {} : { session_id: entry.session_id }),
			...(entry.transcript === undefined ? {} : { transcript: entry.transcript }),
			...(entry.transcript_id === undefined ? {} : { transcript_id: entry.transcript_id }),
			...(entry.undelivered ? { undelivered: true as const } : {}),
			...(entry.lane === undefined ? {} : { lane: entry.lane }),
			...(entry.ask === undefined ? {} : { ask: entry.ask }),
			...(entry.re === undefined ? {} : { re: entry.re }),
		};
	}

	/** Caller holds the lock. */
	private write(full: InboxEntry): void {
		fs.appendFileSync(this.file, `${JSON.stringify(full)}\n`, "utf8");
		this.rotate(() => this.lines());
	}

	/**
	 * Past `INBOX_ROTATE_BYTES`, drop the oldest half of the findings that `keptByRotation` does not
	 * keep: never anything still `new`, which is the whole point of the inbox, and the reason this is
	 * not the blind halving the run log and the audit use; never an answer that is open, nor a no that
	 * still holds. This file was the one that grew forever, and `newCount()` re-parses it on every
	 * badge refresh. Caller holds the lock. `read` gives the lines as the file has them. Returns the
	 * lines written, or undefined when nothing was dropped.
	 */
	private rotate(read: () => Line[]): Line[] | undefined {
		try {
			if (fs.statSync(this.file).size < INBOX_ROTATE_BYTES) return undefined;
			const lines = read();
			const now = Date.now();
			const droppable = lines.flatMap(({ stored }) => (stored && !keptByRotation(stored, now) ? [stored] : []));
			const drop = Math.floor(droppable.length / 2);
			// Nothing to drop means an inbox full of findings it keeps: rewriting it would change
			// nothing and would cost a full read+write on every append from here on.
			if (drop === 0) return undefined;
			const dropped = new Set(droppable.slice(0, drop));
			const kept = lines.filter(({ stored }) => !stored || !dropped.has(stored));
			this.rewrite(kept);
			return kept;
		} catch {
			/* best effort: a rotation that fails must never lose the append that just succeeded */
			return undefined;
		}
	}

	/** All entries, oldest first. Unparseable lines are skipped. */
	list(): InboxEntry[] {
		return this.lines().flatMap(({ stored }) => (stored ? [screenFinding(stored)] : []));
	}

	/**
	 * Every non-blank line of the file, in order, with the entry it reads as; `entry` is missing for a
	 * line that is not a finding (torn, not JSON). A rewrite writes such a line back as it found it.
	 */
	private lines(): Line[] {
		let text: string;
		try {
			text = fs.readFileSync(this.file, "utf8");
		} catch (err: any) {
			if (err?.code === "ENOENT") return [];
			throw err;
		}
		const out: Line[] = [];
		for (const raw of text.split("\n")) {
			if (!raw.trim()) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				/* a corrupt line: kept as raw text, read as nothing */
			}
			const stored = readFinding(parsed);
			out.push(stored ? { raw, stored, rest: unread(parsed as Record<string, unknown>, stored) } : { raw });
		}
		return out;
	}

	/**
	 * What is waiting, in triage order: the checkpoints first — a decision a person owes — then the
	 * news, each group in the order it arrived. `/inbox` numbers this list and `claim`/`dismiss`
	 * resolve numbers against it, so the order is decided once, here.
	 */
	listNew(): InboxEntry[] {
		// A finding with no id or no text names nothing a person could read or act on: not listed, not counted.
		const fresh = this.list().filter((e) => e.status === "new" && e.id !== "" && e.text !== "");
		return [...fresh.filter((e) => e.kind === "checkpoint"), ...fresh.filter((e) => e.kind !== "checkpoint")];
	}

	newFor(sessionId: string, since?: string): InboxEntry[] {
		const after = since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(since);
		return this.list().filter((e) => e.status === "new" && e.session_id === sessionId && Date.parse(e.created_at) > after);
	}

	/**
	 * The transcripts in `dir` a prune must keep: those of `new` findings, and those of findings whose
	 * answer is `pending` or `started` (the answer's run resumes them, and its checks read them). By
	 * job for a loop, by lane for a check, whose findings name a rule in `job_id`. A string is a job's
	 * id. `dir` is that lane's own directory: a finding's transcript is the one there whose header
	 * names its session id (`laneTranscripts`). A finding an older version wrote names only a path,
	 * which is kept by that name and never opened.
	 */
	pinnedTranscripts(of: string | { job: string } | { lane: LaneId }, dir: string): Set<string> {
		const mine = typeof of === "string" ? (e: InboxEntry) => e.job_id === of : "job" in of ? (e: InboxEntry) => e.job_id === of.job : (e: InboxEntry) => e.lane === of.lane;
		const open = (e: InboxEntry) => e.status === "new" || e.answer?.state === "pending" || e.answer?.state === "started";
		const pinned = this.list().filter((e) => mine(e) && open(e));
		const ids = pinned.flatMap((e) => (e.ask ? (e.ask.session_id ?? []) : (e.transcript_id ?? [])));
		const named = pinned.flatMap((e) => (!(e.ask ? e.ask.session_id : e.transcript_id) && e.transcript ? [path.resolve(e.transcript)] : []));
		const there = ids.length ? laneTranscripts(dir) : new Map<string, string | undefined>();
		return new Set([...ids.flatMap((id) => (there.get(id) ? [path.resolve(there.get(id)!)] : [])), ...named]);
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

	/**
	 * Write `lines` back: a line nothing changed as it was, byte for byte; a changed finding in this
	 * version's shape, from its stored words, with every field it does not read as it was. Caller
	 * holds the lock.
	 */
	private rewrite(lines: Line[]): void {
		writeFileAtomic(this.file, lines.map((l) => (l.stored && l.changed ? findingLine(l.stored, l.rest) : l.raw)).join("\n") + (lines.length ? "\n" : ""));
	}
}

/**
 * A line as an entry. For a line this version wrote it is the identity; the two older shapes it
 * still reads are pi-loops ≤ 0.1.2 (camelCase throughout) and the shape written until 0.21.0
 * (`trace_id` for the run id, absent optional keys, no `kind` on news). A line in either is
 * rewritten in this shape the next time its status changes.
 */
function readFinding(raw: any): InboxEntry | undefined {
	// The id is the only handle a surface prints and a button sends: a line without one of the shape
	// pi-loops gives (`inb-` and 32 hex) is no finding, and is kept as it is, like a torn line.
	if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !FINDING_ID.test(raw.id)) return undefined;
	// A line anything may have written: a field of the wrong type reads as missing, so every reader
	// of a finding can call a string method on a string field.
	const str = (...keys: string[]): string | undefined => {
		for (const k of keys) if (typeof raw[k] === "string") return raw[k];
		return undefined;
	};
	const status = str("status");
	return {
		id: raw.id,
		created_at: str("created_at", "createdAt") ?? "",
		status: status === "claimed" || status === "dismissed" ? status : "new",
		kind: raw.kind === "checkpoint" ? "checkpoint" : "news",
		source: str("source") ?? "",
		run_id: str("run_id", "trace_id", "runId") ?? "",
		cwd: str("cwd") ?? "",
		text: str("text") ?? "",
		verified: typeof raw.verified === "boolean" ? raw.verified : null,
		dismiss_reason: str("dismiss_reason") ?? null,
		job_id: str("job_id", "jobId"),
		session_id: str("session_id", "sessionId"),
		claimed_by: str("claimed_by", "claimedBy"),
		verified_reason: str("verified_reason", "verifiedReason"),
		dismissed_at: str("dismissed_at"),
		transcript: str("transcript"),
		...(typeof raw.transcript_id === "string" ? { transcript_id: raw.transcript_id } : {}),
		...(raw.undelivered === true ? { undelivered: true as const } : {}),
		...(typeof raw.lane === "string" ? { lane: raw.lane } : {}),
		...readAskFields(raw),
		// A root names a finding: anything else names nothing a surface could draw it under.
		...(typeof raw.re === "string" && FINDING_ID.test(raw.re) ? { re: raw.re } : {}),
	};
}

/** The longest `source` and `job_id` a consumer reads, as `build` caps a new finding's source. */
const LABEL_MAX_CHARS = 80;

/**
 * A finding as every consumer reads it: each field a surface shows, as the card shows it. The text,
 * the source, the reasons, the call and the answer are screened, redacted, on one line and capped.
 * `job_id` is an id, not words: readers match it against a job's or a rule's id. It goes through the
 * same screen only because a hand-edited line can put anything there; an id pi-loops wrote passes
 * through it unchanged, so it still matches. The cwd is an identity too: it is as stored, so it
 * matches its project and its lane exactly; a surface that shows it screens it there. Other ids,
 * stamps, the lane, the transcript and the cap are as stored. Only the steps inside a section and a
 * rewrite read the stored words.
 */
export function screenFinding(stored: InboxEntry): InboxEntry {
	const words = (text: string, max: number): string => capChars(cardText(text), max);
	return {
		...stored,
		source: words(stored.source, LABEL_MAX_CHARS),
		text: words(stored.text, INBOX_TEXT_MAX_CHARS),
		dismiss_reason: stored.dismiss_reason === null ? null : words(stored.dismiss_reason, INBOX_TEXT_MAX_CHARS),
		...(stored.job_id === undefined ? {} : { job_id: words(stored.job_id, LABEL_MAX_CHARS) }),
		...(stored.verified_reason === undefined ? {} : { verified_reason: capChars(redact(screenText(stored.verified_reason)), INBOX_TEXT_MAX_CHARS) }),
		...screenAskFields(stored),
	};
}

/** The keys of the two older shapes that `readFinding` reads into this version's: a rewrite writes them in this shape and drops these. */
const OLDER_KEYS: ReadonlySet<string> = new Set(["createdAt", "trace_id", "runId", "jobId", "sessionId", "claimedBy", "verifiedReason"]);

/**
 * The fields of line `raw` that `entry` does not carry: a field this version does not know, or one
 * of the wrong shape (an `ask` a newer version wrote). A rewrite writes them back as they were.
 */
function unread(raw: Record<string, unknown>, entry: InboxEntry): Record<string, unknown> | undefined {
	const known = entry as unknown as Record<string, unknown>;
	const rest = Object.entries(raw).filter(([key]) => known[key] === undefined && !OLDER_KEYS.has(key));
	return rest.length ? Object.fromEntries(rest) : undefined;
}

/**
 * The line of a finding: its fields in this version's shape, an unreadable `answer` as it was read,
 * then the fields of the line it did not read, unless the finding now carries one of them.
 */
function findingLine(entry: InboxEntry, rest: Record<string, unknown> | undefined): string {
	const { answer, ...fields } = entry;
	const out: Record<string, unknown> = { ...fields };
	if (answer !== undefined) out.answer = answer.state === "unreadable" ? answer.raw : answer;
	for (const [key, value] of Object.entries(rest ?? {})) if (out[key] === undefined) out[key] = value;
	return JSON.stringify(out);
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

/**
 * Resolve an id or a unique id prefix — and, with `ordinals: true`, "<n>", the 1-based position in
 * `entries`. A number is a position in a list the caller printed, so only a caller that printed one
 * may ask for it (`/inbox`, which numbers what it shows); everywhere else a finding is named by its
 * id, and an all-digit ref resolves to nothing, as an unknown id does.
 */
export function resolveInboxRef(entries: InboxEntry[], ref: string, opts?: { ordinals?: boolean }): InboxEntry | undefined {
	const trimmed = ref.trim();
	if (!trimmed) return undefined;
	if (/^\d+$/.test(trimmed)) return opts?.ordinals ? entries[Number(trimmed) - 1] : undefined;
	const matches = entries.filter((e) => e.id === trimmed || e.id.startsWith(trimmed));
	return matches.length === 1 ? matches[0] : undefined;
}
