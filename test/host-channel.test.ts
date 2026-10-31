import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { HOST_SOCKET, type HostSnapshot, askHost, hostSocketPath, renderHostSnapshot, keepNotice, noticesToShow, parseRingNote, ringHost, serveHostChannel, type Notice } from "../src/host-control-channel.ts";

const snapshot = (): HostSnapshot => ({
	pid: 4242,
	host: "the-box",
	startedAt: "2026-09-09T05:00:00.000Z",
	model: "openai-codex/gpt-5.5",
	version: "0.23.0",
	sessions: [{ sessionId: "424aba43-0000", pid: 939915, mode: "tui" }],
	runs: [{ runId: "run-abcdef0123456789", label: "nightly", jobId: "cron-1", startedAt: "2026-09-09T05:01:00.000Z", promptPreview: "check the repo" }],
	checks: [{ traceId: "0123abcd-0000", sourceLabel: "local:dynamic", eventLabel: "check", startedAt: "2026-09-09T05:02:00.000Z", cwd: "/work/api" }],
	jobs: { enabled: 2, total: 3 },
	rules: { enabled: 1, total: 1 },
	inboxNew: 4,
	mcp: [{ name: "hub", state: "connected" }],
});

test("a watcher can see what the host is doing and interrupt it, over a private socket", async () => {
	const dir = tmp("pi-loops-chan-");
	const aborted: string[] = [];
	let stopped: string | undefined;
	const server = serveHostChannel(dir, { status: snapshot, abortRun: (id) => (aborted.push(`run:${id}`), true), abortCheck: (id) => (aborted.push(`check:${id}`), false), stop: (reason) => (stopped = reason), run: async (jobId) => (jobId === "cron-ok" ? true : "is no longer in the store") });
	try {
		// `listen()` binds a tick after the call returns; a client asking sooner than any real one
		// would just sees no host.
		await new Promise((r) => setTimeout(r, 60));
		const status = await askHost(dir, { op: "status" });
		assert.equal(status?.ok, true);
		assert.equal((status as any).snapshot.pid, 4242);
		assert.equal((status as any).snapshot.runs[0].label, "nightly");

		assert.equal(((await askHost(dir, { op: "abort", runId: "run-x" })) as any).aborted, true);
		assert.equal(((await askHost(dir, { op: "abort", traceId: "trace-y" })) as any).aborted, false, "an id nothing is running under reports false");
		assert.deepEqual(aborted, ["run:run-x", "check:trace-y"]);

		// `/cron run <loop>` in a window: the host runs it, or says why not in /cron run's own words.
		assert.equal(((await askHost(dir, { op: "run", jobId: "cron-ok" })) as any).ran, true);
		assert.equal(((await askHost(dir, { op: "run", jobId: "cron-gone" })) as any).ran, "is no longer in the store");

		const bad = await askHost(dir, { op: "wat" } as any);
		assert.equal(bad?.ok, false);
		assert.match((bad as any).error, /unknown op/);

		// Only the user who owns the host can read it.
		assert.equal(fs.statSync(path.join(dir, HOST_SOCKET)).mode & 0o777, 0o600);

		assert.equal((await askHost(dir, { op: "upgrade" }))?.ok, true, "a newer window asks it to make way");
		await new Promise((r) => setTimeout(r, 120));
		assert.equal(stopped, "upgrade");
		assert.equal((await askHost(dir, { op: "stop" }))?.ok, true);
		await new Promise((r) => setTimeout(r, 120));
		assert.equal(stopped, "stop");
	} finally {
		server.close();
	}
});

test("asking a directory with no host answers nothing rather than hanging", async () => {
	const dir = tmp("pi-loops-nochan-");
	assert.equal(await askHost(dir, { op: "status" }, 200), undefined);
	// A socket file left behind by a crashed host is not a listener either.
	fs.writeFileSync(path.join(dir, HOST_SOCKET), "");
	assert.equal(await askHost(dir, { op: "status" }, 200), undefined);
});

test("the snapshot renders the lines a watcher needs", () => {
	const lines = renderHostSnapshot(snapshot()).join("\n");
	assert.match(lines, /pid 4242 on the-box/);
	assert.match(lines, /pi-loops 0\.23\.0 · 2\/3 job\(s\), 1\/1 rule\(s\) enabled · inbox: 4 new/);
	assert.match(lines, /conversation 424aba43 open in pid 939915 \(tui\)/, "which windows hold which conversations");
	assert.match(lines, /running nightly \(run-abcdef01\)/);
	assert.match(lines, /checking local:dynamic\/check/);
	assert.match(lines, /mcp hub: connected/);
	const idle = renderHostSnapshot({ ...snapshot(), runs: [], checks: [] }).join("\n");
	assert.match(idle, /nothing running right now/);
});

