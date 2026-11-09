import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ALREADY_LEAVING, API_KEY_REFUSAL, CONTROL_TIMEOUT_MS, HOST_SOCKET, type HostRequest, type HostSnapshot, askHost, hostSocketPath, renderHostSnapshot, keepNotice, noticesToShow, parseRingNote, ringHost, serveHostChannel, stopRun, type Notice } from "../src/host-control-channel.ts";

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
	const asked: unknown[] = [];
	const server = serveHostChannel(dir, { status: snapshot, abortRun: (id) => (aborted.push(`run:${id}`), true), abortCheck: (id) => (aborted.push(`check:${id}`), false), stop: (reason) => (stopped = reason), run: async (jobId, requestedBy) => (asked.push(requestedBy), jobId === "cron-ok" ? true : "is no longer in the store") });
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
		// Who asked travels with the request, so the run's card goes to that conversation; a request
		// from an older window has no such field and runs as it always did.
		assert.equal(((await askHost(dir, { op: "run", jobId: "cron-ok", requestedBy: { sessionId: "conv-b" } })) as any).ran, true);
		assert.deepEqual(asked, [undefined, undefined, { sessionId: "conv-b" }]);
		const malformed = await askHost(dir, { op: "run", jobId: "cron-ok", requestedBy: { sessionId: 7 } } as any);
		assert.equal(malformed?.ok, false, "a requestedBy that is not a conversation id is refused at the channel");
		assert.match((malformed as any).error, /requestedBy/);
		assert.equal(asked.length, 3, "and never reaches the scheduler");

		const bad = await askHost(dir, { op: "wat" } as any);
		assert.equal(bad?.ok, false);
		assert.match((bad as any).error, /unknown op/);

		// Only the user who owns the host can read it.
		assert.equal(fs.statSync(path.join(dir, HOST_SOCKET)).mode & 0o777, 0o600);

		assert.equal((await askHost(dir, { op: "upgrade" }))?.ok, true, "a newer window asks it to make way");
		await new Promise((r) => setTimeout(r, 120));
		assert.equal(stopped, "upgrade");
	} finally {
		server.close();
	}
});

test("a stop says why, one without a reason is a plain stop, and only the first one leaves", async () => {
	const ask = async (requests: HostRequest[]) => {
		const dir = tmp("pi-loops-chan-reason-");
		const stops: string[] = [];
		const server = serveHostChannel(dir, { status: snapshot, abortRun: () => false, abortCheck: () => false, stop: (reason) => void stops.push(reason) });
		try {
			await new Promise((r) => setTimeout(r, 60));
			const answers = [];
			for (const req of requests) answers.push(await askHost(dir, req));
			await new Promise((r) => setTimeout(r, 120));
			return { stops, answers };
		} finally {
			server.close();
		}
	};
	assert.deepEqual((await ask([{ op: "stop" }])).stops, ["stop"], "as every sender before 0.24 asks");
	assert.deepEqual((await ask([{ op: "stop", reason: "stop" }])).stops, ["stop"]);
	assert.deepEqual((await ask([{ op: "stop", reason: "restart" }])).stops, ["restart"]);
	assert.deepEqual((await ask([{ op: "stop", reason: "upgrade" }])).stops, ["upgrade"]);
	assert.deepEqual((await ask([{ op: "stop", reason: "wat" } as any])).stops, ["stop"], "a reason it does not know is a plain stop");

	// A window that finds the older version asks again every tick while it waits for a turn.
	const again = await ask([{ op: "upgrade" }, { op: "upgrade" }, { op: "stop", reason: "restart" }]);
	assert.deepEqual(again.stops, ["upgrade"], "the wait is not started again");
	assert.deepEqual(again.answers, [{ ok: true }, { ok: true, note: ALREADY_LEAVING }, { ok: true, note: ALREADY_LEAVING }]);
	assert.equal(ALREADY_LEAVING, "already leaving");
	assert.deepEqual((await ask([{ op: "stop", reason: "restart" }, { op: "stop", reason: "restart" }, { op: "upgrade" }])).stops, ["restart"], "nor by a second restart");

	// A person's plain stop during that wait ends it: it leaves now, inside the CLI's own 15 s.
	const cut = await ask([{ op: "upgrade" }, { op: "stop" }, { op: "stop" }, { op: "upgrade" }]);
	assert.deepEqual(cut.stops, ["upgrade", "stop"], "the stop reaches the process once, and starts no wait");
	assert.deepEqual(cut.answers, [{ ok: true }, { ok: true, note: ALREADY_LEAVING }, { ok: true, note: ALREADY_LEAVING }, { ok: true, note: ALREADY_LEAVING }]);
	assert.deepEqual((await ask([{ op: "stop", reason: "restart" }, { op: "stop" }])).stops, ["restart", "stop"]);
	assert.deepEqual((await ask([{ op: "stop" }, { op: "stop" }])).stops, ["stop"], "a plain stop that is already leaving is not asked twice");
});

