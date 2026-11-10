import { execFileSync, spawn } from "node:child_process";
import { mock, test } from "node:test";
import fsDefault from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { addedMessage, type CheckOptions, checkRequest, historyWithCards, type HostStatus, openForLaunch, type PageServer, readHeldConversation, renderHostPage, type RequestFacts, sessionRows } from "../src/page-server.ts";
import { entriesReadable, HELD_READ_MAX_BYTES } from "../src/held-read.ts";
import { openFileDir } from "../src/open-file.ts";
import { PAGE_INSTANCE, pageClaimRow } from "../src/engine.ts";
import { RequestStore } from "../src/requests.ts";
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
		// A person who opens that address gets a page with a way back, not JSON.
		const opened = await fetch(`${page.url}c/01a0-nobody/`, { headers: { "x-pi-web-token": TEST_TOKEN } });
		assert.equal(opened.status, 404);
		assert.match(opened.headers.get("content-type") ?? "", /^text\/html/);
		const html = await opened.text();
		assert.ok(html.includes("<p>No such conversation.</p>") && html.includes('<a href="/">Back</a>'), html);
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

const zero = { runs: 0, failed: 0, findings: 0, mine: 0 };
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
	assert.ok(page.includes("<td>the background, running nightly &lt;triage&gt;</td>"), page);
	assert.ok(page.includes(`<td>the background, running ${runId.slice(0, 12)}</td>`), page);
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
	assert.ok(renderHostPage({ ...status(), sessions: rows }).includes("<td>this page</td>"));
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
	assert.ok(page.includes("<td>01a19f65-9e05 &quot;fix &lt;b&gt;the&lt;/b&gt; bug&quot;</td>"), page);
	assert.ok(page.includes("<td>01a19f65-aaaa</td>"), "no title known: the id alone, as before");
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

test("the Background view shows what waits in the words pi-loops status uses, where it is open left to the table", () => {
	const s = status();
	s.snapshot.requests = [{ sessionId: "424aba43-0000", count: 2, oldest: new Date(Date.now() - 5 * 60_000).toISOString(), dead: 1, holder: { kind: "terminal", pid: 939915 } }];
	const page = renderHostPage(s);
	assert.ok(page.includes("<h2>Waiting</h2>"));
	assert.ok(page.includes("<li>2 messages waiting for 1 conversation, 1 could not be delivered</li>"), page);
	assert.ok(page.includes("<li>424aba43-0000: 2 waiting · oldest 5m · 1 could not be delivered</li>"), page);
	assert.equal(page.includes("939915"), false, "no pid");
	assert.equal(renderHostPage(status()).includes("Waiting"), false, "nothing waits, no section");
});

test("the Background view uses the page's words and the page's times: no pid, spawned, held by, mailbox or plain job", () => {
	const s = status();
	s.snapshot = { ...snap(), pid: 4242, startedAt: "2026-11-09T11:27:55.479+00:00", nextDue: "2026-11-10T08:00:00.000+00:00", runs: [{ runId: "run-0123456789ab", label: "nightly", startedAt: "2026-11-09T11:30:00.000+00:00", promptPreview: "check the repo" }], recent: [{ ok: true, at: "2026-11-09T11:00:00.000+00:00", job: "nightly" }] } as any;
	const terminal = { kind: "terminal" as const, pid: 6262, instance: "w", acquiredAt: "at", mode: "tui" as const, pushServers: [] };
	s.sessions = sessionRows({ leases: [lease("01a1c010-83af", terminal)], plainJobSessions: ["01a1c010-83af"], ruleSessions: [], mailbox: new Map([["01a1c010-83af", 1]]), legacy: [], alive: () => true, since: () => zero, title: () => undefined, jobName: () => undefined });
	const page = renderHostPage(s);
	const words = page.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]*>/g, " ");
	for (const plumbing of [/\bpid\b/, /4242|6262/, /spawned/, /held by/, /mailbox/, /plain job/, /\bsession\b/i, /run-0123/]) assert.doesNotMatch(words, plumbing, String(plumbing));
	assert.match(page, /<th>conversation<\/th><th>project<\/th><th>where<\/th><th>loops<\/th><th>rules<\/th><th>waiting<\/th>/);
	assert.ok(page.includes("<td>a terminal</td>"), page);
	for (const iso of ["2026-11-09T11:27:55.479+00:00", "2026-11-10T08:00:00.000+00:00", "2026-11-09T11:30:00.000+00:00", "2026-11-09T11:00:00.000+00:00"]) assert.ok(page.includes(`<time datetime="${iso}">`), `${iso} is a time the page's clock writes`);
	const one = renderHostPage({ ...status(), snapshot: { ...snap(), recent: [{ ok: true, at: "now", job: "cron-15c11c9f364f92b42c49f6d15ea2bff6" }, { ok: true, at: "now", job: "pr-watch" }] } as any, sessions: sessionRows({ leases: [], plainJobSessions: [], ruleSessions: [], mailbox: new Map([["01a1c010-83af", 1]]), legacy: [], alive: () => true, since: () => ({ runs: 1, failed: 0, findings: 2, mine: 0 }), title: () => undefined, jobName: () => undefined }) });
	assert.ok(one.includes("</time> cron-15c11c9f</li>") && one.includes("</time> pr-watch</li>"), "a loop by its label, as every page surface names it");
	assert.ok(one.includes("<td>1 run, 2 findings</td>"), "one run, and no zero failures");
});

test("the Background view's times are written by the page's own clock, from the page", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-server-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }), { server: { background: status } });
	try {
		const html = await (await fetch(`${page.url}background?token=${TEST_TOKEN}`)).text();
		const clockSrc = /\/\* clock: \*\/([\s\S]*?)\/\* :clock \*\//.exec(fs.readFileSync(path.join(process.cwd(), "src", "web.mjs"), "utf8"))?.[1];
		assert.ok(clockSrc && html.includes(clockSrc.trim()), "the strip's clock, the same text");
		assert.match(html, /querySelectorAll\("time\[datetime\]"\)/);
	} finally {
		await page.stop();
	}
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
		assert.match(later, /<p>pi-loops 5 · started <time datetime="now">now<\/time><\/p>/);
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
	// A browser paired on 0.22.8 holds its token in pi_web_token, and a cookie goes to every port on
	// 127.0.0.1 for a year. The first 0.24 start replaced that token; the cookie is cleared anyway.
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
		assert.match(await first.text(), /open in a terminal and has nothing saved yet/);
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

test("GET / after the last conversation was an empty one pi never saved opens a new conversation in its project, not the Background view", { timeout: 20_000 }, async () => {
	// A bookmark of the bare address landed on a status table after `pi-loops restart`: the page's last
	// conversation had no file to open, and nothing else was open.
	const dir = tmp("pi-loops-page-server-");
	const root = path.join(dir, "sessions");
	const project = path.join(dir, "proj");
	fs.mkdirSync(project);
	// The project has nothing saved at all: the empty conversation was its first.
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "new1" }), { server: { sessionsRoot: root, background: status, lastPage: () => "empty1" } });
	try {
		fs.mkdirSync(path.join(page.loops, "leases"), { recursive: true });
		fs.writeFileSync(path.join(page.loops, "leases", "empty1.json"), JSON.stringify({ v: 1, sessionId: "empty1", sessionFile: path.join(root, "--proj--", "never-written.jsonl"), cwd: project, epoch: 2, holder: null, updatedAt: "now" }));
		const r = await fetch(`${page.url}?token=${TEST_TOKEN}`);
		assert.equal(r.status, 200);
		const html = await r.text();
		assert.doesNotMatch(html, /<h1>pi-loops in the background<\/h1>/, "not the Background view");
		assert.equal(page.pool.list().length, 1, "one pi, started for a new conversation");
		assert.ok(page.pool.get("new1"), "the new conversation");
		assert.equal(fs.realpathSync(page.pool.get("new1")!.cwd), fs.realpathSync(project), "in the last conversation's project");
		assert.ok(html.includes("new1"), "and the page is that conversation's");
	} finally {
		await page.stop();
	}
});

test("GET / with a last conversation whose project is unknown is still the Background view", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-server-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }), { server: { background: status, lastPage: () => "gone1" } });
	try {
		const html = await (await fetch(`${page.url}?token=${TEST_TOKEN}`)).text();
		assert.match(html, /<h1>pi-loops in the background<\/h1>/);
		assert.deepEqual(page.pool.list(), [], "and no pi was started");
	} finally {
		await page.stop();
	}
});

test("POST /conversations/new starts one pi in a project the page lists, with that project's arguments, and refuses any other cwd without starting one", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-server-");
	const root = path.join(dir, "sessions");
	const project = path.join(dir, "proj");
	fs.mkdirSync(project);
	piSession(root, "--proj--", "2026-11-01_old1.jsonl", { id: "old1", cwd: project }, ["from the list"]);
	const argv = path.join(dir, "argv.jsonl");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "new1", argv }), { server: { sessionsRoot: root } });
	const spawned = () => (fs.existsSync(argv) ? fs.readFileSync(argv, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
	try {
		liveLease(page.loops, "term1", path.join(root, "--proj--", "t.jsonl"), project);
		page.pool.recordArgs("term1", ["-e", "/opt/pi-loops"]);
		const send = (headers: Record<string, string>, b: unknown) => fetch(`${page.url}conversations/new`, { method: "POST", headers, body: JSON.stringify(b) });
		const json = { "content-type": "application/json" };
		const ok = { ...json, "x-pi-web-token": TEST_TOKEN };
		assert.equal((await send(json, { cwd: project })).status, 401, "no token");
		assert.equal((await send({ ...ok, origin: "https://evil.example" }, { cwd: project })).status, 403, "another origin");
		assert.equal((await send({ "content-type": "text/plain", "x-pi-web-token": TEST_TOKEN }, { cwd: project })).status, 415, "not JSON");
		for (const b of [{ cwd: path.join(dir, "elsewhere") }, { cwd: dir }, { cwd: 5 }, {}, { cwd: project, piArgs: ["--evil"] }]) {
			const r = await page.post("conversations/new", b);
			assert.equal(r.status, 400, JSON.stringify(b));
		}
		assert.deepEqual(spawned(), [], "a refused cwd starts no pi");
		assert.equal(page.pool.list().length, 0);
		const r = await page.post("conversations/new", { cwd: project });
		assert.equal(r.status, 200, JSON.stringify(r.body));
		assert.deepEqual(r.body, { url: "/c/new1/" });
		assert.equal(spawned().length, 1, "one pi");
		assert.equal(page.pool.list().length, 1);
		assert.equal(fs.realpathSync(page.pool.get("new1")!.cwd), fs.realpathSync(project), "in that project");
		const args = spawned()[0];
		assert.deepEqual(args.slice(args.indexOf("-e"), args.indexOf("-e") + 2), ["-e", "/opt/pi-loops"], "the project's arguments");
		// The cap: the launch path's own words.
		page.pool.open = async () => {
			throw new Error("6 conversations are open in the page and none of them is idle; close one to open another");
		};
		const full = await page.post("conversations/new", { cwd: project });
		assert.equal(full.status, 503);
		assert.equal(full.body.error, "6 conversations are open in the page and none of them is idle; close one to open another");
	} finally {
		await page.stop();
	}
});

test("a new conversation in a project with no arguments of its own loads pi-loops with the -e another page's pi was given, and nothing else of it", { timeout: 30_000 }, async () => {
	const pkg = path.resolve(import.meta.dirname, "..");
	const cases: Array<[string, string[], string[]]> = [
		["-e pi-loops, with a model", ["-e", pkg, "--model", "x", "--no-session"], ["-e", pkg]],
		["--extension pi-loops", ["--extension", pkg, "-e", "/opt/other-ext"], ["-e", pkg]],
		["-e naming the entry file", ["-e", path.join(pkg, "src", "extension-entry.ts")], ["-e", pkg]],
		["--extension=<the entry file>", [`--extension=${path.join(pkg, "src", "extension-entry.ts")}`], ["-e", pkg]],
		["--extension=<the root>", [`--extension=${pkg}`], ["-e", pkg]],
		["-e naming another file of the package", ["-e", path.join(pkg, "src", "cli.ts")], []],
		["no -e anywhere", ["--model", "x"], []],
		["an -e that is not pi-loops", ["-e", "/opt/other-ext", "--model", "x"], []],
	];
	for (const [what, given, wanted] of cases) {
		const dir = tmp("pi-loops-page-server-");
		const api = path.join(dir, "api");
		const web = path.join(dir, "web");
		fs.mkdirSync(api);
		fs.mkdirSync(web);
		const argv = path.join(dir, "argv.jsonl");
		const page = await startTestPage(dir, fakePi(dir, { sessionId: "new1", argv }));
		try {
			// web is known by a loop alone: no conversation, no lease, no arguments of its own.
			fs.mkdirSync(page.loops, { recursive: true });
			fs.writeFileSync(path.join(page.loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [{ id: "cron-w", name: "w", cwd: web }] }));
			// A live page pi of another project, started as a launch with -e starts one.
			const live = path.join(dir, "live1");
			fs.writeFileSync(live, JSON.stringify({ type: "session", version: 3, id: "live1", cwd: api }) + "\n");
			await page.pool.open({ sessionId: "live1", sessionFile: live, cwd: api, piArgs: given });
			const r = await page.post("conversations/new", { cwd: web });
			assert.equal(r.status, 200, `${what}: ${JSON.stringify(r.body)}`);
			const started = fs.readFileSync(argv, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
			const own = started.slice(started.indexOf("rpc") + 1);
			assert.deepEqual(own, wanted, what);
		} finally {
			await page.stop();
		}
	}
});

