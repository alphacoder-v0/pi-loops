import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { type CheckOptions, checkRequest, type HostStatus, openForLaunch, type PageServer, renderHostPage, type RequestFacts, sessionRows } from "../src/page-server.ts";
import { openFileDir } from "../src/open-file.ts";
import { DELIVERY_JOB_ID, LeaseStore } from "../src/lease.ts";
import type { SessionLease } from "../src/lease.ts";
import { fakePi, firstVisit, mintKey, secretIn, startTestPage, TEST_TOKEN, until } from "./page-harness.ts";

const TOKEN = "a".repeat(32);
const OPTS: CheckOptions = { token: TOKEN, allowHosts: ["pi.example.test"], loopback: true };
const HERE = "127.0.0.1:4173";
const get = (facts: Partial<RequestFacts> = {}): RequestFacts => ({ method: "GET", path: "/state", host: HERE, remote: "127.0.0.1", ...facts });
const post = (facts: Partial<RequestFacts> = {}): RequestFacts => get({ method: "POST", path: "/prompt", ...facts });

test("no credential is 401; a wrong one is 403", () => {
	assert.deepEqual(checkRequest(get(), OPTS), { status: 401, why: "no token" });
	assert.deepEqual(checkRequest(get({ headerToken: "b".repeat(32) }), OPTS), { status: 403, why: "bad token" });
	assert.deepEqual(checkRequest(get({ queryToken: `é${TOKEN.slice(1)}` }), OPTS), { status: 403, why: "bad token" }, "a token of the wrong byte length");
	assert.deepEqual(checkRequest(post({ origin: `http://${HERE}` }), OPTS), { status: 401, why: "no token" }, "a POST with nothing to carry");
});

test("a foreign Host is refused, whatever it carries", () => {
	assert.deepEqual(checkRequest(get({ host: "evil.example:4173", queryToken: TOKEN }), OPTS), { status: 403, why: "forbidden host" });
	assert.deepEqual(checkRequest(get({ host: "pi.example.test.evil.example", queryToken: TOKEN }), OPTS), { status: 403, why: "forbidden host" }, "a name that only starts with an allowed one");
	assert.deepEqual(checkRequest(get({ host: "10.0.0.5:4173", queryToken: TOKEN }), OPTS), { status: 403, why: "forbidden host" }, "a bare IP on a loopback-bound server");
	assert.deepEqual(checkRequest(get({ host: "10.0.0.5:4173", queryToken: TOKEN }), { ...OPTS, loopback: false }), { ok: true, via: "query" }, "a bare IP when bound to the network");
});

test("a .ts.net name passes from loopback and the tailnet, and not from elsewhere", () => {
	const tailnet = { host: "box.tail1234.ts.net", queryToken: TOKEN };
	assert.deepEqual(checkRequest(get({ ...tailnet, remote: "127.0.0.1" }), OPTS), { ok: true, via: "query" });
	assert.deepEqual(checkRequest(get({ ...tailnet, remote: "::ffff:100.101.1.2" }), OPTS), { ok: true, via: "query" });
	assert.deepEqual(checkRequest(get({ ...tailnet, remote: "192.168.1.20" }), OPTS), { status: 403, why: "forbidden host" });
});

test("an allow-listed name passes, in any case", () => {
	assert.deepEqual(checkRequest(get({ host: "PI.example.test:4173", queryToken: TOKEN }), OPTS), { ok: true, via: "query" });
	const two = { ...OPTS, allowHosts: ["pi.example.test", "box.local"] };
	assert.deepEqual(checkRequest(get({ host: "BOX.LOCAL", queryToken: TOKEN }), two), { ok: true, via: "query" }, "any name on the list, with no port");
	assert.deepEqual(checkRequest(get({ host: "other.example.test:4173", queryToken: TOKEN }), two), { status: 403, why: "forbidden host" }, "and no name off it");
});

test("a request another site started is refused, token or not", () => {
	for (const facts of [{ secFetchSite: "cross-site" }, { secFetchSite: "same-site" }, { origin: "http://localhost:5173" }, { origin: "null" }, { origin: "not a url" }]) {
		assert.equal((checkRequest(get({ ...facts, queryToken: TOKEN }), OPTS) as { status: number }).status, 403, JSON.stringify(facts));
		assert.equal((checkRequest(post({ ...facts, headerToken: TOKEN }), OPTS) as { status: number }).status, 403, `POST ${JSON.stringify(facts)}`);
	}
});

test("a POST takes the token from the header, never from its URL", () => {
	assert.deepEqual(checkRequest(post({ queryToken: TOKEN }), OPTS), { status: 403, why: "token in the query string is refused on POST" });
	assert.deepEqual(checkRequest(post({ queryToken: TOKEN, headerToken: TOKEN }), OPTS), { status: 403, why: "token in the query string is refused on POST" }, "even beside the header");
	assert.deepEqual(checkRequest(post({ headerToken: TOKEN }), OPTS), { ok: true, via: "header" }, "the header and no Origin");
	assert.deepEqual(checkRequest(post({ headerToken: "b".repeat(32), secFetchSite: "same-origin" }), OPTS), { status: 403, why: "bad token" }, "a header with the wrong token proves nothing");
	assert.deepEqual(checkRequest(post({ device: "d".repeat(32), secFetchSite: "same-origin", origin: `http://${HERE}` }), OPTS), { status: 401, why: "no token" }, "and no cookie is a credential");
});

test("a GET keeps today's rule: no Origin passes, and the query still counts", () => {
	assert.deepEqual(checkRequest(get({ queryToken: TOKEN }), OPTS), { ok: true, via: "query" });
	assert.deepEqual(checkRequest(get({ headerToken: TOKEN }), OPTS), { ok: true, via: "header" });
});

test("a refused POST writes nothing under the loops directory", { timeout: 30_000 }, async () => {
	const dir = tmp("pi-loops-page-server-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		await page.pool.open({ sessionId: "s1", cwd: dir, piArgs: [] });
		const send = (headers: Record<string, string>) =>
			fetch(`${page.url}c/s1/prompt`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ text: "rm -rf ~" }) });

		const { cookie } = await firstVisit(page, "s1");
		const foreign = await send({ origin: "http://evil.example", cookie, "x-pi-web-token": TEST_TOKEN });
		assert.equal(foreign.status, 403, "a foreign Origin");
		assert.deepEqual(await foreign.json(), { error: "cross-site request refused" });
		const bare = await send({});
		assert.equal(bare.status, 401, "no credential");
		assert.deepEqual(await bare.json(), { error: "no token" });
		const formPost = await send({ cookie, "sec-fetch-site": "same-origin" });
		assert.equal(formPost.status, 401, "the device cookie and nothing else");
		assert.deepEqual(await formPost.json(), { error: "no token" });
		const notJson = await fetch(`${page.url}c/s1/prompt`, { method: "POST", headers: { "x-pi-web-token": TEST_TOKEN, "content-type": "text/plain" }, body: JSON.stringify({ text: "rm -rf ~" }) });
		assert.equal(notJson.status, 415, "a post that is not JSON");

		assert.equal(fs.existsSync(path.join(page.loops, "requests")), false, "nothing reached requests/");
	} finally {
		await page.stop();
	}
});

test("a conversation the page does not have and no lease names is 404, and starts nothing", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-server-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		const unknown = await page.get("c/01a0-nobody/state");
		assert.equal(unknown.status, 404);
		assert.deepEqual(unknown.body, { error: "no such conversation" });
		assert.equal((await page.get("state")).status, 404, "and nothing answers outside /c/<id>/");
		assert.deepEqual(page.pool.list(), [], "no pi was started for it");
	} finally {
		await page.stop();
	}
});

/** A GET with the headers as written: fetch sets Sec-Fetch-Mode itself, and a browser's navigation needs it. */
function navGet(url: string, p: string, headers: Record<string, string>): Promise<{ status: number; cookie: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request(new URL(url), { method: "GET", path: p, headers }, (res) => {
			res.resume();
			resolve({ status: res.statusCode ?? 0, cookie: (res.headers["set-cookie"] ?? []).join(", ") });
		});
		req.on("error", reject);
		req.end();
	});
}

