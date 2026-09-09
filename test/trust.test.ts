import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { canonicalDir, isExactlyTrusted } from "../src/trust.ts";

test("trusting a project does not trust everything under it", () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-trust-"));
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-proj-"));
	const vendored = path.join(root, "node_modules", "evil");
	fs.mkdirSync(vendored, { recursive: true });
	const store = new ProjectTrustStore(agentDir);
	store.set(root, true);

	assert.equal(store.get(vendored), true, "pi's own lookup inherits trust from an ancestor");
	assert.equal(isExactlyTrusted(agentDir, root), true, "the trusted project itself is trusted");
	assert.equal(isExactlyTrusted(agentDir, vendored), false, "a directory under it is not: a job's cwd can be model-chosen");
	assert.equal(isExactlyTrusted(agentDir, path.join(root, "src")), false);
	assert.equal(isExactlyTrusted(agentDir, ""), false);
	assert.equal(isExactlyTrusted(agentDir, fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-other-"))), false);

	// A path that reaches the same directory another way is still that directory.
	const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-link-")), "linked");
	fs.symlinkSync(root, link);
	assert.equal(isExactlyTrusted(agentDir, link), true);
	assert.equal(canonicalDir(link), canonicalDir(root));

	store.set(root, false);
	assert.equal(isExactlyTrusted(agentDir, root), false, "an explicit refusal is not trust");
});