test("the Background view draws a conversation's title as text: no escape sequence or bidi override", () => {
	const s = status();
	s.sessions = [{ sessionId: "123456789", title: "evil \u001b[31mred\u001b[0m \u202ereversed", cwd: "/work/\u202eapi", holder: { kind: "nobody" }, plainJobs: 0, rules: 0, mailbox: 0, sinceYouLooked: zero }];
	const page = renderHostPage(s);
	assert.ok(page.includes("123456789 &quot;evil red reversed&quot;"), page.slice(page.indexOf("<tbody>"), page.indexOf("</tbody>")));
	assert.equal(/[\u001b\u202e]/.test(page), false);
});

/* ------------------------------------------------------------------ the inbox as cards */

const hex = (n: number) => n.toString(16).padStart(32, "0");
/** One finding line as `Inbox.append` writes it, with what a test needs to say about it. */
function finding(over: Record<string, unknown>) {
	return { id: `inb-${hex(1)}`, created_at: new Date().toISOString(), status: "new", kind: "news", source: "cron:issue-triage", run_id: "run-1", cwd: "/p", text: "a finding", verified: null, dismiss_reason: null, job_id: "cron-1", ...over };
}
function writeInbox(loops: string, lines: unknown[]) {
	fs.mkdirSync(loops, { recursive: true });
	fs.writeFileSync(path.join(loops, "inbox.jsonl"), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
}
const inboxNow = (loops: string) => fs.readFileSync(path.join(loops, "inbox.jsonl"), "utf8").trim().split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; /* a torn line */ } });
const rowsOf = (loops: string, sessionId: string) => { try { return fs.readFileSync(path.join(loops, "requests", `${sessionId}.jsonl`), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; /* no file: no rows */ } };
const audits = (loops: string) => { try { return fs.readFileSync(path.join(loops, "triggers-audit.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; /* nothing audited yet */ } };

test("the inbox's POST routes take the checks every POST takes, a 4 KB body, and a whole inb- id", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-inbox-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		writeInbox(page.loops, [finding({})]);
		const before = fs.readFileSync(path.join(page.loops, "inbox.jsonl"), "utf8");
		for (const route of ["inbox/claim", "inbox/dismiss"]) {
			const send = (headers: Record<string, string>, b: unknown = { id: `inb-${hex(1)}` }, at = route) => fetch(`${page.url}${at}`, { method: "POST", headers, body: typeof b === "string" ? b : JSON.stringify(b) });
			const json = { "content-type": "application/json" };
			assert.equal((await send(json)).status, 401, `${route}: no token`);
			assert.equal((await send({ ...json, "x-pi-web-token": "b".repeat(32) })).status, 403, `${route}: a wrong token`);
			assert.equal((await send({ ...json, "x-pi-web-token": TEST_TOKEN, "sec-fetch-site": "cross-site" })).status, 403, `${route}: another site`);
			assert.equal((await send({ ...json, "x-pi-web-token": TEST_TOKEN, origin: "https://evil.example" })).status, 403, `${route}: another origin`);
			assert.equal((await send(json, undefined, `${route}?token=${TEST_TOKEN}`)).status, 403, `${route}: a token in the URL of a POST`);
			assert.equal((await send({ "content-type": "text/plain", "x-pi-web-token": TEST_TOKEN })).status, 415, `${route}: a form post`);
			const ok = { ...json, "x-pi-web-token": TEST_TOKEN };
			assert.equal((await send(ok, JSON.stringify({ id: `inb-${hex(1)}`, pad: "x".repeat(5000) }))).status, 413, `${route}: past 4 KB`);
			assert.equal((await send(ok, "{not json")).status, 400, `${route}: not JSON`);
			for (const id of ["1", "inb-0000", `inb-${"AB".repeat(16)}`, "", 7, `inb-${hex(1)}x`]) assert.equal((await send(ok, { id })).status, 400, `${route}: ${JSON.stringify(id)} is not a whole id`);
			const unknown = await send(ok, { id: `inb-${hex(99)}` });
			assert.deepEqual([unknown.status, await unknown.json()], [404, { error: "no such finding" }], `${route}: an id that names nothing`);
		}
		assert.equal(fs.readFileSync(path.join(page.loops, "inbox.jsonl"), "utf8"), before, "nothing refused changed the inbox");
		assert.ok(!fs.existsSync(path.join(page.loops, "requests")), "and nothing was queued");
	} finally {
		await page.stop();
	}
});

test("a claim from the page queues the born-left inbox: row for the terminal that holds the conversation, once", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-inbox-");
	const project = path.join(dir, "proj");
	fs.mkdirSync(project);
	const file = path.join(dir, "held-1");
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "held-1", cwd: project })}\n`);
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	let opens = 0;
	const open = page.pool.open.bind(page.pool);
	page.pool.open = (how) => (opens++, open(how));
	try {
		liveLease(page.loops, "held-1", file, project);
		writeInbox(page.loops, [finding({ kind: "checkpoint", text: "ship it · waits: you · if not: it waits", cwd: project, session_id: "held-1" }), finding({ id: `inb-${hex(2)}`, cwd: project, session_id: "held-1" })]);
		const claimed = await page.post("inbox/claim", { id: `inb-${hex(1)}`, from: "s1", extra: "ignored" });
		assert.equal(claimed.status, 200);
		assert.deepEqual([claimed.body.delivery, claimed.body.conversation, claimed.body.line], ["terminal", "held-1", "Queued for your terminal."]);
		const rows = rowsOf(page.loops, "held-1");
		assert.equal(rows.length, 1);
		assert.deepEqual([rows[0].source, rows[0].collapse_key, rows[0].mode, rows[0].created_by.instance, rows[0].created_by.pid], [`inbox:inb-${hex(1)}`, `inbox:inb-${hex(1)}`, "attended", "page", process.pid]);
		assert.ok(rows[0].created_by.left, "born left: the holder runs it");
		assert.match(rows[0].payload.text, /^A recurring loop \(cron:issue-triage, running in .*proj\) reported this finding — investigate and address it:\nship it · waits: you · if not: it waits\nThis finding is a checkpoint/);
		const stored = inboxNow(page.loops).find((e) => e.id === `inb-${hex(1)}`);
		assert.deepEqual([stored.status, stored.claimed_by], ["claimed", "held-1"], "claimed by the conversation it runs in, as /inbox claim marks it");
		const audit = audits(page.loops).filter((a) => a.state === "claimed");
		assert.equal(audit.length, 1);
		assert.deepEqual([audit[0].type, audit[0].traceId, audit[0].sourceLabel, audit[0].eventLabel, audit[0].details.from], ["request", rows[0].id, `inbox:inb-${hex(1)}`, "held-1", "page"]);
		assert.equal(opens, 0, "the terminal answers it: no pi was started");

		const again = await page.post("inbox/claim", { id: `inb-${hex(1)}` });
		assert.deepEqual([again.status, again.body], [409, { error: "already claimed", status: "claimed" }]);
		assert.equal(rowsOf(page.loops, "held-1").length, 1, "still one row");

		const race = await Promise.all([page.post("inbox/claim", { id: `inb-${hex(2)}` }), page.post("inbox/claim", { id: `inb-${hex(2)}` })]);
		assert.deepEqual(race.map((r) => r.status).sort(), [200, 409], "two pages: one wins");
		assert.equal(rowsOf(page.loops, "held-1").filter((r) => r.source === `inbox:inb-${hex(2)}`).length, 1, "and one row");
	} finally {
		await page.stop();
	}
});

/** Hold `inbox.lock` as another process writing the inbox would: the mkdir lock, released after `ms`. */
function holdInboxLock(loops: string, ms: number): Promise<void> {
	const lock = path.join(loops, "inbox.lock");
	fs.mkdirSync(lock, { recursive: true });
	return new Promise((r) => setTimeout(() => { fs.rmSync(lock, { recursive: true, force: true }); r(); }, ms));
}

test("while another process holds the inbox lock, a claim from the page queues nothing until it can mark the finding", { timeout: 30_000 }, async () => {
	const dir = tmp("pi-loops-page-inbox-");
	const project = path.join(dir, "proj");
	fs.mkdirSync(project);
	const file = path.join(dir, "held-1");
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "held-1", cwd: project })}\n`);
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		liveLease(page.loops, "held-1", file, project);
		writeInbox(page.loops, [finding({ cwd: project, session_id: "held-1" })]);
		const held = holdInboxLock(page.loops, 600);
		const claim = page.post("inbox/claim", { id: `inb-${hex(1)}` });
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(rowsOf(page.loops, "held-1").length, 0, "a holder that ran a row queued now could run it for a claim that then loses");
		await held;
		assert.equal((await claim).status, 200);
		assert.equal(rowsOf(page.loops, "held-1").length, 1);
	} finally {
		await page.stop();
	}
});

test("two page claims racing a held inbox lock: one wins, and its row is there every time", { timeout: 60_000 }, async () => {
	const dir = tmp("pi-loops-page-inbox-");
	const project = path.join(dir, "proj");
	fs.mkdirSync(project);
	const file = path.join(dir, "held-1");
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "held-1", cwd: project })}\n`);
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		liveLease(page.loops, "held-1", file, project);
		const rounds = 8;
		writeInbox(page.loops, Array.from({ length: rounds }, (_, i) => finding({ id: `inb-${hex(10 + i)}`, cwd: project, session_id: "held-1" })));
		for (let i = 0; i < rounds; i++) {
			const id = `inb-${hex(10 + i)}`;
			const held = holdInboxLock(page.loops, 150);
			const answers = await Promise.all([page.post("inbox/claim", { id }), page.post("inbox/claim", { id }), held]);
			assert.deepEqual(answers.slice(0, 2).map((a: any) => a.status).sort(), [200, 409], `round ${i}: one wins`);
			assert.equal(rowsOf(page.loops, "held-1").filter((r) => r.source === `inbox:${id}`).length, 1, `round ${i}: the winner's row is queued once`);
		}
	} finally {
		await page.stop();
	}
});

test("a shell's pi-loops inbox claim racing a page claim under a held lock: one wins, and a row exactly when the page did", { timeout: 60_000 }, async () => {
	const dir = tmp("pi-loops-page-inbox-");
	const project = path.join(dir, "proj");
	fs.mkdirSync(project);
	const file = path.join(dir, "held-1");
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "held-1", cwd: project })}\n`);
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		liveLease(page.loops, "held-1", file, project);
		writeInbox(page.loops, [finding({ cwd: project, session_id: "held-1" })]);
		const held = holdInboxLock(page.loops, 300);
		const cli = new Promise<number>((resolve) => {
			const child = spawn(process.execPath, [path.resolve("src/cli-entry.mjs"), "inbox", "claim", `inb-${hex(1)}`, "--json"], { env: { ...process.env, PI_LOOPS_DIR: page.loops, PI_CODING_AGENT_DIR: path.join(dir, "agent") }, stdio: "ignore" });
			child.on("exit", (code) => resolve(code ?? -1));
		});
		const [web, shell] = await Promise.all([page.post("inbox/claim", { id: `inb-${hex(1)}` }), cli, held]);
		assert.equal([web.status === 200, shell === 0].filter(Boolean).length, 1, `one wins: page ${web.status}, shell exit ${shell}`);
		assert.equal(rowsOf(page.loops, "held-1").length, web.status === 200 ? 1 : 0, "a row only for the page's win");
		assert.equal(inboxNow(page.loops)[0].claimed_by, web.status === 200 ? "held-1" : "cli");
	} finally {
		await page.stop();
	}
});

test("a project-owned finding (a starter's loop installed before its conversation was saved) says it runs where it is claimed from, and is claimed into the asking conversation", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-inbox-");
	const project = path.join(dir, "proj");
	fs.mkdirSync(project);
	const file = path.join(dir, "here-1");
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "here-1", cwd: project })}\n`);
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		liveLease(page.loops, "here-1", file, project);
		fs.writeFileSync(path.join(page.loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [{ id: "cron-1", name: "changelog-draft", recipe: "changelog-draft", cwd: project }] }));
		writeInbox(page.loops, [finding({ cwd: project, job_id: "cron-1", source: "cron:changelog-draft" })]);
		const listed = await page.get(`inbox?cwd=${encodeURIComponent(project)}&session=here-1`);
		assert.deepEqual(listed.body.cards[0].owner, { holder: "project" }, "not 'gone': it never had a conversation");
		assert.equal(listed.body.cards[0].fromThisConversation, false);
		const refused = await page.post("inbox/claim", { id: `inb-${hex(1)}` });
		assert.equal(refused.status, 409);
		assert.match(refused.body.error, /^this loop belongs to its project; open a conversation in .*proj to claim it there$/);
		const here = await page.post("inbox/claim", { id: `inb-${hex(1)}`, from: "here-1" });
		assert.deepEqual([here.status, here.body.conversation], [200, "here-1"], "claimed into the conversation it was claimed from");
		assert.equal(rowsOf(page.loops, "here-1").length, 1);
		const after = await page.get(`inbox?cwd=${encodeURIComponent(project)}&session=here-1`);
		assert.deepEqual(after.body.handled.map((c: any) => [c.id, c.owner.holder, c.line]), [[`inb-${hex(1)}`, "terminal", "Queued for your terminal."]], "handled, and waiting where it was claimed into");
	} finally {
		await page.stop();
	}
});

