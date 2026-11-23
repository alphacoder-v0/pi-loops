/** The model-facing tools' words for a proposed watch (design 6.3): the lists, and the switches a proposal refuses. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { fakeRunner } from "./fake-runner.ts";
import { ownerViewOf } from "../src/job-owner.ts";
import { openStores } from "../src/stores.ts";
import { type ConfirmTurn, type ToolHost, automationTools, confirmControlPlane, controlTarget, createLoopJob } from "../src/tools.ts";
import { TriggerRuntime } from "../src/trigger-runtime.ts";
import { parseSchedule } from "../src/schedule.ts";

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

test("[M5b.9] confirmTool in a window: the person's own turn gets pi's confirm; a scheduled turn with a guard seat opens no dialog, since the guard asked in /inbox; one with no seat and hop 1 are refused", async () => {
	const dir = tmp("pi-loops-tools-confirm-");
	const stores = openStores(dir);
	const triggers = new TriggerRuntime({ store: stores.rules, jobStore: stores.jobs, getSession: () => ({ sessionId: "s", cwd: dir }), runner: fakeRunner(), dedupFile: path.join(dir, "dedup.json") });
	let turn: ConfirmTurn = { kind: "person" };
	const host: ToolHost = { stores, owner: () => ownerViewOf({ sessionId: "s", cwd: dir }, undefined), triggers, session: () => ({ sessionId: "s", cwd: dir }), createJob: (input, scope) => createLoopJob(host, input, scope), cronControlAudit: () => "audit-1", confirmTool: (ctx, req, hop) => confirmControlPlane(ctx, req, hop, turn), refreshBadge: () => undefined, scheduledTurn: () => turn.kind === "scheduled" };
	const confirms: string[] = [];
	let answer = false;
	const ctx = { hasUI: true, ui: { notify: () => undefined, confirm: async (title: string) => (confirms.push(title), answer), select: async () => assert.fail("no select") } } as any;
	const remove = (name: string) => automationTools({ hop: 0, actor: "tool" }, host).find((d) => d.name === "cron_remove")!.execute("i", { ref: name }, undefined, undefined, ctx);
	const add = (name: string) => createLoopJob(host, { schedule: parseSchedule("every 10m"), prompt: "look", name, stateful: true });
	await add("a");
	await add("b");
	const declined = await remove("a");
	assert.deepEqual(confirms, ["Control-plane approval required"], "the person's own turn: pi's confirm");
	assert.equal(String(declined.content[0].text), 'user declined: remove cron job "a"');
	answer = true;
	await remove("a");
	assert.deepEqual(confirms.length, 2);
	assert.deepEqual(stores.jobs.load().map((j) => j.name), ["b"], "their yes removes it");
	turn = { kind: "scheduled", seated: false };
	const unseated = await remove("b");
	assert.equal(String(unseated.content[0].text), 'nobody answered in time: remove cron job "b"', "no guard seat: nobody was asked, so it is refused, in a scheduled turn's words");
	assert.deepEqual(stores.jobs.load().map((j) => j.name), ["b"]);
	turn = { kind: "scheduled", seated: true };
	await remove("b");
	assert.equal(confirms.length, 2, "a scheduled turn: no dialog, no countdown");
	assert.deepEqual(stores.jobs.load(), [], "the call ran: the guard let it through only after a person's yes");
	assert.match((await confirmControlPlane(ctx, { label: "remove cron job c", tool: "cron_remove", reason: "r", preview: "p" }, 1, { kind: "scheduled", seated: true }))!, /sub-agents have no control-plane prompt channel/, "hop 1 is refused, scheduled or not");
	assert.equal(confirms.length, 2);
});

test("[M5b.9] controlTarget reads a one-shot job the same in every time zone: the window and the background may differ, and a yes binds to it", async () => {
	const dir = tmp("pi-loops-target-tz-");
	const mine = path.join(dir, "mine");
	fs.mkdirSync(mine);
	const stores = openStores(dir);
	const host = { stores, triggers: { store: stores.rules } } as any;
	await stores.jobs.add({ id: "cron-bbbb", name: "release", schedule: { kind: "once", at: Date.UTC(2027, 0, 1, 1, 0) }, stateful: true, prompt: "ship", cwd: mine, enabled: true, catchUp: false, createdAt: new Date().toISOString(), runCount: 0, skippedOverlap: 0 } as any);
	const was = process.env.TZ;
	try {
		process.env.TZ = "Asia/Shanghai";
		const east = controlTarget(host, "cron_remove", { ref: "release" }, mine);
		process.env.TZ = "UTC";
		const utc = controlTarget(host, "cron_remove", { ref: "release" }, mine);
		assert.equal(east, utc);
		assert.equal(utc, 'job cron-bbbb "release" once', "the id names the job; a time that reads differently in each zone is left out");
	} finally {
		if (was === undefined) delete process.env.TZ;
		else process.env.TZ = was;
	}
});

test("[M5b.9] controlTarget: what a control-plane call would change, resolved as the tool resolves it in the project", async () => {
	const dir = tmp("pi-loops-tools-target-");
	const mine = path.join(dir, "mine");
	const other = path.join(dir, "other");
	fs.mkdirSync(mine);
	fs.mkdirSync(other);
	const stores = openStores(dir);
	const host = { stores, triggers: { store: stores.rules } } as any;
	const job = await stores.jobs.add({ id: "cron-aaaa", name: "pr-watch", schedule: parseSchedule("every 10m"), stateful: true, prompt: "look", cwd: mine, enabled: true, catchUp: false, createdAt: new Date().toISOString(), runCount: 0, skippedOverlap: 0 } as any);
	assert.equal(controlTarget(host, "cron_remove", { ref: "pr-watch" }, mine), `job ${job.id} "pr-watch" every 10m`);
	assert.equal(controlTarget(host, "set_cron_job_state", { ref: "pr-watch", enabled: false }, other), "no job matches", "another project's job is not this project's name");
	const rules = [];
	for (let i = 0; i < 7; i++) rules.push(await stores.rules.add({ condition: `c${i}`, action: "a", cwd: mine }));
	await stores.rules.add({ condition: "elsewhere", action: "a", cwd: other });
	const ids = rules.map((r) => r.id).sort();
	assert.equal(controlTarget(host, "remove_trigger", { id: rules[0].id }, mine), `rule ${rules[0].id}`);
	assert.equal(controlTarget(host, "set_trigger_state", { id: "dyn-none", enabled: true }, mine), "no rule matches");
	const all = controlTarget(host, "remove_trigger", { all: true }, mine)!;
	assert.match(all, new RegExp(`^7 rules: ${ids.slice(0, 5).join(", ")}, … \\(all ids sha256 [0-9a-f]{12}\\)$`), "the count, the first ids sorted, and a digest of them all");
	await stores.rules.add({ condition: "later", action: "a", cwd: mine });
	assert.notEqual(controlTarget(host, "remove_trigger", { all: true }, mine), all, "a rule added later changes the target");
	assert.equal(controlTarget(host, "remove_trigger", { all: true }, path.join(dir, "empty")), "0 rules");
	assert.equal(controlTarget(host, "cron_list", {}, mine), undefined);
});
