import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { LeaseBinding, LeaseStore, TURN_EVENTS, VIEWER_REREAD_GAP_MS, decideAcquire, markTurnEvent, shouldReadAgain, turnSinceOf, type TurnMarks, decideHostAcquire, holderAlive, openWindowPids, procStart, type LeaseHolder, type ProcessProbe, type SessionLease } from "../src/lease.ts";

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
	assert.ok("lease" in decideHostAcquire(closed, hostHolder, now + 60 * 60_000, now, probe()), "a clock set back an hour does not make every file look just written");
	assert.match((decideHostAcquire(closed, hostHolder, now + 30_000, now, probe()) as any).refused, /changed in the last two minutes/);
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
	assert.equal(Object.hasOwn(out.lease, "preempted"), false, "the lease records no interruption: the host sees it lost the conversation through the epoch");
	const idle = decideAcquire(oldLease({ holder: hostHolder }), "s", me, {}, Date.now(), probe());
	assert.equal(idle.outcome, "acquired");
	assert.deepEqual((idle as any).tookFromHost, { pid: 20, runId: undefined }, "an idle host interrupted nothing");
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

test("an idle conversation's lease can be deleted, a live holder's cannot", () => {
	const dir = tmp("pi-loops-lease-");
	const store = new LeaseStore(dir);
	const live = { ...me, pid: process.pid, procStart: procStart(process.pid) };
	store.acquire("held", live, {});
	store.acquire("idle", live, {});
	store.release("idle", live);
	assert.equal(store.removeIfFree("held"), false);
	assert.equal(store.removeIfFree("idle"), true);
	assert.deepEqual(store.list().map((l) => l.sessionId), ["held"]);
});

test("a window whose copy is behind the file stands aside: it keeps the lease, and fires and delivers nothing until bound again", () => {
	// A viewer that takes over after the holder quit has the conversation as it was when it opened.
	// Its turns would branch off that old entry and leave the holder's turns on a dead branch. Giving
	// the lease back instead would let the background process write into a file open in this window.
	const dir = tmp();
	const file = path.join(dir, "s.jsonl");
	fs.writeFileSync(file, "{}\n");
	const old = new Date(Date.now() - 10 * 60_000);
	fs.utimesSync(file, old, old);
	const store = new LeaseStore(dir, probe());
	const window = new LeaseBinding(store, "w1", () => ({ kind: "terminal", pid: process.pid, mode: "tui", pushServers: [] }), probe());
	assert.equal(window.bind("s", { sessionFile: file }).outcome, "acquired");
	window.standAside();
	assert.deepEqual(window.here(), { sessionId: "s", holds: false }, "still this window's conversation, but nothing of ours fires into it");
	assert.equal(window.heldEpoch("s"), undefined);
	assert.equal(store.read("s")?.holder?.instance, "w1", "the lease stays with the window");
	assert.match((store.acquireForHost("s", hostHolder) as any).refused ?? "", /held by pid/, "so the background process does not write into it");
	assert.equal(window.refresh(), undefined);
	assert.equal(window.bind("s", { sessionFile: file }).outcome, "held", "/resume binds again");
	assert.equal(window.standingAside, false);
	assert.equal(window.here().holds, true);
});

test("the window stands aside when its copy is behind the file, and then writes none of pi-loops' entries", () => {
	// pi-loops.ts has no harness: its source is the thing pinned.
	const source = fs.readFileSync(path.join(process.cwd(), "src", "pi-loops.ts"), "utf8");
	const start = source.indexOf("function noteUnseenEntries(");
	const body = source.slice(start, source.indexOf("\n\t}\n", start));
	assert.match(body, /getEntries\(\)\.length <= ctx\.sessionManager\.getEntries\(\)\.length\) return;[\s\S]*binding\.standAside\(\)/, "behind the file: stand aside");
	assert.match(source, /const mayAppend = \(\): boolean => !!lastCtx && !leaving && binding\.viewerOf === undefined && !binding\.standingAside;/, "nor once it is leaving: the lease goes back during session_shutdown");
	assert.match(source, /if \(ctx\.mode === "tui" && mayAppend\(\)\) pi\.appendEntry<ViewData>\(VIEW_ENTRY/, "a view is an entry only where this window may write");
});

