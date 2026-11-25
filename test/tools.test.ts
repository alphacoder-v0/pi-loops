/** The model-facing tools' words for a proposed watch (design 6.3): the lists, and the switches a proposal refuses. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { fakeRunner } from "./fake-runner.ts";
import { ownerViewOf } from "../src/job-owner.ts";
import { openStores } from "../src/stores.ts";
import { type ConfirmTurn, GATE_NEEDS_PERSON, RULE_GATE_NEEDS_PERSON, type ToolHost, automationTools, confirmControlPlane, controlTarget, createLoopJob, wakeMeTool } from "../src/tools.ts";
import { parseSchedule, stamp } from "../src/schedule.ts";
import { dayTime } from "../src/clock.ts";
import { plainJobRow } from "../src/engine.ts";

function tools() {
	const dir = tmp("pi-loops-tools-");
	const mine = path.join(dir, "mine");
	fs.mkdirSync(mine);
	const stores = openStores(dir);
	const host: ToolHost = { stores, owner: () => ownerViewOf({ sessionId: "s", cwd: mine }, undefined), rules: stores.rules, pollSecs: () => 600, session: () => ({ sessionId: "s", cwd: mine }), createJob: (input, scope) => createLoopJob(host, input, scope), cronControlAudit: () => "audit-1", confirmTool: async () => undefined, refreshBadge: () => undefined };
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
	const host: ToolHost = { stores, owner: () => ownerViewOf({ cwd: dir }, undefined), rules: stores.rules, pollSecs: () => 600, session: () => ({ cwd: dir }), createJob: (input, scope) => createLoopJob(host, input, scope), cronControlAudit: () => "audit-1", confirmTool: async () => undefined, refreshBadge: () => undefined };
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
	let turn: ConfirmTurn = { kind: "person" };
	const host: ToolHost = { stores, owner: () => ownerViewOf({ sessionId: "s", cwd: dir }, undefined), rules: stores.rules, pollSecs: () => 600, session: () => ({ sessionId: "s", cwd: dir }), createJob: (input, scope) => createLoopJob(host, input, scope), cronControlAudit: () => "audit-1", confirmTool: (ctx, req, hop) => confirmControlPlane(ctx, req, hop, turn), refreshBadge: () => undefined, scheduledTurn: () => turn.kind === "scheduled" };
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
	const host = { stores, rules: stores.rules } as any;
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
	const host = { stores, rules: stores.rules } as any;
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

test("[wake-me] wake_me writes its own loop's follow-up and no other's; a refusal writes nothing; cron_list gives the model the wake and the quiet", async () => {
	const t = tools();
	const cwd = t.stores.dir;
	const job = (id: string, name: string) => t.stores.jobs.add({ id, name, schedule: parseSchedule("every 1h"), stateful: true, prompt: "look", cwd: path.join(cwd, "mine"), enabled: true, catchUp: true, createdAt: new Date().toISOString() });
	const a = await job("cron-aaaaaaaa", "ci");
	await job("cron-bbbbbbbb", "other");
	const tool = wakeMeTool({ jobId: a.id, runId: "run-a", job: () => t.stores.jobs.load().find((j) => j.id === a.id), clock: t.stores.clock, runs: () => t.stores.jobs.allRuns(), rows: () => [] });
	const call = (args: Record<string, unknown>) => tool.execute("i", args, undefined, undefined, {} as any);
	const refused = await call({ when: "in 30s", note: "x" });
	assert.equal(refused.isError, true);
	assert.match(String(refused.content[0].text), /^not set: a wake is at least 60 seconds and at most 7 days ahead\. Its next scheduled run is .+\.$/);
	assert.deepEqual(t.stores.clock.read().jobs, {}, "a refusal writes nothing");
	const set = await call({ when: "in 2h", note: "nothing before then", quiet: true, job: "cron-bbbbbbbb" });
	assert.equal(set.isError, undefined);
	const jobs = t.stores.clock.read().jobs;
	assert.equal(jobs[a.id]?.followup?.note, "nothing before then");
	assert.equal(jobs[a.id]?.quietUntil, jobs[a.id]?.followup?.at);
	assert.equal(jobs["cron-bbbbbbbb"], undefined, "the run's own loop only: the input names no job");
	const list = await t.call("cron_list", {});
	const text = String(list.content[0].text);
	assert.match(text, new RegExp(`\\n  next_wake: ${jobs[a.id]!.followup!.at.replace(/[.+]/g, "\\$&")}, asked by the loop: "nothing before then"`));
	assert.match(text, /\n  quiet_until: .+, asked by the loop: "nothing before then" \(\/cron run ci wakes it now\)/);
	const listed = list.details.jobs.find((j: any) => j.id === a.id);
	assert.deepEqual([listed.next_wake, listed.quiet_until], [{ at: jobs[a.id]!.followup!.at, note: "nothing before then" }, { until: jobs[a.id]!.quietUntil, why: "nothing before then" }]);
});

test("[gate-held-count] cron_list gives the model a loop's gate and its state: its command, the looks it held since its output changed, or why it is failing", async () => {
	const t = tools();
	const cwd = t.stores.dir;
	const job = await t.stores.jobs.add({ id: "cron-cccccccc", name: "prs", schedule: parseSchedule("every 1h"), stateful: true, prompt: "look", cwd: path.join(cwd, "mine"), enabled: true, catchUp: true, createdAt: new Date().toISOString(), gate: { kind: "command", command: "gh pr list" } });
	const seenAt = new Date(Date.now() - 3_600_000).toISOString();
	t.stores.clock.seed({ [job.id]: { runs: 3, gate: { looks: 5, seen: { digest: "d", at: seenAt }, last: { at: new Date().toISOString(), digest: "d" } } } });
	const list = await t.call("cron_list", {});
	assert.match(String(list.content[0].text), new RegExp(`\\n  gate: \`gh pr list\` \\(the same for 5 looks since ${seenAt.replace(/[.+]/g, "\\$&")}: no model call until its output changes\\)`));
	assert.deepEqual(list.details.jobs.find((j: any) => j.id === job.id).gate, { command: "gh pr list", looks: 5, since: seenAt });
	t.stores.clock.noteLook(job.id, { at: new Date().toISOString(), failed: "timed out after 5s" });
	const failing = String((await t.call("cron_list", {})).content[0].text);
	assert.match(failing, /\n  gate_failing: timed out after 5s \(the loop runs without the gate until it works\)/);
});

test("[wake-me-next] wake_me's reply reads the next scheduled run as /cron does: from the run in flight, which fires an every schedule when it starts", async () => {
	const t = tools();
	const now = Date.parse("2026-11-23T09:55:00.000+08:00");
	const a = await t.stores.jobs.add({ id: "cron-aaaaaaaa", name: "ci", schedule: parseSchedule("every 1h"), stateful: true, prompt: "look", cwd: path.join(t.stores.dir, "mine"), enabled: true, catchUp: true, createdAt: stamp(now - 86_400_000) });
	t.stores.clock.seed({ [a.id]: { runs: 3, fired: stamp(now - 55 * 60_000) } });
	const started = now - 5 * 60_000;
	const mine = { ...plainJobRow(a, "row-a", `cron:${a.id}`, "", { pid: process.pid, instance: "x", version: "0" }, started), lane: `@${a.id}`, run: { id: "run-a", pid: process.pid, started_at: stamp(started) } };
	const reply = async (rows: any[]) => {
		const tool = wakeMeTool({ jobId: a.id, runId: "run-a", job: () => t.stores.jobs.load().find((j) => j.id === a.id), clock: t.stores.clock, runs: () => [], rows: () => rows, now: () => now });
		return String((await tool.execute("i", { when: "in 20m", note: "look again" }, undefined, undefined, {} as any)).content[0].text);
	};
	assert.match(await reply([mine]), new RegExp(`Its next scheduled run is ${dayTime(started + 3_600_000, now)}\\.$`), "an hour after the run in flight started, not after the last one that ended");
	assert.match(await reply([]), new RegExp(`Its next scheduled run is ${dayTime(now + 5 * 60_000, now)}\\.$`), "with no run in flight, from the clock");
	const refused = await (wakeMeTool({ jobId: a.id, runId: "run-a", job: () => t.stores.jobs.load().find((j) => j.id === a.id), clock: t.stores.clock, runs: () => [], rows: () => [mine], now: () => now }).execute("i", { when: "in 10s", note: "x" }, undefined, undefined, {} as any));
	assert.match(String(refused.content[0].text), new RegExp(`Its next scheduled run is ${dayTime(started + 3_600_000, now)}\\.$`), "a refusal says the same next run");
});

test("[wake-quiet] cron_list's next_run is the one /cron shows: a quiet time holds the slots before it", async () => {
	const t = tools();
	const a = await t.stores.jobs.add({ id: "cron-aaaaaaaa", name: "ci", schedule: parseSchedule("every 1h"), stateful: true, prompt: "look", cwd: path.join(t.stores.dir, "mine"), enabled: true, catchUp: true, createdAt: new Date(Date.now() - 86_400_000).toISOString() });
	const until = new Date(Date.now() + 3 * 3_600_000).toISOString();
	t.stores.clock.seed({ [a.id]: { runs: 1, fired: new Date(Date.now() - 30 * 60_000).toISOString(), quietUntil: until, quietWhy: "weekend" } });
	const listed = (await t.call("cron_list", {})).details as any;
	const job = (listed.jobs ?? listed).find((j: any) => j.id === a.id);
	assert.ok(job?.next_run, JSON.stringify(listed));
	assert.ok(Date.parse(job.next_run) >= Date.parse(until), `next_run ${job.next_run} is not before the quiet time ends (${until})`);
});

test("[clean-at-sink] cron_list's text carries no control or format character, whichever field held it", async () => {
	const t = tools();
	const nasty = "a\u001b[2J\u202eb\u200bc\u009bd";
	const a = await t.stores.jobs.add({ id: "cron-aaaaaaaa", name: `n ${nasty}`, schedule: parseSchedule("every 1h"), stateful: true, prompt: `p ${nasty}`, cwd: path.join(t.stores.dir, "mine"), enabled: true, catchUp: true, createdAt: new Date().toISOString(), gate: { kind: "command", command: "gh pr list" } });
	t.stores.clock.seed({ [a.id]: { runs: 1, note: { at: new Date().toISOString(), text: `note ${nasty}` }, followup: { id: "fu", at: new Date(Date.now() + 3_600_000).toISOString(), note: `w ${nasty}`, set_by: "r", created_at: new Date().toISOString() }, gate: { looks: 0, last: { at: new Date().toISOString(), failed: `f ${nasty}` } } } });
	const text = String((await t.call("cron_list", {})).content[0].text);
	for (const word of ["n a", "p a", "note a", "w a", "f a"]) assert.ok(text.includes(word), `${word}: ${text}`);
	for (const line of text.split("\n")) assert.equal(/[\p{Cc}\p{Cf}]/u.test(line), false, JSON.stringify(line));
});

test("[gate-person-only] the skill quotes the two refusals of a gate exactly as the tools give them", () => {
	const flat = (t: string) => t.replace(/\s+/g, " ");
	const skill = flat(fs.readFileSync(path.join(process.cwd(), "skills/pi-loops/SKILL.md"), "utf8"));
	for (const refusal of [GATE_NEEDS_PERSON, RULE_GATE_NEEDS_PERSON]) assert.ok(skill.includes(flat(refusal)), `SKILL.md quotes: ${refusal}`);
});