test("a project-owned card being claimed says where it waits: the conversation it was claimed into, not the loop's", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-inbox-");
	const project = path.join(dir, "proj");
	fs.mkdirSync(project);
	const file = path.join(dir, "quiet-1");
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "quiet-1", cwd: project })}\n`);
	// No sweep in the test's time: the claim stays queued with the finding still new.
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }), { server: { claimSweepMs: 600_000 } });
	try {
		liveLease(page.loops, "quiet-1", file, project, { mode: "print" });
		fs.writeFileSync(path.join(page.loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [{ id: "cron-1", name: "changelog-draft", recipe: "changelog-draft", cwd: project, owner: "project" }] }));
		writeInbox(page.loops, [finding({ cwd: project, job_id: "cron-1", source: "cron:changelog-draft" })]);
		queuedPageClaim(page.loops, "quiet-1", `inb-${hex(1)}`, project);
		const listed = await page.get(`inbox?cwd=${encodeURIComponent(project)}&session=quiet-1`);
		const card = listed.body.cards[0];
		assert.deepEqual([card.claiming, card.owner], [true, { holder: "project" }], "the card is still the project's");
		assert.equal(card.line, "Queued; the terminal that has this conversation is not taking messages (/resume there).", "the line is the claimed-into conversation's, not 'its conversation is gone'");
	} finally {
		await page.stop();
	}
});

test("a claim whose conversation is gone runs in the page's own when it is in the project, and is refused otherwise", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-inbox-");
	const project = path.join(dir, "proj");
	fs.mkdirSync(project);
	const file = path.join(dir, "here-1");
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "here-1", cwd: project })}\n`);
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		liveLease(page.loops, "here-1", file, project);
		writeInbox(page.loops, [finding({ cwd: project, session_id: "gone-1" }), finding({ id: `inb-${hex(2)}`, cwd: path.join(dir, "elsewhere"), session_id: "gone-1" })]);
		const refused = await page.post("inbox/claim", { id: `inb-${hex(1)}` });
		assert.equal(refused.status, 409);
		assert.match(refused.body.error, /^the conversation that made this loop is gone; open a conversation in .*proj to claim it there$/);
		assert.equal(inboxNow(page.loops)[0].status, "new", "the finding stays new");
		const here = await page.post("inbox/claim", { id: `inb-${hex(1)}`, from: "here-1" });
		assert.deepEqual([here.status, here.body.conversation], [200, "here-1"]);
		assert.equal(rowsOf(page.loops, "here-1").length, 1);
		const other = await page.post("inbox/claim", { id: `inb-${hex(2)}`, from: "here-1" });
		assert.equal(other.status, 409, "a finding of another project does not run here");
	} finally {
		await page.stop();
	}
});

test("a claim for a conversation nobody holds starts its pi and rings it with the row's fingerprint", { timeout: 30_000 }, async () => {
	const dir = tmp("pi-loops-page-inbox-");
	const project = path.join(dir, "proj");
	fs.mkdirSync(project);
	const file = path.join(dir, "idle-1");
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "idle-1", cwd: project })}\n`);
	const log = path.join(dir, "child.log");
	const page = await startTestPage(dir, fakePi(dir, { commands: ["pi-loops"], log }));
	try {
		liveLease(page.loops, "idle-1", file, project, { pid: 2 ** 22 + 7 });
		writeInbox(page.loops, [finding({ cwd: project, session_id: "idle-1" })]);
		const claimed = await page.post("inbox/claim", { id: `inb-${hex(1)}` });
		assert.deepEqual([claimed.status, claimed.body.delivery], [200, "started"]);
		assert.ok(page.pool.has("idle-1"), "its pi was started");
		const row = rowsOf(page.loops, "idle-1")[0];
		assert.ok(await until(() => fs.existsSync(log) && fs.readFileSync(log, "utf8").includes(`/pi-loops ring ${row.id} `)), "and rung for the row");
		const rang = fs.readFileSync(log, "utf8").split("\n").filter((l) => l.includes("/pi-loops ring"));
		assert.equal(rang.length, 1, "once");
		assert.match(rang[0], new RegExp(`/pi-loops ring ${row.id} [0-9a-f]{32}"`));
	} finally {
		await page.stop();
	}
});

