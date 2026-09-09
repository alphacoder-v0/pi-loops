// Resolve pi's packages (bare specifiers) outside pi's own loader: for `node --import` of the headless
// host (src/host.ts) and for tests. PI_LOOPS_PI_PACKAGE names pi's package dir; else the global install.
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

let pkg;
function piPackage() {
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
export async function resolve(specifier, context, next) {
	const rel = MAP[specifier];
	if (rel) {
		const file = path.join(piPackage(), rel);
		if (fs.existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true };
	}
	return next(specifier, context);
}
