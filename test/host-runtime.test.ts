import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../src/config.ts";
import { createHostRuntime, type HostRuntime } from "../src/host-runtime.ts";
import { LoopScheduler } from "../src/scheduler.ts";
import { mapNotification } from "../src/mcp.ts";
import { buildPeriodicCheckTrigger } from "../src/triggers.ts";
import { fakeRunner } from "./fake-runner.ts";
import { LeaseBinding, LeaseStore, procStart } from "../src/lease.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Mailbox } from "../src/mailbox.ts";


test("the host keeps running while pis open and close", async () => {
	const dir = tmp("pi-loops-hostrt-");
	const fake = fakeRunner();
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: fake, mcpTools: () => [], log: () => undefined });
	try {
		await host.scheduler.store.add({ id: "cron-kept", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "look", cwd: dir, enabled: true, catchUp: true, createdAt: new Date(Date.now() - 120_000).toISOString(), runCount: 0, skippedOverlap: 0 });
		// A window opens and ticks, closes, and another opens: none of it reaches the host.
		for (const sessionId of ["s1", "s2"]) {
			const pi = new LoopScheduler({ dir, runner: fakeRunner(), kind: "interactive", getSession: () => ({ sessionId, cwd: dir }), owns: (job) => !job.stateful });
			await pi.tick();
			await pi.stop();
		}
		await host.scheduler.tick();
		await host.scheduler.drain(5000);
		assert.equal(fake.calls.length, 1, "the host ran the loop the windows left alone");
	} finally {
		await host.stop();
	}
});

test("the host runs loops and routes a promotion to the creating session's mailbox when a window holds it, else to the inbox with that session's id; sub-agent tools act in the run's cwd", async () => {
	const dir = tmp("pi-loops-hostrt-");
	const proj = path.join(dir, "proj");
	fs.mkdirSync(proj);
	const fake = fakeRunner();
	const logs: string[] = [];
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "", model: "default/model" }), runner: fake, mcpTools: () => [], log: (m) => void logs.push(m) });
	try {
		await host.scheduler.store.add({ id: "cron-hosted", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "look", cwd: proj, enabled: true, catchUp: true, createdAt: new Date(Date.now() - 120_000).toISOString(), runCount: 0, skippedOverlap: 0 });
		await host.scheduler.tick();
		const end = Date.now() + 5000;
		while (host.scheduler.store.listRuns("cron-hosted").length < 1 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
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

		// A rule created in a conversation that a window holds: queued for that window, not the inbox.
		new LeaseStore(dir).acquire("held", { kind: "terminal", pid: process.pid, instance: "w", acquiredAt: new Date().toISOString(), pushServers: [] });
		const mine = await host.triggers.store.add({ condition: "c", action: "a", cwd: proj, promoteToChat: true, sessionId: "held" });
		process.env.FAKE_PI_REPLY = `matched ${mine.id}: for the window`;
		const queued = await host.triggers.handle(buildPeriodicCheckTrigger(proj, 1), "sub_agent", [mine]);
		assert.equal(queued?.promoted, true);
		assert.match(new Mailbox(dir).pending("held")[0]?.text ?? "", /for the window/, "queued in the holding window's mailbox");
		// The same rule's conversation closed: the inbox, marked for it.
		const closed = await host.triggers.store.add({ condition: "c", action: "a", cwd: proj, promoteToChat: true, sessionId: "closed" });
		process.env.FAKE_PI_REPLY = `matched ${closed.id}: for later`;
		await host.triggers.handle(buildPeriodicCheckTrigger(proj, 1), "sub_agent", [closed]);
		assert.equal(host.scheduler.inbox.listNew().find((e) => e.text.includes("for later"))?.session_id, "closed");

		// Tools handed to a sub-session created by the host act in that run's cwd, not the host's.
		const tools = await host.customTools({ cwd: proj, prompt: "", timeoutMs: 1, hop: 1, kind: "loop", model: "pinned/model" });
		const create = tools.find((t) => t.name === "cron_create")!;
		await assert.rejects(create.execute("id", { schedule: "every 5m", action: "chat me" }, undefined, undefined, { hasUI: false } as any), /not a background process/, "no chat here: a plain (inject) job cannot be created");
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
	const dir = tmp("pi-loops-hostrt-");
	const proj = path.join(dir, "proj");
	fs.mkdirSync(proj);
	const fake = fakeRunner();
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: fake, mcpTools: () => [], log: () => undefined });
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
	const dir = tmp("pi-loops-hostrt-");
	const proj = path.join(dir, "proj");
	fs.mkdirSync(proj);
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: fakeRunner(), mcpTools: () => [], log: () => undefined });
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