test("the open pi windows are the live terminal holders of leases, not presence files: pi-loops itself and dead holders do not count", () => {
	const dir = tmp("pi-loops-lease-");
	fs.mkdirSync(path.join(dir, "leases"), { recursive: true });
	const write = (sessionId: string, holder: Partial<LeaseHolder> | null) =>
		fs.writeFileSync(path.join(dir, "leases", `${sessionId}.json`), JSON.stringify({ v: 1, sessionId, sessionFile: `/s/${sessionId}.jsonl`, cwd: "/p", epoch: 1, holder: holder && { instance: "i", procStart: procStart(holder.pid!), pushServers: [], ...holder }, updatedAt: new Date().toISOString() }));
	const probe: ProcessProbe = { alive: (pid) => pid !== 999_999, startTime: (pid) => procStart(pid), bootedAt: () => 0 };
	write("01aa0000-0000-7000-8000-000000000001", { kind: "terminal", pid: process.pid });
	write("01aa0000-0000-7000-8000-000000000002", { kind: "host", pid: process.ppid });
	write("01aa0000-0000-7000-8000-000000000003", { kind: "terminal", pid: 999_999 });
	write("01aa0000-0000-7000-8000-000000000004", null);
	assert.deepEqual([...openWindowPids(new LeaseStore(dir), probe)], [process.pid]);
});

const pageHolder: LeaseHolder = { ...me, pid: 30, instance: "page", mode: "rpc", page: true };
const tui: LeaseHolder = { ...me, mode: "tui" };

test("a terminal takes its conversation from the page between turns, at once and at the next epoch", () => {
	const out = decideAcquire(oldLease({ epoch: 4, holder: pageHolder }), "s", tui, {}, Date.now(), probe());
	assert.equal(out.outcome, "acquired");
	assert.equal(out.lease.epoch, 5);
	assert.equal((out as any).tookFromPage, 30);
	assert.equal((out as any).tookFromPid, undefined, "the page's pi is alive: it lost the conversation, it did not die");
	assert.equal(out.lease.holder?.instance, "a");
	assert.equal(out.write, true);
});

test("while the page's turn runs, the terminal is a viewer and writes nothing", () => {
	const out = decideAcquire(oldLease({ holder: { ...pageHolder, turnSince: "2026-01-01T00:00:00.000Z" } }), "s", tui, {}, Date.now(), probe());
	assert.equal(out.outcome, "viewer");
	assert.equal(out.write, false);
});

test("only a tui window takes from the page: rpc, print and json windows view it, and a tui views an rpc window that is not the page", () => {
	for (const mode of ["rpc", "print", "json", "unbound"] as const) assert.equal(decideAcquire(oldLease({ holder: pageHolder }), "s", { ...me, mode }, {}, Date.now(), probe()).outcome, "viewer", mode);
	assert.equal(decideAcquire(oldLease({ holder: { ...pageHolder, page: undefined } }), "s", tui, {}, Date.now(), probe()).outcome, "viewer");
});

test("setTurn writes and deletes turnSince at the holder's epoch, keeps the epoch, and refuses another epoch or holder", () => {
	const store = new LeaseStore(tmp(), probe());
	store.acquire("s", pageHolder);
	assert.equal(store.setTurn("s", pageHolder, 1, "2026-01-01T00:00:01.000Z"), true);
	assert.equal(store.read("s")?.holder?.turnSince, "2026-01-01T00:00:01.000Z");
	assert.equal(store.read("s")?.epoch, 1);
	assert.equal(store.setTurn("s", pageHolder, 2, undefined), false, "a stale epoch");
	assert.equal(store.setTurn("s", { ...pageHolder, instance: "b" }, 1, undefined), false, "not the holder");
	assert.equal(store.read("s")?.holder?.turnSince, "2026-01-01T00:00:01.000Z");
	assert.equal(store.setTurn("s", pageHolder, 1, undefined), true);
	assert.equal(Object.hasOwn(store.read("s")!.holder!, "turnSince"), false);
	assert.equal(store.read("s")?.holder?.page, true, "the rest of the holder stays");
});

