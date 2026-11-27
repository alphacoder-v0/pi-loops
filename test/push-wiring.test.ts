import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { loadConfig } from "../src/config.ts";
import { EventLog } from "../src/events.ts";
import { createHostRuntime } from "../src/host-runtime.ts";
import { checkLane } from "../src/lane.ts";
import { injectPush, pushRowId, pushTrigger } from "../src/push.ts";
import { RequestStore } from "../src/requests.ts";
import { TriggerStore } from "../src/triggers.ts";
import { holdUpgrade, resumeUpgrade } from "../src/upgrade-hold.ts";

const USAGE = { input: 1, output: 1, cost: 0.01, turns: 1 };
const note = (key: string | undefined, summary = "build red") => ({ method: "ci/build", params: { _meta: { ...(key ? { pi_dedup_key: key } : {}), pi_summary: summary } } });

/** pi-loops in the background with one project that has a rule; its runner holds every check until `release`. */
async function background(over: { budget?: number; runner?: (req: any) => Promise<any> } = {}) {
	const dir = tmp("pi-loops-push-wiring-");
	const project = path.join(dir, "project");
	fs.mkdirSync(project, { recursive: true });
	if (over.budget !== undefined) fs.writeFileSync(path.join(dir, "config.toml"), `[limits]\ndaily_budget_usd = ${over.budget}\n`);
	const calls: any[] = [];
	const runner = async (req: any) => { calls.push(req); return over.runner ? over.runner(req) : { ok: true, exitCode: 0, timedOut: false, text: "nothing matched", usage: USAGE }; };
	const start = () => {
		const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner, mcpTools: () => [], log: () => undefined });
		// As host.ts at start, before any push can arrive: this start's pushes are derived from here on.
		host.rederivePushes((server) => server === "ci");
		return host;
	};
	const host = start();
	await host.stores.rules.add({ condition: "a build fails", action: "say so", cwd: project });
	const lines = () => fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	return { dir, project, host, start, calls, lines, lane: checkLane(project)!, requests: new RequestStore(dir) };
}

test("[push-raw-first] a push reaches events.jsonl as received before any row names it; one that maps to no trigger stays there and makes no row", async () => {
	const b = await background();
	assert.equal(b.host.receivePush("ci", "sub_agent", note("k1")), true);
	const [stored] = b.lines();
	assert.deepEqual([stored.source, stored.receiver.kind, JSON.parse(stored.raw)], ["mcp:ci", "background", note("k1")], "the notification as received");
	await b.host.drain(5000);
	const record = b.host.stores.jobs.allRuns().find((r) => r.runId === pushRowId(stored.id, b.project));
	assert.equal(record?.cause, "push", "its row ran, and the row was the stored event's");
	assert.equal(b.calls.length, 1);
	assert.equal(b.host.receivePush("ci", "sub_agent", note(undefined)), false, "no dedup key: dropped at the adapter");
	assert.equal(b.lines().length, 2, "but stored first");
	assert.deepEqual(b.requests.list(b.lane), []);
	assert.equal(b.calls.length, 1, "and never checked");
});

test("[push-rederive-on-start] a push stored with no row (a crash between the two) gets its row at start; one proved done, one too old, or a server that injects gets none", async () => {
	const b = await background();
	const events = new EventLog(b.dir, "background");
	const lost = events.append("mcp:ci", JSON.stringify(note("k1")));
	const injecting = events.append("mcp:chat", JSON.stringify(note("k2")));
	// A push stored ten minutes ago: outside the window a restart looks back over.
	const old = { id: "evt-old", received_at: new Date(Date.now() - 10 * 60_000).toISOString(), source: "mcp:ci", receiver: { pid: process.pid, kind: "background" }, raw: JSON.stringify(note("k3")) };
	const file = path.join(b.dir, "events.jsonl");
	fs.writeFileSync(file, `${JSON.stringify(old)}\n${fs.readFileSync(file, "utf8")}`);
	assert.equal(b.host.rederivePushes((server) => server === "ci"), 1);
	assert.deepEqual(b.requests.list(b.lane).map((r) => r.id), [pushRowId(lost.id, b.project)]);
	assert.equal(b.requests.list(b.lane).some((r) => r.payload?.events?.includes(injecting.id)), false);
	assert.equal(b.host.rederivePushes((server) => server === "ci"), 0, "a second start writes nothing more");
	await b.host.riders["check-lanes"](Date.now(), { startedAt: 0, tickMs: 30_000 });
	await b.host.drain(5000);
	assert.equal(b.calls.length, 1);
	assert.equal(b.host.rederivePushes((server) => server === "ci"), 0, "a row proved done is not written again");
});

