import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PI_LOOPS_VERSION } from "../src/version.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the reported version is the package's own, never the silent fallback", () => {
	const declared = String(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version);
	assert.equal(PI_LOOPS_VERSION, declared);
	assert.notEqual(PI_LOOPS_VERSION, "0.0.0", "0.0.0 means package.json was not found at all");
});

test("a checkout under a path with a space still reports its version", async () => {
	// The percent-encoding of `new URL(...).pathname` is invisible until the path has a space or a
	// `#` in it; then the read fails and every version pi-loops reports becomes 0.0.0.
	const dir = tmp("pi loops #version-");
	fs.mkdirSync(path.join(dir, "src"));
	fs.copyFileSync(path.join(root, "src", "version.ts"), path.join(dir, "src", "version.ts"));
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "pi-loops", type: "module", version: "9.8.7" }));
	const { PI_LOOPS_VERSION: copied } = await import(pathToFileURL(path.join(dir, "src", "version.ts")).href);
	assert.equal(copied, "9.8.7");
});
