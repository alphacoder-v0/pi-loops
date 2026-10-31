import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import { tmp } from "./tmp.ts";
import { handleHostPageRequest, pageToken, renderHostPage, serveHostPage, sessionRows, type HostStatus } from "../src/host-page.ts";
import * as path from "node:path";
import type { SessionLease } from "../src/lease.ts";

const zero = { runs: 0, failed: 0, findings: 0 };
const snap = () => ({ pid: 7, host: "machine", startedAt: "now", version: "5", runs: [], checks: [], jobs: { enabled: 1, total: 1 }, rules: { enabled: 2, total: 2 }, inboxNew: 0, mcp: [] });
const status = (): HostStatus => ({ snapshot: snap(), managed: "spawned", sessions: [] });
const request = (over: Partial<Parameters<typeof handleHostPageRequest>[0]> = {}) => handleHostPageRequest({ method: "GET", url: "/?token=secret", headers: { host: "127.0.0.1" }, ...over }, "secret", status);

const lease = (sessionId: string, holder: SessionLease["holder"], extra: Partial<SessionLease> = {}): SessionLease => ({ v: 1, sessionId, holder, epoch: 1, updatedAt: "now", cwd: "/work", sessionFile: "/work/session.jsonl", ...extra });

test("sessionRows unions ids, counts sources and orders holder groups", () => {
	const rows = sessionRows({
		leases: [
			lease("z-term", { kind: "terminal", pid: 2, instance: "i", acquiredAt: "t", mode: "rpc", pushServers: ["mcp"] }),
			lease("a-host", { kind: "host", pid: 3, instance: "h", acquiredAt: "h", pushServers: [], busy: { runId: "run", jobId: "job", since: "h" } }),
			lease("dead", { kind: "terminal", pid: 4, instance: "d", acquiredAt: "d", pushServers: [] }),
		],
		plainJobSessions: ["z-term", "z-term", "orphan"], ruleSessions: ["a-host", "orphan", "orphan"], mailbox: new Map([["mail", 2], ["orphan", 1]]),
		legacy: [{ sessionId: "legacy", pid: 9 }, { sessionId: "dead", pid: 8 }], alive: (h) => h.pid !== 4, since: () => zero,
	});
	assert.deepEqual(rows.map((r) => [r.sessionId, r.holder.kind]), [["z-term", "terminal"], ["a-host", "host"], ["dead", "legacy-pi"], ["legacy", "legacy-pi"], ["mail", "nobody"], ["orphan", "nobody"]]);
	assert.deepEqual(rows[0].holder, { kind: "terminal", pid: 2, mode: "rpc", since: "t", pushServers: ["mcp"] });
	assert.deepEqual(rows[1].holder, { kind: "host", busy: "job", since: "h" });
	assert.deepEqual([rows[5].plainJobs, rows[5].rules, rows[5].mailbox], [1, 2, 1]);
	assert.equal(rows[0].cwd, "/work");
});

test("live lease beats legacy and dead lease without legacy becomes nobody", () => {
	const rows = sessionRows({ leases: [lease("x", { kind: "host", pid: 2, instance: "h", acquiredAt: "at", pushServers: [] }), lease("y", { kind: "terminal", pid: 4, instance: "d", acquiredAt: "at", pushServers: [] })], plainJobSessions: [], ruleSessions: [], mailbox: new Map(), legacy: [{ sessionId: "x", pid: 8 }], alive: (h) => h.pid === 2, since: () => zero });
	assert.deepEqual(rows.map((r) => r.holder.kind), ["host", "nobody"]);
});

test("method rejection precedes authentication for all non-GET methods", () => {
	for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD"]) assert.deepEqual(request({ method }), { status: 405, headers: { ...Object.fromEntries(Object.entries({ "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "content-type": "text/plain; charset=utf-8", allow: "GET" }) ) }, body: "method not allowed\n" });
});

test("missing or same-length wrong tokens are rejected with security headers", () => {
	for (const url of ["/", "/?token=secreu"]) {
		const res = request({ url });
		assert.equal(res.status, 401);
		assert.equal(res.body, "bad or missing token\n");
		assert.equal(res.headers["cache-control"], "no-store");
		assert.equal(res.headers["x-content-type-options"], "nosniff");
		assert.equal(res.headers["referrer-policy"], "no-referrer");
		assert.ok(res.headers["content-security-policy"]);
	}
});

test("query and bearer tokens authenticate; foreign hosts are refused", () => {
	assert.equal(request().status, 200);
	assert.equal(request({ url: "/", headers: { host: "localhost", authorization: "Bearer secret" } }).status, 200);
	assert.equal(request({ headers: { host: "evil.example" } }).status, 403);
});

test("tailnet names require a tailnet or loopback source", () => {
	assert.equal(request({ headers: { host: "x.ts.net" }, remoteAddress: "100.101.1.2" }).status, 200);
	assert.equal(request({ headers: { host: "x.ts.net" }, remoteAddress: "8.8.8.8" }).status, 403);
});

