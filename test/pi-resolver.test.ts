import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { tmp } from "./tmp.ts";

const resolver = pathToFileURL(path.join(process.cwd(), "src", "pi-resolver.mjs")).href;

/** What `piAliases()` answers for a pi installed at `piDir`, asked in a process of its own (the answer is cached per process). */
function aliasesFor(piDir: string): Record<string, string> {
	const run = spawnSync(process.execPath, ["--input-type=module", "-e", `const { piAliases } = await import(${JSON.stringify(resolver)}); console.log(JSON.stringify(piAliases()));`], { encoding: "utf8", env: { ...process.env, PI_LOOPS_PI_PACKAGE: piDir } });
	assert.equal(run.status, 0, run.stderr);
	return JSON.parse(run.stdout);
}

/** macOS's temp directory is /var, a link to /private/var, and the resolver answers with real paths. */
const real = (file: string | undefined): string | undefined => (file === undefined ? undefined : fs.realpathSync(file));

function touch(file: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "");
}

test("pi's packages are found under pi, and beside it in a hoisted or pnpm layout", () => {
	// Only the nested place was looked at: with pi's dependencies hoisted beside it, the background
	// process — which runs every loop — could not start.
	const nested = path.join(tmp("pi-loops-resolver-"), "node_modules", "@earendil-works", "pi-coding-agent");
	touch(path.join(nested, "package.json"));
	touch(path.join(nested, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js"));
	assert.equal(real(aliasesFor(nested)["@earendil-works/pi-ai"]), real(path.join(nested, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js")));

	const root = path.join(tmp("pi-loops-resolver-"), "node_modules");
	const hoisted = path.join(root, "@earendil-works", "pi-coding-agent");
	touch(path.join(hoisted, "package.json"));
	touch(path.join(root, "@earendil-works", "pi-ai", "dist", "index.js"));
	touch(path.join(root, "typebox", "build", "index.mjs"));
	const found = aliasesFor(hoisted);
	assert.equal(real(found["@earendil-works/pi-ai"]), real(path.join(root, "@earendil-works", "pi-ai", "dist", "index.js")));
	assert.equal(real(found.typebox), real(path.join(root, "typebox", "build", "index.mjs")));
	assert.equal(found["@earendil-works/pi-tui"], undefined, "a package in neither place is left to Node");

	// A pi that is not inside a node_modules (a source checkout named by PI_LOOPS_PI_PACKAGE): Node
	// would never look two levels up from it, and neither does this.
	const loose = tmp("pi-loops-resolver-");
	const checkout = path.join(loose, "a", "pi-coding-agent");
	touch(path.join(checkout, "package.json"));
	touch(path.join(loose, "@earendil-works", "pi-ai", "dist", "index.js"));
	assert.equal(aliasesFor(checkout)["@earendil-works/pi-ai"], undefined, "a file planted beside an arbitrary directory is not taken");

		// pnpm: pi is a link into the store, where its dependencies sit beside its real directory.
	const store = path.join(tmp("pi-loops-resolver-"), ".pnpm", "pi@1", "node_modules");
	touch(path.join(store, "@earendil-works", "pi-coding-agent", "package.json"));
	touch(path.join(store, "@earendil-works", "pi-ai", "dist", "index.js"));
	const link = path.join(tmp("pi-loops-resolver-"), "pi-coding-agent");
	fs.symlinkSync(path.join(store, "@earendil-works", "pi-coding-agent"), link);
	assert.equal(real(aliasesFor(link)["@earendil-works/pi-ai"]), real(path.join(store, "@earendil-works", "pi-ai", "dist", "index.js")));
});