test("the page's three ops answer over the socket, and page-open refuses what would not be a window", async () => {
	const dir = tmp("pi-loops-chan-");
	const opened: unknown[] = [];
	const server = serveHostChannel(dir, {
		status: snapshot,
		abortRun: () => false,
		abortCheck: () => false,
		stop: () => undefined,
		run: async () => true,
		ring: () => undefined,
		pageOpen: async (req) => (opened.push(req), { url: "http://127.0.0.1:4173/c/s1/", sessionId: "s1", openKey: "k1", reused: true, ignoredArgs: ["--model", "x"] }),
		pageKey: (sessionId) => (sessionId === "s1" ? { openKey: "k2" } : { error: "pi-loops knows no conversation nope" }),
		pair: () => ({ code: "654321", addresses: ["http://192.168.1.5:4173/"] }),
	});
	try {
		await new Promise((r) => setTimeout(r, 60));
		const cwd = tmp("pi-loops-chan-cwd-");
		assert.deepEqual(await askHost(dir, { op: "page-open", cwd, sessionId: "s1", piArgs: ["--model", "x"] }), { ok: true, url: "http://127.0.0.1:4173/c/s1/", sessionId: "s1", openKey: "k1", reused: true, ignoredArgs: ["--model", "x"] });
		assert.deepEqual(opened, [{ cwd, sessionId: "s1", sessionFile: undefined, piArgs: ["--model", "x"] }]);
		for (const flag of ["--mode", "-p", "--print", "--session-dir"]) {
			assert.deepEqual(await askHost(dir, { op: "page-open", cwd, piArgs: ["--model", "x", flag, "json"] }), { ok: false, error: `${flag} would make the child something other than a window` });
		}
		assert.deepEqual(await askHost(dir, { op: "page-open", cwd, piArgs: ["--mode=json"] }), { ok: false, error: "--mode would make the child something other than a window" });
		// A key on pi's command line would be written into pages/ and kept for the next start.
		for (const args of [["--api-key", "sk-secret"], ["--api-key=sk-secret"]]) {
			assert.deepEqual(await askHost(dir, { op: "page-open", cwd, piArgs: ["--model", "x", ...args] }), { ok: false, error: API_KEY_REFUSAL });
		}
		assert.deepEqual(await askHost(dir, { op: "page-open", cwd: "relative/dir", piArgs: [] }), { ok: false, error: "page-open needs cwd, an absolute path to a directory" });
		assert.deepEqual(await askHost(dir, { op: "page-open", cwd: path.join(cwd, "not-there"), piArgs: [] }), { ok: false, error: "page-open needs cwd, an absolute path to a directory" });
		assert.equal(opened.length, 1, "nothing refused reached the page");
		assert.deepEqual(await askHost(dir, { op: "page-key", sessionId: "s1" }), { ok: true, openKey: "k2" });
		assert.deepEqual(await askHost(dir, { op: "page-key", sessionId: "nope" }), { ok: false, error: "pi-loops knows no conversation nope" });
		assert.deepEqual(await askHost(dir, { op: "pair" }), { ok: true, code: "654321", addresses: ["http://192.168.1.5:4173/"] });
	} finally {
		server.close();
	}
});

