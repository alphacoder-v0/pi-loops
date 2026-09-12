import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LoopScheduler } from "../src/scheduler.ts";
import { TriggerStore } from "../src/triggers.ts";
import { TriggerRuntime } from "../src/trigger-runtime.ts";
import { type ToolHost, automationTools, createLoopJob } from "../src/tools.ts";
import { fakeRunner } from "./fake-runner.ts";

const ctx = { hasUI: false } as any;

function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-scope-"));
	const mine = path.join(dir, "mine");
	const other = path.join(dir, "other");
	fs.mkdirSync(mine);
	fs.mkdirSync(other);
	const scheduler = new LoopScheduler({ dir, runner: fakeRunner(), getSession: () => ({ sessionId: "s", cwd: mine }) });
	const triggers = new TriggerRuntime({ store: new TriggerStore(dir), jobStore: scheduler.store, getSession: () => ({ sessionId: "s", cwd: mine }), runner: fakeRunner(), dedupFile: path.join(dir, "dedup.json") });
	const host: ToolHost = {
		scheduler,
		triggers,
		session: () => ({ sessionId: "s", cwd: mine }),
		createJob: (input, scope) => createLoopJob(host, input, scope),
		cronControlAudit: () => "audit-1",
		confirmTool: async () => undefined, // hop 0 with a user present: approvals granted
		refreshBadge: () => undefined,
	};
	return { dir, mine, other, scheduler, triggers, host };
}

test("a cron expression that parses but never matches is refused at creation, the way /cron set refuses it", async () => {
	// "0 0 30 2 *" is February 30th. Stored, the job simply goes quiet — and every scan for its next
	// run walks five years of minutes on the leader's tick (test/schedule.test.ts).
	const f = fixture();
	try {
		await assert.rejects(
			() => createLoopJob(f.host, { schedule: { kind: "cron", expr: "0 0 30 2 *" }, prompt: "p", stateful: true }),
			/0 0 30 2 \* has no next run/,
		);
		assert.deepEqual(f.scheduler.store.load(), [], "and nothing was written");
	} finally {
		await f.scheduler.stop();
	}
});

test("with no session project a job's cwd must be absolute: a relative one has nothing to resolve against", async () => {
	// The headless host and `--no-session` have no cwd of their own, and the host's process cwd is
	// $HOME — so resolving `cwd: "code/piz"` there silently pinned the job to a real, unrelated
	// project. Only an absolute directory says what was meant.
	const f = fixture();
	const nowhere: ToolHost = { ...f.host, session: () => ({ sessionId: "s", cwd: "" }) };
	try {
		await assert.rejects(
			() => createLoopJob(nowhere, { schedule: { kind: "every", ms: 60_000 }, prompt: "p", stateful: true, cwd: "sub" }),
			/absolute directory/,
		);
		await assert.rejects(
			() => createLoopJob(nowhere, { schedule: { kind: "every", ms: 60_000 }, prompt: "p", stateful: true }),
			/no project directory for this job: pass cwd/,
		);
		assert.deepEqual(f.scheduler.store.load(), [], "and neither job was written");
		const absolute = await createLoopJob(nowhere, { schedule: { kind: "every", ms: 60_000 }, prompt: "p", stateful: true, cwd: f.other });
		assert.equal(absolute.cwd, f.other);
	} finally {
		await f.scheduler.stop();
	}
});

test("a job's relative cwd resolves against the session's project when there is one", async () => {
	const f = fixture();
	try {
		const job = await createLoopJob(f.host, { schedule: { kind: "every", ms: 60_000 }, prompt: "p", stateful: true, cwd: "sub" });
		assert.equal(job.cwd, path.join(f.mine, "sub"));
	} finally {
		await f.scheduler.stop();
	}
});

