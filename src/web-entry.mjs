#!/usr/bin/env node
// The browser front end for pi, as one process. `pi-loops` starts it; nobody runs it by path
// (`src/cli.ts` is what passes it a port, a loops directory and the rest of pi's args).
//
// Temporary: this is what is left of the old src/web.mjs process once the page moved out. The HTTP
// server is src/page-server.ts, the pi behind it src/page-children.ts, and the page itself
// src/web.mjs. This file parses the arguments, starts one pi, serves it, and takes pi with it on
// the way out.
//
// Loopback and a token by default. `--host` binds elsewhere for a phone on the same network.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { importTs } from "./ts-entry.mjs";

const { spawnPageChild } = await importTs(import.meta.url, "./page-children.ts");
const { lanAddresses, liveHostPid, readJson, ring, startPageServer, webToken } = await importTs(import.meta.url, "./page-server.ts");

/* ------------------------------------------------------------------ arguments */

/**
 * The version of this file, baked into the page it serves.
 *
 * A tab that has been open across an upgrade looks exactly like a current one — the panel even
 * shows a version, but that is the server's, read live. The page had no way to say how old *it*
 * was, which is how three rounds of "no reply appears" were spent on a page that could not have
 * received one. Now it says.
 */
const VERSION = (() => {
	try {
		return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "?";
	} catch {
		return "?"; // running from somewhere without the manifest; the comparison simply goes quiet
	}
})();

const argv = process.argv.slice(2);
const dashdash = argv.indexOf("--");
const ourArgs = dashdash === -1 ? argv : argv.slice(0, dashdash);
const piArgs = dashdash === -1 ? [] : argv.slice(dashdash + 1);
const flag = (name) => ourArgs.includes(`--${name}`);
const optionValue = (name, fallback) => {
	// Both spellings, because `--host=0.0.0.0` used to parse as "no --host at all" — which bound
	// loopback and skipped the refusal that goes with binding anywhere else.
	const eq = ourArgs.find((a) => a.startsWith(`--${name}=`));
	if (eq) return eq.slice(name.length + 3);
	const i = ourArgs.indexOf(`--${name}`);
	return i !== -1 && ourArgs[i + 1] ? ourArgs[i + 1] : fallback;
};
/**
 * A value-taking flag passed with nothing after it. `optionValue` falls back to the default, which
 * for `--port` meant `pi-loops --web --port` served on 4173 without a word — the same silence as a
 * port that is not a number, and it deserves the same refusal.
 */
const missingValue = (name) => {
	if (ourArgs.some((a) => a.startsWith(`--${name}=`))) return false;
	const i = ourArgs.indexOf(`--${name}`);
	const next = i === -1 ? undefined : ourArgs[i + 1];
	return i !== -1 && (next === undefined || next === "" || next.startsWith("--"));
};

if (flag("help")) {
	console.log(`pi-loops web — the browser front end for pi

  pi-loops --web [options] [-- <pi args>]

  --port <n>        port to serve on (default 4173; 0 takes any free one)
  --host <addr>     bind somewhere other than loopback, for a phone on the same network
  --allow-host <n,…>  accept these Host values, for a reverse proxy in front
  --loops-dir <p>   pi-loops directory for the automation panel (default $PI_LOOPS_DIR)
  --no-open         do not open a browser
  --help

Anything after -- goes to pi, e.g.  pi-loops --web -- --model anthropic/claude-opus-5`);
	process.exit(0);
}

