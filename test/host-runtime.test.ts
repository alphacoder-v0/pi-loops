import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig } from "../src/config.ts";
import { createHostRuntime, type HostRuntime } from "../src/host-runtime.ts";
import { LoopScheduler } from "../src/scheduler.ts";
import { mapNotification } from "../src/mcp.ts";
import { buildPeriodicCheckTrigger } from "../src/triggers.ts";
import { fakeRunner } from "./fake-runner.ts";
import { LeaseBinding, LeaseStore, procStart } from "../src/lease.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { RequestStore } from "../src/requests.ts";
import { inboxClaimRow, personRow, ruleResultRow, stopRow } from "../src/engine.ts";

test("a row the background cannot run does not cost a read of the conversation on every tick", async () => {
	// An attended row (a claim typed in a window that is gone) waits for a window for as long as it
	// takes; the host used to parse the whole conversation on every tick to find that out again.
	// Now it reads the file only when the file, jobs.json or the queue changed. The proof: the
	// file's content is swapped for one that would prove the row delivered, with the same size and
	// mtime; a host that re-read it would remove the row, and this one does not until the mtime moves.
	const dir = tmp("pi-loops-hostrt-");
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: fakeRunner(), mcpTools: () => [], log: () => undefined });
	try {
		const sm = SessionManager.create(dir, dir);
		sm.appendMessage({ role: "user", content: "x".repeat(80), timestamp: Date.now() } as any);
		const file = sm.getSessionFile()!;
		const sessionId = sm.getSessionId();
		const old = new Date(Date.now() - 10 * 60_000);
		fs.utimesSync(file, old, old);
		fs.mkdirSync(path.join(dir, "leases"), { recursive: true });
		fs.writeFileSync(path.join(dir, "leases", `${sessionId}.json`), JSON.stringify({ v: 1, sessionId, sessionFile: file, cwd: dir, epoch: 1, holder: null, updatedAt: new Date().toISOString() }));
		const row = inboxClaimRow("look into finding f1", "f1", { sessionId, cwd: dir, createdBy: { pid: 1, instance: "w", version: "0" } });
		new RequestStore(dir).append(row);
		await host.scheduler.tick();
		assert.equal(new RequestStore(dir).list(sessionId).length, 1, "waits for a window");
		// The same bytes, apart from the message now carrying the row's proof.
		const prefix = `[Trigger ${row.id}] `;
		const before = fs.statSync(file);
		fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("x".repeat(80), prefix + "x".repeat(80 - prefix.length)));
		fs.utimesSync(file, before.atime, before.mtime);
		assert.equal(fs.statSync(file).size, before.size);
		await host.scheduler.tick();
		await host.scheduler.tick();
		assert.equal(new RequestStore(dir).list(sessionId).length, 1, "unchanged size and mtime: the conversation was not read again");
		fs.utimesSync(file, new Date(Date.now() - 9 * 60_000), new Date(Date.now() - 9 * 60_000));
		await host.scheduler.tick();
		assert.equal(new RequestStore(dir).list(sessionId).length, 0, "the mtime moved: read, and the proof found");
	} finally {
		await host.stop();
	}
});

test("the tick sweeps image files no request names, a minute after they were written", async () => {
	const dir = tmp("pi-loops-hostrt-");
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: fakeRunner(), mcpTools: () => [], log: () => undefined });
	try {
		// A person row for a conversation that exists: the background cannot run it (attended), so it
		// waits in the file with its images, and the sweep must leave those alone.
		const { sessionId } = closedConversation(dir);
		const store = new RequestStore(dir);
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		store.append(personRow("p1", "kept", [image], { sessionId, cwd: dir, createdBy: { pid: process.pid, instance: "web", version: "0" } }), [image]);
		const old = path.join(dir, "requests", `${sessionId}.${"c".repeat(32)}.images.json`);
		const young = path.join(dir, "requests", `${sessionId}.${"d".repeat(32)}.images.json`);
		fs.writeFileSync(old, "[]");
		fs.writeFileSync(young, "[]");
		const twoMinutesAgo = new Date(Date.now() - 120_000);
		fs.utimesSync(old, twoMinutesAgo, twoMinutesAgo);
		await host.scheduler.tick();
		assert.deepEqual([fs.existsSync(old), fs.existsSync(young), fs.existsSync(store.imageFile(sessionId, "p1"))], [false, true, true], "the old orphan went; a young one and a row's file stayed");
		assert.equal(store.list(sessionId).length, 1, "and the row still waits for a window");
	} finally {
		await host.stop();
	}
});

