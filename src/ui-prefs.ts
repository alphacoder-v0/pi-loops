/**
 * `ui.json`: the preferences that outlive a session, and the one place that writes them.
 *
 * Three parts of this project keep something here — the browser front end remembers the model and
 * the thinking level you last chose, `/cron panel on|off` remembers whether the panel shows, and
 * the launcher reads the first two back when it starts the next session. A writer that puts its own
 * key into the file and nothing else erases the others', which is how turning the panel off used to
 * send the next morning's session back to pi's default model. So a write here is always
 * read-modify-write: the key is merged into whatever the file already holds, including keys this
 * module has never heard of.
 *
 * The file has a writer outside TypeScript. `src/web.mjs` is plain JS loaded without a TypeScript
 * loader, so it cannot import this module and keeps its own copy of the merge; the shape on disk is
 * therefore a contract, not an implementation detail. It is JSON with a two-space indent and a
 * trailing newline — the spelling the front end already wrote, kept because this is a file people
 * open and read — and unknown keys are left exactly as they were found.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "./lock.ts";

export interface UiPrefs {
	/** Whether `/cron`'s panel shows above the editor. Absent means nobody has turned it off. */
	panel?: boolean;
	/** The model and thinking level last chosen in the browser front end. */
	model?: string;
	thinking?: string;
}

const fileIn = (dir: string): string => path.join(dir, "ui.json");

/**
 * The file as a plain object. A file that is not there and a file somebody edited into something
 * that is not an object read the same — as no preferences — because the only thing either can mean
 * is "nothing has been remembered yet", and failing a command over it would be worse than the
 * default it falls back to.
 */
function readRaw(dir: string): Record<string, unknown> {
	try {
		const doc: unknown = JSON.parse(fs.readFileSync(fileIn(dir), "utf8"));
		return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : {};
	} catch {
		// No file yet, or one that is not readable as JSON: the next write replaces it.
		return {};
	}
}

/** The preferences this project understands, each one only when it is the type it should be. */
export function readUiPrefs(dir: string): UiPrefs {
	const doc = readRaw(dir);
	const prefs: UiPrefs = {};
	if (typeof doc.panel === "boolean") prefs.panel = doc.panel;
	if (typeof doc.model === "string") prefs.model = doc.model;
	if (typeof doc.thinking === "string") prefs.thinking = doc.thinking;
	return prefs;
}

/**
 * Whether the panel shows. Only an explicit `false` hides it: a fresh install, a deleted file and a
 * file that no longer parses all mean "never turned off", and the panel is what `/cron` advertises.
 */
export function panelEnabled(prefs: UiPrefs): boolean {
	return prefs.panel !== false;
}

/**
 * Remember one preference, keeping every other key in the file.
 *
 * There is no lock around the read and the write. The writer outside TypeScript cannot take one, so
 * a lock here would serialise this module against itself and promise a mutual exclusion it does not
 * have; what it would buy is a window of a few microseconds between two writes a person makes by
 * hand, minutes apart. The atomic write is the part that matters — a reader never sees half a file.
 */
export function writeUiPref<K extends keyof UiPrefs>(dir: string, key: K, value: NonNullable<UiPrefs[K]>): void {
	const doc = readRaw(dir);
	if (doc[key] === value) return;
	doc[key] = value;
	try {
		writeFileAtomic(fileIn(dir), `${JSON.stringify(doc, null, 2)}\n`);
	} catch {
		// A preference is not worth failing the command that set it: the panel still changes for this
		// session, it just will not be that way in the next one.
	}
}