/** One request sent as written: fetch would resolve the dot segments before they reached the server. */
function rawGet(url: string, p: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = http.request(new URL(url), { method: "GET", path: p, headers: { "x-pi-web-token": TEST_TOKEN } }, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("error", reject);
		req.end();
	});
}

test("a session id that would leave the directory is refused", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-server-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }), { server: { sessions: { known: () => ({ cwd: dir, sessionFile: path.join(dir, "s.jsonl") }) } } });
	try {
		for (const p of ["/c/../x/state", "/c/..%2Fx/state", "/c/%2e%2e/state", "/c/a%2F..%2F..%2Fx/state"]) {
			assert.equal(await rawGet(page.url, p), 404, p);
		}
		assert.deepEqual(page.pool.list(), [], "even with every id known, none of these started a pi");
	} finally {
		await page.stop();
	}
});

/* ------------------------------------------------------------------ the Background view */

const zero = { runs: 0, failed: 0, findings: 0 };
const snap = () => ({ pid: 7, host: "machine", startedAt: "now", version: "5", runs: [], checks: [], jobs: { enabled: 1, total: 1 }, rules: { enabled: 2, total: 2 }, inboxNew: 0, mcp: [] });
const status = (): HostStatus => ({ snapshot: snap(), managed: "spawned", sessions: [] });
const lease = (sessionId: string, holder: SessionLease["holder"], extra: Partial<SessionLease> = {}): SessionLease => ({ v: 1, sessionId, holder, epoch: 1, updatedAt: "now", cwd: "/work", sessionFile: "/work/session.jsonl", ...extra });

test("sessionRows unions ids, counts sources and orders holder groups", () => {
	const rows = sessionRows({
		leases: [
			lease("z-term", { kind: "terminal", pid: 2, instance: "i", acquiredAt: "t", mode: "rpc", pushServers: ["mcp"] }),
			lease("a-host", { kind: "host", pid: 3, instance: "h", acquiredAt: "h", pushServers: [], busy: { runId: "run", jobId: "job", since: "h" } }),
			lease("dead", { kind: "terminal", pid: 4, instance: "d", acquiredAt: "d", pushServers: [] }),
		],
		plainJobSessions: ["z-term", "z-term", "orphan"], ruleSessions: ["a-host", "orphan", "orphan"], mailbox: new Map([["mail", 2], ["orphan", 1]]),
		legacy: [{ sessionId: "legacy", pid: 9 }, { sessionId: "dead", pid: 8 }], alive: (h) => h.pid !== 4, since: () => zero, title: () => undefined, jobName: () => undefined,
	});
	assert.deepEqual(rows.map((r) => [r.sessionId, r.holder.kind]), [["z-term", "terminal"], ["a-host", "host"], ["dead", "legacy-pi"], ["legacy", "legacy-pi"], ["mail", "nobody"], ["orphan", "nobody"]]);
	assert.deepEqual(rows[0].holder, { kind: "terminal", pid: 2, mode: "rpc", since: "t", pushServers: ["mcp"] });
	assert.deepEqual(rows[1].holder, { kind: "host", busy: "run", since: "h" }, "a job with no name: the run's short id");
	assert.deepEqual([rows[5].plainJobs, rows[5].rules, rows[5].mailbox], [1, 2, 1]);
	assert.equal(rows[0].cwd, "/work");
});

test("the Background view names a turn pi-loops holds by its job's name, else the run's short id", () => {
	// The column used to read "running" and the job's 32-character id, which no person ever typed.
	const runId = "0c1d2e3f40516273849506a7b8c9d0e1";
	const rows = sessionRows({
		leases: [
			lease("named", { kind: "host", pid: 3, instance: "h", acquiredAt: "h", pushServers: [], busy: { runId, jobId: "a".repeat(32), since: "h" } }),
			lease("unnamed", { kind: "host", pid: 3, instance: "h", acquiredAt: "h", pushServers: [], busy: { runId, jobId: "b".repeat(32), since: "h" } }),
		],
		plainJobSessions: [], ruleSessions: [], mailbox: new Map(), legacy: [], alive: () => true, since: () => zero, title: () => undefined,
		jobName: (id) => (id === "a".repeat(32) ? "nightly <triage>" : undefined),
	});
	const page = renderHostPage({ ...status(), sessions: rows });
	assert.ok(page.includes("<td>pi-loops — running nightly &lt;triage&gt;</td>"), page);
	assert.ok(page.includes(`<td>pi-loops — running ${runId.slice(0, 12)}</td>`), page);
	assert.equal(page.includes("a".repeat(32)) || page.includes("b".repeat(32)), false, "and no job id");
});

test("live lease beats legacy and dead lease without legacy becomes nobody", () => {
	const rows = sessionRows({ leases: [lease("x", { kind: "host", pid: 2, instance: "h", acquiredAt: "at", pushServers: [] }), lease("y", { kind: "terminal", pid: 4, instance: "d", acquiredAt: "at", pushServers: [] })], plainJobSessions: [], ruleSessions: [], mailbox: new Map(), legacy: [{ sessionId: "x", pid: 8 }], alive: (h) => h.pid === 2, since: () => zero, title: () => undefined, jobName: () => undefined });
	assert.deepEqual(rows.map((r) => r.holder.kind), ["host", "nobody"]);
});

test("a terminal holder whose lease says page is the page's, listed after the terminals", () => {
	const rows = sessionRows({
		leases: [lease("p", { kind: "terminal", pid: 5, instance: "c", acquiredAt: "at", mode: "rpc", pushServers: [], page: true }), lease("t", { kind: "terminal", pid: 6, instance: "w", acquiredAt: "at", mode: "tui", pushServers: [] })],
		plainJobSessions: [], ruleSessions: [], mailbox: new Map(), legacy: [], alive: () => true, since: () => zero, title: () => undefined, jobName: () => undefined,
	});
	assert.deepEqual(rows.map((r) => r.holder), [{ kind: "terminal", pid: 6, mode: "tui", since: "at", pushServers: [] }, { kind: "page", pid: 5, since: "at" }]);
	assert.ok(renderHostPage({ ...status(), sessions: rows }).includes("<td>the page, pid 5</td>"));
});

test("the Background view tells conversations apart by their title or first message", () => {
	const holder = { kind: "terminal" as const, pid: 6, instance: "w", acquiredAt: "at", mode: "tui" as const, pushServers: [] };
	const rows = sessionRows({
		leases: [lease("01a19f65-9e05", holder, { sessionFile: "/work/a.jsonl" }), lease("01a19f65-aaaa", holder, { sessionFile: "/work/b.jsonl" })],
		plainJobSessions: ["01a19f65-cccc"], ruleSessions: [], mailbox: new Map(), legacy: [], alive: () => true, since: () => zero,
		title: (file) => (file === "/work/a.jsonl" ? "fix <b>the</b> bug" : undefined), jobName: () => undefined,
	});
	assert.deepEqual(rows.map((r) => [r.sessionId, r.title]), [["01a19f65-9e05", "fix <b>the</b> bug"], ["01a19f65-aaaa", undefined], ["01a19f65-cccc", undefined]]);
	const page = renderHostPage({ ...status(), sessions: rows });
	assert.ok(page.includes("<td>01a19f65 &quot;fix &lt;b&gt;the&lt;/b&gt; bug&quot;</td>"), page);
	assert.ok(page.includes("<td>01a19f65</td>"), "no title known: the id alone, as before");
});

