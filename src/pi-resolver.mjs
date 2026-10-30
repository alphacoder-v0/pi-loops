// Where pi's packages are, for everything that runs outside pi's own loader: the `node --import` hook
// for the headless host (src/host-entry.mjs) and the tests, and the jiti aliases in src/ts-entry.mjs.
// PI_LOOPS_PI_PACKAGE names pi's package dir; else the one beside this Node, else the global install.
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

let pkg;
/** pi's package directory: what was told, else the one beside this Node, else the global install. */
export function piPackage() {
	if (pkg) return pkg;
	const told = process.env.PI_LOOPS_PI_PACKAGE;
	if (told && fs.existsSync(path.join(told, "package.json"))) return (pkg = told);
	const guess = path.join(path.dirname(path.dirname(process.execPath)), "lib", "node_modules", "@earendil-works", "pi-coding-agent");
	if (fs.existsSync(path.join(guess, "package.json"))) return (pkg = guess);
	return (pkg = path.join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@earendil-works", "pi-coding-agent"));
}
// Relative to pi's package directory.
const MAP = {
	"@earendil-works/pi-coding-agent": "dist/index.js",
	"@earendil-works/pi-ai": "node_modules/@earendil-works/pi-ai/dist/index.js",
	"@earendil-works/pi-agent-core": "node_modules/@earendil-works/pi-agent-core/dist/index.js",
	"@earendil-works/pi-tui": "node_modules/@earendil-works/pi-tui/dist/index.js",
	typebox: "node_modules/typebox/build/index.mjs",
};
/**
 * Where one of pi's packages is: nested under pi's own node_modules (npm's layout for a global pi),
 * else beside pi (a hoisted install, or pnpm's store, where pi's real directory sits among its
 * dependencies). Only the nested place was looked at, and anywhere else the background process —
 * which every loop now runs in — could not start.
 */
function piFile(rel) {
	const dir = piPackage();
	const nested = path.join(dir, rel);
	if (!rel.startsWith("node_modules/") || fs.existsSync(nested)) return nested;
	let real = dir;
	try {
		real = fs.realpathSync(dir);
	} catch {
		/* not there: the nested path is as good an answer */
	}
	// Only where Node itself would look: the node_modules that holds pi's scope directory.
	const root = path.dirname(path.dirname(real));
	if (path.basename(root) !== "node_modules") return nested;
	const beside = path.join(root, rel.slice("node_modules/".length));
	return fs.existsSync(beside) ? beside : nested;
}
/**
 * The same map as an absolute-path table, which is the shape jiti's `alias` option wants — for when
 * jiti loads this package's TypeScript instead of Node (src/ts-entry.mjs). It is derived from `MAP`
 * rather than written twice so the two routes cannot resolve pi differently. Entries whose file is
 * missing are dropped, exactly as the hook below declines to short-circuit for them.
 */
export function piAliases() {
	const out = {};
	for (const [specifier, rel] of Object.entries(MAP)) {
		const file = piFile(rel);
		if (fs.existsSync(file)) out[specifier] = file;
	}
	return out;
}
export async function resolve(specifier, context, next) {
	const rel = MAP[specifier];
	if (rel) {
		const file = piFile(rel);
		if (fs.existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true };
	}
	return next(specifier, context);
}
