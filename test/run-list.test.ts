import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { plainJobRow } from "../src/engine.ts";
import { parseLane } from "../src/lane.ts";
import { RequestStore } from "../src/requests.ts";
import { RunList, STOPPED_BY_PERSON, type Running } from "../src/run-list.ts";
import { stamp } from "../src/schedule.ts";
import { tmp } from "./tmp.ts";

const by = { pid: 321, procStart: "start-321" };
const now = Date.parse("2026-01-02T03:04:05.000Z");

function row(id: string) {
	return plainJobRow({
		id: "job",
		sessionId: "s",
		prompt: "say hello",
		cwd: "/project",
		model: undefined,
		thinking: undefined,
		tools: undefined,
		builtinTools: undefined,
	}, id, "cron:job", "", { pid: 1, instance: "test", version: "1" }, now);
}

function run(over: Partial<Omit<Running, "runId" | "startedAt">> = {}): Omit<Running, "runId" | "startedAt"> {
	return { jobId: "job", label: "Job", promptPreview: "say hello", ctrl: new AbortController(), ...over };
}

test("[R1] RunList.claim writes the matching claim and omits an undefined procStart.", () => {
	const store = new RequestStore(tmp());
	const list = new RunList();
	const first = row("R1-a");
	store.append(first);
	const claimed = list.claim(store, first, by, run(), now)!;
	assert.equal(claimed.run.id, first.id);
	assert.equal(claimed.run.pid, by.pid);
	assert.equal(claimed.run.procStart, by.procStart);
	assert.equal(claimed.run.started_at, list.get(first.id)?.startedAt);
	assert.deepEqual(store.list(first.lane)[0].run, {
		id: first.id,
		pid: by.pid,
		started_at: list.get(first.id)!.startedAt,
		procStart: by.procStart,
	});

	const second = row("R1-b");
	store.append(second);
	const noStart = list.claim(store, second, { pid: by.pid, procStart: undefined }, run(), now)!;
	assert.equal(Object.hasOwn(noStart.run, "procStart"), false);
	assert.equal(Object.hasOwn(store.list(second.lane)[1].run!, "procStart"), false);
	assert.equal(noStart.run.started_at, list.get(second.id)?.startedAt);
	assert.equal(noStart.run.started_at, stamp(now));
});

test("[R2] RunList.claim lists the run before it writes the claim.", () => {
	const list = new RunList();
	const request = row("R2");
	let seen: Running[] = [];
	const requests = {
		claim: () => {
			assert.equal(list.get(request.id)?.runId, request.id);
			seen = [...list.all()];
			return true;
		},
	};
	const claimed = list.claim(requests, request, by, run(), now);
	assert.equal(claimed?.run.id, request.id);
	assert.equal(seen.length, 1);
	assert.equal(seen[0].runId, request.id);
});

test("A missing or already claimed row leaves the list and stored claim alone.", () => {
	const store = new RequestStore(tmp());
	const list = new RunList();
	const missing = row("missing");
	assert.equal(list.claim(store, missing, by, run(), now), undefined);
	assert.deepEqual(list.all(), []);

	const already = row("claimed");
	store.append(already);
	const original = { id: already.id, pid: 99, started_at: "before", procStart: "other" };
	assert.equal(store.claim(already.lane, already.id, original), true);
	const before = store.list(already.lane)[0].run;
	assert.equal(list.claim(store, already, by, run(), now), undefined);
	assert.deepEqual(list.all(), []);
	assert.deepEqual(store.list(already.lane)[0].run, before);
});