test("HTML escapes status values, has no script, and names pi-loops in the background", () => {
	const s = status();
	s.sessions = [{ sessionId: "123456789", cwd: "<script>alert(1)</script>", holder: { kind: "nobody" }, plainJobs: 0, rules: 0, mailbox: 0, sinceYouLooked: zero }];
	const page = renderHostPage(s);
	assert.equal(page.includes("<script>alert(1)</script>"), false);
	assert.ok(page.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
	assert.equal(page.includes("<script"), false);
	assert.ok(page.includes("<title>pi-loops in the background</title>"));
	assert.equal(/\bhost\b/i.test(page.replace(/<[^>]*>/g, " ").replace(/machine/g, "")), false, "the words on it never say host");
	assert.equal(page.includes("token"), false, "and nothing on it carries the token");
});

test("the Background view is drawn in the page's palette, both schemes, and links back to the page", () => {
	const page = renderHostPage(status());
	assert.ok(page.includes("--bg:#f2f2f7;") && page.includes("--bg:#000000;"), "the page's paper in light and in dark");
	assert.ok(page.includes("--brand:#9a5500;") && page.includes("--brand:#ffb340;"), "and its amber");
	assert.match(page, /<a href="\/">[^<]*back to the page<\/a>/);
});

test("the Background view shows the request queues in the words pi-loops status uses", () => {
	const s = status();
	s.snapshot.requests = [{ sessionId: "424aba43-0000", count: 2, oldest: new Date(Date.now() - 5 * 60_000).toISOString(), dead: 1, holder: { kind: "terminal", pid: 939915 } }];
	const page = renderHostPage(s);
	assert.ok(page.includes("<h2>Requests</h2>"));
	assert.ok(page.includes("<li>requests: 2 queued in 1 session(s)</li>"), page);
	assert.ok(page.includes("<li>424aba43: 2 queued · oldest 5m · dead: 1 · in pi 939915</li>"), page);
	assert.equal(renderHostPage(status()).includes("Requests"), false, "nothing queued, no section");
});

test("GET / with no conversation to open is the Background view; /background and /background.json answer to the token or a paired browser", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-server-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }), { server: { background: status } });
	try {
		const root = await fetch(`${page.url}?token=${TEST_TOKEN}`);
		assert.equal(root.status, 200);
		const first = await root.text();
		assert.match(first, /<h1>pi-loops in the background<\/h1>/);
		assert.match(root.headers.get("set-cookie") ?? "", DEVICE_SET_COOKIE, "and the browser is paired from here on");
		const secret = secretIn(first);
		assert.match(secret, /^[0-9a-f]{64}$/, "the first visit hands the view the device secret to keep");
		const nonce = /script-src 'nonce-([^']+)'/.exec(root.headers.get("content-security-policy") ?? "")?.[1];
		assert.ok(nonce && first.includes(`<script nonce="${nonce}">`), "under a nonce the view's policy names");
		const cookie = (root.headers.get("set-cookie") ?? "").split(";")[0];
		const html = await fetch(`${page.url}background`, { headers: { cookie } });
		assert.equal(html.status, 200);
		const later = await html.text();
		assert.match(later, /pid 7 · pi-loops 5 · spawned/);
		assert.equal(later.includes("DEVICE_SECRET"), false, "and a later look carries no secret");
		assert.equal(later.split("<script").length, 2, "its one script is the theme's");
		assert.ok(later.indexOf('localStorage.getItem("theme")') < later.indexOf("<style>"), "applied before the first paint");
		assert.deepEqual((await page.get("background.json")).body, status());
		assert.equal((await fetch(`${page.url}background.json`)).status, 401, "not without the token");
		assert.deepEqual(page.pool.list(), [], "and looking started no pi");
	} finally {
		await page.stop();
	}
});

test("nothing under src/ serves the old status page: no port 4174, and host-page-token only where it is removed", () => {
	const files = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]));
	const src = path.join(process.cwd(), "src");
	const said = (needle: string) => files(src).filter((f) => fs.readFileSync(f, "utf8").includes(needle)).map((f) => path.relative(src, f));
	assert.deepEqual(said("4174"), []);
	assert.deepEqual(said("host-page-token"), ["host.ts"]);
	assert.match(fs.readFileSync(path.join(src, "host.ts"), "utf8"), /fs\.unlinkSync\(path\.join\(dir, "host-page-token"\)\)/, "and there it is only unlinked");
});

