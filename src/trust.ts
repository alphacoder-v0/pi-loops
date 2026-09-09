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

/** pi's own normalisation: resolved, then through symlinks where the path exists. */
export function canonicalDir(dir: string): string {
	const resolved = path.resolve(dir);
	try {
		return fs.realpathSync(resolved);
	} catch {
		return resolved;
	}
}

/** True only when the user trusted this very directory, not an ancestor of it. */
export function isExactlyTrusted(agentDir: string, cwd: string): boolean {
	if (!cwd) return false;
	const entry = new ProjectTrustStore(agentDir).getEntry(cwd);
	if (!entry || entry.decision !== true) return false;
	return canonicalDir(entry.path) === canonicalDir(cwd);
}