test("a quiet queue is decided again when a row's backoff ends, with no file changed", async () => {
	const dir = tmp("pi-loops-hostrt-");
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: fakeRunner(), mcpTools: () => [], log: () => undefined });
	try {
		const { sessionId, file } = closedConversation(dir);
		new RequestStore(dir).append({ ...resultRow(sessionId, "t-later", dir), attempts: 1, not_before: new Date(Date.now() + 400).toISOString() });
		await host.scheduler.tick();
		await host.scheduler.tick();
		assert.equal(inConversation(file, "t-later"), false, "backing off: nothing to do yet");
		await new Promise((r) => setTimeout(r, 500));
		await host.scheduler.tick();
		assert.equal(inConversation(file, "t-later"), true, "the backoff ended: appended, though no file changed");
	} finally {
		await host.stop();
	}
});
import { stamp } from "../src/schedule.ts";


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

test("the host runs loops and queues a promotion for the creating session when a window holds it, and files one with no creating session in the inbox; sub-agent tools act in the run's cwd", async () => {
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
		assert.match(new RequestStore(dir).list("held")[0]?.payload?.text ?? "", /for the window/, "queued for the holding window");
		// The same rule's conversation closed and its file unknown to pi-loops: nothing can ever take a
		// row, so the inbox at once, marked for it, as 0.23 routed it.
		const closed = await host.triggers.store.add({ condition: "c", action: "a", cwd: proj, promoteToChat: true, sessionId: "closed" });
		process.env.FAKE_PI_REPLY = `matched ${closed.id}: for later`;
		await host.triggers.handle(buildPeriodicCheckTrigger(proj, 1), "sub_agent", [closed]);
		assert.equal(host.scheduler.inbox.listNew().find((e) => e.text.includes("for later"))?.session_id, "closed");
		assert.equal(new RequestStore(dir).list("closed").length, 0, "and no row waits for it");

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

		// An interactive scheduler on the same store still queues them for its chat.
		const pi = new LoopScheduler({ dir, runner: fake, kind: "interactive", getSession: () => ({ sessionId: "s1", cwd: proj }) });
		try {
			await pi.tick();
			await pi.drain(5000);
			assert.equal(new RequestStore(dir).list("s1").length, 2, "the chat that owns them gets both");
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

test("a rule's result for a conversation open in a 0.22 window goes to the inbox, marked for it", async () => {
	// That window never reads requests/: a row would wait until it closed, unseen while the person is in it.
	const dir = tmp("pi-loops-hostrt-");
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: fakeRunner(), mcpTools: () => [], log: () => undefined });
	try {
		const { sessionId } = closedConversation(dir);
		fs.mkdirSync(path.join(dir, "presence"), { recursive: true });
		fs.writeFileSync(path.join(dir, "presence", `old-${process.pid}-w22.json`), JSON.stringify({ pid: process.pid, host: os.hostname(), instance: "w22", sessionId, cwd: dir, kind: "interactive", heartbeatAt: new Date().toISOString() }));
		const rule = await host.triggers.store.add({ condition: "c", action: "a", cwd: dir, promoteToChat: true, sessionId });
		process.env.FAKE_PI_REPLY = `matched ${rule.id}: for the old window`;
		await host.triggers.handle(buildPeriodicCheckTrigger(dir, 1), "sub_agent", [rule]);
		const found = host.scheduler.inbox.listNew();
		assert.deepEqual([found.length, found[0]?.session_id], [1, sessionId]);
		assert.deepEqual(new RequestStore(dir).list(sessionId), [], "and no row waits for it");
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
		assert.equal(new RequestStore(dir).list(sessionId).length, 1, "queued for the conversation");
		const old = new Date(Date.now() - 10 * 60_000);
		fs.utimesSync(file, old, old);
		await host.scheduler.tick();
		const entries = SessionManager.open(file).getEntries() as any[];
		assert.ok(entries.some((e) => e.type === "custom_message" && /the build is green/.test(String(e.content))), "delivered on the host's next tick");
		assert.equal(new RequestStore(dir).list(sessionId).length, 0);
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
		new RequestStore(dir).append(ruleResultRow(sessionId, "[Trigger t-gone] the deploy finished", { traceId: "t-gone", sourceLabel: "local:dynamic", cwd: dir }, { pid: 1, instance: "w", version: "0" }));
		fs.rmSync(file);
		await host.scheduler.tick();
		assert.equal(new RequestStore(dir).list(sessionId).length, 0);
		const filed = host.scheduler.inbox.listNew();
		assert.deepEqual(filed.map((e) => [e.text, e.session_id, e.source]), [["the deploy finished", sessionId, "trigger:local:dynamic"]]);
		assert.equal(host.triggers.store.listAudit(10, (r) => r.type === "request" && r.state === "dead").length, 1, "and the audit says why");
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

const resultRow = (sessionId: string, id: string, dir: string) => ruleResultRow(sessionId, `[Trigger ${id}] while you were away`, { traceId: id, sourceLabel: "local:dynamic", cwd: dir }, { pid: 1, instance: "w", version: "0" });
const inConversation = (file: string, id: string) => (SessionManager.open(file).getEntries() as any[]).some((e) => e.type === "custom_message" && String(e.content).includes(`[Trigger ${id}]`));
async function until(check: () => boolean, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
	return check();
}

test("a row for a closed session lands within one tick with every bell lost", async () => {
	const dir = tmp("pi-loops-hostrt-");
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: fakeRunner(), mcpTools: () => [], log: () => undefined });
	try {
		const { sessionId, file } = closedConversation(dir);
		// Not started: no watcher, and nobody rings. Only the tick can deliver.
		new RequestStore(dir).append(resultRow(sessionId, "t-lost", dir));
		assert.equal(await until(() => inConversation(file, "t-lost"), 300), false, "nothing but the tick delivers here");
		await host.scheduler.tick();
		assert.equal(inConversation(file, "t-lost"), true, "one tick carries it");
		assert.deepEqual(new RequestStore(dir).list(sessionId), []);
	} finally {
		await host.stop();
	}
});

test("a row for a closed session lands without waiting for the tick", async () => {
	const dir = tmp("pi-loops-hostrt-");
	let ticks = 0;
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: fakeRunner(), mcpTools: () => [], log: () => undefined, onTick: () => void ticks++ });
	try {
		const { sessionId, file } = closedConversation(dir);
		host.start(); // ticks once now, then every 30 s: the first tick has read requests/ before the row exists
		assert.equal(await until(() => ticks >= 1, 5000), true);
		new RequestStore(dir).append(resultRow(sessionId, "t-rung", dir));
		assert.equal(await until(() => inConversation(file, "t-rung"), 3000), true, "the watcher on requests/ rang");
		assert.equal(ticks, 1, "and no tick explains it");
		// A conversation given back while a row waits: the watcher on leases/ rings it.
		const leases = new LeaseStore(dir);
		const window = { kind: "terminal" as const, pid: process.pid, instance: "w", acquiredAt: new Date().toISOString(), pushServers: [] };
		assert.ok("lease" in leases.acquire(sessionId, window, { sessionFile: file, cwd: dir }), "a live window takes the conversation");
		await new Promise((r) => setTimeout(r, 100));
		new RequestStore(dir).append(resultRow(sessionId, "t-held", dir));
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(inConversation(file, "t-held"), false, "while a live window holds it, the row is the window's");
		assert.equal(leases.read(sessionId)?.holder?.instance, "w");
		// Given back, its file long quiet (a window's release clears the host's own-write marker).
		const old = new Date(Date.now() - 10 * 60_000);
		fs.utimesSync(file, old, old);
		leases.release(sessionId, window);
		assert.equal(await until(() => inConversation(file, "t-held"), 3000), true, "the release rang it");
		assert.equal(ticks, 1);
	} finally {
		await host.stop();
	}
});