test("a claim for a conversation whose pi has no pi-loops sends that pi nothing, and is not started again for it", { timeout: 30_000 }, async () => {
	const dir = tmp("pi-loops-page-inbox-");
	const project = path.join(dir, "proj");
	fs.mkdirSync(project);
	const file = path.join(dir, "bare-1");
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "bare-1", cwd: project })}\n`);
	const log = path.join(dir, "child.log");
	const page = await startTestPage(dir, fakePi(dir, { commands: [], log }));
	let opens = 0;
	const open = page.pool.open.bind(page.pool);
	page.pool.open = (how) => (opens++, open(how));
	try {
		liveLease(page.loops, "bare-1", file, project, { pid: 2 ** 22 + 7 });
		writeInbox(page.loops, [finding({ cwd: project, session_id: "bare-1" }), finding({ id: `inb-${hex(2)}`, cwd: project })]);
		const claimed = await page.post("inbox/claim", { id: `inb-${hex(1)}` });
		assert.deepEqual([claimed.status, claimed.body.delivery, claimed.body.line], [200, "no-pi-loops", "Queued; the pi of that conversation has no pi-loops, so nothing runs it here. Open it in a terminal with pi-loops."]);
		const prompts = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "").split("\n").filter((l) => l.includes('"type":"prompt"'));
		assert.deepEqual(prompts(), [], "no ring: without pi-loops it would reach the model as the person's message");
		assert.equal(opens, 1);
		await page.pool.stopAll();
		// A dismiss runs a sweep, as the ten-second timer does.
		assert.equal((await page.post("inbox/dismiss", { id: `inb-${hex(2)}` })).status, 200);
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(opens, 1, "the sweep does not start that pi again for the claim");
		assert.deepEqual(prompts(), []);
		assert.equal(rowsOf(page.loops, "bare-1").length, 1, "the row waits for a pi that has pi-loops");
	} finally {
		await page.stop();
	}
});

test("a dismiss from the page stores the reason for the loop's next run and says so; past 500 characters it is refused", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-inbox-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		fs.mkdirSync(page.loops, { recursive: true });
		fs.writeFileSync(path.join(page.loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [{ id: "cron-1", name: "issue-triage" }] }));
		writeInbox(page.loops, [finding({}), finding({ id: `inb-${hex(2)}`, job_id: "cron-gone" }), finding({ id: `inb-${hex(3)}` }), finding({ id: `inb-${hex(4)}`, status: "claimed" })]);
		const long = await page.post("inbox/dismiss", { id: `inb-${hex(1)}`, reason: "x".repeat(501) });
		assert.deepEqual([long.status, long.body], [400, { error: "reason is longer than 500 characters" }]);
		assert.equal((await page.post("inbox/dismiss", { id: `inb-${hex(1)}`, reason: 5 })).status, 400);
		const told = await page.post("inbox/dismiss", { id: `inb-${hex(1)}`, reason: "Not a bug" });
		assert.deepEqual([told.status, told.body.told, told.body.line], [200, { told: "loop", loop: "issue-triage" }, "Dismissed. Your reason goes to issue-triage's next run."]);
		const stored = inboxNow(page.loops)[0];
		assert.deepEqual([stored.status, stored.dismiss_reason, typeof stored.dismissed_at], ["dismissed", "Not a bug", "string"]);
		const gone = await page.post("inbox/dismiss", { id: `inb-${hex(2)}`, reason: "Too noisy" });
		assert.equal(gone.body.line, "Dismissed. The loop that reported it is gone, so nobody is told.");
		const bare = await page.post("inbox/dismiss", { id: `inb-${hex(3)}` });
		assert.deepEqual([bare.body.told, bare.body.line], [{ told: "silent" }, "Dismissed."]);
		const claimed = await page.post("inbox/dismiss", { id: `inb-${hex(4)}`, reason: "x" });
		assert.deepEqual([claimed.status, claimed.body], [409, { error: "already claimed", status: "claimed" }]);
		const audit = audits(page.loops).filter((a) => a.state === "dismissed");
		assert.deepEqual(audit.map((a) => [a.type, a.traceId, a.details.reason, a.details.chip]), [["request", `inb-${hex(1)}`, "Not a bug", true], ["request", `inb-${hex(2)}`, "Too noisy", true], ["request", `inb-${hex(3)}`, null, false]]);
	} finally {
		await page.stop();
	}
});

test("GET /inbox: one project's cards, decisions first, fifty at most, a torn line left out, and starts no pi", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-inbox-");
	const project = path.join(dir, "proj");
	fs.mkdirSync(project);
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	let opens = 0;
	const open = page.pool.open.bind(page.pool);
	page.pool.open = (how) => (opens++, open(how));
	try {
		const news = Array.from({ length: 55 }, (_, i) => finding({ id: `inb-${hex(100 + i)}`, cwd: project, text: `news ${i}. <b>bold</b>` }));
		writeInbox(page.loops, [...news, "{torn", "{}", finding({ id: `inb-${hex(1)}`, kind: "checkpoint", text: "ship it · waits: you", cwd: project, session_id: "s-gone" }), finding({ id: `inb-${hex(2)}`, cwd: path.join(dir, "other") })]);
		fs.writeFileSync(path.join(page.loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [{ id: "cron-1", name: "issue-triage", cwd: project }] }));
		assert.equal((await fetch(`${page.url}inbox`)).status, 401, "behind the token");
		const unknown = await page.get(`inbox?cwd=${encodeURIComponent(path.join(dir, "other"))}`);
		assert.deepEqual([unknown.status, unknown.body], [404, { error: "no such project" }], "a cwd is a key into the projects found, as GET /conversations takes it");
		const got = await page.get(`inbox?cwd=${encodeURIComponent(project)}&session=s1`);
		assert.equal(got.status, 200);
		assert.equal(got.body.cards.length, 50);
		assert.equal(got.body.more, 6);
		assert.equal(got.body.elsewhere, 1);
		const first = got.body.cards[0];
		assert.deepEqual([first.id, first.kind, first.headline, first.waits, first.ifNot, first.owner], [`inb-${hex(1)}`, "decision", "ship it", "you", undefined, { holder: "gone" }]);
		assert.deepEqual([got.body.cards[1].headline, got.body.cards[1].body], ["news 0.", "<b>bold</b>"], "text stays text; the page draws it as such");
		assert.ok(got.body.cards.every((c: any) => /^inb-[0-9a-f]{32}$/.test(c.id)), "no card without an id");
		assert.deepEqual(got.body.chips, ["Not a bug", "Already fixed", "Duplicate", "Too noisy", "Not now"]);
		assert.equal(opens, 0, "listing started no pi");
	} finally {
		await page.stop();
	}
});

test("GET /inbox carries the project's away summary, counted as the terminal counts it", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-away-");
	const project = path.join(dir, "proj");
	fs.mkdirSync(project);
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		fs.mkdirSync(page.loops, { recursive: true });
		const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
		const looked = ago(60);
		fs.writeFileSync(path.join(page.loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [{ id: "cron-1", name: "issue-triage", cwd: project }] }));
		fs.writeFileSync(path.join(page.loops, "seen.json"), JSON.stringify({ v: 2, projects: { [fs.realpathSync(project)]: looked }, sessions: {} }));
		const run = (over: Record<string, unknown>) => JSON.stringify({ runId: "r", jobId: "cron-1", stateful: true, cwd: project, pid: 1, startedAt: ago(30), finishedAt: ago(20), ok: true, findings: 0, droppedFindings: 0, stateUpdated: false, ...over });
		fs.writeFileSync(path.join(page.loops, "runs.jsonl"), [run({ runId: "a", ok: false }), run({ runId: "b", usage: { input: 1, output: 1, turns: 1, cost: 0.2 } }), run({ runId: "old", finishedAt: ago(90) })].join("\n") + "\n");
		writeInbox(page.loops, [finding({ cwd: project, session_id: "s1", created_at: ago(10) }), finding({ id: `inb-${hex(2)}`, cwd: project, session_id: "other", kind: "checkpoint", text: "ship it · waits: you", created_at: ago(10) })]);
		const got = await page.get(`inbox?cwd=${encodeURIComponent(project)}&session=s1`);
		assert.equal(got.status, 200);
		const { asOf, since, ...rest } = got.body.away;
		assert.deepEqual(rest, { cwd: project, runs: 2, failedRuns: 1, findings: 2, decisions: 1, fromThisConversation: 1, costUsd: 0.2 });
		assert.equal(Date.parse(since), Date.parse(looked));
		assert.ok(Math.abs(Date.parse(asOf) - Date.now()) < 5000, "asOf is the server's now");
		const machine = await page.get("inbox");
		assert.equal(machine.body.away, null, "no project, no away summary");
	} finally {
		await page.stop();
	}
});

test("a null line or an unreadable run log costs GET /inbox the away card, not the cards; a record a little ahead does not stop Mark all seen", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-away-");
	const project = path.join(dir, "proj");
	fs.mkdirSync(project);
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		fs.mkdirSync(page.loops, { recursive: true });
		fs.writeFileSync(path.join(page.loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [{ id: "cron-1", name: "issue-triage", cwd: project }] }));
		writeInbox(page.loops, ["null", finding({ cwd: project })]);
		const ahead = new Date(Date.now() + 3000).toISOString();
		const run = (over: Record<string, unknown>) => JSON.stringify({ runId: "r", jobId: "cron-1", stateful: true, cwd: project, pid: 1, startedAt: new Date(Date.now() - 60_000).toISOString(), finishedAt: new Date(Date.now() - 30_000).toISOString(), ok: true, findings: 0, droppedFindings: 0, stateUpdated: false, ...over });
		fs.writeFileSync(path.join(page.loops, "runs.jsonl"), ["null", "5", run({}), run({ runId: "ahead", finishedAt: ahead })].join("\n") + "\n");
		const got = await page.get(`inbox?cwd=${encodeURIComponent(project)}&session=s1`);
		assert.equal(got.status, 200);
		assert.deepEqual([got.body.away.runs, got.body.away.findings, got.body.cards.length], [1, 1, 1], "a null line is no record");
		assert.ok(Date.parse(got.body.away.asOf) < Date.parse(ahead), "asOf is never ahead of the clock");
		const marked = await page.post("inbox/seen", { cwd: project, at: got.body.away.asOf });
		assert.equal(marked.status, 200, "so Mark all seen is taken");
		fs.rmSync(path.join(page.loops, "runs.jsonl"));
		fs.mkdirSync(path.join(page.loops, "runs.jsonl"));
		const broken = await page.get(`inbox?cwd=${encodeURIComponent(project)}&session=s1`);
		assert.equal(broken.status, 200);
		assert.equal(broken.body.away, null, "a run log that cannot be read: no away card");
		assert.equal(broken.body.cards.length, 1, "and the cards still come");
		assert.ok(page.logs.some((l) => l.startsWith("pi-loops web: away summary:")), "said in the log");
	} finally {
		await page.stop();
	}
});

test("GET /inbox offers three starters, in the design's order, only for the open conversation's project and only while it has no loop and no rule", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-starters-");
	const project = path.join(dir, "proj");
	const other = path.join(dir, "other");
	fs.mkdirSync(project);
	fs.mkdirSync(other);
	const root = path.join(dir, "sessions");
	piSession(root, "--proj--", "s1.jsonl", { id: "s1", cwd: project }, ["hello"]);
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }), { server: { sessionsRoot: root } });
	try {
		fs.mkdirSync(page.loops, { recursive: true });
		fs.writeFileSync(path.join(page.loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [{ id: "cron-9", cwd: other }] }));
		const got = await page.get(`inbox?session=s1`);
		assert.equal(got.status, 200);
		assert.deepEqual(got.body.starters.map((s: any) => s.name), ["daily-digest", "pr-watch", "changelog-draft"]);
		const digest = got.body.starters[0];
		assert.deepEqual([digest.readsOnly, digest.needsTracker, digest.budgetHintUsd, typeof digest.summary, typeof digest.line], [true, true, 1, "string", "string"]);
		assert.equal(got.body.starters[2].needsTracker, false);
		assert.equal((await page.get(`inbox?cwd=${encodeURIComponent(project)}&session=s1`)).body.starters?.length, 3, "asked by its cwd");
		assert.equal((await page.get(`inbox?cwd=${encodeURIComponent(other)}&session=s1`)).body.starters, undefined, "another project: Add would install into this conversation's");
		assert.equal((await page.get(`inbox?cwd=${encodeURIComponent(other)}`)).body.starters, undefined, "a project with loops and no conversation here: no starters");
		fs.writeFileSync(path.join(page.loops, "triggers.json"), JSON.stringify({ version: 1, rules: [{ id: "dyn-1", condition: "x", cwd: project }] }));
		assert.equal((await page.get(`inbox?session=s1`)).body.starters, undefined, "a rule in the project");
		fs.writeFileSync(path.join(page.loops, "triggers.json"), JSON.stringify({ version: 1, rules: [] }));
		fs.writeFileSync(path.join(page.loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [{ id: "cron-1", cwd: project, enabled: false }] }));
		assert.equal((await page.get(`inbox?session=s1`)).body.starters, undefined, "a loop in the project, even a disabled one");
	} finally {
		await page.stop();
	}
});

test("POST /inbox/seen takes the checks every POST takes, a 512-byte body, a known project and a time not in the future, and writes only seen.json", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-seen-");
	const project = path.join(dir, "proj");
	fs.mkdirSync(project);
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		fs.mkdirSync(page.loops, { recursive: true });
		fs.writeFileSync(path.join(page.loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [{ id: "cron-1", name: "issue-triage", cwd: project }] }));
		const before = fs.readdirSync(page.loops).sort();
		const at = new Date(Date.now() - 1000).toISOString();
		const send = (headers: Record<string, string>, b: unknown = { cwd: project, at }) => fetch(`${page.url}inbox/seen`, { method: "POST", headers, body: typeof b === "string" ? b : JSON.stringify(b) });
		const json = { "content-type": "application/json" };
		const ok = { ...json, "x-pi-web-token": TEST_TOKEN };
		assert.equal((await send(json)).status, 401, "no token");
		assert.equal((await send({ ...json, "x-pi-web-token": "b".repeat(32) })).status, 403, "a wrong token");
		assert.equal((await send({ ...ok, origin: "https://evil.example" })).status, 403, "another origin");
		assert.equal((await send({ ...ok, "sec-fetch-site": "cross-site" })).status, 403, "another site");
		assert.equal((await send({ "content-type": "text/plain", "x-pi-web-token": TEST_TOKEN })).status, 415, "not JSON");
		assert.equal((await send(ok, { cwd: project, at, pad: "x".repeat(600) })).status, 413, "past 512 bytes");
		assert.equal((await send(ok, "[1]")).status, 400, "not an object");
		assert.equal((await send(ok, { cwd: project, at, more: 1 })).status, 400, "exactly cwd and at");
		assert.equal((await send(ok, { cwd: project, at: "yesterday" })).status, 400, "an ISO time");
		assert.equal((await send(ok, { cwd: project, at: new Date(Date.now() + 60_000).toISOString() })).status, 400, "not in the future");
		assert.equal((await send(ok, { cwd: path.join(dir, "elsewhere"), at })).status, 404, "a project the page lists");
		assert.equal((await send(ok, { cwd: 5, at })).status, 400);
		assert.deepEqual(fs.readdirSync(page.loops).sort(), before, "nothing written by a refused mark");
		// Two pages at once: the later look wins, whichever lands last.
		const earlier = new Date(Date.now() - 5000).toISOString();
		const [a, b] = await Promise.all([page.post("inbox/seen", { cwd: project, at }), page.post("inbox/seen", { cwd: project, at: earlier })]);
		assert.deepEqual([a.status, b.status], [200, 200]);
		assert.equal((await page.post("inbox/seen", { cwd: project, at: earlier })).body.since, at, "an older look does not move the cursor back");
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(page.loops, "seen.json"), "utf8")).projects, { [fs.realpathSync(project)]: at });
		assert.deepEqual(fs.readdirSync(page.loops).filter((f) => !before.includes(f)).sort(), ["seen.json"], "seen.json is all it writes");
		const got = await page.get(`inbox?cwd=${encodeURIComponent(project)}`);
		assert.equal(Date.parse(got.body.away.since), Date.parse(at));
	} finally {
		await page.stop();
	}
});

test("See the run reads a run's transcript under sessions/ and nothing else", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-inbox-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		const runs = path.join(page.loops, "sessions", "cron-1");
		fs.mkdirSync(runs, { recursive: true });
		const transcript = path.join(runs, "run-1.jsonl");
		fs.writeFileSync(transcript, [{ type: "session", version: 3, id: "r", cwd: "/p" }, { type: "message", message: { role: "assistant", content: [{ type: "text", text: "found the stale TODO" }] } }].map((l) => JSON.stringify(l)).join("\n") + "\n");
		const outside = path.join(dir, "secret.jsonl");
		fs.writeFileSync(outside, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "outside" }] } })}\n`);
		fs.symlinkSync(outside, path.join(runs, "link.jsonl"));
		writeInbox(page.loops, [finding({ transcript }), finding({ id: `inb-${hex(2)}`, transcript: outside }), finding({ id: `inb-${hex(3)}`, transcript: path.join(runs, "link.jsonl") }), finding({ id: `inb-${hex(4)}`, source: "trigger:deploy" }), finding({ id: `inb-${hex(5)}`, transcript: path.join(runs, "pruned.jsonl") })]);
		const read = await page.get(`inbox/run?id=inb-${hex(1)}`);
		assert.equal(read.status, 200);
		assert.ok(read.body.lines.some((l: any) => JSON.stringify(l).includes("found the stale TODO")), JSON.stringify(read.body.lines));
		for (const n of [2, 3]) assert.deepEqual(await page.get(`inbox/run?id=inb-${hex(n)}`), { status: 404, body: { error: "the run's transcript is gone (pruned, or its loop was removed)" } }, `a path outside sessions/ (#${n})`);
		assert.deepEqual(await page.get(`inbox/run?id=inb-${hex(4)}`), { status: 404, body: { error: "a rule check keeps no run transcript" } });
		assert.equal((await page.get(`inbox/run?id=inb-${hex(5)}`)).status, 404);
		assert.equal((await page.get("inbox/run?id=1")).status, 400);
		// The file goes between resolving its path and reading it: the same answer as a file that was never there.
		const real = fsDefault.statSync;
		const vanish = mock.method(fsDefault, "statSync", (p: fs.PathLike, ...rest: any[]) => {
			if (String(p) === fs.realpathSync(transcript)) throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${p}'`), { code: "ENOENT" });
			return (real as any)(p, ...rest);
		});
		syncBuiltinESMExports();
		try {
			assert.deepEqual(await page.get(`inbox/run?id=inb-${hex(1)}`), { status: 404, body: { error: "the run's transcript is gone (pruned, or its loop was removed)" } });
		} finally {
			vanish.mock.restore();
			syncBuiltinESMExports();
		}
	} finally {
		await page.stop();
	}
});

test("the panel counts the findings the inbox lists: one with no text is not counted", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-inbox-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		writeInbox(page.loops, [finding({ kind: "checkpoint", text: "ship it · waits: you" }), finding({ id: `inb-${hex(2)}`, text: "" }), "{torn"]);
		await page.pool.open({ sessionId: "s1", cwd: dir, piArgs: [] });
		const state = (await page.get("c/s1/state")).body;
		assert.deepEqual([state.automation.inboxNew, state.automation.inboxDecisions], [1, 1]);
	} finally {
		await page.stop();
	}
});

/** A page claim row as the page writes it, for a test that starts with one queued. */
function queuedPageClaim(loops: string, sessionId: string, findingId: string, cwd: string) {
	const row = pageClaimRow("investigate", findingId, { sessionId, cwd, createdBy: { pid: process.pid, instance: PAGE_INSTANCE, version: "0" } });
	new RequestStore(loops).append(row);
	return row;
}

test("pi-loops starting finishes a claim it was cut short in, and the ten-second sweep does what it finds later", { timeout: 30_000 }, async () => {
	const dir = tmp("pi-loops-page-inbox-");
	const project = path.join(dir, "proj");
	fs.mkdirSync(project);
	const file = path.join(dir, "held-1");
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "held-1", cwd: project })}\n`);
	const loops = path.join(dir, "loops");
	liveLease(loops, "held-1", file, project);
	// Cut short between the row and the status: the row is queued, the finding still new.
	writeInbox(loops, [finding({ cwd: project, session_id: "held-1" }), finding({ id: `inb-${hex(2)}`, cwd: project, session_id: "held-1" }), finding({ id: `inb-${hex(3)}`, cwd: project, status: "claimed", claimed_by: "cli" })]);
	queuedPageClaim(loops, "held-1", `inb-${hex(1)}`, project);
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }), { server: { claimSweepMs: 200 } });
	try {
		assert.ok(await until(() => inboxNow(page.loops)[0].status === "claimed"), "the sweep at start marks it claimed");
		assert.equal(inboxNow(page.loops)[0].claimed_by, "held-1");
		assert.equal(rowsOf(page.loops, "held-1").length, 1, "and leaves the row to the terminal that holds the conversation");
		// Later: another row cut short, and one for a finding a shell claimed meanwhile.
		queuedPageClaim(page.loops, "held-1", `inb-${hex(2)}`, project);
		queuedPageClaim(page.loops, "held-1", `inb-${hex(3)}`, project);
		assert.ok(await until(() => inboxNow(page.loops)[1].status === "claimed", 3000), "the timer's sweep finishes the next one");
		assert.ok(await until(() => !rowsOf(page.loops, "held-1").some((r) => r.source === `inbox:inb-${hex(3)}`), 3000), "and takes back the row of a finding claimed elsewhere: its turn would run twice");
		assert.equal(inboxNow(page.loops)[2].claimed_by, "cli", "the shell's claim stands");
	} finally {
		await page.stop();
	}
});

test("a claim from the page says where it waits: a terminal not taking messages, pi-loops' scheduled turn, and lists it as handled", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-inbox-");
	const project = path.join(dir, "proj");
	fs.mkdirSync(project);
	const files = ["quiet-1", "busy-1"].map((id) => {
		const file = path.join(dir, id);
		fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, cwd: project })}\n`);
		return file;
	});
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		liveLease(page.loops, "quiet-1", files[0], project, { mode: "print" });
		liveLease(page.loops, "busy-1", files[1], project, { kind: "host", mode: undefined, busy: { runId: "run-x", jobId: "cron-1", since: new Date().toISOString() } });
		fs.writeFileSync(path.join(page.loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [{ id: "cron-1", name: "issue-triage", cwd: project }] }));
		writeInbox(page.loops, [finding({ cwd: project, session_id: "quiet-1" }), finding({ id: `inb-${hex(2)}`, cwd: project, session_id: "busy-1" })]);
		const quiet = await page.post("inbox/claim", { id: `inb-${hex(1)}` });
		assert.deepEqual([quiet.body.delivery, quiet.body.line], ["terminal-quiet", "Queued; the terminal that has this conversation is not taking messages (/resume there)."]);
		const busy = await page.post("inbox/claim", { id: `inb-${hex(2)}` });
		assert.deepEqual([busy.body.delivery, busy.body.line], ["background", "Queued; runs after pi-loops finishes its scheduled run there."]);
		assert.deepEqual(page.pool.list(), [], "neither started a pi");
		const listed = (await page.get(`inbox?cwd=${encodeURIComponent(project)}`)).body;
		assert.deepEqual(listed.cards, []);
		assert.deepEqual(listed.handled.map((c: any) => [c.id, c.status, c.line]), [[`inb-${hex(1)}`, "claimed", "Queued; the terminal that has this conversation is not taking messages (/resume there)."], [`inb-${hex(2)}`, "claimed", "Queued; runs after pi-loops finishes its scheduled run there."]], "claimed, still queued: handled, with where it waits");
	} finally {
		await page.stop();
	}
});