test("a tui window viewing the page mid-turn takes the conversation on its first refresh after the turn", () => {
	const store = new LeaseStore(tmp(), probe());
	const page = new LeaseBinding(store, "page", () => ({ kind: "terminal", pid: 30, procStart: "start", mode: "rpc", page: true, pushServers: [] }), probe());
	const window = new LeaseBinding(store, "w1", () => ({ kind: "terminal", pid: 10, procStart: "start", mode: "tui", pushServers: [] }), probe());
	assert.equal(page.bind("s").outcome, "acquired");
	page.setTurn("2026-01-01T00:00:01.000Z");
	assert.equal(window.bind("s").outcome, "viewer");
	assert.equal(window.refresh()?.outcome, "viewer", "still mid-turn");
	page.setTurn(undefined);
	const taken = window.refresh();
	assert.equal(taken?.outcome, "acquired");
	assert.equal((taken as any).tookFromPage, 30);
	assert.equal(window.here().holds, true);
	assert.equal(page.here().holds, false, "the page's pi sees the lease is gone, as any window does");
	assert.equal(page.refresh()?.outcome, "viewer");
	page.setTurn("2026-01-01T00:00:02.000Z");
	assert.equal(store.read("s")?.holder?.turnSince, undefined, "a viewer writes no turn");
});

test("a page's pi stays mid-turn from agent_start to agent_settled and through a compaction, in pi's own event order", () => {
	const marks = (events: string[]) => {
		let m: TurnMarks = {};
		const seen: Array<string | undefined> = [];
		events.forEach((event, i) => {
			m = markTurnEvent(m, event, `2026-01-01T00:00:0${i}.000Z`);
			seen.push(turnSinceOf(m));
		});
		return seen;
	};
	// A run that pi retries or continues after agent_end: compaction, then agent.continue(), then settled.
	const run = ["agent_start", "agent_end", "session_before_compact", "session_compact", "agent_start", "agent_end", "agent_settled"];
	assert.deepEqual(marks(run), [...Array(6).fill("2026-01-01T00:00:00.000Z"), undefined], "marked from the first agent_start until agent_settled, never cleared by agent_end or by a compaction inside the run");
	// Compaction before the prompt runs before agent_start; /compact runs with no run at all.
	assert.deepEqual(marks(["session_before_compact", "session_compact", "agent_start", "agent_end", "agent_settled"]).slice(0, 2), ["2026-01-01T00:00:00.000Z", undefined]);
	assert.deepEqual(marks(["session_before_compact", "session_compact_failed"]), ["2026-01-01T00:00:00.000Z", undefined], "a compaction that failed or was cancelled ends the mark too");
	assert.deepEqual(Object.keys(TURN_EVENTS).sort(), ["agent_settled", "agent_start", "session_before_compact", "session_compact", "session_compact_failed"]);
});

test("a page holder is a live window like any other: holderAlive and openWindowPids do not look at page or turnSince", () => {
	const live = probe();
	assert.equal(holderAlive(pageHolder, live), true);
	assert.equal(holderAlive({ ...pageHolder, turnSince: "2026-01-01T00:00:00.000Z" }, live), true);
	assert.equal(holderAlive(pageHolder, probe({ alive: () => false })), false);
	const dir = tmp("pi-loops-lease-");
	const store = new LeaseStore(dir, live);
	store.acquire("s", pageHolder);
	store.acquire("t", { ...me, pid: 31 });
	assert.deepEqual([...openWindowPids(store, live)].sort(), [30, 31]);
});