test("[push-window-inject] an injecting push is stored with its receiver, delivered once, and deduped only against this process's own pushes", async () => {
	const dir = tmp("pi-loops-push-inject-");
	const audit = new TriggerStore(dir);
	const promoted: string[] = [];
	const deps = (events: EventLog, over: { over?: boolean } = {}) => ({ events, audit, budget: () => ({ spent: 2, cap: 1, over: over.over ?? false }), promote: (c: string) => { promoted.push(c); return "chat" as const; }, injectAndRun: () => "inbox" as const, log: () => undefined, now: Date.now });
	const window = new EventLog(dir, "window");
	const first = window.append("mcp:hub", JSON.stringify(note("k1", "deploy finished")));
	assert.equal(first.receiver.kind, "window");
	const out = await injectPush(deps(window), first, pushTrigger(first)!, "inject_summary");
	assert.equal(out?.ok, true);
	assert.deepEqual(promoted, [`[Trigger ${first.id}] ci/build deploy finished`]);
	const again = window.append("mcp:hub", JSON.stringify(note("k1", "deploy finished")));
	assert.equal(await injectPush(deps(window), again, pushTrigger(again)!, "inject_summary"), undefined, "the same key again in this process");
	assert.ok(audit.listAudit(10, (r) => r.traceId === again.id).some((r) => r.state === "deduped"));
	// Another window that has the server injects it too: its own copy, in its own conversation.
	const other = { ...again, id: "evt-other", receiver: { pid: process.pid + 1, kind: "window" as const } };
	const sees = { since: () => [first, other] } as unknown as EventLog;
	assert.equal((await injectPush(deps(sees), other, pushTrigger(other)!, "inject_summary"))?.ok, true, "another process's push with the same key does not dedup it");
	// Over budget a summary still arrives (it costs nothing); a turn does not.
	const third = window.append("mcp:hub", JSON.stringify(note("k3")));
	assert.equal((await injectPush(deps(window, { over: true }), third, pushTrigger(third)!, "inject_summary"))?.ok, true);
	const fourth = window.append("mcp:hub", JSON.stringify(note("k4")));
	assert.equal(await injectPush(deps(window, { over: true }), fourth, pushTrigger(fourth)!, "inject_and_run"), undefined);
	assert.ok(audit.listAudit(10, (r) => r.traceId === fourth.id).some((r) => r.state === "budget_exceeded"));
	// A turn that went to the inbox says so in its audit row.
	const fifth = window.append("mcp:hub", JSON.stringify(note("k5")));
	const inboxed = await injectPush(deps(window), fifth, pushTrigger(fifth)!, "inject_and_run");
	assert.equal(inboxed?.promoted, false);
	assert.equal((audit.listAudit(10, (r) => r.traceId === fifth.id && r.type === "trigger_result")[0]?.details as any)?.to, "inbox");
});

test("[push-rederive-on-start] a project's own server's push is written again in that project only, and an injecting one is never checked", async () => {
	const b = await background();
	const other = path.join(b.dir, "other");
	fs.mkdirSync(other);
	await b.host.stores.rules.add({ condition: "something else", action: "x", cwd: other });
	const events = new EventLog(b.dir, "background");
	const own = events.append("mcp:repo", JSON.stringify(note("k1")), { project: b.project, delivery: "sub_agent" });
	events.append("mcp:repo", JSON.stringify(note("k2")), { project: b.project, delivery: "inject_summary" });
	// No user-level server is named "repo": the event says what it is.
	assert.equal(b.host.rederivePushes(() => false), 1);
	assert.deepEqual(b.requests.list(b.lane).map((r) => r.id), [pushRowId(own.id, b.project)]);
	assert.deepEqual(b.requests.list(checkLane(other)!), [], "another project's rules never see it");
});

