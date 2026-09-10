import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { budgetStopReason, collect, createInFlightCosts, createInProcessRunner, disposeSubSession, isInsideDir, resolveRunModel, sharedSubSessionResources, subSessionResources, subSessionTools, unwrapModelRuntime } from "../src/sdk-runner.ts";
import { GUARD_PATH, subagentGuardExtension } from "../src/subagent-guard.ts";

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
	// A path that does not exist yet, under a directory reached through a symlink. This is not a
	// contrivance: it is every path on macOS, where /var is a link to /private/var and so anything
	// under os.tmpdir() has a symlinked ancestor — and it is why CI was failing there while the
	// same tests passed on Linux. Resolving only whole paths answers "outside" for a file that is
	// plainly inside, which in the caller means our own extension is not recognised as ours and a
	// sub-session loads a second copy of pi-loops.
	assert.equal(isInsideDir(link, path.join(link, "src", "not-created-yet.ts")), true, "a file that does not exist yet is still inside");
	assert.equal(isInsideDir(own, path.join(link, "src", "not-created-yet.ts")), true, "…including when the directory is the link's target");
	assert.equal(isInsideDir(link, path.join(sibling, "not-created-yet.ts")), false, "and a sibling still is not");
	assert.equal(loaded.filter((p) => p === GUARD_PATH).length, 1, "the dangerous-command gate takes its place");
});

test("the sub-session gate blocks pie's dangerous commands and lets ordinary ones through", async () => {
	const blocked: string[] = [];
	const guard = subagentGuardExtension((m) => blocked.push(m));
	const handler = guard.handlers.get("tool_call")![0];
	const call = (toolName: string, input: unknown) => handler({ type: "tool_call", toolCallId: "t1", toolName, input }, {} as any) as Promise<any>;

	const refused = await call("bash", { command: "rm -rf /" });
	assert.equal(refused.block, true);
	assert.match(refused.reason, /refused by pi-loops/);
	assert.match(refused.reason, /rm recursive\+force/);
	assert.equal(blocked.length, 1);

	assert.equal(await call("bash", { command: "cargo test" }), undefined, "ordinary work is untouched");
	assert.equal(await call("read", { path: "/etc/passwd" }), undefined, "the gate only screens shell commands");
	assert.equal((await call("powershell", { command: "shutdown -h now" })).block, true);
});

test("collect(): ok, timed out, aborted, model error, no reply, thrown", () => {
	const stats = { tokens: { input: 10, output: 5, cacheRead: 7, cacheWrite: 3 }, cost: 0.01, assistantMessages: 1 };
	const mk = (messages: unknown[], errorMessage?: string) => ({ messages, sessionId: "sid", sessionFile: "/tmp/x.jsonl", getSessionStats: () => stats, agent: { state: { errorMessage } } });
	const asst = (stopReason: string, text = "done <inbox>x</inbox>", extra: Record<string, unknown> = {}) => ({ role: "assistant", provider: "p", model: "m", stopReason, content: [{ type: "text", text }], ...extra });
	const req = { timeoutMs: 5000 } as any;
	const ok = collect(mk([{ role: "user" }, asst("stop")]), req, false);
	assert.deepEqual([ok.ok, ok.text, ok.model, ok.usage.cost, ok.usage.turns, ok.sessionFile], [true, "done <inbox>x</inbox>", "p/m", 0.01, 1, "/tmp/x.jsonl"]);
	assert.deepEqual([ok.usage.cacheRead, ok.usage.cacheWrite], [7, 3], "cached tokens are billed too; dropping them understates the run");
	const noisy = collect(mk([asst("stop")]), req, false, undefined, { warning: "model fell back", retries: 5, compactions: 2 });
	assert.deepEqual([noisy.ok, noisy.warning, noisy.retries, noisy.compactions], [true, "model fell back", 5, 2], "a run that retried five times must not look like a clean one");
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
	const b = collect(mk([asst("aborted", "half a review")]), req, false, undefined, undefined, "stopped by today's $5.00 daily budget");
	assert.deepEqual([b.ok, b.timedOut, b.errorMessage], [false, false, "stopped by today's $5.00 daily budget"], "a budget stop keeps its reason through the abort it needed, and is not a timeout");
	assert.equal(b.stopReason, "aborted", "the schedulers read that as 'not the job failing': the slot goes back and the streak is untouched");
	assert.equal(b.usage.cost, 0.01, "and is still billed for what it spent before it was stopped");
});

