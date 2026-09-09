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