test("a pi printing malformed JSON and a 5 MB line, then closing its input, never reaches uncaughtException", { timeout: 30_000 }, async () => {
	const dir = tmp("pi-loops-page-server-");
	const fake = path.join(dir, "rude-pi");
	fs.writeFileSync(
		fake,
		[
			"#!/usr/bin/env node",
			'process.stdout.write("{not json\\n[1,2]\\nnull\\n\\"a string\\"\\n");',
			'process.stdout.write("x".repeat(5 * 1024 * 1024) + "\\n");',
			'process.stdout.write(JSON.stringify({ type: "message_update", text: "y".repeat(5 * 1024 * 1024) }) + "\\n");',
			'require("node:fs").closeSync(0);',
			"setInterval(() => {}, 1e9);",
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	const uncaught: unknown[] = [];
	const onUncaught = (err: unknown) => void uncaught.push(err);
	process.on("uncaughtException", onUncaught);
	process.on("unhandledRejection", onUncaught);
	const page = await startTestPage(dir, fake);
	try {
		const child = await page.pool.open({ sessionId: "rude", cwd: dir, piArgs: [] });
		await new Promise((r) => setTimeout(r, 1500));
		for (let i = 0; i < 5; i++) child.writeToPi(`${JSON.stringify({ type: "get_state", id: `poke-${i}` })}\n`);
		await new Promise((r) => setTimeout(r, 500));
		assert.equal(child.alive, false, "its closed input is noticed");
		const history = await page.get("c/rude/history");
		assert.equal(history.status, 200, "and its page still answers");
		assert.deepEqual(history.body.messages, []);
		assert.deepEqual(uncaught, [], "nothing escaped to the process");
	} finally {
		await page.stop();
		process.off("uncaughtException", onUncaught);
		process.off("unhandledRejection", onUncaught);
	}
});

test("a key or a code spent on the waiting page still pairs the browser, so the refresh gets in", { timeout: 30_000 }, async () => {
	// The open key is one shot and the waiting page reloads itself every five seconds: without the
	// device on that first answer, the reload arrived with a spent key and met the door.
	const dir = tmp("pi-loops-page-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }), { server: { heldTurn: () => ({ runId: "run-1", label: "nightly" }), sessions: { known: () => ({ cwd: dir, sessionFile: path.join(dir, "s.jsonl") }) } } });
	try {
		const key = page.server.openKeyFor("s1");
		const first = await fetch(`${page.url}c/s1/?open=${key}`);
		assert.equal(first.status, 200);
		const waiting = await first.text();
		assert.match(waiting, /nightly/, "the waiting page names the run");
		const cookie = first.headers.get("set-cookie") ?? "";
		assert.match(cookie, DEVICE_SET_COOKIE, "the key's one load leaves the device cookie");
		assert.match(secretIn(waiting), /^[0-9a-f]{64}$/, "and hands the waiting page its secret to keep");
		assert.equal(waiting.includes(TEST_TOKEN), false, "but never the token");
		const refresh = await fetch(`${page.url}c/s1/`, { headers: { cookie: cookie.split(";")[0] } });
		assert.equal(refresh.status, 200, "and the refresh is signed in");
		assert.equal(secretIn(await refresh.text()), "", "without the secret a second time");
		assert.equal((await fetch(`${page.url}c/s1/?open=${key}`)).status, 403, "the key itself is spent");
		const code = page.server.newPairCode();
		const paired = await fetch(`${page.url}c/s1/?pair=${code}`);
		assert.equal(paired.status, 200);
		assert.match(paired.headers.get("set-cookie") ?? "", DEVICE_SET_COOKIE, "so does the pairing code's");
	} finally {
		await page.stop();
	}
});

test("the launch's open file is 0600 in a 0700 directory, holds the keyed address, and goes when the key is spent", { timeout: 30_000 }, async () => {
	// Found on a75ea1c: the launcher ran xdg-open on the keyed address, and any account on the
	// machine could read it in /proc/<pid>/cmdline and trade it for the token first.
	const dir = tmp("pi-loops-page-server-");
	const loops = path.join(dir, "loops");
	const stale = path.join(openFileDir(loops), "left-by-a-dead-process.html");
	fs.mkdirSync(path.dirname(stale), { recursive: true });
	fs.writeFileSync(stale, "old");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		assert.equal(fs.existsSync(stale), false, "a file left by a process before this one is swept at start");
		await page.pool.open({ sessionId: "s1", cwd: dir, piArgs: [] });
		const { openKey, openFile } = page.server.openFileFor("s1");
		assert.equal(path.dirname(openFile), openFileDir(loops));
		assert.equal(path.basename(openFile).includes(openKey), false, "the file's name, which the opener's argv carries, is not the key");
		assert.equal(fs.statSync(openFile).mode & 0o777, 0o600);
		assert.equal(fs.statSync(openFileDir(loops)).mode & 0o777, 0o700);
		const html = fs.readFileSync(openFile, "utf8");
		assert.ok(html.includes(`${page.url}c/s1/?open=${openKey}`), "it sends the browser to the keyed page");
		const opened = await fetch(`${page.url}c/s1/?open=${openKey}`);
		assert.equal(opened.status, 200);
		await opened.text();
		assert.equal(fs.existsSync(openFile), false, "spending the key removes the file");
		const unspent = page.server.openFileFor("s1").openFile;
		page.server.close();
		assert.equal(fs.existsSync(unspent), false, "an unspent one goes with the page");
	} finally {
		await page.stop();
	}
});

test("the launch file's hand-off, a cross-site navigation, spends the open key; a frame or a pairing guess that way does not", { timeout: 30_000 }, async () => {
	// Found on the first cut of the launch file: Chrome sends the load from a file: page as
	// Sec-Fetch-Site cross-site, the key was refused, and the browser met the door.
	const dir = tmp("pi-loops-page-server-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	const fromFile = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
	try {
		await page.pool.open({ sessionId: "s1", cwd: dir, piArgs: [] });
		const framed = page.server.openFileFor("s1");
		const frame = await navGet(page.url, `/c/s1/?open=${framed.openKey}`, { ...fromFile, "sec-fetch-dest": "iframe" });
		assert.equal(frame.status, 403, "a frame on another site is not the browser opening the page");
		const code = page.server.newPairCode();
		const guess = await navGet(page.url, `/c/s1/?pair=${code}`, fromFile);
		assert.equal(guess.status, 403, "the six digits stay behind the cross-site lock");
		const { openKey, openFile } = page.server.openFileFor("s1");
		const opened = await navGet(page.url, `/c/s1/?open=${openKey}`, fromFile);
		assert.equal(opened.status, 200, "the launch file's hand-off opens the page");
		assert.ok(opened.cookie.split(", ").some((c) => DEVICE_SET_COOKIE.test(c)), "and signs the browser in");
		assert.equal(fs.existsSync(openFile), false, "spending the key");
		assert.equal((await navGet(page.url, `/c/s1/?open=${openKey}`, {})).status, 403, "which then opens nothing");
	} finally {
		await page.stop();
	}
});

test("an open key is spent by any trusted load that carries it, signed in or not", { timeout: 30_000 }, async () => {
	// The key rides in the launcher's argv, which any account on the machine can read. A browser that
	// was already signed in used to leave it unspent, so whoever read it had a minute to trade it for
	// the token.
	const dir = tmp("pi-loops-page-server-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		await page.pool.open({ sessionId: "s1", cwd: dir, piArgs: [] });
		const key = page.server.openKeyFor("s1");
		const signedIn = await fetch(`${page.url}c/s1/?open=${key}`, { headers: { "x-pi-web-token": TEST_TOKEN } });
		assert.equal(signedIn.status, 200, "the signed-in load opens the page");
		await signedIn.text();
		const stranger = await fetch(`${page.url}c/s1/?open=${key}`);
		assert.equal(stranger.status, 403, "and the key it carried opens nothing after it");
		await stranger.text();
	} finally {
		await page.stop();
	}
});

test("a browser's own form post passes with Origin null when it says same-origin, and nothing else that says null does", () => {
	// The waiting page sends `referrer-policy: no-referrer`, so Chrome posts its Stop it form with
	// Origin null; the same request says Sec-Fetch-Site: same-origin, which no page can forge.
	assert.deepEqual(checkRequest(post({ headerToken: TOKEN, origin: "null", secFetchSite: "same-origin" }), OPTS), { ok: true, via: "header" });
	for (const facts of [{ origin: "null" }, { origin: "null", secFetchSite: "cross-site" }, { origin: "null", secFetchSite: "same-site" }, { origin: "http://evil.example", secFetchSite: "cross-site" }, { origin: "http://evil.example" }]) {
		assert.equal((checkRequest(post({ ...facts, headerToken: TOKEN }), OPTS) as { status: number }).status, 403, JSON.stringify(facts));
	}
});

/** A form post sent as written, with the headers a browser would set and fetch would not. */
function formPost(url: string, p: string, headers: Record<string, string>): Promise<{ status: number; location?: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request(new URL(url), { method: "POST", path: p, headers: { "content-type": "application/x-www-form-urlencoded", "content-length": "0", ...headers } }, (res) => {
			res.resume();
			resolve({ status: res.statusCode ?? 0, location: res.headers.location });
		});
		req.on("error", reject);
		req.end();
	});
}

test("a page's pi that took its conversation back standing aside reads it again from disk, once per wait", { timeout: 30_000 }, async () => {
	// Found on a75ea1c (lane 8): after the terminal quit, the page's pi took the lease back marked
	// aside and asked for /resume, and the page offered no way to resume the session it was in.
	const dir = tmp("pi-loops-page-server-");
	const file = path.join(dir, "s1.jsonl");
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "s1", cwd: dir })}\n`);
	const log = path.join(dir, "rpc.jsonl");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1", sessionFile: file, log, commands: ["pi-loops"] }));
	const swaps = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((m) => m.type === "switch_session") : []);
	try {
		const child = await page.pool.open({ sessionId: "s1", cwd: dir, piArgs: [] });
		const leases = new LeaseStore(page.loops);
		const own = { kind: "terminal" as const, pid: child.pid, instance: "page-pi", acquiredAt: new Date().toISOString(), mode: "rpc" as const, pushServers: [] };
		assert.ok("lease" in leases.acquire("s1", own, { cwd: dir }));
		await page.get("c/s1/state");
		assert.deepEqual(swaps(), [], "a pi that is current is left alone");
		assert.equal(leases.setAside("s1", own, 1), true);
		await page.get("c/s1/state");
		assert.ok(await until(() => swaps().length === 1), "the next poll has it read the conversation again");
		assert.equal(swaps()[0].sessionPath, file, "the conversation it is in, and no other");
		await page.get("c/s1/state");
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(swaps().length, 1, "and not again on every poll while it still stands aside");
	} finally {
		await page.stop();
	}
});

test("the 0.22.8 token cookie is cleared on any answer to a browser that still sends it", { timeout: 20_000 }, async () => {
	// 0.24 keeps the same web-token, so a browser paired on 0.22.8 still holds the live token in
	// pi_web_token, and a cookie goes to every port on 127.0.0.1 for a year.
	const dir = tmp("pi-loops-page-server-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	const CLEARED = /(^|, )pi_web_token=; Path=\/; Max-Age=0/;
	try {
		await page.pool.open({ sessionId: "s1", cwd: dir, piArgs: [] });
		const door = await navGet(page.url, "/", { cookie: `pi_web_token=${TEST_TOKEN}` });
		assert.equal(door.status, 403, "the old cookie is no credential");
		assert.match(door.cookie, CLEARED, "the door clears it");
		const first = await navGet(page.url, `/c/s1/?open=${page.server.openKeyFor("s1")}`, { cookie: `pi_web_token=${TEST_TOKEN}` });
		assert.equal(first.status, 200);
		assert.match(first.cookie, CLEARED, "so does the page");
		assert.ok(first.cookie.split(", ").some((c) => DEVICE_SET_COOKIE.test(c)), "beside the device cookie it sets");
		const none = await navGet(page.url, "/", {});
		assert.doesNotMatch(none.cookie, /pi_web_token/, "a browser without it is not told about it");
	} finally {
		await page.stop();
	}
});

test("the token on a device the page knows does not re-enroll it, so the secret that browser keeps still works", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-server-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		await page.pool.open({ sessionId: "s1", cwd: dir, piArgs: [] });
		const first = await fetch(`${page.url}c/s1/?open=${page.server.openKeyFor("s1")}`);
		const secret = secretIn(await first.text());
		const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
		const tokened = await fetch(`${page.url}c/s1/`, { headers: { cookie, "x-pi-web-token": TEST_TOKEN } });
		assert.equal(tokened.status, 200);
		assert.equal(tokened.headers.get("set-cookie"), null, "no new device");
		assert.equal(secretIn(await tokened.text()), "", "and no new secret");
		const traded = await fetch(`${page.url}c/s1/token`, { method: "POST", headers: { cookie, "x-pi-web-device-secret": secret } });
		assert.equal(traded.status, 200, "the first secret still trades for the token");
		await traded.text();
		// The address pi-loops prints: a known device that lost this origin's secret (the port moved)
		// still signs in with it.
		const typed = await fetch(`${page.url}c/s1/?token=${TEST_TOKEN}`, { headers: { cookie } });
		assert.match(typed.headers.get("set-cookie") ?? "", DEVICE_SET_COOKIE, "?token= is a first visit");
		assert.match(secretIn(await typed.text()), /^[0-9a-f]{64}$/, "and hands over a secret");
		const stranger = await fetch(`${page.url}c/s1/`, { headers: { "x-pi-web-token": TEST_TOKEN } });
		assert.match(stranger.headers.get("set-cookie") ?? "", DEVICE_SET_COOKIE, "a browser with no device still gets one from the token");
		await stranger.text();
	} finally {
		await page.stop();
	}
});

test("Stop it stops the run a lease names when pi-loops has not said which turn it is yet", { timeout: 20_000 }, async () => {
	// Found on a75ea1c: Stop it aborted only through heldTurn, so a wait that came from pi-loops's lease
	// alone (it takes the lease, then claims the job) answered the button and stopped nothing.
	const dir = tmp("pi-loops-page-server-");
	const aborted: string[] = [];
	const leases = new LeaseStore(path.join(dir, "loops"));
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }), {
		server: { heldTurn: () => undefined, abortRun: (runId) => {
				aborted.push(runId);
				return true;
			}, sessions: { known: () => ({ cwd: dir, sessionFile: path.join(dir, "s1"), holder: leases.read("s1")?.holder }) } },
	});
	try {
		assert.ok("lease" in leases.acquire("s1", { kind: "host", pid: process.pid, instance: "host", acquiredAt: new Date().toISOString(), pushServers: [], busy: { runId: "run-9", jobId: "cron-1", since: new Date().toISOString() } }, { cwd: dir }));
		const first = await fetch(`${page.url}c/s1/?open=${page.server.openKeyFor("s1")}`);
		assert.match(await first.text(), /Stop it/, "the page waits, with the button");
		const stop = await fetch(`${page.url}c/s1/stop-turn`, { method: "POST", headers: { "x-pi-web-token": TEST_TOKEN, "sec-fetch-site": "same-origin" } });
		assert.equal(stop.status, 204);
		assert.deepEqual(aborted, ["run-9"], "the run the lease names is stopped");
	} finally {
		await page.stop();
	}
});

test("a terminal's conversation with nothing saved yet waits in the page, and a delivery wait has no Stop it", { timeout: 20_000 }, async () => {
	// Found in round 3: the page started a pi for a terminal's new conversation, which had no file, so
	// pi started another conversation and the page showed it under this one's address.
	const dir = tmp("pi-loops-page-server-");
	const leases = new LeaseStore(path.join(dir, "loops"));
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "other" }), {
		server: { sessions: { known: (id) => ({ cwd: dir, sessionFile: path.join(dir, `${id}.jsonl`), holder: leases.read(id)?.holder }) } },
	});
	try {
		assert.ok("lease" in leases.acquire("s1", { kind: "terminal", pid: process.pid, instance: "t", acquiredAt: new Date().toISOString(), mode: "tui", pushServers: [] }, { cwd: dir }));
		const first = await fetch(`${page.url}c/s1/?open=${page.server.openKeyFor("s1")}`);
		assert.equal(first.status, 200);
		assert.match(await first.text(), new RegExp(`open in a terminal \\(pi ${process.pid}\\) and has nothing saved yet`));
		assert.deepEqual(page.pool.list(), [], "no pi was started for it");
		assert.ok("lease" in leases.acquire("s2", { kind: "host", pid: process.pid, instance: "host", acquiredAt: new Date().toISOString(), pushServers: [], busy: { runId: "requests", jobId: DELIVERY_JOB_ID, since: new Date().toISOString() } }, { cwd: dir }));
		fs.writeFileSync(path.join(dir, "s2.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: "s2", cwd: dir })}\n`);
		const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
		const delivery = await fetch(`${page.url}c/s2/`, { headers: { cookie } });
		const html = await delivery.text();
		assert.match(html, /a message delivery/);
		assert.doesNotMatch(html, /Stop it/, "nothing to stop: it ends on its own");
	} finally {
		await page.stop();
	}
});

