// Where pi's packages are, for everything that runs outside pi's own loader: the `node --import` hook
// for the headless host (src/host-entry.mjs) and the tests, and the jiti aliases in src/ts-entry.mjs.
// PI_LOOPS_PI_PACKAGE names pi's package dir; else pi's managed install (the `pi` on PATH, then the
// agent directory's); else the one beside this Node; else the global npm install.
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const PI_SCOPE = path.join("@earendil-works", "pi-coding-agent");
const hasPi = (dir) => fs.existsSync(path.join(dir, "package.json"));

/**
 * pi's managed install under `agentDir`: `install/current-version` names a release, and the release
 * holds pi under `install/releases/<version>/node_modules`. Undefined when the version file is not
 * there or not a plain version, or when that release has no pi in it.
 */
function managedPi(agentDir) {
	let version;
	try {
		version = fs.readFileSync(path.join(agentDir, "install", "current-version"), "utf8").trim();
	} catch {
		return undefined; // not a managed install
	}
	// The same check pi's own launcher (`<agentDir>/bin/pi`) makes before it trusts the file.
	if (!/^[0-9A-Za-z._+-]+$/.test(version) || version === "." || version === "..") return undefined;
	const dir = path.join(agentDir, "install", "releases", version, "node_modules", PI_SCOPE);
	return hasPi(dir) ? dir : undefined;
}

/** The first `pi` on `pathEnv`, with every link followed; undefined when there is none. */
function piOnPath(pathEnv) {
	for (const entry of (pathEnv ?? "").split(path.delimiter)) {
		if (!entry) continue;
		try {
			const real = fs.realpathSync(path.join(entry, "pi"));
			if (fs.statSync(real).isFile()) return real;
		} catch {
			/* no pi in this directory */
		}
	}
	return undefined;
}

/**
 * Where pi's package is, and every place looked at on the way. Pure apart from reading the disk:
 * the environment, this Node's path and the `npm root -g` question are passed in.
 */
export function findPiPackage({ env = process.env, execPath = process.execPath, npmRoot = () => execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() } = {}) {
	const looked = [];
	const told = env.PI_LOOPS_PI_PACKAGE;
	if (told) {
		if (hasPi(told)) return { dir: told, looked };
		looked.push(`${told} (PI_LOOPS_PI_PACKAGE)`);
	}
	// A managed install: `pi` on PATH links to `<agentDir>/bin/pi`, a launcher beside `install/`.
	const onPath = piOnPath(env.PATH);
	if (onPath && path.basename(onPath) === "pi" && path.basename(path.dirname(onPath)) === "bin") {
		const root = path.dirname(path.dirname(onPath));
		const found = managedPi(root);
		if (found) return { dir: found, looked };
		looked.push(`${path.join(root, "install")} (the pi on PATH, ${onPath})`);
	}
	const home = env.HOME || os.homedir();
	const agentDir = env.PI_CODING_AGENT_DIR ? env.PI_CODING_AGENT_DIR.replace(/^~(?=$|\/)/, home) : path.join(home, ".pi", "agent");
	const managed = managedPi(agentDir);
	if (managed) return { dir: managed, looked };
	looked.push(path.join(agentDir, "install"));
	const beside = path.join(path.dirname(path.dirname(execPath)), "lib", "node_modules", PI_SCOPE);
	if (hasPi(beside)) return { dir: beside, looked };
	looked.push(beside);
	// The last resort, and the one that can fail on its own: no npm on PATH.
	try {
		const global = path.join(npmRoot(), PI_SCOPE);
		if (hasPi(global)) return { dir: global, looked };
		looked.push(`${global} (npm root -g)`);
	} catch {
		looked.push("npm root -g (npm did not answer)");
	}
	return { dir: undefined, looked };
}

let pkg;
/** pi's package directory (see `findPiPackage`), or an error that names every place looked at. */
export function piPackage() {
	if (pkg) return pkg;
	const { dir, looked } = findPiPackage();
	if (!dir) throw new Error(`no pi package found; looked in ${looked.join(", ")}. Set PI_LOOPS_PI_PACKAGE to the directory of your @earendil-works/pi-coding-agent install`);
	return (pkg = dir);
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