test("a claim answers at once while a sweep waits on another conversation's pi", { timeout: 40_000 }, async () => {
	const dir = tmp("pi-loops-page-inbox-");
	const project = path.join(dir, "proj");
	fs.mkdirSync(project);
	const hung = path.join(dir, "hung-pi");
	fs.writeFileSync(hung, "#!/usr/bin/env node\nprocess.stdin.resume();\nsetInterval(() => {}, 1e9);\n", { mode: 0o755 });
	const loops = path.join(dir, "loops");
	const files = ["slow-1", "held-1"].map((id) => {
		const file = path.join(dir, id);
		fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, cwd: project })}\n`);
		return file;
	});
	liveLease(loops, "slow-1", files[0], project, { pid: 2 ** 22 + 7 });
	liveLease(loops, "held-1", files[1], project);
	writeInbox(loops, [finding({ cwd: project, session_id: "slow-1", status: "claimed", claimed_by: "slow-1" }), finding({ id: `inb-${hex(2)}`, cwd: project, session_id: "held-1" })]);
	queuedPageClaim(loops, "slow-1", `inb-${hex(1)}`, project);
	const page = await startTestPage(dir, hung, { server: { claimSweepMs: 100 } });
	try {
		assert.ok(await until(() => page.pool.has("slow-1")), "the sweep at start is waiting on a pi that does not answer");
		const started = Date.now();
		const claimed = await page.post("inbox/claim", { id: `inb-${hex(2)}` });
		assert.equal(claimed.status, 200);
		assert.ok(Date.now() - started < 3000, `answered in ${Date.now() - started} ms, not after the other conversation's pi`);
		assert.equal(claimed.body.delivery, "terminal");
	} finally {
		await page.stop();
	}
});

test("a claim into a conversation open in the page names it", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-inbox-");
	const project = path.join(dir, "proj");
	fs.mkdirSync(project);
	const file = path.join(dir, "open-1");
	fs.writeFileSync(file, [{ type: "session", version: 3, id: "open-1", cwd: project }, { type: "message", message: { role: "user", content: [{ type: "text", text: "release notes" }] } }].map((l) => JSON.stringify(l)).join("\n") + "\n");
	const page = await startTestPage(dir, fakePi(dir, { commands: ["pi-loops"] }));
	try {
		liveLease(page.loops, "open-1", file, project, { pid: 2 ** 22 + 7 });
		await page.pool.open({ sessionId: "open-1", sessionFile: file, cwd: project, piArgs: [] });
		writeInbox(page.loops, [finding({ cwd: project, session_id: "open-1" })]);
		const listed = (await page.get(`inbox?session=open-1`)).body;
		assert.deepEqual(listed.cards[0].owner, { holder: "page", title: "release notes" });
		const claimed = await page.post("inbox/claim", { id: `inb-${hex(1)}` });
		assert.equal(claimed.body.line, 'Running in "release notes".');
	} finally {
		await page.stop();
	}
});

test("a claim whose conversation's queue is locked gives up after five seconds and leaves the finding new", { timeout: 40_000 }, async () => {
	const dir = tmp("pi-loops-page-inbox-");
	const project = path.join(dir, "proj");
	fs.mkdirSync(project);
	const file = path.join(dir, "held-1");
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "held-1", cwd: project })}\n`);
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		liveLease(page.loops, "held-1", file, project);
		writeInbox(page.loops, [finding({ cwd: project, session_id: "held-1" })]);
		// A queue lock nobody releases: held past the inbox lock's own ten-second stale point, another
		// process would break the inbox lock and its write would be lost under this one's rewrite.
		fs.mkdirSync(path.join(page.loops, "requests", "held-1.lock"), { recursive: true });
		const started = Date.now();
		const claimed = await page.post("inbox/claim", { id: `inb-${hex(1)}` });
		const took = Date.now() - started;
		assert.equal(claimed.status, 500);
		assert.ok(took >= 4_500 && took < 9_000, `gave up at the queue lock's timeout, well inside the inbox lock's stale point: ${took} ms`);
		assert.equal(inboxNow(page.loops)[0].status, "new", "the finding is as it was");
		fs.rmSync(path.join(page.loops, "requests", "held-1.lock"), { recursive: true, force: true });
	} finally {
		await page.stop();
	}
});

test("a dismiss reason from the page is stored without control characters", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-inbox-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		writeInbox(page.loops, [finding({})]);
		assert.equal((await page.post("inbox/dismiss", { id: `inb-${hex(1)}`, reason: "not \u001b[2J\u001b[31ma bug\u001b[0m\u0007" })).status, 200);
		assert.equal(inboxNow(page.loops)[0].dismiss_reason, "not a bug");
	} finally {
		await page.stop();
	}
});

test("See the run is offered only for a transcript the server would read", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-inbox-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		const runs = path.join(page.loops, "sessions", "cron-1");
		fs.mkdirSync(runs, { recursive: true });
		const inside = path.join(runs, "run-1.jsonl");
		fs.writeFileSync(inside, `${JSON.stringify({ type: "session", version: 3, id: "r", cwd: "/p" })}\n`);
		const outside = path.join(dir, "secret.jsonl");
		fs.writeFileSync(outside, "{}\n");
		fs.symlinkSync(outside, path.join(runs, "link.jsonl"));
		writeInbox(page.loops, [finding({ transcript: inside }), finding({ id: `inb-${hex(2)}`, transcript: outside }), finding({ id: `inb-${hex(3)}`, transcript: path.join(runs, "link.jsonl") }), finding({ id: `inb-${hex(4)}`, transcript: path.join(runs, "..", "..", "inbox.jsonl") })]);
		const cards = (await page.get("inbox")).body.cards;
		assert.deepEqual(cards.map((c: any) => [c.id, c.hasTranscript]), [[`inb-${hex(1)}`, true], [`inb-${hex(2)}`, false], [`inb-${hex(3)}`, false], [`inb-${hex(4)}`, false]]);
	} finally {
		await page.stop();
	}
});

test("a watch question is a select like any dialog: /ui-response carries the chosen option to pi, and the /watch route is gone", { timeout: 30_000 }, async () => {
	const dir = tmp("pi-loops-page-watch-");
	const log = path.join(dir, "child.log");
	const ask = { type: "extension_ui_request", id: "ask-1", method: "select", title: "Set up this watch?\nWaits for: ~/build.done appears", options: ["Set it up · this conversation · once", "Cancel"], timeout: 60_000 };
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1", commands: ["pi-loops"], log, lines: [ask] }));
	try {
		await page.pool.open({ sessionId: "s1", cwd: dir, piArgs: [] });
		const written = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
		assert.ok(await until(() => page.pool.views().find((v) => v.sessionId === "s1")?.pendingAsks === 1), "pi asked");
		const state = await page.get("c/s1/state");
		assert.deepEqual(state.body.pendingAsks.map((a: any) => [a.id, a.method, a.options]), [["ask-1", "select", ask.options]], "offered to a tab that opens now");
		const r = await page.post("c/s1/ui-response", { id: "ask-1", value: "Set it up · this conversation · once", type: "prompt", message: "/cron add" });
		assert.equal(r.status, 200);
		assert.ok(await until(() => written().some((m) => m.type === "extension_ui_response")), "the answer reached pi");
		assert.deepEqual(written().filter((m) => m.type === "extension_ui_response"), [{ type: "extension_ui_response", id: "ask-1", value: "Set it up · this conversation · once" }], "named fields only");
		assert.ok(!written().some((m) => m.type === "prompt"), "nothing else was written");
		assert.equal(page.pool.views().find((v) => v.sessionId === "s1")?.pendingAsks, 0, "answered: not offered again");
		const gone = await page.post("c/s1/watch", { planId: "wp-0123456789abcdef", verdict: "set", where: "chat", once: true });
		assert.equal(gone.status, 404);
	} finally {
		await page.stop();
	}
});

test("GET /activity: one project's runs and rule results, the attention block, a torn line left out, behind the token, and starts no pi", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-activity-");
	const project = path.join(dir, "proj");
	fs.mkdirSync(project);
	let budget = { spent: 1, cap: 5, over: false };
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }), { server: { budget: () => budget } });
	let opens = 0;
	const open = page.pool.open.bind(page.pool);
	page.pool.open = (how) => (opens++, open(how));
	try {
		const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
		const record = (n: number, over: Record<string, unknown> = {}) => ({ runId: `run-${n}`, jobId: "cron-1", jobName: "issue-triage", stateful: true, cwd: project, pid: 1, startedAt: ago(20 - n), finishedAt: ago(19 - n), ok: true, findings: 0, droppedFindings: 0, stateUpdated: true, ordinal: n, ...over });
		const runs = [1, 2, 3, 4, 5].map((n) => JSON.stringify(record(n)));
		fs.mkdirSync(page.loops, { recursive: true });
		fs.writeFileSync(path.join(page.loops, "runs.jsonl"), `${[...runs.slice(0, 2), "{torn", ...runs.slice(2), JSON.stringify(record(6, { cwd: path.join(dir, "other") }))].join("\n")}\n{"runId":"run-cut`);
		const audit = [
			{ ts: ago(4), type: "trigger_result", traceId: "t-1", cwd: project, state: "running", sourceLabel: "local:dynamic" },
			{ ts: ago(3), type: "trigger_result", traceId: "t-1", cwd: project, state: "completed", sourceLabel: "local:dynamic", summary: "matched dyn-1. hello, world", details: { matched_rule_ids: ["dyn-1"] } },
			{ ts: ago(2), type: "trigger_result", traceId: "t-2", cwd: project, state: "completed", sourceLabel: "local:dynamic", summary: "no dynamic trigger matched", details: { matched_rule_ids: [] } },
		];
		fs.writeFileSync(path.join(page.loops, "triggers-audit.jsonl"), audit.map((l) => JSON.stringify(l)).join("\n") + "\n");
		fs.writeFileSync(path.join(page.loops, "triggers.json"), JSON.stringify({ version: 1, rules: [{ id: "dyn-1", condition: "~/build.done appears", action: "print it", cwd: project, enabled: true }] }));
		writeInbox(page.loops, [finding({ id: `inb-${hex(1)}`, source: "trigger:local:dynamic", run_id: "t-1", job_id: "dyn-1", cwd: project, text: "matched dyn-1. hello, world" }), finding({ id: `inb-${hex(2)}`, kind: "checkpoint", cwd: path.join(dir, "other"), text: "Merge it? · waits: you" })]);
		const failing = (n: number) => ({ id: "cron-1", name: "issue-triage", cwd: project, enabled: true, runCount: 10, consecutiveFailures: n });
		fs.writeFileSync(path.join(page.loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [failing(2)] }));
		assert.equal((await fetch(`${page.url}activity`)).status, 401, "behind the token");
		const unknown = await page.get(`activity?cwd=${encodeURIComponent(path.join(dir, "nowhere"))}`);
		assert.deepEqual([unknown.status, unknown.body], [404, { error: "no such project" }]);
		const lost = await page.get("activity?session=nobody-knows-this-one");
		assert.equal(lost.status, 200);
		assert.deepEqual([lost.body.cwd, lost.body.items, lost.body.more, lost.body.failed], [null, [], 0, 0], "a session in no project gets no project's items");
		assert.deepEqual(Object.keys(lost.body.attention).sort(), ["failing", "newDecisions"], "and only the machine-wide parts of the attention block");
		assert.equal(lost.body.attention.newDecisions.length, 1);
		const got = await page.get(`activity?cwd=${encodeURIComponent(project)}&session=s1`);
		assert.equal(got.status, 200);
		assert.equal(got.body.cwd, project);
		assert.deepEqual(got.body.items.map((i: any) => [i.id, i.kind, i.carded]), [["t-1", "rule", false], ["run-5", "run", false], ["run-4", "run", false], ["run-3", "run", true], ["run-2", "run", true], ["run-1", "run", true]], "five runs, the quiet check left out, another project's run left out, the torn lines skipped");
		assert.deepEqual([got.body.items[0].source.name, got.body.items[0].inboxIds], ["~/build.done appears", [`inb-${hex(1)}`]]);
		assert.equal(got.body.items[1].source.label, "issue-triage", "a loop's row carries its label, as every surface labels it");
		assert.deepEqual([got.body.attention.decisions, got.body.attention.news], [0, 1], "the title counts this project");
		assert.deepEqual(got.body.attention.newDecisions.map((d: any) => [d.id, d.headline]), [[`inb-${hex(2)}`, "Merge it?"]], "the notification hears the whole machine");
		assert.deepEqual([got.body.attention.failing, got.body.attention.budget], [[], undefined], "two failures are not a streak, and the budget is said only when over");
		fs.writeFileSync(path.join(page.loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [failing(3)] }));
		budget = { spent: 5.5, cap: 5, over: true };
		const later = await page.get(`activity?cwd=${encodeURIComponent(project)}`);
		assert.deepEqual(later.body.attention.failing, [{ jobId: "cron-1", name: "issue-triage", streak: 3, key: "cron-1:7" }]);
		assert.equal(later.body.attention.budget.cap, 5);
		assert.match(later.body.attention.budget.day, /^\d{4}-\d{2}-\d{2}$/);
		assert.equal(opens, 0, "reading the activity started no pi");
	} finally {
		await page.stop();
	}
});