test("[push-crash-none-lost] through receivePush: a project's push is stored with its project, and a flood of large pushes leaves the event of a row that still runs readable", async () => {
	const dir = tmp("pi-loops-push-flood-");
	const project = path.join(dir, "project");
	fs.mkdirSync(project, { recursive: true });
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: async () => { await held; return { ok: true, exitCode: 0, timedOut: false, text: "nothing matched", usage: USAGE }; }, mcpTools: () => [], log: () => undefined });
	await host.stores.rules.add({ condition: "a build fails", action: "say so", cwd: project });
	const events = new EventLog(dir, "background");
	try {
		assert.equal(host.receivePush("repo", "sub_agent", note("k1"), project), true);
		const [first] = events.since(0);
		assert.deepEqual([first.project, first.delivery], [project, "sub_agent"], "the receipt is stored with the push");
		await new Promise((resolve) => setTimeout(resolve, 50));
		const lane = checkLane(project)!;
		assert.equal(new RequestStore(dir).list(lane).filter((r) => r.run).length, 1, "its check runs and holds its row");
		// A server with no rule pushing 3 MB: two rotations of a 2 MB log.
		for (let i = 0; i < 6; i++) host.receivePush("noisy", "sub_agent", { method: "x/y", params: { _meta: { pi_dedup_key: `n${i}` }, data: "x".repeat(500_000) } });
		assert.equal(events.get(first.id)?.raw, JSON.stringify(note("k1")), "the running row's event survived the flood");
	} finally {
		release();
		await host.drain(5000);
	}
});

test("[push-rederive-on-start] a push that was derived is never derived again at start, whatever became of its row: refused, or joined or replaced into a row that was refused", async () => {
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	const b = await background({ budget: 0.5, runner: async () => { await held; return { ok: true, exitCode: 0, timedOut: false, text: "nothing matched", usage: USAGE }; } });
	const listChanged = { method: "notifications/tools/listChanged", params: {} };
	b.host.receivePush("ci", "sub_agent", note("k1"));
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(b.requests.list(b.lane).filter((r) => r.run).length, 1, "the first push's check runs and holds the lane");
	b.host.receivePush("ci", "sub_agent", note("k2"));
	b.host.receivePush("ci", "sub_agent", note("k2"));
	b.host.receivePush("ci", "sub_agent", listChanged);
	b.host.receivePush("ci", "sub_agent", listChanged);
	const [, k2, joined, tools, replacing] = b.lines();
	assert.ok(b.host.stores.rules.listAudit(50, (r) => r.traceId === pushRowId(joined.id, b.project)).some((r) => r.state === "deduped"), "the second k2 joined the first one's row");
	assert.deepEqual(b.requests.list(b.lane).filter((r) => !r.run).map((r) => r.id), [pushRowId(k2.id, b.project), pushRowId(tools.id, b.project)], "two rows wait; the second tools push replaced the first one's");
	// The day goes over budget while they wait: both leave refused, with no run record.
	b.host.stores.jobs.appendRun({ runId: "spent", jobId: "x", stateful: true, cwd: b.dir, pid: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ok: true, findings: 0, droppedFindings: 0, stateUpdated: false, usage: { ...USAGE, cost: 1 } });
	release();
	await b.host.drain(5000);
	await b.host.riders["check-lanes"](Date.now(), { startedAt: 0, tickMs: 30_000 });
	await b.host.drain(5000);
	assert.deepEqual(b.requests.list(b.lane), [], "the waiting rows left refused");
	const next = b.start();
	assert.deepEqual(b.requests.list(b.lane), [], "the restart writes no row for any of them");
	assert.equal(next.rederivePushes((server) => server === "ci"), 0);
	assert.ok(replacing, "five pushes stored");
});