// `--port 0` means "any free port"; the URL printed below is the
// one that was actually bound.
const portArg = missingValue("port") ? "" : String(optionValue("port", "4173"));
// Said out loud rather than fixed up. `--port 41773x` used to serve on 4173 instead, so the address
// in the terminal was not the address that was asked for and the reason was nowhere.
if (!/^\d+$/.test(portArg) || Number(portArg) > 65535) {
	console.error(`pi-loops web: --port takes a number from 0 to 65535; got ${portArg ? `"${portArg}"` : "nothing"}`);
	process.exit(1);
}
const PORT = Number(portArg);
// The directory the extension inside the pi behind this page uses (`defaultLoopsDir(getAgentDir())`,
// which this file cannot import): PI_LOOPS_DIR, else `loops` under pi's agent directory — moved by
// PI_CODING_AGENT_DIR, with a leading `~` expanded as pi expands it. Reading ~/.pi/agent/loops
// regardless put the panel, the token and the remembered model in a directory the session was not using.
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ? process.env.PI_CODING_AGENT_DIR.replace(process.platform === "win32" ? /^~(?=$|[\\/])/ : /^~(?=$|\/)/, os.homedir()) : path.join(os.homedir(), ".pi", "agent");
const LOOPS_DIR = optionValue("loops-dir", process.env.PI_LOOPS_DIR || path.join(AGENT_DIR, "loops"));

const TOKEN =
	process.env.PI_WEB_TOKEN ||
	webToken(LOOPS_DIR, (message) => {
		console.error(message);
		process.exit(1);
	});
/**
 * What to bind. Loopback by default, because the safe thing should not need to be asked for. A
 * phone cannot reach a loopback address at all, so `--host 0.0.0.0` (or a specific interface) is
 * how the front end gets onto your own network.
 */
const HOST_BIND = optionValue("host", "127.0.0.1");
const LOOPBACK = HOST_BIND === "127.0.0.1" || HOST_BIND === "::1" || HOST_BIND === "localhost";
// It is substituted into a JS string literal in the page and into a URL on the console, so what it
// may contain is not a matter of taste: a quote ends the literal early and the rest of the token
// becomes code. Say so at startup rather than serving a broken page.
if (!/^[A-Za-z0-9_-]{8,}$/.test(TOKEN)) {
	console.error("PI_WEB_TOKEN must be at least 8 characters of letters, digits, - or _");
	process.exit(1);
}

/* ------------------------------------------------------------------ going away */

/**
 * How long to wait for pi to finish quitting.
 *
 * SIGTERM to pi is not a kill, it is `/quit`: pi tears the session down, and pi-loops stops its
 * scheduler, drains its hooks (up to three seconds) and releases its conversation's lease. Fifteen
 * seconds is that path with room to spare; exiting first would leave the lease to be taken over from
 * a dead process rather than released.
 */
const PI_QUIT_WAIT_MS = 15_000;
let leaving = false;
/** Set when pi's own word on the shutdown reached the terminal, so nothing repeats it in other words. */
let relayedNote = false;

/**
 * pi's `ui.notify` while it is quitting, printed rather than only broadcast.
 *
 * An extension says something on the way out through `ctx.ui.notify`, and `ctx.hasUI` is true in rpc
 * mode: pi binds a real UI context there, whose `notify` is an `extension_ui_request` event on
 * stdout. So such a line went to the page — and the page's server is this process, on its way
 * out, with no browser left to draw it. The person who pressed Ctrl-C got `pi exited (143)` and no
 * word that their loops were still running somewhere.
 *
 * Only while leaving, and only for `notify`: a notification during a live session belongs to the
 * window, and a terminal echoing every one of them would be noise.
 */
function relayNote(msg) {
	if (!leaving || msg?.type !== "extension_ui_request" || msg.method !== "notify") return;
	const text = String(msg.message ?? "").trim();
	if (!text) return;
	relayedNote = true;
	console.error(text);
}

/**
 * Where the automation is, in one line, for the person who pressed Ctrl-C: loops and checks run in
 * the always-on host, which does not stop with this window, and a person who just closed it wants
 * to know that, and how to stop it. pi's own wording is preferred when it arrives (`relayNote`).
 * Silence when there is no host: then there was nothing running to tell anyone about.
 */
