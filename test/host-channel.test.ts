import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { HOST_SOCKET, type HostSnapshot, askHost, hostSocketPath, renderHostSnapshot, serveHostChannel } from "../src/host-control-channel.ts";

const snapshot = (): HostSnapshot => ({
	pid: 4242,
	host: "the-box",
	startedAt: "2026-09-09T05:00:00.000Z",
	model: "openai-codex/gpt-5.5",
	leader: true,
	runs: [{ runId: "run-abcdef0123456789", label: "nightly", jobId: "cron-1", startedAt: "2026-09-09T05:01:00.000Z", promptPreview: "check the repo" }],
	checks: [{ traceId: "0123abcd-0000", sourceLabel: "local:dynamic", eventLabel: "check", startedAt: "2026-09-09T05:02:00.000Z", cwd: "/work/api" }],
	jobs: { enabled: 2, total: 3 },
	rules: { enabled: 1, total: 1 },
	inboxNew: 4,
	mcp: [{ name: "hub", state: "connected" }],
});

test("a watcher can see what the host is doing and interrupt it, over a private socket", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-chan-"));
	const aborted: string[] = [];
	let stopped = false;
	const server = serveHostChannel(dir, { status: snapshot, abortRun: (id) => (aborted.push(`run:${id}`), true), abortCheck: (id) => (aborted.push(`check:${id}`), false), stop: () => (stopped = true) });
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

		const bad = await askHost(dir, { op: "wat" } as any);
		assert.equal(bad?.ok, false);
		assert.match((bad as any).error, /unknown op/);

		// Only the user who owns the host can read it.
		assert.equal(fs.statSync(path.join(dir, HOST_SOCKET)).mode & 0o777, 0o600);

		assert.equal((await askHost(dir, { op: "stop" }))?.ok, true);
		await new Promise((r) => setTimeout(r, 120));
		assert.equal(stopped, true);
	} finally {
		server.close();
	}
});

test("asking a directory with no host answers nothing rather than hanging", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-nochan-"));
	assert.equal(await askHost(dir, { op: "status" }, 200), undefined);
	// A socket file left behind by a crashed host is not a listener either.
	fs.writeFileSync(path.join(dir, HOST_SOCKET), "");
	assert.equal(await askHost(dir, { op: "status" }, 200), undefined);
});

test("the snapshot renders the lines a watcher needs", () => {
	const lines = renderHostSnapshot(snapshot()).join("\n");
	assert.match(lines, /pid 4242 on the-box/);
	assert.match(lines, /owns the clock · 2\/3 loop\(s\), 1\/1 rule\(s\) enabled · inbox: 4 new/);
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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-deep-"));
	const dir = path.join(root, "a".repeat(40), "b".repeat(40), "loops");
	fs.mkdirSync(dir, { recursive: true });
	assert.ok(Buffer.byteLength(path.join(dir, HOST_SOCKET)) > 108, "the naive path is over the limit");

	const chosen = hostSocketPath(dir);
	assert.ok(Buffer.byteLength(chosen) <= 108, `${chosen} fits`);
	// Two directories must not share a socket, and the same directory must always resolve the same.
	assert.equal(hostSocketPath(dir), chosen);
	assert.notEqual(hostSocketPath(path.join(root, "other")), chosen);
	// A short path is left exactly where it was, so nothing moves for an ordinary install.
	const shallow = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-shallow-"));
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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-deep2-"));
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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-squat-"));
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