test("a terminal-held conversation is read from its file, never by switching the page's pi, and read again once when the terminal's turn ends", { timeout: 30_000 }, async () => {
	const dir = tmp("pi-loops-page-viewer-");
	const file = path.join(dir, "s1.jsonl");
	const line = (o: unknown) => `${JSON.stringify(o)}\n`;
	fs.writeFileSync(file, line({ type: "session", version: 3, id: "s1", cwd: dir, timestamp: new Date().toISOString() }) + line({ type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "asked from the page" }], timestamp: Date.now() } }));
	const log = path.join(dir, "rpc.jsonl");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1", sessionFile: file, log, commands: ["pi-loops"] }));
	const sent = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((m) => m.type) : []);
	const answer = (id: string, parentId: string, text: string) => fs.appendFileSync(file, line({ type: "message", id, parentId, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() } }));
	try {
		const child = await page.pool.open({ sessionId: "s1", cwd: dir, piArgs: [] });
		const rereads = () => child.backlog.filter((e: any) => e?.type === "reread");
		liveLease(page.loops, "s1", file, dir, { turns: true });
		// As a page does: its state first, which is when the pool learns the pi's session file.
		await page.get("c/s1/state");
		assert.ok(await until(() => child.sessionFile === file), "the page's pi has its session file");
		const first = await page.get("c/s1/history");
		assert.match(JSON.stringify(first.body.messages), /asked from the page/, "the file's messages");
		// A run card is not an answer: no reload for it.
		fs.appendFileSync(file, line({ type: "custom", customType: "pi-loops:view", id: "c1", parentId: "m1", timestamp: new Date().toISOString(), data: { title: "cron todo · 5s", lines: [] } }));
		await page.get("c/s1/state");
		assert.equal(rereads().length, 0, "a card is not worth a reload");
		// The terminal answers: its turn is on the lease while it runs, and nothing is read mid-turn.
		liveLease(page.loops, "s1", file, dir, { turns: true, turnSince: new Date().toISOString() });
		answer("m2", "c1", "half an answer");
		const during = await page.get("c/s1/state");
		assert.equal(rereads().length, 0, "not in the middle of the terminal's turn");
		assert.ok(during.body.holder.turnSince, "the page is told the terminal is answering");
		liveLease(page.loops, "s1", file, dir, { turns: true });
		await page.get("c/s1/state");
		assert.equal(rereads().length, 1, "the turn is over: read again, once");
		assert.equal(typeof rereads()[0].seq, "number", "numbered like every event");
		await page.get("c/s1/state");
		assert.equal(rereads().length, 1, "and not again with nothing new");
		const again = await page.get("c/s1/history");
		assert.match(JSON.stringify(again.body.messages), /half an answer/);
		assert.ok(again.body.seq >= rereads()[0].seq, "the transcript covers the reread that asked for it");
		assert.deepEqual(sent().filter((t) => t === "switch_session" || t === "get_messages"), [], "the page's pi was neither switched nor asked");
	} finally {
		await page.stop();
	}
});

test("a terminal-held conversation's run cards come back with its messages, in file order", () => {
	const dir = tmp("pi-loops-page-held-cards-");
	const file = path.join(dir, "s1.jsonl");
	const at = new Date().toISOString();
	let parent: string | null = null;
	const lines = [JSON.stringify({ type: "session", version: 3, id: "s1", cwd: dir, timestamp: at })];
	const add = (id: string, body: Record<string, unknown>) => {
		lines.push(JSON.stringify({ id, parentId: parent, timestamp: at, ...body }));
		parent = id;
	};
	const card = (title: string) => ({ type: "custom", customType: "pi-loops:view", data: { title, lines: [] } });
	add("m1", { type: "message", message: { role: "user", content: [{ type: "text", text: "start a loop" }], timestamp: Date.now() } });
	add("c1", card("cron todo · 5s · 0 findings"));
	add("a1", { type: "custom", customType: "trigger_result", data: { state: "completed" } });
	add("c2", card("cron todo · 4s · 1 finding"));
	add("m2", { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: Date.now() } });
	add("c3", card("cron todo FAILED · 2s · provider 500"));
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
	const read = readHeldConversation(file);
	assert.ok(read);
	const shape = (m: any) => (m.role === "pi-loops:view" ? `card:${m.title}` : `${m.role}:${m.content[0].text}`);
	assert.deepEqual(read.messages.map(shape), ["user:start a loop", "card:cron todo · 5s · 0 findings", "card:cron todo · 4s · 1 finding", "assistant:ok", "card:cron todo FAILED · 2s · provider 500"], "the three cards where they were written; other entries are not drawn");
	// The page's pi answers its own conversation's messages; the cards go in where its entries put them.
	const entries = lines.slice(1).map((l) => JSON.parse(l));
	const live = [...entries.filter((e) => e.type === "message").map((e) => e.message), { role: "assistant", content: [{ type: "text", text: "not written yet" }] }];
	assert.deepEqual(historyWithCards(entries, "c3", live).map(shape), ["user:start a loop", "card:cron todo · 5s · 0 findings", "card:cron todo · 4s · 1 finding", "assistant:ok", "card:cron todo FAILED · 2s · provider 500", "assistant:not written yet"]);
});

test("a held conversation's file over 32 MB is not read in the always-on process", () => {
	const dir = tmp("pi-loops-page-held-cap-");
	const file = path.join(dir, "s1.jsonl");
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "s1", cwd: dir, timestamp: new Date().toISOString() })}\n`);
	assert.equal(HELD_READ_MAX_BYTES, 32 * 1024 * 1024);
	assert.ok(readHeldConversation(file), "a small file is read");
	const real = fs.statSync(file);
	let read = 0;
	const big = (fd: number) => (read++, Object.assign(fs.fstatSync(fd), { size: HELD_READ_MAX_BYTES + 1 }));
	assert.equal(readHeldConversation(file, big as typeof fs.fstatSync), undefined, "the page's pi answers instead");
	assert.equal(read, 1, "the size is the open file's");
	assert.equal(fs.statSync(file).size, real.size);
});

test("what a terminal added is found to hold a message when a large result comes after the message line starts", () => {
	const dir = tmp("pi-loops-page-added-");
	const file = path.join(dir, "s1.jsonl");
	const head = `${JSON.stringify({ type: "session", version: 3, id: "s1", cwd: dir, timestamp: new Date().toISOString() })}\n`;
	fs.writeFileSync(file, head);
	fs.appendFileSync(file, `${JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(600 * 1024) }] } })}\n`);
	assert.equal(addedMessage(file, head.length, fs.statSync(file).size), true);
	const quiet = fs.statSync(file).size;
	fs.appendFileSync(file, `${JSON.stringify({ type: "custom", customType: "pi-loops:view", id: "c1", parentId: "m1", data: { title: "cron todo · 5s", lines: ["y".repeat(300 * 1024)] } })}\n`);
	assert.equal(addedMessage(file, quiet, fs.statSync(file).size), false, "a card is not a message");
});

test("a short message between two large entries a terminal added is not missed", () => {
	const dir = tmp("pi-loops-page-added-middle-");
	const file = path.join(dir, "s1.jsonl");
	const head = `${JSON.stringify({ type: "session", version: 3, id: "s1", cwd: dir, timestamp: new Date().toISOString() })}\n`;
	fs.writeFileSync(file, head);
	const card = (id: string) => `${JSON.stringify({ type: "custom", customType: "pi-loops:view", id, parentId: null, data: { title: "cron todo · 5s", lines: ["y".repeat(600 * 1024)] } })}\n`;
	fs.appendFileSync(file, card("c1"));
	fs.appendFileSync(file, `${JSON.stringify({ type: "message", id: "m1", parentId: "c1", message: { role: "user", content: [{ type: "text", text: "hi" }] } })}\n`);
	fs.appendFileSync(file, card("c2"));
	assert.equal(addedMessage(file, head.length, fs.statSync(file).size), true, "what neither window sees is read again");
});

test("a pi-loops view is redacted and capped on the server before the page sees it", () => {
	const secret = "sk-abcdefghijklmnopqrstuvwxyz012345";
	const entries = [
		{ type: "message", id: "m1", parentId: null, timestamp: "2026-11-05T00:00:00Z", message: { role: "user", content: [{ type: "text", text: "trace it" }], timestamp: 1 } },
		{ type: "custom", customType: "pi-loops:view", id: "v1", parentId: "m1", timestamp: "2026-11-05T00:00:01Z", data: { title: `cron trace ${secret}`, lines: [`error: key ${secret}`, "z".repeat(9000), "after"] } },
	];
	const [, view] = historyWithCards(entries) as any[];
	assert.equal(view.id, "v1");
	const all = [view.title, ...view.lines].join("\n");
	assert.doesNotMatch(all, /sk-abcdefghijklmnopqrstuvwxyz012345/);
	assert.ok(all.length <= 4000, `capped: ${all.length}`);
	assert.match(view.title, /^cron trace /);
});

test("the page's pi's conversation comes back with its run cards in place, asked fresh each time", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-rpc-cards-");
	const file = path.join(dir, "s1.jsonl");
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "s1", cwd: dir, timestamp: new Date().toISOString() })}\n`);
	const held = path.join(dir, "held.json");
	const msg = (id: string, parentId: string | null, role: string, text: string) => ({ type: "message", id, parentId, timestamp: "2026-11-05T00:00:00Z", message: { role, content: [{ type: "text", text }], timestamp: 1 } });
	const card = (id: string, parentId: string, title: string) => ({ type: "custom", customType: "pi-loops:view", id, parentId, timestamp: "2026-11-05T00:00:00Z", data: { title, lines: [] } });
	const entries = [msg("m1", null, "user", "start a loop"), card("c1", "m1", "cron todo · 5s · 0 findings"), msg("m2", "c1", "assistant", "ok")];
	const messagesOf = (es: any[]) => es.filter((e) => e.type === "message").map((e) => e.message);
	fs.writeFileSync(held, JSON.stringify({ messages: messagesOf(entries), entries, leafId: "m2" }));
	const log = path.join(dir, "rpc.jsonl");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1", sessionFile: file, log, history: held }));
	const shape = (m: any) => (m.role === "pi-loops:view" ? `card:${m.title}` : `${m.role}:${m.content[0].text}`);
	try {
		await page.pool.open({ sessionId: "s1", cwd: dir, piArgs: [] });
		await page.get("c/s1/state");
		const first = await page.get("c/s1/history");
		assert.deepEqual(first.body.messages.map(shape), ["user:start a loop", "card:cron todo · 5s · 0 findings", "assistant:ok"], "the card where it was saved");
		entries.push(card("c2", "m2", "cron todo · 4s · 1 finding"));
		fs.writeFileSync(held, JSON.stringify({ messages: messagesOf(entries), entries, leafId: "c2" }));
		const second = await page.get("c/s1/history");
		assert.deepEqual(second.body.messages.map(shape), ["user:start a loop", "card:cron todo · 5s · 0 findings", "assistant:ok", "card:cron todo · 4s · 1 finding"], "a card saved a moment after the last read is in the next one");
		assert.equal(second.body.messages[3].id, "c2", "each card carries its entry id");
	} finally {
		await page.stop();
	}
});