test("the budget is a daily total, so a run in flight is measured against it too", () => {
	assert.equal(budgetStopReason({ spent: 4.5, cap: 5 }, 0.2), undefined, "under the cap the run goes on");
	assert.equal(budgetStopReason({ spent: 99, cap: 0 }, 5), undefined, "no cap is the default");
	assert.equal(budgetStopReason(undefined, 5), undefined, "and a caller with no scheduler measures nothing");
	// The overshoot the entrance check cannot see: admitted at $4.99 of $5.00, then spending.
	const over = budgetStopReason({ spent: 4.99, cap: 5 }, 0.02);
	assert.match(over!, /stopped by today's \$5\.00 daily budget \(\$4\.99 already spent, \$0\.02 in flight\)/);
	assert.match(over!, /daily_budget_usd/, "and it names the setting to raise");
	assert.ok(budgetStopReason({ spent: 4.5, cap: 5 }, 0.5), "reaching the cap stops the run, as the dispatcher's own check does");
});

test("what the run log has not been told yet is counted: the run beside this one, and this run's own checker", () => {
	const costs = createInFlightCosts();
	const maker = costs.enter("run-1", () => 0.4);
	const beside = costs.enter("run-2", () => 0.25);
	assert.equal(costs.total("run-1"), 0.65, "two runs admitted in the same tick each see the other: neither is in the log yet");
	maker();
	const checker = costs.enter("run-1", () => 0.1);
	assert.equal(Number(costs.total("run-1").toFixed(2)), 0.75, "--verify is a second sub-agent of the same run; the maker before it was not free");
	assert.equal(Number(costs.total("run-2").toFixed(2)), 0.35, "and another run does not inherit it — that record is written with the maker's cost in it");
	checker();
	beside();
	assert.equal(costs.total("run-3"), 0, "nothing in flight, nothing to add to the log's own total");
});

test("a run inherits the parent session's tools; a job's --tools narrows them but never widens", () => {
	const parent = ["read", "grep", "find", "ls", "edit"]; // the session gave up bash with -xt
	const custom = [{ name: "hub_search" }, { name: "cron_create" }];
	const inherited = subSessionTools({}, parent, custom)!;
	assert.deepEqual(inherited.slice(0, 5), parent, "everything the session has");
	assert.ok(inherited.includes("hub_search") && inherited.includes("cron_create"), "plus this run's MCP and automation tools");
	assert.equal(inherited.includes("bash"), false, "a tool the session took away stays away");

	assert.deepEqual(subSessionTools({ tools: ["read", "grep"] }, parent, custom), ["read", "grep"], "a job's allowlist is honoured");
	assert.deepEqual(subSessionTools({ tools: ["read", "bash"] }, parent, custom), ["read"], "and cannot re-add what the parent dropped");
	assert.deepEqual(subSessionTools({ tools: ["hub_search"] }, parent, custom), ["hub_search"], "MCP tools can be named in it");
	assert.equal(subSessionTools({}, undefined, custom), undefined, "no parent session (the host): pi's own default");
});

test("a job's pinned model falls back to the session's when it stops resolving (pie pins no model at all)", () => {
	const gpt = { provider: "openai", id: "gpt-5" } as any;
	const parent = { provider: "anthropic", id: "sonnet" } as any;
	const runtime = (model: any, auth: boolean) => ({ getModel: () => model, hasConfiguredAuth: () => auth });
	assert.equal(resolveRunModel(undefined, parent, runtime(gpt, true)).model, parent, "no pin: the parent's live model, as pie reads it at fire time");
	assert.equal(resolveRunModel("openai/gpt-5", parent, runtime(gpt, true)).model, gpt, "a pin that still resolves is honoured");

	const gone = resolveRunModel("openai/gpt-5", parent, runtime(undefined, false));
	assert.equal(gone.model, parent, "provider removed or model renamed: the loop keeps running instead of failing every day forever");
	assert.match(gone.warning!, /openai\/gpt-5 is unavailable \(model no longer exists\); using anthropic\/sonnet/);

	const unauthed = resolveRunModel("openai/gpt-5", parent, runtime(gpt, false));
	assert.equal(unauthed.model, parent, "in the catalogue but with no credential: pi's own restore path checks auth too");
	assert.match(unauthed.warning!, /no auth configured/);

	const hopeless = resolveRunModel("openai/gpt-5", undefined, runtime(undefined, false));
	assert.deepEqual([hopeless.model, hopeless.warning], [undefined, undefined]);
	assert.match(hopeless.error!, /not available .* and the session has none/);
});

test("the parent's model runtime is unwrapped from whichever handle the caller has", () => {
	const runtime = { getModel: () => undefined, hasConfiguredAuth: () => false } as any;
	assert.equal(unwrapModelRuntime(runtime), runtime, "a ModelRuntime is used as-is");
	assert.equal(unwrapModelRuntime({ runtime } as any), runtime, "an extension only has ctx.modelRegistry, a facade over it");
	assert.equal(unwrapModelRuntime(undefined), undefined);
	assert.equal(unwrapModelRuntime({} as any), undefined, "and never a half-built stand-in");
});

test("a finished run never sends session_shutdown to the extension instances it shares", () => {
	const events: string[] = [];
	let disposed = 0;
	disposeSubSession({ extensionRunner: { emit: (e: { type: string }) => (events.push(e.type), Promise.resolve()) }, dispose: () => void disposed++ } as any);
	assert.deepEqual(events, [], "the parent process and the next run are still using them (a shared browser, say)");
	assert.equal(disposed, 1, "this session's own resources are still released");
});

test("the parent's extensions are loaded once per (cwd, trust) and shared by every run", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-agent-"));
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-proj-"));
	const own = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-own-"));
	const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-ext-"));
	const ext = path.join(extDir, "browser.ts");
	// Stands in for `pi -e ./browser.ts`: the factory body is what opens a browser per instance.
	fs.writeFileSync(ext, `export default function (pi) { globalThis.__piLoopsExtLoads = (globalThis.__piLoopsExtLoads ?? 0) + 1; }\n`);
	const deps = { agentDir: home, parentFlags: { ...flags, extensionPaths: [ext] }, isTrusted: () => false, ownDir: own };

	const first = await sharedSubSessionResources({ cwd }, deps);
	const second = await sharedSubSessionResources({ cwd }, deps);
	assert.equal(second.loader, first.loader, "one loaded set for this cwd, not one per run");
	assert.equal((globalThis as any).__piLoopsExtLoads, 1, "the extension factory ran once, not once per tick");
	assert.equal(first.loader.getExtensions().extensions.some((e) => e.resolvedPath === ext), true, "and the parent's -e extension is in it");

	const trusted = await sharedSubSessionResources({ cwd }, { ...deps, isTrusted: () => true });
	assert.notEqual(trusted.loader, first.loader, "trust is part of the key: a trusted loader never reaches an untrusted cwd");
	assert.deepEqual([first.settingsManager.isProjectTrusted(), trusted.settingsManager.isProjectTrusted()], [false, true]);
});

