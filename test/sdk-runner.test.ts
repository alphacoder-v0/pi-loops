import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collect, isInsideDir, subSessionResources } from "../src/sdk-runner.ts";

const flags = { extensionPaths: [], skillPaths: [], promptTemplatePaths: [], appendSystemPrompt: [], noSkills: false, noExtensions: false, noContextFiles: false, noPromptTemplates: false };

test("a sub-session loads a project's .pi/extensions only when the project is trusted", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-agent-"));
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-proj-"));
	fs.mkdirSync(path.join(cwd, ".pi", "extensions"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".pi", "extensions", "marker.ts"), `export default function (pi) { pi.registerCommand("marker", { description: "m", handler: async () => {} }); }\n`);
	const own = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-own-"));
	const untrusted = subSessionResources({ cwd }, { agentDir: home, parentFlags: flags, isTrusted: () => false, ownDir: own });
	assert.equal(untrusted.trusted, false);
	assert.equal(untrusted.settingsManager.isProjectTrusted(), false, "pi's default is trusted; the runner must pin it to the decision");
	await untrusted.loader.reload();
	assert.equal(untrusted.loader.getExtensions().extensions.some((e) => e.resolvedPath.includes("marker.ts")), false, "untrusted project: no project extension is loaded");
	const trusted = subSessionResources({ cwd }, { agentDir: home, parentFlags: flags, isTrusted: () => true, ownDir: own });
	assert.equal(trusted.settingsManager.isProjectTrusted(), true);
	await trusted.loader.reload();
	assert.equal(trusted.loader.getExtensions().extensions.some((e) => e.resolvedPath.includes("marker.ts")), true, "trusted project: its extensions come along");
});

test("a sub-session never loads a second copy of pi-loops (own dir filtered, symlinks and siblings handled)", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-agent-"));
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-proj-"));
	const own = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-own-"));
	fs.mkdirSync(path.join(own, "src"));
	fs.writeFileSync(path.join(own, "src", "self.ts"), "export default function () {}\n");
	const sibling = `${own}2`;
	fs.mkdirSync(path.join(sibling, "src"), { recursive: true });
	fs.writeFileSync(path.join(sibling, "src", "other.ts"), "export default function () {}\n");
	const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-link-")), "linked");
	fs.symlinkSync(own, link);
	const r = subSessionResources({ cwd }, { agentDir: home, parentFlags: { ...flags, extensionPaths: [path.join(link, "src", "self.ts"), path.join(sibling, "src", "other.ts")] }, isTrusted: () => false, ownDir: own });
	await r.loader.reload();
	const loaded = r.loader.getExtensions().extensions.map((e) => e.resolvedPath);
	assert.equal(loaded.some((p) => p.endsWith("self.ts")), false, "our own extension reached through a symlink is filtered");
	assert.equal(loaded.some((p) => p.endsWith("other.ts")), true, "a sibling directory with the same prefix is not");
	assert.equal(isInsideDir(own, path.join(own, "src", "x.ts")), true);
	assert.equal(isInsideDir(own, path.join(sibling, "x.ts")), false);
});

test("collect(): ok, timed out, aborted, model error, no reply, thrown", () => {
	const stats = { tokens: { input: 10, output: 5 }, cost: 0.01, assistantMessages: 1 };
	const mk = (messages: unknown[], errorMessage?: string) => ({ messages, sessionId: "sid", sessionFile: "/tmp/x.jsonl", getSessionStats: () => stats, agent: { state: { errorMessage } } });
	const asst = (stopReason: string, text = "done <inbox>x</inbox>", extra: Record<string, unknown> = {}) => ({ role: "assistant", provider: "p", model: "m", stopReason, content: [{ type: "text", text }], ...extra });
	const req = { timeoutMs: 5000 } as any;
	const ok = collect(mk([{ role: "user" }, asst("stop")]), req, false);
	assert.deepEqual([ok.ok, ok.text, ok.model, ok.usage.cost, ok.usage.turns, ok.sessionFile], [true, "done <inbox>x</inbox>", "p/m", 0.01, 1, "/tmp/x.jsonl"]);
	const t = collect(mk([asst("aborted", "partial")]), req, true);
	assert.deepEqual([t.ok, t.timedOut, t.errorMessage], [false, true, "timed out after 5s"]);
	const ctrl = new AbortController();
	ctrl.abort();
	const a = collect(mk([asst("aborted")]), { ...req, signal: ctrl.signal }, false);
	assert.deepEqual([a.ok, a.errorMessage], [false, "aborted"]);
	const e = collect(mk([asst("error", "", { errorMessage: "rate limited" })]), req, false);
	assert.deepEqual([e.ok, e.errorMessage, e.stopReason], [false, "rate limited", "error"]);
	const n = collect(mk([{ role: "user" }]), req, false);
	assert.deepEqual([n.ok, n.errorMessage], [false, "the sub-agent produced no reply"]);
	const th = collect(mk([asst("stop")]), req, false, "boom");
	assert.deepEqual([th.ok, th.errorMessage], [false, "boom"]);
});
