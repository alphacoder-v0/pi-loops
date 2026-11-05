/**
 * How big a conversation this process parses: the page server reads held conversations itself, and
 * the page child asks its pi for every entry. Both run in the process every page and loop shares,
 * so both ask here first. A module of its own because src/page-server.ts imports
 * src/page-children.ts, and both need it.
 */
import * as fs from "node:fs";

/** The largest session file the page reads itself; a bigger one is answered by the page's pi. The read is synchronous, in the process every page shares. */
export const HELD_READ_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Whether this process asks pi for a conversation's entries (run cards, the panel's snapshot, find,
 * undo, the model to resume on): pi answers with every entry, compacted and abandoned branches too,
 * and this process parses them, so not for a session file over `HELD_READ_MAX_BYTES`. A file pi has
 * not named yet is not read: its size is unknown. Nor is a file that is not on disk once it has been
 * (`everOnDisk`), since it may have moved at any size; one pi has not written yet is read, since pi
 * writes it at the first message and what it holds until then is small.
 */
export function entriesReadable(file: string | undefined, everOnDisk = true): boolean {
	if (!file) return false; // not known yet: do not parse what we cannot size
	try {
		return fs.statSync(file).size <= HELD_READ_MAX_BYTES;
	} catch (err: any) {
		return err?.code === "ENOENT" && !everOnDisk; // not written yet is small; gone, or not ours to stat, is unknown
	}
}