test("Stop it on the waiting page stops the turn from a real browser, and not from another site or with the cookie alone", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-server-");
	const aborted: string[] = [];
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }), {
		server: { heldTurn: () => ({ runId: "run-1", label: "nightly" }), abortRun: (runId) => {
				aborted.push(runId);
				return true;
			}, sessions: { known: () => ({ cwd: dir, sessionFile: path.join(dir, "s1") }) } },
	});
	try {
		const first = await fetch(`${page.url}c/s1/?open=${page.server.openKeyFor("s1")}`);
		const html = await first.text();
		const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
		const crossSite = await formPost(page.url, "/c/s1/stop-turn", { cookie, "x-pi-web-token": TEST_TOKEN, origin: "http://evil.example", "sec-fetch-site": "cross-site" });
		assert.equal(crossSite.status, 403, "another site");
		const opaque = await formPost(page.url, "/c/s1/stop-turn", { cookie, "x-pi-web-token": TEST_TOKEN, origin: "null" });
		assert.equal(opaque.status, 403, "Origin null with nothing to say it is this page");
		const cookieOnly = await formPost(page.url, "/c/s1/stop-turn", { cookie, origin: "null", "sec-fetch-site": "same-origin" });
		assert.equal(cookieOnly.status, 401, "a form post with the device cookie alone");
		assert.deepEqual(aborted, [], "none of them stopped anything");

		// The button, run as a browser runs it: Chrome sends Origin null and same-origin from this
		// no-referrer page, and the device cookie rides along on its own.
		const nonce = /script-src 'nonce-([^']+)'/.exec(first.headers.get("content-security-policy") ?? "")?.[1];
		const script = new RegExp(`<script nonce="${nonce}">([\\s\\S]*?)</script>`).exec(html)?.[1];
		assert.ok(script, "the waiting page carries its script under the nonce its policy names");
		const stored = new Map<string, string>();
		const button: { onclick?: () => Promise<void> } = {};
		let reloaded = false;
		// Redirects are followed, with the headers, as a browser's fetch follows them: a 303 that led to
		// a header-authenticated GET of the page re-enrolled the device and signed the browser out.
		const browserFetch = (u: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
			fetch(`${page.url}${u.slice(1)}`, { ...init, headers: { ...init.headers, cookie, origin: "null", "sec-fetch-site": "same-origin" } });
		new Function("document", "localStorage", "fetch", "location", script as string)(
			{ getElementById: (id: string) => (id === "stop" ? button : null) },
			{ getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) },
			browserFetch,
			{ reload: () => { reloaded = true; } },
		);
		assert.match(stored.get("pi-loops-device") ?? "", /^[0-9a-f]{64}$/, "the first visit kept its secret");
		await button.onclick?.();
		assert.deepEqual(aborted, ["run-1"], "Stop it stopped the run it named");
		assert.ok(reloaded, "and the waiting page loads again");
		const reload = await fetch(`${page.url}c/s1/`, { headers: { cookie } });
		assert.equal(reload.status, 200, "the reload is signed in");
		await reload.text();
		const traded = await fetch(`${page.url}c/s1/token`, { method: "POST", headers: { cookie, "x-pi-web-device-secret": stored.get("pi-loops-device") ?? "", "sec-fetch-site": "same-origin" } });
		assert.equal(traded.status, 200, "and the secret this browser kept still trades for the token");
		await traded.text();
		assert.deepEqual(page.pool.list(), [], "no pi was started for the conversation while it is held");
	} finally {
		await page.stop();
	}
});

