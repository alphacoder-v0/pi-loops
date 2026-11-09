// Type-check src/ against the installed pi (its bundled type definitions), no local deps. pi is found
// the way the runtime finds it (src/pi-resolver.mjs): PI_LOOPS_PI_PACKAGE, a managed install, global.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { piPackage } from "../src/pi-resolver.mjs";

let pkg;
try {
	pkg = piPackage();
} catch (err) {
	console.error(`${err?.message ?? err}; or npm i -g @earendil-works/pi-coding-agent`);
	process.exit(1);
}
// pi's dependencies: under pi (npm's global layout), else beside it (a managed install hoists them).
const hoisted = path.dirname(path.dirname(fs.realpathSync(pkg)));
const nm = fs.existsSync(path.join(pkg, "node_modules")) || path.basename(hoisted) !== "node_modules" ? path.join(pkg, "node_modules") : hoisted;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-tsc-"));
const tsconfig = {
	compilerOptions: {
		target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true,
		skipLibCheck: true, allowImportingTsExtensions: true, types: ["node"], typeRoots: [path.join(nm, "@types")], baseUrl: ".",
		paths: {
			"@earendil-works/pi-coding-agent": [path.join(pkg, "dist/index.d.ts")],
			"@earendil-works/pi-tui": [path.join(nm, "@earendil-works/pi-tui/dist/index.d.ts")],
			"@earendil-works/pi-ai": [path.join(nm, "@earendil-works/pi-ai/dist/index.d.ts")],
			"@earendil-works/pi-agent-core": [path.join(nm, "@earendil-works/pi-agent-core/dist/index.d.ts")],
			typebox: [path.join(nm, "typebox/build/index.d.mts")],
		},
	},
	include: [path.join(process.cwd(), "src/**/*.ts")],
};
fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
const r = spawnSync("npx", ["-y", "-p", "typescript@5", "tsc", "-p", path.join(dir, "tsconfig.json")], { stdio: "inherit" });
fs.rmSync(dir, { recursive: true, force: true });
process.exit(r.status ?? 1);