// Bounded: the defect this guards is a loop of self-rings, which shows as a hang, not a failed assertion.
test("a delivery that changes nothing does not ring itself again", { timeout: 30_000 }, async () => {
	const dir = tmp("pi-loops-hostrt-");
	const logs: string[] = [];
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: fakeRunner(), mcpTools: () => [], log: (m) => void logs.push(m) });
	try {
		const { sessionId, file } = closedConversation(dir);
		const leases = new LeaseStore(dir);
		host.start();
		await new Promise((r) => setTimeout(r, 100));
		// A row the host appends: taking the lease, rewriting the queue and giving the lease back each
		// ring this process, and each ring finds nothing left to do.
		new RequestStore(dir).append(resultRow(sessionId, "t-once", dir));
		assert.equal(await until(() => inConversation(file, "t-once"), 3000), true);
		await new Promise((r) => setTimeout(r, 500));
		assert.equal(leases.read(sessionId)?.epoch, 3, "taken once and given back once, then quiet");
		// A row that must wait (in backoff): the lease is not taken for it at all.
		new RequestStore(dir).append({ ...resultRow(sessionId, "t-waits", dir), attempts: 1, not_before: new Date(Date.now() + 3600_000).toISOString() });
		await new Promise((r) => setTimeout(r, 500));
		assert.equal(leases.read(sessionId)?.epoch, 3, "a drain that would only wait writes nothing");
		assert.equal(new RequestStore(dir).list(sessionId).length, 1);
		assert.deepEqual(logs.filter((l) => /doorbell|watch/.test(l)), []);
	} finally {
		await host.stop();
	}
});

