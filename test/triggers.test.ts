import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DedupWindow, TriggerStore, buildPeriodicCheckTrigger, controlPlanePreflight, extractDynamicRuleIds, looksLikeFixedScheduleRequest, parseTriggerRule, renderDynamicTriggerPrompt, resolveRuleRef } from "../src/triggers.ts";

test("parseTriggerRule handles english and chinese markers like pie", () => {
	assert.deepEqual(parseTriggerRule("when ~/build.done exists, run cargo test"), { condition: "~/build.done exists", action: "cargo test" });
	assert.deepEqual(parseTriggerRule("if the PR is merged then execute notify me"), { condition: "the PR is merged", action: "notify me" });
	assert.deepEqual(parseTriggerRule("当 $HOME/helloworld 存在的时候，执行 打印它的内容"), { condition: "$HOME/helloworld 存在", action: "打印它的内容" });
	assert.deepEqual(parseTriggerRule("如果构建失败，则通知我"), { condition: "构建失败", action: "通知我" });
	assert.throws(() => parseTriggerRule("just some words"), /could not split the trigger into a condition and action/);
	assert.throws(() => parseTriggerRule("   "), /usage: \/new-trigger/);
});

test("looksLikeFixedScheduleRequest", () => {
	assert.ok(looksLikeFixedScheduleRequest("check every hour"));
	assert.ok(looksLikeFixedScheduleRequest("每天九点看一下"));
	assert.ok(!looksLikeFixedScheduleRequest("when the file appears"));
});

test("prompt rendering and id extraction", () => {
	const trig = buildPeriodicCheckTrigger("/tmp/p", 1);
	const prompt = renderDynamicTriggerPrompt(trig, [{ id: "dyn-" + "a".repeat(32), condition: "c", action: "a", enabled: true, fireOnce: true, promoteToChat: false, createdAt: "t", cwd: "/tmp/p" }]);
	assert.ok(prompt.includes('"source_label": "local:dynamic"'));
	assert.ok(prompt.includes("no dynamic trigger rule matched"));
	assert.ok(prompt.includes("dyn-" + "a".repeat(32)));
	const ids = extractDynamicRuleIds(`matched dyn-${"b".repeat(32)} and dyn-${"b".repeat(32)} but not dyn-123`);
	assert.deepEqual(ids, [`dyn-${"b".repeat(32)}`]);
});

test("store: add/list/enable/remove/markFired/clear + audit", async () => {
	const store = new TriggerStore(fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-trig-")));
	const a = await store.add({ condition: "x", action: "y", cwd: "/p" });
	const b = await store.add({ condition: "x2", action: "y2", cwd: "/q", fireOnce: false, promoteToChat: true });
	assert.equal(store.load().length, 2);
	assert.equal(resolveRuleRef(store.load(), "2")?.id, b.id);
	assert.equal(resolveRuleRef(store.load(), a.id.slice(0, 10))?.id, a.id);
	const fired = await store.markFired([a.id, b.id]);
	assert.deepEqual(fired.map((r) => r.id), [a.id], "only fire-once rules are disabled");
	const after = store.load();
	assert.equal(after.find((r) => r.id === a.id)?.enabled, false);
	assert.ok(after.find((r) => r.id === b.id)?.firedAt);
	assert.equal(after.find((r) => r.id === b.id)?.enabled, true);
	await store.setEnabled(a.id, true);
	assert.equal(store.load().find((r) => r.id === a.id)?.firedAt, undefined);
	assert.equal(await store.clear("/q"), 1);
	assert.equal((await store.remove(a.id))?.id, a.id);
	assert.equal(store.load().length, 0);
	store.appendAudit({ type: "trigger", traceId: "t1", state: "accepted", summary: "sk-abcdefghij1234567890abcd" });
	store.appendAudit({ type: "trigger_result", traceId: "t1", state: "completed" });
	const audit = store.listAudit(5);
	assert.equal(audit.length, 2);
	assert.equal(audit[0].type, "trigger_result", "newest first");
	assert.ok(audit[1].summary?.includes("[REDACTED"));
});

test("dedup window: in-memory and shared across processes through a file", async () => {
	const d = new DedupWindow(1000);
	assert.equal(await d.check("k", "t1", 0, "latest_replaces"), undefined);
	assert.deepEqual(await d.check("k", "t2", 500, "drop"), { traceId: "t1", replacementPolicy: "latest_replaces" }, "reports the first arrival and its policy (pie)");
	assert.equal(await d.check("k", "t3", 2000), undefined);
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-dedup-")), "dedup.json");
	const a = new DedupWindow(60_000, file);
	const b = new DedupWindow(60_000, file); // a second pi process
	assert.equal(await a.check("mcp:x:tools", "ta", 1000), undefined);
	assert.equal((await b.check("mcp:x:tools", "tb", 1500))?.traceId, "ta", "the other process sees the first one's claim");
	assert.equal(await b.check("mcp:x:tools", "tc", 70_000), undefined, "window expired");
});

test("controlPlanePreflight: sub-agents are denied fail-closed (pie), no-UI processes are refused, interactive asks", () => {
	assert.match(controlPlanePreflight({ hop: 1, hasUI: false }, "create dynamic trigger") ?? "", /fail-closed/);
	assert.match(controlPlanePreflight({ hop: 2, hasUI: true }, "re-enable cron job") ?? "", /fail-closed/);
	assert.match(controlPlanePreflight({ hop: 0, hasUI: false }, "remove dynamic trigger") ?? "", /interactive confirmation/);
	assert.equal(controlPlanePreflight({ hop: 0, hasUI: true }, "create dynamic trigger"), undefined);
});

test("store.update patches a rule in place (model, thinking, timeout can be changed after creation)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-trg-"));
	const store = new TriggerStore(dir);
	const r = await store.add({ condition: "c", action: "a", cwd: dir, model: "old/model" });
	const updated = await store.update(r.id, (rule) => {
		rule.model = "new/model";
		rule.thinking = "high";
		rule.timeoutMs = 60_000;
	});
	assert.equal(updated?.model, "new/model");
	assert.deepEqual(store.load().map((x) => [x.thinking, x.timeoutMs]), [["high", 60_000]]);
	assert.equal(await store.update("dyn-nope", () => {}), undefined);
});
