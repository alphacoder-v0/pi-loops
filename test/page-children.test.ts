import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LeaseHolder, ProcessProbe } from "../src/lease.ts";
import { ChildPool, type ChildView, decideChildStops, decideOpen, decideOrphan, PAGE_CAP, PAGE_CRASH_BUDGET, PAGE_IDLE_MS, type PageRecord, parsePageRecord } from "../src/page-children.ts";
import { fakePi, startTestPage, TEST_TOKEN, until } from "./page-harness.ts";
import { tmp } from "./tmp.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const view = (sessionId: string, over: Partial<ChildView> = {}): ChildView => ({ sessionId, clients: 0, busy: false, pendingAsks: 0, unsentPersonRows: 0, lastClientAt: NOW, ...over });
const OPTS = { idleMs: PAGE_IDLE_MS, cap: PAGE_CAP };

test("an idle child is stopped after the idle time, and one somebody needs never is", () => {
	const old = NOW - PAGE_IDLE_MS - 1;
	assert.deepEqual(decideChildStops([view("a", { lastClientAt: old }), view("b", { lastClientAt: NOW - 1000 })], NOW, OPTS), { stop: ["a"] }, "only the one nobody looked at for the idle time");
	for (const busy of [{ clients: 1 }, { busy: true }, { pendingAsks: 1 }, { unsentPersonRows: 1 }]) {
		assert.deepEqual(decideChildStops([view("a", { lastClientAt: old, ...busy })], NOW, OPTS), { stop: [] }, `not with ${JSON.stringify(busy)}`);
	}
});

test("opening one more than the cap stops the least recently used idle child, and none idle is full", () => {
	const six = ["a", "b", "c", "d", "e", "f"].map((id, i) => view(id, { lastClientAt: NOW - 1000 * (10 - i) }));
	assert.deepEqual(decideChildStops(six, NOW, { ...OPTS, opening: "g" }), { stop: ["a"] }, "the one used longest ago");
	assert.deepEqual(decideChildStops(six, NOW, { ...OPTS, opening: "c" }), { stop: [] }, "a conversation the pool has needs no room");
	assert.deepEqual(decideChildStops(six.slice(1), NOW, { ...OPTS, opening: "g" }), { stop: [] }, "five leave room for a sixth");
	const inUse = six.map((v, i) => (i === 0 ? { ...v, clients: 1 } : v));
	assert.deepEqual(decideChildStops(inUse, NOW, { ...OPTS, opening: "g" }), { stop: ["b"] }, "a child with a browser attached is passed over");
	const allBusy = six.map((v) => ({ ...v, busy: true }));
	assert.deepEqual(decideChildStops(allBusy, NOW, { ...OPTS, opening: "g" }), { stop: [], full: true });
});

const RECORD: PageRecord = { v: 1, sessionId: "s1", cwd: "/w", pid: 200, procStart: "child-start", startedAt: new Date(NOW).toISOString(), lastClientAt: new Date(NOW).toISOString(), server: { pid: 100, procStart: "server-start" }, piArgs: ["--model", "x"] };

function probe(alive: Record<number, string>): ProcessProbe {
	return { alive: (pid) => pid in alive, startTime: (pid) => alive[pid], bootedAt: () => NOW - 3_600_000 };
}

test("a record is stopped only when the pi-loops that wrote it is gone and its child is not", () => {
	assert.equal(decideOrphan(RECORD, { pid: 100, procStart: "server-start" }, probe({ 100: "server-start", 200: "child-start" })), "ours");
	assert.equal(decideOrphan(RECORD, { pid: 300 }, probe({ 100: "server-start", 200: "child-start" })), "ours", "another pi-loops still running stops its own children");
	assert.equal(decideOrphan(RECORD, { pid: 300 }, probe({ 200: "child-start" })), "wait-then-stop");
	assert.equal(decideOrphan(RECORD, { pid: 300 }, probe({})), "gone");
	assert.equal(decideOrphan(RECORD, { pid: 300 }, probe({ 200: "someone-else" })), "gone", "a reused pid is not the child");
	assert.equal(decideOrphan(RECORD, { pid: 300 }, probe({ 100: "someone-else", 200: "child-start" })), "wait-then-stop", "nor a reused server pid the server");
});

test("opening reuses, waits for a turn pi-loops is running, refuses after the crash budget, else starts", () => {
	const held = { runId: "r1", label: "nightly" };
	const crashed = Array.from({ length: PAGE_CRASH_BUDGET.count }, (_, i) => NOW - 1000 * i);
	assert.deepEqual(decideOpen({ child: view("a"), heldTurn: held, crashes: crashed, now: NOW }), { kind: "reuse" });
	assert.deepEqual(decideOpen({ heldTurn: held, crashes: crashed, now: NOW }), { kind: "wait-background", runId: "r1", label: "nightly" });
	assert.deepEqual(decideOpen({ crashes: crashed, now: NOW }), { kind: "crash-looping" });
	assert.deepEqual(decideOpen({ crashes: crashed.slice(1), now: NOW }), { kind: "start" }, "one short of the budget");
	assert.deepEqual(decideOpen({ crashes: crashed.map((at) => at - PAGE_CRASH_BUDGET.windowMs), now: NOW }), { kind: "start" }, "exits outside the window do not count");
});

