import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { runCli } from "../src/cli.ts";
import { CHECK_SOURCE } from "../src/check-tick.ts";
import { EventLog } from "../src/events.ts";
import { checkLane, loopLane } from "../src/lane.ts";
import { pushRowId, pushTrigger, writePush } from "../src/push.ts";
import { RequestStore } from "../src/requests.ts";
import { stamp } from "../src/schedule.ts";
import { JobStore, type LoopJob } from "../src/store.ts";
import { TriggerStore } from "../src/triggers.ts";

const JOB = "cron-0123456789abcdef0123456789abcdef";
const BY = { pid: 1, instance: "bg", version: "0" };
const note = (key: string) => JSON.stringify({ method: "ci/build", params: { _meta: { pi_dedup_key: key, pi_summary: "build red" } } });

/** A loops directory and the CLI pointed at it, as a shell would run `pi-loops`. */
function shell() {
	const root = tmp("pi-loops-replay-");
	const dir = path.join(root, "loops");
	fs.mkdirSync(dir);
	const replay = async (id: string): Promise<{ code: number; lines: string[] }> => {
		const lines: string[] = [];
		const saved = { dir: process.env.PI_LOOPS_DIR, agent: process.env.PI_CODING_AGENT_DIR };
		process.env.PI_LOOPS_DIR = dir;
		process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
		try {
			const code = await runCli(["events", "replay", id], (l) => lines.push(l));
			// Two replays in one millisecond would derive one id.
			await new Promise((resolve) => setTimeout(resolve, 2));
			return { code, lines };
		} finally {
			for (const [k, v] of [["PI_LOOPS_DIR", saved.dir], ["PI_CODING_AGENT_DIR", saved.agent]] as const) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	};
	return { root, dir, replay, events: new EventLog(dir, "background"), requests: new RequestStore(dir), rules: new TriggerStore(dir), jobs: new JobStore(dir) };
}

test("[events-replay] a push is replayed as a row in each project with an enabled rule, naming the event, though its first row is there; a second replay writes a second row", async () => {
	const s = shell();
	const a = tmp("replay-a-");
	const b = tmp("replay-b-");
	await s.rules.add({ condition: "a build fails", action: "say so", cwd: a });
	await s.rules.add({ condition: "a build fails", action: "say so", cwd: b });
	const event = s.events.append("mcp:ci", note("k1"));
	const trigger = pushTrigger(event)!;
	writePush(s.requests, { event, key: trigger.idempotencyKey, policy: trigger.replacementPolicy, label: "ci / build", sourceLabel: trigger.sourceLabel, project: a, earlier: [], done: () => false, createdBy: BY, now: Date.now() });

	const first = await s.replay(event.id);
	assert.equal(first.code, 0);
	assert.equal(first.lines[0], `replayed ${event.id}: 2 row(s) in ${[checkLane(a), checkLane(b)].join(", ")}`);
	const rowsA = s.requests.list(checkLane(a)!);
	assert.equal(rowsA.length, 2, "the first row and the replay's");
	const replayed = rowsA.find((r) => r.id !== pushRowId(event.id, a))!;
	assert.deepEqual([replayed.source, replayed.mode, replayed.payload?.events, replayed.payload?.cwd], ["push:mcp:ci", "unattended", [event.id], a]);
	assert.deepEqual(s.requests.list(checkLane(b)!).map((r) => r.payload?.events), [[event.id]]);

	assert.equal((await s.replay(event.id)).code, 0);
	const again = s.requests.list(checkLane(a)!);
	assert.equal(again.length, 3, "a second replay is a second row");
	assert.equal(new Set(again.map((r) => r.id)).size, 3);
});

test("[events-replay] a rule's gate reading is replayed as one check of that rule, a loop's as one run of that loop, each naming the event", async () => {
	const s = shell();
	const project = tmp("replay-p-");
	const rule = await s.rules.add({ condition: "the queue is long", action: "say so", cwd: project });
	const ruleEvent = s.events.append(`gate:${rule.id}`, "reading");
	await s.jobs.add({ id: JOB, schedule: { kind: "every", ms: 3_600_000 }, stateful: true, prompt: "look at the queue", cwd: project, enabled: true, catchUp: false, createdAt: stamp(Date.now()), runCount: 0, skippedOverlap: 0 } as LoopJob);
	const loopEvent = s.events.append(`gate:${JOB}`, "reading");

	const check = await s.replay(ruleEvent.id);
	assert.equal(check.code, 0);
	assert.equal(check.lines[0], `replayed ${ruleEvent.id}: 1 row(s) in ${checkLane(project)}`);
	const [row] = s.requests.list(checkLane(project)!);
	assert.deepEqual([row.source, row.payload?.rules, row.payload?.events], [CHECK_SOURCE, [rule.id], [ruleEvent.id]]);
	await s.replay(ruleEvent.id);
	assert.equal(s.requests.list(checkLane(project)!).length, 2, "a second replay is a second check");

	const run = await s.replay(loopEvent.id);
	assert.equal(run.code, 0);
	const lane = loopLane(JOB)!;
	assert.equal(run.lines[0], `replayed ${loopEvent.id}: 1 row(s) in ${lane}`);
	const [loopRow] = s.requests.list(lane);
	assert.deepEqual([loopRow.source, loopRow.mode, loopRow.payload?.events], [`cron-run:${JOB}`, "unattended", [loopEvent.id]], "a run, not a slot");
	await s.replay(loopEvent.id);
	assert.equal(s.requests.list(lane).length, 2, "a second replay is a second run");
});

test("[events-replay] an unknown id, an event that is no push or gate reading, a push no rule checks and a gate whose rule or job is gone are each refused in one line", async () => {
	const s = shell();
	const push = s.events.append("mcp:ci", note("k1"));
	const goneRule = s.events.append("gate:dyn-0123456789abcdef0123456789abcdef", "reading");
	const goneJob = s.events.append(`gate:${JOB}`, "reading");
	fs.appendFileSync(path.join(s.dir, "events.jsonl"), `${JSON.stringify({ id: "evt-hand", received_at: stamp(Date.now()), source: "file:notes", receiver: { pid: 1, kind: "background" }, raw: "x" })}\n`);
	// A push a window stored is one it put in its chat; so is one from a server mcp.toml says injects.
	const injected = new EventLog(s.dir, "window").append("mcp:ci", note("k2"));
	fs.writeFileSync(path.join(s.dir, "mcp.toml"), `[[server]]\nname = "feed"\nkind = "stdio"\ncommand = "true"\ninject_summary = true\n`);
	const fed = s.events.append("mcp:feed", note("k3"));
	const cases: [string, string][] = [
		[injected.id, `event ${injected.id} is a push from ci that injects into a chat: a replay writes no row for it`],
		[fed.id, `event ${fed.id} is a push from feed that injects into a chat: a replay writes no row for it`],
		["evt-nope", "no event evt-nope in events.jsonl"],
		["evt-hand", "event evt-hand is from file:notes: only a push (mcp:) or a gate reading (gate:) is replayed"],
		[push.id, `event ${push.id}: no project has an enabled rule that checks a push`],
		[goneRule.id, `event ${goneRule.id}: rule dyn-0123456789abcdef0123456789abcdef is gone`],
		[goneJob.id, `event ${goneJob.id}: job ${JOB} is gone`],
	];
	for (const [id, line] of cases) assert.deepEqual(await s.replay(id), { code: 1, lines: [line] }, id);
	assert.deepEqual(fs.readdirSync(s.dir).filter((f) => f.startsWith("requests")).flatMap((d) => fs.readdirSync(path.join(s.dir, d))), [], "nothing written");
});

test("[events-replay] a loop's gate reading is refused while the loop is proposed or disabled, in the words /cron run and /triggers run use, and writes no row", async () => {
	const s = shell();
	const project = tmp("replay-off-");
	const base = { schedule: { kind: "every", ms: 3_600_000 }, stateful: true, prompt: "look", cwd: project, catchUp: false, createdAt: stamp(Date.now()), runCount: 0, skippedOverlap: 0 };
	const off = "cron-" + "1".repeat(32);
	const proposed = "cron-" + "2".repeat(32);
	await s.jobs.add({ ...base, id: off, name: "queue-watch", enabled: false } as LoopJob);
	await s.jobs.add({ ...base, id: proposed, enabled: false, proposed: true } as LoopJob);
	const offEvent = s.events.append(`gate:${off}`, "reading");
	const proposedEvent = s.events.append(`gate:${proposed}`, "reading");
	assert.deepEqual(await s.replay(offEvent.id), { code: 1, lines: [`event ${offEvent.id}: queue-watch is disabled — /cron enable queue-watch first`] });
	assert.deepEqual(await s.replay(proposedEvent.id), { code: 1, lines: [`event ${proposedEvent.id}: ${proposed} is proposed and waits for your yes: /cron enable ${proposed} asks again`] });
	assert.deepEqual([s.requests.list(loopLane(off)!), s.requests.list(loopLane(proposed)!)], [[], []], "nothing written");
});

test("[events-replay] a project's own server's push is replayed in that project only; one its server injected is refused", async () => {
	const s = shell();
	const a = path.join(s.dir, "a");
	const b = path.join(s.dir, "b");
	fs.mkdirSync(a);
	fs.mkdirSync(b);
	const rules = new TriggerStore(s.dir);
	await rules.add({ condition: "c", action: "x", cwd: a });
	await rules.add({ condition: "c", action: "x", cwd: b });
	const own = s.events.append("mcp:repo", note("k1"), { project: a, delivery: "sub_agent" });
	const fed = s.events.append("mcp:repo", note("k2"), { project: a, delivery: "inject_summary" });
	const out = await s.replay(own.id);
	assert.equal(out.code, 0, out.lines.join("\n"));
	assert.equal(new RequestStore(s.dir).list(checkLane(a)!).length, 1);
	assert.deepEqual(new RequestStore(s.dir).list(checkLane(b)!), [], "the other project's rules never see it");
	assert.deepEqual(await s.replay(fed.id), { code: 1, lines: [`event ${fed.id} is a push from repo that injects into a chat: a replay writes no row for it`] });
});
