import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../src/config.ts";
import { createHostRuntime } from "../src/host-runtime.ts";
import { LoopScheduler } from "../src/scheduler.ts";
import { mapNotification } from "../src/mcp.ts";
import { buildPeriodicCheckTrigger } from "../src/triggers.ts";
import { fakeRunner } from "./fake-runner.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-hostrt-"));

test("the host runtime leaves as soon as an interactive pi owns the clock", async () => {
	const dir = tmp();
	const exits: number[] = [];
	const logs: string[] = [];
	const pi = new LoopScheduler({ dir, runner: fakeRunner(), kind: "interactive", getSession: () => ({ sessionId: "s", cwd: dir }) });
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: fakeRunner(), mcpTools: () => [], log: (m) => void logs.push(m), exit: (c) => void exits.push(c) });
	try {
		await pi.tick();
		await host.scheduler.tick();
		assert.deepEqual(exits, [0]);
		assert.ok(logs.some((m) => /interactive pi owns the clock/.test(m)));
	} finally {
		await host.stop();
		await pi.stop();
	}
});

test("alone, the host runs loops and routes what a rule would have promoted into the inbox; sub-agent tools act in the run's cwd", async () => {
	const dir = tmp();
	const proj = path.join(dir, "proj");
	fs.mkdirSync(proj);
	const fake = fakeRunner();
	const logs: string[] = [];
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "", model: "default/model" }), runner: fake, mcpTools: () => [], log: (m) => void logs.push(m), exit: () => undefined });
	try {
		await host.scheduler.store.add({ id: "cron-hosted", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "look", cwd: proj, enabled: true, catchUp: true, createdAt: new Date(Date.now() - 120_000).toISOString(), runCount: 0, skippedOverlap: 0 });
		await host.scheduler.tick();
		const end = Date.now() + 5000;
		while (host.scheduler.store.listRuns("cron-hosted").length < 1 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
		assert.equal(host.scheduler.isLeader, true);
		assert.equal(host.scheduler.store.listRuns("cron-hosted")[0]?.ok, true);
		assert.equal(fake.calls[0].cwd, proj);
		assert.equal(fake.calls[0].model, "default/model", "an unpinned loop runs on the host's default model");
		assert.equal(host.scheduler.inbox.listNew().length, 1, "findings still reach the inbox");

		const rule = await host.triggers.store.add({ condition: "c", action: "a", cwd: proj, promoteToChat: true });
		process.env.FAKE_PI_REPLY = `matched ${rule.id}: done`;
		const out = await host.triggers.handle(buildPeriodicCheckTrigger(proj, 1), "sub_agent");
		assert.equal(out?.promoted, false);
		const promoted = host.scheduler.inbox.listNew().find((e) => e.source === "trigger:local:dynamic");
		assert.ok(promoted, "no chat here: the promotion lands in the inbox");
		assert.equal(promoted?.cwd, proj);

		// Tools handed to a sub-session created by the host act in that run's cwd, not the host's.
		const tools = await host.customTools({ cwd: proj, prompt: "", timeoutMs: 1, hop: 1, kind: "loop", model: "pinned/model" });
		const create = tools.find((t) => t.name === "cron_create")!;
		await assert.rejects(create.execute("id", { schedule: "every 5m", action: "chat me" }, undefined, undefined, { hasUI: false } as any), /not the background host/, "no chat here: a plain (inject) job cannot be created");
		const res = await create.execute("id", { schedule: "every 5m", action: "follow up", stateful: true }, undefined, undefined, { hasUI: false } as any);
		assert.equal(res.isError, undefined);
		const created = host.scheduler.store.load().find((j) => j.prompt === "follow up")!;
		assert.equal(created.cwd, proj);
		assert.equal(created.model, "pinned/model");
		assert.equal(host.triggers.store.listAudit(1)[0].type, "cron_control_plane", "control-plane operations by sub-agents are audited where /triggers audit shows them");
		// An MCP push reaching the host is evaluated once per project that has rules, in that project.
		const other = path.join(dir, "other");
		fs.mkdirSync(other);
		await host.triggers.store.add({ condition: "c2", action: "a2", cwd: other });
		await host.triggers.store.add({ condition: "c3", action: "a3", cwd: proj }); // the first proj rule fired once and is disabled
		const before = fake.calls.length;
		const push = mapNotification("srv", { method: "notifications/resources/updated", params: { uri: "file:///x" } })!;
		await host.triggers.handle(push, "sub_agent");
		const pushRuns = fake.calls.slice(before).map((c) => c.cwd).sort();
		assert.deepEqual(pushRuns, [other, proj].sort(), "one evaluation per project, each in its own directory — never in $HOME");

		const enable = tools.find((t) => t.name === "set_cron_job_state")!;
		const denied = await enable.execute("id", { ref: created.id, enabled: true }, undefined, undefined, { hasUI: false } as any);
		assert.equal(denied.isError, true, "Prompt-class operations stay denied in the host");
	} finally {
		delete process.env.FAKE_PI_REPLY;
		await host.stop();
	}
});

