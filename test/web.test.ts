import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { plainJobRow, requestFingerprint, ruleResultRow } from "../src/engine.ts";
import { RequestStore, type SessionRequest } from "../src/requests.ts";
import { LeaseStore } from "../src/lease.ts";
import { TriggerStore } from "../src/triggers.ts";
import { ChildPool, type PageChild } from "../src/page-children.ts";
import { type PageServerOptions, ring, startPageServer, unsentPersonRows, webToken } from "../src/page-server.ts";
import { until } from "./page-harness.ts";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * The page server in this process over a stand-in pi, with one conversation open the way pi-loops
 * opens one. `url` is that conversation's own address, `/c/<id>/`, and `root` the server's. A pi
 * that names its session is waited for (`named`), so `url` is the address the page stays on.
 */
async function startWeb(
	dir: string,
	piScript: string,
	opts: { named?: string; open?: { sessionId: string; sessionFile: string }; known?: PageServerOptions["sessions"]["known"] } = {},
) {
	const loops = path.join(dir, "loops");
	const fake = path.join(dir, `fakepi-${randomUUID().slice(0, 8)}`);
	fs.writeFileSync(fake, piScript, { mode: 0o755 });
	const logs: string[] = [];
	const log = (line: string) => void logs.push(line);
	const token = webToken(loops, (message) => {
		throw new Error(message);
	});
	const requests = new RequestStore(loops);
	const leases = new LeaseStore(loops);
	const pool = new ChildPool({ dir: loops, command: () => ({ command: fake, args: [] }), env: process.env, version: "0.0.0-test", log, ring: (c) => ring(c), unsent: (c) => unsentPersonRows(requests, c) });
	const server = await startPageServer({
		dir: loops,
		bind: { host: "127.0.0.1", port: 0 },
		allowHosts: [],
		token,
		version: "0.0.0-test",
		pool,
		sessions: { known: opts.known ?? ((id) => leases.read(id)) },
		log,
		onListenError: (err) => log(`listen: ${err.message}`),
	});
	const stop = async () => {
		server.close();
		await pool.stopAll();
	};
	let child: PageChild;
	try {
		child = await pool.open({ cwd: process.cwd(), piArgs: [], ...opts.open });
		const named = opts.named;
		if (named !== undefined) assert.ok(await until(() => pool.keyOf(child) === named), `pi said it is in ${named}; the pool has it as ${pool.keyOf(child)}`);
	} catch (err) {
		await stop();
		throw err;
	}
	const root = server.url();
	const url = `${root}c/${encodeURIComponent(pool.keyOf(child) ?? opts.open?.sessionId ?? `new-${child.pid}`)}/`;
	const post = async (p: string, b: unknown) => (await (await fetch(`${url}${p}`, { method: "POST", headers: { "x-pi-web-token": token, "content-type": "application/json" }, body: JSON.stringify(b) })).json()) as any;
	const state = async () => (await (await fetch(`${url}state?token=${token}`)).json()) as any;
	return { url, root, token, pool, child, logs, post, state, stop };
}

/** A key for one address under `url`, minted the way the page mints one. */
async function keyFor(url: string, token: string, kind: "events" | "file" | "preview", keyPath?: string): Promise<string> {
	const r = (await (await fetch(`${url}key`, { method: "POST", headers: { "x-pi-web-token": token, "content-type": "application/json" }, body: JSON.stringify({ for: kind, path: keyPath }) })).json()) as any;
	if (typeof r.key !== "string") throw new Error(`no key: ${JSON.stringify(r)}`);
	return r.key;
}

/** The conversation's event stream, with a key for it. */
const eventsAt = async (url: string, token: string) => `${url}events?key=${await keyFor(url, token, "events")}`;

test("a pi that refuses to start leaves the server answering, and its page says why", { timeout: 30_000 }, async () => {
	// The real case: two copies of an extension installed, so pi exits before answering anything.
	// Writing to its closed stdin used to end the front end with an unhandled EPIPE, which left a
	// browser tab pointing at nothing and the reason only in a terminal.
	const dir = tmp("pi-loops-web-");
	const sessionFile = path.join(dir, "s1.jsonl");
	const uncaught: unknown[] = [];
	const onUncaught = (err: unknown) => void uncaught.push(err);
	process.on("uncaughtException", onUncaught);
	process.on("unhandledRejection", onUncaught);
	const web = await startWeb(dir, '#!/bin/sh\necho \'Error: Tool "cron_create" conflicts with /somewhere/else\' >&2\nexit 1\n', {
		open: { sessionId: "s1", sessionFile },
		known: (id) => (id === "s1" ? { cwd: dir, sessionFile } : undefined),
	});
	try {
		// Each visit starts it again until the crash budget is spent; the visit after that gets the reason.
		let page = { status: 0, text: "" };
		for (let i = 0; i < 6 && page.status !== 503; i++) {
			assert.ok(await until(() => !web.pool.has("s1")), "pi exited");
			const r = await fetch(web.url, { headers: { "x-pi-web-token": web.token } });
			page = { status: r.status, text: await r.text() };
		}
		assert.equal(page.status, 503, `the page stops starting it; got:\n${page.text}`);
		assert.match(page.text, /Tool &quot;cron_create&quot; conflicts with \/somewhere\/else/, "pi's reason reaches the page");
		assert.equal((await fetch(`${web.root}manifest.webmanifest`)).status, 200, "and the server is still answering");
		assert.deepEqual(uncaught, [], "nothing escaped to the process");
	} finally {
		await web.stop();
		process.off("uncaughtException", onUncaught);
		process.off("unhandledRejection", onUncaught);
	}
});

test("a pi that starts is served, and one visit is enough for that browser", { timeout: 30_000 }, async () => {
	// `sleep` stands in for a pi that is up but has nothing to say: enough to prove the server binds
	// and answers, without a model call.
	const dir = tmp("pi-loops-web-");
	const web = await startWeb(dir, "#!/bin/sh\nsleep 8\n");
	try {
		const bare = web.url;
		// Read from where the token lives, which is also the address a person would rebuild from.
		const token = fs.readFileSync(path.join(dir, "loops", "web-token"), "utf8").trim();
		const url = `${bare}?token=${token}`;

		// A browser that has never been here is turned away — and told what to do about it, because a
		// bare "bad token" in a tab you opened from a bookmark is a dead end.
		let fetchError: unknown;
		const cold = await fetch(bare).catch((e) => {
			fetchError = e;
			return undefined;
		});
		assert.equal(cold?.status, 403, `the page needs the token, even from localhost${fetchError ? ` (${fetchError})` : ""}`);
		// As long as the token in characters, one byte longer: the compare used to throw, and the server with it.
		const sneaky = `%C3%A9${token.slice(1)}`;
		assert.equal((await fetch(`${bare}?token=${sneaky}`)).status, 403, "a token of the wrong byte length is refused");
		assert.equal((await fetch(bare)).status, 403, "and the server is still answering");
		assert.match(await (cold as Response).text(), /pi-loops/, "and says how to get in");

		// The visit that carries the token pairs the browser: a device cookie, never the token...
		const withToken = await fetch(url);
		assert.equal(withToken.status, 200);
		const cookie = withToken.headers.get("set-cookie") ?? "";
		assert.match(cookie, /^pi_web_device=[0-9a-f]{32};/, "the visit leaves a device cookie");
		assert.equal(cookie.includes(token), false, "with no token in it");
		assert.match(cookie, /SameSite=Strict/i, "which no other site can make the browser send");
		assert.match(cookie, /HttpOnly/i);

		// ...and after it, the address to remember has nothing in it.
		const warm = await fetch(bare, { headers: { cookie: cookie.split(";")[0] } });
		assert.equal(warm.status, 200, "the bare address works from then on");
		assert.equal((await warm.text()).includes(token), false, "and the page it serves has no token in it");
	} finally {
		await web.stop();
	}
});

test("the token outlives the server, so the address does not change", { timeout: 30_000 }, async () => {
	// Two starts sharing one loops directory: a bookmark taken from the first has to work on the
	// second, which is the whole reason the token is a file rather than a fresh random per run.
	const dir = tmp("pi-loops-web-");
	const file = path.join(dir, "loops", "web-token");
	const token = async () => {
		const web = await startWeb(dir, "#!/bin/sh\nsleep 2\n");
		try {
			assert.equal((await fetch(`${web.url}?token=${fs.readFileSync(file, "utf8").trim()}`)).status, 200, "the server takes the token in the file");
			return web.token;
		} finally {
			await web.stop();
		}
	};
	const first = await token();
	assert.match(first, /^[0-9a-f]{32}$/, "the first start made a token");
	assert.equal(await token(), first, "and the second start uses the same one");
	assert.equal(fs.statSync(file).mode & 0o777, 0o600, "readable by nobody else");

	// And a file that came back from a backup at 0644 is tightened rather than trusted as it is.
	fs.chmodSync(file, 0o644);
	await token();
	assert.equal(fs.statSync(file).mode & 0o777, 0o600, "a loose mode is fixed on the next start");
});

test("the first 0.24 start replaces a token an earlier version wrote, once", () => {
	// 0.22.8 kept its web-token in a cookie every port on 127.0.0.1 receives for a year, so a token
	// from before 0.24 is replaced once, and the marker beside it says that has happened.
	const loops = path.join(tmp("pi-loops-web-token-"), "loops");
	fs.mkdirSync(loops, { recursive: true });
	const file = path.join(loops, "web-token");
	const marker = path.join(loops, "web-token.v024");
	const fail = (message: string): never => {
		throw new Error(message);
	};
	const old = "0228aaaabbbbccccddddeeeeffff0000";
	fs.writeFileSync(file, `${old}\n`, { mode: 0o600 });
	const first = webToken(loops, fail);
	assert.notEqual(first, old, "the 0.22.8 token is not kept");
	assert.match(first, /^[0-9a-f]{32}$/);
	assert.equal(fs.readFileSync(file, "utf8").trim(), first, "the new token is the one in the file");
	assert.ok(fs.existsSync(marker), "and the marker is written");
	assert.equal(fs.statSync(marker).mode & 0o777, 0o600);
	assert.equal(webToken(loops, fail), first, "a second start keeps the new token");

	// A token the person writes after that is theirs to keep, as docs/configuration.md says.
	fs.writeFileSync(file, "my-own-token-1234\n", { mode: 0o600 });
	assert.equal(webToken(loops, fail), "my-own-token-1234");

	// No token at all: both are written, and the next start keeps what this one made.
	const fresh = path.join(tmp("pi-loops-web-token-"), "loops");
	const made = webToken(fresh, fail);
	assert.ok(fs.existsSync(path.join(fresh, "web-token.v024")));
	assert.equal(webToken(fresh, fail), made);

	// A symlink in its place still fails as before, marker or not.
	fs.rmSync(file);
	fs.symlinkSync(path.join(fresh, "web-token"), file);
	assert.throws(() => webToken(loops, fail), /is not a regular file/);
	fs.rmSync(marker);
	assert.throws(() => webToken(loops, fail), /is not a regular file/, "and the rotation does not write through it");
	assert.equal(fs.readFileSync(path.join(fresh, "web-token"), "utf8").trim(), made, "the file it points at is untouched");
});

test("a marker that is a symlink is not written through", () => {
	const loops = path.join(tmp("pi-loops-web-token-"), "loops");
	fs.mkdirSync(loops, { recursive: true });
	const target = path.join(tmp("pi-loops-web-token-"), "someone-elses-choice");
	fs.symlinkSync(target, path.join(loops, "web-token.v024"));
	const token = path.join(loops, "web-token");
	fs.writeFileSync(token, "0228aaaabbbbccccddddeeeeffff0000\n", { mode: 0o600 });
	const fail = (message: string): never => {
		throw new Error(message);
	};
	for (let i = 0; i < 2; i++) {
		assert.throws(() => webToken(loops, fail), /web-token\.v024 is not a regular file/);
		// It used to write a new token first and fail after, so every start changed the token.
		assert.equal(fs.readFileSync(token, "utf8").trim(), "0228aaaabbbbccccddddeeeeffff0000", "the token is not rotated under a marker it cannot read");
	}
	assert.equal(fs.existsSync(path.join(loops, "web-token.lock")), false, "and the refusal leaves no lock to hold the next start");
	assert.equal(fs.existsSync(target), false, "nothing was created where the link points");
});