test("the model-facing tools show this project's automation, not the whole machine's", async () => {
	const f = fixture();
	try {
		await f.scheduler.store.add({ id: "cron-mine", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "mine", cwd: f.mine, enabled: true, catchUp: true, createdAt: new Date().toISOString(), runCount: 0, skippedOverlap: 0 });
		await f.scheduler.store.add({ id: "cron-secret", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "client name in here", cwd: f.other, enabled: true, catchUp: true, createdAt: new Date().toISOString(), runCount: 0, skippedOverlap: 0 });
		await f.triggers.store.add({ condition: "c1", action: "a1", cwd: f.mine });
		await f.triggers.store.add({ condition: "c2", action: "other project", cwd: f.other });
		const tools = automationTools({ hop: 0, actor: "tool" }, f.host);
		const cronList = tools.find((t) => t.name === "cron_list")!;
		const listed = await cronList.execute("i", {}, undefined, undefined, ctx);
		assert.match(String(listed.content[0].text), /cron jobs: 1/);
		assert.doesNotMatch(String(listed.content[0].text), /client name/, "another project's prompt never reaches the model");
		const listedAll = await cronList.execute("i", { all_projects: true }, undefined, undefined, ctx);
		assert.match(String(listedAll.content[0].text), /cron jobs: 2/, "explicitly asking for every project still works");

		const trigList = tools.find((t) => t.name === "list_triggers")!;
		const rules = await trigList.execute("i", {}, undefined, undefined, ctx);
		assert.match(String(rules.content[0].text), /rules: 1/);
		assert.doesNotMatch(String(rules.content[0].text), /other project/);
	} finally {
		await f.scheduler.stop();
	}
});

test("cron_list promises no next run for a job another machine owns", async () => {
	// The scheduler dispatches only jobs stamped with this hostname, so a next run for another
	// machine's job is a time nothing here will honour — docs/loops.md says as much, `/cron` obeyed
	// it, and the model-facing list printed one anyway.
	const f = fixture();
	try {
		await f.scheduler.store.add({ id: "cron-elsewhere", name: "nightly", schedule: { kind: "cron", expr: "0 9 * * *" }, stateful: true, prompt: "p", cwd: f.mine, enabled: true, catchUp: true, host: "another-machine", createdAt: new Date().toISOString(), runCount: 0, skippedOverlap: 0 });
		await f.scheduler.store.add({ id: "cron-here", name: "mine", schedule: { kind: "cron", expr: "0 9 * * *" }, stateful: true, prompt: "p", cwd: f.mine, enabled: true, catchUp: true, host: os.hostname(), createdAt: new Date().toISOString(), runCount: 0, skippedOverlap: 0 });
		const cronList = automationTools({ hop: 0, actor: "tool" }, f.host).find((t) => t.name === "cron_list")!;
		const listed = await cronList.execute("i", {}, undefined, undefined, ctx);
		const byId = new Map(listed.details.jobs.map((j: any) => [j.id, j]));
		assert.equal(byId.get("cron-elsewhere").next_run, undefined);
		assert.ok(byId.get("cron-here").next_run, "this machine's job still has one");
		assert.match(String(listed.content[0].text), /other_host: another-machine/, "and it says why, so the model is not left guessing");
	} finally {
		await f.scheduler.stop();
	}
});

test("removing all trigger rules only clears this project", async () => {
	const f = fixture();
	try {
		await f.triggers.store.add({ condition: "c1", action: "a1", cwd: f.mine });
		await f.triggers.store.add({ condition: "c2", action: "a2", cwd: f.other });
		const remove = automationTools({ hop: 0, actor: "tool" }, f.host).find((t) => t.name === "remove_trigger")!;
		const res = await remove.execute("i", { all: true }, undefined, undefined, ctx);
		assert.equal(res.details.removed_count, 1);
		const left = f.triggers.store.load();
		assert.equal(left.length, 1);
		assert.equal(left[0].cwd, f.other, "another project's rule survives");
	} finally {
		await f.scheduler.stop();
	}
});

