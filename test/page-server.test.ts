import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { type CheckOptions, checkRequest, COOKIE, type HostStatus, renderHostPage, type RequestFacts, sessionRows } from "../src/page-server.ts";
import type { SessionLease } from "../src/lease.ts";
import { fakePi, startTestPage, TEST_TOKEN } from "./page-harness.ts";

const TOKEN = "a".repeat(32);
const OPTS: CheckOptions = { token: TOKEN, allowHosts: ["pi.example.test"], loopback: true };
const HERE = "127.0.0.1:4173";
const get = (facts: Partial<RequestFacts> = {}): RequestFacts => ({ method: "GET", path: "/state", host: HERE, remote: "127.0.0.1", ...facts });
const post = (facts: Partial<RequestFacts> = {}): RequestFacts => get({ method: "POST", path: "/prompt", ...facts });

test("no credential is 401; a wrong one is 403", () => {
	assert.deepEqual(checkRequest(get(), OPTS), { status: 401, why: "no token" });
	assert.deepEqual(checkRequest(get({ cookie: "b".repeat(32) }), OPTS), { status: 403, why: "bad token" });
	assert.deepEqual(checkRequest(get({ queryToken: `é${TOKEN.slice(1)}` }), OPTS), { status: 403, why: "bad token" }, "a token of the wrong byte length");
	assert.deepEqual(checkRequest(post({ origin: `http://${HERE}` }), OPTS), { status: 401, why: "no token" }, "a POST with nothing to carry");
});

test("a foreign Host is refused, whatever it carries", () => {
	assert.deepEqual(checkRequest(get({ host: "evil.example:4173", cookie: TOKEN }), OPTS), { status: 403, why: "forbidden host" });
	assert.deepEqual(checkRequest(get({ host: "pi.example.test.evil.example", cookie: TOKEN }), OPTS), { status: 403, why: "forbidden host" }, "a name that only starts with an allowed one");
	assert.deepEqual(checkRequest(get({ host: "10.0.0.5:4173", cookie: TOKEN }), OPTS), { status: 403, why: "forbidden host" }, "a bare IP on a loopback-bound server");
	assert.deepEqual(checkRequest(get({ host: "10.0.0.5:4173", cookie: TOKEN }), { ...OPTS, loopback: false }), { ok: true, via: "cookie" }, "a bare IP when bound to the network");
});

test("a .ts.net name passes from loopback and the tailnet, and not from elsewhere", () => {
	const tailnet = { host: "box.tail1234.ts.net", cookie: TOKEN };
	assert.deepEqual(checkRequest(get({ ...tailnet, remote: "127.0.0.1" }), OPTS), { ok: true, via: "cookie" });
	assert.deepEqual(checkRequest(get({ ...tailnet, remote: "::ffff:100.101.1.2" }), OPTS), { ok: true, via: "cookie" });
	assert.deepEqual(checkRequest(get({ ...tailnet, remote: "192.168.1.20" }), OPTS), { status: 403, why: "forbidden host" });
});

test("an allow-listed name passes, in any case", () => {
	assert.deepEqual(checkRequest(get({ host: "PI.example.test:4173", cookie: TOKEN }), OPTS), { ok: true, via: "cookie" });
	const two = { ...OPTS, allowHosts: ["pi.example.test", "box.local"] };
	assert.deepEqual(checkRequest(get({ host: "BOX.LOCAL", cookie: TOKEN }), two), { ok: true, via: "cookie" }, "any name on the list, with no port");
	assert.deepEqual(checkRequest(get({ host: "other.example.test:4173", cookie: TOKEN }), two), { status: 403, why: "forbidden host" }, "and no name off it");
});

test("a request another site started is refused, token or not", () => {
	for (const facts of [{ secFetchSite: "cross-site" }, { secFetchSite: "same-site" }, { origin: "http://localhost:5173" }, { origin: "null" }, { origin: "not a url" }]) {
		assert.equal((checkRequest(get({ ...facts, cookie: TOKEN }), OPTS) as { status: number }).status, 403, JSON.stringify(facts));
		assert.equal((checkRequest(post({ ...facts, headerToken: TOKEN }), OPTS) as { status: number }).status, 403, `POST ${JSON.stringify(facts)}`);
	}
});