/** Hooks are fired off the run and never awaited by it, so their output lands a moment later. */
async function waitForLines(file: string, n: number, ms = 10_000): Promise<string[]> {
	const end = Date.now() + ms;
	for (;;) {
		const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
		if (lines.length >= n || Date.now() > end) return lines;
		await new Promise((r) => setTimeout(r, 25));
	}
}

const dueJob = (id: string, name: string, cwd: string) => ({ id, name, schedule: { kind: "every" as const, ms: 60_000 }, stateful: true, prompt: "look", cwd, enabled: true, catchUp: true, createdAt: new Date(Date.now() - 120_000).toISOString(), runCount: 0, skippedOverlap: 0 });

test("the host fires run_start/run_end around each loop run, in the run's own project", async () => {
	const dir = tmp("pi-loops-hostrt-");
	const proj = path.join(dir, "proj");
	fs.mkdirSync(proj);
	const events = path.join(dir, "events.jsonl");
	const dirs = path.join(dir, "dirs.txt");
	// One rule per event: the payload as JSON, plus where the command was run.
	const rule = (event: string) => [`[[hook]]`, `event = "${event}"`, `command = "cat \\"$PI_HOOK_PAYLOAD\\" >> ${events}; echo >> ${events}; pwd -P >> ${dirs}"`].join("\n");
	fs.writeFileSync(path.join(dir, "hooks.toml"), `${rule("run_start")}\n${rule("run_end")}\n`);
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "", model: "default/model" }), runner: fakeRunner(), mcpTools: () => [], log: () => undefined });
	try {
		await host.scheduler.store.add(dueJob("cron-hooked", "nightly", proj));
		await host.scheduler.tick();
		await host.scheduler.drain(10_000);
		const [startLine, endLine] = await waitForLines(events, 2);
		assert.ok(endLine, "a run fires both of its hooks");
		const start = JSON.parse(startLine);
		const end = JSON.parse(endLine);
		assert.equal(start.event, "run_start");
		assert.equal(end.event, "run_end");
		assert.equal(start.cwd, proj, "the payload names the run's project, not the host's empty cwd");
		assert.equal(start.session_id, end.session_id, "start and end carry the same run id, so a hook can pair them");
		assert.equal(start.model_provider, "default");
		// A run reports itself, so a rule about the conversation never sees one.
		assert.equal(start.run_job, "nightly");
		assert.equal(end.run_ok, true);
		assert.match(end.message_summary, /nightly/);
		assert.deepEqual([...new Set((await waitForLines(dirs, 2)).map((p) => fs.realpathSync(p)))], [fs.realpathSync(proj)], 'cwd = "project" is the job\'s directory');

		// The event the issue is about: last night's loop failed and nobody was watching.
		process.env.FAKE_PI_FAIL = "1";
		await host.scheduler.store.add(dueJob("cron-broken", "flaky", proj));
		await host.scheduler.tick();
		await host.scheduler.drain(10_000);
		const failed = JSON.parse((await waitForLines(events, 4)).at(-1)!);
		assert.equal(failed.event, "run_end");
		assert.equal(failed.run_ok, false, "$PI_RUN_OK is the failure test a hook branches on");
		assert.match(failed.message_summary, /flaky.*boom/);
	} finally {
		delete process.env.FAKE_PI_FAIL;
		await host.stop();
	}
});

test("a project's own hooks.toml runs in the host only for a directory pi already trusted", async () => {
	const hosted = (trusted: boolean) => {
		const dir = tmp("pi-loops-hostrt-");
		const proj = path.join(dir, "proj");
		fs.mkdirSync(path.join(proj, ".pi"), { recursive: true });
		const ran = path.join(dir, "ran.txt");
		// The user's own opt-in, the widest one there is: every project's hooks, everywhere.
		fs.writeFileSync(path.join(dir, "hooks.toml"), "allow_project_hooks = true\n");
		fs.writeFileSync(path.join(proj, ".pi", "hooks.toml"), `[[hook]]\nevent = "run_start"\ncommand = "echo ran >> ${ran}"\n`);
		const logs: string[] = [];
		const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: fakeRunner(), mcpTools: () => [], log: (m) => void logs.push(m), isProjectTrusted: () => trusted });
		return { dir, proj, ran, logs, host };
	};

	const untrusted = hosted(false);
	try {
		await untrusted.host.scheduler.store.add(dueJob("cron-untrusted", "nightly", untrusted.proj));
		await untrusted.host.scheduler.tick();
		await untrusted.host.scheduler.drain(10_000);
		await untrusted.host.stop(); // drains the hook queue: whatever was going to run has run by now
		assert.equal(fs.existsSync(untrusted.ran), false, "a job's cwd is not consent to run that directory's scripts");
		assert.ok(untrusted.logs.some((m) => /project hook/i.test(m)), `the host says why: ${untrusted.logs.join(" | ")}`);
	} finally {
		await untrusted.host.stop();
	}

	const trusted = hosted(true);
	try {
		await trusted.host.scheduler.store.add(dueJob("cron-trusted", "nightly", trusted.proj));
		await trusted.host.scheduler.tick();
		await trusted.host.scheduler.drain(10_000);
		await waitForLines(trusted.ran, 1);
		assert.equal(fs.readFileSync(trusted.ran, "utf8").trim(), "ran", "trusted + opted in: the project's rule fires");
	} finally {
		await trusted.host.stop();
	}
});