test("the page's pi's conversation over 32 MB is answered with its messages alone, its entries never asked for: not to prime, find, undo or restore its model", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-rpc-cap-");
	const file = path.join(dir, "s1.jsonl");
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "s1", cwd: dir, timestamp: new Date().toISOString() })}\n`);
	const held = path.join(dir, "held.json");
	const entries = [{ type: "message", id: "m1", parentId: null, timestamp: "2026-11-05T00:00:00Z", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 } }, { type: "custom", customType: "pi-loops:view", id: "c1", parentId: "m1", timestamp: "2026-11-05T00:00:00Z", data: { title: "cron todo · 5s", lines: [] } }];
	fs.writeFileSync(held, JSON.stringify({ messages: [entries[0].message], entries, leafId: "c1" }));
	const log = path.join(dir, "rpc.jsonl");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1", sessionFile: file, log, history: held, commands: ["cron"] }));
	const realStat = fsDefault.statSync;
	const huge = mock.method(fsDefault, "statSync", (p: fs.PathLike, ...rest: any[]) => {
		const st = (realStat as any)(p, ...rest);
		return String(p) === file && st ? Object.assign(st, { size: HELD_READ_MAX_BYTES + 1 }) : st;
	});
	syncBuiltinESMExports();
	try {
		await page.pool.open({ sessionId: "s1", cwd: dir, piArgs: [] });
		await page.get("c/s1/state");
		// The pool primes the panel on its own at spawn (primeRuntime, after the catalog), and asks for
		// a fresh snapshot last: wait for that, so what it sent is all in the log.
		const sent = () => fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		assert.ok(await until(() => sent().some((m) => m.type === "prompt" && m.message === "/cron snapshot")), "primed");
		const got = await page.get("c/s1/history");
		assert.deepEqual(got.body.messages.map((m: any) => m.role), ["user"], "no card: the entries are too big to read here");
		const find = await page.post("c/s1/find", { q: "hi" });
		assert.deepEqual(find.body.hits, [], "nothing found in what is not read");
		const undo = await page.post("c/s1/undo", {});
		assert.equal(undo.body.success, false);
		assert.match(undo.body.error, /too big/);
		await page.pool.get("s1")?.restoreModelOf(file);
		const types = sent().map((m) => m.type);
		assert.ok(types.includes("get_messages") && !types.includes("get_entries"), types.join(","));
	} finally {
		huge.mock.restore();
		syncBuiltinESMExports();
		await page.stop();
	}
});

test("a new conversation pi has not written yet keeps its run cards on reload, and undo says there is nothing to undo", { timeout: 20_000 }, async () => {
	// pi writes the session file at the first user or assistant message: a conversation that has had
	// only slash commands (`/cron add …`) holds its cards in memory, which is small.
	const dir = tmp("pi-loops-page-unwritten-");
	const file = path.join(dir, "s1.jsonl");
	const held = path.join(dir, "held.json");
	const card = { type: "custom", customType: "pi-loops:view", id: "c1", parentId: null, timestamp: "2026-11-05T00:00:00Z", data: { title: "cron todo · 5s · 0 findings", lines: [] } };
	fs.writeFileSync(held, JSON.stringify({ messages: [], entries: [card], leafId: "c1" }));
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1", sessionFile: file, log: path.join(dir, "rpc.jsonl"), history: held }));
	try {
		await page.pool.open({ sessionId: "s1", cwd: dir, piArgs: [] });
		await page.get("c/s1/state");
		const got = await page.get("c/s1/history");
		assert.deepEqual(got.body.messages.map((m: any) => m.role === "pi-loops:view" ? `card:${m.title}` : m.role), ["card:cron todo · 5s · 0 findings"], "the card pi holds is drawn");
		const undo = await page.post("c/s1/undo", {});
		assert.deepEqual([undo.status, undo.body.error], [400, "nothing to undo"]);
	} finally {
		await page.stop();
	}
});

test("a conversation whose file was on disk and is gone is not parsed here: it may have moved, at any size", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-moved-");
	const file = path.join(dir, "s1.jsonl");
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "s1", cwd: dir, timestamp: new Date().toISOString() })}\n`);
	const held = path.join(dir, "held.json");
	const entries = [{ type: "message", id: "m1", parentId: null, timestamp: "2026-11-05T00:00:00Z", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 } }];
	fs.writeFileSync(held, JSON.stringify({ messages: [entries[0].message], entries, leafId: "m1" }));
	const log = path.join(dir, "rpc.jsonl");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1", sessionFile: file, log, history: held }));
	try {
		await page.pool.open({ sessionId: "s1", sessionFile: file, cwd: dir, piArgs: [] });
		await page.get("c/s1/state");
		const sent = () => fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l).type);
		// A /history before pi has named its file reads nothing, by design; on a slow runner its
		// get_state answer can land after the first /history, so ask again until it has.
		for (const until = Date.now() + 5_000; Date.now() < until; await new Promise((r) => setTimeout(r, 50))) {
			await page.get("c/s1/history");
			if (sent().includes("get_entries")) break;
		}
		assert.ok(sent().includes("get_entries"), "read while it is on disk");
		fs.renameSync(file, path.join(dir, "moved.jsonl"));
		const before = sent().length;
		await page.get("c/s1/history");
		assert.equal(sent().slice(before).includes("get_entries"), false, "not once it is gone");
	} finally {
		await page.stop();
	}
});

test("a conversation whose file pi has not named, or that is not on disk, is not parsed here: its size is unknown", () => {
	// The page's pi names its file in its first get_state answer; a /history before that answer
	// must not pull the whole entry tree into the always-on process on the strength of not knowing.
	assert.equal(entriesReadable(undefined), false);
	const dir = tmp("pi-loops-page-readable-");
	assert.equal(entriesReadable(path.join(dir, "moved-away.jsonl")), false, "a file that is not there may have moved, at any size");
	assert.equal(entriesReadable(path.join(dir, "not-written-yet.jsonl"), false), true, "one never on disk holds only what is in memory");
	const small = path.join(dir, "s.jsonl");
	fs.writeFileSync(small, "{}\n");
	assert.equal(entriesReadable(small), true);
});

/* ------------------------------------------------ loop rows: Stop this run and the suggestion */

const RUN = `run-${"c".repeat(32)}`;
const quietRuns = (jobId: string, n: number) => Array.from({ length: n }, (_, i) => JSON.stringify({ runId: `run-${hex(i + 100)}`, jobId, stateful: true, cwd: "/p", pid: 1, startedAt: new Date(Date.now() - (n - i) * 60_000).toISOString(), finishedAt: new Date(Date.now() - (n - i) * 60_000 + 1000).toISOString(), ok: true, findings: 0, droppedFindings: 0, stateUpdated: true })).join("\n") + "\n";
const loopJob = (cwd: string, over: Record<string, unknown> = {}) => ({ id: "cron-aaaaaaaa", name: "pr-watch", schedule: { kind: "every", ms: 15 * 60_000 }, stateful: true, prompt: "watch the PRs", cwd, enabled: true, catchUp: true, createdAt: new Date(Date.now() - 86_400_000).toISOString(), runCount: 12, skippedOverlap: 0, ...over });

test("the loop routes take the checks every POST takes, a 1 KB body, exactly their fields, and whole ids; nothing refused writes or starts a pi", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-loops-");
	const stops: string[] = [];
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }), { server: { stopRun: (id) => (stops.push(id), { stopping: "run" }) } });
	let opens = 0;
	const open = page.pool.open.bind(page.pool);
	page.pool.open = (how) => (opens++, open(how));
	try {
		fs.mkdirSync(page.loops, { recursive: true });
		fs.writeFileSync(path.join(page.loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [loopJob(dir)] }));
		fs.writeFileSync(path.join(page.loops, "runs.jsonl"), quietRuns("cron-aaaaaaaa", 12));
		const before = fs.readFileSync(path.join(page.loops, "jobs.json"), "utf8");
		const bodies: Record<string, Record<string, unknown>> = { "loops/stop": { runId: RUN }, "loops/tune": { jobId: "cron-aaaaaaaa", key: "slower:cron-aaaaaaaa:every 15m", choice: "keep" } };
		for (const route of ["loops/stop", "loops/tune"]) {
			const good = bodies[route];
			const send = (headers: Record<string, string>, b: unknown = good, at = route) => fetch(`${page.url}${at}`, { method: "POST", headers, body: typeof b === "string" ? b : JSON.stringify(b) });
			const json = { "content-type": "application/json" };
			assert.equal((await send(json)).status, 401, `${route}: no token`);
			assert.equal((await send({ ...json, "x-pi-web-token": "b".repeat(32) })).status, 403, `${route}: a wrong token`);
			assert.equal((await send({ ...json, "x-pi-web-token": TEST_TOKEN, "sec-fetch-site": "cross-site" })).status, 403, `${route}: another site`);
			assert.equal((await send({ ...json, "x-pi-web-token": TEST_TOKEN, origin: "null" })).status, 403, `${route}: Origin null`);
			assert.equal((await send({ ...json, "x-pi-web-token": TEST_TOKEN, origin: "https://evil.example" })).status, 403, `${route}: another origin`);
			assert.equal((await send(json, undefined, `${route}?token=${TEST_TOKEN}`)).status, 403, `${route}: a token in the URL of a POST`);
			assert.equal((await send({ "content-type": "text/plain", "x-pi-web-token": TEST_TOKEN })).status, 415, `${route}: a form post`);
			const ok = { ...json, "x-pi-web-token": TEST_TOKEN };
			assert.equal((await send(ok, JSON.stringify({ ...good, pad: "x".repeat(1100) }))).status, 413, `${route}: past 1 KB`);
			assert.equal((await send(ok, "{not json")).status, 400, `${route}: not JSON`);
			assert.equal((await send(ok, "[1]")).status, 400, `${route}: not an object`);
			const extra = await send(ok, { ...good, cwd: "/etc" });
			assert.deepEqual([extra.status, (await extra.json()).error], [400, 'unknown field "cwd"'], `${route}: an unknown field`);
		}
		const stopWith = (b: unknown) => page.post("loops/stop", b);
		for (const runId of ["run-1", `run-${"C".repeat(32)}`, `run-${"c".repeat(31)}`, `${RUN}x`, `cron-${"c".repeat(32)}`, "", 7, null]) assert.equal((await stopWith({ runId })).status, 400, `stop: ${JSON.stringify(runId)} is not a whole run id`);
		const tuneWith = (b: Record<string, unknown>) => page.post("loops/tune", { ...bodies["loops/tune"], ...b });
		for (const jobId of ["../jobs", "", "a b", 7]) assert.equal((await tuneWith({ jobId })).status, 400, `tune: job id ${JSON.stringify(jobId)}`);
		for (const choice of ["Apply", "delete", ""]) assert.equal((await tuneWith({ choice })).status, 400, `tune: choice ${choice}`);
		assert.equal((await tuneWith({ key: "k".repeat(301) })).status, 400, "tune: a key past 300 characters");
		assert.deepEqual(await tuneWith({ jobId: "cron-bbbbbbbb" }), { status: 404, body: { error: "no such loop" } });
		assert.deepEqual(stops, [], "no refused stop reached pi-loops");
		assert.equal(fs.readFileSync(path.join(page.loops, "jobs.json"), "utf8"), before, "nothing refused changed jobs.json");
		assert.equal(audits(page.loops).length, 0, "nor wrote an audit row");
		assert.equal(opens, 0, "and no route started a pi");
	} finally {
		await page.stop();
	}
});

test("POST /loops/stop: the whole run id goes to pi-loops, which answers at once; a run that already ended says finished", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-stop-");
	const asked: string[] = [];
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }), { server: { stopRun: (id) => (asked.push(id), id === RUN ? { stopping: "run" } : id === `run-${"d".repeat(32)}` ? { stopping: "row" } : { finished: true }) } });
	let opens = 0;
	const open = page.pool.open.bind(page.pool);
	page.pool.open = (how) => (opens++, open(how));
	try {
		assert.deepEqual(await page.post("loops/stop", { runId: RUN }), { status: 200, body: { ok: true, stopping: "run" } });
		assert.deepEqual(await page.post("loops/stop", { runId: `run-${"d".repeat(32)}` }), { status: 200, body: { ok: true, stopping: "row" } }, "a held turn: through its conversation's queue");
		assert.deepEqual(await page.post("loops/stop", { runId: `run-${"e".repeat(32)}` }), { status: 200, body: { ok: false, finished: true } });
		assert.deepEqual(asked, [RUN, `run-${"d".repeat(32)}`, `run-${"e".repeat(32)}`]);
		assert.equal(opens, 0, "a stop never starts a pi");
	} finally {
		await page.stop();
	}
	// A page served without pi-loops' stop (a test, an older wiring) has nothing to stop with.
	const bare = await startTestPage(tmp("pi-loops-page-stop-"), fakePi(dir, { sessionId: "s1" }));
	try {
		assert.equal((await bare.post("loops/stop", { runId: RUN })).status, 404);
	} finally {
		await bare.stop();
	}
});