const DEVICE_SET_COOKIE = /^pi_web_device=[0-9a-f]{32}; Path=\/; Max-Age=31536000; HttpOnly; SameSite=Strict$/;

test("a first visit leaves a device cookie and hands the secret once; a reload carries neither token nor secret", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-server-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		await page.pool.open({ sessionId: "s1", cwd: dir, piArgs: [] });
		const first = await firstVisit(page, "s1");
		assert.equal(first.status, 200);
		assert.match(first.setCookie, DEVICE_SET_COOKIE, "the one cookie is the device's");
		assert.equal(first.setCookie.includes(TEST_TOKEN), false, "and the token is not in it");
		assert.ok(first.html.includes(TEST_TOKEN), "the first page carries the token");
		assert.match(first.secret, /^[0-9a-f]{64}$/, "and the device secret");

		const reload = await fetch(`${page.url}c/s1/`, { headers: { cookie: first.cookie } });
		assert.equal(reload.status, 200, "the device cookie brings the page back");
		const html = await reload.text();
		assert.equal(html.includes(TEST_TOKEN), false, "without the token in it");
		assert.equal(html.includes(first.secret), false, "or the secret");
		assert.equal(secretIn(html), "", "it hands no secret at all");
		assert.equal(reload.headers.get("set-cookie"), null, "and sets nothing");

		const file = path.join(page.loops, "web-devices.json");
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		const devices = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.equal(devices.v, 1);
		assert.deepEqual(Object.keys(devices.devices), [first.cookie.split("=")[1]], "the device is recorded");
		assert.equal(JSON.stringify(devices).includes(first.secret), false, "by a hash of its secret");
	} finally {
		await page.stop();
	}
});

test("a device cookie alone reaches nothing behind the token; with its secret it is traded for the token", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-server-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		await page.pool.open({ sessionId: "s1", cwd: dir, piArgs: [] });
		const { cookie, secret } = await firstVisit(page, "s1");
		const state = await fetch(`${page.url}c/s1/state`, { headers: { cookie } });
		assert.equal(state.status, 401, "the cookie alone on /state");
		assert.deepEqual(await state.json(), { error: "no token" });

		const trade = (headers: Record<string, string>) => fetch(`${page.url}c/s1/token`, { method: "POST", headers: { "sec-fetch-site": "same-origin", ...headers } });
		const alone = await trade({ cookie });
		assert.equal(alone.status, 403, "the cookie without its secret");
		assert.deepEqual(await alone.json(), { error: "bad device secret" });
		assert.match(alone.headers.get("set-cookie") ?? "", /^pi_web_device=; Path=\/; Max-Age=0;/, "and the browser that sent it is told to drop its cookie");
		const traded = await trade({ cookie, "x-pi-web-device-secret": secret });
		assert.equal(traded.status, 200, "the cookie and its secret");
		assert.deepEqual(await traded.json(), { token: TEST_TOKEN });
		const noCookie = await trade({ "x-pi-web-device-secret": secret });
		assert.equal(noCookie.status, 401, "the secret without the cookie");
		const cross = await trade({ cookie, "x-pi-web-device-secret": secret, "sec-fetch-site": "cross-site" });
		assert.equal(cross.status, 403, "and never for another site");

		// Twenty wrong secrets forget the device: the cookie is nothing after that, even with the right one.
		for (let i = 1; i < 20; i++) assert.equal((await trade({ cookie, "x-pi-web-device-secret": "f".repeat(64) })).status, 403);
		assert.equal((await trade({ cookie, "x-pi-web-device-secret": "f".repeat(64) })).status, 403, "the twentieth");
		assert.equal((await trade({ cookie, "x-pi-web-device-secret": secret })).status, 401, "the device is forgotten");
		const door = await fetch(`${page.url}c/s1/`, { headers: { cookie } });
		assert.equal(door.status, 403, "and its page is the door again");
		await door.text();
	} finally {
		await page.stop();
	}
});

test("a FIFO named as a file is refused at once, and the rest of the page keeps answering", { timeout: 20_000 }, async () => {
	// Found in round 3: open(2) on a FIFO with no writer blocks, and this is the event loop of the
	// process that runs every loop, rule and conversation. Broken, this test blocks the whole test
	// process rather than failing: the open stops the event loop its own timeout runs on.
	const dir = tmp("pi-loops-page-server-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		await page.pool.open({ sessionId: "s1", cwd: dir, piArgs: [] });
		execFileSync("mkfifo", [path.join(dir, "report.html")]);
		const key = await mintKey(page, "s1", "file", "report.html");
		const r = await fetch(`${page.url}c/s1/file?path=report.html&key=${key}`, { signal: AbortSignal.timeout(5_000) });
		assert.equal(r.status, 404, "not a file");
		await r.text();
		const other = await fetch(`${page.url}manifest.webmanifest`, { signal: AbortSignal.timeout(5_000) });
		assert.equal(other.status, 200, "and the server was never stuck");
		await other.text();
	} finally {
		await page.stop();
	}
});