test("an interactive pi fires the same run events the host does", async () => {
	// The point of the separate pair: whether a job ran under the host or under a pi you left open
	// is an accident of who held the clock, so both must fire run_start/run_end and neither may
	// overload agent_* — a rule about your own turns must not start seeing automation.
	const { HOOK_EVENTS } = await import("../src/hooks.ts");
	assert.ok(HOOK_EVENTS.includes("run_start" as any) && HOOK_EVENTS.includes("run_end" as any));
	const source = fs.readFileSync(path.join(process.cwd(), "src", "pi-loops.ts"), "utf8");
	// The interactive side is not importable by tests (issue #8), so this asserts the wiring exists
	// rather than exercising it: both callbacks fire, and neither uses the conversation's events.
	const onRunStart = source.slice(source.indexOf("onRunStart:"), source.indexOf("onCatchUp:"));
	const onRunFinished = source.slice(source.indexOf("onRunFinished:"), source.indexOf("onInboxChanged:"));
	assert.match(onRunStart, /fireRunHook\(runStartEvent\(/);
	assert.match(onRunFinished, /fireRunHook\(runEndEvent\(/);
	for (const half of [onRunStart, onRunFinished]) assert.equal(/event: "agent_(start|end)"/.test(half), false);
});

/** A real pi session file the host may hold: written once, ten minutes ago, its lease free. */
function closedConversation(dir: string): { sessionId: string; file: string } {
	const sm = SessionManager.create(dir, dir);
	sm.appendMessage({ role: "user", content: "earlier", timestamp: Date.now() } as any);
	const file = sm.getSessionFile()!;
	const old = new Date(Date.now() - 10 * 60_000);
	fs.utimesSync(file, old, old);
	const sessionId = sm.getSessionId();
	fs.mkdirSync(path.join(dir, "leases"), { recursive: true });
	fs.writeFileSync(path.join(dir, "leases", `${sessionId}.json`), JSON.stringify({ v: 1, sessionId, sessionFile: file, cwd: dir, epoch: 1, holder: null, updatedAt: new Date().toISOString() }));
	return { sessionId, file };
}

test("a rule's promotion for a closed creating conversation is appended to it, and the conversation is given back", async () => {
	const dir = tmp("pi-loops-hostrt-");
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: fakeRunner(), mcpTools: () => [], log: () => undefined });
	try {
		const { sessionId, file } = closedConversation(dir);
		const rule = await host.triggers.store.add({ condition: "c", action: "a", cwd: dir, promoteToChat: true, sessionId });
		process.env.FAKE_PI_REPLY = `matched ${rule.id}: while you were away`;
		const out = await host.triggers.handle(buildPeriodicCheckTrigger(dir, 1), "sub_agent", [rule]);
		assert.equal(out?.promoted, true);
		const entries = SessionManager.open(file).getEntries() as any[];
		const appended = entries.find((e) => e.type === "custom_message" && e.customType === "pi-loops:trigger");
		assert.match(String(appended?.content), /^\[Trigger [^\]]+\] .*while you were away/s, "it is in the conversation, where a resume shows it");
		assert.equal(host.scheduler.inbox.listNew().length, 0, "and not in the inbox");
		assert.equal(new LeaseStore(dir).read(sessionId)?.holder, null, "the host held it for that one write");
		assert.equal(host.triggers.store.listAudit(50, (r) => r.state === "appended" && r.details?.session_id === sessionId).length, 1, "and the audit says so, for the since-you-looked count");
	} finally {
		delete process.env.FAKE_PI_REPLY;
		await host.stop();
	}
});

test("a rule's result for a closed conversation written moments ago waits in its queue, and the host appends it once the file is quiet", async () => {
	const dir = tmp("pi-loops-hostrt-");
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: fakeRunner(), mcpTools: () => [], log: () => undefined });
	try {
		const { sessionId, file } = closedConversation(dir);
		const now = new Date();
		fs.utimesSync(file, now, now); // someone wrote it just now
		const rule = await host.triggers.store.add({ condition: "c", action: "a", cwd: dir, promoteToChat: true, sessionId });
		process.env.FAKE_PI_REPLY = `matched ${rule.id}: the build is green`;
		await host.triggers.handle(buildPeriodicCheckTrigger(dir, 1), "sub_agent", [rule]);
		assert.equal(host.scheduler.inbox.listNew().length, 0, "not split off into the inbox");
		assert.equal(new Mailbox(dir).pending(sessionId).length, 1, "queued for the conversation");
		const old = new Date(Date.now() - 10 * 60_000);
		fs.utimesSync(file, old, old);
		await host.scheduler.tick();
		const entries = SessionManager.open(file).getEntries() as any[];
		assert.ok(entries.some((e) => e.type === "custom_message" && /the build is green/.test(String(e.content))), "delivered on the host's next tick");
		assert.equal(new Mailbox(dir).pending(sessionId).length, 0);
	} finally {
		delete process.env.FAKE_PI_REPLY;
		await host.stop();
	}
});