test("opening waits while the lease says pi-loops is busy there, before its turn is known", () => {
	// pi-loops takes the lease, then claims the job, then runs the turn: a page opened in between
	// would start a second writer on the file.
	const host = (over: Partial<LeaseHolder> = {}): { holder: LeaseHolder } => ({ holder: { kind: "host", pid: 100, procStart: "server-start", instance: "host", acquiredAt: "at", pushServers: [], busy: { runId: "run-0123456789abcdef", jobId: "cron-1", since: "at" }, ...over } });
	const live = probe({ 100: "server-start" });
	assert.deepEqual(decideOpen({ lease: host(), crashes: [], now: NOW }, live), { kind: "wait-background", runId: "run-0123456789abcdef", label: "run-01234567" });
	assert.deepEqual(decideOpen({ heldTurn: { runId: "run-0123456789abcdef", label: "nightly" }, lease: host(), crashes: [], now: NOW }, live), { kind: "wait-background", runId: "run-0123456789abcdef", label: "nightly" }, "the turn, once known, names itself");
	assert.deepEqual(decideOpen({ lease: host({ busy: undefined }), crashes: [], now: NOW }, live), { kind: "start" }, "held for a write, not a turn");
	assert.deepEqual(decideOpen({ lease: host(), crashes: [], now: NOW }, probe({})), { kind: "start" }, "a pi-loops that is gone runs nothing");
	assert.deepEqual(decideOpen({ lease: host({ kind: "terminal" }), crashes: [], now: NOW }, live), { kind: "start" }, "only pi-loops's own turn waits here");
	assert.deepEqual(decideOpen({ child: view("a"), lease: host(), crashes: [], now: NOW }, live), { kind: "reuse" });
});

test("a record is read back, and anything torn or foreign is not one", () => {
	assert.deepEqual(parsePageRecord(JSON.stringify(RECORD)), RECORD);
	assert.equal(parsePageRecord(JSON.stringify(RECORD).slice(0, 40)), undefined, "torn");
	assert.equal(parsePageRecord(JSON.stringify({ ...RECORD, server: undefined })), undefined, "no server");
	assert.equal(parsePageRecord(JSON.stringify({ ...RECORD, v: 2 })), undefined, "another version");
	assert.equal(parsePageRecord(JSON.stringify({ ...RECORD, pid: -1 })), undefined, "not a pid");
});

function pool(dir: string, fake: string, now?: () => number) {
	const logs: string[] = [];
	const p = new ChildPool({ dir: path.join(dir, "loops"), command: () => ({ command: fake, args: [] }), env: process.env, version: "0.0.0-test", log: (l) => void logs.push(l), ring: async () => undefined, now });
	return { pool: p, logs };
}
const recordOf = (dir: string, key: string) => {
	const file = path.join(dir, "loops", "pages", `${key}.json`);
	return fs.existsSync(file) ? parsePageRecord(fs.readFileSync(file, "utf8")) : undefined;
};

test("a new conversation is recorded under its pid until pi names it, then under its id, and its pages are told", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-pages-");
	const { pool: p } = pool(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		const child = await p.open({ cwd: dir, piArgs: [] });
		assert.ok(await until(() => p.has("s1")), "keyed by the id pi answered with");
		assert.equal(p.get("s1"), child);
		const rec = recordOf(dir, "s1");
		assert.equal(rec?.pid, child.pid);
		assert.equal(rec?.server.pid, process.pid);
		assert.equal(fs.statSync(path.join(dir, "loops", "pages", "s1.json")).mode & 0o777, 0o600);
		assert.equal(recordOf(dir, `new-${child.pid}`), undefined, "the provisional record is gone");
		assert.deepEqual(child.backlog.filter((e) => e.type === "page_moved").map((e) => e.sessionId), ["s1"]);
		assert.equal(await p.open({ sessionId: "s1", cwd: dir, piArgs: [] }), child, "opened again, it is the same child");
	} finally {
		await p.stopAll();
	}
});

