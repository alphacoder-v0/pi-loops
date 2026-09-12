/**
 * Loading this package's TypeScript from outside pi.
 *
 * `pi-loops` (src/cli-entry.mjs) and the headless host (src/host-entry.mjs) are plain Node
 * processes — no pi around them, and by this project's rules no build step — so each has to import a
 * `.ts` file directly. Node strips the types itself, except under `node_modules`, where it refuses
 * outright (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). That is exactly where
 * `pi install npm:@alphacoder-v0/pi-loops` puts this package, so the npm route needs a second way in
 * while the checkout and `git:` routes keep the first one.
 *
 * The second way is jiti, which ships inside pi's own install and is what pi already uses to load
 * extensions. pi is a peer dependency, so borrowing its copy installs nothing: "no runtime
 * dependencies" stays true.
 *
 * Which way is chosen is decided *before* the import, from the path, rather than by catching the
 * stripping error and retrying. Two reasons. A half-executed module graph is not a thing to retry —
 * side effects in whatever did load stay done. And when jiti is missing too, deciding up front is
 * what makes the failure honest: the person is told which pi was looked for and where, instead of a
 * stack trace about type stripping that names the wrong problem.
 */
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { piAliases, piPackage } from "./pi-resolver.mjs";

/**
 * Can Node strip the types in this file itself? It refuses for anything with a `node_modules`
 * directory anywhere above it, which is the test this mirrors.
 */
export function needsJiti(entryPath) {
	return path.resolve(entryPath).split(path.sep).includes("node_modules");
}

/** jiti's entry point inside pi's install — or an error that says where pi was looked for. */
function jitiEntry() {
	let dir;
	try {
		dir = piPackage();
	} catch (err) {
		// `npm root -g` is the last resort and it can fail on its own (no npm on PATH).
		throw new Error(`could not work out where pi is installed (${err?.message ?? err}); set PI_LOOPS_PI_PACKAGE to its package directory`);
	}
	try {
		return createRequire(path.join(dir, "package.json")).resolve("jiti");
	} catch {
		// Node's own resolution error names jiti and not the thing a person can fix, so say it here.
		const missing = fs.existsSync(path.join(dir, "package.json")) ? "" : " — and no pi package is there at all";
		throw new Error(
			`this copy is installed under node_modules, where Node will not strip TypeScript, so it needs the jiti that ships inside pi${missing}.\n` +
				`  pi package: ${dir}\n` +
				`  looked for: ${path.join(dir, "node_modules", "jiti")}\n` +
				`  set PI_LOOPS_PI_PACKAGE to the directory of your @earendil-works/pi-coding-agent install`,
		);
	}
}

/**
 * Import a `.ts` file next to an `.mjs` entry point, whichever way this install allows. `alias`
 * comes from the resolver hook's map so jiti and the hook agree on which pi they mean.
 */
export async function importTs(parentUrl, specifier) {
	const entry = fileURLToPath(new URL(specifier, parentUrl));
	if (!needsJiti(entry)) return await import(pathToFileURL(entry).href);
	const { createJiti } = await import(pathToFileURL(jitiEntry()).href);
	return await createJiti(parentUrl, { moduleCache: false, alias: piAliases() }).import(entry);
}