test("a deeply nested loops directory still gets a control channel", async () => {
	// A unix socket path is capped at 108 bytes (sockaddr_un.sun_path). `PI_LOOPS_DIR` under a few
	// levels of temp directory goes past that, and `listen()` then fails with EINVAL — the host runs
	// on with no control channel, and `pi-loops host status` reports a healthy host as "not
	// answering". Observed with a 113-byte path.
	const root = tmp("pi-loops-deep-");
	const dir = path.join(root, "a".repeat(40), "b".repeat(40), "loops");
	fs.mkdirSync(dir, { recursive: true });
	assert.ok(Buffer.byteLength(path.join(dir, HOST_SOCKET)) > 108, "the naive path is over the limit");

	const chosen = hostSocketPath(dir);
	assert.ok(Buffer.byteLength(chosen) <= 108, `${chosen} fits`);
	// Two directories must not share a socket, and the same directory must always resolve the same.
	assert.equal(hostSocketPath(dir), chosen);
	assert.notEqual(hostSocketPath(path.join(root, "other")), chosen);
	// A short path is left exactly where it was, so nothing moves for an ordinary install.
	const shallow = tmp("pi-loops-shallow-");
	assert.equal(hostSocketPath(shallow), path.join(shallow, HOST_SOCKET));

	let stopped = false;
	const server = serveHostChannel(dir, { status: snapshot, abortRun: () => true, abortCheck: () => false, stop: () => (stopped = true) });
	try {
		await new Promise((r) => setTimeout(r, 60));
		const answer = await askHost(dir, { op: "status" });
		assert.ok(answer?.ok, `the host answers from a deep directory: ${JSON.stringify(answer)}`);
		assert.equal((answer as any).snapshot.pid, 4242);
		assert.equal(stopped, false);
	} finally {
		server.close();
		fs.rmSync(chosen, { force: true });
	}
});

test("the fallback socket lives in a directory this user owns, not loose in /tmp", () => {
	const root = tmp("pi-loops-deep2-");
	const dir = path.join(root, "c".repeat(40), "d".repeat(40), "loops");
	fs.mkdirSync(dir, { recursive: true });
	const chosen = hostSocketPath(dir);
	// Not directly in the shared temp directory: this socket accepts abort and stop, and a
	// predictable path there is a path any local account can bind first.
	assert.notEqual(path.dirname(chosen), os.tmpdir(), chosen);
	assert.match(path.basename(path.dirname(chosen)), /^pi-loops-/);
	// Starting the channel creates that directory closed to everyone else.
	const server = serveHostChannel(dir, { status: snapshot, abortRun: () => true, abortCheck: () => false, stop: () => {} });
	try {
		const mode = fs.lstatSync(path.dirname(chosen)).mode & 0o777;
		assert.equal(mode & 0o077, 0, `0${mode.toString(8)} is not private`);
	} finally {
		server.close();
		fs.rmSync(chosen, { force: true });
	}
});

test("a socket someone else left at that path is not treated as the host", async () => {
	const dir = tmp("pi-loops-squat-");
	const socketPath = path.join(dir, HOST_SOCKET);
	// Stand in for another account's process holding the path: a plain server that answers "ok" to
	// anything. `host stop` would have believed it and never signalled the real host.
	const squatter = net.createServer((c) => c.end(JSON.stringify({ ok: true, aborted: true }) + "\n"));
	await new Promise((r) => squatter.listen(socketPath, () => r(undefined)));
	try {
		// Same uid here — the test cannot become another user — so the check that must hold is the
		// server's: it refuses to take over a socket it did not create.
		const answer = await askHost(dir, { op: "status" });
		assert.equal(answer?.ok, true, "a socket owned by this uid does answer");
		const logs: string[] = [];
		const server = serveHostChannel(dir, { status: snapshot, abortRun: () => true, abortCheck: () => false, stop: () => {} }, (m) => logs.push(m));
		server.close();
		assert.equal(logs.length, 0, "an existing socket of our own is reclaimed, not refused");
	} finally {
		squatter.close();
		fs.rmSync(socketPath, { force: true });
	}
});

test("a window shows each warning from the background once: its own project's and the machine's, and on its first look only the recent ones", () => {
	const now = Date.parse("2026-10-30T12:00:00Z");
	const ago = (min: number) => new Date(now - min * 60_000).toISOString();
	const notices = [
		{ seq: 1, at: ago(60), text: "an hour old", cwd: "/a" },
		{ seq: 2, at: ago(2), text: "cron nightly: parked after 3 interrupted runs", cwd: "/a" },
		{ seq: 3, at: ago(1), text: "another project's", cwd: "/b" },
	];
	const same = (a: string, b: string) => a === b;
	// A window opened after the background process said something still hears what is recent.
	const first = noticesToShow(notices, undefined, 42, "/a", same, now);
	assert.deepEqual(first.show.map((n) => n.text), ["cron nightly: parked after 3 interrupted runs"]);
	const later = [...notices, { seq: 4, at: ago(0), text: "budget reached" }];
	const next = noticesToShow(later, first.seen, 42, "/a", same, now);
	assert.deepEqual(next.show.map((n) => n.text), ["budget reached"], "each once, the machine's too");
	assert.deepEqual(noticesToShow(later, next.seen, 42, "/a", same, now).show, []);
	// A new background process numbers from 1 again; its notices are all new to this window.
	const restarted = noticesToShow([{ seq: 1, at: ago(0), text: "fresh", cwd: "/a" }], next.seen, 43, "/a", same, now);
	assert.deepEqual(restarted.show.map((n) => n.text), ["fresh"]);
});