test("a loop row carries its run, its signal and one suggestion; apply writes one patch and a cron_control_plane row, Keep only the kept key, a stale key is 409", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-tune-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	const jobsFile = path.join(page.loops, "jobs.json");
	const jobs = () => JSON.parse(fs.readFileSync(jobsFile, "utf8")).jobs;
	try {
		fs.mkdirSync(page.loops, { recursive: true });
		const running = { runId: RUN, pid: process.pid, host: "h", startedAt: new Date().toISOString() };
		const original = loopJob(dir);
		// pi-loops in the background holds the busy loop's run: its pid is the service record's.
		fs.writeFileSync(path.join(page.loops, "host-service.json"), JSON.stringify({ v: 1, pid: process.pid, startedAt: new Date().toISOString() }));
		const inWindow = { runId: `run-${"9".repeat(32)}`, pid: 999_999_999, host: "h", startedAt: new Date().toISOString() };
		fs.writeFileSync(jobsFile, JSON.stringify({ version: 2, jobs: [original, loopJob(dir, { id: "cron-cccccccc", name: "busy", running }), loopJob(dir, { id: "cron-dddddddd", name: "window", stateful: false, running: inWindow })] }));
		fs.writeFileSync(path.join(page.loops, "runs.jsonl"), quietRuns("cron-aaaaaaaa", 12));
		await page.pool.open({ sessionId: "s1", cwd: dir, piArgs: [] });
		const rows = (await page.get("c/s1/state")).body.automation.jobs;
		const quiet = rows.find((j: any) => j.id === "cron-aaaaaaaa");
		assert.deepEqual(quiet.signal, { findings30d: 0, claimed30d: 0, dismissed30d: 0, quietStreak: 12 });
		assert.deepEqual(quiet.suggestion, { kind: "slower", key: "slower:cron-aaaaaaaa:every 15m", label: "Run hourly instead" });
		assert.equal(quiet.run, undefined);
		const busy = rows.find((j: any) => j.id === "cron-cccccccc");
		assert.deepEqual(busy.run, { runId: RUN, since: running.startedAt }, "the run Stop this run names");
		assert.equal(busy.suggestion, undefined, "no suggestion while it runs");
		const window = rows.find((j: any) => j.id === "cron-dddddddd");
		assert.deepEqual([window.running, window.run], [true, undefined], "a turn a window runs has no Stop this run: only what pi-loops in the background holds");
		assert.deepEqual(quiet.lastEnd, { runId: `run-${hex(111)}` }, "the latest record, which did not stop by a person");

		assert.deepEqual(await page.post("loops/tune", { jobId: "cron-aaaaaaaa", key: "slower:cron-aaaaaaaa:every 10m", choice: "apply" }), { status: 409, body: { error: "the suggestion changed" } });
		assert.deepEqual(await page.post("loops/tune", { jobId: "cron-cccccccc", key: "slower:cron-cccccccc:every 15m", choice: "apply" }), { status: 409, body: { error: "the suggestion changed" } }, "nothing is suggested for a running loop");
		assert.equal(audits(page.loops).length, 0);

		// Keep: the kept key and nothing else.
		const kept = await page.post("loops/tune", { jobId: "cron-aaaaaaaa", key: "slower:cron-aaaaaaaa:every 15m", choice: "keep" });
		assert.deepEqual(kept, { status: 200, body: { ok: true, kept: true } });
		const afterKeep = jobs().find((j: any) => j.id === "cron-aaaaaaaa");
		assert.deepEqual({ ...afterKeep, tuneKept: undefined }, { ...original, tuneKept: undefined }, "the schedule, enabled and every stamp as they were");
		assert.equal(afterKeep.tuneKept, "slower:cron-aaaaaaaa:every 15m");
		assert.equal(audits(page.loops).length, 0, "Keep writes no audit row");
		const again = (await page.get("c/s1/state")).body.automation.jobs.find((j: any) => j.id === "cron-aaaaaaaa");
		assert.equal(again.suggestion, undefined, "a kept suggestion stays dismissed");
		assert.equal((await page.post("loops/tune", { jobId: "cron-aaaaaaaa", key: "slower:cron-aaaaaaaa:every 15m", choice: "apply" })).status, 409, "and cannot be applied behind the person's back");

		// Apply: a fresh loop, the same numbers.
		fs.writeFileSync(jobsFile, JSON.stringify({ version: 2, jobs: [loopJob(dir, { lastFiredAt: new Date(Date.now() - 60_000).toISOString() })] }));
		const applied = await page.post("loops/tune", { jobId: "cron-aaaaaaaa", key: "slower:cron-aaaaaaaa:every 15m", choice: "apply" });
		assert.equal(applied.status, 200);
		assert.equal(applied.body.op, "set");
		assert.equal(applied.body.line, "now every 1h");
		assert.ok(Date.parse(applied.body.nextAt) > Date.now(), "the next time as a stamp, which the page writes in local time");
		const job = jobs()[0];
		assert.deepEqual(job.schedule, { kind: "every", ms: 3_600_000 });
		assert.ok(job.lastDueAt, "the clock restarts at the edit, as /cron set does");
		const rows2 = audits(page.loops).filter((a) => a.type === "cron_control_plane");
		assert.equal(rows2.length, 1);
		assert.deepEqual([rows2[0].state, rows2[0].sourceLabel, rows2[0].eventLabel, rows2[0].details.before_schedule, rows2[0].details.after_schedule, rows2[0].details.suggestion], ["set", "page", "cron-aaaaaaaa", "every 15m", "every 1h", "slower:cron-aaaaaaaa:every 15m"]);
		assert.equal((await page.post("loops/tune", { jobId: "cron-aaaaaaaa", key: "slower:cron-aaaaaaaa:every 15m", choice: "apply" })).status, 409, "applied once: the key is stale now");
	} finally {
		await page.stop();
	}
});

test("a loop whose findings were all dismissed is offered Pause, and applying it turns the loop off", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-pause-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		fs.mkdirSync(page.loops, { recursive: true });
		fs.writeFileSync(path.join(page.loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [loopJob(dir)] }));
		writeInbox(page.loops, Array.from({ length: 6 }, (_, i) => finding({ id: `inb-${hex(i + 1)}`, job_id: "cron-aaaaaaaa", status: "dismissed" })));
		fs.writeFileSync(path.join(page.loops, "runs.jsonl"), JSON.stringify({ runId: `run-${hex(1)}`, jobId: "cron-aaaaaaaa", stateful: true, cwd: dir, pid: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ok: true, findings: 6, droppedFindings: 0, stateUpdated: true }) + "\n");
		await page.pool.open({ sessionId: "s1", cwd: dir, piArgs: [] });
		const row = (await page.get("c/s1/state")).body.automation.jobs[0];
		assert.deepEqual(row.signal, { findings30d: 6, claimed30d: 0, dismissed30d: 6, quietStreak: 0 });
		assert.equal(row.suggestion.label, "Pause");
		const applied = await page.post("loops/tune", { jobId: "cron-aaaaaaaa", key: row.suggestion.key, choice: "apply" });
		assert.deepEqual(applied, { status: 200, body: { ok: true, op: "disable", line: "paused" } });
		assert.equal(JSON.parse(fs.readFileSync(path.join(page.loops, "jobs.json"), "utf8")).jobs[0].enabled, false);
		assert.equal(audits(page.loops).find((a) => a.type === "cron_control_plane")?.state, "disable");
	} finally {
		await page.stop();
	}
});

test("a rule that waits for a path says so on its row, with the next look from the process that checks rules", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-rulelook-");
	const next = new Date(2026, 10, 5, 9, 22).getTime();
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }), { server: { ruleLook: (id) => (id === `dyn-${hex(1)}` ? { look: "absent", nextAt: next } : undefined) } });
	try {
		fs.mkdirSync(page.loops, { recursive: true });
		const precheck = { v: 1, of: "~/build.done appears", raw: "~/build.done", resolved: "/home/me/build.done" };
		const rule = (id: string, over: Record<string, unknown> = {}) => ({ id, condition: "~/build.done appears", action: "tell me", enabled: true, fireOnce: true, promoteToChat: false, createdAt: "t", cwd: dir, precheck, ...over });
		fs.writeFileSync(path.join(page.loops, "triggers.json"), JSON.stringify({ version: 1, rules: [rule(`dyn-${hex(1)}`), rule(`dyn-${hex(2)}`), rule(`dyn-${hex(3)}`, { precheck: undefined }), rule(`dyn-${hex(4)}`, { condition: "~/build.done appears and is not empty" })] }));
		await page.pool.open({ sessionId: "s1", cwd: dir, piArgs: [] });
		const rules = (await page.get("c/s1/state")).body.automation.rules;
		assert.deepEqual([rules[0].waitsFor, rules[0].look, Date.parse(rules[0].nextLookAt)], ["~/build.done", "no model call until the file exists", next], "the next look as a stamp, for the page's own clock");
		assert.deepEqual([rules[1].waitsFor, rules[1].look, rules[1].nextLookAt], ["~/build.done", "no model call until the file exists", undefined], "not looked at yet in this process");
		assert.deepEqual([rules[2].look, rules[3].look], [undefined, undefined], "a rule from before the pre-check, and one edited by hand, are the model's");
	} finally {
		await page.stop();
	}
});

test("a tune whose store write fails answers 500 with fixed words and logs the error; Keep and Apply racing land once; a loop with no project is 404", { timeout: 30_000 }, async () => {
	const dir = tmp("pi-loops-page-tune-lows-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	const jobsFile = path.join(page.loops, "jobs.json");
	const key = "slower:cron-aaaaaaaa:every 15m";
	try {
		fs.mkdirSync(page.loops, { recursive: true });
		fs.writeFileSync(path.join(page.loops, "runs.jsonl"), quietRuns("cron-aaaaaaaa", 12));

		// L2: Keep in one tab, Apply in another, at once: exactly one lands, whichever is first.
		for (let i = 0; i < 4; i++) {
			fs.writeFileSync(jobsFile, JSON.stringify({ version: 2, jobs: [loopJob(dir, { lastFiredAt: new Date(Date.now() - 60_000).toISOString() })] }));
			const answers = await Promise.all([page.post("loops/tune", { jobId: "cron-aaaaaaaa", key, choice: "keep" }), page.post("loops/tune", { jobId: "cron-aaaaaaaa", key, choice: "apply" })]);
			assert.deepEqual(answers.map((a) => a.status).sort(), [200, 409], `round ${i}: ${JSON.stringify(answers)}`);
			const job = JSON.parse(fs.readFileSync(jobsFile, "utf8")).jobs[0];
			assert.ok(answers[0].status === 200 ? job.tuneKept === key && job.schedule.ms === 15 * 60_000 : job.tuneKept === undefined && job.schedule.ms === 3_600_000, `round ${i}: ${JSON.stringify(job)}`);
		}

		// L3: a loop whose cwd names no project the page lists.
		fs.writeFileSync(jobsFile, JSON.stringify({ version: 2, jobs: [loopJob("")] }));
		assert.deepEqual(await page.post("loops/tune", { jobId: "cron-aaaaaaaa", key: "slower:cron-aaaaaaaa:every 15m", choice: "apply" }), { status: 404, body: { error: "no such loop" } });

		// L1: the store cannot be written.
		fs.writeFileSync(jobsFile, JSON.stringify({ version: 2, jobs: [loopJob(dir)] }));
		const store = (await import("../src/store.ts")).JobStore.prototype;
		const real = store.update;
		store.update = async () => { throw new Error(`EACCES: permission denied, open '${jobsFile}.tmp'`); };
		try {
			assert.deepEqual(await page.post("loops/tune", { jobId: "cron-aaaaaaaa", key, choice: "apply" }), { status: 500, body: { error: "could not change the loop" } });
		} finally {
			store.update = real;
		}
		assert.ok(page.logs.some((l) => l.includes("EACCES") && l.includes("tune cron-aaaaaaaa")), "the whole error is in the log");
	} finally {
		await page.stop();
	}
});

test("the Background view says a run a person stopped was stopped, not FAIL", () => {
	const page = renderHostPage({ ...status(), snapshot: { ...snap(), recent: [{ job: "pr-watch", at: "2026-11-05T10:00:00Z", ok: false, stopped: true, byPerson: true }, { job: "check-issues", at: "2026-11-05T09:30:00Z", ok: false, stopped: true }, { job: "nightly", at: "2026-11-05T09:00:00Z", ok: false, error: "provider 500" }] } });
	assert.ok(page.includes('<li>stopped <time datetime="2026-11-05T10:00:00Z">2026-11-05T10:00:00Z</time> pr-watch — stopped by you</li>'), page);
	assert.ok(page.includes('<li>stopped <time datetime="2026-11-05T09:30:00Z">2026-11-05T09:30:00Z</time> check-issues</li>'), "a quit or restart stopped it: no stopped by you");
	assert.ok(page.includes('<li>FAIL <time datetime="2026-11-05T09:00:00Z">2026-11-05T09:00:00Z</time> nightly — provider 500</li>'));
});

test("the waiting page's Stop it goes through the same stop as a loop row's, as the page's", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-server-");
	const stops: string[] = [];
	const aborted: string[] = [];
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }), {
		server: { heldTurn: () => ({ runId: RUN, label: "nightly" }), stopRun: (id) => (stops.push(id), { stopping: "row" }), abortRun: (id) => (aborted.push(id), true), sessions: { known: () => ({ cwd: dir, sessionFile: path.join(dir, "s1") }) } },
	});
	try {
		const stop = await fetch(`${page.url}c/s1/stop-turn`, { method: "POST", headers: { "x-pi-web-token": TEST_TOKEN, "sec-fetch-site": "same-origin" } });
		assert.equal(stop.status, 204);
		assert.deepEqual([stops, aborted], [[RUN], []], "stopRun, which writes the request row and records the page, never the bare abort");
	} finally {
		await page.stop();
	}
});