test("a ring reads a closed conversation without writing it, even one pi would migrate", async () => {
	const dir = tmp("pi-loops-hostrt-");
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: fakeRunner(), mcpTools: () => [], log: () => undefined });
	try {
		const { sessionId, file } = closedConversation(dir);
		// An older session format: opening it through pi's SessionManager rewrites it.
		const [header, ...rest] = fs.readFileSync(file, "utf8").split("\n");
		fs.writeFileSync(file, [JSON.stringify({ ...JSON.parse(header), version: 2 }), ...rest].join("\n"));
		const old = new Date(Date.now() - 10 * 60_000);
		fs.utimesSync(file, old, old);
		const before = { text: fs.readFileSync(file, "utf8"), mtime: fs.statSync(file).mtimeMs };
		new RequestStore(dir).append({ ...resultRow(sessionId, "t-waits", dir), attempts: 1, not_before: new Date(Date.now() + 3600_000).toISOString() });
		host.ring(sessionId);
		await new Promise((r) => setTimeout(r, 200));
		assert.deepEqual({ text: fs.readFileSync(file, "utf8"), mtime: fs.statSync(file).mtimeMs }, before, "nobody holds the lease, so nothing may write the file");
	} finally {
		await host.stop();
	}
});

// Bounded: the defect this guards is a loop of self-rings, which starves timers and shows as a hang.
test("a delivery that fails is left to the tick instead of ringing itself again", { timeout: 30_000 }, async () => {
	const dir = tmp("pi-loops-hostrt-");
	const logs: string[] = [];
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: fakeRunner(), mcpTools: () => [], log: (m) => void logs.push(m) });
	try {
		const { sessionId } = closedConversation(dir);
		// A dead letter goes to an inbox this process cannot write: every delivery of it fails.
		fs.writeFileSync(path.join(dir, "inbox.jsonl"), "");
		fs.chmodSync(path.join(dir, "inbox.jsonl"), 0o444);
		host.start();
		await new Promise((r) => setTimeout(r, 100));
		new RequestStore(dir).append({ ...resultRow(sessionId, "t-dead", dir), attempts: 3 });
		await new Promise((r) => setTimeout(r, 1000));
		const failures = logs.filter((l) => l.startsWith(`requests for session ${sessionId.slice(0, 8)}`));
		assert.ok(failures.length >= 1 && failures.length <= 2, `failed once, then quiet until the tick: ${failures.length} failures logged`);
	} finally {
		fs.chmodSync(path.join(dir, "inbox.jsonl"), 0o644);
		await host.stop();
	}
});