test("the event stream, a file and a preview open with a key minted for them, and not with the cookie or ?token=", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-server-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		await page.pool.open({ sessionId: "s1", cwd: dir, piArgs: [] });
		fs.writeFileSync(path.join(dir, "a.png"), "a");
		fs.writeFileSync(path.join(dir, "b.png"), "b");
		const { cookie } = await firstVisit(page, "s1");
		const status = async (p: string, headers: Record<string, string> = {}) => {
			const ac = new AbortController();
			const r = await fetch(`${page.url}${p}`, { headers, signal: ac.signal });
			ac.abort();
			return r.status;
		};

		assert.equal(await status("c/s1/events", { cookie }), 401, "the stream with the cookie");
		assert.equal(await status(`c/s1/events?token=${TEST_TOKEN}`), 401, "the stream with ?token=");
		const events = await mintKey(page, "s1", "events");
		assert.equal(await status(`c/s1/events?key=${events}`), 200, "the stream with its key");
		assert.equal(await status(`c/s1/events?key=${events}`), 200, "and again, as an EventSource reconnects");

		assert.equal(await status("c/s1/file?path=a.png", { cookie }), 401, "a file with the cookie");
		assert.equal(await status(`c/s1/file?path=a.png&token=${TEST_TOKEN}`), 401, "a file with ?token=");
		const forA = await mintKey(page, "s1", "file", "a.png");
		assert.equal(await status(`c/s1/file?path=b.png&key=${forA}`), 403, "a key for a.png does not open b.png");
		const forA2 = await mintKey(page, "s1", "file", "a.png");
		assert.equal(await status(`c/s1/file?path=a.png&key=${forA2}`), 200, "a key for a.png opens a.png");
		assert.equal(await status(`c/s1/file?path=a.png&key=${forA2}`), 403, "once");
		assert.equal(await status(`c/s1/file?path=a.png&key=${events}`), 403, "and the stream's key opens no file");

		const made = await page.post("c/s1/preview", { html: "<p>hi</p>" });
		const id = made.body.id as string;
		assert.equal(await status(`preview/${id}`, { cookie }), 401, "a preview with the cookie");
		assert.equal(await status(`preview/${id}?token=${TEST_TOKEN}`), 401, "a preview with ?token=");
		const forPreview = await mintKey(page, "s1", "preview", id);
		assert.equal(await status(`preview/${id}?key=${forPreview}`), 200, "a preview with its key");
		assert.equal(await status(`preview/${id}?key=${forPreview}`), 403, "once");

		const bad = await page.post("c/s1/key", { for: "rpc" });
		assert.equal(bad.status, 400, "a key is only for those three");
		assert.equal((await fetch(`${page.url}c/s1/key`, { method: "POST", headers: { cookie, "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ for: "events" }) })).status, 401, "and minting one takes the token");
	} finally {
		await page.stop();
	}
});

test("a sniffed device cookie: a server on another port receives it, and nothing it does with it reaches /state, /prompt or the token", { timeout: 30_000 }, async () => {
	// Cookies ignore ports. The browser's jar is keyed by host alone, so the cookie this page sets is
	// sent to anything else listening on 127.0.0.1; that server is the one this test plays.
	const dir = tmp("pi-loops-page-server-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	const seen: string[] = [];
	const sniffer = http.createServer((req, res) => {
		seen.push(String(req.headers.cookie ?? ""));
		res.end("ok");
	});
	await new Promise<void>((r) => sniffer.listen(0, "127.0.0.1", r));
	try {
		await page.pool.open({ sessionId: "s1", cwd: dir, piArgs: [] });
		const first = await firstVisit(page, "s1");
		const jar = first.setCookie.split(";")[0];
		await (await fetch(`http://127.0.0.1:${(sniffer.address() as { port: number }).port}/`, { headers: { cookie: jar } })).text();
		const stolen = seen[0];
		assert.ok(stolen, "the other port got the cookie");
		assert.equal(stolen.includes(TEST_TOKEN), false, "and the token is not in it");

		// Everything a process holding that cookie can send, with every header a browser would add.
		const forged = { cookie: stolen, "sec-fetch-site": "same-origin", origin: page.url.replace(/\/$/, "") };
		assert.equal((await fetch(`${page.url}c/s1/state`, { headers: forged })).status, 401, "/state");
		const prompt = await fetch(`${page.url}c/s1/prompt`, { method: "POST", headers: { ...forged, "content-type": "application/json" }, body: JSON.stringify({ text: "rm -rf ~" }) });
		assert.equal(prompt.status, 401, "/prompt");
		assert.equal((await fetch(`${page.url}c/s1/rpc`, { method: "POST", headers: { ...forged, "content-type": "application/json" }, body: JSON.stringify({ type: "bash", command: "id" }) })).status, 401, "/rpc");
		assert.equal((await fetch(`${page.url}c/s1/token`, { method: "POST", headers: forged })).status, 403, "/token without the secret");
		assert.equal((await fetch(`${page.url}c/s1/token`, { method: "POST", headers: { ...forged, "x-pi-web-device-secret": "0".repeat(64) } })).status, 403, "/token with a guess");
		const html = await (await fetch(`${page.url}c/s1/`, { headers: forged })).text();
		assert.equal(html.includes(TEST_TOKEN), false, "the page it can fetch has no token in it");
		assert.equal(secretIn(html), "", "and no secret");
		assert.equal((await fetch(`${page.url}?token=`, { headers: forged })).headers.get("set-cookie"), null, "and fetching it mints nothing new");
		assert.equal(fs.existsSync(path.join(page.loops, "requests")), false, "nothing reached requests/");
	} finally {
		sniffer.close();
		await page.stop();
	}
});

test("a new token signs every paired browser out: the device cookie meets the door until it pairs again", { timeout: 30_000 }, async () => {
	const dir = tmp("pi-loops-page-server-");
	const fake = fakePi(dir, { sessionId: "s1" });
	const before = await startTestPage(dir, fake);
	let cookie = "";
	try {
		await before.pool.open({ sessionId: "s1", cwd: dir, piArgs: [] });
		cookie = (await firstVisit(before, "s1")).cookie;
		assert.equal((await fetch(`${before.url}c/s1/`, { headers: { cookie } })).status, 200, "paired");
	} finally {
		await before.stop();
	}
	const after = await startTestPage(dir, fake, { server: { token: "u".repeat(32) } });
	try {
		await after.pool.open({ sessionId: "s1", cwd: dir, piArgs: [] });
		const door = await fetch(`${after.url}c/s1/`, { headers: { cookie } });
		assert.equal(door.status, 403, "the old device is the door");
		await door.text();
		assert.equal((await fetch(`${after.url}c/s1/token`, { method: "POST", headers: { cookie, "x-pi-web-device-secret": "0".repeat(64) } })).status, 401, "and trades for nothing");
	} finally {
		await after.stop();
	}
});

test("a page-open that arrives before the page is bound starts pi at once, and is answered with the url once the bind settles", { timeout: 30_000 }, async () => {
	const dir = tmp("pi-loops-page-");
	const started = path.join(dir, "started.jsonl");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s-new", argv: started }));
	let bind!: (server: PageServer | undefined) => void;
	const deps = (server: Promise<PageServer | undefined>) => ({ pool: page.pool, server, notServed: () => "the page is not served", heldTurn: () => undefined, lease: () => undefined });
	try {
		let settled = false;
		const opening = openForLaunch({ cwd: dir, piArgs: ["--model", "x"] }, deps(new Promise((r) => (bind = r)))).finally(() => (settled = true));
		assert.ok(await until(() => fs.existsSync(started), 3000), "pi starts while the page is still binding");
		assert.ok(await until(() => page.pool.has("s-new"), 3000), "and says which conversation it is in");
		assert.equal(settled, false, "the answer waits for the bind: it carries the url");
		bind(page.server);
		const opened = await opening;
		assert.ok(!("error" in opened));
		assert.equal(opened.url, `${page.url}c/s-new/`);
		assert.equal(opened.sessionId, "s-new");

		await page.pool.stop("s-new", "test");
		fs.rmSync(started);
		const refused = openForLaunch({ cwd: dir, piArgs: [] }, deps(new Promise((r) => (bind = r))));
		assert.ok(await until(() => fs.existsSync(started), 3000));
		bind(undefined);
		assert.deepEqual(await refused, { error: "the page is not served" });
		assert.deepEqual(page.pool.list(), [], "the pi started for a page that is not served is stopped again");
	} finally {
		await page.stop();
	}
});

/* ------------------------------------------------------------------ the conversation list */

/** A session file as pi writes one, under `root/<dir>/`: the header and what was said. */
function piSession(root: string, dir: string, name: string, head: { id: string; cwd: string }, said: string[] = [], mtime?: number): string {
	fs.mkdirSync(path.join(root, dir), { recursive: true });
	const file = path.join(root, dir, name);
	const lines = [{ type: "session", version: 3, ...head }, ...said.map((text) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } }))];
	fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	if (mtime !== undefined) fs.utimesSync(file, mtime / 1000, mtime / 1000);
	return file;
}

/** A lease held by this test process, which is alive: a terminal unless `extra` says otherwise. */
function liveLease(loops: string, sessionId: string, sessionFile: string, cwd: string, extra: Record<string, unknown> = {}) {
	fs.mkdirSync(path.join(loops, "leases"), { recursive: true });
	const holder = { kind: "terminal", pid: process.pid, instance: "t", acquiredAt: new Date().toISOString(), mode: "tui", pushServers: [], ...extra };
	fs.writeFileSync(path.join(loops, "leases", `${sessionId}.json`), JSON.stringify({ v: 1, sessionId, sessionFile, cwd, epoch: 1, holder, updatedAt: "now" }));
}

test("GET /conversations lists a project's conversations from pi's files, behind the token, and starts no pi", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-server-");
	const root = path.join(dir, "sessions");
	const api = path.join(dir, "api");
	const web = path.join(dir, "web");
	const held = piSession(root, "--api--", "a.jsonl", { id: "a", cwd: api }, ["release notes"]);
	piSession(root, "--api--", "b.jsonl", { id: "b", cwd: api }, ["fix the cache"], Date.now() - 60_000);
	piSession(root, "--web--", "c.jsonl", { id: "c", cwd: web }, ["landing page"], Date.now() - 3_600_000);
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }), { server: { sessionsRoot: root } });
	let opens = 0;
	const open = page.pool.open.bind(page.pool);
	page.pool.open = (how) => (opens++, open(how));
	try {
		liveLease(page.loops, "a", held, api);
		fs.mkdirSync(path.join(page.loops, "requests"), { recursive: true });
		fs.writeFileSync(path.join(page.loops, "inbox.jsonl"), `${JSON.stringify({ id: "i1", status: "new", kind: "checkpoint", session_id: "b", text: "close #412?" })}\n`);
		assert.equal((await fetch(`${page.url}conversations?cwd=${encodeURIComponent(api)}`)).status, 401, "no token");
		assert.equal((await fetch(`${page.url}conversations`, { headers: { "x-pi-web-token": "b".repeat(32) } })).status, 403, "a wrong one");
		assert.equal((await fetch(`${page.url}conversations`, { headers: { "x-pi-web-token": TEST_TOKEN, "sec-fetch-site": "cross-site" } })).status, 403, "another site's request");
		assert.equal((await fetch(`${page.url}conversations`, { headers: { cookie: `pi_web_device=${"d".repeat(32)}` } })).status, 401, "a device cookie is not a credential here: titles are what people typed");

		const got = await page.get(`conversations?cwd=${encodeURIComponent(api)}`);
		assert.equal(got.status, 200);
		assert.equal(got.body.cwd, api);
		assert.deepEqual(got.body.rows.map((r: any) => [r.sessionId, r.title, r.holder, r.needsYou]), [["a", "release notes", "terminal", 0], ["b", "fix the cache", "none", 1]]);
		assert.equal(got.body.more, 0);
		assert.deepEqual(got.body.projects.map((p: any) => p.cwd), [api, web]);

		assert.equal((await page.get("conversations")).body.cwd, api, "without a cwd: the newest project");
		assert.equal((await page.get("conversations?session=c")).body.cwd, web, "or the project of the conversation the page shows");
		const unknown = await page.get(`conversations?cwd=${encodeURIComponent("/")}`);
		assert.deepEqual([unknown.status, unknown.body], [404, { error: "no such project" }], "a cwd is a key into what was found, not a path to read");
		assert.equal(opens, 0, "listing asked the pool for nothing");
		assert.deepEqual(page.pool.list(), [], "and no pi was started");
	} finally {
		await page.stop();
	}
});