test("the control socket gives page-open 30 s and every other op 10 s", async () => {
	assert.deepEqual(CONTROL_TIMEOUT_MS, { "page-open": 30_000, other: 10_000 }, "page-open may reap an orphan for 15 s and wait for pi as long again");
	const dir = tmp("pi-loops-chan-");
	const after = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms));
	const handlers = {
		status: snapshot,
		abortRun: () => false,
		abortCheck: () => false,
		stop: () => undefined,
		run: () => after(300, true as const),
		ring: () => undefined,
		pageOpen: () => after(300, { url: "http://127.0.0.1:4173/c/s1/", sessionId: "s1", openKey: "k1" }),
		pageKey: () => ({ openKey: "k" }),
		pair: () => ({ code: "1", addresses: [] }),
	};
	// The same table, scaled down: an answer slower than `other` and faster than `page-open`.
	const server = serveHostChannel(dir, handlers, undefined, { "page-open": 1_000, other: 100 });
	try {
		await new Promise((r) => setTimeout(r, 60));
		const cwd = tmp("pi-loops-chan-cwd-");
		assert.equal((await askHost(dir, { op: "page-open", cwd, piArgs: [] }, 2_000))?.ok, true, "a slow page-open is answered");
		assert.equal(await askHost(dir, { op: "run", jobId: "cron-1" }, 2_000), undefined, "a run as slow is dropped at 10 s, as before");
	} finally {
		server.close();
	}
});

test("a pi-loops waiting on page-open settles when pi-loops drops the connection, rather than exiting mid-wait", async () => {
	const dir = tmp("pi-loops-chan-");
	const server = serveHostChannel(
		dir,
		{ status: snapshot, abortRun: () => false, abortCheck: () => false, stop: () => undefined, run: async () => true, ring: () => undefined, pageOpen: () => new Promise(() => undefined), pageKey: () => ({ openKey: "k" }), pair: () => ({ code: "1", addresses: [] }) },
		undefined,
		{ "page-open": 300, other: 100 },
	);
	try {
		await new Promise((r) => setTimeout(r, 60));
		// Its own process, as `pi-loops` is: nothing but this wait keeps that event loop alive.
		const channel = pathToFileURL(path.join(process.cwd(), "src", "host-control-channel.ts")).href;
		const script = `const { askHost } = await import(${JSON.stringify(channel)}); const res = await askHost(process.env.DIR, { op: "page-open", cwd: process.env.DIR, piArgs: [] }, 5000); console.log(JSON.stringify(res ?? null));`;
		const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
			const child = execFile(process.execPath, ["--import", path.join(process.cwd(), "src", "register-pi.mjs"), "--input-type=module", "-e", script], { env: { ...process.env, DIR: dir }, timeout: 15_000 }, (_err, stdout, stderr) => resolve({ code: child.exitCode, stdout, stderr }));
		});
		assert.equal(run.code, 0, run.stderr);
		assert.equal(run.stdout.trim(), "null", "no answer, said as no answer");
	} finally {
		server.close();
	}
});

test("the page line counts its open conversations, says why it waits, and a page conversation says so", () => {
	const line = (s: Partial<HostSnapshot>) => renderHostSnapshot({ ...snapshot(), ...s }).filter((l) => l.startsWith("  page:"));
	assert.deepEqual(line({ page: "http://127.0.0.1:4173/", pageOpen: 0 }), ["  page: http://127.0.0.1:4173/ · no conversation open"]);
	assert.deepEqual(line({ page: "http://127.0.0.1:4173/", pageOpen: 1 }), ["  page: http://127.0.0.1:4173/ · 1 open conversation"]);
	assert.deepEqual(line({ page: "http://127.0.0.1:4173/", pageOpen: 3 }), ["  page: http://127.0.0.1:4173/ · 3 open conversations"]);
	assert.deepEqual(line({ pageWaiting: "waiting for 127.0.0.1:4173 (an older pi-loops page holds it)" }), ["  page: waiting for 127.0.0.1:4173 (an older pi-loops page holds it)"]);
	assert.deepEqual(line({}), [], "no page and no reason: no line");
	const held = renderHostSnapshot({ ...snapshot(), sessions: [{ sessionId: "abcdef12-0000", pid: 77, mode: "rpc", page: { tabs: 2, idleMs: 5 * 60_000 } }] });
	assert.ok(held.includes("  conversation abcdef12-0000 open in the page (pid 77, 2 tabs, idle 5m)"), held.join("\n"));
});