test("a POST has to show it came from this page", () => {
	assert.deepEqual(checkRequest(post({ cookie: TOKEN }), OPTS), { status: 403, why: "cross-origin post refused" }, "the cookie alone is what a form post from anywhere carries");
	assert.deepEqual(checkRequest(post({ queryToken: TOKEN }), OPTS), { status: 403, why: "token in the query string is refused on POST" });
	assert.deepEqual(checkRequest(post({ queryToken: TOKEN, headerToken: TOKEN }), OPTS), { status: 403, why: "token in the query string is refused on POST" }, "even beside the header");
	assert.deepEqual(checkRequest(post({ headerToken: TOKEN }), OPTS), { ok: true, via: "header" }, "the header and no Origin");
	assert.deepEqual(checkRequest(post({ cookie: TOKEN, origin: `http://${HERE}` }), OPTS), { ok: true, via: "cookie" }, "the cookie and this Origin");
	assert.deepEqual(checkRequest(post({ cookie: TOKEN, secFetchSite: "same-origin" }), OPTS), { ok: true, via: "cookie" }, "the cookie and same-origin");
	assert.deepEqual(checkRequest(post({ cookie: TOKEN, headerToken: "b".repeat(32) }), OPTS), { status: 403, why: "cross-origin post refused" }, "a header with the wrong token proves nothing");
});

test("a GET keeps today's rule: no Origin passes, and the query still counts", () => {
	assert.deepEqual(checkRequest(get({ cookie: TOKEN }), OPTS), { ok: true, via: "cookie" });
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

		const foreign = await send({ origin: "http://evil.example", cookie: `${COOKIE}=${TEST_TOKEN}` });
		assert.equal(foreign.status, 403, "a foreign Origin");
		assert.deepEqual(await foreign.json(), { error: "cross-site request refused" });
		const bare = await send({});
		assert.equal(bare.status, 401, "no credential");
		assert.deepEqual(await bare.json(), { error: "no token" });
		const formPost = await send({ cookie: `${COOKIE}=${TEST_TOKEN}` });
		assert.equal(formPost.status, 403, "the cookie and nothing else");
		assert.deepEqual(await formPost.json(), { error: "cross-origin post refused" });
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
		legacy: [{ sessionId: "legacy", pid: 9 }, { sessionId: "dead", pid: 8 }], alive: (h) => h.pid !== 4, since: () => zero, title: () => undefined,
	});
	assert.deepEqual(rows.map((r) => [r.sessionId, r.holder.kind]), [["z-term", "terminal"], ["a-host", "host"], ["dead", "legacy-pi"], ["legacy", "legacy-pi"], ["mail", "nobody"], ["orphan", "nobody"]]);
	assert.deepEqual(rows[0].holder, { kind: "terminal", pid: 2, mode: "rpc", since: "t", pushServers: ["mcp"] });
	assert.deepEqual(rows[1].holder, { kind: "host", busy: "job", since: "h" });
	assert.deepEqual([rows[5].plainJobs, rows[5].rules, rows[5].mailbox], [1, 2, 1]);
	assert.equal(rows[0].cwd, "/work");
});

test("live lease beats legacy and dead lease without legacy becomes nobody", () => {
	const rows = sessionRows({ leases: [lease("x", { kind: "host", pid: 2, instance: "h", acquiredAt: "at", pushServers: [] }), lease("y", { kind: "terminal", pid: 4, instance: "d", acquiredAt: "at", pushServers: [] })], plainJobSessions: [], ruleSessions: [], mailbox: new Map(), legacy: [{ sessionId: "x", pid: 8 }], alive: (h) => h.pid === 2, since: () => zero, title: () => undefined });
	assert.deepEqual(rows.map((r) => r.holder.kind), ["host", "nobody"]);
});

test("a terminal holder whose lease says page is the page's, listed after the terminals", () => {
	const rows = sessionRows({
		leases: [lease("p", { kind: "terminal", pid: 5, instance: "c", acquiredAt: "at", mode: "rpc", pushServers: [], page: true }), lease("t", { kind: "terminal", pid: 6, instance: "w", acquiredAt: "at", mode: "tui", pushServers: [] })],
		plainJobSessions: [], ruleSessions: [], mailbox: new Map(), legacy: [], alive: () => true, since: () => zero, title: () => undefined,
	});
	assert.deepEqual(rows.map((r) => r.holder), [{ kind: "terminal", pid: 6, mode: "tui", since: "at", pushServers: [] }, { kind: "page", pid: 5, since: "at" }]);
	assert.ok(renderHostPage({ ...status(), sessions: rows }).includes("<td>the page, pid 5</td>"));
});