test("HTML escapes status values, has no script, and emits security headers", () => {
	const s = status();
	s.sessions = [{ sessionId: "123456789", cwd: "<script>alert(1)</script>", holder: { kind: "nobody" }, plainJobs: 0, rules: 0, mailbox: 0, sinceYouLooked: zero }];
	const page = renderHostPage(s, "secret");
	assert.equal(page.includes("<script>alert(1)</script>"), false);
	assert.ok(page.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
	assert.equal(page.includes("<script"), false);
	assert.ok(page.includes("<title>pi-loops</title>"));
	assert.equal(request().headers["cache-control"], "no-store");
	assert.equal(request().headers["content-type"], "text/html; charset=utf-8");
});

test("status JSON round-trips, unknown paths return 404, status errors are hidden", () => {
	const json = request({ url: "/status.json?token=secret" });
	assert.deepEqual(JSON.parse(json.body), status());
	assert.equal(json.headers["content-type"], "application/json; charset=utf-8");
	assert.equal(request({ url: "/other?token=secret" }).status, 404);
	const failed = handleHostPageRequest({ method: "GET", url: "/?token=secret", headers: { host: "127.0.0.1" } }, "secret", () => { throw new Error("private error"); });
	assert.equal(failed.status, 500);
	assert.equal(failed.body.includes("private error"), false);
});

test("a token as long in characters but not in bytes is refused, not a crash that ends the host", async () => {
	// "é" is one character and two UTF-8 bytes: the length check passed and timingSafeEqual threw.
	for (const res of [request({ url: "/?token=%C3%A9ecret" }), request({ url: "/", headers: { host: "127.0.0.1", authorization: "Bearer \u00e9ecret" } })]) assert.equal(res.status, 401);
	const page = await serveHostPage({ port: 0, token: "secret", status, log: () => {} });
	try {
		assert.equal((await fetch(`${page.url}?token=%C3%A9ecre`)).status, 401);
		assert.equal((await fetch(`${page.url}?token=secret`)).status, 200, "the server is still up");
	} finally {
		page.close();
	}
});

test("a real loopback server answers authenticated requests and rejects a duplicate port", async () => {
	const first = await serveHostPage({ port: 0, token: "secret", status, log: () => {} });
	assert.ok(first.url?.startsWith("http://127.0.0.1:"));
	const answer = await fetch(`${first.url}?token=secret`);
	assert.equal(answer.status, 200);
	const port = new URL(first.url!).port;
	const messages: string[] = [];
	const second = await serveHostPage({ port: Number(port), token: "secret", status, log: (line) => messages.push(line) });
	assert.equal(second.url, undefined);
	assert.deepEqual(messages, [`status page unavailable: 127.0.0.1:${port} in use`]);
	second.close();
	first.close();
});

test("the page token is kept across host starts, 0600, and a symlink in its place is not followed", () => {
	const dir = tmp("pi-loops-page-");
	const first = pageToken(dir);
	assert.match(first, /^[0-9a-f]{32}$/);
	assert.equal(pageToken(dir), first, "a bookmark keeps working after a restart");
	assert.equal(fs.statSync(path.join(dir, "host-page-token")).mode & 0o777, 0o600);
	const other = tmp("pi-loops-page-");
	const elsewhere = path.join(tmp("pi-loops-page-"), "planted");
	fs.writeFileSync(elsewhere, "0123456789abcdef0123456789abcdef\n");
	fs.symlinkSync(elsewhere, path.join(other, "host-page-token"));
	const notes: string[] = [];
	const token = pageToken(other, (m) => notes.push(m));
	assert.notEqual(token, "0123456789abcdef0123456789abcdef", "the planted token is not used");
	assert.match(notes[0] ?? "", /not a regular file/);
});

test("a page token other users had access to, or one that is not a token, is replaced and the new one kept", () => {
	const dir = tmp("pi-loops-page-");
	const file = path.join(dir, "host-page-token");
	fs.writeFileSync(file, "0123456789abcdef0123456789abcdef\n", { mode: 0o644 });
	fs.chmodSync(file, 0o644);
	const notes: string[] = [];
	const token = pageToken(dir, (m) => notes.push(m));
	assert.notEqual(token, "0123456789abcdef0123456789abcdef", "a token another user may have read is not served");
	assert.match(notes[0] ?? "", /other users had access/);
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.equal(pageToken(dir), token, "and the replacement is the one kept");
	fs.writeFileSync(file, "garbage\n", { mode: 0o600 });
	const fresh = pageToken(dir);
	assert.match(fresh, /^[0-9a-f]{32}$/);
	assert.equal(pageToken(dir), fresh, "a damaged file is replaced, not worked around on every start");
});

test("the page shows the request queues in the words pi-loops status uses", () => {
	const s = status();
	s.snapshot.requests = [{ sessionId: "424aba43-0000", count: 2, oldest: new Date(Date.now() - 5 * 60_000).toISOString(), dead: 1, holder: { kind: "terminal", pid: 939915 } }];
	const page = renderHostPage(s, "secret");
	assert.ok(page.includes("<h2>Requests</h2>"));
	assert.ok(page.includes("<li>requests: 2 queued in 1 session(s)</li>"), page);
	assert.ok(page.includes("<li>424aba43: 2 queued · oldest 5m · dead: 1 · in pi 939915</li>"), page);
	assert.equal(renderHostPage(status(), "secret").includes("Requests"), false, "nothing queued, no section");
});