test("results queued for a conversation whose file is gone go to the inbox, marked for it, instead of waiting for ever", async () => {
	const dir = tmp("pi-loops-hostrt-");
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: fakeRunner(), mcpTools: () => [], log: () => undefined });
	try {
		const { sessionId, file } = closedConversation(dir);
		new Mailbox(dir).enqueue(sessionId, { id: "t-gone", text: "[Trigger t-gone] the deploy finished", cwd: dir, createdAt: new Date().toISOString() });
		fs.rmSync(file);
		await host.scheduler.tick();
		assert.equal(new Mailbox(dir).pending(sessionId).length, 0);
		const filed = host.scheduler.inbox.listNew();
		assert.deepEqual(filed.map((e) => [e.text, e.session_id]), [["the deploy finished", sessionId]]);
	} finally {
		await host.stop();
	}
});

test("a conversation left held for a turn that no longer runs is given back on the next tick", async () => {
	// The release at a turn's end can fail (a lock timeout, a full disk). The lease then named this
	// process, alive and "already working in it", and that conversation's plain jobs never ran again.
	const dir = tmp("pi-loops-hostrt-");
	const logs: string[] = [];
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: fakeRunner(), mcpTools: () => [], log: (m) => void logs.push(m) });
	try {
		const { sessionId } = closedConversation(dir);
		const lease = JSON.parse(fs.readFileSync(path.join(dir, "leases", `${sessionId}.json`), "utf8"));
		const since = new Date(Date.now() - 5 * 60_000).toISOString();
		lease.holder = { kind: "host", pid: process.pid, instance: "host", procStart: procStart(process.pid), acquiredAt: since, pushServers: [], busy: { runId: "run-gone", since } };
		fs.writeFileSync(path.join(dir, "leases", `${sessionId}.json`), JSON.stringify(lease));
		await host.scheduler.tick();
		assert.equal(new LeaseStore(dir).read(sessionId)?.holder, null, "given back");
		assert.ok(logs.some((l) => /gave back session .* run-gone/.test(l)));
	} finally {
		await host.stop();
	}
});

test("a held turn runs in the closed conversation's file and stops once a window takes the conversation back", async () => {
	const dir = tmp("pi-loops-hostrt-");
	const seen: any[] = [];
	const { sessionId, file } = closedConversation(dir);
	// The runner does what src/sdk-runner.ts does with `stillHolds`: asks on every event, and stops.
	const runner = async (req: any) => {
		seen.push({ kind: req.kind, sessionFile: req.sessionFile, before: req.stillHolds() });
		new LeaseBinding(new LeaseStore(dir), "w1", () => ({ kind: "terminal", pid: process.pid, mode: "tui", pushServers: [] })).bind(sessionId);
		const after = req.stillHolds();
		seen.push({ after });
		return { ok: false, exitCode: 1, timedOut: false, text: "", errorMessage: "taken back", stopReason: "aborted", usage: { input: 0, output: 0, cost: 0, turns: 0 } } as any;
	};
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner, mcpTools: () => [], log: () => undefined });
	try {
		await host.scheduler.store.add({ id: "cron-held", schedule: { kind: "every", ms: 60_000 }, stateful: false, sessionId, prompt: "remind me", cwd: dir, enabled: true, catchUp: false, createdAt: new Date(Date.now() - 90_000).toISOString(), runCount: 0, skippedOverlap: 0 });
		await host.scheduler.tick();
		await host.scheduler.drain(5000);
		assert.deepEqual(seen[0], { kind: "held", sessionFile: file, before: true }, "the turn runs in that conversation's own file, holding it");
		assert.deepEqual(seen[1], { after: false }, "the window's acquisition is what the turn sees");
		const job = host.scheduler.store.load()[0];
		assert.equal(job.runCount, 0, "the interrupted turn is not counted");
		assert.equal(job.lastFiredAt, undefined, "its slot is owed to the window now holding the conversation");
	} finally {
		await host.stop();
	}
});