/** A runner whose setup never finishes: `deps.customTools` stands in for a stalled `git clone`. */
function stalledRunner(extra: Record<string, unknown> = {}) {
	const started: string[] = [];
	const runner = createInProcessRunner({
		agentDir: fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-agent-")),
		parentFlags: flags,
		getParentModel: () => ({ provider: "p", id: "m" }) as any,
		getParentThinking: () => undefined,
		customTools: (req) => (started.push(req.prompt), new Promise<any>(() => {})),
		isTrusted: () => false,
		ownDir: fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-own-")),
		...extra,
	});
	return { runner, started };
}

test("the deadline and abort cover the setup phase, not just the prompt", { timeout: 15_000 }, async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-proj-"));
	const { runner, started } = stalledRunner();
	const req = { cwd, prompt: "tick", timeoutMs: 50, hop: 1, kind: "loop" } as const;

	const timed = await runner({ ...req });
	assert.deepEqual([timed.ok, timed.timedOut], [false, true], "a stalled npm/git in setup must not hold the running claim past the deadline");
	assert.match(timed.errorMessage!, /timed out after 0s/);

	const ctrl = new AbortController();
	setTimeout(() => ctrl.abort(), 20).unref();
	const aborted = await runner({ ...req, prompt: "tock", timeoutMs: 600_000, signal: ctrl.signal });
	assert.deepEqual([aborted.ok, aborted.errorMessage, aborted.stopReason], [false, "aborted", "aborted"], "abortRun reaches a run that has no session yet");
	assert.deepEqual(started, ["tick", "tock"], "both runs really entered setup");
});