test("[push-rederive-on-start] the first start of this version, or a clock.json that was lost, derives no push stored before it: a push is lost before it runs twice", async () => {
	const dir = tmp("pi-loops-push-first-start-");
	const project = path.join(dir, "project");
	fs.mkdirSync(project, { recursive: true });
	await new TriggerStore(dir).add({ condition: "a build fails", action: "say so", cwd: project });
	// Stored before this version's first start: a process before it derived it, or never will.
	new EventLog(dir, "background").append("mcp:ci", JSON.stringify(note("k1")));
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: async () => ({ ok: true, exitCode: 0, timedOut: false, text: "", usage: USAGE }), mcpTools: () => [], log: () => undefined });
	assert.equal(host.rederivePushes((server) => server === "ci"), 0);
	assert.deepEqual(new RequestStore(dir).list(checkLane(project)!), []);
	const lost = new EventLog(dir, "background").append("mcp:ci", JSON.stringify(note("k2")));
	assert.equal(host.rederivePushes((server) => server === "ci"), 1, "a push stored after that start is derived at the next");
	assert.deepEqual(new RequestStore(dir).list(checkLane(project)!).map((r) => r.id), [pushRowId(lost.id, project)]);
});

test("[push-rederive-on-start] a push derived before a rotation of events.jsonl is not derived again at start: the copy the rotation carried is the same push", async () => {
	const b = await background();
	b.host.receivePush("ci", "sub_agent", note("k1"));
	const [k1] = b.lines();
	const rowId = pushRowId(k1.id, b.project);
	assert.deepEqual(b.requests.list(b.lane).map((r) => r.id), [rowId]);
	// A gate's reading rotates the log while k1's row still waits, so k1 is carried into the new file.
	new EventLog(b.dir, "background", { maxBytes: 10, keep: () => new Set([k1.id]) }).append("gate:x", "{}");
	assert.ok(fs.existsSync(path.join(b.dir, "events.1.jsonl")));
	// The row then leaves with no run record, as a refused one does.
	b.requests.remove(b.lane, [rowId]);
	b.start();
	assert.deepEqual(b.requests.list(b.lane), [], "the restart writes no row for it");
});

test("[push-rederive-on-start] two rotations that drop the cursor's own event do not bring back an older derived push the second one carried", async () => {
	const b = await background();
	const events = new EventLog(b.dir, "background");
	const w = events.append("mcp:ci", JSON.stringify(note("w")));
	assert.equal(b.host.rederivePushes((server) => server === "ci"), 1);
	const x = events.append("mcp:ci", JSON.stringify(note("x")));
	assert.equal(b.host.rederivePushes((server) => server === "ci"), 1, "the cursor is x");
	// x's row leaves; w's still waits, so each rotation carries w and drops the generation that held x.
	b.requests.remove(b.lane, [pushRowId(x.id, b.project)]);
	const small = new EventLog(b.dir, "background", { maxBytes: 10, keep: () => new Set([w.id]) });
	small.append("gate:x", "{}");
	small.append("gate:x", "{}");
	assert.equal(new EventLog(b.dir, "background").get(x.id), undefined, "x is gone from both generations");
	// w's row then leaves with no run record, as a refused one does.
	b.requests.remove(b.lane, [pushRowId(w.id, b.project)]);
	assert.equal(b.start().rederivePushes((server) => server === "ci"), 0);
	assert.deepEqual(b.requests.list(b.lane), [], "the restart writes no row for w");
});

/** A push from `ci` stored by hand: numbered `seq`, received at `ms`. */
const storedPush = (id: string, seq: number, ms: number) => `${JSON.stringify({ id, received_at: new Date(ms).toISOString(), seq, source: "mcp:ci", receiver: { pid: process.pid, kind: "background" }, raw: JSON.stringify(note(id)) })}\n`;

