/**
 * A loop's memory (docs/loops.md "A loop's notes"). The loop writes one text each run, the index,
 * and it may keep longer notes as files in its own directory. Everything else a run is shown is
 * built here from a ledger, with a fixed window and a fixed size:
 *
 *   - `notesWrite`: the one place the notes are capped, at the write, never silently;
 *   - `reportedFor`: the `[reported]` lines, what the loop already told a person and what they did;
 *   - `notesFiles` and `notesFileLines`: the `[notes-files]` lines, listed and not loaded.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { InboxEntry } from "./inbox.ts";
import { LOOP_STATE_MAX_CHARS, capChars } from "./protocol.ts";
import { cardText } from "./redact.ts";
import { stamp } from "./schedule.ts";

/** The file in a loop's notes directory that gets the whole text of a write over the cap. */
export const OVERFLOW_FILE = "overflow.md";
/** How long a decided finding stays in `[reported]`. */
export const REPORTED_DAYS = 14;
/** The newest `new` findings `[reported]` shows, and the newest decided ones, each. */
export const REPORTED_PER_KIND = 12;
/**
 * What the `[reported]` block lists, in the one sentence every playbook and document uses: a recipe
 * cannot compute it, so `test/notes.test.ts` holds each of them to this text, built from the limits
 * `reportedFor` applies.
 */
export const REPORTED_WORDS = `lists your findings that are still new (the newest ${REPORTED_PER_KIND}) and the ones a person claimed or dismissed in the last ${REPORTED_DAYS} days (the newest ${REPORTED_PER_KIND}), with what they did`;

/** A finding's text, and a dismiss reason, as `[reported]` cuts them. */
export const REPORTED_TEXT_CHARS = 200;
/** The files `[notes-files]` lists; a line says how many more there are. */
export const NOTES_FILES_LISTED = 50;

/** `<loops dir>/state/<job id>/`: the one directory a run of that loop may read and write with path tools. */
export function notesDirOf(loopsDir: string, jobId: string): string {
	return path.join(loopsDir, "state", jobId);
}

export interface NotesWrite {
	/** What `state/<id>.md` gets. */
	index: string;
	/** The whole text, when it was cut: `state/<id>/overflow.md` gets it. */
	overflow?: string;
	/** Characters written, and characters of them kept in the index. */
	cut?: { from: number; to: number };
}

/** The line that ends an index that was cut. */
export function cutLine(from: number, to: number, cap = LOOP_STATE_MAX_CHARS): string {
	return `(cut by pi-loops: you wrote ${from} characters and ${to} are kept here. The whole text is in ${OVERFLOW_FILE}. Move what matters into files and keep these notes under ${cap} characters.)`;
}

/**
 * What one write of the notes stores. Under the cap, the index is the text. Over it, the index is
 * the leading whole lines that fit, then `cutLine`, and the whole text goes to the overflow file:
 * nothing is lost and nothing is silent. The index with its cut line is never longer than `cap`.
 * Characters are code points, as `capChars` counts them.
 */
export function notesWrite(text: string, cap = LOOP_STATE_MAX_CHARS): NotesWrite {
	const from = Array.from(text).length;
	if (from <= cap) return { index: text };
	// The cut line with `to` = `from` is the longest it can be: `to` is never more digits than `from`.
	const budget = cap - Array.from(cutLine(from, from, cap)).length - 1;
	const kept: string[] = [];
	let used = 0;
	for (const line of text.split("\n")) {
		const cost = Array.from(line).length + (kept.length ? 1 : 0);
		if (used + cost > budget) break;
		kept.push(line);
		used += cost;
	}
	const keptText = kept.join("\n");
	const to = Array.from(keptText).length;
	const last = cutLine(from, to, cap);
	return { index: kept.length ? `${keptText}\n${last}` : last, overflow: text, cut: { from, to } };
}

/** When a decided finding was decided: the dismiss, the answer to a claim, or a claim from the command line. */
function decidedAt(f: InboxEntry): string {
	if (f.status === "dismissed" && f.dismissed_at) return f.dismissed_at;
	const answer = f.answer;
	if (answer && "at" in answer && typeof answer.at === "string") return answer.at;
	if (f.status === "claimed" && f.claimed_at) return f.claimed_at;
	// An older version wrote no time for a claim from the command line. Its filing is the nearest time such a finding has.
	return f.created_at;
}