/** ": 2 loop(s), 1 rule(s), 1 plain job(s)", the machine's enabled work, for the line printed on the way out. */
function automationSummary() {
	const jobs = readJson(path.join(LOOPS_DIR, "jobs.json"), { jobs: [] }).jobs ?? [];
	const rules = readJson(path.join(LOOPS_DIR, "triggers.json"), { rules: [] }).rules ?? [];
	const loops = jobs.filter((j) => j && j.enabled && j.stateful).length;
	const plain = jobs.filter((j) => j && j.enabled && !j.stateful).length;
	const on = rules.filter((r) => r && r.enabled).length;
	const parts = [loops ? `${loops} loop(s)` : "", on ? `${on} rule(s)` : "", plain ? `${plain} plain job(s), each run a model turn` : ""].filter(Boolean);
	return parts.length ? `: ${parts.join(", ")}` : "";
}

/** Whether any loop or rule on this machine is enabled: something a background process would run. */
function enabledAutomation() {
	const jobs = readJson(path.join(LOOPS_DIR, "jobs.json"), { jobs: [] }).jobs ?? [];
	const rules = readJson(path.join(LOOPS_DIR, "triggers.json"), { rules: [] }).rules ?? [];
	return jobs.some((j) => j && j.enabled && j.stateful) || rules.some((r) => r && r.enabled);
}

function reportAutomation() {
	if (relayedNote) return;
	try {
		const pid = liveHostPid(LOOPS_DIR);
		if (pid) console.error(`automation keeps running in the background (pid ${pid})${automationSummary()}; pi-loops status | stop`);
		// Nothing runs them, and closing the window is when a person would notice that: say it.
		else if (enabledAutomation()) console.error(`automation is paused: ${child.live.runtime?.paused || "pi-loops is not running"}; pi-loops start runs it`);
	} catch (err) {
		// Reading the directory must not hold the exit: say what went wrong and go.
		console.error(`pi-loops web: could not tell whether automation is still running: ${err?.message ?? err}`);
	}
}

/**
 * Take the pi we started with us: it has no server in front of it and nobody to talk to.
 *
 * SIGTERM and then wait: pi's shutdown is where the clock is handed to a headless host, and a front
 * end that did not wait would exit before that happened and before anything could be said about it.
 * Bounded, because a pi wedged in shutdown must not leave a window that will not close.
 */
function leave(code) {
	if (leaving) return;
	leaving = true;
	if (!child.alive) process.exit(code);
	const timer = setTimeout(() => {
		console.error(`pi did not finish quitting in ${PI_QUIT_WAIT_MS / 1000}s; leaving anyway`);
		reportAutomation();
		process.exit(code);
	}, PI_QUIT_WAIT_MS);
	child.pi.once("exit", () => {
		clearTimeout(timer);
		// A moment for the last of pi's stdout before deciding what to say. The note is an event on
		// that pipe and `exit` fires while it may still be unread, so reporting straight away would
		// always fall back to reading the directory and never use pi's own wording. Bounded and
		// short: `close` — the process gone *and* its pipes drained — normally arrives in a tick.
		const done = () => {
			reportAutomation();
			process.exit(code);
		};
		const drain = setTimeout(done, 300);
		child.pi.once("close", () => {
			clearTimeout(drain);
			done();
		});
	});
	try {
		child.pi.kill("SIGTERM");
	} catch {
		// already gone, which is the outcome we wanted — its `exit` has fired or is about to
	}
}

function openBrowser(url) {
	const cmd = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
	try {
		spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true }).unref();
	} catch {
		/* a URL on stdout is enough */
	}
}

/* ------------------------------------------------------------------ pi, in rpc mode */

const child = spawnPageChild({
	command: process.env.PI_BIN || "pi",
	args: ["--mode", "rpc", ...piArgs],
	cwd: process.cwd(),
	env: process.env,
	version: VERSION,
	log: (line) => console.error(line),
	onExit: (code, signal) => {
		console.error(`pi exited (${signal || code})`);
		// Long enough for that event to reach an attached browser before this process goes with it.
		setTimeout(() => process.exit(code ?? 0), 500);
	},
	onError: () => process.exit(1),
	onNote: relayNote,
	ring: () => ring(child),
});

