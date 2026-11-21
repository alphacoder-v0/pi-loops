/** The model-facing tools' words for a proposed watch (design 6.3): the lists, and the switches a proposal refuses. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { fakeRunner } from "./fake-runner.ts";
import { ownerViewOf } from "../src/job-owner.ts";
import { openStores } from "../src/stores.ts";
import { type ToolHost, automationTools, createLoopJob } from "../src/tools.ts";
import { TriggerRuntime } from "../src/trigger-runtime.ts";

function tools() {
	const dir = tmp("pi-loops-tools-");
	const mine = path.join(dir, "mine");
	fs.mkdirSync(mine);
	const stores = openStores(dir);
	const triggers = new TriggerRuntime({ store: stores.rules, jobStore: stores.jobs, getSession: () => ({ sessionId: "s", cwd: mine }), runner: fakeRunner(), dedupFile: path.join(dir, "dedup.json") });
	const host: ToolHost = { stores, owner: () => ownerViewOf({ sessionId: "s", cwd: mine }, undefined), triggers, session: () => ({ sessionId: "s", cwd: mine }), createJob: (input, scope) => createLoopJob(host, input, scope), cronControlAudit: () => "audit-1", confirmTool: async () => undefined, refreshBadge: () => undefined };
	const defs = automationTools({ hop: 0, actor: "tool" }, host);
	const call = (name: string, args: Record<string, unknown>) => defs.find((t) => t.name === name)!.execute("i", args, undefined, undefined, { hasUI: true } as any);
	return { stores, call };
}

test("cron_list and list_triggers give the model [proposed] where they give [disabled]", async () => {
	const t = tools();
	await t.call("cron_create", { schedule: "every 10m", action: "look", name: "pr-watch" });
	await t.call("new_trigger", { condition: "c", action: "a" });
	const jobs = await t.call("cron_list", {});
	assert.match(String(jobs.content[0].text), /\n- cron-\w+ "pr-watch" \[proposed, stateful\] schedule: every 10m/);
	assert.equal(jobs.details.jobs[0].proposed, true);
	assert.equal(jobs.details.jobs[0].next_run, undefined, "no next run is promised for it");
	const rules = await t.call("list_triggers", {});
	assert.match(String(rules.content[0].text), /\n- dyn-\w+ \[proposed, fire_once, promote_to_chat\]/);
});

test("set_cron_job_state and set_trigger_state refuse a proposal: only the person's answer sets it up", async () => {
	const t = tools();
	await t.call("cron_create", { schedule: "every 10m", action: "look", name: "pr-watch" });
	await t.call("new_trigger", { condition: "c", action: "a" });
	const job = await t.call("set_cron_job_state", { ref: "pr-watch", enabled: true });
	assert.equal(job.isError, true);
	assert.equal(String(job.content[0].text), `cron job "pr-watch" is proposed and waits for the person's yes: only their answer sets it up (/cron enable pr-watch asks again)`);
	const [rule] = t.stores.rules.load();
	const out = await t.call("set_trigger_state", { id: rule.id, enabled: true });
	assert.equal(String(out.content[0].text), `dynamic trigger ${rule.id} is proposed and waits for the person's yes: only their answer sets it up (/triggers enable ${rule.id} asks again)`);
	assert.deepEqual([t.stores.jobs.load()[0].enabled, t.stores.rules.load()[0].enabled], [false, false]);
});

test("a person's turn in a conversation pi has not saved proposes nothing: the proposal and its receipt need a conversation", async () => {
	const t = tools();
	const dir = tmp("pi-loops-tools-nosession-");
	const stores = openStores(dir);
	const triggers = new TriggerRuntime({ store: stores.rules, jobStore: stores.jobs, getSession: () => ({ cwd: dir }), runner: fakeRunner(), dedupFile: path.join(dir, "dedup.json") });
	const host: ToolHost = { stores, owner: () => ownerViewOf({ cwd: dir }, undefined), triggers, session: () => ({ cwd: dir }), createJob: (input, scope) => createLoopJob(host, input, scope), cronControlAudit: () => "audit-1", confirmTool: async () => undefined, refreshBadge: () => undefined };
	for (const [name, args] of [["cron_create", { schedule: "every 10m", action: "look" }], ["new_trigger", { condition: "c", action: "a" }]] as const) {
		const out = await automationTools({ hop: 0, actor: "tool" }, host).find((d) => d.name === name)!.execute("i", args, undefined, undefined, { hasUI: true } as any);
		assert.equal(out.isError, true, name);
		assert.match(String(out.content[0].text), /^a watch is proposed in a saved conversation/, name);
	}
	assert.deepEqual([stores.jobs.load(), stores.rules.load(), t.stores.jobs.load()], [[], [], []]);
});