test("A thrown claim removes its run, and a duplicate claim does not call again.", () => {
	const thrown = new Error("write failed");
	const list = new RunList();
	const failed = row("throws");
	assert.throws(() => list.claim({ claim: () => { throw thrown; } }, failed, by, run(), now), (error) => error === thrown);
	assert.deepEqual(list.all(), []);

	const firstRow = row("duplicate");
	let calls = 0;
	const requests = { claim: () => { calls++; return true; } };
	const first = list.claim(requests, firstRow, by, run(), now)!;
	const firstRun = list.get(firstRow.id);
	assert.equal(list.claim(requests, firstRow, by, run({ label: "second" }), now), undefined);
	assert.equal(calls, 1);
	assert.equal(list.get(firstRow.id), firstRun);
	assert.equal(first.run.id, firstRun?.runId);
});

test("stop aborts a listed run and preserves its first source.", () => {
	const list = new RunList();
	const defaultRun = run();
	list.add({ ...defaultRun, runId: "cli", startedAt: stamp(now) });
	assert.equal(list.stop("cli"), true);
	assert.equal(defaultRun.ctrl.signal.aborted, true);
	assert.equal(defaultRun.ctrl.signal.reason, STOPPED_BY_PERSON);
	assert.equal(list.get("cli")?.stoppedFrom, "cli");

	const pageRun = run();
	list.add({ ...pageRun, runId: "page", startedAt: stamp(now) });
	assert.equal(list.stop("page", "page"), true);
	assert.equal(list.get("page")?.stoppedFrom, "page");

	const notedRun = run();
	list.add({ ...notedRun, runId: "noted", startedAt: stamp(now) });
	list.noteStopFrom("noted", "page");
	assert.equal(list.stop("noted"), true);
	assert.equal(list.get("noted")?.stoppedFrom, "page");
	assert.equal(list.stop("absent"), false);
	list.noteStopFrom("absent", "cli");
});

test("turnIn finds only a held turn and uses its label.", () => {
	const list = new RunList();
	const sessionId = parseLane("conversation")!.id;
	list.add({ ...run({ label: "Run label", turn: { sessionId, epoch: 4, sessionFile: "/closed.jsonl", cwd: "/project", label: "Turn label" } }), runId: "held", startedAt: stamp(now) });
	list.add({ ...run(), runId: "loop", startedAt: stamp(now) });
	assert.deepEqual(list.turnIn(sessionId), { runId: "held", label: "Turn label", startedAt: stamp(now) });
	assert.equal(list.turnIn("unknown"), undefined);
	assert.equal(list.turnIn(parseLane("other")!.id), undefined);
});

test("all returns insertion order in a copy and remove reports whether it found a run.", () => {
	const list = new RunList();
	const first = { ...run(), runId: "first", startedAt: stamp(now) };
	const second = { ...run(), runId: "second", startedAt: stamp(now) };
	list.add(first);
	list.add(second);
	assert.deepEqual(list.all(), [first, second]);
	const copy = list.all() as Running[];
	copy.push({ ...first, runId: "extra" });
	assert.deepEqual(list.all(), [first, second]);
	assert.equal(list.get("second"), second);
	assert.equal(list.remove("first"), true);
	assert.equal(list.remove("first"), false);
});

test("the stop reason of a person's stop is the words its record carries.", () => {
	assert.equal(STOPPED_BY_PERSON, "stopped by a person");
});

test("RunList.claim passes its lock options to the store, and a lock it cannot take leaves no run.", () => {
	const seen: unknown[] = [];
	const list = new RunList();
	const quick = { timeoutMs: 50 };
	const first = row("lock-a");
	list.claim({ claim: (_lane, _id, _run, lock) => (seen.push(lock), true) }, first, by, run(), now, quick);
	assert.deepEqual(seen, [quick]);

	const dir = tmp();
	const store = new RequestStore(dir);
	const second = row("lock-b");
	store.append(second);
	const lock = path.join(dir, "requests", `${second.lane}.lock`);
	fs.mkdirSync(lock);
	fs.writeFileSync(path.join(lock, "owner"), `${process.pid}.-.deadbeef0000`);
	assert.throws(() => list.claim(store, second, by, run(), now, quick), /timed out waiting for lock/);
	assert.equal(list.get(second.id), undefined, "the run is taken out");
});
