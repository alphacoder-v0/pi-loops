import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { LeaseStore, decideAcquire, decideHostAcquire, holderAlive, procStart, type LeaseHolder, type ProcessProbe, type SessionLease } from "../src/lease.ts";

const me: LeaseHolder = { kind: "terminal", pid: 10, instance: "a", procStart: "start", acquiredAt: "2026-01-01T00:00:00.000Z", pushServers: [] };
const probe = (over: Partial<ProcessProbe> = {}): ProcessProbe => ({ alive: () => true, startTime: () => "start", bootedAt: () => Date.parse("2025-01-01T00:00:00Z"), ...over });
const oldLease = (over: Partial<SessionLease> = {}): SessionLease => ({ v: 1, sessionId: "s", epoch: 1, holder: me, updatedAt: me.acquiredAt, ...over });

test("acquiring a session nobody holds takes it at epoch 1", () => {
	const store = new LeaseStore(tmp());
	assert.equal(store.acquire("s", me).lease.epoch, 1);
});

test("holder acquiring again keeps epoch and does not rewrite when unchanged", () => {
	const store = new LeaseStore(tmp());
	store.acquire("s", me);
	const before = fs.statSync(store.file("s")).mtimeMs;
	const result = store.acquire("s", me);
	assert.equal(result.outcome, "held");
	assert.equal(result.lease.epoch, 1);
	assert.equal(fs.statSync(store.file("s")).mtimeMs, before);
});

test("a second instance on a live holder becomes a viewer without writing", () => {
	const store = new LeaseStore(tmp(), probe());
	store.acquire("s", me);
	const before = fs.readFileSync(store.file("s"), "utf8");
	const result = store.acquire("s", { ...me, instance: "b" });
	assert.equal(result.outcome, "viewer");
	assert.equal(fs.readFileSync(store.file("s"), "utf8"), before);
});

test("release clears the holder and increments epoch; non-holder release is refused", () => {
	const store = new LeaseStore(tmp());
	store.acquire("s", me);
	assert.equal(store.release("s", { ...me, instance: "b" }), false);
	assert.equal(store.release("s", me), true);
	assert.equal(store.read("s")?.holder, null);
	assert.equal(store.read("s")?.epoch, 2);
});

test("dead holder pid is taken over with epoch+1 and tookFromPid", () => {
	const current = oldLease();
	const result = decideAcquire(current, "s", { ...me, pid: 11 }, {}, Date.now(), probe({ alive: () => false }));
	assert.equal(result.outcome, "acquired");
	assert.equal(result.lease.epoch, 2);
	assert.equal(result.tookFromPid, 10);
});

test("recycled pid is taken over", () => {
	const result = decideAcquire(oldLease(), "s", { ...me, pid: 11 }, {}, Date.now(), probe({ startTime: () => "new" }));
	assert.equal(result.outcome, "acquired");
	assert.equal(result.tookFromPid, 10);
});

test("without a start time, holder before boot is dead and after boot is alive", () => {
	const noStart = { ...me, procStart: undefined };
	assert.equal(holderAlive({ ...noStart, acquiredAt: "2024-01-01T00:00:00Z" }, probe({ startTime: () => undefined })), false);
	assert.equal(holderAlive({ ...noStart, acquiredAt: "2025-01-01T00:00:00Z" }, probe({ startTime: () => undefined })), true);
});

test("a live holder is never displaced just because it is old", () => {
	const holder = { ...me, acquiredAt: "2025-01-02T00:00:00Z" };
	assert.equal(holderAlive(holder, probe({ bootedAt: () => Date.parse("2025-01-01T00:00:00Z") })), true);
});

test("stale writer compare-and-write loses against a newer epoch", () => {
	const dir = tmp();
	class RacingStore extends LeaseStore {
		calls = 0;
		override read(sessionId: string): SessionLease | undefined {
			this.calls++;
			if (this.calls === 2) {
				const latest = { ...oldLease(), epoch: 8, holder: { ...me, pid: 99 } };
				fs.mkdirSync(path.join(dir, "leases"), { recursive: true });
				fs.writeFileSync(path.join(dir, "leases", `${sessionId}.json`), `${JSON.stringify(latest)}\n`);
			}
			return super.read(sessionId);
		}
	}
	const store = new RacingStore(dir, probe({ alive: (pid) => pid === 99, startTime: (pid) => pid === 99 ? "start" : undefined }));
	const outcome = store.acquire("s", { ...me, pid: 11 });
	assert.equal(outcome.outcome, "viewer");
	assert.equal(store.read("s")?.epoch, 8);
});

test("holder bound without a start time is held by pid when live", () => {
	const holder = { ...me, procStart: undefined };
	const current = oldLease({ holder });
	assert.equal(decideAcquire(current, "s", holder, {}, Date.now(), probe({ startTime: () => undefined })).outcome, "held");
});

test("setPushServers keeps epoch, sorts and dedupes, and refuses wrong epoch or non-holder", () => {
	const store = new LeaseStore(tmp());
	store.acquire("s", me);
	assert.equal(store.setPushServers("s", me, 1, ["z", "a", "z"]), true);
	assert.deepEqual(store.read("s")?.holder?.pushServers, ["a", "z"]);
	assert.equal(store.read("s")?.epoch, 1);
	assert.equal(store.setPushServers("s", me, 2, ["x"]), false);
	assert.equal(store.setPushServers("s", { ...me, instance: "b" }, 1, ["x"]), false);
});

test("unsafe session ids are rejected", () => {
	const store = new LeaseStore(tmp());
	assert.throws(() => store.file("a/b"));
	assert.throws(() => store.file(".."));
});