test("[push-rederive-on-start] a start derives the pushes numbered after the cursor and received in the last five minutes, whatever order the clock and the log put them in", async () => {
	const b = await background();
	const now = Date.now();
	// The clock was set back after a; d and c are rotation copies above a and b, in no order; e is ten minutes old.
	fs.writeFileSync(path.join(b.dir, "events.jsonl"), storedPush("evt-d", 4, now - 60_000) + storedPush("evt-c", 3, now - 4 * 60_000) + storedPush("evt-a", 1, now - 30_000) + storedPush("evt-b", 2, now - 3 * 60_000) + storedPush("evt-e", 5, now - 10 * 60_000));
	fs.writeFileSync(path.join(b.dir, "events.seq"), "5\n");
	b.host.stores.clock.derivePushed(2);
	assert.equal(b.host.rederivePushes((server) => server === "ci"), 2);
	assert.deepEqual(b.requests.list(b.lane).map((r) => r.id), [pushRowId("evt-c", b.project), pushRowId("evt-d", b.project)], "c and d, in the order stored; a and b are not after the cursor; e is too old");
});

test("[push-rederive-on-start] after a first start with an empty log, a push stored is derived at the next start, one stamped before that first start too", async () => {
	const b = await background();
	assert.equal(JSON.parse(fs.readFileSync(path.join(b.dir, "clock.json"), "utf8")).pushes.derived, 0, "the log was empty");
	fs.writeFileSync(path.join(b.dir, "events.jsonl"), storedPush("evt-a", 1, Date.now() - 60_000));
	assert.equal(b.host.rederivePushes((server) => server === "ci"), 1);
	assert.deepEqual(b.requests.list(b.lane).map((r) => r.id), [pushRowId("evt-a", b.project)]);
});

test("[push-rederive-on-start] a cursor past the last number (events.seq and the log were removed) is no cursor: the start derives no push stored before it", async () => {
	const b = await background();
	const t = Date.now() - 1000;
	fs.writeFileSync(path.join(b.dir, "events.jsonl"), storedPush("evt-a", 1, t) + storedPush("evt-b", 2, t + 1));
	b.host.stores.clock.derivePushed(9);
	assert.equal(b.host.rederivePushes((server) => server === "ci"), 0);
	assert.deepEqual(b.requests.list(b.lane), []);
	assert.equal(JSON.parse(fs.readFileSync(path.join(b.dir, "clock.json"), "utf8")).pushes.derived, 2, "the cursor starts again at the last number");
});

test("[upgrade-hold] while the upgrade's pause holds, a push is stored and its row waits, with no check; resumed, the check-lanes rider runs it", async () => {
	const b = await background();
	holdUpgrade(b.dir);
	assert.equal(b.host.receivePush("ci", "sub_agent", note("k1")), true);
	await b.host.drain(5000);
	assert.equal(b.lines().length, 1, "stored first");
	assert.equal(b.requests.list(b.lane).length, 1, "its row waits");
	assert.equal(b.calls.length, 0, "no check while paused");
	await b.host.riders["check-lanes"](Date.now(), { startedAt: 0, tickMs: 30_000 });
	await b.host.drain(5000);
	assert.equal(b.calls.length, 0, "the rider waits too");
	resumeUpgrade(b.dir);
	await b.host.riders["check-lanes"](Date.now(), { startedAt: 0, tickMs: 30_000 });
	await b.host.drain(5000);
	assert.equal(b.calls.length, 1, "resumed: checked once");
});

test("[push-raw-first] a push whose rows cannot be written (triggers.json does not parse) stays stored, is logged, and does not end pi-loops in the background", async () => {
	const dir = tmp("pi-loops-push-corrupt-");
	const logged: string[] = [];
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: async () => ({ ok: true, exitCode: 0, timedOut: false, text: "", usage: USAGE }), mcpTools: () => [], log: (line) => logged.push(line) });
	host.rederivePushes((server) => server === "ci");
	fs.writeFileSync(path.join(dir, "triggers.json"), `{"version":1,"rules":[`);
	assert.equal(host.receivePush("ci", "sub_agent", note("k1")), true);
	const [stored] = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(JSON.parse(stored.raw), note("k1"), "stored as received, for a replay");
	assert.ok(logged.some((line) => line.includes(stored.id) && line.includes("triggers.json")), `logged: ${logged.join(" | ")}`);
});