test("the Background view tells conversations apart by their title or first message", () => {
	const holder = { kind: "terminal" as const, pid: 6, instance: "w", acquiredAt: "at", mode: "tui" as const, pushServers: [] };
	const rows = sessionRows({
		leases: [lease("01a19f65-9e05", holder, { sessionFile: "/work/a.jsonl" }), lease("01a19f65-aaaa", holder, { sessionFile: "/work/b.jsonl" })],
		plainJobSessions: ["01a19f65-cccc"], ruleSessions: [], mailbox: new Map(), legacy: [], alive: () => true, since: () => zero,
		title: (file) => (file === "/work/a.jsonl" ? "fix <b>the</b> bug" : undefined),
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

test("the Background view shows the request queues in the words pi-loops status uses", () => {
	const s = status();
	s.snapshot.requests = [{ sessionId: "424aba43-0000", count: 2, oldest: new Date(Date.now() - 5 * 60_000).toISOString(), dead: 1, holder: { kind: "terminal", pid: 939915 } }];
	const page = renderHostPage(s);
	assert.ok(page.includes("<h2>Requests</h2>"));
	assert.ok(page.includes("<li>requests: 2 queued in 1 session(s)</li>"), page);
	assert.ok(page.includes("<li>424aba43: 2 queued · oldest 5m · dead: 1 · in pi 939915</li>"), page);
	assert.equal(renderHostPage(status()).includes("Requests"), false, "nothing queued, no section");
});

test("GET / with no conversation to open is the Background view; /background and /background.json answer behind the token", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-page-server-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }), { server: { background: status } });
	try {
		const root = await fetch(`${page.url}?token=${TEST_TOKEN}`);
		assert.equal(root.status, 200);
		assert.match(await root.text(), /<h1>pi-loops in the background<\/h1>/);
		assert.match(root.headers.get("set-cookie") ?? "", new RegExp(`^${COOKIE}=`), "and the browser is signed in from here on");
		const html = await fetch(`${page.url}background`, { headers: { cookie: `${COOKIE}=${TEST_TOKEN}` } });
		assert.equal(html.status, 200);
		assert.match(await html.text(), /pid 7 · pi-loops 5 · spawned/);
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

test("a key or a code spent on the waiting page still leaves the cookie, so the refresh gets in", { timeout: 30_000 }, async () => {
	// The open key is one shot and the waiting page reloads itself every five seconds: without the
	// cookie on that first answer, the reload arrived with a spent key and met the door.
	const dir = tmp("pi-loops-page-");
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }), { server: { heldTurn: () => ({ runId: "run-1", label: "nightly" }), sessions: { known: () => ({ cwd: dir, sessionFile: path.join(dir, "s.jsonl") }) } } });
	try {
		const key = page.server.openKeyFor("s1");
		const first = await fetch(`${page.url}c/s1/?open=${key}`);
		assert.equal(first.status, 200);
		assert.match(await first.text(), /nightly/, "the waiting page names the run");
		const cookie = first.headers.get("set-cookie") ?? "";
		assert.match(cookie, new RegExp(`${COOKIE}=${TEST_TOKEN}`), "the key's one load leaves the cookie");
		const refresh = await fetch(`${page.url}c/s1/`, { headers: { cookie: cookie.split(";")[0] } });
		assert.equal(refresh.status, 200, "and the refresh is signed in");
		assert.equal((await fetch(`${page.url}c/s1/?open=${key}`)).status, 403, "the key itself is spent");
		const code = page.server.newPairCode();
		const paired = await fetch(`${page.url}c/s1/?pair=${code}`);
		assert.equal(paired.status, 200);
		assert.match(paired.headers.get("set-cookie") ?? "", new RegExp(`${COOKIE}=${TEST_TOKEN}`), "so does the pairing code's");
	} finally {
		await page.stop();
	}
});