for (const sig of ["SIGINT", "SIGTERM"]) {
	// `leave` is the one place that decides what going away means; a second copy of it here is a
	// second place to forget something. Ctrl-C in the terminal that started the session arrives here
	// as SIGINT and goes down that one path — pi is detached, so this handler is the only thing that
	// ends it, and it ends it the way `/quit` does.
	process.on(sig, () => leave(0));
}

/* ------------------------------------------------------------------ http */

const server = await startPageServer({
	dir: LOOPS_DIR,
	bind: { host: HOST_BIND, port: PORT },
	allowHosts: String(optionValue("allow-host", "")).split(","),
	token: TOKEN,
	version: VERSION,
	child: () => child,
	log: (line) => console.error(line),
	/**
	 * The port is fixed on purpose — one address, bookmarkable — and the price of a fixed port is that
	 * you can collide with yourself. Running `pi-loops` twice is not a mistake worth an error message:
	 * the second one hands you the window the first one is already serving, and gets out of the way
	 * rather than leaving a second pi running behind a server that never bound.
	 */
	onListenError: (err) => {
		if (err?.code !== "EADDRINUSE") {
			console.error(`pi-loops web: cannot listen on port ${PORT}: ${err?.message ?? err}`);
			return void leave(1);
		}
		const there = `http://127.0.0.1:${PORT}/`;
		// No credentials on this request. Whatever is on that port might not be one of ours, and a
		// secret sent to find that out has already been sent. An instance of this program answers the
		// header on its 403 too, so the question can be asked without proving anything.
		fetch(there)
			.then((r) => {
				if (r.headers.get("x-pi-loops-web") !== "1") throw new Error("not ours");
				console.log(`pi-loops web is already running on ${there} — opening that`);
				// A browser asked for a URL it already has open answers by bringing that tab forward,
				// without reloading it — so starting the session again handed you the same page you were
				// already looking at, however old it was. A different address every time means the tab
				// is replaced rather than merely focused, which is the difference between "it opened"
				// and "it opened the version I just installed".
				if (!flag("no-open") && process.stdout.isTTY) openBrowser(`${there}?opened=${Date.now().toString(36)}`);
				leave(0);
			})
			.catch(() => {
				console.error(`pi-loops web: port ${PORT} is taken by something else; --port <n> picks another`);
				leave(1);
			});
	},
});

// The port actually bound, which is not the one asked for when that was 0.
const port = server.port();
console.log(`pi-loops web on ${server.url()}`);
if (!LOOPBACK) {
	for (const a of lanAddresses(port)) console.log(`  on this network: ${a.url}  (${a.via})`);
	// Worth saying once, out loud: this is plain http, and the cookie it hands out is a token
	// that outlives the process. `tailscale serve` gets the same phone in over TLS and leaves
	// this server on loopback, which is why the docs lead with it.
	console.log("  this is unencrypted; on a network you do not own, prefer: tailscale serve --bg " + port);
}
// The code is what another device actually uses: the door page asks for it, so nobody types 32
// hex characters on a screen keyboard. Printed on loopback too, because `tailscale serve` puts a
// phone in front of a loopback-bound server and that phone still has to get in once. On a
// terminal only — it stays live until someone pairs, so a log file holding it is a log file
// holding the way in. A browser that is already signed in can mint another through /pair.
if (process.stdout.isTTY) console.log(`  pairing code for another device: ${server.newPairCode()}`);
// Only needed by a browser that has not been here before; after one visit the cookie is enough.
// On a terminal only: this token outlives the process now, and stdout redirected to a file is a
// credential written to a file, where a per-launch random one used to expire on its own.
if (process.stdout.isTTY) console.log(`  first visit from another browser: http://127.0.0.1:${port}/?token=${TOKEN}`);
await child.refreshCatalog();
await child.primeRuntime();
if (!flag("no-open") && process.stdout.isTTY) {
	openBrowser(`http://127.0.0.1:${port}/?open=${server.armOpenKey()}`);
}
