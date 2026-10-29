import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { realpathish } from "../src/paths.ts";
import { withinProject } from "../src/paths.ts";
import { isInsideDir } from "../src/sdk-runner.ts";

test("project identity is a realpath and includes subdirectories", () => {
	const dir = fs.realpathSync(tmp("pi-loops-paths-"));
	const proj = path.join(dir, "proj");
	fs.mkdirSync(path.join(proj, "src"), { recursive: true });
	fs.symlinkSync(proj, path.join(dir, "link"));
	assert.equal(withinProject(proj, path.join(proj, "src")), true, "a subdirectory is the same project");
	assert.equal(withinProject(proj, path.join(dir, "link")), true, "so is a symlink to it");
	assert.equal(withinProject(proj, path.join(dir, "link", "src")), true);
	assert.equal(withinProject(path.join(proj, "src"), proj), false, "but the parent is not inside the project");
	assert.equal(withinProject(proj, path.join(dir, "other")), false);
});

test("a path that does not exist yet still resolves under its symlinked parent", () => {
	const real = fs.realpathSync(tmp("pi-loops-paths-"));
	const project = path.join(real, "project");
	fs.mkdirSync(project);
	const link = path.join(real, "link");
	fs.symlinkSync(project, link);

	const unborn = path.join(link, "worktrees", "not-created-yet");
	assert.equal(realpathish(unborn), path.join(project, "worktrees", "not-created-yet"));
	assert.equal(realpathish(link), project, "and an existing path is resolved as before");

	// The two callers used to disagree about exactly this pair, one of them answering "a different
	// project" for a directory the other placed inside it.
	assert.equal(withinProject(project, unborn), true);
	assert.equal(isInsideDir(project, unborn), true);
	assert.equal(withinProject(project, path.join(real, "elsewhere", "x")), false, "a sibling is still outside");
});
