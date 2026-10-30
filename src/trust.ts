/**
 * Whether a directory may load project-local resources for an unattended run.
 *
 * pi's `ProjectTrustStore.get()` walks up the ancestor chain, which is right for a person opening
 * a subdirectory of a project they trusted. It is wrong here: a job's cwd can be chosen by a model
 * (`cron_create` takes one), and inherited trust would make `<trusted repo>/node_modules/anything`
 * trusted too — enough to have that directory's `.pi/mcp.toml` spawn its `command` with nobody
 * watching. An unattended run therefore requires the exact directory to have been trusted.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { withinProject } from "./paths.ts";

/** pi's own normalisation: resolved, then through symlinks where the path exists. */
export function canonicalDir(dir: string): string {
	const resolved = path.resolve(dir);
	try {
		return fs.realpathSync(resolved);
	} catch {
		return resolved;
	}
}

/**
 * pi's own saved decision for `cwd`: the nearest entry, this directory's or a parent's, so a
 * directory distrusted inside a trusted parent stays distrusted. A held turn uses it, because its
 * directory is the one the person opened pi in; a loop's may be one a model chose, and uses
 * `isExactlyTrusted`. "This session only" is never saved, so it never counts.
 */
export function isTrustedByPi(agentDir: string, cwd: string): boolean {
	if (!cwd) return false;
	return new ProjectTrustStore(agentDir).get(cwd) === true;
}

/** True only when the user trusted this very directory, not an ancestor of it. */
export function isExactlyTrusted(agentDir: string, cwd: string): boolean {
	if (!cwd) return false;
	const entry = new ProjectTrustStore(agentDir).getEntry(cwd);
	if (!entry || entry.decision !== true) return false;
	return canonicalDir(entry.path) === canonicalDir(cwd);
}

/**
 * The other route: the project the *user* opened this session in is trusted, and that reaches the
 * directories inside it — a worktree, `--cwd ./sub`, a path through a symlink.
 *
 * It does not reach out of it. The trust site asked `sameProject`, which is symmetric and blocks
 * only `/` and `$HOME`, so an *ancestor* counted as the same project: `cron_create` takes a
 * model-chosen `cwd` with no confirmation, and `cwd: ".."` would have had the parent directory's
 * `.pi/extensions` and `.pi/mcp.toml` loaded in an unattended run — the thing this module exists to
 * prevent. Scoping a *list* is a different question and keeps the symmetric answer (`sameProject` in
 * `tools.ts`): showing a job is not running one.
 */
export function sessionTrustCovers(sessionCwd: string, cwd: string): boolean {
	if (!sessionCwd || !cwd) return false;
	return withinProject(sessionCwd, cwd);
}