test("a stop row aborts the held turn running in that conversation", { timeout: 30_000 }, async () => {
	const dir = tmp("pi-loops-hostrt-");
	const { sessionId } = closedConversation(dir);
	let started = false;
	const ended: string[] = [];
	// A runner that runs until it is told to stop, as a model turn does.
	const runner = async (req: any) => {
		started = true;
		await new Promise<void>((r) => (req.signal.aborted ? r() : req.signal.addEventListener("abort", () => r(), { once: true })));
		ended.push("aborted");
		return { ok: false, exitCode: 1, timedOut: false, text: "", errorMessage: "aborted", stopReason: "aborted", usage: { input: 0, output: 0, cost: 0, turns: 0 } } as any;
	};
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner, mcpTools: () => [], log: () => undefined });
	try {
		await host.scheduler.store.add({ id: "cron-held", schedule: { kind: "every", ms: 60_000 }, stateful: false, sessionId, prompt: "remind me", cwd: dir, enabled: true, catchUp: false, createdAt: new Date(Date.now() - 90_000).toISOString(), runCount: 0, skippedOverlap: 0 });
		await host.scheduler.tick();
		assert.equal(await until(() => started, 5000), true, "the held turn is running");
		const leases = new LeaseStore(dir);
		assert.ok(leases.read(sessionId)?.holder?.busy?.runId, "the lease names the turn");
		const requests = new RequestStore(dir);
		const stop = stopRow(sessionId, { current: true, started_before: stamp() }, "cli", { pid: 1, instance: "cli", version: "0" });
		requests.append(stop);
		host.ring(sessionId);
		assert.equal(await until(() => ended.length === 1, 5000), true, "the turn stopped on the bell, with the socket never asked");
		await host.scheduler.drain(5000);
		assert.deepEqual(requests.list(sessionId), [], "the stop row is done");
		assert.equal(host.triggers.store.listAudit(1, (r) => r.type === "request" && r.traceId === stop.id)[0]?.state, "done");
		assert.equal(host.scheduler.store.listRuns("cron-held")[0]?.ok, false, "the stopped turn is recorded");
		assert.equal(leases.read(sessionId)?.holder, null, "and the conversation given back");
	} finally {
		await host.stop();
	}
});

/** A runner that writes its prompt into the conversation at once, as pi does at message_end, then runs until stopped. */
function runnerUntilStopped(prompts: string[]) {
	return async (req: any) => {
		prompts.push(req.prompt);
		SessionManager.open(req.sessionFile).appendMessage({ role: "user", content: req.prompt, timestamp: Date.now() } as any);
		await new Promise<void>((r) => (req.signal.aborted ? r() : req.signal.addEventListener("abort", () => r(), { once: true })));
		return { ok: false, exitCode: 1, timedOut: false, text: "", errorMessage: "aborted", stopReason: "aborted", usage: { input: 0, output: 0, cost: 0, turns: 0 } } as any;
	};
}
const heldJob = (sessionId: string, dir: string) => ({ id: "cron-held", schedule: { kind: "every" as const, ms: 3_600_000 }, stateful: false, sessionId, prompt: "remind me", cwd: dir, enabled: true, catchUp: false, createdAt: new Date(Date.now() - 3_700_000).toISOString(), runCount: 0, skippedOverlap: 0 });