/**
 * The lines of `[reported]`: what loop `jobId` told a person and what they did with it. Its `new`
 * findings (the newest `REPORTED_PER_KIND`) and its findings decided in the last `REPORTED_DAYS`
 * days (the newest `REPORTED_PER_KIND`), newest first, one line each:
 * `- <MM-DD> <status>[ ("<reason>")]: <text>`, the date of the filing for a new finding and of the
 * decision for a decided one. The text and the reason are cut at `REPORTED_TEXT_CHARS` and are
 * `cardText`. A question about a call (`ask`) is in `[asked]`, and a finding pi-loops filed about
 * one (`re`) is not the loop's own report: neither is here.
 */
export function reportedFor(findings: readonly InboxEntry[], jobId: string, now: number): string[] {
	const mine = findings.filter((f) => f.job_id === jobId && !f.ask && f.re === undefined);
	const newest = (list: InboxEntry[], at: (f: InboxEntry) => string) =>
		list.map((f) => ({ f, at: at(f) })).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, REPORTED_PER_KIND);
	const open = newest(mine.filter((f) => f.status === "new"), (f) => f.created_at);
	const since = now - REPORTED_DAYS * 86_400_000;
	const decided = newest(mine.filter((f) => f.status !== "new" && Date.parse(decidedAt(f)) >= since), decidedAt);
	const cut = (text: string) => capChars(cardText(text), REPORTED_TEXT_CHARS);
	return [...open, ...decided]
		.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
		.map(({ f, at }) => {
			const why = f.status === "dismissed" && f.dismiss_reason ? ` ("${cut(f.dismiss_reason)}")` : "";
			return `- ${at.slice(5, 10)} ${f.status}${why}: ${cut(f.text)}`;
		});
}

/** One file of a loop's notes directory, as `[notes-files]` lists it. `name` is relative to the directory. */
export interface NotesFile {
	name: string;
	bytes: number;
	changedMs: number;
}

/**
 * The regular files under `dir`, by name; a symbolic link is not listed. A directory that is not
 * there has no files.
 */
export function notesFiles(dir: string): NotesFile[] {
	let entries: fs.Dirent[];
	try {
		entries = walkNoLinks(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	const files: NotesFile[] = [];
	for (const e of entries) {
		if (!e.isFile()) continue;
		const full = path.join(e.parentPath, e.name);
		try {
			const st = fs.lstatSync(full);
			files.push({ name: path.relative(dir, full), bytes: st.size, changedMs: st.mtimeMs });
		} catch {
			/* a file removed between the listing and the stat is not listed */
		}
	}
	return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function size(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The lines of `[notes-files]`: `- <name> · <size> · changed <YYYY-MM-DD>`, at most `NOTES_FILES_LISTED`, then how many more. */
export function notesFileLines(files: readonly NotesFile[]): string[] {
	const lines = files.slice(0, NOTES_FILES_LISTED).map((f) => cardText(`- ${f.name} · ${size(f.bytes)} · changed ${stamp(f.changedMs).slice(0, 10)}`));
	const more = files.length - NOTES_FILES_LISTED;
	return more > 0 ? [...lines, `- … and ${more} more`] : lines;
}

/**
 * Every entry under `dir`, depth first, never entering a symbolic link. `readdirSync`'s `recursive`
 * follows a link to a directory, which would list files outside the notes (a link to the loops
 * directory) and walk a link cycle or the whole file system.
 */
export function walkNoLinks(dir: string): fs.Dirent[] {
	const out: fs.Dirent[] = [];
	const visit = (d: string, top: boolean): void => {
		let here: fs.Dirent[];
		try {
			here = fs.readdirSync(d, { withFileTypes: true });
		} catch (err) {
			if (top) throw err;
			return; // a subdirectory removed or unreadable mid-walk is skipped
		}
		for (const e of here) {
			out.push(e);
			if (e.isDirectory() && !e.isSymbolicLink()) visit(path.join(d, e.name), false);
		}
	};
	visit(dir, true);
	return out;
}
