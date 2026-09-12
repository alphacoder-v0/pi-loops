/**
 * One answer to "what path is this, really", for every place that compares two of them.
 *
 * Two answers agree about a path that exists and disagree about one that does not — and a path that
 * does not exist yet is the normal case here (a job's cwd created by the run itself, a project
 * directory deleted and recreated, a macOS temp directory whose /var is a link to /private/var). One
 * would then say "the same project" and the other "a different project" about the same two
 * directories.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * `p` with every symlink above it resolved, whether or not `p` itself exists: the deepest ancestor
 * that does exist is resolved and the rest re-attached. `fs.realpathSync` refuses a path that is
 * not there, and resolving nothing at all reports "outside the project" for a directory that is
 * plainly inside it.
 */
export function realpathish(p: string): string {
	if (!p) return "";
	let at = path.resolve(p);
	const tail: string[] = [];
	for (;;) {
		try {
			return path.join(fs.realpathSync(at), ...tail);
		} catch {
			const parent = path.dirname(at);
			if (parent === at) return path.resolve(p); // reached the root and nothing resolved
			tail.unshift(path.basename(at));
			at = parent;
		}
	}
}
