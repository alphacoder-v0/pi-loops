import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { realpathish } from "../src/paths.ts";
import { withinProject } from "../src/presence.ts";
import { isInsideDir } from "../src/sdk-runner.ts";

test("a path that does not exist yet still resolves under its symlinked parent", () => {
	const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-paths-")));
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
