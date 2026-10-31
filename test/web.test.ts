import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import { execSync, spawn } from "node:child_process";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { requestFingerprint } from "../src/engine.ts";
import { RequestStore, type SessionRequest } from "../src/requests.ts";
import { LeaseStore } from "../src/lease.ts";
import { TriggerStore } from "../src/triggers.ts";
import { randomUUID } from "node:crypto";

const WEB = path.join(process.cwd(), "src", "web.mjs");
const webSource = WEB;
const { readFileSync } = fs;

/** Run the front end against a stand-in for pi, and collect everything it printed. */
function runWeb(piScript: string, port: number | "any", ms = 4000, onLine?: (line: string) => void, reuseDir?: string, extra: string[] = []): Promise<{ code: number | null; output: string }> {
	const dir = reuseDir ?? tmp("pi-loops-web-");
	const fake = path.join(dir, "fakepi");
	fs.writeFileSync(fake, piScript, { mode: 0o755 });
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [WEB, "--port", port === "any" ? "0" : String(port), "--no-open", ...extra], {
			env: { ...process.env, PI_BIN: fake, PI_LOOPS_DIR: path.join(dir, "loops") },
		});
		let output = "";
		const take = (d: Buffer) => {
			output += d.toString();
			onLine?.(d.toString());
		};
		child.stdout.on("data", take);
		child.stderr.on("data", take);
		const timer = setTimeout(() => child.kill("SIGTERM"), ms);
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve({ code, output });
		});
	});
}

test("a pi that refuses to start takes the front end down cleanly, saying why", { timeout: 30_000 }, async () => {
	// The real case: two copies of an extension installed, so pi exits before answering anything.
	// The front end used to write to a closed stdin and die of an unhandled EPIPE instead — which
	// left a browser tab pointing at nothing and the reason only in a terminal.
	const { code, output } = await runWeb('#!/bin/sh\necho \'Error: Tool "cron_create" conflicts with /somewhere/else\' >&2\nexit 1\n', "any");
	assert.equal(code, 1, "it leaves with pi's own exit code");
    assert.match(output, /Tool "cron_create" conflicts/, "pi's reason reaches the terminal");
	assert.equal(/Unhandled|EPIPE\n\s+at /.test(output), false, `no crash, got:\n${output}`);
	assert.match(output, /pi exited \(1\)/);
});

test("with pi's agent directory moved, the front end keeps its files where the extension keeps its loops", { timeout: 30_000 }, async () => {
	// `PI_CODING_AGENT_DIR` moves everything pi keeps, and the extension inside the pi behind this page
	// follows it. The front end did not: it read and wrote ~/.pi/agent/loops — the token, and `ui.json`
	// with the model you pick in the page — so the panel described a directory the session was not
	// writing, and choosing a model rewrote the choice of whatever setup lives in the default one.
	const dir = tmp("pi-loops-web-");
	const home = path.join(dir, "home");
	const agent = path.join(dir, "agent");
	fs.mkdirSync(home);
	const fake = path.join(dir, "fakepi");
	fs.writeFileSync(fake, "#!/bin/sh\nsleep 8\n", { mode: 0o755 });
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PI_BIN: fake, PI_CODING_AGENT_DIR: agent };
	delete env.PI_LOOPS_DIR;
	const seen: string[] = [];
	const child = spawn(process.execPath, [WEB, "--port", "0", "--no-open"], { env });
	child.stdout.on("data", (d: Buffer) => seen.push(d.toString()));
	child.stderr.on("data", (d: Buffer) => seen.push(d.toString()));
	const exited = new Promise((resolve) => child.on("exit", resolve));
	try {
		assert.ok(await addressOf(seen), `it announced a URL, got:\n${seen.join("")}`);
		assert.ok(fs.existsSync(path.join(agent, "loops", "web-token")), `the token is under the moved agent directory, got:\n${seen.join("")}`);
		assert.equal(fs.existsSync(path.join(home, ".pi")), false, "and nothing was written under the default one");
	} finally {
		child.kill("SIGTERM");
		await exited;
	}
});

test("a pi that starts is served, and one visit is enough for that browser", { timeout: 30_000 }, async () => {
	// `sleep` stands in for a pi that is up but has nothing to say: enough to prove the server binds
	// and answers, without a model call.
	// A free port, not a chosen one: a fixed port is a fight with whatever else is on this machine,
	// and losing it makes the test flaky rather than making it fail honestly.
	const dir = tmp("pi-loops-web-");
	const seen: string[] = [];
	const running = runWeb("#!/bin/sh\nsleep 8\n", "any", 7000, (line) => seen.push(line), dir);
	const bare = new URL((await addressOf(seen)) ?? "http://127.0.0.1:1/");
	assert.match(seen.join(""), /web on http/, `it announced a URL, got:\n${seen.join("")}`);
	// The token is printed only on a terminal now that it outlives the process, so read it from
	// where it lives — which is also the address a person would rebuild from.
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

	// The visit that carries the token hands out a cookie...
	const withToken = await fetch(url);
	assert.equal(withToken.status, 200);
	const cookie = withToken.headers.get("set-cookie") ?? "";
	assert.match(cookie, new RegExp(`pi_web_token=${token}`), "the visit leaves a cookie");
	assert.match(cookie, /SameSite=Strict/i, "which no other site can make the browser send");
	assert.match(cookie, /HttpOnly/i);

	// ...and after it, the address to remember has nothing in it.
	const warm = await fetch(bare, { headers: { cookie: cookie.split(";")[0] } });
	assert.equal(warm.status, 200, "the bare address works from then on");
	await running;
});

test("the token outlives the process, so the address does not change", { timeout: 30_000 }, async () => {
	// Two launches sharing one loops directory: a bookmark taken from the first has to work on the
	// second, which is the whole reason the token is a file rather than a fresh random per run.
	const dir = tmp("pi-loops-web-");
	const file = path.join(dir, "loops", "web-token");
	const token = async () => {
		const seen: string[] = [];
		await runWeb("#!/bin/sh\nsleep 2\n", "any", 2500, (line) => seen.push(line), dir);
		return fs.readFileSync(file, "utf8").trim();
	};
	const first = await token();
	assert.match(first, /^[0-9a-f]{32}$/, "the first launch made a token");
	assert.equal(await token(), first, "and the second launch uses the same one");
	assert.equal(fs.statSync(file).mode & 0o777, 0o600, "readable by nobody else");

	// And a file that came back from a backup at 0644 is tightened rather than trusted as it is.
	fs.chmodSync(file, 0o644);
	await token();
	assert.equal(fs.statSync(file).mode & 0o777, 0o600, "a loose mode is fixed on the next launch");
});

