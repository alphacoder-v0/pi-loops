import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { LeaseStore, decideAcquire, holderAlive, procStart, type LeaseHolder, type ProcessProbe, type SessionLease } from "../src/lease.ts";

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