test("a held turn a person stopped runs exactly once: no successor row, no owed slot", { timeout: 30_000 }, async () => {
	const dir = tmp("pi-loops-hostrt-");
	const { sessionId } = closedConversation(dir);
	const prompts: string[] = [];
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: runnerUntilStopped(prompts), mcpTools: () => [], log: () => undefined });
	try {
		await host.scheduler.store.add(heldJob(sessionId, dir));
		await host.scheduler.tick();
		assert.equal(await until(() => prompts.length === 1, 5000), true);
		const requests = new RequestStore(dir);
		requests.append(stopRow(sessionId, { current: true, started_before: stamp() }, "cli", { pid: 1, instance: "cli", version: "0" }));
		host.ring(sessionId);
		await host.scheduler.drain(5000);
		assert.deepEqual(requests.list(sessionId), [], "no successor row asks the stopped prompt again");
		const job = host.scheduler.store.load()[0];
		assert.equal(job.owedSlot, undefined, "the slot is spent");
		assert.equal(job.runCount, 1);
		await host.scheduler.tick();
		await host.scheduler.drain(5000);
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(prompts.length, 1, "the next tick does not run it again");
	} finally {
		await host.stop();
	}
});

test("a stop read by the held turn's own first drain stops it", { timeout: 30_000 }, async () => {
	const dir = tmp("pi-loops-hostrt-");
	const { sessionId } = closedConversation(dir);
	const prompts: string[] = [];
	const requests = new RequestStore(dir);
	let stop: ReturnType<typeof stopRow> | undefined;
	// Written the moment the turn exists (its first log line), before the turn's own first drain reads the file.
	const log = (line: string) => {
		if (stop || !/turn run-[0-9a-f]+ in session/.test(line)) return;
		stop = stopRow(sessionId, { current: true, started_before: stamp(Date.now() + 1_000) }, "cli", { pid: 1, instance: "cli", version: "0" });
		requests.append(stop);
	};
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: runnerUntilStopped(prompts), mcpTools: () => [], log });
	try {
		await host.scheduler.store.add(heldJob(sessionId, dir));
		await host.scheduler.tick();
		assert.equal(await until(() => stop !== undefined, 5000), true, "the turn began");
		assert.ok(stop);
		await host.scheduler.drain(5000);
		assert.equal(host.triggers.store.listAudit(1, (r) => r.type === "request" && r.traceId === stop.id)[0]?.state, "done", "the stop named the run");
		assert.equal(prompts.length, 0, "stopped before the model was asked");
		assert.deepEqual(requests.list(sessionId), []);
		assert.equal(host.scheduler.store.load()[0].runCount, 1, "done, not owed");
	} finally {
		await host.stop();
	}
});

test("the background process removes a person row for a conversation that is gone as stale, and files no finding", async () => {
	const dir = tmp("pi-loops-hostrt-");
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: fakeRunner(), mcpTools: () => [], log: () => undefined });
	try {
		const store = new RequestStore(dir);
		// A page's pi whose extension is not loaded writes no lease; the page still writes the row.
		store.append(personRow("p1", "please do not lose this", undefined, { sessionId: "nolease", cwd: dir, createdBy: { pid: process.pid, instance: "page", version: "0" } }, Date.now()));
		assert.equal(fs.existsSync(path.join(dir, "leases", "nolease.json")), false);
		await host.scheduler.tick();
		assert.deepEqual(store.list("nolease"), [], "the row is gone from the queue");
		assert.deepEqual(host.scheduler.inbox.listNew(), [], "a person's message never goes to the inbox");
		const audit = host.triggers.store.listAudit(5).find((a) => a.traceId === "p1");
		assert.deepEqual([audit?.state, (audit?.details as any)?.reason], ["stale", "its conversation is gone"]);
	} finally {
		await host.stop();
	}
});
