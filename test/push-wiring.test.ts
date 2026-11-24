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

const USAGE = { input: 1, output: 1, cost: 0.01, turns: 1 };
const note = (key: string | undefined, summary = "build red") => ({ method: "ci/build", params: { _meta: { ...(key ? { pi_dedup_key: key } : {}), pi_summary: summary } } });

/** pi-loops in the background with one project that has a rule; its runner holds every check until `release`. */
async function background() {
	const dir = tmp("pi-loops-push-wiring-");
	const project = path.join(dir, "project");
	fs.mkdirSync(project, { recursive: true });
	const calls: any[] = [];
	const host = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), runner: async (req: any) => { calls.push(req); return { ok: true, exitCode: 0, timedOut: false, text: "nothing matched", usage: USAGE }; }, mcpTools: () => [], log: () => undefined });
	await host.stores.rules.add({ condition: "a build fails", action: "say so", cwd: project });
	const lines = () => fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	return { dir, project, host, calls, lines, lane: checkLane(project)!, requests: new RequestStore(dir) };
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