// Regression guard: a plain job must never be consumed by a process that cannot deliver it.
// (The host's snapshot has no sessionId, so `dispatch` is not even reached today — this pins that.)
test("the host leaves a plain job's tick owed instead of consuming it", async () => {
	const dir = tmp();
	const proj = path.join(dir, "proj");
	fs.mkdirSync(proj);
	const fake = fakeRunner();
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: fake, mcpTools: () => [], log: () => undefined, exit: () => undefined });
	const createdAt = new Date(Date.now() - 120_000).toISOString();
	try {
		// A plain job (the default mode) and a one-shot: neither can be delivered without a chat.
		await host.scheduler.store.add({ id: "cron-plain", schedule: { kind: "every", ms: 60_000 }, stateful: false, prompt: "tell me in the chat", cwd: proj, sessionId: "s1", enabled: true, catchUp: true, createdAt, runCount: 0, skippedOverlap: 0 });
		await host.scheduler.store.add({ id: "cron-once", schedule: { kind: "once", at: Date.now() - 60_000 }, stateful: false, prompt: "one shot", cwd: proj, sessionId: "s1", enabled: true, catchUp: true, createdAt, runCount: 0, skippedOverlap: 0 });
		await host.scheduler.tick();
		await host.scheduler.drain(5000);

		const jobs = host.scheduler.store.load();
		const plain = jobs.find((j) => j.id === "cron-plain")!;
		assert.equal(plain.runCount, 0, "an undeliverable job is not a completed run");
		assert.equal(plain.lastFiredAt, undefined, "and its tick stays owed for the next interactive pi");
		assert.equal(plain.lastDueAt, undefined);
		assert.ok(jobs.some((j) => j.id === "cron-once"), "a one-shot is not deleted unfired");
		assert.equal(fake.calls.length, 0);

		// An interactive scheduler on the same store still delivers it.
		const injected: string[] = [];
		const pi = new LoopScheduler({ dir, runner: fake, kind: "interactive", getSession: () => ({ sessionId: "s1", cwd: proj }), hooks: { onInject: (_j, prompt) => void injected.push(prompt) } });
		try {
			await pi.tick();
			await pi.drain(5000);
			assert.equal(injected.length, 2, "the chat that owns them gets both");
			assert.equal(pi.store.load().find((j) => j.id === "cron-plain")!.runCount, 1);
		} finally {
			await pi.stop();
		}
	} finally {
		await host.stop();
	}
});

test("the host audits its cron runs, so /triggers audit is not blank for the unattended hours", async () => {
	const dir = tmp();
	const proj = path.join(dir, "proj");
	fs.mkdirSync(proj);
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: fakeRunner(), mcpTools: () => [], log: () => undefined, exit: () => undefined });
	try {
		await host.scheduler.store.add({ id: "cron-audited", name: "nightly", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "look", cwd: proj, enabled: true, catchUp: true, createdAt: new Date(Date.now() - 120_000).toISOString(), runCount: 0, skippedOverlap: 0 });
		await host.scheduler.tick();
		await host.scheduler.drain(10_000);

		const rows = host.triggers.store.listAudit(10).filter((r) => r.sourceLabel === "Cron");
		assert.ok(rows.some((r) => r.state === "accepted"), "the run was admitted");
		assert.ok(rows.some((r) => r.state === "running"));
		const done = rows.find((r) => r.state === "completed");
		assert.ok(done, `a completed row: ${rows.map((r) => r.state).join(", ")}`);
		assert.equal(done!.eventLabel, "cron-audited");
		assert.equal(done!.cwd, proj, "and it is attributed to the job's project");
		assert.ok((done!.details as any)?.session_file, "with the transcript to read");
	} finally {
		await host.stop();
	}
});