test("two first starts at once both come up, on the one token the file holds", async () => {
	const loops = path.join(tmp("pi-loops-web-token-"), "loops");
	fs.mkdirSync(loops, { recursive: true });
	fs.writeFileSync(path.join(loops, "web-token"), "0228aaaabbbbccccddddeeeeffff0000\n", { mode: 0o600 });
	const src = pathToFileURL(path.join(process.cwd(), "src", "page-server.ts")).href;
	const script = `import { webToken } from ${JSON.stringify(src)}; process.stdout.write(webToken(${JSON.stringify(loops)}, (m) => { process.stderr.write(m); process.exit(1); }));`;
	const run = () =>
		new Promise<{ code: number | null; out: string }>((resolve) => {
			const child = spawn(process.execPath, ["--import", path.join(process.cwd(), "src", "register-pi.mjs"), "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
			let out = "";
			child.stdout.on("data", (d) => (out += d));
			child.on("exit", (code) => resolve({ code, out }));
		});
	const results = await Promise.all(Array.from({ length: 4 }, run));
	assert.deepEqual(results.map((r) => r.code), [0, 0, 0, 0], "none exits on the marker");
	const tokens = new Set(results.map((r) => r.out));
	assert.equal(tokens.size, 1, `one token: ${[...tokens].join(", ")}`);
	assert.equal(fs.readFileSync(path.join(loops, "web-token"), "utf8").trim(), [...tokens][0], "and it is the one in the file");
	assert.notEqual([...tokens][0], "0228aaaabbbbccccddddeeeeffff0000");
});

test("a token file another user owns still fails, before and after the rotation", () => {
	const loops = path.join(tmp("pi-loops-web-token-"), "loops");
	fs.mkdirSync(loops, { recursive: true });
	fs.writeFileSync(path.join(loops, "web-token"), "0228aaaabbbbccccddddeeeeffff0000\n", { mode: 0o600 });
	const fail = (message: string): never => {
		throw new Error(message);
	};
	const getuid = process.getuid;
	process.getuid = () => (getuid ? getuid() : 0) + 1;
	try {
		assert.throws(() => webToken(loops, fail), /belongs to another user/);
		fs.writeFileSync(path.join(loops, "web-token.v024"), "");
		assert.throws(() => webToken(loops, fail), /belongs to another user/);
	} finally {
		process.getuid = getuid;
	}
	assert.equal(fs.readFileSync(path.join(loops, "web-token"), "utf8").trim(), "0228aaaabbbbccccddddeeeeffff0000", "nothing was rewritten");
});

/** The event stream as the page reads it, until pi's exit has been told or `capMs` has passed. */
function eventsUntilExit(url: string, capMs = 8000): Promise<string> {
	return new Promise((resolve) => {
		let raw = "";
		const done = () => {
			clearTimeout(cap);
			req.destroy();
			resolve(raw);
		};
		const cap = setTimeout(done, capMs);
		const req = http.get(url, (res) => {
			res.on("data", (d) => {
				raw += d.toString();
				if (/"pi_exit".*\n/.test(raw)) done();
			});
			res.on("end", done);
			res.on("error", done);
		});
		req.on("error", done);
	});
}

/**
 * Read an SSE stream until nothing has arrived for `quietMs`, then hand back every `data:` event.
 * Waiting for the stream to go quiet rather than for an expected count is the point: a reader that
 * stopped at the number a passing test expects would call an unbounded replay correct.
 */
function replayEvents(url: string, quietMs = 400, capMs = 10_000): Promise<any[]> {
	return new Promise((resolve) => {
		const events: any[] = [];
		let buf = "";
		let req: http.ClientRequest | undefined;
		let quiet: NodeJS.Timeout | undefined;
		let hard: NodeJS.Timeout | undefined;
		const done = () => {
			clearTimeout(quiet);
			clearTimeout(hard);
			req?.destroy();
			resolve(events);
		};
		hard = setTimeout(done, capMs);
		req = http.get(url, (res) => {
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				buf += chunk;
				let nl;
				while ((nl = buf.indexOf("\n")) !== -1) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					if (line.startsWith("data: ")) {
						try {
							events.push(JSON.parse(line.slice(6)));
						} catch {
							// the server writes one event per write, so this reader never sees a torn line
						}
					}
				}
				clearTimeout(quiet);
				quiet = setTimeout(done, quietMs);
			});
		});
		req.on("error", done);
	});
}

test("a request line that is not a URL is answered 400, and the front end keeps serving", { timeout: 30_000 }, async () => {
	// `GET //[` made `new URL` throw outside the handler's try, and the unhandled rejection ended it.
	const dir = tmp("pi-loops-web-");
	const web = await startWeb(dir, "#!/bin/sh\nsleep 8\n");
	try {
		const { url, token } = web;
		const { port } = new URL(url);
		const raw = await new Promise<string>((resolve, reject) => {
			const sock = net.connect(Number(port), "127.0.0.1", () => sock.end("GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"));
			let got = "";
			sock.on("data", (d) => (got += d));
			sock.on("end", () => resolve(got));
			sock.on("error", reject);
		});
		assert.match(raw, /^HTTP\/1\.1 400/);
		assert.equal((await fetch(`${url}?token=${token}`)).status, 200, "still serving");
	} finally {
		await web.stop();
	}
});

test("a request another site started is refused, token or not", { timeout: 30_000 }, async () => {
	// SameSite is scoped to the site, and a site ignores the port: any page served from
	// localhost:5173 — a dev server, or something with an XSS in it — is handed our cookies by the
	// browser and would otherwise be able to type into your session.
	const dir = tmp("pi-loops-web-");
	const web = await startWeb(dir, "#!/bin/sh\nsleep 8\n");
	try {
		const { url, token } = web;
		const port = new URL(url).port;

		for (const headers of [
			{ "sec-fetch-site": "cross-site" },
			{ "sec-fetch-site": "same-site" },
			{ origin: "http://localhost:5173" },
		]) {
			const r = await fetch(url, { headers: { ...headers, "x-pi-web-token": token } });
			assert.equal(r.status, 403, `refused ${JSON.stringify(headers)}`);
		}
		// The page's own requests say the same thing about themselves and are let through.
		const ok = await fetch(url, { headers: { "sec-fetch-site": "same-origin", origin: `http://127.0.0.1:${port}`, "x-pi-web-token": token } });
		assert.equal(ok.status, 200, "its own page still works");
	} finally {
		await web.stop();
	}
});