test("two opens of one conversation share one start, and each spawn has its own epoch", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-pages-");
	const { pool: p } = pool(dir, fakePi(dir));
	try {
		const [a, b] = await Promise.all([p.open({ sessionId: "s1", sessionFile: path.join(dir, "s1"), cwd: dir, piArgs: [] }), p.open({ sessionId: "s1", sessionFile: path.join(dir, "s1"), cwd: dir, piArgs: [] })]);
		assert.equal(a, b, "one child");
		await p.stop("s1", "test");
		assert.equal(p.has("s1"), false);
		assert.equal(recordOf(dir, "s1"), undefined, "its record went with it");
		assert.deepEqual(p.crashes("s1"), [], "a stop that was asked for is not a crash");
		const c = await p.open({ sessionId: "s1", sessionFile: path.join(dir, "s1"), cwd: dir, piArgs: [] });
		assert.notEqual(c.epoch, a.epoch, "a new process is a new sequence of events");
	} finally {
		await p.stopAll();
	}
});

test("JSONL from pi is split on newlines only, and a huge line arrives whole", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-pages-");
	// U+2028 is legal inside a JSON string, and a split there desyncs the stream; the long line is
	// multi-byte, so its bytes cross chunk boundaries.
	const huge = "é你".repeat(400_000);
	const lines = [{ type: "test_event", text: "one two three" }, { type: "test_event", text: huge }, { type: "test_event", text: "after" }];
	const { pool: p } = pool(dir, fakePi(dir, { lines }));
	try {
		const child = await p.open({ cwd: dir, piArgs: [] });
		assert.ok(await until(() => child.backlog.some((e) => e.text === "after"), 10_000), "the event after the huge line arrived");
		const said = child.backlog.filter((e) => e.type === "test_event").map((e) => e.text);
		assert.equal(said.length, 3);
		assert.equal(said[0], "one two three");
		assert.equal(said[1] === huge, true, "the huge line, character for character");
	} finally {
		await p.stopAll();
	}
});

test("a pi that dies mid-turn leaves no record, counts toward the crash budget, and its page is told", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-pages-");
	const { pool: p } = pool(dir, fakePi(dir, { crashAfter: true }));
	const child = await p.open({ sessionId: "s1", sessionFile: path.join(dir, "s1"), cwd: dir, piArgs: [] });
	assert.ok(await until(() => !child.alive), "it died");
	assert.equal(p.has("s1"), false);
	assert.equal(recordOf(dir, "s1"), undefined);
	assert.equal(p.crashes("s1").length, 1);
	assert.match(p.lastWords("s1"), /the provider hung up/);
	const exit = child.backlog.find((e) => e.type === "pi_exit");
	assert.equal(exit?.code, 1);
	assert.ok(child.backlog.some((e) => e.type === "agent_start"), "it was in a turn");
});

test("the sweep stops an idle child; opening one past the cap stops the least recently used", { timeout: 30_000 }, async () => {
	const dir = tmp("pi-loops-pages-");
	let clock = Date.now();
	const { pool: p } = pool(dir, fakePi(dir), () => clock);
	const open = (id: string) => p.open({ sessionId: id, sessionFile: path.join(dir, id), cwd: dir, piArgs: [] });
	try {
		const ids = ["a", "b", "c", "d", "e", "f"];
		for (const id of ids) await open(id);
		for (const id of [...ids, "a"]) {
			clock += 1000;
			p.touch(id);
		}
		await open("g");
		assert.deepEqual(
			p.list().map((c) => p.keyOf(c)).sort(),
			["a", "c", "d", "e", "f", "g"],
			"b was used longest ago",
		);
		p.get("c")!.clients.add({} as any);
		clock += PAGE_IDLE_MS + 1;
		assert.deepEqual((await p.sweep()).sort(), ["a", "d", "e", "f", "g"], "everything idle, and not the one with a browser attached");
		assert.deepEqual(fs.readdirSync(path.join(dir, "loops", "pages")).filter((n) => n.endsWith(".json")), ["c.json"], "only the running child keeps a record");
	} finally {
		await p.stopAll();
	}
});

test("a child an earlier pi-loops left running is stopped, never adopted, and a dead one's record is dropped", { timeout: 30_000 }, async () => {
	const dir = tmp("pi-loops-pages-");
	const loops = path.join(dir, "loops");
	fs.mkdirSync(path.join(loops, "pages"), { recursive: true });
	const gone = spawn(process.execPath, ["-e", ""]);
	await new Promise((r) => gone.on("exit", r));
	const left = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { detached: true, stdio: "ignore" });
	const leftExit = new Promise((r) => left.on("exit", r));
	const record = (sessionId: string, pid: number) =>
		fs.writeFileSync(path.join(loops, "pages", `${sessionId}.json`), JSON.stringify({ ...RECORD, sessionId, pid, procStart: undefined, startedAt: new Date().toISOString(), server: { pid: gone.pid } }));
	record("left", left.pid!);
	record("dead", gone.pid!);
	const { pool: p, logs } = pool(dir, fakePi(dir));
	await p.reapOrphans();
	await leftExit;
	assert.equal(left.signalCode, "SIGTERM", "asked to quit the way pi quits");
	assert.deepEqual(fs.readdirSync(path.join(loops, "pages")), [], "both records are gone");
	assert.ok(logs.some((l) => l.includes(`stopping pi ${left.pid} of left`)), logs.join("\n"));
});

