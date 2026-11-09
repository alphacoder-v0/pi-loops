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

/** A pi package directory: only its package.json is looked at. */
function fakePackage(dir: string): string {
	touch(path.join(dir, "package.json"));
	return dir;
}

/** pi 1.5's managed install under `agentDir`: the launcher in bin/, the version file, the release. */
function managedInstall(agentDir: string, version = "1.5.0"): string {
	touch(path.join(agentDir, "bin", "pi"));
	const release = fakePackage(path.join(agentDir, "install", "releases", version, "node_modules", "@earendil-works", "pi-coding-agent"));
	fs.writeFileSync(path.join(agentDir, "install", "current-version"), `${version}\n`);
	return release;
}

/** `~/.local/bin/pi`, the link pi's installer puts on PATH. */
function linkOnPath(agentDir: string): string {
	const bin = path.join(tmp("pi-loops-resolver-path-"), "bin");
	fs.mkdirSync(bin, { recursive: true });
	fs.symlinkSync(path.join(agentDir, "bin", "pi"), path.join(bin, "pi"));
	return bin;
}

test("pi's managed install is found from the pi on PATH, then from the agent directory, before the global guesses", async () => {
	const { findPiPackage } = (await import(resolver)) as { findPiPackage: (o: { env: NodeJS.ProcessEnv; execPath: string; npmRoot: () => string }) => { dir?: string; looked: string[] } };
	const home = tmp("pi-loops-resolver-home-");
	const noNode = path.join(tmp("pi-loops-resolver-node-"), "bin", "node");
	const global = tmp("pi-loops-resolver-npm-");
	const globalPi = fakePackage(path.join(global, "@earendil-works", "pi-coding-agent"));
	const find = (env: NodeJS.ProcessEnv, npmRoot: () => string = () => global) => findPiPackage({ env: { HOME: home, ...env }, execPath: noNode, npmRoot });

	// The pi on PATH links into a managed install: that release's package, not the global one.
	const onPath = path.join(tmp("pi-loops-resolver-agent-"), "agent");
	const release = managedInstall(onPath);
	assert.equal(find({ PATH: linkOnPath(onPath) }).dir, release, "the pi on PATH names its install");

	// PI_LOOPS_PI_PACKAGE still wins over everything.
	const told = fakePackage(path.join(tmp("pi-loops-resolver-told-"), "pi"));
	assert.equal(find({ PATH: linkOnPath(onPath), PI_LOOPS_PI_PACKAGE: told }).dir, told);

	// A current-version naming a release that is not there falls through to the agent directory's.
	const agent = path.join(home, "agent");
	const agentRelease = managedInstall(agent, "1.4.0");
	fs.writeFileSync(path.join(onPath, "install", "current-version"), "9.9.9\n");
	assert.equal(find({ PATH: linkOnPath(onPath), PI_CODING_AGENT_DIR: agent }).dir, agentRelease, "a broken version file is passed over");
	fs.writeFileSync(path.join(onPath, "install", "current-version"), "../../etc\n");
	assert.equal(find({ PATH: linkOnPath(onPath), PI_CODING_AGENT_DIR: agent }).dir, agentRelease, "and so is one that is not a version");
	// ~/.pi/agent when PI_CODING_AGENT_DIR is not set.
	const dotPi = managedInstall(path.join(home, ".pi", "agent"));
	assert.equal(find({ PATH: "" }).dir, dotPi);
	fs.rmSync(path.join(home, ".pi"), { recursive: true });

	// No managed install anywhere: the global layout, as before.
	assert.equal(find({ PATH: "", PI_CODING_AGENT_DIR: path.join(home, "none") }).dir, globalPi, "npm root -g");

	// Nothing anywhere, and npm missing: no throw, and every place looked at is named.
	const none = find({ PATH: linkOnPath(onPath), PI_CODING_AGENT_DIR: path.join(home, "none") }, () => {
		throw new Error("npm: not found");
	});
	assert.equal(none.dir, undefined);
	assert.equal(none.looked.length, 4, none.looked.join("\n"));
	assert.match(none.looked.join("\n"), /the pi on PATH/);
	assert.match(none.looked.join("\n"), /npm root -g \(npm did not answer\)/);
});

test("with no pi anywhere, piPackage says where it looked in one error", () => {
	const home = tmp("pi-loops-resolver-home-");
	const run = spawnSync(process.execPath, ["--input-type=module", "-e", `const { piPackage } = await import(${JSON.stringify(resolver)}); try { piPackage(); } catch (e) { console.log(e.message); }`], { encoding: "utf8", env: { HOME: home, PATH: "" } });
	assert.equal(run.status, 0, run.stderr);
	assert.match(run.stdout, /^no pi package found; looked in .*\.pi\/agent\/install.*npm root -g.*Set PI_LOOPS_PI_PACKAGE/);
});
