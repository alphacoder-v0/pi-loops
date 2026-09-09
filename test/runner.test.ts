import { test } from "node:test";
import assert from "node:assert/strict";
import { absolutizeFlagValue, parentRuntimeFlags } from "../src/runner.ts";

test("parentRuntimeFlags: what a sub-agent shares with the interactive pi, with paths pinned to the parent's cwd; secrets, provider, identity and tool flags stay behind", () => {
	const argv = ["node", "/x/pi", "-e", "./my-ext.ts", "--extension", "/abs/other.ts", "--append-system-prompt", "be terse", "--system-prompt", "custom", "--skill", "./s", "--no-skills", "--no-extensions", "--no-context-files", "--prompt-template", "./t", "--no-prompt-templates", "--provider", "openai", "--api-key", "sk-secret", "--model", "gpt", "--session", "abc", "--continue", "--resume", "--tools", "read", "--approve", "-e", "npm:some-pkg", "-p", "--mode", "json", "--", "hello"];
	const f = parentRuntimeFlags(argv, "/parent/project");
	assert.deepEqual(f.extensionPaths, ["/parent/project/my-ext.ts", "/abs/other.ts", "npm:some-pkg"]);
	assert.deepEqual(f.skillPaths, ["/parent/project/s"]);
	assert.deepEqual(f.promptTemplatePaths, ["/parent/project/t"]);
	assert.deepEqual(f.appendSystemPrompt, ["be terse"]);
	assert.equal(f.systemPrompt, "custom");
	assert.deepEqual([f.noSkills, f.noExtensions, f.noContextFiles, f.noPromptTemplates], [true, true, true, true]);
	assert.ok(!JSON.stringify(f).includes("sk-secret") && !JSON.stringify(f).includes("openai"), "API keys and provider never leave the parent's argv");
	assert.deepEqual(parentRuntimeFlags(["node", "pi"]).extensionPaths, []);
	assert.equal(absolutizeFlagValue("../x/ext.ts", "/a/b"), "/a/x/ext.ts");
	assert.equal(absolutizeFlagValue("git:github.com/o/r", "/a/b"), "git:github.com/o/r");
});
