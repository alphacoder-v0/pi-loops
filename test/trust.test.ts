import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { canonicalDir, isExactlyTrusted, sessionTrustCovers } from "../src/trust.ts";

test("trusting a project does not trust everything under it", () => {
	const agentDir = tmp("pi-loops-trust-");
	const root = tmp("pi-loops-proj-");
	const vendored = path.join(root, "node_modules", "evil");
	fs.mkdirSync(vendored, { recursive: true });
	const store = new ProjectTrustStore(agentDir);
	store.set(root, true);

	assert.equal(store.get(vendored), true, "pi's own lookup inherits trust from an ancestor");
	assert.equal(isExactlyTrusted(agentDir, root), true, "the trusted project itself is trusted");
	assert.equal(isExactlyTrusted(agentDir, vendored), false, "a directory under it is not: a job's cwd can be model-chosen");
	assert.equal(isExactlyTrusted(agentDir, path.join(root, "src")), false);
	assert.equal(isExactlyTrusted(agentDir, ""), false);
	assert.equal(isExactlyTrusted(agentDir, tmp("pi-loops-other-")), false);

	// A path that reaches the same directory another way is still that directory.
	const link = path.join(tmp("pi-loops-link-"), "linked");
	fs.symlinkSync(root, link);
	assert.equal(isExactlyTrusted(agentDir, link), true);
	assert.equal(canonicalDir(link), canonicalDir(root));

	store.set(root, false);
	assert.equal(isExactlyTrusted(agentDir, root), false, "an explicit refusal is not trust");
});

test("the session's own trust reaches into its project, never out of it", () => {
	// The trust site asked `sameProject`, which is symmetric and so said yes to an *ancestor*:
	// `cron_create {cwd: ".."}` from a sub-agent, and that directory's `.pi/extensions` were loaded
	// unattended. Scoping for lists is a different question and keeps the symmetric answer.
	const root = fs.realpathSync(tmp("pi-loops-cover-"));
	const project = path.join(root, "repo");
	const sub = path.join(project, "src", "deep");
	const vendored = path.join(project, "node_modules", "x");
	const sibling = path.join(root, "other");
	fs.mkdirSync(sub, { recursive: true });
	fs.mkdirSync(vendored, { recursive: true });
	fs.mkdirSync(sibling, { recursive: true });

	assert.equal(sessionTrustCovers(project, project), true, "the project this session is open in");
	assert.equal(sessionTrustCovers(project, sub), true, "and a directory under it");
	assert.equal(sessionTrustCovers(project, vendored), true, "including a vendored one: the user opened this project");
	assert.equal(sessionTrustCovers(project, root), false, "never the parent");
	assert.equal(sessionTrustCovers(project, path.join(project, "..")), false, "however it is spelled");
	assert.equal(sessionTrustCovers(project, sibling), false, "nor a sibling");
	assert.equal(sessionTrustCovers(project, ""), false);
	assert.equal(sessionTrustCovers("", project), false, "a session with no project of its own trusts nothing");
	assert.equal(sessionTrustCovers(os.homedir(), path.join(os.homedir(), "anything")), false, "$HOME is not a project");

	// A path that reaches a directory inside the project through a symlink is inside the project.
	const link = path.join(fs.realpathSync(tmp("pi-loops-cover-link-")), "linked");
	fs.symlinkSync(sub, link);
	assert.equal(sessionTrustCovers(project, link), true);
	const outward = path.join(project, "escape");
	fs.symlinkSync(sibling, outward);
	assert.equal(sessionTrustCovers(project, outward), false, "and a link pointing out of it leads out of it");
});