test("procStart returns this process's stable start time", () => {
	assert.equal(typeof procStart(process.pid), "string");
	assert.equal(procStart(process.pid), procStart(process.pid));
});

const hostHolder: LeaseHolder = { kind: "host", pid: 20, instance: "host", procStart: "start", acquiredAt: "2026-01-01T00:00:00.000Z", pushServers: [] };

test("the host takes a closed conversation for one piece of work only when its file has been quiet", () => {
	const now = Date.parse("2026-06-01T12:00:00Z");
	const closed = oldLease({ holder: null, epoch: 4, sessionFile: "/s.jsonl" });
	const quiet = now - 10 * 60_000;
	const taken = decideHostAcquire(closed, hostHolder, quiet, now, probe());
	assert.ok("lease" in taken);
	assert.equal(taken.lease.epoch, 5, "a change of holder moves the epoch");
	assert.equal(taken.lease.holder?.kind, "host");
	assert.match((decideHostAcquire(closed, hostHolder, now - 30_000, now, probe()) as any).refused, /changed in the last two minutes/, "a file written moments ago may be open in a pi without pi-loops");
	assert.match((decideHostAcquire(closed, hostHolder, undefined, now, probe()) as any).refused, /gone/);
	assert.match((decideHostAcquire(oldLease({ holder: null }), hostHolder, quiet, now, probe()) as any).refused, /no known session file/, "pi-loops never saw this conversation's file");
	assert.match((decideHostAcquire(oldLease({ sessionFile: "/s.jsonl" }), hostHolder, quiet, now, probe()) as any).refused, /held by pid 10/, "the host never displaces a live window");
	assert.ok("lease" in decideHostAcquire(oldLease({ sessionFile: "/s.jsonl" }), hostHolder, quiet, now, probe({ alive: () => false })), "a dead window's lease is free");
	assert.match((decideHostAcquire(oldLease({ sessionFile: "/s.jsonl", holder: hostHolder }), hostHolder, quiet, now, probe()) as any).refused, /already working in it/, "a slot due while its turn still runs waits");
});

test("a window takes its conversation back from a busy host at once, and says what it interrupted", () => {
	const held = oldLease({ epoch: 7, holder: { ...hostHolder, busy: { runId: "run-x", since: "2026-01-01T00:00:00.000Z" } }, sessionFile: "/s.jsonl" });
	const out = decideAcquire(held, "s", me, {}, Date.now(), probe());
	assert.equal(out.outcome, "acquired", "not a viewer: the host only borrows a closed conversation");
	assert.equal(out.lease.epoch, 8);
	assert.deepEqual((out as any).tookFromHost, { pid: 20, runId: "run-x" });
	assert.equal(out.lease.preempted?.runId, "run-x", "the host reads this to stop its turn");
	const idle = decideAcquire(oldLease({ holder: hostHolder }), "s", me, {}, Date.now(), probe());
	assert.equal(idle.outcome, "acquired");
	assert.equal(idle.lease.preempted, undefined, "an idle host interrupted nothing");
	assert.equal(decideAcquire(oldLease({ holder: hostHolder }), "s", { ...hostHolder, pid: 21, instance: "other" }, {}, Date.now(), probe()).outcome, "viewer", "one host never displaces another");
});

test("acquireForHost writes the lease under the lock and a stale writer loses", () => {
	const dir = tmp();
	const file = path.join(dir, "s.jsonl");
	fs.writeFileSync(file, "{}\n");
	const old = new Date(Date.now() - 10 * 60_000);
	fs.utimesSync(file, old, old);
	const store = new LeaseStore(dir, probe());
	fs.mkdirSync(path.join(dir, "leases"), { recursive: true });
	fs.writeFileSync(path.join(dir, "leases", "s.json"), JSON.stringify(oldLease({ holder: null, epoch: 2, sessionFile: file })));
	const got = store.acquireForHost("s", hostHolder);
	assert.ok("lease" in got && got.lease.epoch === 3);
	assert.equal(store.read("s")?.holder?.kind, "host");
	assert.equal(store.holds("s", hostHolder, 3), true);
});

test("a release that carries a stale epoch does not end a later lease of the same holder", () => {
	const dir = tmp("pi-loops-lease-");
	const store = new LeaseStore(dir);
	const file = path.join(dir, "conv.jsonl");
	fs.writeFileSync(file, "{}\n");
	const host: LeaseHolder = { kind: "host", pid: process.pid, instance: "host", procStart: procStart(process.pid), acquiredAt: new Date().toISOString(), pushServers: [] };
	store.acquire("s", { ...me, pid: process.pid, procStart: procStart(process.pid) }, { sessionFile: file });
	store.release("s", { ...me, pid: process.pid });
	const first = store.acquireForHost("s", host, Date.now() + 200_000, 0);
	assert.ok("lease" in first);
	assert.equal(store.release("s", host, { epoch: first.lease.epoch }), true);
	const second = store.acquireForHost("s", host, Date.now() + 400_000, 0);
	assert.ok("lease" in second);
	assert.equal(store.release("s", host, { epoch: first.lease.epoch }), false, "turn 1's late release is refused");
	assert.equal(store.read("s")?.holder?.kind, "host", "turn 2 still holds it");
});

test("the host's own last write does not trip the quiet guard; anyone else's does", () => {
	const now = Date.parse("2026-01-01T12:00:00Z");
	const left = now - 30_000;
	const released = oldLease({ holder: null, sessionFile: "/c.jsonl", hostLeftMtime: left });
	assert.ok("lease" in decideHostAcquire(released, hostHolder, left, now, probe()), "the file is as the host left it");
	assert.deepEqual(decideHostAcquire(released, hostHolder, left + 1, now, probe()), { refused: "session file changed in the last two minutes" }, "someone wrote it since");
});