test("a conversation the page starts again gets the pi arguments of the launch that opened it", { timeout: 30_000 }, async () => {
	// `pi-loops -- --model x` opens the conversation; fifteen idle minutes stop its pi; the next load
	// of its page starts another. That one used to start with no arguments at all, on pi's default model.
	const dir = tmp("pi-loops-pages-");
	const argv = path.join(dir, "argv.jsonl");
	const page = await startTestPage(dir, fakePi(dir, { argv }), { server: { sessions: { known: () => ({ cwd: dir, sessionFile: path.join(dir, "s1") }) } } });
	const starts = () => fs.readFileSync(argv, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
	try {
		await page.pool.open({ sessionId: "s1", sessionFile: path.join(dir, "s1"), cwd: dir, piArgs: ["--model", "x"] });
		assert.ok(await until(() => fs.existsSync(argv)), "the first pi is up");
		await page.pool.stop("s1", "idle");
		assert.equal(page.pool.has("s1"), false, "stopped");
		assert.equal((await page.get("c/s1/state")).status, 200, "the page starts it again");
		assert.ok(await until(() => starts().length === 2));
		assert.deepEqual(starts()[1].slice(-2), ["--model", "x"], `the second start; got ${JSON.stringify(starts()[1])}`);

		// A later launch's arguments, recorded while the conversation is not running, are the ones it gets next.
		await page.pool.stop("s1", "idle");
		page.pool.recordArgs("s1", ["--model", "y"]);
		assert.equal((await page.get("c/s1/state")).status, 200);
		assert.ok(await until(() => starts().length === 3));
		assert.deepEqual(starts()[2].slice(-2), ["--model", "y"]);
	} finally {
		await page.stop();
	}
});

/** Every `data:` event of an `/events` stream until `done` holds for one, or the time runs out. */
async function eventsUntil(url: string, done: (ev: any) => boolean, timeoutMs: number): Promise<any[]> {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	const got: any[] = [];
	try {
		const res = await fetch(url, { headers: { "x-pi-web-token": TEST_TOKEN }, signal: ac.signal });
		assert.equal(res.status, 200, "/events opened");
		const reader = res.body!.getReader();
		const dec = new TextDecoder();
		let buf = "";
		for (;;) {
			const { value, done: eof } = await reader.read();
			if (eof) return got;
			buf += dec.decode(value, { stream: true });
			for (let i = buf.indexOf("\n\n"); i !== -1; i = buf.indexOf("\n\n")) {
				const data = buf.slice(0, i).split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
				buf = buf.slice(i + 2);
				if (!data) continue;
				const ev = JSON.parse(data);
				got.push(ev);
				if (done(ev)) return got;
			}
		}
	} catch (err: any) {
		if (err?.name !== "AbortError") throw err;
		return got;
	} finally {
		clearTimeout(timer);
		ac.abort();
	}
}

test("every slow streamed delta reaches a live page and one that joins mid-turn, in order, with no gap in seq", { timeout: 30_000 }, async () => {
	// A turn that streams a word every 300 ms once showed only its first word on the page. That was
	// the stand-in model, not the page; this keeps the page's half of it true.
	const dir = tmp("pi-loops-pages-");
	const words = ["slow ", "w1 ", "w2 ", "w3 ", "w4 ", "w5 ", "w6 ", "w7 ", "done."];
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "slow", stream: { words, stepMs: 300, afterMs: 800 } }));
	try {
		const child = await page.pool.open({ sessionId: "slow", cwd: dir, piArgs: [] });
		const turnEnds = (ev: any) => ev.type === "agent_end";
		const live = eventsUntil(`${page.url}c/slow/events`, turnEnds, 20_000);
		const streamed = () => child.backlog.filter((ev) => ev.assistantMessageEvent?.type === "text_delta").length;
		assert.ok(await until(() => streamed() === 3, 10_000), "three words in");
		const joined = eventsUntil(`${page.url}c/slow/events`, turnEnds, 20_000);
		for (const [who, got] of [["live", await live], ["joined mid-turn", await joined]] as const) {
			const said = got.filter((ev) => ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta").map((ev) => ev.assistantMessageEvent.delta);
			assert.deepEqual(said, words, `${who}: every delta, in order`);
			const seqs = got.map((ev) => ev.seq);
			for (let i = 1; i < seqs.length; i++) assert.equal(seqs[i], seqs[i - 1] + 1, `${who}: seq has no gap at ${i} (${seqs.join(",")})`);
			assert.ok(got.some((ev) => ev.type === "message_end"), `${who}: and the message ended`);
		}
	} finally {
		await page.stop();
	}
});