test("a phone gets in with the six-digit code, and the page is installable", { timeout: 30_000 }, async () => {
	const dir = tmp("pi-loops-web-");
	const web = await startWeb(dir, "#!/bin/sh\nsleep 8\n");
	try {
		const { url, root, token } = web;
		// The code is printed on a terminal, and this is not one — so ask for one the way a browser
		// that is already signed in would.
		const minted = await fetch(`${root}pair`, { method: "POST", headers: { "x-pi-web-token": token, "content-type": "application/json" } });
		const code = (await minted.json()).code as string;
		assert.match(code, /^\d{6}$/, "a code a screen keyboard can manage");

		// A guess that is not even the right shape is refused without a stack trace, and a wrong code
		// does not consume the right one.
		assert.equal((await fetch(`${url}?pair=ÿÿÿÿÿÿ`)).status, 403, "a multibyte guess is just wrong, not a 500");
		assert.equal((await fetch(`${url}?pair=${code === "000000" ? "111111" : "000000"}`)).status, 403);

		const paired = await fetch(`${url}?pair=${code}`);
		assert.equal(paired.status, 200, "the code lets that device in");
		assert.match(paired.headers.get("set-cookie") ?? "", /^pi_web_device=/, "and leaves it paired");
		// Single use: the same code a second time is nothing.
		assert.equal((await fetch(`${url}?pair=${code}`)).status, 403, "and is spent");

		// Closing the dialog retires the code rather than leaving a live grant armed and forgotten.
		const next = (await (await fetch(`${root}pair`, { method: "POST", headers: { "x-pi-web-token": token, "content-type": "application/json" } })).json()).code as string;
		await fetch(`${root}pair`, { method: "POST", headers: { "x-pi-web-token": token, "content-type": "application/json" }, body: JSON.stringify({ cancel: true }) });
		assert.equal((await fetch(`${url}?pair=${next}`)).status, 403, "a cancelled code is not a code");

		// And what a phone should be pointed at is the server's answer, not the page's guess.
		const minted2 = await (await fetch(`${root}pair`, { method: "POST", headers: { "x-pi-web-token": token, "content-type": "application/json" } })).json();
		assert.ok(minted2.expiresIn > 0, `a code says how long it lasts; got ${JSON.stringify(minted2)}`);
		assert.ok(Array.isArray(minted2.addresses), "and which addresses it would work on");

		// Installability is fetched without credentials by the browser, so it cannot sit behind the
		// token — and it carries nothing that needs to.
		const manifest = await fetch(`${root}manifest.webmanifest`);
		assert.equal(manifest.status, 200);
		assert.equal((await manifest.json()).display, "standalone", "so a phone opens it without browser chrome");
		assert.equal((await fetch(`${root}icon.svg`)).status, 200);
		// But not as a load/no-load bit for a page sweeping ports on this machine.
		assert.equal((await fetch(`${root}icon.svg`, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
	} finally {
		await web.stop();
	}
});

test("the transcript hand-off carries the number the events are counted from", { timeout: 30_000 }, async () => {
	// The browser replays /history and then joins the live stream; without a number to compare
	// against it has to guess which of the backlog it already has.
	const dir = tmp("pi-loops-web-");
	// This route asks pi for the transcript, so the stand-in has to answer rather than just sit there.
	const answering = [
		"#!/usr/bin/env node",
		'let buf = "";',
		'process.stdin.on("data", (d) => {',
		"  buf += d; let i;",
		'  while ((i = buf.indexOf("\\n")) !== -1) {',
		"    const line = buf.slice(0, i); buf = buf.slice(i + 1);",
		"    if (!line.trim()) continue;",
		"    let m; try { m = JSON.parse(line); } catch { continue; }",
		'    process.stdout.write(JSON.stringify({ type: "response", id: m.id, success: true, data: { messages: [] } }) + "\\n");',
		"  }",
		"});",
		"setInterval(() => {}, 1e9);",
		"",
	].join("\n");
	const web = await startWeb(dir, answering);
	try {
		const { url, token } = web;

		const hist = await (await fetch(`${url}history?token=${token}`)).json();
		assert.equal(typeof hist.seq, "number", "/history says where the event stream had got to");
	} finally {
		await web.stop();
	}
});

test("/state says whether the host is up from the host's own record, on every request", { timeout: 30_000 }, async () => {
	// The panel's host line came from the session's runtime snapshot, which is written at most once a
	// minute; it said "host not running" beside a running host. The record is read per request instead.
	const dir = tmp("pi-loops-web-");
	const loops = path.join(dir, "loops");
	fs.mkdirSync(loops, { recursive: true });
	const web = await startWeb(dir, chattyPi(dir, []));
	try {
		const { url, token } = web;
		const state = async () => (await (await fetch(`${url}state?token=${token}`)).json()) as any;

		assert.equal((await state()).automation.hostPid, undefined, "no record, no host");
		fs.writeFileSync(path.join(loops, "host-service.json"), JSON.stringify({ v: 1, pid: process.pid, startedAt: new Date().toISOString() }));
		assert.equal((await state()).automation.hostPid, process.pid, "a live host is seen at once");
		fs.rmSync(path.join(loops, "host-service.json"));
		assert.equal((await state()).automation.hostPid, undefined, "and one that went away is gone at once");
	} finally {
		await web.stop();
	}
});

test("the event backlog a late-joining browser replays is bounded", { timeout: 30_000 }, async () => {
	// docs/web-ui-parity.md: "the backlog a late-joining browser replays is bounded." The 800-event
	// cap in src/web.mjs had no test, so it could be deleted with the suite still green.
	const dir = tmp("pi-loops-web-");
	const said = Array.from({ length: 900 }, (_, i) => ({ type: "test_event", n: i }));
	const web = await startWeb(dir, chattyPi(dir, said));
	try {
		const { url, token } = web;
		const state = async () => (await (await fetch(`${url}state?token=${token}`)).json()) as any;

		// Wait for the burst to be read, then let it settle, so the number below is the last event and
		// the replay's first event is exactly 800 behind it.
		let seq = 0;
		for (const deadline = Date.now() + 6000; Date.now() < deadline; ) {
			seq = (await state()).seq;
			if (seq >= said.length) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		assert.ok(seq >= said.length, `every event was read; got ${seq}`);
		await new Promise((r) => setTimeout(r, 300));
		seq = (await state()).seq;

		const replayed = await replayEvents(await eventsAt(url, token));
		// Unbounded, this is all 900 and the first replayed event is seq 1.
		assert.equal(replayed.length, 800, "the replay is the cap, not the whole backlog");
		assert.equal(replayed[0].seq, seq - 800 + 1, "the oldest kept is the 800th-newest event");
		assert.equal(replayed.at(-1).seq, seq, "and the newest is still there");
	} finally {
		await web.stop();
	}
});

test("dialogs held for a browser that turns up are bounded, oldest first", { timeout: 30_000 }, async () => {
	// docs/web-ui-parity.md: the list held for a later browser "is bounded the way the event backlog
	// is." The 50-entry cap in src/web.mjs had no test, so it could be deleted with the suite green.
	const dir = tmp("pi-loops-web-");
	const asks = Array.from({ length: 60 }, (_, i) => ({ type: "extension_ui_request", id: `ask-${i}`, method: "confirm", title: `t${i}`, message: `m${i}` }));
	const web = await startWeb(dir, chattyPi(dir, asks));
	try {
		const { url, token } = web;

		let state: any = {};
		for (const deadline = Date.now() + 6000; Date.now() < deadline; ) {
			state = await (await fetch(`${url}state?token=${token}`)).json();
			if (state.seq >= asks.length) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		assert.ok(state.seq >= asks.length, `every dialog was asked; got ${state.seq}`);
		assert.equal(state.pendingAsks.length, 50, "the held list is capped");
		assert.deepEqual(state.pendingAsks.map((a: any) => a.id), asks.slice(-50).map((a) => a.id), "the oldest are the ones let go");
	} finally {
		await web.stop();
	}
});

test("a dialog pi times out is not offered again, and one replayed carries the time it has left", { timeout: 30_000 }, async () => {
	// pi answers a dialog with a `timeout` itself when it elapses and sends nothing to say so. Held
	// past that, the next browser drew a question whose answer reached nobody.
	const dir = tmp("pi-loops-web-");
	const asks = [
		{ type: "extension_ui_request", id: "timed", method: "confirm", title: "Allow this in a scheduled turn?", message: "m", timeout: 3000 },
		{ type: "extension_ui_request", id: "open", method: "confirm", title: "t", message: "m" },
	];
	const web = await startWeb(dir, chattyPi(dir, asks));
	try {
		const { url, token } = web;
		const state = async () => (await fetch(`${url}state?token=${token}`)).json();

		let first: any = {};
		for (const deadline = Date.now() + 2000; Date.now() < deadline; ) {
			first = await state();
			if (first.pendingAsks?.length === 2) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		assert.equal(first.pendingAsks?.length, 2, "both dialogs are held at first");
		await new Promise((r) => setTimeout(r, 500));
		const timed = (await state()).pendingAsks.find((a: any) => a.id === "timed");
		assert.ok(timed.timeout > 0 && timed.timeout <= 2500, `a replayed timed dialog carries what is left of its time; got ${timed.timeout}`);
		assert.equal("expiresAt" in timed, false, "the server's own clock stays on the server");
		await new Promise((r) => setTimeout(r, 2600));
		assert.deepEqual((await state()).pendingAsks.map((a: any) => a.id), ["open"], "the timed-out dialog is gone; the untimed one is still held");
		// A tab that reconnects replays the event stream: the expired dialog must not come back through it.
		const ac = new AbortController();
		const res = await fetch(await eventsAt(url, token), { signal: ac.signal });
		const reader = res.body!.getReader();
		let text = "";
		for (const deadline = Date.now() + 1000; Date.now() < deadline && !text.includes('"id":"open"'); ) text += new TextDecoder().decode((await reader.read()).value);
		ac.abort();
		assert.match(text, /"id":"open"/, "the dialog pi still waits on is replayed");
		assert.doesNotMatch(text, /"id":"timed"/, "an expired dialog is not replayed by the event stream");
	} finally {
		await web.stop();
	}
});

test("the event streams one server holds open are bounded", { timeout: 30_000 }, async () => {
	// src/web.mjs: "One person, a few tabs. An unbounded set is a way to run this process out of
	// memory." The 16-stream cap had no test, so it could be deleted with the suite still green.
	const dir = tmp("pi-loops-web-");
	const web = await startWeb(dir, "#!/bin/sh\nsleep 8\n");
	try {
		const { url, token } = web;

		const events = await eventsAt(url, token);
		const open = () => new Promise<http.IncomingMessage>((resolve, reject) => {
			const req = http.get(events, (res) => resolve(res));
			req.on("error", reject);
		});
		const held: http.IncomingMessage[] = [];
		try {
			for (let i = 0; i < 16; i++) held.push(await open());
			// The status comes from the response callback rather than a body. With the cap a 429 ends;
			// without it a 200 is a stream that never does, so waiting for it would hang instead of fail.
			const seventeenth = await open();
			held.push(seventeenth);
			assert.equal(seventeenth.statusCode, 429, "the 17th stream is refused");
		} finally {
			for (const res of held) res.destroy();
		}
	} finally {
		await web.stop();
	}
});

test("the previews held for open tabs are bounded, newest first", { timeout: 30_000 }, async () => {
	// src/web.mjs: "Eight, because a preview is a tab you have open right now, and nobody has more
	// of those than that." The PREVIEW_KEEP cap had no test, so it could be deleted with the suite green.
	const dir = tmp("pi-loops-web-");
	const web = await startWeb(dir, "#!/bin/sh\nsleep 8\n");
	try {
		const { root, token } = web;

		const ids: string[] = [];
		for (let i = 0; i < 9; i++) {
			const made = await fetch(`${root}preview`, { method: "POST", headers: { "x-pi-web-token": token, "content-type": "application/json" }, body: JSON.stringify({ html: `<!doctype html><h1>${i}</h1>` }) });
			assert.equal(made.status, 200);
			ids.push(((await made.json()) as any).id);
		}
		assert.equal((await fetch(`${root}preview/${ids[0]}?key=${await keyFor(web.url, token, "preview", ids[0])}`)).status, 404, "the oldest preview is let go");
		assert.equal((await fetch(`${root}preview/${ids[7]}?key=${await keyFor(web.url, token, "preview", ids[7])}`)).status, 200, "the newest eight are kept");
	} finally {
		await web.stop();
	}
});

test("a file the session made can be looked at, and nothing else can", { timeout: 30_000 }, async () => {
	const dir = tmp("pi-loops-web-");
	const work = tmp("pi-loops-work-");
	fs.writeFileSync(path.join(work, "chart.png"), Buffer.from("89504e470d0a1a0a", "hex"));
	fs.writeFileSync(path.join(work, "report.html"), "<h1>hi</h1>");
	fs.writeFileSync(path.join(work, "secrets"), "no extension, not previewable");
	// The stand-in reports `work` as the session's directory, which is what the route anchors to.
	const answering = [
		"#!/usr/bin/env node",
		'let buf = "";',
		'process.stdin.on("data", (d) => {',
		"  buf += d; let i;",
		'  while ((i = buf.indexOf("\\n")) !== -1) {',
		"    const line = buf.slice(0, i); buf = buf.slice(i + 1);",
		"    if (!line.trim()) continue;",
		"    let m; try { m = JSON.parse(line); } catch { continue; }",
		`    const data = m.type === "get_state" ? { cwd: ${JSON.stringify(work)} } : { messages: [] };`,
		'    process.stdout.write(JSON.stringify({ type: "response", id: m.id, success: true, data }) + "\\n");',
		"  }",
		"});",
		"setInterval(() => {}, 1e9);",
		"",
	].join("\n");
	const web = await startWeb(dir, answering);
	try {
		const { url, token } = web;
		// The route anchors to the session directory, which it learns from pi when the page asks.
		await fetch(`${url}state?token=${token}`);
		const get = async (p: string) => fetch(`${url}file?path=${encodeURIComponent(p)}&key=${await keyFor(url, token, "file", p)}`);

		const png = await get("chart.png");
		assert.equal(png.status, 200, "a file it made");
		assert.equal(png.headers.get("content-type"), "image/png");

		const html = await get("report.html");
		assert.equal(html.status, 200);
		// A page the model wrote is something to look at, not something to act with: an opaque origin
		// means its own requests are cross-site, which this server refuses.
		const csp = html.headers.get("content-security-policy") ?? "";
		assert.match(csp, /sandbox/);
		// And it may not carry what it can see anywhere else.
		assert.match(csp, /default-src 'none'/, "a preview does not get to fetch");
		assert.equal(html.headers.get("x-content-type-options"), "nosniff");

		// The home directory is a root too — an agent asked to make something for a person puts it where
		// a person keeps things — but only the parts of it nobody hides a secret in.
		const home = os.homedir();
		const scratch = path.join(home, "_pi_loops_preview_probe.txt");
		fs.writeFileSync(scratch, "visible");
		try {
			// .txt is a reading format, not a looking one: inside the project yes, outside no.
			assert.equal((await get(scratch)).status, 415, "text outside the project is not previewed");
			const shot = path.join(home, "_pi_loops_preview_probe.png");
			fs.writeFileSync(shot, Buffer.from("89504e470d0a1a0a", "hex"));
			try {
				assert.equal((await get(shot)).status, 200, "a picture in the home directory is");
				assert.equal((await get("~/_pi_loops_preview_probe.png")).status, 200, "by ~ as well");
			} finally {
				fs.rmSync(shot, { force: true });
			}
		} finally {
			fs.rmSync(scratch, { force: true });
		}
		// A link out of the visible part of a home directory is the way round the dot rule, so the rule
		// is applied to what the filesystem resolves to rather than to what was asked for.
		const hidden = path.join(home, ".pi_loops_probe_hidden");
		const link = path.join(home, "_pi_loops_probe_link");
		fs.mkdirSync(hidden, { recursive: true });
		fs.writeFileSync(path.join(hidden, "creds.json"), '{"private_key":"secret"}');
		fs.rmSync(link, { force: true });
		fs.symlinkSync(hidden, link);
		try {
			assert.equal((await get("~/_pi_loops_probe_link/creds.json")).status, 403, "a symlink is not a way past the dot rule");
		} finally {
			fs.rmSync(link, { force: true });
			fs.rmSync(hidden, { recursive: true, force: true });
		}

		// Outside the project, only what one looks at: a home directory holds service-account keys named
		// like ordinary JSON, and no one previews those.
		const key = path.join(home, "_pi_loops_probe_sa.json");
		fs.writeFileSync(key, '{"private_key":"secret"}');
		try {
			assert.equal((await get("~/_pi_loops_probe_sa.json")).status, 415, "json outside the project is not shown");
		} finally {
			fs.rmSync(key, { force: true });
		}

		assert.equal((await get("~/.ssh/id_rsa")).status, 403, "but nothing behind a dot");
		assert.equal((await get("~/.bashrc")).status, 403, "not even a harmless one");
		assert.equal((await get(path.join(dir, "loops", "ui.json"))).status, 403, "and not where the token lives");

		assert.equal((await get("../../etc/passwd")).status, 403, "not out of the directory");
		assert.equal((await get("/etc/passwd")).status, 403, "not by absolute path either");
		assert.equal((await get("secrets")).status, 415, "and not a kind of file this shows");
		assert.equal((await fetch(`${url}file?path=chart.png`)).status, 401, "and not without a key");
		assert.equal((await fetch(`${url}file?path=chart.png&token=${token}`)).status, 401, "which the token in the query is not");
	} finally {
		await web.stop();
	}
});

test("an @ mention is expanded from the session's directory, and one outside it is skipped", { timeout: 30_000 }, async () => {
	// The terminal expands `@path` before the model sees it; over rpc it arrives as the literal
	// characters, so the front end does it. Two things have to hold and neither had a test: the file
	// is read relative to the session's own directory — the same anchor `/file` uses, never a root the
	// browser supplies — and a mention that resolves outside it stays text rather than being read
	// into the prompt. The second is what keeps `@../anything` from being a file read.
	const dir = tmp("pi-loops-web-");
	const root = tmp("pi-loops-mention-");
	const work = path.join(root, "project");
	fs.mkdirSync(work);
	fs.writeFileSync(path.join(work, "probe.txt"), "hello from the project");
	fs.writeFileSync(path.join(root, "outside.txt"), "not yours to read");
	const current = writeSession(work, "01a0-mention", "the mention session", new Date());
	const log = path.join(dir, "sent.jsonl");
	const web = await startWeb(dir, sessionAwarePi(current, log, false, {}, ["pi-loops"]), { named: "s1" });
	try {
		const { url, token } = web;
		const post = async (p: string, b: unknown) => (await fetch(`${url}${p}`, { method: "POST", headers: { "x-pi-web-token": token, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
		const sent = () =>
			fs
				.readFileSync(log, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l));
		// Chat text is a request row in the loops directory, not an rpc prompt: the expansion is read back
		// from the row the session's pi is handed.
		const lastPrompt = () => lastRow(dir)?.payload?.text ?? "";

		// The page is told the session's directory and anchors to it, which is what `/state` is for.
		await fetch(`${url}state?token=${token}`);

		assert.equal(((await post("prompt", { text: "@probe.txt" })) as any).success, true);
		assert.equal(sent().some((m) => m.type === "prompt" && !String(m.message).startsWith("/pi-loops ring ")), false, "the text itself never goes over rpc");
		const inside = lastPrompt();
		assert.match(inside, /<file path="probe\.txt">/, `the mention became a file; got:\n${inside}`);
		assert.match(inside, /hello from the project/, "with the file's text in it");

		// `..` resolves outside the session's directory, so the mention is left exactly as typed.
		assert.equal(((await post("prompt", { text: "@../outside.txt" })) as any).success, true);
		const outside = lastPrompt();
		assert.equal(outside, "@../outside.txt", `a mention out of the project is not read; got:\n${outside}`);
		assert.doesNotMatch(outside, /not yours to read/, "and the file's text never enters the prompt");
	} finally {
		await web.stop();
	}
});

test("a session an extension switched to inside pi is followed: the page is told to reload", { timeout: 30_000 }, async () => {
	// `/inbox open` forks a run's transcript and switches pi to it. The page kept showing the old
	// conversation until someone reloaded it: only a switch the page asked for changed the epoch.
	const dir = tmp("pi-loops-web-");
	const work = tmp("pi-loops-switch-");
	const current = writeSession(work, "01a0-before", "the session before", new Date());
	const forked = writeSession(work, "01a0-forked", "the forked run", new Date());
	const log = path.join(dir, "sent.jsonl");
	const web = await startWeb(dir, sessionAwarePi(current, log, false, {}, ["switch-to"]), { named: "s1" });
	try {
		const { url, token } = web;
		const state = async () => (await (await fetch(`${url}state?token=${token}`)).json()) as any;

		const before = await state();
		assert.equal(before.sessionFile, current);
		await fetch(`${url}prompt`, { method: "POST", headers: { "x-pi-web-token": token, "content-type": "application/json" }, body: JSON.stringify({ text: `/switch-to ${forked}` }) });
		const after = await state();
		assert.equal(after.sessionFile, forked);
		assert.notEqual(after.epoch, before.epoch, "a new session is a new epoch, which is what makes the page reload");
		assert.equal((await state()).epoch, after.epoch, "and only once: the next poll sees the same session");
	} finally {
		await web.stop();
	}
});

/**
 * A stand-in pi whose session lives in a directory the test controls, recording every command it
 * was sent. Starting a session and going back to one are the two things that are only visible in
 * what reaches pi: the HTTP answer to both is the same "success".
 */
function sessionAwarePi(sessionFile: string, log: string, streaming = false, session: { entries?: unknown[]; leafId?: string } = {}, commands: string[] | { file: string } = [], pidFile?: string): string {
	return [
		"#!/usr/bin/env node",
		'const fs = require("node:fs");',
		// Its pid, for a test that writes a lease in this pi's name.
		...(pidFile ? [`fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`] : []),
		// The command list, fixed, or read from a file each time so a test can change it (as /reload does).
		`const commands = ${JSON.stringify(commands)};`,
		'const commandList = () => (Array.isArray(commands) ? commands : JSON.parse(fs.readFileSync(commands.file, "utf8")));',
		`let file = ${JSON.stringify(sessionFile)};`,
		// The model it says it is on, and what a `set_model` does to that answer: restoring a resumed
		// session's model is only visible in the two together.
		'let model = { provider: "p", id: "m" };',
		`const session = ${JSON.stringify(session)};`,
		'let buf = "";',
		'process.stdin.on("data", (d) => {',
		"  buf += d; let i;",
		'  while ((i = buf.indexOf("\\n")) !== -1) {',
		"    const line = buf.slice(0, i); buf = buf.slice(i + 1);",
		"    if (!line.trim()) continue;",
		"    let m; try { m = JSON.parse(line); } catch { continue; }",
		`    fs.appendFileSync(${JSON.stringify(log)}, line + "\\n");`,
		'    if (m.type === "switch_session") file = m.sessionPath;',
		// What `/inbox open` and `/session-import --resume` do: an extension switches the session from
		// inside pi, and nothing the front end sent asked for it.
		'    if (m.type === "prompt" && m.message.startsWith("/switch-to ")) file = m.message.slice("/switch-to ".length);',
		'    if (m.type === "set_model") model = { provider: m.provider, id: m.modelId };',
		"    const data =",
		`      m.type === "get_state" ? { cwd: ${JSON.stringify(path.dirname(sessionFile))}, sessionId: "s1", sessionFile: file, isStreaming: ${streaming}, model }`,
		'      : m.type === "get_commands" ? { commands: commandList().map((name) => ({ name, description: name + " does something", source: "extension" })) }',
		'      : m.type === "switch_session" ? { cancelled: false }',
		'      : m.type === "get_entries" ? { entries: session.entries ?? [], leafId: session.leafId }',
		'      : { messages: [] };',
		'    process.stdout.write(JSON.stringify({ type: "response", id: m.id, success: true, data }) + "\\n");',
		"  }",
		"});",
		"setInterval(() => {}, 1e9);",
		"",
	].join("\n");
}

/**
 * A stand-in pi that says `lines` the moment it starts and then answers requests, so a test can put
 * events or dialogs in front of the front end without a model. It reports `cwd` and nothing else.
 */
function chattyPi(dir: string, lines: unknown[]): string {
	return [
		"#!/usr/bin/env node",
		`for (const ev of ${JSON.stringify(lines)}) process.stdout.write(JSON.stringify(ev) + "\\n");`,
		'let buf = "";',
		'process.stdin.on("data", (d) => {',
		"  buf += d; let i;",
		'  while ((i = buf.indexOf("\\n")) !== -1) {',
		"    const line = buf.slice(0, i); buf = buf.slice(i + 1);",
		"    if (!line.trim()) continue;",
		"    let m; try { m = JSON.parse(line); } catch { continue; }",
		`    process.stdout.write(JSON.stringify({ type: "response", id: m.id, success: true, data: { cwd: ${JSON.stringify(dir)} } }) + "\\n");`,
		"  }",
		"});",
		"setInterval(() => {}, 1e9);",
		"",
	].join("\n");
}

/** The request rows the front end wrote for the fake pi's session `s1`, in file order. */
function rowsOf(dir: string): SessionRequest[] {
	return new RequestStore(path.join(dir, "loops")).list("s1");
}
const lastRow = (dir: string) => rowsOf(dir).at(-1);

/** One session file, written the way pi writes them: a header line, then entries. */
function writeSession(dir: string, id: string, first: string, when: Date): string {
	const file = path.join(dir, `${when.toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`);
	const stamp = when.toISOString();
	fs.writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id, timestamp: stamp, cwd: dir }),
			JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: stamp, message: { role: "user", content: [{ type: "text", text: first }] } }),
			JSON.stringify({ type: "message", id: "e2", parentId: "e1", timestamp: stamp, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
		].join("\n") + "\n",
	);
	fs.utimesSync(file, when, when);
	return file;
}

test("a new session is a path pi has not written yet, and going back is one it has", { timeout: 30_000 }, async () => {
	const dir = tmp("pi-loops-web-");
	const sessions = tmp("pi-loops-sessions-");
	const older = writeSession(sessions, "01a0-older", "the older conversation", new Date(Date.now() - 60_000));
	const current = writeSession(sessions, "01a0-current", "the one open now", new Date());
	const log = path.join(dir, "sent.jsonl");
	const web = await startWeb(dir, sessionAwarePi(current, log), { named: "s1" });
	try {
		const { url, token } = web;
		const get = async (p: string) => (await fetch(`${url}${p}?token=${token}`)).json();
		const post = async (p: string, b: unknown) => (await fetch(`${url}${p}`, { method: "POST", headers: { "x-pi-web-token": token, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
		const sent = () =>
			fs
				.readFileSync(log, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l));

		// The list is this project's sessions, newest first, and says which one you are in — which is
		// also the one it will not offer, because pi answers a switch to the file it is already writing
		// by starting an empty session pointed at it.
		const list = (await get("sessions")) as any;
		assert.deepEqual(
			list.sessions.map((s: any) => [path.basename(s.file), s.current]),
			[
				[path.basename(current), true],
				[path.basename(older), false],
			],
			"newest first, with the open one marked",
		);
		assert.equal(list.sessions[1].first, "the older conversation", "a session is recognised by what was said in it");
		assert.equal(list.sessions[1].messages, 2);

		const before = (await get("state")) as any;
		const startedNew = (await post("session/new", {})) as any;
		assert.equal(startedNew.success, true, `starting one worked; got ${JSON.stringify(startedNew)}`);
		const asked = sent().filter((m) => m.type === "switch_session");
		assert.equal(asked.length, 1);
		assert.equal(path.dirname(asked[0].sessionPath), sessions, "a new session goes where pi keeps this project's");
		assert.match(path.basename(asked[0].sessionPath), /^[\d-]+T[\d-]+Z_[0-9a-f-]{36}\.jsonl$/, "named the way pi names them");
		assert.equal(fs.existsSync(asked[0].sessionPath), false, "and is a path, not a file: pi writes it at the first message");

		// A different session is a different sequence of events; the page is told by the epoch changing,
		// and reloads the conversation rather than drawing the new one under the old one's numbering.
		const after = (await get("state")) as any;
		assert.notEqual(after.epoch, before.epoch, "the event epoch turns over");

		// Going back to one it does have. The path has to be one of this project's sessions: a path from
		// a browser is not a reason to open a file anywhere on the disk.
		assert.equal(((await post("session/switch", { file: older })) as any).success, true);
		assert.equal(sent().filter((m) => m.type === "switch_session").pop().sessionPath, older);
		const outside = (await post("session/switch", { file: "/etc/passwd" })) as any;
		assert.equal(outside.success, false, "and nothing else is");
		assert.match(outside.error, /no session of this project/);
	} finally {
		await web.stop();
	}
});

test("the run button sends pi the job's run command, and refuses an id it cannot use", { timeout: 30_000 }, async () => {
	/**
	 * The panel's run button posts a job id; the route turns it into the command pi runs. A changed
	 * mapping would have the button run the wrong thing, or nothing, with every other test green.
	 * The stop button's route is pinned here too: it is the one way to cancel a turn from the page.
	 */
	const dir = tmp("pi-loops-web-");
	const sessions = tmp("pi-loops-sessions-");
	const current = writeSession(sessions, "01a0-current", "the one open now", new Date());
	const log = path.join(dir, "sent.jsonl");
	const web = await startWeb(dir, sessionAwarePi(current, log), { named: "s1" });
	try {
		const { url, token } = web;
		const post = async (p: string, b: unknown) => {
			const res = await fetch(`${url}${p}`, { method: "POST", headers: { "x-pi-web-token": token, "content-type": "application/json" }, body: JSON.stringify(b) });
			return { status: res.status, body: (await res.json()) as any };
		};
		const prompts = () =>
			fs
				.readFileSync(log, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
				.filter((m) => m.type === "prompt")
				.map((m) => m.message);

		const ran = await post("trigger/immediate", { id: "cron-abc123" });
		assert.equal(ran.body.success, true, `a job id runs; got ${JSON.stringify(ran.body)}`);
		assert.deepEqual(prompts(), ["/cron run cron-abc123"]);

		const bad = await post("trigger/immediate", { id: "a b" });
		assert.deepEqual([bad.status, bad.body], [400, { success: false, error: "bad id" }]);
		assert.deepEqual(prompts(), ["/cron run cron-abc123"], "a refused id reaches pi as nothing");

		// No card sends a rule id (rule cards have no run button); the branch is reached only by a
		// request made directly, and it still has to name the rule's own command.
		await post("trigger/immediate", { id: "dyn-00000000000000000000000000000000" });
		assert.deepEqual(prompts().pop(), "/triggers run dyn-00000000000000000000000000000000");

		await post("abort", {});
		assert.ok(
			fs.readFileSync(log, "utf8").split("\n").filter(Boolean).some((l) => JSON.parse(l).type === "abort"),
			"the stop button's route reaches pi as an abort",
		);
	} finally {
		await web.stop();
	}
});

test("the sessions list counts a long multi-byte session as truncated", { timeout: 30_000 }, async () => {
	// The window is 64 KB of bytes; comparing decoded UTF-16 units instead made a long CJK session
	// read as complete, and the resume picker printed a floor as an exact message count.
	const dir = tmp("pi-loops-web-");
	const sessions = tmp("pi-loops-sessions-");
	const current = writeSession(sessions, "01a0-current", "the one open now", new Date());
	const wide = path.join(sessions, "01a0-wide.jsonl");
	const lines = [JSON.stringify({ type: "session", version: 3, id: "01a0-wide", timestamp: new Date(0).toISOString(), cwd: sessions })];
	for (let i = 0; i < 3000; i++) lines.push(JSON.stringify({ type: "message", id: `m${i}`, message: { role: "user", content: "漢".repeat(30) } }));
	fs.writeFileSync(wide, lines.join("\n") + "\n");
	assert.ok(fs.statSync(wide).size > 64 * 1024, "the file is past the window in bytes");
	const web = await startWeb(dir, sessionAwarePi(current, path.join(dir, "sent.jsonl")), { named: "s1" });
	try {
		const { url, token } = web;
		const list = (await (await fetch(`${url}sessions?token=${token}`)).json()) as any;
		const entry = list.sessions.find((s: any) => path.basename(s.file) === "01a0-wide.jsonl");
		assert.ok(entry, `the long session is listed; got ${JSON.stringify(list.sessions)}`);
		assert.equal(entry.truncated, true, "the window is bytes, so a CJK session past it is a floor");
	} finally {
		await web.stop();
	}
});

test("a session is not swapped out from under a turn that is running", { timeout: 30_000 }, async () => {
	// The swap aborts the turn. Finding that out afterwards, having lost the reply you were waiting
	// for, is the failure this refusal exists to prevent — and it is here rather than only in the
	// page so that a tab left open across an upgrade cannot skip it.
	const dir = tmp("pi-loops-web-");
	const sessions = tmp("pi-loops-sessions-");
	const current = writeSession(sessions, "01a0-busy", "mid turn", new Date());
	const web = await startWeb(dir, sessionAwarePi(current, path.join(dir, "sent.jsonl"), true), { named: "s1" });
	try {
		const { url, token } = web;
		const answer = await (await fetch(`${url}session/new`, { method: "POST", headers: { "x-pi-web-token": token, "content-type": "application/json" }, body: "{}" })).json();
		assert.equal(answer.success, false);
		assert.match(answer.error, /a turn is running/);
	} finally {
		await web.stop();
	}
});

test("a command typed while a turn is running reaches pi as one it can run", { timeout: 30_000 }, async () => {
	// Answering "busy" with pi's `follow_up` command refused every extension command, in pi's own
	// words — `Extension command "/inbox" cannot be queued. Use prompt() or execute the command when
	// not streaming.` — while the same line typed into the terminal ran at once. `prompt` with a
	// streamingBehavior is the one command that carries both halves: an extension command runs
	// immediately, ordinary text queues. That is the line docs/web-ui-parity.md promises.
	const dir = tmp("pi-loops-web-");
	const log = path.join(dir, "sent.jsonl");
	const web = await startWeb(dir, sessionAwarePi(path.join(dir, "s.jsonl"), log, true, {}, ["inbox", "pi-loops"]), { named: "s1" });
	try {
		const { url, token } = web;

		// A slash command the session has never heard of is refused before this route is reached, so
		// wait for the front end to have heard of this one rather than racing its startup.
		const completes = async () => (((await (await fetch(`${url}complete`, { method: "POST", headers: { "x-pi-web-token": token, "content-type": "application/json" }, body: JSON.stringify({ text: "/in" }) })).json()) as any).items ?? []) as any[];
		for (let i = 0; i < 60 && !(await completes()).some((c) => c.value === "/inbox"); i++) await new Promise((r) => setTimeout(r, 100));
		assert.ok((await completes()).some((c) => c.value === "/inbox"), "the front end knows /inbox, so it is sent rather than refused as a name it does not have");

		const send = async (body: unknown) => (await (await fetch(`${url}prompt`, { method: "POST", headers: { "x-pi-web-token": token, "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as any;
		assert.equal((await send({ text: "/inbox", mode: "follow_up" })).success, true, "a command sent while a turn is running is accepted");
		assert.equal((await send({ text: "/inbox" })).success, true, "so is one the page sent believing pi was idle");
		const carryOn = await send({ text: "carry on", mode: "follow_up" });
		assert.equal(carryOn.success, true, "ordinary text still goes through");

		// The ring is sent after /prompt has answered with the queued row: wait for it, bounded, so the
		// log is read once everything this test sent is in it.
		const sentNow = () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
		assert.ok(await until(() => sentNow().some((m) => m.type === "prompt" && String(m.message).startsWith("/pi-loops ring ")), 5000), "the ring reached pi");
		const sent = sentNow();
		const prompts = sent.filter((m) => m.type === "prompt" && m.message === "/inbox");
		assert.equal(prompts.length, 2, "both reached pi as prompts");
		assert.deepEqual(prompts.map((m) => m.streamingBehavior), ["followUp", "followUp"], "each asking pi to queue it if a turn is still running");
		assert.equal(sent.some((m) => m.type === "follow_up" || m.type === "steer"), false, "never as a command that refuses an extension command");
		// Ordinary text is a request row, queued in the file where Esc cannot drop it, and the bell is the
		// one rpc command it costs: `/pi-loops ring <id> <fingerprint>`, which the extension drains on.
		assert.equal(sent.some((m) => m.message === "carry on"), false, "the text itself is not an rpc prompt");
		const row = lastRow(dir);
		assert.equal(row?.payload?.text, "carry on");
		assert.deepEqual([row?.source, row?.mode, row?.wake, row?.id], ["person", "attended", "turn", carryOn.queued]);
		const ring = sent.find((m) => m.type === "prompt" && String(m.message).startsWith("/pi-loops ring "));
		assert.equal(ring?.message, `/pi-loops ring ${row.id} ${requestFingerprint(row)}`, "rung for, with the proof of who wrote it");
	} finally {
		await web.stop();
	}
});

test("the compact button can steer what the summary keeps", { timeout: 30_000 }, async () => {
	// `/compact <instructions>` in the terminal; the browser had no way to say it at all, and a
	// summary you cannot steer is one you undo by hand afterwards.
	const dir = tmp("pi-loops-web-");
	const log = path.join(dir, "sent.jsonl");
	const web = await startWeb(dir, sessionAwarePi(path.join(dir, "s.jsonl"), log), { named: "s1" });
	try {
		const { url, token } = web;
		await fetch(`${url}compact`, { method: "POST", headers: { "x-pi-web-token": token, "content-type": "application/json" }, body: JSON.stringify({ instructions: "keep the API shapes" }) });
		await fetch(`${url}compact`, { method: "POST", headers: { "x-pi-web-token": token, "content-type": "application/json" }, body: "{}" });
		const compactions = fs
			.readFileSync(log, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l))
			.filter((m) => m.type === "compact");
		assert.equal(compactions[0].customInstructions, "keep the API shapes", "what to keep reaches pi");
		assert.equal("customInstructions" in compactions[1], false, "and plain compaction stays plain");
	} finally {
		await web.stop();
	}
});

test("the panel and /cron agree about what this project is", { timeout: 30_000 }, async () => {
	// They did not. The panel compared strings and the extension resolved symlinks
	// (`withinProject`), so a project reached through a link — a worktree, a `~/code` pointing at a
	// mounted disk — was the same project to `/cron` and a different one to the page: the job was
	// listed in the terminal and missing from the panel, which reads as a job that is gone. And a
	// job whose cwd is $HOME was shown here under every project, which the terminal never does.
	const dir = tmp("pi-loops-web-");
	const real = tmp("pi-loops-real-");
	const project = path.join(real, "project");
	fs.mkdirSync(project, { recursive: true });
	const link = path.join(dir, "via-a-link");
	fs.symlinkSync(project, link);

	const loops = path.join(dir, "loops");
	fs.mkdirSync(loops, { recursive: true });
	const job = (id: string, cwd: string, skippedOverlap = 0) => ({
		id, schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "p", cwd,
		enabled: true, catchUp: true, createdAt: new Date().toISOString(), runCount: 0, skippedOverlap,
	});
	fs.writeFileSync(
		path.join(loops, "jobs.json"),
		JSON.stringify({ version: 2, jobs: [job("cron-linked", project, 3), job("cron-worktree-gone", path.join(link, "worktrees", "issue-42")), job("cron-home", os.homedir()), job("cron-elsewhere", path.join(real, "another"))] }),
	);
	// A rule somewhere else as well. The two counts are kept apart because the commands are: /cron
	// counts jobs and /triggers counts rules, so one number covering both matches neither of them.
	fs.writeFileSync(
		path.join(loops, "triggers.json"),
		JSON.stringify({ version: 1, rules: [{ id: "dyn-elsewhere", condition: "c", action: "a", enabled: true, cwd: path.join(real, "another") }] }),
	);

	// The stand-in reports the *link* as the session's directory, which is how a person reaches it.
	const answering = [
		"#!/usr/bin/env node",
		'let buf = "";',
		'process.stdin.on("data", (d) => {',
		"  buf += d; let i;",
		'  while ((i = buf.indexOf("\\n")) !== -1) {',
		"    const line = buf.slice(0, i); buf = buf.slice(i + 1);",
		"    if (!line.trim()) continue;",
		"    let m; try { m = JSON.parse(line); } catch { continue; }",
		`    const data = m.type === "get_state" ? { cwd: ${JSON.stringify(link)} } : { messages: [] };`,
		'    process.stdout.write(JSON.stringify({ type: "response", id: m.id, success: true, data }) + "\\n");',
		"  }",
		"});",
		"setInterval(() => {}, 1e9);",
		"",
	].join("\n");
	const web = await startWeb(dir, answering);
	try {
		const { url, token } = web;
		const state = (await (await fetch(`${url}state?token=${token}`)).json()) as any;
		const listed = state.automation.jobs.map((j: any) => j.id);

		// A job whose cwd is two levels below the deepest existing directory — a removed worktree — is
		// still this project's: the panel resolves as much of the path as exists, the way `/cron` does.
		// One level up was not enough, and this job was dropped into the other-projects count.
		assert.deepEqual(listed, ["cron-linked", "cron-worktree-gone"], `the linked project's jobs are this project's; got ${JSON.stringify(listed)}`);
		// The card shows the skipped-overlap count the terminal panel and `/cron` print. It leaves the
		// store on this same payload, so the page never has to work out a number the scheduler owns.
		assert.equal(state.automation.jobs.find((j: any) => j.id === "cron-linked")?.skippedOverlap, 3, "the panel is handed the skipped-overlap count the terminal prints");
		// `/cron` says `+ <all - here> loops in other projects`, counting jobs and nothing else; this is
		// the same subtraction, and the rules are their own number beside it rather than added in.
		assert.deepEqual(state.automation.elsewhere, { jobs: 2, rules: 1 }, "and what it cannot show is counted, jobs and rules apart");
	} finally {
		await web.stop();
	}
});

test("with nothing running loops, the panel promises no next run, says paused, and still shows the last check", { timeout: 30_000 }, async () => {
	// Loops run in the background now. Stopped, the panel kept showing "next 09:00" from next-runs.json
	// (a window writes it while no background process runs). A loop's runs are the activity strip's.
	const dir = tmp("pi-loops-web-");
	const project = tmp("pi-loops-proj-");
	const loops = path.join(dir, "loops");
	fs.mkdirSync(loops, { recursive: true });
	fs.writeFileSync(path.join(loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [{ id: "cron-a", name: "nightly", schedule: { kind: "every", ms: 3600_000 }, stateful: true, prompt: "p", cwd: project, enabled: true, catchUp: true, createdAt: new Date().toISOString(), runCount: 1, skippedOverlap: 0 }] }));
	fs.writeFileSync(path.join(loops, "next-runs.json"), JSON.stringify({ at: new Date().toISOString(), next: { "cron-a": new Date(Date.now() + 3600_000).toISOString() } }));
	const finished = new Date().toISOString();
	fs.writeFileSync(path.join(loops, "runs.jsonl"), JSON.stringify({ runId: "run-1", jobId: "cron-a", jobName: "nightly", stateful: true, cwd: project, pid: 1, startedAt: finished, finishedAt: finished, ok: true, findings: 2, droppedFindings: 0, stateUpdated: true }) + "\n");
	// A rule check's result, then a loop run's (which is not a check): the panel's "last check" is the first.
	fs.writeFileSync(path.join(loops, "triggers-audit.jsonl"), [
		{ ts: "2026-10-30T10:00:00.000+00:00", cwd: project, type: "trigger_result", traceId: "t1", state: "completed", sourceLabel: "local:dynamic", eventLabel: "periodic" },
		{ ts: "2026-10-30T10:05:00.000+00:00", cwd: project, type: "trigger_result", traceId: "run-1", state: "completed", sourceLabel: "Cron", eventLabel: "cron-a" },
	].map((r) => JSON.stringify(r)).join("\n") + "\n");
	const web = await startWeb(dir, chattyPi(project, []));
	try {
		const { url, token } = web;
		const a = ((await (await fetch(`${url}state?token=${token}`)).json()) as any).automation;
		const job = a.jobs.find((j: any) => j.id === "cron-a");
		assert.equal(job?.next, undefined, `no next run while nothing runs it; got ${JSON.stringify(job)}`);
		assert.match(job.asleep ?? "", /^paused: pi-loops is not running/);
		assert.equal(a.paused, "pi-loops is not running");
		assert.equal(a.lastRun, undefined, "the activity strip is the one place for runs");
		assert.deepEqual(a.lastCheck, { state: "completed", at: "2026-10-30T10:00:00.000+00:00" }, "rule checks run in the background: the panel reads the last one from the audit");
	} finally {
		await web.stop();
	}
});

test("this chat's own plain job runs in the window, so the panel does not call it paused", { timeout: 30_000 }, async () => {
	const dir = tmp("pi-loops-web-");
	const work = tmp("pi-loops-proj-");
	const loops = path.join(dir, "loops");
	fs.mkdirSync(loops, { recursive: true });
	const current = writeSession(work, "01a0-own", "the session", new Date());
	fs.writeFileSync(path.join(loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [{ id: "cron-p", schedule: { kind: "every", ms: 3600_000 }, stateful: false, prompt: "p", cwd: work, sessionId: "s1", enabled: true, catchUp: false, createdAt: new Date().toISOString(), runCount: 0, skippedOverlap: 0 }] }));
	const log = path.join(dir, "sent.jsonl");
	const web = await startWeb(dir, sessionAwarePi(current, log), { named: "s1" });
	try {
		const { url, token } = web;
		const a = ((await (await fetch(`${url}state?token=${token}`)).json()) as any).automation;
		assert.equal(a.paused, undefined, "nothing here waits for the background process");
		assert.equal(a.jobs[0].asleep, undefined, "and the job is this chat's own");
	} finally {
		await web.stop();
	}
});

test("the panel shows the next run of a cron-expression job, and never a time that has passed", { timeout: 30_000 }, async () => {
	// The page used to work this out itself and understood only `every <interval>`; a `0 9 * * *`
	// job showed nothing. It reads the scheduler's answers now — and refuses a stale one, because a
	// next run in the past is a job that fired before the file was rewritten, not a next run.
	const dir = tmp("pi-loops-web-");
	const project = tmp("pi-loops-proj-");
	const loops = path.join(dir, "loops");
	fs.mkdirSync(loops, { recursive: true });
	const job = (id: string) => ({
		id, schedule: { kind: "cron", expr: "0 9 * * *" }, stateful: true, prompt: "p", cwd: project,
		enabled: true, catchUp: true, createdAt: new Date().toISOString(), runCount: 0, skippedOverlap: 0,
	});
	fs.writeFileSync(path.join(loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [job("cron-soon"), job("cron-stale")] }));
	// A loop has a next run only while something runs it.
	fs.writeFileSync(path.join(loops, "host-service.json"), JSON.stringify({ v: 1, pid: process.pid, startedAt: new Date().toISOString() }));
	const soon = new Date(Date.now() + 3 * 3600_000).toISOString();
	fs.writeFileSync(
		path.join(loops, "next-runs.json"),
		JSON.stringify({ at: new Date().toISOString(), next: { "cron-soon": soon, "cron-stale": new Date(Date.now() - 60_000).toISOString() } }),
	);

	const answering = [
		"#!/usr/bin/env node",
		'let buf = "";',
		'process.stdin.on("data", (d) => {',
		"  buf += d; let i;",
		'  while ((i = buf.indexOf("\\n")) !== -1) {',
		"    const line = buf.slice(0, i); buf = buf.slice(i + 1);",
		"    if (!line.trim()) continue;",
		"    let m; try { m = JSON.parse(line); } catch { continue; }",
		`    const data = m.type === "get_state" ? { cwd: ${JSON.stringify(project)} } : { messages: [] };`,
		'    process.stdout.write(JSON.stringify({ type: "response", id: m.id, success: true, data }) + "\\n");',
		"  }",
		"});",
		"setInterval(() => {}, 1e9);",
		"",
	].join("\n");
	const web = await startWeb(dir, answering);
	try {
		const { url, token } = web;
		const state = (await (await fetch(`${url}state?token=${token}`)).json()) as any;
		const byId = Object.fromEntries(state.automation.jobs.map((j: any) => [j.id, j.next]));

		assert.equal(byId["cron-soon"], soon, "a cron expression now has a next run at all");
		assert.equal(byId["cron-stale"], undefined, "and a stale answer is shown as none rather than as a past time");
	} finally {
		await web.stop();
	}
});

test("a key in a job's prompt does not reach the page", { timeout: 30_000 }, async () => {
	// The panel now shows a job's whole prompt and last error, so a credential in either would travel
	// whole to every attached browser. The server masks them with the same shapes as the stderr tail
	// before /state leaves the process, and it must not fall back to the old ninety-character cut.
	const dir = tmp("pi-loops-web-");
	const project = tmp("pi-loops-proj-");
	const loops = path.join(dir, "loops");
	fs.mkdirSync(loops, { recursive: true });
	const key = "sk-" + "A".repeat(24);
	const err = "ghp_" + "B".repeat(36);
	const prompt = "a prompt longer than ninety characters, carrying " + key + " and a tail a slice would have dropped";
	fs.writeFileSync(path.join(loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [
		{ id: "cron-secret", name: "secret", schedule: { kind: "every", ms: 60000 }, stateful: true, prompt, cwd: project, enabled: true, catchUp: true, createdAt: new Date().toISOString(), runCount: 0, lastError: err },
	] }));

	const answering = [
		"#!/usr/bin/env node",
		'let buf = "";',
		'process.stdin.on("data", (d) => {',
		"  buf += d; let i;",
		'  while ((i = buf.indexOf("\\n")) !== -1) {',
		"    const line = buf.slice(0, i); buf = buf.slice(i + 1);",
		"    if (!line.trim()) continue;",
		"    let m; try { m = JSON.parse(line); } catch { continue; }",
		`    const data = m.type === "get_state" ? { cwd: ${JSON.stringify(project)} } : { messages: [] };`,
		'    process.stdout.write(JSON.stringify({ type: "response", id: m.id, success: true, data }) + "\\n");',
		"  }",
		"});",
		"setInterval(() => {}, 1e9);",
		"",
	].join("\n");
	const web = await startWeb(dir, answering);
	try {
		const { url, token } = web;
		const state = (await (await fetch(`${url}state?token=${token}`)).json()) as any;
		const job = state.automation.jobs.find((j: any) => j.id === "cron-secret");

		assert.ok(job, "the job reached /state");
		assert.equal(job.prompt.includes(key), false, "the key in the prompt is masked");
		assert.equal(job.lastError.includes(err), false, "and so is the one in the error");
		assert.match(job.prompt, /tail a slice would have dropped/, "and the prompt is whole, not cut at ninety");
	} finally {
		await web.stop();
	}
});

test("the escape hatch cannot be used to skip a route's own guards", { timeout: 30_000 }, async () => {
	// /rpc exists so anything in pi's protocol this front end has not grown a button for is still
	// reachable. It also made every guard optional: `{"type":"switch_session"}` posted here went
	// straight to pi, skipping the mid-turn refusal, the "one of this project's sessions" check and
	// the epoch/backlog/pending-dialog reset the attached browsers are owed.
	const dir = tmp("pi-loops-web-");
	const log = path.join(dir, "sent.jsonl");
	const web = await startWeb(dir, sessionAwarePi(path.join(dir, "s.jsonl"), log), { named: "s1" });
	try {
		const { url, token } = web;
		const rpc = async (body: unknown) => (await (await fetch(`${url}rpc`, { method: "POST", headers: { "x-pi-web-token": token, "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as any;

		for (const type of ["switch_session", "extension_ui_response", "prompt", "steer", "follow_up", "compact", "fork", "abort", "cycle_model", "cycle_thinking_level"]) {
			const answer = await rpc({ type, sessionPath: "/etc/passwd" });
			assert.equal(answer.success, false, `${type} is refused`);
			assert.equal(answer.error, `${type} has a route of its own`);
		}
		// `new_session` and `clone` swap the session behind the browsers' backs — no new epoch, no
		// backlog or pending-dialog reset, no catalog refresh, and the page never notices. Neither has a
		// route here, and neither should: a fresh session is `/switch_session`-shaped work.
		for (const type of ["new_session", "clone"]) {
			const answer = await rpc({ type });
			assert.equal(answer.success, false, `${type} is refused`);
			assert.match(answer.error, /would replace the session the attached browsers are watching/);
		}
		// And nothing of the sort reached pi. The fake pi appends to the log only when something reaches
		// it, and every request above was refused before that — so the log may not exist yet at all,
		// which is the strongest form of the same fact (it used to be read unconditionally, and failed
		// on exactly the runs where nothing had reached pi before this line).
		const sent = (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
		assert.equal(sent.some((m) => m.type === "switch_session"), false, "pi never saw the one that would have swapped the session");
		assert.equal(sent.some((m) => m.type === "new_session" || m.type === "clone"), false, "nor the two that would have replaced it");

		// What the hatch is for still works: a command with no route of its own goes through.
		assert.equal((await rpc({ type: "get_state" })).success, true, "a command this front end has no button for is still reachable");
	} finally {
		await web.stop();
	}
});

test("a signed-in browser reloading a stale pairing code does not spend a guess", { timeout: 30_000 }, async () => {
	// Twenty guesses is the whole of the pairing budget, and checking one spends it. That check used
	// to run before the cookie was looked at, so a signed-in tab reloading a bookmark that still
	// carried an old ?pair= burned a try each time — and twenty reloads left the phone in the next
	// room unable to get in at all, with nothing on screen to explain it.
	const dir = tmp("pi-loops-web-");
	const web = await startWeb(dir, "#!/bin/sh\nsleep 9\n");
	try {
		const { url, root, token } = web;
		const code = (await (await fetch(`${root}pair`, { method: "POST", headers: { "x-pi-web-token": token, "content-type": "application/json" } })).json()).code as string;
		const wrong = code === "000000" ? "111111" : "000000";

		// A browser that is already in, reloading an address that still has a wrong code on it.
		for (let i = 0; i < 25; i++) {
			const r = await fetch(`${url}?token=${token}&pair=${wrong}`);
			assert.equal(r.status, 200, "the token is what lets it in, and it still does");
		}
		// The code the phone is holding is still the code.
		assert.equal((await fetch(`${url}?pair=${code}`)).status, 200, "the pairing budget was never touched");
	} finally {
		await web.stop();
	}
});

test("a credential in pi's dying words does not reach the page", { timeout: 30_000 }, async () => {
	// A provider that refuses to authenticate is one of the commonest reasons pi exits at all, and
	// what it prints on the way out is the key it was refused with. That tail is broadcast to every
	// attached browser — so the one event whose whole job is to explain a failure was the one event
	// that could carry a secret out of this process.
	const dir = tmp("pi-loops-web-");
	const key = `sk-${"a".repeat(32)}`;
	const dying = `#!/bin/sh\nsleep 2\necho 'auth failed for ${key} (Bearer ${"b".repeat(24)})' >&2\nexit 1\n`;
	// pi's stderr is copied to this process's own, which is where the terminal that started it reads it.
	const own: string[] = [];
	const write = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array, ...rest: any[]) => {
		own.push(String(chunk));
		return write(chunk, ...rest);
	}) as typeof process.stderr.write;
	const web = await startWeb(dir, dying);
	try {
		const { url, token } = web;

		// A browser attached to the stream, the way the page is, waiting for whatever pi says last.
		const events = await eventsUntilExit(await eventsAt(url, token));

		assert.match(events, /pi_exit/, `the page is told pi went; got:\n${events.slice(-400)}`);
		assert.match(events, /auth failed/, "and told why, which is the point of the event");
		assert.doesNotMatch(events, /sk-aaaa/, "without the key it was refused with");
		assert.match(events, /\[REDACTED\]/, "masked rather than dropped, so the line still reads");
		// This process's stderr is host.log when pi-loops serves the page, a file on disk: the line
		// lands there masked, and the key it was refused with lands nowhere.
		assert.doesNotMatch(own.join(""), /sk-aaaa/, "the key is not written to this process's own stderr");
		assert.match(own.join(""), /auth failed for \[REDACTED\]/, "the masked line still says what went wrong");
	} finally {
		process.stderr.write = write;
		await web.stop();
	}
});

test("pi's dying words are cut by characters, and the cut says how much it dropped", { timeout: 30_000 }, async () => {
	// The server cut the tail to 4000 UTF-16 code units on the way out, so the page's own cap — which
	// counts characters and appends "… (N chars)" — could never fire: it was always handed 4000 code
	// units or fewer, and code points are never more numerous than code units. The cut counted units,
	// so it could also begin on the low half of an astral character, which the browser draws as a
	// replacement glyph where the error should start. docs/web-ui-parity.md:96-101.
	const dir = tmp("pi-loops-web-");
	// 5000 characters, 5001 code units, the rocket across the 4000-from-the-end boundary — where a cut
	// counted in code units begins on its low half. A tail longer than STDERR_KEEP would put the split
	// at the 8000-unit keep boundary, which the 4000-unit send cut then discards whole; this length
	// keeps it in the part that is actually served.
	const line = `${"z".repeat(1000)}🚀${"y".repeat(3999)}`;
	const web = await startWeb(dir, `#!/bin/sh\nsleep 2\nprintf '%s\\n' '${line}' >&2\nexit 1\n`);
	try {
		const { url, token } = web;

		// The event happens when pi dies, not before: `replayEvents` settles 400ms after the last data,
		// which is right for a backlog and wrong here. Read the stream the way the page does, then parse
		// the one line — JSON, because a lone surrogate is escaped on the wire and only reappears parsed.
		const raw = await eventsUntilExit(await eventsAt(url, token));
		const exitLine = raw
			.split("\n")
			.filter((l) => l.startsWith("data: ") && l.includes('"pi_exit"'))
			.pop();
		assert.ok(exitLine, `the page is told pi went; got:\n${raw.slice(-300)}`);
		const exit = JSON.parse(exitLine.slice(6));
		assert.ok(exit.stderr, "the event carries the tail");
		assert.match(exit.stderr, /chars dropped/, "the served tail says what it dropped, since the page's cap cannot");
		assert.doesNotMatch(exit.stderr, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, "and no cut lands on half a character");
		assert.ok(exit.stderr.length <= 4000, `still within what the page caps at, got ${exit.stderr.length}`);
	} finally {
		await web.stop();
	}
});

test("pi's dying words past the kept tail count everything dropped, and the kept tail is cut by characters", { timeout: 30_000 }, async () => {
	// 9000 rockets: 18 000 code units. The kept tail (8000) cut in code units left 4000 characters,
	// which went out whole with no marker and began on the low half of a rocket. The marker counted
	// only what it cut from the kept tail, so it said 4040 however much pi had written.
	const dir = tmp("pi-loops-web-");
	const web = await startWeb(dir, `#!/bin/sh\nsleep 2\nprintf '%s\\n' '${"🚀".repeat(9000)}' >&2\nexit 1\n`);
	try {
		const { url, token } = web;
		const raw = await eventsUntilExit(await eventsAt(url, token));
		const exitLine = raw
			.split("\n")
			.filter((l) => l.startsWith("data: ") && l.includes('"pi_exit"'))
			.pop();
		assert.ok(exitLine, `the page is told pi went; got:\n${raw.slice(-300)}`);
		const exit = JSON.parse(exitLine.slice(6));
		// 9000 written, 3960 shown.
		assert.match(exit.stderr, /^… \(5040 chars dropped\)\n/, "the count is of everything pi wrote, not of the kept tail");
		assert.doesNotMatch(exit.stderr, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, "and no cut lands on half a character");
	} finally {
		await web.stop();
	}
});

test("a key that lands across the cut is masked, not halved", { timeout: 30_000 }, async () => {
	// The tail was cut to 4000 characters *before* it was redacted, so a key straddling the cut lost
	// the `sk-` prefix the pattern needs — no match, and the second half of the key went out to every
	// attached browser. Redacting the whole kept tail first is the only order that holds.
	const dir = tmp("pi-loops-web-");
	const key = `sk-${"a".repeat(32)}`;
	// Placed so the 4000-character cut falls fifteen characters into the key.
	const line = `${"p".repeat(1000)}${key}${"q".repeat(3980)}`;
	const web = await startWeb(dir, `#!/bin/sh\nsleep 2\necho '${line}' >&2\nexit 1\n`);
	try {
		const { url, token } = web;

		const events = await eventsUntilExit(await eventsAt(url, token));

		assert.match(events, /pi_exit/, `the page is told pi went; got:\n${events.slice(-200)}`);
		assert.doesNotMatch(events, /a{20}/, "no part of the key leaves this process");
		assert.match(events, /\[REDACTED\]/, "it was masked where it was");
	} finally {
		await web.stop();
	}
});

test("the routes that only read are only read from", { timeout: 30_000 }, async () => {
	// /state, /history and /stats answered any method, so a form post from anywhere the Sec-Fetch-Site
	// check does not reach — curl, an older browser — could drive them. They are GETs; say so.
	const dir = tmp("pi-loops-web-");
	const web = await startWeb(dir, sessionAwarePi(path.join(dir, "s.jsonl"), path.join(dir, "sent.jsonl")), { named: "s1" });
	try {
		const { url, token } = web;

		for (const route of ["state", "history", "stats"]) {
			assert.equal((await fetch(`${url}${route}?token=${token}`)).status, 200, `${route} reads`);
			const posted = await fetch(`${url}${route}`, { method: "POST", headers: { "x-pi-web-token": token, "content-type": "application/json" }, body: "{}" });
			assert.equal(posted.status, 404, `${route} is not a route you post to`);
		}
	} finally {
		await web.stop();
	}
});

test("going back to an earlier session puts it back on the model it was last using", { timeout: 30_000 }, async () => {
	// The journey that found it: a window started on one model, switched to another in the picker,
	// twenty-four messages with it, then a clear and a resume — and the panel named the first one
	// again. pi is not lying there: `--model` on the launch command line, which the launcher also
	// supplies from the model you last chose, is re-resolved every time the session inside the
	// process is replaced, so a resume lands on the model the *process* started with. A fresh
	// `pi --resume` restores the session's own model instead, and a window should not mean something
	// different from a terminal.
	const dir = tmp("pi-loops-web-");
	const sessions = tmp("pi-loops-sessions-");
	const older = writeSession(sessions, "01a0-older", "the older conversation", new Date(Date.now() - 60_000));
	const current = writeSession(sessions, "01a0-current", "the one open now", new Date());
	const log = path.join(dir, "sent.jsonl");
	// The branch the resumed session is on ends with a model change to q/n. The entry that is newest
	// in the file belongs to a branch nobody is on any more — an undo, a fork — and the model in an
	// abandoned branch is not the model of this conversation.
	const session = {
		leafId: "e3",
		entries: [
			{ type: "message", id: "e1", parentId: null, message: { role: "user", content: [{ type: "text", text: "hello" }] } },
			{ type: "model_change", id: "e2", parentId: "e1", provider: "q", modelId: "n" },
			{ type: "message", id: "e3", parentId: "e2", message: { role: "assistant", provider: "q", model: "n", content: [{ type: "text", text: "ok" }] } },
			{ type: "model_change", id: "z1", parentId: "e1", provider: "abandoned", modelId: "x" },
		],
	};
	const web = await startWeb(dir, sessionAwarePi(current, log, false, session), { named: "s1" });
	try {
		const { url, token } = web;
		const post = async (p: string, b: unknown) => (await fetch(`${url}${p}`, { method: "POST", headers: { "x-pi-web-token": token, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
		const sent = () =>
			fs
				.readFileSync(log, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l));

		await fetch(`${url}sessions?token=${token}`); // the list a resume may point at
		const back = (await post("session/switch", { file: older })) as any;
		assert.equal(back.success, true, `the resume worked; got ${JSON.stringify(back)}`);

		const models = sent().filter((c) => c.type === "set_model");
		assert.deepEqual(
			models.map((c) => `${c.provider}/${c.modelId}`),
			["q/n"],
			`the session's own model was re-applied, once; got ${JSON.stringify(models)}`,
		);
		const order = sent().map((c) => c.type);
		assert.ok(order.indexOf("set_model") > order.indexOf("switch_session"), "after the swap, not before it");

		// A new session is not a resume: it is meant to start on whatever this process starts sessions on.
		await post("session/new", {});
		assert.equal(sent().filter((c) => c.type === "set_model").length, 1, "a new session is left alone");
	} finally {
		await web.stop();
	}
});

/* ------------------------------------------------------------------ the browser path: a message is a request (design §5) */

const sentTo = (log: string) => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const ringsIn = (log: string) => sentTo(log).filter((m) => m.type === "prompt" && String(m.message).startsWith("/pi-loops ring")).map((m) => String(m.message));
/** Backdate a row's `created_at` by `ms`, as a wait of that long would: the test does not sit through it. */
function ageRow(dir: string, id: string, ms: number): void {
	const file = new RequestStore(path.join(dir, "loops")).file("s1");
	const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	for (const row of lines) if (row.id === id) row.created_at = new Date(Date.now() - ms).toISOString();
	fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}
/** The page's own bound on an untaken message (src/web.mjs UNTAKEN_MS), plus a second. */
const PAST_UNTAKEN_MS = 16_000;

test("without pi-loops in the page's pi, chat goes over rpc as before, and no row is written", { timeout: 30_000 }, async () => {
	// The reviewer's stand-in pi: a command list with no `pi-loops` in it (a pi older than the floor,
	// a load error, extensions off). 0.24.0 wrote a row nobody would drain and sent `/pi-loops ring
	// <id> <fingerprint>`, which pi handed to the model as the person's message. 0.22.8 sent the text.
	const dir = tmp("pi-loops-web-");
	const log = path.join(dir, "sent.jsonl");
	const web = await startWeb(dir, sessionAwarePi(path.join(dir, "s.jsonl"), log, false), { named: "s1" });
	try {
		const answer = await web.post("prompt", { text: "please fix the build" });
		assert.deepEqual([answer.success, answer.queued], [true, undefined], "sent, not queued");
		assert.deepEqual(sentTo(log).filter((m) => m.type === "prompt").map((m) => m.message), ["please fix the build"], "the text itself reaches pi, and no ring does");
		assert.deepEqual(rowsOf(dir), [], "nothing waits in a file nobody drains");
		assert.deepEqual((await web.state()).requests, [], "the queue the page shows is pi's own");
		assert.equal((await web.post("queue/cancel", { id: "p1" })).error, "pi-loops is not loaded in this session");
		assert.equal((await web.post("queue/send", {})).error, "pi-loops is not loaded in this session");
	} finally {
		await web.stop();
	}
});

test("clear cancels every row the badge counts, pi-loops' included, and empties pi's own queue", { timeout: 30_000 }, async () => {
	// docs/web-ui-parity.md: "queued N ✕" counts the person's rows and pi-loops'. The clear cancelled
	// only the person's, so with two scheduled prompts queued the badge still said 2 after the click;
	// 0.22.8's clear emptied pi's whole queue.
	const dir = tmp("pi-loops-web-");
	const loops = path.join(dir, "loops");
	const log = path.join(dir, "sent.jsonl");
	const web = await startWeb(dir, sessionAwarePi(path.join(dir, "s.jsonl"), log, true, {}, ["pi-loops"]), { named: "s1" });
	try {
		const store = new RequestStore(loops);
		const by = { pid: process.pid, instance: "w", procStart: undefined, version: "test" } as SessionRequest["created_by"];
		store.append(plainJobRow({ id: "cron-a", sessionId: "s1", prompt: "check", cwd: dir }, "run-a", "cron:cron-a", "", by));
		store.append(ruleResultRow("s1", "CI failed", { traceId: "trace-r", sourceLabel: "ci" }, by));
		const mineRow = await web.post("prompt", { text: "mine" });
		assert.equal((await web.state()).requests.length, 3, "three rows counted");
		assert.equal((await web.post("queue/clear", {})).success, true);
		const cancelled = rowsOf(dir).filter((r) => r.kind === "cancel").map((r) => r.target?.id).sort();
		assert.deepEqual(cancelled, [mineRow.queued, "run-a", "trace-r"].sort(), "a cancel for every row the badge counted");
		assert.equal(sentTo(log).some((m) => m.type === "clear_queue"), true, "and pi's own queue is cleared");
	} finally {
		await web.stop();
	}
});

test("a message nobody took says why after fifteen seconds, and can be sent here instead", { timeout: 30_000 }, async () => {
	// The terminal that holds the session stands aside (its copy is behind the file), so it delivers
	// nothing, and says so on its lease. The page's pi would answer the row itself; here it is a
	// stand-in with no extension, as a suspended or wedged pi would be, so the row sits. After the
	// bound the page names the pid and the reason and offers rpc, which is how 0.22 sent everything.
	const dir = tmp("pi-loops-web-");
	const loops = path.join(dir, "loops");
	fs.mkdirSync(loops, { recursive: true });
	const leases = new LeaseStore(loops);
	const term = { kind: "terminal" as const, pid: process.pid, instance: "term", acquiredAt: new Date().toISOString(), mode: "tui" as const, pushServers: [] };
	assert.ok("lease" in leases.acquire("s1", term, { cwd: dir }));
	assert.equal(leases.setAside("s1", term, 1), true);
	const log = path.join(dir, "sent.jsonl");
	const web = await startWeb(dir, sessionAwarePi(path.join(dir, "s.jsonl"), log, false, {}, ["pi-loops"]), { named: "s1" });
	try {
		const answer = await web.post("prompt", { text: "anyone?", images: [{ type: "image", data: "AAAA", mimeType: "image/png" }] });
		assert.deepEqual([answer.success, answer.elsewhere], [true, undefined], "a holder that will not deliver is not 'answered there'");
		assert.equal((await web.state()).requests[0]?.stuck, undefined, "fresh: nothing to say yet");
		ageRow(dir, answer.queued, PAST_UNTAKEN_MS);
		assert.deepEqual((await web.state()).requests[0]?.stuck, { pid: process.pid, line: "not taken (shows an older copy of this conversation)", button: "send it here instead" });
		assert.equal((await web.post("queue/send-here", { id: "../x" })).success, false, "an id is checked before it reaches a file");
		const sent = await web.post("queue/send-here", { id: answer.queued });
		assert.equal(sent.success, true, JSON.stringify(sent));
		assert.deepEqual(rowsOf(dir), [], "out of the queue");
		assert.equal(fs.existsSync(new RequestStore(loops).imageFile("s1", answer.queued)), false, "and its image file with it");
		const prompt = sentTo(log).find((m) => m.type === "prompt" && m.message === "anyone?");
		assert.equal(prompt?.images?.length, 1, "sent to this page's pi over rpc, image included");
		assert.deepEqual(new TriggerStore(loops).listAudit(5, (r) => r.type === "request" && r.traceId === answer.queued).map((r) => r.state), ["cancelled"]);
		assert.equal((await web.post("queue/send-here", { id: answer.queued })).success, false, "once");
		// A row a holder has stamped handed over is pi's: send-here refuses it rather than answering twice.
		const handed = await web.post("prompt", { text: "taken by pi meanwhile" });
		new RequestStore(loops).update("s1", handed.queued, { handed_at: new Date().toISOString() });
		assert.deepEqual(await web.post("queue/send-here", { id: handed.queued }), { success: false, error: "already handed to pi" });
		assert.equal(rowsOf(dir).some((r) => r.id === handed.queued), true, "and the row stays pi's");
		await web.post("queue/cancel", { id: handed.queued });
		// After Stop a queued message is not held (owner decision 2026-11-02: Stop ends the turn, not
		// the queue), so one nobody took is said to be untaken as before the Stop, with the same offer.
		const after = await web.post("prompt", { text: "after this, stop" });
		assert.equal((await web.post("abort", {})).success, true);
		ageRow(dir, after.queued, PAST_UNTAKEN_MS);
		assert.deepEqual((await web.state()).requests.find((r: any) => r.id === after.queued)?.stuck, { pid: process.pid, line: "not taken (shows an older copy of this conversation)", button: "send it here instead" }, "a Stop hides nothing: the message still waits, and the page still says so");
	} finally {
		await web.stop();
	}
});

test("a page whose own pi stands aside says so and does not offer to send around it", { timeout: 30_000 }, async () => {
	// The page's pi holds the session and its copy is behind the file (another window wrote more,
	// then died). Anything written now branches the conversation; the page says /resume, and the row
	// waits for the pi that resumes, which then answers it.
	const dir = tmp("pi-loops-web-");
	const loops = path.join(dir, "loops");
	fs.mkdirSync(loops, { recursive: true });
	const pidFile = path.join(dir, "pi.pid");
	const log = path.join(dir, "sent.jsonl");
	const web = await startWeb(dir, sessionAwarePi(path.join(dir, "s.jsonl"), log, false, {}, ["pi-loops"], pidFile), { named: "s1" });
	try {
		// The pool answers once pi has spawned, which can be before the stand-in has run a line.
		for (const end = Date.now() + 5_000; !fs.existsSync(pidFile) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 25));
		const piPid = Number(fs.readFileSync(pidFile, "utf8"));
		const leases = new LeaseStore(loops);
		const own = { kind: "terminal" as const, pid: piPid, instance: "page-pi", acquiredAt: new Date().toISOString(), mode: "rpc" as const, pushServers: [] };
		assert.ok("lease" in leases.acquire("s1", own, { cwd: dir }));
		assert.equal(leases.setAside("s1", own, 1), true);
		const answer = await web.post("prompt", { text: "hello?" });
		assert.deepEqual([answer.success, answer.elsewhere, answer.aside], [true, undefined, { pid: piPid }], "the page is told its own pi stands aside");
		ageRow(dir, answer.queued, PAST_UNTAKEN_MS);
		assert.deepEqual((await web.state()).requests[0]?.stuck, { pid: piPid, line: "not taken (this page's pi shows an older copy of this conversation and reads it again once it is idle)" }, "no offer: anything written now branches the conversation");
		assert.equal((await web.post("queue/send-here", { id: answer.queued })).success, false, "nothing may write into the conversation until it is resumed");
		assert.equal(rowsOf(dir).length, 1, "the row waits for the pi that resumes");
	} finally {
		await web.stop();
	}
});

test("a holder that delivers but has not taken the message is not called unanswering, and the offer says it forks", { timeout: 30_000 }, async () => {
	// Owner decision O2: the terminal holds and answers. The page sees its own pi idle, not the
	// terminal's, so a terminal in a long turn, or suspended with Ctrl-Z, looks the same from here.
	// The row says the holder may be busy, and the one offer says what answering here costs.
	const dir = tmp("pi-loops-web-");
	const loops = path.join(dir, "loops");
	fs.mkdirSync(loops, { recursive: true });
	const leases = new LeaseStore(loops);
	assert.ok("lease" in leases.acquire("s1", { kind: "terminal", pid: process.pid, instance: "term", acquiredAt: new Date().toISOString(), mode: "tui", pushServers: [] }, { cwd: dir }));
	const log = path.join(dir, "sent.jsonl");
	const web = await startWeb(dir, sessionAwarePi(path.join(dir, "s.jsonl"), log, false, {}, ["pi-loops"]), { named: "s1" });
	try {
		const answer = await web.post("prompt", { text: "still there?" });
		assert.deepEqual(answer.elsewhere, { pid: process.pid }, "answered there, as before");
		ageRow(dir, answer.queued, PAST_UNTAKEN_MS);
		const stuck = (await web.state()).requests[0]?.stuck;
		assert.deepEqual(stuck, { pid: process.pid, line: "another pi holds this conversation and has not taken it yet (it may be busy)", button: "answer here instead (a branch the other pi will not see)" });
		assert.notEqual(stuck?.button, "send it here instead", "no unqualified send-here for a holder that delivers");
		// Chosen knowingly, it still works: the way out for a terminal that is suspended.
		assert.equal((await web.post("queue/send-here", { id: answer.queued })).success, true);
		assert.equal(sentTo(log).some((m) => m.type === "prompt" && m.message === "still there?"), true);
	} finally {
		await web.stop();
	}
});

test("a command list that changes is asked for again before a message is routed on it", { timeout: 30_000 }, async () => {
	// `/reload` in the page can unload pi-loops; the page used to route on the list it fetched at
	// startup, writing rows nobody drains. The list is asked for after every slash command, and
	// again when the cached one is older than thirty seconds.
	const dir = tmp("pi-loops-web-");
	const commandsFile = path.join(dir, "commands.json");
	fs.writeFileSync(commandsFile, JSON.stringify(["pi-loops", "reload"]));
	const log = path.join(dir, "sent.jsonl");
	const web = await startWeb(dir, sessionAwarePi(path.join(dir, "s.jsonl"), log, false, {}, { file: commandsFile }), { named: "s1" });
	try {
		const first = await web.post("prompt", { text: "with pi-loops" });
		assert.equal(typeof first.queued, "string", "a row while pi-loops is loaded");
		fs.writeFileSync(commandsFile, JSON.stringify(["reload"]));
		assert.equal((await web.post("prompt", { text: "/reload" })).success, true);
		await new Promise((r) => setTimeout(r, 300));
		const second = await web.post("prompt", { text: "without pi-loops" });
		assert.equal(second.queued, undefined, "routed on the list as it is now: over rpc");
		assert.deepEqual(sentTo(log).filter((m) => m.type === "prompt" && !String(m.message).startsWith("/")).map((m) => m.message), ["without pi-loops"]);
		assert.equal(rowsOf(dir).length, 1, "no second row");
	} finally {
		await web.stop();
	}
});

test("a message typed before pi exits is offered, not sent, by the next page", { timeout: 30_000 }, async () => {
	// docs/web-ui-parity.md: a message you sent survives pi stopping and is offered, never sent on
	// its own, by the next page. The row names the web.mjs that wrote it; no holder sends a person
	// row whose process is gone, and the next page shows it with send and discard.
	const dir = tmp("pi-loops-web-");
	const first = await startWeb(dir, sessionAwarePi(path.join(dir, "s.jsonl"), path.join(dir, "sent-1.jsonl"), true, {}, ["pi-loops"]), { named: "s1" });
	const long = "keep this ".repeat(50).trim();
	const answer = await first.post("prompt", { text: long });
	assert.equal(answer.success, true);
	assert.equal(rowsOf(dir)[0]?.created_by.pid, JSON.parse(fs.readFileSync(path.join(dir, "loops", "pages", "s1.json"), "utf8")).pid, "the row names the pi it was rung to");
	await first.stop();
	assert.equal(rowsOf(dir).length, 1, "pi exited with the message queued: it is still in the file");

	const log2 = path.join(dir, "sent-2.jsonl");
	const next = await startWeb(dir, sessionAwarePi(path.join(dir, "s.jsonl"), log2, false, {}, ["pi-loops"]), { named: "s1" });
	try {
		const listed = (await next.state()).requests;
		assert.deepEqual(listed.map((r: any) => [r.id, r.label, r.text, r.offered, r.mine]), [[answer.queued, "you", long, true, false]], "offered: not sent before pi stopped, with the whole text, since send vouches for all of it");
		assert.deepEqual(ringsIn(log2), [], "and rung for by nobody");
		// Discard is a cancel row; send makes it this page's and rings for it.
		assert.equal((await next.post("queue/send", { id: answer.queued })).success, true);
		const row = rowsOf(dir).find((r) => r.id === answer.queued)!;
		assert.equal(row.created_by.pid, JSON.parse(fs.readFileSync(path.join(dir, "loops", "pages", "s1.json"), "utf8")).pid, "sent: the row is this page's pi's now");
		await new Promise((r) => setTimeout(r, 200));
		assert.deepEqual(ringsIn(log2), [`/pi-loops ring ${row.id} ${requestFingerprint(row)}`], "and the bell carries its fingerprint");
		assert.equal((await next.state()).requests[0]?.offered, false);
		assert.equal((await next.post("queue/cancel", { id: answer.queued })).success, true);
		const cancel = rowsOf(dir).find((r) => r.kind === "cancel");
		assert.deepEqual(cancel?.target, { id: answer.queued }, "discard: a cancel row the holder acts on");
		assert.equal((await next.post("queue/cancel", { id: "../etc" })).success, false, "an id is checked before it reaches a file");
	} finally {
		await next.stop();
	}
});

test("after Stop, the queue is untouched and runs on its own: Stop is pi's abort and nothing else", { timeout: 30_000 }, async () => {
	// Owner decision 2026-11-02: Stop stops the current turn only, as Esc does in a terminal. The rows
	// stay where they are, listed and cancellable one at a time (docs/web-ui-parity.md), and the
	// holder hands the next one over once pi is idle (test/engine.test.ts: after Stop, the person's
	// queued rows run once pi is idle). Nothing has to be sent again by hand, so "send queued" is gone.
	const dir = tmp("pi-loops-web-");
	const log = path.join(dir, "sent.jsonl");
	const web = await startWeb(dir, sessionAwarePi(path.join(dir, "s.jsonl"), log, true, {}, ["pi-loops"]), { named: "s1" });
	try {
		const a = await web.post("prompt", { text: "first" });
		const b = await web.post("prompt", { text: "second" });
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(ringsIn(log).length, 2, "each send rings once");
		assert.equal((await web.post("abort", {})).success, true);
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(sentTo(log).at(-1)?.type, "abort", "Stop is pi's abort");
		assert.equal(ringsIn(log).length, 2, "and rings for nothing");
		assert.deepEqual(rowsOf(dir).map((r) => r.id), [a.queued, b.queued], "the queue is untouched: the holder runs it once pi is idle");
		assert.deepEqual((await web.state()).requests.map((r: any) => [r.label, r.text, r.mine]), [["you", "first", true], ["you", "second", true]]);
		assert.deepEqual(await web.post("queue/send", {}), { success: false, error: "bad id" }, "nothing to send by hand: send takes the id of a message a previous page left");
		assert.ok(rowsOf(dir).every((r) => !("released_at" in r)), "no hold to release");
	} finally {
		await web.stop();
	}
});

test("a send pi refuses comes back to the composer with the error", { timeout: 30_000 }, async () => {
	// The holder writes `last_error` on a person row pi never started (test/engine.test.ts). The page
	// reads the file for /state: the row leaves it, the audit says failed, and the stream carries the
	// text back to the composer with the error.
	const dir = tmp("pi-loops-web-");
	const log = path.join(dir, "sent.jsonl");
	const web = await startWeb(dir, sessionAwarePi(path.join(dir, "s.jsonl"), log, false, {}, ["pi-loops"]), { named: "s1" });
	try {
		const { queued } = await web.post("prompt", { text: "hello?", images: [{ type: "image", data: "AAAA", mimeType: "image/png" }] });
		assert.equal((await web.state()).requests.length, 1, "queued, with nothing wrong yet");
		new RequestStore(path.join(dir, "loops")).update("s1", queued, { attempts: 1, last_error: "pi did not start a turn for it" });
		assert.deepEqual((await web.state()).requests, [], "taken out of the queue");
		assert.equal(rowsOf(dir).length, 0, "and out of the file");
		const audit = new TriggerStore(path.join(dir, "loops")).listAudit(5, (r) => r.type === "request" && r.traceId === queued);
		assert.deepEqual(audit.map((r) => r.state), ["failed"]);
		const events = await replayEvents(await eventsAt(web.url, web.token));
		const failed = events.find((e: any) => e.type === "send_failed");
		assert.deepEqual([failed?.id, failed?.text, failed?.images?.length, failed?.error], [queued, "hello?", 1, "pi did not start a turn for it"], "the text and its image come back, with the reason");
	} finally {
		await web.stop();
	}
});

test("a page's message for a session a terminal holds is answered there", { timeout: 30_000 }, async () => {
	// Owner decision O2: when a terminal pi holds the session, the page's pi is a viewer. The row is
	// written and rung for all the same; the terminal's watcher drains it, and the page is told which
	// pid answers.
	const dir = tmp("pi-loops-web-");
	const loops = path.join(dir, "loops");
	fs.mkdirSync(loops, { recursive: true });
	// This test process stands in for the terminal pi: alive, and not the pi behind the page.
	const leases = new LeaseStore(loops);
	assert.ok("lease" in leases.acquire("s1", { kind: "terminal", pid: process.pid, instance: "term", acquiredAt: new Date().toISOString(), mode: "tui", pushServers: [] }, { cwd: dir }));
	const log = path.join(dir, "sent.jsonl");
	const web = await startWeb(dir, sessionAwarePi(path.join(dir, "s.jsonl"), log, false, {}, ["pi-loops"]), { named: "s1" });
	try {
		const answer = await web.post("prompt", { text: "who answers?" });
		assert.deepEqual([answer.success, answer.elsewhere], [true, { pid: process.pid }], "the page says which terminal answers");
		assert.equal(rowsOf(dir)[0]?.payload?.text, "who answers?", "the row is in the one queue the terminal drains");
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(ringsIn(log).length, 1, "rung for, in case the page's pi holds after all");
		// A command still runs in the page's own pi, as before.
		assert.equal(sentTo(log).some((m) => m.message === "who answers?"), false);
	} finally {
		await web.stop();
	}
});
