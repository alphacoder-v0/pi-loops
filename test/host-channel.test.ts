import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HOST_SOCKET, type HostSnapshot, askHost, renderHostSnapshot, serveHostChannel } from "../src/host-control-channel.ts";

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