test("a run in flight is stopped when today's spend plus its own cost reaches the cap", { timeout: 15_000 }, async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-proj-"));
	// The dispatcher admitted this run at $4.99 of $5.00; the runs admitted with it spent the rest.
	const { runner, started } = stalledRunner({ budget: () => ({ spent: 5.2, cap: 5 }) });
	const req = { cwd, prompt: "tick", timeoutMs: 300, hop: 1, kind: "loop" } as const;

	const stopped = await runner({ ...req });
	assert.equal(stopped.ok, false);
	assert.equal(stopped.timedOut, false, "a budget stop is not a timeout, and must not read like one");
	assert.match(stopped.errorMessage!.slice(0, 80), /budget/, "/cron runs shows the first 80 characters of the reason");
	assert.match(stopped.errorMessage!, /\$5\.00 daily budget/);
	assert.equal(stopped.stopReason, "aborted", "the job did not fail: its slot goes back and the tick is still owed");
	assert.deepEqual(started, [], "and the run never even starts setting up: loading a project's packages costs seconds");

	const under = stalledRunner({ budget: () => ({ spent: 1, cap: 5 }) });
	const ran = await under.runner({ ...req, timeoutMs: 50 });
	assert.deepEqual([ran.ok, ran.timedOut], [false, true], "under the cap nothing changes");
	assert.deepEqual(under.started, ["tick"]);
});

test("a run resolves its model through the parent's runtime, so --api-key and an in-session /login reach it", { timeout: 15_000 }, async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-proj-"));
	const asked: string[] = [];
	// Only this instance knows the provider: pi applies `--api-key` to the parent's runtime, and it
	// is what `/login` mutates. A runtime the runner builds for itself would find nothing.
	const parentRuntime = {
		getModel: (provider: string, id: string) => (asked.push(`${provider}/${id}`), provider === "ci" ? ({ provider, id } as any) : undefined),
		hasConfiguredAuth: (provider: string) => provider === "ci",
	};
	const { runner } = stalledRunner({ getParentModel: () => undefined, getParentModelRuntime: () => ({ runtime: parentRuntime }) });
	const r = await runner({ cwd, prompt: "tick", model: "ci/fast", timeoutMs: 50, hop: 1, kind: "loop" });
	assert.deepEqual(asked, ["ci/fast"], "the parent's own runtime resolved the pin");
	assert.deepEqual([r.ok, r.timedOut], [false, true], "and the run reached setup with that model instead of failing on credentials");
});