test("the page's pi and a terminal mark their lease, on every event TURN_EVENTS names and on no other, and say they do", () => {
	// pi-loops.ts has no harness: its source is the thing pinned.
	const source = fs.readFileSync(path.join(process.cwd(), "src", "pi-loops.ts"), "utf8");
	assert.match(source, /const pageChild = claimPageChild\(\);/, "the page-child claim, read once and kept across the factory's re-runs (src/page-children.ts)");
	assert.match(source, /new LeaseBinding\([^\n]*\.\.\.\(pageChild \? \{ page: true as const \} : \{\}\)/, "page: true on the holder");
	assert.match(source, /function markTurn\(event: keyof typeof TURN_EVENTS\): void \{\n(?:\t\t\/\/[^\n]*\n)*\t\tif \(!pageChild && leaseMode !== "tui"\) return;/, "a print, json or rpc window that is not the page writes no turn stamp");
	assert.match(source, /new LeaseBinding\([^\n]*\.\.\.\(pageChild \|\| leaseMode === "tui" \? \{ turns: true as const \} : \{\}\)/, "turns: true on a holder that writes them");
	const marked = [...source.matchAll(/markTurn\("(\w+)"\)/g)].map((m) => m[1]).sort();
	assert.deepEqual(marked, Object.keys(TURN_EVENTS).sort());
	for (const event of marked) assert.match(source, new RegExp(`pi\\.on\\("${event}", [^\\n]*\\n(?:\\t\\t[^\\n]*\\n){0,3}?\\t\\tmarkTurn\\("${event}"\\)`), `${event} marks itself`);
});

test("a terminal's turnSince changes no takeover: another window still views a live terminal", () => {
	const terminal = { ...tui, instance: "t", pid: 31, turns: true as const, turnSince: "2026-01-01T00:00:00.000Z" };
	for (const holder of [terminal, { ...terminal, turnSince: undefined }]) {
		const out = decideAcquire(oldLease({ holder }), "s", { ...tui, instance: "b", pid: 32 }, {}, Date.now(), probe());
		assert.equal(out.outcome, "viewer");
		assert.equal(out.write, false);
	}
});

test("shouldReadAgain: only after a terminal's turn, only for a new message, only while idle, at most every few seconds", () => {
	const base = { holder: { kind: "terminal", mine: false, turns: true }, busyHere: false, readMark: { size: 100, mtimeMs: 1 }, now: { size: 180, mtimeMs: 2 }, sinceLastMs: Infinity, newMessage: () => true };
	assert.equal(shouldReadAgain(base), true);
	const no: Array<[string, Partial<typeof base> & Record<string, unknown>]> = [
		["mid-turn", { holder: { ...base.holder, turnSince: "2026-01-01T00:00:00.000Z" } as any }],
		["a terminal that never says when a turn ends", { holder: { kind: "terminal", mine: false } as any }],
		["the page's own pi holds it", { holder: { ...base.holder, mine: true } }],
		["pi-loops in the background holds it", { holder: { ...base.holder, kind: "background" } }],
		["nobody holds it", { holder: undefined as any }],
		["the page's pi is busy", { busyHere: true }],
		["nothing changed", { now: { size: 100, mtimeMs: 1 } }],
		["only a run card or an audit entry was added", { newMessage: () => false }],
		["read again moments ago", { sinceLastMs: VIEWER_REREAD_GAP_MS - 1 }],
	];
	for (const [why, over] of no) assert.equal(shouldReadAgain({ ...base, ...over } as any), false, why);
	let asked = 0;
	shouldReadAgain({ ...base, holder: { ...base.holder, turnSince: "x" } as any, newMessage: () => (asked++, true) });
	assert.equal(asked, 0, "the added bytes are read only when everything else says yes");
});