test("GET /conversations answers a warm call for 200 conversations within 300 ms", { timeout: 30_000 }, async () => {
	const dir = tmp("pi-loops-page-server-");
	const root = path.join(dir, "sessions");
	for (let i = 0; i < 200; i++) piSession(root, "--api--", `${i}.jsonl`, { id: `s${i}`, cwd: dir }, [`conversation ${i}`], Date.now() - i * 1000);
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }), { server: { sessionsRoot: root } });
	try {
		assert.equal((await page.get("conversations")).body.rows.length, 200, "cold");
		const at = Date.now();
		const warm = await page.get(`conversations?cwd=${encodeURIComponent(dir)}`);
		const ms = Date.now() - at;
		assert.equal(warm.body.rows.length, 200);
		assert.ok(ms < 300, `a warm answer took ${ms} ms`);
	} finally {
		await page.stop();
	}
});

test("a conversation no lease names opens from pi's own session file, and a made-up id is still 404", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-server-");
	const root = path.join(dir, "sessions");
	const file = piSession(root, "--api--", "2026-11-01_old1.jsonl", { id: "old1", cwd: dir }, ["from before 0.23"]);
	const argv = path.join(dir, "argv.jsonl");
	const page = await startTestPage(dir, fakePi(dir, { argv }), { server: { sessionsRoot: root } });
	try {
		assert.equal((await page.get("c/nobody/state")).status, 404, "a made-up id");
		assert.deepEqual(page.pool.list(), []);
		assert.equal((await page.get("c/old1/state")).status, 200, "pi's own file names it");
		const started = fs.readFileSync(argv, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		assert.deepEqual(started.length, 1);
		assert.equal(started[0][started[0].indexOf("--session") + 1], file, "pi was started on that file");
	} finally {
		await page.stop();
	}
});

test("/state says who holds the conversation, by the rule /prompt follows", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-server-");
	const file = path.join(dir, "s1.jsonl");
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "s1", cwd: dir })}\n`);
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		await page.pool.open({ sessionId: "s1", cwd: dir, piArgs: [] });
		assert.deepEqual((await page.get("c/s1/state")).body.holder, { kind: "none", mine: false, delivers: false, aside: false, piLoops: false }, "nobody");
		liveLease(page.loops, "s1", file, dir);
		assert.deepEqual((await page.get("c/s1/state")).body.holder, { kind: "terminal", pid: process.pid, mine: false, delivers: true, aside: false, piLoops: false }, "a terminal that answers, and a page pi with no pi-loops that would answer here");
		liveLease(page.loops, "s1", file, dir, { aside: true });
		assert.deepEqual((await page.get("c/s1/state")).body.holder, { kind: "terminal", pid: process.pid, mine: false, delivers: false, aside: true, piLoops: false }, "one that stands aside answers nothing");
		liveLease(page.loops, "s1", file, dir, { kind: "host", mode: undefined });
		assert.equal((await page.get("c/s1/state")).body.holder.kind, "background");
	} finally {
		await page.stop();
	}
});

test("a conversation that cannot open because the page is full answers a page with the reason and a way back", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-server-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }), { server: { sessions: { known: () => ({ cwd: dir, sessionFile: path.join(dir, "s1") }) } } });
	page.pool.open = async () => {
		throw new Error("6 conversations are open in the page and none of them is idle; close one to open another");
	};
	try {
		const res = await fetch(`${page.url}c/s1/?token=${TEST_TOKEN}`);
		assert.equal(res.status, 503);
		assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
		const html = await res.text();
		assert.match(html, /6 conversations are open in the page and none of them is idle/);
		assert.match(html, /<a href="\/">/);
	} finally {
		await page.stop();
	}
});

test("the manifest paints the installed window black, as the page's dark paper", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-server-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		const manifest = await (await fetch(`${page.url}manifest.webmanifest`)).json();
		assert.equal(manifest.background_color, "#000000");
		assert.equal(manifest.theme_color, "#000000");
	} finally {
		await page.stop();
	}
});

/* ------------------------------------------------------------------ rework 1 */

test("/state says whether this page's pi has pi-loops, which is what sends a message to the terminal", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-server-");
	const file = path.join(dir, "s1.jsonl");
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "s1", cwd: dir })}\n`);
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1", commands: ["pi-loops"] }));
	try {
		await page.pool.open({ sessionId: "s1", cwd: dir, piArgs: [] });
		liveLease(page.loops, "s1", file, dir);
		assert.deepEqual((await page.get("c/s1/state")).body.holder, { kind: "terminal", pid: process.pid, mine: false, delivers: true, aside: false, piLoops: true });
	} finally {
		await page.stop();
	}
});

test("a conversation opened with no arguments of its own starts with those of its project's latest conversation", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-server-");
	const root = path.join(dir, "sessions");
	piSession(root, "--api--", "2026-11-01_old1.jsonl", { id: "old1", cwd: dir }, ["from the list"]);
	const argv = path.join(dir, "argv.jsonl");
	const page = await startTestPage(dir, fakePi(dir, { argv }), { server: { sessionsRoot: root } });
	try {
		// The terminal's conversation, opened from the launcher with pi-loops loaded by -e.
		liveLease(page.loops, "term1", path.join(root, "--api--", "t.jsonl"), dir);
		page.pool.recordArgs("term1", ["-e", "/opt/pi-loops"]);
		// Another project's, more recent, is not this one's.
		liveLease(page.loops, "other1", "/elsewhere/o.jsonl", "/elsewhere");
		page.pool.recordArgs("other1", ["-e", "/wrong"]);
		assert.equal((await page.get("c/old1/state")).status, 200);
		const started = fs.readFileSync(argv, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		assert.deepEqual(started[0].slice(started[0].indexOf("-e"), started[0].indexOf("-e") + 2), ["-e", "/opt/pi-loops"]);
		assert.deepEqual(page.pool.argsOf("old1"), ["-e", "/opt/pi-loops"], "and they are its own from now on");
	} finally {
		await page.stop();
	}
});

test("the Background view draws a conversation's title as text: no escape sequence or bidi override", () => {
	const s = status();
	s.sessions = [{ sessionId: "123456789", title: "evil \u001b[31mred\u001b[0m \u202ereversed", cwd: "/work/\u202eapi", holder: { kind: "nobody" }, plainJobs: 0, rules: 0, mailbox: 0, sinceYouLooked: zero }];
	const page = renderHostPage(s);
	assert.ok(page.includes("12345678 &quot;evil red reversed&quot;"), page.slice(page.indexOf("<tbody>"), page.indexOf("</tbody>")));
	assert.equal(/[\u001b\u202e]/.test(page), false);
});
