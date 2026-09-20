import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import { execSync, spawn } from "node:child_process";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

test("--no-auth serves the page with nothing to carry", { timeout: 30_000 }, async () => {
	const seen: string[] = [];
	const running = runWeb("#!/bin/sh\nsleep 8\n", "any", 7000, (line) => seen.push(line), undefined, ["--no-auth"]);
	const url = await addressOf(seen);
	assert.ok(url, `it announced a URL, got:\n${seen.join("")}`);
	assert.ok(await printed(seen, /--no-auth/), `and said what that means, got:\n${seen.join("")}`);
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
	const running = runWeb(sessionAwarePi(current, log), "any", 9000, (line) => seen.push(line), dir);
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
	const lastPrompt = () => sent().filter((m) => m.type === "prompt").pop()?.message ?? "";

	// The page is told the session's directory and anchors to it, which is what `/state` is for.
	await fetch(`${url}state?token=${token}`);

	assert.equal(((await post("prompt", { text: "@probe.txt" })) as any).success, true);
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
function sessionAwarePi(sessionFile: string, log: string, streaming = false, session: { entries?: unknown[]; leafId?: string } = {}, commands: string[] = []): string {
	return [
		"#!/usr/bin/env node",
		'const fs = require("node:fs");',
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
		'    if (m.type === "set_model") model = { provider: m.provider, id: m.modelId };',
		"    const data =",
		`      m.type === "get_state" ? { cwd: ${JSON.stringify(path.dirname(sessionFile))}, sessionId: "s1", sessionFile: file, isStreaming: ${streaming}, model }`,
		`      : m.type === "get_commands" ? { commands: ${JSON.stringify(commands)}.map((name) => ({ name, description: name + " does something", source: "extension" })) }`,
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
	const running = runWeb(sessionAwarePi(path.join(dir, "s.jsonl"), log, true, {}, ["inbox"]), "any", 8000, (line) => seen.push(line), dir);
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
	assert.equal((await send({ text: "carry on", mode: "follow_up" })).success, true, "ordinary text still goes through");

	const sent = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const prompts = sent.filter((m) => m.type === "prompt" && m.message === "/inbox");
	assert.equal(prompts.length, 2, "both reached pi as prompts");
	assert.deepEqual(prompts.map((m) => m.streamingBehavior), ["followUp", "followUp"], "each asking pi to queue it if a turn is still running");
	assert.equal(sent.some((m) => m.type === "follow_up" || m.type === "steer"), false, "never as a command that refuses an extension command");
	const queued = sent.find((m) => m.message === "carry on");
	assert.equal(queued.type, "prompt", "ordinary text is the same command");
	assert.equal(queued.streamingBehavior, "followUp", "queued rather than refused when pi is still streaming");
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
	const job = (id: string, cwd: string) => ({
		id, schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "p", cwd,
		enabled: true, catchUp: true, createdAt: new Date().toISOString(), runCount: 0, skippedOverlap: 0,
	});
	fs.writeFileSync(
		path.join(loops, "jobs.json"),
		JSON.stringify({ version: 2, jobs: [job("cron-linked", project), job("cron-home", os.homedir()), job("cron-elsewhere", path.join(real, "another"))] }),
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

	assert.deepEqual(listed, ["cron-linked"], `the linked project's job is this project's; got ${JSON.stringify(listed)}`);
	// `/cron` says `+ <all - here> jobs in other projects`, counting jobs and nothing else; this is
	// the same subtraction, and the rules are their own number beside it rather than added in.
	assert.deepEqual(state.automation.elsewhere, { jobs: 2, rules: 1 }, "and what it cannot show is counted, jobs and rules apart");
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
		// Node has no getpgid, so ask the system; `ps -o pgid=` is the same flag on Linux and macOS.
		'say("start pid=" + process.pid + " pgid=" + require("node:child_process").execSync("ps -o pgid= -p " + process.pid).toString().trim());',
		// SIGINT is noted and survived: pi itself has no handler for it, and what matters here is
		// whether the signal arrives at all.
		'process.on("SIGINT", () => say("sigint"));',
		// Slow on purpose. pi's real shutdown hands the clock to a headless host and waits for it to
		// record itself, and a front end that does not wait would print nothing about that.
		'process.on("SIGTERM", () => { say("sigterm"); setTimeout(() => { say("exit"); process.exit(0); }, 500); });',
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
	// Found by pressing it: the hand-off line never appeared and `pi-loops host status` showed no
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
					`  fs.writeFileSync(path.join(${JSON.stringify(opts.loopsDir)}, "host.json"), JSON.stringify({ pid: process.ppid, host: os.hostname(), startedAt: new Date().toISOString(), node: process.version }));`,
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

test("Ctrl-C says where the automation went, when pi's own note never arrives", { timeout: 30_000, skip: process.platform === "win32" ? "process groups are POSIX" : false }, async () => {
	// The live failure this fixes: pi did hand the clock over — `pi-loops host status` showed the host
	// — and the terminal said only `pi exited (143)`. pi-loops announces the hand-off through
	// `ctx.ui.notify`, and `ctx.hasUI` is true in rpc mode: pi binds a real UI context there, whose
	// notify is an event addressed to the page. The page's server is the process on its way out, and
	// rpc mode does not flush stdout on SIGTERM either — so whoever pressed the key was not told
	// their automation was still running, nor where. The loops directory is read instead, the way
	// `pi-loops host status` reads it.
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
	assert.match(text, /automation handed to a background host \(pid \d+\); pi-loops host status \| stop/, `and where it went, got:\n${text}`);
	assert.equal(code, 0, "and it left quietly");
});

test("pi's own word on the hand-off reaches the terminal when it arrives in time", { timeout: 30_000, skip: process.platform === "win32" ? "process groups are POSIX" : false }, async () => {
	// A notification arriving while pi quits has nowhere else to go, and relaying it is how the
	// terminal gets pi's own wording — the pid, what it is keeping running, the command that ends it
	// — instead of the front end's approximation of it. Said once: there is no host.json here, and
	// the directory is not consulted at all when pi has already spoken.
	const dir = tmp("pi-loops-web-");
	const log = path.join(dir, "signals.log");
	const note = "[cron] handed the clock to a background host (pid 4242; 2 loop(s), 0 rule(s), 0 push source(s)); /cron host stop ends it";
	const { child, seen, exited } = runWebDetached(dir, log, quittingPi(log, { note }));
	assert.ok(await addressOf(seen), `it announced a URL, got:\n${seen.join("")}`);
	await logged(log, /^start/m);

	process.kill(-child.pid!, "SIGINT");
	await exited;
	const text = seen.join("");

	assert.match(text, /handed the clock to a background host \(pid 4242/, `pi's own line was relayed, got:\n${text}`);
	assert.doesNotMatch(text, /automation handed to a background host/, "and not said twice in two different ways");
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