test("a second launch on the busy port hands over instead of failing", { timeout: 30_000 }, async () => {
	// The cost of a fixed port is colliding with yourself, and `pi-loops` twice is a normal thing to
	// do. The second one should hand you the window the first is already serving.
	const dir = tmp("pi-loops-web-");
	const port = 4173 + Math.floor(Math.random() * 400);
	const seen: string[] = [];
	const first = runWeb("#!/bin/sh\nsleep 10\n", port, 9000, (line) => seen.push(line), dir);
	for (const deadline = Date.now() + 6000; Date.now() < deadline && !seen.join("").includes("web on"); ) {
		await new Promise((r) => setTimeout(r, 50));
	}
	assert.match(seen.join(""), /web on/, `the first one bound, got:\n${seen.join("")}`);

	const second = await runWeb("#!/bin/sh\nsleep 10\n", port, 9000, undefined, dir);
	assert.equal(second.code, 0, `it left quietly, got:\n${second.output}`);
	assert.match(second.output, /already running on http:\/\/127\.0\.0\.1:\d+\//);
	// The address it opens differs each time on purpose: a browser handed a URL it already has open
	// brings that tab forward without reloading it, and an old tab is how "no reply appears" starts.
	assert.match(readFileSync(webSource, "utf8"), /openBrowser\(`\$\{there\}\?opened=/, "the handover opens a fresh address");
	await first;
});

/** One GET, with a Host header of our choosing: the thing every rebinding check is actually about. */
function statusWithHost(port: number, host: string, path = "/"): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers: { host } }, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("error", reject);
		req.end();
	});
}

/**
 * Wait until what the front end has printed so far matches.
 *
 * Two lines printed one after the other do not arrive in one chunk, and a test that reads the buffer
 * the instant the first line lands fails on the second for no reason anybody can reproduce. Waiting
 * for the line you are asserting about is the whole fix.
 */
async function printed(seen: string[], re: RegExp): Promise<boolean> {
	for (const deadline = Date.now() + 6000; Date.now() < deadline; ) {
		if (re.test(seen.join(""))) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return false;
}

/** Wait for the front end to announce itself and give back the address it bound. */
async function addressOf(seen: string[]): Promise<string | undefined> {
	for (const deadline = Date.now() + 6000; Date.now() < deadline; ) {
		const m = /web on (http:\/\/127\.0\.0\.1:\d+\/)/.exec(seen.join(""));
		if (m) return m[1];
		await new Promise((r) => setTimeout(r, 50));
	}
	return undefined;
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

test("--no-auth serves the page with nothing to carry", { timeout: 30_000 }, async () => {
	const seen: string[] = [];
	const running = runWeb("#!/bin/sh\nsleep 8\n", "any", 7000, (line) => seen.push(line), undefined, ["--no-auth"]);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	assert.ok(await printed(seen, /--no-auth/), `and said what that means, got:\n${seen.join("")}`);
	assert.equal((await fetch(url)).status, 200, "the bare address is the whole of it");
	await running;
});

test("a request line that is not a URL is answered 400, and the front end keeps serving", { timeout: 30_000 }, async () => {
	// `GET //[` made `new URL` throw outside the handler's try, and the unhandled rejection ended it.
	const seen: string[] = [];
	const running = runWeb("#!/bin/sh\nsleep 8\n", "any", 7000, (line) => seen.push(line), undefined, ["--no-auth"]);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const { port } = new URL(url);
	const raw = await new Promise<string>((resolve, reject) => {
		const sock = net.connect(Number(port), "127.0.0.1", () => sock.end("GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"));
		let got = "";
		sock.on("data", (d) => (got += d));
		sock.on("end", () => resolve(got));
		sock.on("error", reject);
	});
	assert.match(raw, /^HTTP\/1\.1 400/);
	assert.equal((await fetch(url)).status, 200, "still serving");
	await running;
});

test("a request another site started is refused, token or not", { timeout: 30_000 }, async () => {
	// SameSite is scoped to the site, and a site ignores the port: any page served from
	// localhost:5173 — a dev server, or something with an XSS in it — is handed this cookie by the
	// browser and would otherwise be able to type into your session.
	const seen: string[] = [];
	const running = runWeb("#!/bin/sh\nsleep 8\n", "any", 7000, (line) => seen.push(line), undefined, ["--no-auth"]);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const port = new URL(url).port;

	for (const headers of [
		{ "sec-fetch-site": "cross-site" },
		{ "sec-fetch-site": "same-site" },
		{ origin: "http://localhost:5173" },
	]) {
		const r = await fetch(url, { headers });
		assert.equal(r.status, 403, `refused ${JSON.stringify(headers)}`);
	}
	// The page's own requests say the same thing about themselves and are let through.
	const ok = await fetch(url, { headers: { "sec-fetch-site": "same-origin", origin: `http://127.0.0.1:${port}` } });
	assert.equal(ok.status, 200, "its own page still works");
	await running;
});

test("a phone gets in with the six-digit code, and the page is installable", { timeout: 30_000 }, async () => {
	const dir = tmp("pi-loops-web-");
	const seen: string[] = [];
	const running = runWeb("#!/bin/sh\nsleep 8\n", "any", 7000, (line) => seen.push(line), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	// The code is printed on a terminal, and this is not one — so ask for one the way a browser
	// that is already signed in would.
	const token = fs.readFileSync(path.join(dir, "loops", "web-token"), "utf8").trim();
	const minted = await fetch(`${url}pair?token=${token}`, { method: "POST" });
	const code = (await minted.json()).code as string;
	assert.match(code, /^\d{6}$/, "a code a screen keyboard can manage");

	// A guess that is not even the right shape is refused without a stack trace, and a wrong code
	// does not consume the right one.
	assert.equal((await fetch(`${url}?pair=ÿÿÿÿÿÿ`)).status, 403, "a multibyte guess is just wrong, not a 500");
	assert.equal((await fetch(`${url}?pair=${code === "000000" ? "111111" : "000000"}`)).status, 403);

	const paired = await fetch(`${url}?pair=${code}`);
	assert.equal(paired.status, 200, "the code lets that device in");
	assert.match(paired.headers.get("set-cookie") ?? "", /pi_web_token=/, "and leaves it signed in");
	// Single use: the same code a second time is nothing.
	assert.equal((await fetch(`${url}?pair=${code}`)).status, 403, "and is spent");

	// Closing the dialog retires the code rather than leaving a live grant armed and forgotten.
	const next = (await (await fetch(`${url}pair?token=${token}`, { method: "POST" })).json()).code as string;
	await fetch(`${url}pair?token=${token}`, { method: "POST", body: JSON.stringify({ cancel: true }) });
	assert.equal((await fetch(`${url}?pair=${next}`)).status, 403, "a cancelled code is not a code");

	// And what a phone should be pointed at is the server's answer, not the page's guess.
	const minted2 = await (await fetch(`${url}pair?token=${token}`, { method: "POST" })).json();
	assert.ok(minted2.expiresIn > 0, `a code says how long it lasts; got ${JSON.stringify(minted2)}`);
	assert.ok(Array.isArray(minted2.addresses), "and which addresses it would work on");

	// Installability is fetched without credentials by the browser, so it cannot sit behind the
	// token — and it carries nothing that needs to.
	const manifest = await fetch(`${url}manifest.webmanifest`);
	assert.equal(manifest.status, 200);
	assert.equal((await manifest.json()).display, "standalone", "so a phone opens it without browser chrome");
	assert.equal((await fetch(`${url}icon.svg`)).status, 200);
	// But not as a load/no-load bit for a page sweeping ports on this machine.
	assert.equal((await fetch(`${url}icon.svg`, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
	await running;
});

test("the transcript hand-off carries the number the events are counted from", { timeout: 30_000 }, async () => {
	// The browser replays /history and then joins the live stream; without a number to compare
	// against it has to guess which of the backlog it already has.
	const dir = tmp("pi-loops-web-");
	const seen: string[] = [];
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
	const running = runWeb(answering, "any", 7000, (line) => seen.push(line), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(dir, "loops", "web-token"), "utf8").trim();

	const hist = await (await fetch(`${url}history?token=${token}`)).json();
	assert.equal(typeof hist.seq, "number", "/history says where the event stream had got to");
	await running;
});

test("/state says whether the host is up from the host's own record, on every request", { timeout: 30_000 }, async () => {
	// The panel's host line came from the session's runtime snapshot, which is written at most once a
	// minute; it said "host not running" beside a running host. The record is read per request instead.
	const dir = tmp("pi-loops-web-");
	const loops = path.join(dir, "loops");
	fs.mkdirSync(loops, { recursive: true });
	const seen: string[] = [];
	const running = runWeb(chattyPi(dir, []), "any", 6000, (line) => seen.push(line), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(loops, "web-token"), "utf8").trim();
	const state = async () => (await (await fetch(`${url}state?token=${token}`)).json()) as any;

	assert.equal((await state()).automation.hostPid, undefined, "no record, no host");
	fs.writeFileSync(path.join(loops, "host-service.json"), JSON.stringify({ v: 1, pid: process.pid, startedAt: new Date().toISOString() }));
	assert.equal((await state()).automation.hostPid, process.pid, "a live host is seen at once");
	fs.rmSync(path.join(loops, "host-service.json"));
	assert.equal((await state()).automation.hostPid, undefined, "and one that went away is gone at once");
	await running;
});

test("the event backlog a late-joining browser replays is bounded", { timeout: 30_000 }, async () => {
	// docs/web-ui-parity.md: "the backlog a late-joining browser replays is bounded." The 800-event
	// cap in src/web.mjs had no test, so it could be deleted with the suite still green.
	const dir = tmp("pi-loops-web-");
	const said = Array.from({ length: 900 }, (_, i) => ({ type: "test_event", n: i }));
	const seen: string[] = [];
	const running = runWeb(chattyPi(dir, said), "any", 8000, (line) => seen.push(line), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(dir, "loops", "web-token"), "utf8").trim();
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

	const replayed = await replayEvents(`${url}events?token=${token}`);
	// Unbounded, this is all 900 and the first replayed event is seq 1.
	assert.equal(replayed.length, 800, "the replay is the cap, not the whole backlog");
	assert.equal(replayed[0].seq, seq - 800 + 1, "the oldest kept is the 800th-newest event");
	assert.equal(replayed.at(-1).seq, seq, "and the newest is still there");
	await running;
});

test("dialogs held for a browser that turns up are bounded, oldest first", { timeout: 30_000 }, async () => {
	// docs/web-ui-parity.md: the list held for a later browser "is bounded the way the event backlog
	// is." The 50-entry cap in src/web.mjs had no test, so it could be deleted with the suite green.
	const dir = tmp("pi-loops-web-");
	const asks = Array.from({ length: 60 }, (_, i) => ({ type: "extension_ui_request", id: `ask-${i}`, method: "confirm", title: `t${i}`, message: `m${i}` }));
	const seen: string[] = [];
	const running = runWeb(chattyPi(dir, asks), "any", 8000, (line) => seen.push(line), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(dir, "loops", "web-token"), "utf8").trim();

	let state: any = {};
	for (const deadline = Date.now() + 6000; Date.now() < deadline; ) {
		state = await (await fetch(`${url}state?token=${token}`)).json();
		if (state.seq >= asks.length) break;
		await new Promise((r) => setTimeout(r, 50));
	}
	assert.ok(state.seq >= asks.length, `every dialog was asked; got ${state.seq}`);
	assert.equal(state.pendingAsks.length, 50, "the held list is capped");
	assert.deepEqual(state.pendingAsks.map((a: any) => a.id), asks.slice(-50).map((a) => a.id), "the oldest are the ones let go");
	await running;
});

test("the event streams one server holds open are bounded", { timeout: 30_000 }, async () => {
	// src/web.mjs: "One person, a few tabs. An unbounded set is a way to run this process out of
	// memory." The 16-stream cap had no test, so it could be deleted with the suite still green.
	const dir = tmp("pi-loops-web-");
	const seen: string[] = [];
	const running = runWeb("#!/bin/sh\nsleep 8\n", "any", 8000, (line) => seen.push(line), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(dir, "loops", "web-token"), "utf8").trim();

	const open = () => new Promise<http.IncomingMessage>((resolve, reject) => {
		const req = http.get(`${url}events?token=${token}`, (res) => resolve(res));
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
	await running;
});

test("the previews held for open tabs are bounded, newest first", { timeout: 30_000 }, async () => {
	// src/web.mjs: "Eight, because a preview is a tab you have open right now, and nobody has more
	// of those than that." The PREVIEW_KEEP cap had no test, so it could be deleted with the suite green.
	const dir = tmp("pi-loops-web-");
	const seen: string[] = [];
	const running = runWeb("#!/bin/sh\nsleep 8\n", "any", 8000, (line) => seen.push(line), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(dir, "loops", "web-token"), "utf8").trim();

	const ids: string[] = [];
	for (let i = 0; i < 9; i++) {
		const made = await fetch(`${url}preview?token=${token}`, { method: "POST", body: JSON.stringify({ html: `<!doctype html><h1>${i}</h1>` }) });
		assert.equal(made.status, 200);
		ids.push(((await made.json()) as any).id);
	}
	assert.equal((await fetch(`${url}preview/${ids[0]}?token=${token}`)).status, 404, "the oldest preview is let go");
	assert.equal((await fetch(`${url}preview/${ids[7]}?token=${token}`)).status, 200, "the newest eight are kept");
	await running;
});

test("a file the session made can be looked at, and nothing else can", { timeout: 30_000 }, async () => {
	const dir = tmp("pi-loops-web-");
	const work = tmp("pi-loops-work-");
	fs.writeFileSync(path.join(work, "chart.png"), Buffer.from("89504e470d0a1a0a", "hex"));
	fs.writeFileSync(path.join(work, "report.html"), "<h1>hi</h1>");
	fs.writeFileSync(path.join(work, "secrets"), "no extension, not previewable");
	const seen: string[] = [];
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
	const running = runWeb(answering, "any", 8000, (line) => seen.push(line), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(dir, "loops", "web-token"), "utf8").trim();
	// The route anchors to the session directory, which it learns from pi when the page asks.
	await fetch(`${url}state?token=${token}`);
	const get = (p: string) => fetch(`${url}file?token=${token}&path=${encodeURIComponent(p)}`);

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
	assert.equal((await fetch(`${url}file?path=chart.png`)).status, 403, "and not without the token");
	await running;
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
	const seen: string[] = [];
	const running = runWeb(sessionAwarePi(current, log, false, {}, ["pi-loops"]), "any", 9000, (line) => seen.push(line), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(dir, "loops", "web-token"), "utf8").trim();
	const post = async (p: string, b: unknown) => (await fetch(`${url}${p}?token=${token}`, { method: "POST", body: JSON.stringify(b) })).json();
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
	await running;
});

test("a session an extension switched to inside pi is followed: the page is told to reload", { timeout: 30_000 }, async () => {
	// `/inbox open` forks a run's transcript and switches pi to it. The page kept showing the old
	// conversation until someone reloaded it: only a switch the page asked for changed the epoch.
	const dir = tmp("pi-loops-web-");
	const work = tmp("pi-loops-switch-");
	const current = writeSession(work, "01a0-before", "the session before", new Date());
	const forked = writeSession(work, "01a0-forked", "the forked run", new Date());
	const log = path.join(dir, "sent.jsonl");
	const seen: string[] = [];
	const running = runWeb(sessionAwarePi(current, log, false, {}, ["switch-to"]), "any", 9000, (line) => seen.push(line), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(dir, "loops", "web-token"), "utf8").trim();
	const state = async () => (await (await fetch(`${url}state?token=${token}`)).json()) as any;

	const before = await state();
	assert.equal(before.sessionFile, current);
	await fetch(`${url}prompt?token=${token}`, { method: "POST", body: JSON.stringify({ text: `/switch-to ${forked}` }) });
	const after = await state();
	assert.equal(after.sessionFile, forked);
	assert.notEqual(after.epoch, before.epoch, "a new session is a new epoch, which is what makes the page reload");
	assert.equal((await state()).epoch, after.epoch, "and only once: the next poll sees the same session");
	await running;
});

test("--no-auth is loopback only, whatever name the request arrives under", { timeout: 30_000 }, async () => {
	// Refusing --no-auth at bind time is not enough: `tailscale serve` proxies to a loopback-bound
	// server, and `tailscale funnel` does the same thing from the open internet.
	const seen: string[] = [];
	const running = runWeb("#!/bin/sh\nsleep 8\n", "any", 7000, (line) => seen.push(line), undefined, ["--no-auth"]);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const port = new URL(url).port;

	assert.equal((await fetch(url)).status, 200, "loopback is what --no-auth opens");
	// fetch will not let a caller set Host — it is a forbidden header there — so ask directly.
	assert.equal(await statusWithHost(Number(port), `box.tail1234.ts.net:${port}`), 403, "a tailnet name is not");
	await running;
});

test("--no-auth is refused when the front end is put on the network", { timeout: 30_000 }, async () => {
	// The two flags are individually reasonable and together mean an unauthenticated shell that
	// anything on the network can reach.
	const { code, output } = await runWeb("#!/bin/sh\nsleep 5\n", "any", 5000, undefined, undefined, ["--host", "0.0.0.0", "--no-auth"]);
	assert.equal(code, 1);
	assert.match(output, /--no-auth is refused with --host/);

	// And written the other way, which used to parse as "no --host at all" and sail past the check.
	const equals = await runWeb("#!/bin/sh\nsleep 5\n", "any", 5000, undefined, undefined, ["--host=0.0.0.0", "--no-auth"]);
	assert.equal(equals.code, 1, `--host=addr is the same flag, got:\n${equals.output}`);
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
	const seen: string[] = [];
	const running = runWeb(sessionAwarePi(current, log), "any", 9000, (line) => seen.push(line), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(dir, "loops", "web-token"), "utf8").trim();
	const get = async (p: string) => (await fetch(`${url}${p}?token=${token}`)).json();
	const post = async (p: string, b: unknown) => (await fetch(`${url}${p}?token=${token}`, { method: "POST", body: JSON.stringify(b) })).json();
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
	await running;
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
	const seen: string[] = [];
	const running = runWeb(sessionAwarePi(current, path.join(dir, "sent.jsonl")), "any", 9000, (line) => seen.push(line), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(dir, "loops", "web-token"), "utf8").trim();
	const list = (await (await fetch(`${url}sessions?token=${token}`)).json()) as any;
	const entry = list.sessions.find((s: any) => path.basename(s.file) === "01a0-wide.jsonl");
	assert.ok(entry, `the long session is listed; got ${JSON.stringify(list.sessions)}`);
	assert.equal(entry.truncated, true, "the window is bytes, so a CJK session past it is a floor");
	await running;
});

test("a session is not swapped out from under a turn that is running", { timeout: 30_000 }, async () => {
	// The swap aborts the turn. Finding that out afterwards, having lost the reply you were waiting
	// for, is the failure this refusal exists to prevent — and it is here rather than only in the
	// page so that a tab left open across an upgrade cannot skip it.
	const dir = tmp("pi-loops-web-");
	const sessions = tmp("pi-loops-sessions-");
	const current = writeSession(sessions, "01a0-busy", "mid turn", new Date());
	const seen: string[] = [];
	const running = runWeb(sessionAwarePi(current, path.join(dir, "sent.jsonl"), true), "any", 8000, (line) => seen.push(line), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(dir, "loops", "web-token"), "utf8").trim();
	const answer = await (await fetch(`${url}session/new?token=${token}`, { method: "POST", body: "{}" })).json();
	assert.equal(answer.success, false);
	assert.match(answer.error, /a turn is running/);
	await running;
});

test("a command typed while a turn is running reaches pi as one it can run", { timeout: 30_000 }, async () => {
	// Answering "busy" with pi's `follow_up` command refused every extension command, in pi's own
	// words — `Extension command "/inbox" cannot be queued. Use prompt() or execute the command when
	// not streaming.` — while the same line typed into the terminal ran at once. `prompt` with a
	// streamingBehavior is the one command that carries both halves: an extension command runs
	// immediately, ordinary text queues. That is the line docs/web-ui-parity.md promises.
	const dir = tmp("pi-loops-web-");
	const log = path.join(dir, "sent.jsonl");
	const seen: string[] = [];
	const running = runWeb(sessionAwarePi(path.join(dir, "s.jsonl"), log, true, {}, ["inbox", "pi-loops"]), "any", 8000, (line) => seen.push(line), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(dir, "loops", "web-token"), "utf8").trim();

	// A slash command the session has never heard of is refused before this route is reached, so
	// wait for the front end to have heard of this one rather than racing its startup.
	const completes = async () => (((await (await fetch(`${url}complete?token=${token}`, { method: "POST", body: JSON.stringify({ text: "/in" }) })).json()) as any).items ?? []) as any[];
	for (let i = 0; i < 60 && !(await completes()).some((c) => c.value === "/inbox"); i++) await new Promise((r) => setTimeout(r, 100));
	assert.ok((await completes()).some((c) => c.value === "/inbox"), "the front end knows /inbox, so it is sent rather than refused as a name it does not have");

	const send = async (body: unknown) => (await (await fetch(`${url}prompt?token=${token}`, { method: "POST", body: JSON.stringify(body) })).json()) as any;
	assert.equal((await send({ text: "/inbox", mode: "follow_up" })).success, true, "a command sent while a turn is running is accepted");
	assert.equal((await send({ text: "/inbox" })).success, true, "so is one the page sent believing pi was idle");
	const carryOn = await send({ text: "carry on", mode: "follow_up" });
	assert.equal(carryOn.success, true, "ordinary text still goes through");

	const sent = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
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
	await running;
});

test("the compact button can steer what the summary keeps", { timeout: 30_000 }, async () => {
	// `/compact <instructions>` in the terminal; the browser had no way to say it at all, and a
	// summary you cannot steer is one you undo by hand afterwards.
	const dir = tmp("pi-loops-web-");
	const log = path.join(dir, "sent.jsonl");
	const seen: string[] = [];
	const running = runWeb(sessionAwarePi(path.join(dir, "s.jsonl"), log), "any", 8000, (line) => seen.push(line), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(dir, "loops", "web-token"), "utf8").trim();
	await fetch(`${url}compact?token=${token}`, { method: "POST", body: JSON.stringify({ instructions: "keep the API shapes" }) });
	await fetch(`${url}compact?token=${token}`, { method: "POST", body: "{}" });
	const compactions = fs
		.readFileSync(log, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l))
		.filter((m) => m.type === "compact");
	assert.equal(compactions[0].customInstructions, "keep the API shapes", "what to keep reaches pi");
	assert.equal("customInstructions" in compactions[1], false, "and plain compaction stays plain");
	await running;
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
	const seen: string[] = [];
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
	const running = runWeb(answering, "any", 8000, (line) => seen.push(line), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(loops, "web-token"), "utf8").trim();
	const state = (await (await fetch(`${url}state?token=${token}`)).json()) as any;
	const listed = state.automation.jobs.map((j: any) => j.id);

	// A job whose cwd is two levels below the deepest existing directory — a removed worktree — is
	// still this project's: the panel resolves as much of the path as exists, the way `/cron` does.
	// One level up was not enough, and this job was dropped into the other-projects count.
	assert.deepEqual(listed, ["cron-linked", "cron-worktree-gone"], `the linked project's jobs are this project's; got ${JSON.stringify(listed)}`);
	// The card shows the skipped-overlap count the terminal panel and `/cron` print. It leaves the
	// store on this same payload, so the page never has to work out a number the scheduler owns.
	assert.equal(state.automation.jobs.find((j: any) => j.id === "cron-linked")?.skippedOverlap, 3, "the panel is handed the skipped-overlap count the terminal prints");
	// `/cron` says `+ <all - here> jobs in other projects`, counting jobs and nothing else; this is
	// the same subtraction, and the rules are their own number beside it rather than added in.
	assert.deepEqual(state.automation.elsewhere, { jobs: 2, rules: 1 }, "and what it cannot show is counted, jobs and rules apart");
	await running;
});

test("with nothing running loops, the panel promises no next run, says paused, and still shows the last run and check", { timeout: 30_000 }, async () => {
	// Loops run in the background now. Stopped, the panel kept showing "next 09:00" from next-runs.json
	// (a window writes it while no background process runs), and the last run's line was gone because
	// runs no longer reach the window's session.
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
	const seen: string[] = [];
	const running = runWeb(chattyPi(project, []), "any", 6000, (line) => seen.push(line), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(loops, "web-token"), "utf8").trim();
	const a = ((await (await fetch(`${url}state?token=${token}`)).json()) as any).automation;
	const job = a.jobs.find((j: any) => j.id === "cron-a");
	assert.equal(job?.next, undefined, `no next run while nothing runs it; got ${JSON.stringify(job)}`);
	assert.match(job.asleep ?? "", /^paused: pi-loops is not running/);
	assert.equal(a.paused, "pi-loops is not running");
	assert.deepEqual(a.lastRun, { label: "nightly", ok: true, at: finished, findings: 2 });
	assert.deepEqual(a.lastCheck, { state: "completed", at: "2026-10-30T10:00:00.000+00:00" }, "rule checks run in the background: the panel reads the last one from the audit");
	await running;
});

test("this chat's own plain job runs in the window, so the panel does not call it paused", { timeout: 30_000 }, async () => {
	const dir = tmp("pi-loops-web-");
	const work = tmp("pi-loops-proj-");
	const loops = path.join(dir, "loops");
	fs.mkdirSync(loops, { recursive: true });
	const current = writeSession(work, "01a0-own", "the session", new Date());
	fs.writeFileSync(path.join(loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [{ id: "cron-p", schedule: { kind: "every", ms: 3600_000 }, stateful: false, prompt: "p", cwd: work, sessionId: "s1", enabled: true, catchUp: false, createdAt: new Date().toISOString(), runCount: 0, skippedOverlap: 0 }] }));
	const log = path.join(dir, "sent.jsonl");
	const seen: string[] = [];
	const running = runWeb(sessionAwarePi(current, log), "any", 6000, (line) => seen.push(line), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(loops, "web-token"), "utf8").trim();
	const a = ((await (await fetch(`${url}state?token=${token}`)).json()) as any).automation;
	assert.equal(a.paused, undefined, "nothing here waits for the background process");
	assert.equal(a.jobs[0].asleep, undefined, "and the job is this chat's own");
	await running;
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

	const seen: string[] = [];
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
	const running = runWeb(answering, "any", 8000, (line) => seen.push(line), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(loops, "web-token"), "utf8").trim();
	const state = (await (await fetch(`${url}state?token=${token}`)).json()) as any;
	const byId = Object.fromEntries(state.automation.jobs.map((j: any) => [j.id, j.next]));

	assert.equal(byId["cron-soon"], soon, "a cron expression now has a next run at all");
	assert.equal(byId["cron-stale"], undefined, "and a stale answer is shown as none rather than as a past time");
	await running;
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

	const seen: string[] = [];
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
	const running = runWeb(answering, "any", 8000, (line) => seen.push(line), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(loops, "web-token"), "utf8").trim();
	const state = (await (await fetch(`${url}state?token=${token}`)).json()) as any;
	const job = state.automation.jobs.find((j: any) => j.id === "cron-secret");

	assert.ok(job, "the job reached /state");
	assert.equal(job.prompt.includes(key), false, "the key in the prompt is masked");
	assert.equal(job.lastError.includes(err), false, "and so is the one in the error");
	assert.match(job.prompt, /tail a slice would have dropped/, "and the prompt is whole, not cut at ninety");
	await running;
});

test("the escape hatch cannot be used to skip a route's own guards", { timeout: 30_000 }, async () => {
	// /rpc exists so anything in pi's protocol this front end has not grown a button for is still
	// reachable. It also made every guard optional: `{"type":"switch_session"}` posted here went
	// straight to pi, skipping the mid-turn refusal, the "one of this project's sessions" check and
	// the epoch/backlog/pending-dialog reset the attached browsers are owed.
	const dir = tmp("pi-loops-web-");
	const log = path.join(dir, "sent.jsonl");
	const seen: string[] = [];
	const running = runWeb(sessionAwarePi(path.join(dir, "s.jsonl"), log), "any", 8000, (line) => seen.push(line), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(dir, "loops", "web-token"), "utf8").trim();
	const rpc = async (body: unknown) => (await (await fetch(`${url}rpc?token=${token}`, { method: "POST", body: JSON.stringify(body) })).json()) as any;

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
	await running;
});

test("a signed-in browser reloading a stale pairing code does not spend a guess", { timeout: 30_000 }, async () => {
	// Twenty guesses is the whole of the pairing budget, and checking one spends it. That check used
	// to run before the cookie was looked at, so a signed-in tab reloading a bookmark that still
	// carried an old ?pair= burned a try each time — and twenty reloads left the phone in the next
	// room unable to get in at all, with nothing on screen to explain it.
	const dir = tmp("pi-loops-web-");
	const seen: string[] = [];
	const running = runWeb("#!/bin/sh\nsleep 9\n", "any", 8000, (line) => seen.push(line), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(dir, "loops", "web-token"), "utf8").trim();
	const code = (await (await fetch(`${url}pair?token=${token}`, { method: "POST" })).json()).code as string;
	const wrong = code === "000000" ? "111111" : "000000";

	// A browser that is already in, reloading an address that still has a wrong code on it.
	for (let i = 0; i < 25; i++) {
		const r = await fetch(`${url}?token=${token}&pair=${wrong}`);
		assert.equal(r.status, 200, "the token is what lets it in, and it still does");
	}
	// The code the phone is holding is still the code.
	assert.equal((await fetch(`${url}?pair=${code}`)).status, 200, "the pairing budget was never touched");
	await running;
});

test("a credential in pi's dying words does not reach the page", { timeout: 30_000 }, async () => {
	// A provider that refuses to authenticate is one of the commonest reasons pi exits at all, and
	// what it prints on the way out is the key it was refused with. That tail is broadcast to every
	// attached browser — so the one event whose whole job is to explain a failure was the one event
	// that could carry a secret out of this process.
	const dir = tmp("pi-loops-web-");
	const seen: string[] = [];
	const key = `sk-${"a".repeat(32)}`;
	const dying = `#!/bin/sh\nsleep 2\necho 'auth failed for ${key} (Bearer ${"b".repeat(24)})' >&2\nexit 1\n`;
	const running = runWeb(dying, "any", 9000, (line) => seen.push(line), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(dir, "loops", "web-token"), "utf8").trim();

	// A browser attached to the stream, the way the page is, waiting for whatever pi says last.
	let events = "";
	await new Promise<void>((resolve) => {
		const req = http.get(`${url}events?token=${token}`, (res) => {
			res.on("data", (d) => {
				events += d.toString();
			});
			res.on("end", () => resolve());
			res.on("error", () => resolve());
		});
		req.on("error", () => resolve());
		// The server leaves half a second after pi does; this outlives both.
		setTimeout(resolve, 6000);
	});
	await running;

	assert.match(events, /pi_exit/, `the page is told pi went; got:\n${events.slice(-400)}`);
	assert.match(events, /auth failed/, "and told why, which is the point of the event");
	assert.doesNotMatch(events, /sk-aaaa/, "without the key it was refused with");
	assert.match(events, /\[REDACTED\]/, "masked rather than dropped, so the line still reads");
	// The terminal that started this still has the whole of it: that is what a terminal is for.
	assert.match(seen.join(""), /sk-aaaa/, "the unredacted line is on this process's own stderr");
});

test("pi's dying words are cut by characters, and the cut says how much it dropped", { timeout: 30_000 }, async () => {
	// The server cut the tail to 4000 UTF-16 code units on the way out, so the page's own cap — which
	// counts characters and appends "… (N chars)" — could never fire: it was always handed 4000 code
	// units or fewer, and code points are never more numerous than code units. The cut counted units,
	// so it could also begin on the low half of an astral character, which the browser draws as a
	// replacement glyph where the error should start. docs/web-ui-parity.md:96-101.
	const dir = tmp("pi-loops-web-");
	const seen: string[] = [];
	// 5000 characters, 5001 code units, the rocket across the 4000-from-the-end boundary — where a cut
	// counted in code units begins on its low half. A tail longer than STDERR_KEEP would put the split
	// at the 8000-unit keep boundary, which the 4000-unit send cut then discards whole; this length
	// keeps it in the part that is actually served.
	const line = `${"z".repeat(1000)}🚀${"y".repeat(3999)}`;
	const running = runWeb(`#!/bin/sh\nsleep 2\nprintf '%s\\n' '${line}' >&2\nexit 1\n`, "any", 9000, (l) => seen.push(l), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(dir, "loops", "web-token"), "utf8").trim();

	// The event happens when pi dies, not before: `replayEvents` settles 400ms after the last data,
	// which is right for a backlog and wrong here. Read the stream the way the page does, then parse
	// the one line — JSON, because a lone surrogate is escaped on the wire and only reappears parsed.
	let raw = "";
	await new Promise<void>((resolve) => {
		const req = http.get(`${url}events?token=${token}`, (res) => {
			res.on("data", (d) => {
				raw += d.toString();
			});
			res.on("end", () => resolve());
			res.on("error", () => resolve());
		});
		req.on("error", () => resolve());
		setTimeout(resolve, 6000);
	});
	await running;
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
});

test("pi's dying words past the kept tail count everything dropped, and the kept tail is cut by characters", { timeout: 30_000 }, async () => {
	// 9000 rockets: 18 000 code units. The kept tail (8000) cut in code units left 4000 characters,
	// which went out whole with no marker and began on the low half of a rocket. The marker counted
	// only what it cut from the kept tail, so it said 4040 however much pi had written.
	const dir = tmp("pi-loops-web-");
	const seen: string[] = [];
	const running = runWeb(`#!/bin/sh\nsleep 2\nprintf '%s\\n' '${"🚀".repeat(9000)}' >&2\nexit 1\n`, "any", 9000, (l) => seen.push(l), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(dir, "loops", "web-token"), "utf8").trim();
	let raw = "";
	await new Promise<void>((resolve) => {
		const req = http.get(`${url}events?token=${token}`, (res) => {
			res.on("data", (d) => {
				raw += d.toString();
			});
			res.on("end", () => resolve());
			res.on("error", () => resolve());
		});
		req.on("error", () => resolve());
		setTimeout(resolve, 6000);
	});
	await running;
	const exitLine = raw
		.split("\n")
		.filter((l) => l.startsWith("data: ") && l.includes('"pi_exit"'))
		.pop();
	assert.ok(exitLine, `the page is told pi went; got:\n${raw.slice(-300)}`);
	const exit = JSON.parse(exitLine.slice(6));
	// 9000 written, 3960 shown.
	assert.match(exit.stderr, /^… \(5040 chars dropped\)\n/, "the count is of everything pi wrote, not of the kept tail");
	assert.doesNotMatch(exit.stderr, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, "and no cut lands on half a character");
});

test("a key that lands across the cut is masked, not halved", { timeout: 30_000 }, async () => {
	// The tail was cut to 4000 characters *before* it was redacted, so a key straddling the cut lost
	// the `sk-` prefix the pattern needs — no match, and the second half of the key went out to every
	// attached browser. Redacting the whole kept tail first is the only order that holds.
	const dir = tmp("pi-loops-web-");
	const seen: string[] = [];
	const key = `sk-${"a".repeat(32)}`;
	// Placed so the 4000-character cut falls fifteen characters into the key.
	const line = `${"p".repeat(1000)}${key}${"q".repeat(3980)}`;
	const running = runWeb(`#!/bin/sh\nsleep 2\necho '${line}' >&2\nexit 1\n`, "any", 9000, (l) => seen.push(l), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(dir, "loops", "web-token"), "utf8").trim();

	let events = "";
	await new Promise<void>((resolve) => {
		const req = http.get(`${url}events?token=${token}`, (res) => {
			res.on("data", (d) => {
				events += d.toString();
			});
			res.on("end", () => resolve());
			res.on("error", () => resolve());
		});
		req.on("error", () => resolve());
		setTimeout(resolve, 6000);
	});
	await running;

	assert.match(events, /pi_exit/, `the page is told pi went; got:\n${events.slice(-200)}`);
	assert.doesNotMatch(events, /a{20}/, "no part of the key leaves this process");
	assert.match(events, /\[REDACTED\]/, "it was masked where it was");
});

test("--allow-host admits the name you put in front of it, and no other", { timeout: 30_000 }, async () => {
	// Behind a reverse proxy the Host is the proxy's name, which no rule here can derive — so it is
	// named on the command line, and until now the flag that does it was missing from --help.
	const dir = tmp("pi-loops-web-");
	const seen: string[] = [];
	const running = runWeb("#!/bin/sh\nsleep 8\n", "any", 7000, (line) => seen.push(line), dir, ["--allow-host", "pi.example.test,box.local"]);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const port = Number(new URL(url).port);
	const token = fs.readFileSync(path.join(dir, "loops", "web-token"), "utf8").trim();

	assert.equal(await statusWithHost(port, `pi.example.test:${port}`, `/?token=${token}`), 200, "the name that was named gets in");
	assert.equal(await statusWithHost(port, "BOX.LOCAL", `/?token=${token}`), 200, "whatever case it arrives in");
	assert.equal(await statusWithHost(port, `pi.example.test.evil.example:${port}`, `/?token=${token}`), 403, "and a name that merely starts with one does not");
	assert.equal(await statusWithHost(port, `other.example.test:${port}`, `/?token=${token}`), 403, "nor any other name");
	// And the flag is in --help, because a flag that relaxes a security check and is not documented
	// is a flag nobody can audit.
	assert.match(readFileSync(webSource, "utf8"), /--allow-host <n,…>\s+accept these Host values/, "--help says it exists");
	await running;
});

/** The front end with exactly the flags given: `runWeb` supplies a `--port` of its own, which is
 * the one thing a test about `--port` cannot have. */
function runWebRaw(args: string[]): Promise<{ code: number | null; output: string }> {
	const dir = tmp("pi-loops-web-");
	const fake = path.join(dir, "fakepi");
	fs.writeFileSync(fake, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [WEB, "--no-open", ...args], {
			env: { ...process.env, PI_BIN: fake, PI_LOOPS_DIR: path.join(dir, "loops") },
		});
		let output = "";
		const take = (d: Buffer) => {
			output += d.toString();
		};
		child.stdout.on("data", take);
		child.stderr.on("data", take);
		const timer = setTimeout(() => child.kill("SIGTERM"), 4000);
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve({ code, output });
		});
	});
}

test("a --port that is not a number is refused rather than quietly served somewhere else", { timeout: 30_000 }, async () => {
	// It used to fall back to 4173, so the address in the terminal was not the address that was asked
	// for and the reason was nowhere — the same class of silence as `--host=0.0.0.0` parsing as no
	// --host at all.
	const bad = await runWebRaw(["--port", "41773x"]);
	assert.equal(bad.code, 1, `it leaves rather than serving; got:\n${bad.output}`);
	assert.match(bad.output, /--port takes a number from 0 to 65535/);
	const huge = await runWebRaw(["--port=99999"]);
	assert.equal(huge.code, 1, `and a number no socket can take is one of those; got:\n${huge.output}`);
	assert.match(huge.output, /--port takes a number from 0 to 65535/);
	// `--port` with nothing after it is the same mistake and used to be the same silence: 4173.
	const empty = await runWebRaw(["--port"]);
	assert.equal(empty.code, 1, `a flag that takes a value and has none is refused; got:\n${empty.output}`);
	assert.match(empty.output, /--port takes a number from 0 to 65535; got nothing/);
	// A port that is a port still binds, which is the other half of the claim.
	const good = await runWebRaw(["--port", "0"]);
	assert.match(good.output, /web on http:\/\/127\.0\.0\.1:\d+\//, `a real port is served; got:\n${good.output}`);
});

test("the routes that only read are only read from", { timeout: 30_000 }, async () => {
	// /state, /history and /stats answered any method, so a form post from anywhere the Sec-Fetch-Site
	// check does not reach — curl, an older browser — could drive them. They are GETs; say so.
	const dir = tmp("pi-loops-web-");
	const seen: string[] = [];
	const running = runWeb(sessionAwarePi(path.join(dir, "s.jsonl"), path.join(dir, "sent.jsonl")), "any", 8000, (line) => seen.push(line), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(dir, "loops", "web-token"), "utf8").trim();

	for (const route of ["state", "history", "stats"]) {
		assert.equal((await fetch(`${url}${route}?token=${token}`)).status, 200, `${route} reads`);
		const posted = await fetch(`${url}${route}?token=${token}`, { method: "POST", body: "{}" });
		assert.equal(posted.status, 404, `${route} is not a route you post to`);
	}
	await running;
});

/**
 * A stand-in pi that records what it was signalled with, in a file rather than on stderr.
 *
 * Its stderr goes through the front end, and the front end is what these tests are stopping — so a
 * line it prints on the way out could be lost to the very exit under test. A file cannot be.
 */
function signalLoggingPi(log: string): string {
	return [
		"#!/usr/bin/env node",
		'const fs = require("node:fs");',
		`const say = (line) => fs.appendFileSync(${JSON.stringify(log)}, line + "\\n");`,
		// SIGINT is noted and survived: pi itself has no handler for it, and what matters here is
		// whether the signal arrives at all.
		'process.on("SIGINT", () => say("sigint"));',
		// Slow on purpose. pi's real shutdown hands the clock to a headless host and waits for it to
		// record itself, and a front end that does not wait would print nothing about that.
		'process.on("SIGTERM", () => { say("sigterm"); setTimeout(() => { say("exit"); process.exit(0); }, 500); });',
		// `start` is the readiness line the tests wait for, so it goes last: a test that signals on
		// seeing it must know the handlers above are installed. Logged first, a loaded runner could
		// deliver SIGTERM (web.mjs turning its Ctrl-C into one) between the write and the handler —
		// fatal by default, so `sigterm` never appears and the test measures node's startup instead.
		// Node has no getpgid, so ask the system; `ps -o pgid=` is the same flag on Linux and macOS.
		'say("start pid=" + process.pid + " pgid=" + require("node:child_process").execSync("ps -o pgid= -p " + process.pid).toString().trim());',
		"setInterval(() => {}, 1e9);",
		"",
	].join("\n");
}

/** The front end in a process group of its own, so a group signal here is a terminal's Ctrl-C. */
function runWebDetached(dir: string, log: string, script = signalLoggingPi(log)) {
	const fake = path.join(dir, "fakepi");
	fs.writeFileSync(fake, script, { mode: 0o755 });
	const seen: string[] = [];
	const child = spawn(process.execPath, [WEB, "--port", "0", "--no-open"], {
		env: { ...process.env, PI_BIN: fake, PI_LOOPS_DIR: path.join(dir, "loops") },
		detached: true,
	});
	child.stdout.on("data", (d: Buffer) => seen.push(d.toString()));
	child.stderr.on("data", (d: Buffer) => seen.push(d.toString()));
	const exited = new Promise<{ code: number | null; at: number }>((resolve) => child.on("exit", (code) => resolve({ code, at: Date.now() })));
	return { child, seen, exited };
}

/** Which process group a pid is in. Node cannot say; `ps -o pgid=` is the same flag on Linux and macOS. */
function pgidOf(pid: number): number {
	return Number(execSync(`ps -o pgid= -p ${pid}`).toString().trim());
}

/** Wait until the stand-in pi has written the line being waited for. */
async function logged(log: string, re: RegExp): Promise<string> {
	for (const deadline = Date.now() + 8000; Date.now() < deadline; ) {
		const text = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
		if (re.test(text)) return text;
		await new Promise((r) => setTimeout(r, 25));
	}
	return fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
}

test("the pi behind the page runs in a process group of its own", { timeout: 30_000, skip: process.platform === "win32" ? "process groups are POSIX" : false }, async () => {
	// The group is the whole point: a terminal's Ctrl-C is delivered to every process in the
	// foreground group, and pi has no SIGINT handler — so a pi in this group dies of it instantly,
	// before the front end can ask it to quit, and the hand-off to the headless host never happens.
	const dir = tmp("pi-loops-web-");
	const log = path.join(dir, "signals.log");
	const { child, seen, exited } = runWebDetached(dir, log);
	assert.ok(await addressOf(seen), `it announced a URL, got:\n${seen.join("")}`);
	const started = await logged(log, /^start /m);
	const m = /start pid=(\d+) pgid=(\d+)/.exec(started);
	assert.ok(m, `the stand-in pi said where it is, got:\n${started}`);
	assert.equal(m[1], m[2], "pi leads a group of its own");
	assert.notEqual(Number(m[2]), pgidOf(child.pid!), "which is not the one the front end is in");

	child.kill("SIGTERM");
	await exited;
});

test("Ctrl-C in that terminal ends the session the way /quit does, and waits for it", { timeout: 30_000, skip: process.platform === "win32" ? "process groups are POSIX" : false }, async () => {
	// Found by pressing it: the hand-off line never appeared and `pi-loops status` showed no
	// host, because pi had already been killed by the same SIGINT rather than asked to quit. Now the
	// signal reaches only this process, which turns it into the SIGTERM pi does handle — and waits,
	// so pi's own word about the hand-off is still relayed to the terminal that asked to stop.
	const dir = tmp("pi-loops-web-");
	const log = path.join(dir, "signals.log");
	const { child, seen, exited } = runWebDetached(dir, log);
	assert.ok(await addressOf(seen), `it announced a URL, got:\n${seen.join("")}`);
	await logged(log, /^start /m);

	// What a terminal does, to the group the launcher and the front end share.
	process.kill(-child.pid!, "SIGINT");
	const { code } = await exited;
	const text = fs.readFileSync(log, "utf8");

	assert.doesNotMatch(text, /sigint/, "the group's SIGINT never reached pi");
	assert.match(text, /sigterm/, "it was asked to quit instead");
	assert.match(text, /exit/, "and it finished quitting");
	// Read after the front end is gone: if it had exited first, this line would not be here yet.
	assert.match(text.split("\n").filter(Boolean).at(-1) ?? "", /^exit$/, "the front end left only once pi had");
	assert.equal(code, 0, "and left quietly");
});

/**
 * A stand-in pi that quits the way pi's rpc mode does — exit 143 on SIGTERM — and, on the way out,
 * does one of the two things that tell the front end what became of the automation: writes a
 * `host.json` naming a live process, or emits the hand-off note as the notification event pi's own
 * `ctx.ui.notify` becomes in that mode.
 *
 * The record names its parent, which is the front end itself: the one pid a test can be sure is
 * still alive when the record is read. `start` goes to the log because the signal under test has to
 * arrive after this process installed its handler — otherwise SIGTERM is simply fatal, and the test
 * would be measuring node's startup.
 */
function quittingPi(log: string, opts: { loopsDir?: string; note?: string }): string {
	return [
		"#!/usr/bin/env node",
		'const fs = require("node:fs"), os = require("node:os"), path = require("node:path");',
		"process.on('SIGTERM', () => {",
		...(opts.loopsDir
			? [
					`  fs.mkdirSync(${JSON.stringify(opts.loopsDir)}, { recursive: true });`,
					`  fs.writeFileSync(path.join(${JSON.stringify(opts.loopsDir)}, "host-service.json"), JSON.stringify({ v: 1, pid: process.ppid, startedAt: new Date().toISOString(), node: process.version }));`,
				]
			: []),
		...(opts.note ? [`  process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "n1", method: "notify", message: ${JSON.stringify(opts.note)}, notifyType: "info" }) + "\\n");`] : []),
		"  setTimeout(() => process.exit(143), 20);",
		"});",
		`fs.appendFileSync(${JSON.stringify(log)}, "start\\n");`,
		"setInterval(() => {}, 1e9);",
		"",
	].join("\n");
}

test("Ctrl-C says the automation keeps running in the background", { timeout: 30_000, skip: process.platform === "win32" ? "process groups are POSIX" : false }, async () => {
	// Loops run in the always-on host, which outlives this window; the terminal said only
	// `pi exited (143)`, and whoever pressed the key was not told their automation was still
	// running, nor where. The loops directory is read, the way `pi-loops status` reads it.
	const dir = tmp("pi-loops-web-");
	const log = path.join(dir, "signals.log");
	const { child, seen, exited } = runWebDetached(dir, log, quittingPi(log, { loopsDir: path.join(dir, "loops") }));
	assert.ok(await addressOf(seen), `it announced a URL, got:\n${seen.join("")}`);
	await logged(log, /^start/m);

	process.kill(-child.pid!, "SIGINT");
	const { code } = await exited;
	const text = seen.join("");

	assert.match(text, /pi exited \(143\)/, "pi's own exit is still reported as it was");
	// Read after the front end has gone, so the line was written before it left rather than lost with it.
	assert.match(text, /automation keeps running in the background \(pid \d+\); pi-loops status \| stop/, `and where it is, got:\n${text}`);
	assert.equal(code, 0, "and it left quietly");
});

test("pi's own word on the way out reaches the terminal when it arrives in time", { timeout: 30_000, skip: process.platform === "win32" ? "process groups are POSIX" : false }, async () => {
	// A notification arriving while pi quits has nowhere else to go, and relaying it is how the
	// terminal gets pi's own wording instead of the front end's approximation of it. Said once:
	// the directory is not consulted at all when pi has already spoken.
	const dir = tmp("pi-loops-web-");
	const log = path.join(dir, "signals.log");
	const note = "[cron] pi-loops (pid 4242) keeps running; /pi-loops stop ends it";
	const { child, seen, exited } = runWebDetached(dir, log, quittingPi(log, { note }));
	assert.ok(await addressOf(seen), `it announced a URL, got:\n${seen.join("")}`);
	await logged(log, /^start/m);

	process.kill(-child.pid!, "SIGINT");
	await exited;
	const text = seen.join("");

	assert.match(text, /pi-loops \(pid 4242\) keeps running/, `pi's own line was relayed, got:\n${text}`);
	assert.doesNotMatch(text, /automation keeps running in the background/, "and not said twice in two different ways");
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
	const seen: string[] = [];
	const running = runWeb(sessionAwarePi(current, log, false, session), "any", 9000, (line) => seen.push(line), dir);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(dir, "loops", "web-token"), "utf8").trim();
	const post = async (p: string, b: unknown) => (await fetch(`${url}${p}?token=${token}`, { method: "POST", body: JSON.stringify(b) })).json();
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
	await running;
});

/* ------------------------------------------------------------------ the browser path: a message is a request (design §5) */

/** The front end over a stand-in pi, kept until the test ends it: `stop()` is Ctrl-C, which takes pi down with it. */
async function startWeb(dir: string, piScript: string) {
	const fake = path.join(dir, `fakepi-${randomUUID().slice(0, 8)}`);
	fs.writeFileSync(fake, piScript, { mode: 0o755 });
	const seen: string[] = [];
	const child = spawn(process.execPath, [WEB, "--port", "0", "--no-open"], { env: { ...process.env, PI_BIN: fake, PI_LOOPS_DIR: path.join(dir, "loops") } });
	child.stdout.on("data", (d: Buffer) => seen.push(d.toString()));
	child.stderr.on("data", (d: Buffer) => seen.push(d.toString()));
	const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	const token = fs.readFileSync(path.join(dir, "loops", "web-token"), "utf8").trim();
	const post = async (p: string, b: unknown) => (await (await fetch(`${url}${p}?token=${token}`, { method: "POST", body: JSON.stringify(b) })).json()) as any;
	const state = async () => (await (await fetch(`${url}state?token=${token}`)).json()) as any;
	const stop = async () => {
		child.kill("SIGTERM");
		await exited;
	};
	return { child, url, token, post, state, stop, seen, pid: child.pid! };
}

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
	const web = await startWeb(dir, sessionAwarePi(path.join(dir, "s.jsonl"), log, false));
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
	const web = await startWeb(dir, sessionAwarePi(path.join(dir, "s.jsonl"), log, false, {}, ["pi-loops"]));
	try {
		const answer = await web.post("prompt", { text: "anyone?", images: [{ type: "image", data: "AAAA", mimeType: "image/png" }] });
		assert.deepEqual([answer.success, answer.elsewhere], [true, undefined], "a holder that will not deliver is not 'answered there'");
		assert.equal((await web.state()).requests[0]?.stuck, undefined, "fresh: nothing to say yet");
		ageRow(dir, answer.queued, PAST_UNTAKEN_MS);
		assert.deepEqual((await web.state()).requests[0]?.stuck, { pid: process.pid, line: `not taken by pi ${process.pid} (shows an older copy of this conversation)`, button: "send it here instead" });
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
		// After Stop, a message queued before it waits for the person on purpose: not untaken.
		const held = await web.post("prompt", { text: "after this, stop" });
		assert.equal((await web.post("abort", {})).success, true);
		ageRow(dir, held.queued, PAST_UNTAKEN_MS);
		assert.equal((await web.state()).requests.find((r: any) => r.id === held.queued)?.stuck, undefined, "held after Stop, not untaken");
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
	const web = await startWeb(dir, sessionAwarePi(path.join(dir, "s.jsonl"), log, false, {}, ["pi-loops"], pidFile));
	try {
		// The front end announces its address before the pi it spawned has run a line.
		for (const end = Date.now() + 5_000; !fs.existsSync(pidFile) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 25));
		const piPid = Number(fs.readFileSync(pidFile, "utf8"));
		const leases = new LeaseStore(loops);
		const own = { kind: "terminal" as const, pid: piPid, instance: "page-pi", acquiredAt: new Date().toISOString(), mode: "rpc" as const, pushServers: [] };
		assert.ok("lease" in leases.acquire("s1", own, { cwd: dir }));
		assert.equal(leases.setAside("s1", own, 1), true);
		const answer = await web.post("prompt", { text: "hello?" });
		assert.deepEqual([answer.success, answer.elsewhere, answer.aside], [true, undefined, { pid: piPid }], "the page is told its own pi stands aside");
		ageRow(dir, answer.queued, PAST_UNTAKEN_MS);
		assert.deepEqual((await web.state()).requests[0]?.stuck, { pid: piPid, line: `not taken by pi ${piPid} (this page's pi shows an older copy of this conversation; /resume to see it)` }, "no offer: anything written now branches the conversation");
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
	const web = await startWeb(dir, sessionAwarePi(path.join(dir, "s.jsonl"), log, false, {}, ["pi-loops"]));
	try {
		const answer = await web.post("prompt", { text: "still there?" });
		assert.deepEqual(answer.elsewhere, { pid: process.pid }, "answered there, as before");
		ageRow(dir, answer.queued, PAST_UNTAKEN_MS);
		const stuck = (await web.state()).requests[0]?.stuck;
		assert.deepEqual(stuck, { pid: process.pid, line: `pi ${process.pid} holds this conversation and has not taken it yet (it may be busy)`, button: `answer here instead (a branch pi ${process.pid} will not see)` });
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
	const web = await startWeb(dir, sessionAwarePi(path.join(dir, "s.jsonl"), log, false, {}, { file: commandsFile }));
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
	const first = await startWeb(dir, sessionAwarePi(path.join(dir, "s.jsonl"), path.join(dir, "sent-1.jsonl"), true, {}, ["pi-loops"]));
	const long = "keep this ".repeat(50).trim();
	const answer = await first.post("prompt", { text: long });
	assert.equal(answer.success, true);
	assert.equal(rowsOf(dir)[0]?.created_by.pid, first.pid, "the row names the page that wrote it");
	await first.stop();
	assert.equal(rowsOf(dir).length, 1, "pi exited with the message queued: it is still in the file");

	const log2 = path.join(dir, "sent-2.jsonl");
	const next = await startWeb(dir, sessionAwarePi(path.join(dir, "s.jsonl"), log2, false, {}, ["pi-loops"]));
	try {
		const listed = (await next.state()).requests;
		assert.deepEqual(listed.map((r: any) => [r.id, r.label, r.text, r.offered, r.mine]), [[answer.queued, "you", long, true, false]], "offered: not sent before pi stopped, with the whole text, since send vouches for all of it");
		assert.deepEqual(ringsIn(log2), [], "and rung for by nobody");
		// Discard is a cancel row; send makes it this page's and rings for it.
		assert.equal((await next.post("queue/send", { id: answer.queued })).success, true);
		const row = rowsOf(dir).find((r) => r.id === answer.queued)!;
		assert.equal(row.created_by.pid, next.pid, "sent: the row is this page's now");
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

test("after Stop, queued requests wait for the next input", { timeout: 30_000 }, async () => {
	// docs/web-ui-parity.md: after Stop, nothing queued starts a turn until you send again. Stop is
	// rpc `abort` and nothing else: the page rings for nothing, so the rows stay where the holder's
	// hold keeps them (test/engine.test.ts: after Stop, the person's queued rows wait until they send
	// again), and "send queued" is the one thing that rings for them.
	const dir = tmp("pi-loops-web-");
	const log = path.join(dir, "sent.jsonl");
	const web = await startWeb(dir, sessionAwarePi(path.join(dir, "s.jsonl"), log, true, {}, ["pi-loops"]));
	try {
		const a = await web.post("prompt", { text: "first" });
		const b = await web.post("prompt", { text: "second" });
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(ringsIn(log).length, 2, "each send rings once");
		assert.equal((await web.post("abort", {})).success, true);
		await new Promise((r) => setTimeout(r, 200));
		const after = sentTo(log);
		assert.equal(after.at(-1)?.type, "abort", "Stop is pi's abort");
		assert.equal(ringsIn(log).length, 2, "and rings for nothing");
		assert.deepEqual(rowsOf(dir).map((r) => r.id), [a.queued, b.queued], "the queue is untouched: the holder's hold decides when it runs");
		assert.deepEqual((await web.state()).requests.map((r: any) => [r.label, r.text, r.mine]), [["you", "first", true], ["you", "second", true]]);
		assert.deepEqual(await web.post("queue/send", {}), { success: true, sent: a.queued }, "send queued: the oldest of this page's rows");
		await new Promise((r) => setTimeout(r, 200));
		const row = rowsOf(dir)[0];
		assert.deepEqual(rowsOf(dir).map((r) => typeof r.released_at), ["string", "string"], "released: a holder this page cannot ring (a terminal) reads it off the rows");
		assert.equal(ringsIn(log).at(-1), `/pi-loops ring ${row.id} ${requestFingerprint(row)}`, "rung for again, which is the person's input");
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
	const web = await startWeb(dir, sessionAwarePi(path.join(dir, "s.jsonl"), log, false, {}, ["pi-loops"]));
	try {
		const { queued } = await web.post("prompt", { text: "hello?", images: [{ type: "image", data: "AAAA", mimeType: "image/png" }] });
		assert.equal((await web.state()).requests.length, 1, "queued, with nothing wrong yet");
		new RequestStore(path.join(dir, "loops")).update("s1", queued, { attempts: 1, last_error: "pi did not start a turn for it" });
		assert.deepEqual((await web.state()).requests, [], "taken out of the queue");
		assert.equal(rowsOf(dir).length, 0, "and out of the file");
		const audit = new TriggerStore(path.join(dir, "loops")).listAudit(5, (r) => r.type === "request" && r.traceId === queued);
		assert.deepEqual(audit.map((r) => r.state), ["failed"]);
		const events = await replayEvents(`${web.url}events?token=${web.token}`);
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
	const web = await startWeb(dir, sessionAwarePi(path.join(dir, "s.jsonl"), log, false, {}, ["pi-loops"]));
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
