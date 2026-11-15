/**
 * The conversion of a loops directory that an older version wrote. This is the only module that
 * names what older versions kept and this one does not. Every process runs it when it starts, and
 * running it again changes nothing.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Private files of older versions that nothing reads now: the next runs the scheduler wrote for
 * the page, and the leader file and the presence directory of pi-loops 0.22 windows.
 */
export const RETIRED_FILES: readonly string[] = ["next-runs.json", "scheduler.json", "presence"];

/**
 * Remove the retired files from `dir`, and return the names removed. Only those names, directly in
 * `dir`; a link is removed and what it points to stays. A file that cannot be removed is reported
 * to `log` and left: it is unread, so it is no reason to stop a start.
 */
export function convertStores(dir: string, log: (line: string) => void = () => {}): string[] {
	const removed: string[] = [];
	for (const name of RETIRED_FILES) {
		const file = path.join(dir, name);
		if (!fs.lstatSync(file, { throwIfNoEntry: false })) continue;
		try {
			fs.rmSync(file, { recursive: true, force: true });
			removed.push(name);
		} catch (err: any) {
			log(`could not remove ${name}, which an older version left: ${err?.message ?? err}`);
		}
	}
	return removed;
}