test("the background process keeps one notice per text an hour, so a broken store is said once, not every tick", () => {
	const kept: Notice[] = [];
	const now = Date.parse("2026-10-30T12:00:00Z");
	let seq = 0;
	seq = keepNotice(kept, seq, "cannot read jobs: broken", undefined, now);
	seq = keepNotice(kept, seq, "cannot read jobs: broken", undefined, now + 30_000);
	assert.equal(kept.length, 1);
	seq = keepNotice(kept, seq, "cannot read jobs: broken", undefined, now + 61 * 60_000);
	assert.equal(kept.length, 2, "and again after an hour");
	keepNotice(kept, seq, "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 leaked", "/a", now);
	assert.doesNotMatch(kept.at(-1)!.text, /sk-ant-api03-abcdef/, "redacted before it is kept");
	for (let i = 0; i < 60; i++) keepNotice(kept, i + 10, `n${i}`, undefined, now);
	assert.equal(kept.length, 50, "at most 50");
});

test("ring accepts request: and lease: notes and refuses anything else", async () => {
	const dir = tmp("pi-loops-ring-");
	const rang: string[] = [];
	const server = serveHostChannel(dir, { status: snapshot, abortRun: () => true, abortCheck: () => false, stop: () => {}, run: async () => true, ring: (sid) => void rang.push(sid) });
	try {
		await new Promise((r) => setTimeout(r, 60));
		assert.equal((await askHost(dir, { op: "ring", note: "request:424aba43-0000" }))?.ok, true);
		assert.equal((await askHost(dir, { op: "ring", note: "lease:424aba43-0000" }))?.ok, true);
		assert.deepEqual(rang, ["424aba43-0000", "424aba43-0000"], "the session is rung, whichever store changed");
		for (const note of ["request:../x", "request:", "lease:", "request:/etc/passwd", "lease:a b", "status", `request:${"x".repeat(500)}`, 42, undefined]) {
			const answer = await askHost(dir, { op: "ring", note } as any);
			assert.equal(answer?.ok, false, `refused: ${JSON.stringify(note)?.slice(0, 40)}`);
			assert.match((answer as any).error, /request:<session> or lease:<session>/);
		}
		assert.equal(rang.length, 2, "a refused note rings nothing");
		assert.deepEqual(parseRingNote("lease:s1"), { kind: "lease", sessionId: "s1" });
		assert.equal(parseRingNote("request:s1\nlease:s2"), undefined, "one note, one line");
		// A producer with no host listening loses nothing but the ring.
		await ringHost(tmp("pi-loops-noring-"), "request:s1");
	} finally {
		server.close();
	}
});

test("the snapshot lists each conversation's request queue: depth, age, dead rows and who would run them", () => {
	const now = Date.parse("2026-09-09T06:00:00.000Z");
	const requests = [
		{ sessionId: "424aba43-0000", count: 2, oldest: "2026-09-09T05:55:00.000Z", dead: 1, holder: { kind: "terminal" as const, pid: 939915 } },
		{ sessionId: "7a1c0000-0000", count: 1, oldest: "2026-09-09T03:00:00.000Z", dead: 0, holder: { kind: "host" as const } },
		{ sessionId: "9e1f0000-0000", count: 1, oldest: "2026-09-09T05:59:30.000Z", dead: 0, holder: { kind: "nobody" as const } },
	];
	const lines = renderHostSnapshot({ ...snapshot(), requests }, now);
	assert.deepEqual(lines.slice(-4), ["  requests: 4 queued in 3 session(s)", "    424aba43: 2 queued · oldest 5m · dead: 1 · in pi 939915", "    7a1c0000: 1 queued · oldest 3h · in the background", "    9e1f0000: 1 queued · oldest 30s · nobody holds it"]);
	assert.doesNotMatch(renderHostSnapshot(snapshot(), now).join("\n"), /requests:/, "nothing queued, nothing said");
	assert.doesNotMatch(renderHostSnapshot({ ...snapshot(), requests: [] }, now).join("\n"), /requests:/);
	// A row the validator let through with a stamp that does not parse is a `?`, not `NaNs`.
	assert.equal(renderHostSnapshot({ ...snapshot(), requests: [{ ...requests[2], oldest: "garbage" }] }, now).at(-1), "    9e1f0000: 1 queued · oldest ? · nobody holds it");
});
