import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { type CheckOptions, checkRequest, COOKIE, type RequestFacts } from "../src/page-server.ts";
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
	const fake = path.join(dir, "fakepi");
	fs.writeFileSync(fake, "#!/bin/sh\nsleep 8\n", { mode: 0o755 });
	const web = spawn(process.execPath, [path.join(process.cwd(), "src", "web-entry.mjs"), "--port", "0", "--no-open"], {
		env: { ...process.env, PI_BIN: fake, PI_LOOPS_DIR: path.join(dir, "loops") },
	});
	let output = "";
	web.stdout.on("data", (d: Buffer) => (output += d.toString()));
	web.stderr.on("data", (d: Buffer) => (output += d.toString()));
	const exited = new Promise((resolve) => web.on("exit", resolve));
	try {
		let url: string | undefined;
		for (const deadline = Date.now() + 6000; !url && Date.now() < deadline; await new Promise((r) => setTimeout(r, 50))) {
			url = /web on (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output)?.[1];
		}
		assert.ok(url, `it announced a URL, got:\n${output}`);
		const token = fs.readFileSync(path.join(dir, "loops", "web-token"), "utf8").trim();
		const send = (headers: Record<string, string>) =>
			fetch(`${url}prompt`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ text: "rm -rf ~" }) });

		const foreign = await send({ origin: "http://evil.example", cookie: `${COOKIE}=${token}` });
		assert.equal(foreign.status, 403, "a foreign Origin");
		assert.deepEqual(await foreign.json(), { error: "cross-site request refused" });
		const bare = await send({});
		assert.equal(bare.status, 401, "no credential");
		assert.deepEqual(await bare.json(), { error: "no token" });
		const formPost = await send({ cookie: `${COOKIE}=${token}` });
		assert.equal(formPost.status, 403, "the cookie and nothing else");
		assert.deepEqual(await formPost.json(), { error: "cross-origin post refused" });
		const notJson = await fetch(`${url}prompt`, { method: "POST", headers: { "x-pi-web-token": token, "content-type": "text/plain" }, body: JSON.stringify({ text: "rm -rf ~" }) });
		assert.equal(notJson.status, 415, "a post that is not JSON");

		assert.equal(fs.existsSync(path.join(dir, "loops", "requests")), false, "nothing reached requests/");
	} finally {
		web.kill("SIGTERM");
		await exited;
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