test("pi-loops status tells conversations apart by their title or first message", () => {
	const lines = renderHostSnapshot({
		...snapshot(),
		sessions: [
			{ sessionId: "01a19f65-9e05-74c8", pid: 10, mode: "tui", title: "fix the login bug" },
			{ sessionId: "01a19f65-aaaa-74c8", pid: 11, mode: "rpc", page: { tabs: 1, idleMs: 5 * 60_000 }, title: "write\u0007 the docs" },
			{ sessionId: "01a19f66-0000", pid: 12, mode: "tui" },
		],
	});
	assert.ok(lines.includes('  conversation 01a19f65-9e05 "fix the login bug" open in pid 10 (tui)'), lines.join("\n"));
	assert.ok(lines.includes('  conversation 01a19f65-aaaa "write  the docs" open in the page (pid 11, 1 tab, idle 5m)'), "a control character in a title reaches no terminal");
	assert.ok(lines.includes("  conversation 01a19f66-0000 open in pid 12 (tui)"), "no title known: the id alone, as before");
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
	assert.match(lines, /pi-loops 0\.23\.0 · 2\/3 loops, 1\/1 rules enabled · inbox: 4 new/);
	assert.match(lines, /conversation 424aba43-0000 open in pid 939915 \(tui\)/, "which windows hold which conversations");
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

test("the snapshot says in plain words what waits for each conversation: how many, how old, what could not be delivered and where it runs", () => {
	const now = Date.parse("2026-09-09T06:00:00.000Z");
	const requests = [
		{ sessionId: "424aba43-0000", count: 2, oldest: "2026-09-09T05:55:00.000Z", dead: 1, holder: { kind: "terminal" as const, pid: 939915 } },
		{ sessionId: "7a1c0000-0000", count: 1, oldest: "2026-09-09T03:00:00.000Z", dead: 0, holder: { kind: "host" as const } },
		{ sessionId: "9e1f0000-0000", count: 1, oldest: "2026-09-09T05:59:30.000Z", dead: 0, holder: { kind: "nobody" as const } },
	];
	const lines = renderHostSnapshot({ ...snapshot(), requests }, now);
	assert.deepEqual(lines.slice(-4), ["  4 messages waiting for 3 conversations, 1 could not be delivered", "    424aba43-0000: 2 waiting · oldest 5m · 1 could not be delivered · open in pid 939915", "    7a1c0000-0000: 1 waiting · oldest 3h · in the background", "    9e1f0000-0000: 1 waiting · oldest 30s · closed"]);
	assert.doesNotMatch(renderHostSnapshot(snapshot(), now).join("\n"), /waiting for/, "nothing queued, nothing said");
	assert.doesNotMatch(renderHostSnapshot({ ...snapshot(), requests: [] }, now).join("\n"), /waiting for/);
	assert.deepEqual(renderHostSnapshot({ ...snapshot(), requests: [requests[1]] }, now).slice(-2), ["  1 message waiting for 1 conversation", "    7a1c0000-0000: 1 waiting · oldest 3h · in the background"], "one of each, and nothing undelivered");
	assert.doesNotMatch(lines.join("\n"), /request|queued|dead|holds/, "the plain words, not the plumbing's");
	// A row the validator let through with a stamp that does not parse is a `?`, not `NaNs`.
	assert.equal(renderHostSnapshot({ ...snapshot(), requests: [{ ...requests[2], oldest: "garbage" }] }, now).at(-1), "    9e1f0000-0000: 1 waiting · oldest ? · closed");
});

test("stopRun: a held turn stops through its conversation's queue, a loop run is aborted, nothing running is finished", async () => {
	const did: string[] = [];
	const deps = (held?: string) => ({
		runs: () => [{ runId: `run-${"a".repeat(32)}` }, { runId: `run-${"b".repeat(32)}` }],
		heldSession: (id: string) => (id === held ? "sess-1" : undefined),
		abortRun: (id: string) => (did.push(`abort:${id}`), true),
		stopThroughRow: (sid: string, id: string) => void did.push(`row:${sid}:${id}`),
	});
	const a = `run-${"a".repeat(32)}`;
	assert.deepEqual(stopRun(a, deps(a), { prefix: false }), { stopping: "row" });
	assert.deepEqual(stopRun(a, deps(), { prefix: false }), { stopping: "run" });
	assert.deepEqual(did, [`row:sess-1:${a}`, `abort:${a}`], "a held turn is never aborted behind its queue's back");
	assert.deepEqual(stopRun(`run-${"c".repeat(32)}`, deps(), { prefix: false }), { finished: true }, "it ended before the stop reached it");
	assert.deepEqual(stopRun("run-aaaa", deps(), { prefix: false }), { finished: true }, "the page sends whole ids: no prefix match");
	assert.deepEqual(stopRun("run-aaaa", deps(), { prefix: true }), { stopping: "run" }, "a typed, shortened id from the status lines");
	assert.deepEqual(stopRun("", deps(), { prefix: true }), { finished: true });
	assert.deepEqual(stopRun(a, { ...deps(), abortRun: () => false }, { prefix: false }), { finished: true });
});

test("the socket's abort answers through stopRun when the process has one, and says a held turn's stop went to its queue", async () => {
	const dir = tmp("pi-loops-chan-stop-");
	const server = serveHostChannel(dir, { status: snapshot, abortRun: () => false, stopRun: (id) => (id === "run-held" ? { stopping: "row" } : id === "run-loop" ? { stopping: "run" } : { finished: true }), abortCheck: () => false, stop: () => undefined });
	try {
		await new Promise((r) => setTimeout(r, 60));
		assert.deepEqual(await askHost(dir, { op: "abort", runId: "run-held" }), { ok: true, aborted: true, stopping: "row" });
		assert.deepEqual(await askHost(dir, { op: "abort", runId: "run-loop" }), { ok: true, aborted: true, stopping: "run" });
		assert.deepEqual(await askHost(dir, { op: "abort", runId: "run-gone" }), { ok: true, aborted: false });
	} finally {
		server.close();
	}
});

test("pi-loops status says a run a person stopped was stopped by you, not FAIL", () => {
	const lines = renderHostSnapshot({ ...snapshot(), recent: [{ job: "pr-watch", at: "2026-11-05T10:00:00Z", ok: false, stopped: true }, { job: "nightly", at: "2026-11-05T09:00:00Z", ok: false, error: "provider 500" }] });
	assert.ok(lines.includes("  stop 2026-11-05T10:00:00Z  pr-watch — stopped by you"), lines.join("\n"));
	assert.ok(lines.includes("  FAIL 2026-11-05T09:00:00Z  nightly — provider 500"));
});

test("pi-loops status names an unnamed loop by its label, as every other surface does", () => {
	const id = "cron-0123456789abcdef0123456789abcdef";
	const lines = renderHostSnapshot({ ...snapshot(), recent: [{ job: id, at: "2026-11-05T10:00:00Z", ok: true }], failing: [{ job: id, error: "boom" }] }).join("\n");
	assert.doesNotMatch(lines, /0123456789abcdef0123456789abcdef/, "never the whole id");
	assert.match(lines, /  cron-01234567\b/, "a recent run");
	assert.match(lines, /! cron-01234567: boom/, "a failing loop");
	assert.match(renderHostSnapshot({ ...snapshot(), failing: [{ job: "pr-watch", error: "boom" }] }).join("\n"), /! pr-watch: boom/, "a name stays a name");
});
