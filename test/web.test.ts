import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const WEB = path.join(process.cwd(), "src", "web.mjs");

/** Run the front end against a stand-in for pi, and collect everything it printed. */
function runWeb(piScript: string, port: number | "any", ms = 4000, onLine?: (line: string) => void, reuseDir?: string, extra: string[] = []): Promise<{ code: number | null; output: string }> {
	const dir = reuseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-web-"));
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

test("a pi that starts is served, and one visit is enough for that browser", { timeout: 30_000 }, async () => {
	// `sleep` stands in for a pi that is up but has nothing to say: enough to prove the server binds
	// and answers, without a model call.
	// A free port, not a chosen one: a fixed port is a fight with whatever else is on this machine,
	// and losing it makes the test flaky rather than making it fail honestly.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-web-"));
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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-web-"));
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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-web-"));
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
	await first;
});

/** One GET, with a Host header of our choosing: the thing every rebinding check is actually about. */
function statusWithHost(port: number, host: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path: "/", method: "GET", headers: { host } }, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("error", reject);
		req.end();
	});
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

test("--no-auth serves the page with nothing to carry", { timeout: 30_000 }, async () => {
	const seen: string[] = [];
	const running = runWeb("#!/bin/sh\nsleep 8\n", "any", 7000, (line) => seen.push(line), undefined, ["--no-auth"]);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	assert.match(seen.join(""), /--no-auth/, "and said what that means");
	assert.equal((await fetch(url)).status, 200, "the bare address is the whole of it");
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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-web-"));
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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-web-"));
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

test("a file the session made can be looked at, and nothing else can", { timeout: 30_000 }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-web-"));
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-work-"));
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
	assert.match(html.headers.get("content-security-policy") ?? "", /sandbox/);
	assert.equal(html.headers.get("x-content-type-options"), "nosniff");

	assert.equal((await get("../../etc/passwd")).status, 403, "not out of the directory");
	assert.equal((await get("/etc/passwd")).status, 403, "not by absolute path either");
	assert.equal((await get("secrets")).status, 415, "and not a kind of file this shows");
	assert.equal((await fetch(`${url}file?path=chart.png`)).status, 403, "and not without the token");
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
