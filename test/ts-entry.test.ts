import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { needsJiti } from "../src/ts-entry.mjs";


/** A directory shaped like pi's install: what the resolver's map is relative to. */
function fakePi(): string {
	const dir = tmp("pi-loops-tsentry-");
	fs.writeFileSync(path.join(dir, "package.json"), `{ "name": "@earendil-works/pi-coding-agent" }`);
	for (const rel of ["dist/index.js", "node_modules/@earendil-works/pi-ai/dist/index.js", "node_modules/@earendil-works/pi-agent-core/dist/index.js", "node_modules/@earendil-works/pi-tui/dist/index.js", "node_modules/typebox/build/index.mjs"]) {
		fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), "export {};\n");
	}
	return dir;
}

/** The resolver remembers pi's directory after the first answer, so each case gets its own copy. */
async function resolverFor(piPackage: string, tag: string) {
	process.env.PI_LOOPS_PI_PACKAGE = piPackage;
	// A query string is the only way to ask Node for a second instance of the same module.
	return (await import(`../src/pi-resolver.mjs?${tag}`)) as {
		piPackage: () => string;
		piAliases: () => Record<string, string>;
		resolve: (specifier: string, context: unknown, next: (s: string, c: unknown) => never) => Promise<{ url: string }>;
	};
}

test("only a copy with node_modules above it needs jiti to load its own TypeScript", () => {
	assert.equal(needsJiti("/home/me/.pi/agent/npm/node_modules/@alphacoder-v0/pi-loops/src/cli.ts"), true, "the npm route: Node refuses to strip types there");
	assert.equal(needsJiti("/usr/lib/node_modules/@alphacoder-v0/pi-loops/src/host.ts"), true, "a global install is the same place");
	assert.equal(needsJiti("/home/me/.pi/agent/git/github.com/alphacoder-v0/pi-loops/src/cli.ts"), false, "the git: route is a plain checkout");
	assert.equal(needsJiti("/home/me/code/piz/src/cli.ts"), false, "so is a local checkout");
	assert.equal(needsJiti("/home/me/node_modules_elsewhere/pi-loops/src/cli.ts"), false, "a directory that merely starts with the name is not it");
	assert.equal(needsJiti("node_modules/@alphacoder-v0/pi-loops/src/cli.ts"), true, "relative paths are resolved before the question is asked");
});

test("the jiti aliases and the loader hook point at the same files, so the two routes cannot drift", async () => {
	const pi = fakePi();
	const { piAliases, resolve } = await resolverFor(pi, "aliases");
	const aliases = piAliases();
	assert.deepEqual(Object.keys(aliases).sort(), ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]);
	for (const [specifier, file] of Object.entries(aliases)) {
		assert.equal(path.relative(pi, file).startsWith(".."), false, `${specifier} resolves inside pi's package`);
		const viaHook = await resolve(specifier, {}, () => {
			throw new Error(`the hook did not resolve ${specifier} itself`);
		});
		assert.equal(viaHook.url, pathToFileURL(file).href, `${specifier}: the hook and jiti agree`);
	}
	// An alias with no file behind it would make jiti fail where the hook merely steps aside, so it
	// is dropped for the same reason the hook declines to short-circuit.
	fs.rmSync(path.join(pi, "node_modules", "typebox", "build", "index.mjs"));
	assert.equal("typebox" in piAliases(), false, "a missing file is not an alias");
});

test("pi's package directory is the one PI_LOOPS_PI_PACKAGE names, and a directory with no pi in it is not believed", async () => {
	const pi = fakePi();
	const { piPackage } = await resolverFor(pi, "told");
	assert.equal(piPackage(), pi);
	const empty = tmp("pi-loops-tsentry-");
	const { piPackage: second } = await resolverFor(empty, "untold");
	assert.notEqual(second(), empty, "nothing there, so the search falls through to the install");
});

test("the launcher runs from a copy under node_modules, where Node will not strip types", () => {
	const pkg = path.join(tmp("pi-loops-tsentry-"), "node_modules", "@alphacoder-v0", "pi-loops");
	fs.mkdirSync(pkg, { recursive: true });
	fs.cpSync(path.join(process.cwd(), "src"), path.join(pkg, "src"), { recursive: true });
	fs.copyFileSync(path.join(process.cwd(), "package.json"), path.join(pkg, "package.json"));
	// This is `pi install npm:@alphacoder-v0/pi-loops` in miniature: the tarball's own layout is the
	// same directory under the same name, and it used to die on the first import.
	const r = spawnSync(process.execPath, [path.join(pkg, "src", "cli-entry.mjs"), "--help"], { encoding: "utf8", env: { ...process.env, PI_LOOPS_PI_PACKAGE: "" } });
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /^pi-loops \[--web \| --tui\]/, "the usage, not a type-stripping error");
	assert.doesNotMatch(r.stderr, /TYPE_STRIPPING/);
});