test("a sub-agent cannot remove a cron job, and another project's job needs its exact id", async () => {
	const f = fixture();
	try {
		await f.scheduler.store.add({ id: "cron-other", name: "nightly", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "p", cwd: f.other, enabled: true, catchUp: true, createdAt: new Date().toISOString(), runCount: 0, skippedOverlap: 0 });
		// hop 0 (a user is present): a name that belongs to another project still resolves, but only
		// because the tool falls back to an exact-id match — a bare name of another project does not.
		const atHop0 = automationTools({ hop: 0, actor: "tool" }, f.host).find((t) => t.name === "cron_remove")!;
		const byName = await atHop0.execute("i", { ref: "nightly", confirm: true }, undefined, undefined, ctx);
		assert.equal(byName.isError, true, "another project's job is not reachable by name");
		assert.equal(f.scheduler.store.load().length, 1);

		// A sub-agent is denied outright: nobody can approve a removal in an unattended run.
		const subHost: ToolHost = { ...f.host, confirmTool: async () => "denied: no user to approve this" };
		const atHop1 = automationTools({ hop: 1, actor: "sub-agent" }, subHost).find((t) => t.name === "cron_remove")!;
		const denied = await atHop1.execute("i", { ref: "cron-other", confirm: true }, undefined, undefined, ctx);
		assert.equal(denied.isError, true);
		assert.equal(f.scheduler.store.load().length, 1, "the job is still there");
	} finally {
		await f.scheduler.stop();
	}
});

test("a sub-agent cannot ask for the machine-wide view, and cannot disable another project's automation", async () => {
	const f = fixture();
	try {
		await f.scheduler.store.add({ id: "cron-elsewhere", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "secret", cwd: f.other, enabled: true, catchUp: true, createdAt: new Date().toISOString(), runCount: 0, skippedOverlap: 0 });
		const rule = await f.triggers.store.add({ condition: "other project condition", action: "a", cwd: f.other });

		const subHost: ToolHost = { ...f.host, confirmTool: async () => "denied: nobody can approve this" };
		const sub = automationTools({ hop: 1, actor: "sub-agent" }, subHost);
		const cronList = sub.find((t) => t.name === "cron_list")!;
		const listed = await cronList.execute("i", { all_projects: true }, undefined, undefined, ctx);
		assert.match(String(listed.content[0].text), /cron jobs: none/, "all_projects is not a sub-agent's to set");
		assert.doesNotMatch(String(listed.content[0].text), /secret/);
		const trigList = sub.find((t) => t.name === "list_triggers")!;
		assert.doesNotMatch(String((await trigList.execute("i", { all_projects: true }, undefined, undefined, ctx)).content[0].text), /other project condition/);

		// Disabling another project's automation is a control-plane action, so it is refused too.
		const setCron = sub.find((t) => t.name === "set_cron_job_state")!;
		assert.equal((await setCron.execute("i", { ref: "cron-elsewhere", enabled: false }, undefined, undefined, ctx)).isError, true);
		assert.equal(f.scheduler.store.load().find((j) => j.id === "cron-elsewhere")!.enabled, true);
		const setTrig = sub.find((t) => t.name === "set_trigger_state")!;
		assert.equal((await setTrig.execute("i", { id: rule.id, enabled: false }, undefined, undefined, ctx)).isError, true);
		assert.equal(f.triggers.store.load().find((r) => r.id === rule.id)!.enabled, true);

		// Ordinals never resolve in the model-facing tools: the model's list is not the user's.
		const atHop0 = automationTools({ hop: 0, actor: "tool" }, f.host);
		assert.equal((await atHop0.find((t) => t.name === "cron_remove")!.execute("i", { ref: "1", confirm: true }, undefined, undefined, ctx)).isError, true);
		assert.equal((await atHop0.find((t) => t.name === "remove_trigger")!.execute("i", { id: "1" }, undefined, undefined, ctx)).isError, true);
	} finally {
		await f.scheduler.stop();
	}
});
