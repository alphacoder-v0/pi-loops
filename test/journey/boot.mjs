import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// The sandbox PATH has no npm and its pi is a link, so pi's package is found here, outside it, the
// way pi-loops finds it (a managed install, then the global one), and named to the sandbox directly.
const { piPackage } = await import(pathToFileURL(path.join(repo, "src", "pi-resolver.mjs")).href);
export const DEFAULT_REPLY = "pong from the stand-in";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const commandPath = (name) => {
	const result = spawnSync("sh", ["-c", "command -v \"$1\"", "sh", name], { encoding: "utf8", timeout: 10000 });
	return result.status === 0 ? result.stdout.trim() : undefined;
};
export function cleanBrowserEnv() {
	return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/proxy/i.test(key) && !/_(?:KEY|TOKEN|SECRET)$/i.test(key)));
}
function printSurvivors(survivors, root) {
	for (const pid of survivors) process.stderr.write(`SURVIVOR ${pid} in ${root}\n`);
}
function startToken(pid) {
	if (process.platform === "linux") {
		try { const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(") ") + 2).split(/\s+/)[19]; } catch { return undefined; /* process exited before its start token was read */ }
	}
	const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 10000 });
	if (result.error || result.status !== 0) return undefined;
	return result.stdout.trim() || undefined;
}
const sameProcess = (pid, token) => token !== undefined && startToken(pid) === token;
const executable = (name) => {
	const found = commandPath(name);
	if (!found) throw Object.assign(new Error(`MISSING ${name}`), { missing: name });
	return found;
};
const request = (url) => new Promise((resolve) => {
	http.get(url, (res) => { res.resume(); resolve(res.statusCode); }).on("error", () => resolve(0)); /* a page that is still binding is not a boot failure */
});
const sessionAlive = (tmuxBin, tmux, env) => spawnSync(tmuxBin, ["-L", tmux.socket, "has-session", "-t", tmux.session], { env, stdio: "ignore", timeout: 10000 }).status === 0;

function markerPids(root, runId, browserSession) {
	const markers = [`PI_JOURNEY_RUN=${runId}`, ...(browserSession ? [`AGENT_BROWSER_SESSION=${browserSession}`] : [])];
	const found = new Set();
	const diagnostic = [];
	if (process.platform === "linux") {
		for (const entry of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
			const pid = Number(entry);
			if (pid === process.pid) continue;
			try {
				const state = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0];
				const env = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
				if (state !== "Z" && markers.some((marker) => env.includes(marker))) found.add(pid);
				else {
					const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
					const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
					if (cwd.startsWith(`${root}/`) || args.includes(root)) diagnostic.push({ pid, cmd: args });
				}
			} catch { /* process exited during the scan */ }
		}
		return { found, diagnostic };
	}
	const result = spawnSync("ps", ["-axwwEo", "pid=,command="], { encoding: "utf8", timeout: 10000, maxBuffer: 64 << 20 });
	if (result.error) throw result.error;
	for (const line of (result.stdout ?? "").split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(.*)$/);
		if (!match) continue;
		const pid = Number(match[1]);
		if (pid === process.pid) continue;
		if (markers.some((marker) => match[2].includes(marker))) found.add(pid);
		// -E puts the environment in this column; report only the program so no secret reaches the output.
		else if (match[2].includes(root)) diagnostic.push({ pid, cmd: match[2].split(/\s+/)[0] });
	}
	return { found, diagnostic };
}

export async function sweep(root, runId, browserSession) {
	const deadline = Date.now() + 5000;
	const diagnostic = new Map();
	let found = new Set();
	let emptyScans = 0;
	while (Date.now() < deadline) {
		const scan = markerPids(root, runId, browserSession);
		found = scan.found;
		for (const match of scan.diagnostic) diagnostic.set(match.pid, match.cmd);
		for (const pid of found) try { process.kill(pid, "SIGKILL"); } catch { /* process exited after the marker scan */ }
		if (found.size) {
			emptyScans = 0;
			await sleep(100);
			continue;
		}
		emptyScans++;
		if (emptyScans === 2) break;
		await sleep(300);
	}
	found = markerPids(root, runId, browserSession).found;
	return { survivors: [...found], diagnostic: [...diagnostic].map(([pid, cmd]) => ({ pid, cmd })) };
}

function pidAlive(pid) {
	try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

/** Where tmux keeps `-L` sockets for this user. */
function tmuxSocketDir() {
	return path.join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`);
}

/**
 * What journey runs whose harness process is gone left behind, named `journey-<pid>-<run>`: tmux
 * sockets, and agent-browser's per-session files. A run cut short leaves both.
 */
function removeStaleSessionFiles() {
	const tmuxBin = commandPath("tmux");
	for (const [dir, isTmux] of [[tmuxSocketDir(), true], [path.join(os.homedir(), ".agent-browser"), false]]) {
		let names = [];
		try { names = fs.readdirSync(dir); } catch { continue; /* the tool was never run here */ }
		for (const name of names) {
			const pid = Number(/^journey-(\d+)-/.exec(name)?.[1]);
			if (!pid || pidAlive(pid)) continue; // a harness that is still running owns its files
			if (isTmux && tmuxBin) spawnSync(tmuxBin, ["-L", name, "kill-server"], { stdio: "ignore", timeout: 10000 });
			fs.rmSync(path.join(dir, name), { force: true });
		}
	}
}

export async function reapStale(outRoot) {
	removeStaleSessionFiles();
	if (!fs.existsSync(outRoot)) return;
	for (const sha of fs.readdirSync(outRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
		const shaDir = path.join(outRoot, sha.name);
		for (const journey of fs.readdirSync(shaDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
			const sandbox = path.join(shaDir, journey.name, "sandbox");
			const recordFile = path.join(sandbox, "harness.json");
			if (!fs.existsSync(recordFile)) continue;
			let record;
			try { record = JSON.parse(fs.readFileSync(recordFile, "utf8")); } catch { continue; /* incomplete harness record is left for boot() to refuse */ }
			if (sameProcess(record.pid, record.startToken)) continue;
			if (record.stopped) continue;
			if (record.browserSession) closeBrowser(record.browserSession);
			const report = await sweep(sandbox, record.runId, record.browserSession);
			if (report.survivors.length) {
				printSurvivors(report.survivors, sandbox);
				continue;
			}
			fs.rmSync(sandbox, { recursive: true, force: true });
		}
	}
}

function closeBrowser(session) {
	const browserBin = commandPath("agent-browser");
	if (browserBin) spawnSync(browserBin, ["--session", session, "close"], { env: cleanBrowserEnv(), stdio: "ignore", timeout: 10000 });
}

export async function boot({ out, against, page = "new", tui = false, reply = DEFAULT_REPLY, seed, runId = randomUUID(), signal }) {
	const node = executable("node");
	const pi = executable("pi");
	const git = executable("git");
	const tmuxBin = tui ? executable("tmux") : commandPath("tmux");
	fs.mkdirSync(out, { recursive: true });
	const root = fs.realpathSync(out);
	const entries = fs.readdirSync(root);
	const recordFile = path.join(root, "harness.json");
	let previous;
	if (entries.length) {
		if (!fs.existsSync(recordFile)) throw new Error(`refusing to clear non-empty out without harness.json: ${root}`);
		previous = JSON.parse(fs.readFileSync(recordFile, "utf8"));
		if (sameProcess(previous.pid, previous.startToken)) throw new Error(`journey sandbox is still owned by pid ${previous.pid}`);
		if (previous.browserSession) closeBrowser(previous.browserSession);
		const report = await sweep(root, previous.runId, previous.browserSession);
		if (report.survivors.length) { printSurvivors(report.survivors, root); throw new Error("stale journey sandbox still has marked processes"); }
		for (const name of fs.readdirSync(root)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
	}
	const dirs = Object.fromEntries(["home", "agent", "loops", "project", "bin", "logs", "product"].map((name) => [name, path.join(root, name)]));
	const browserSession = `journey-${process.pid}-${runId}`;
	const ownerStart = startToken(process.pid);
	if (!ownerStart) throw new Error("cannot read this process start token");
	const record = { pid: process.pid, startToken: ownerStart, runId, browserSession };
	fs.writeFileSync(recordFile, JSON.stringify(record));
	for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
	spawnSync(git, ["init", "-q"], { cwd: dirs.project, stdio: "ignore", timeout: 10000 });
	const seeded = seed ? await seed(dirs) : undefined;
	if (against) {
		const archive = spawnSync(git, ["archive", against], { cwd: repo, encoding: null, maxBuffer: 128 * 1024 * 1024 });
		if (archive.status !== 0) throw new Error(`git archive ${against} failed: ${archive.stderr?.toString()}`);
		const extracted = spawnSync("tar", ["-x", "-C", dirs.product], { input: archive.stdout, maxBuffer: 128 * 1024 * 1024 });
		if (extracted.status !== 0) throw new Error("could not unpack product archive");
	} else copyHeadProduct(git, dirs.product);
	for (const tool of [node, pi, git, ...(tmuxBin ? [tmuxBin] : []), ...["rg", "fd"].map(commandPath).filter(Boolean)]) {
		const target = path.join(dirs.bin, path.basename(tool));
		if (!fs.existsSync(target)) fs.symlinkSync(tool, target);
	}
	const cli = path.join(dirs.product, "src", "cli-entry.mjs");
	const shim = path.join(dirs.bin, "pi-loops");
	fs.writeFileSync(shim, `#!/bin/sh\nexec ${quote(node)} ${quote(cli)} "$@"\n`, { mode: 0o755 });
	const env = {
		HOME: dirs.home, PI_CODING_AGENT_DIR: dirs.agent, PI_LOOPS_DIR: dirs.loops,
		XDG_CONFIG_HOME: path.join(dirs.home, ".config"), XDG_CACHE_HOME: path.join(dirs.home, ".cache"),
		XDG_DATA_HOME: path.join(dirs.home, ".local", "share"), XDG_STATE_HOME: path.join(dirs.home, ".local", "state"),
		PATH: `${dirs.bin}:/usr/bin:/bin`, TERM: "xterm-256color", LANG: "C.UTF-8", TZ: "UTC",
		PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_LOOPS_HOST_MODEL: "fake/fake-model",
		NO_PROXY: "127.0.0.1,localhost", PI_JOURNEY_RUN: runId, PI_LOOPS_PI_PACKAGE: piPackage(),
	};
	throwIfAborted(signal);
	const portFile = path.join(root, "model.port");
	const model = spawn(node, [path.join(repo, "test/downstream/fake-model.mjs"), portFile], { cwd: dirs.project, env: { ...env, FAKE_MODEL_REPLY: reply, FAKE_MODEL_LOG: path.join(dirs.logs, "model.jsonl"), ...(seeded?.modelEnv ?? {}) }, stdio: "ignore" });
	let modelError;
	model.on("error", (error) => { modelError = error; });
	const bootMs = Date.now();
	let tmux;
	let pageProcess;
	let stopPromise;
	const stop = () => stopPromise ??= (async () => {
		closeBrowser(browserSession);
		if (pageProcess && pageProcess.exitCode === null) {
			try { process.kill(-pageProcess.pid, "SIGTERM"); } catch { /* launched detached, but the group may already be gone */ }
		}
		if (tmux) spawnSync(tmuxBin, ["-L", tmux.socket, "kill-server"], { env, stdio: "ignore", timeout: 10000 });
		if (pageProcess) await waitChildExit(pageProcess, 5000);
		await sleep(300);
		let tmuxFailed = false;
		if (tmux) {
			try { await until(() => !sessionAlive(tmuxBin, tmux, env), 5000, "tmux session did not stop"); }
			catch { tmuxFailed = true; /* sweep below retries any marker-owned tmux process */ }
		}
		spawnSync(shim, ["stop"], { cwd: dirs.project, env, stdio: "ignore", timeout: 10000 });
		if (model.exitCode === null) {
			try { model.kill("SIGTERM"); } catch { /* stand-in exited before its stop signal */ }
		}
		await waitChildExit(model, 5000);
		const result = await sweep(root, runId, browserSession);
		const report = tmuxFailed ? { ...result, survivors: [...result.survivors, "tmux session"] } : result;
		printSurvivors(report.survivors, root);
		// Its server is gone, but `kill-server` leaves the socket file: 180 of them had piled up.
		if (tmux && !report.survivors.length) fs.rmSync(path.join(tmuxSocketDir(), tmux.socket), { force: true });
		fs.writeFileSync(recordFile, JSON.stringify({ ...record, stopped: true }));
		return report;
	})();
	try {
		await until(() => { if (modelError) throw modelError; return fs.existsSync(portFile); }, 10000, "stand-in model did not start", signal);
		fs.writeFileSync(path.join(dirs.agent, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${fs.readFileSync(portFile, "utf8").trim()}/v1`, api: "openai-completions", apiKey: "fake", models: [{ id: "fake-model" }] } } }));
		throwIfAborted(signal);
		if (tui) {
			const socket = `journey-${process.pid}-${runId}`;
			const session = "main";
			const command = `${quote(shim)} --tui --no-extensions -e ${quote(dirs.product)} --model fake/fake-model`;
			spawnSync(tmuxBin, ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", session, "-c", dirs.project, command], { cwd: dirs.project, env, stdio: "ignore", timeout: 10000 });
			tmux = { socket, session };
			await until(() => sessionAlive(tmuxBin, tmux, env), 15000, "terminal did not start", signal);
			await until(() => fs.existsSync(path.join(dirs.loops, "logs")) && fs.readdirSync(path.join(dirs.loops, "logs")).some((name) => fs.readFileSync(path.join(dirs.loops, "logs", name), "utf8").includes("session start:")), 15000, "terminal extension did not start", signal);
			throwIfAborted(signal);
			spawnSync(tmuxBin, ["-L", socket, "send-keys", "-t", session, "-l", "hello from terminal"], { env, stdio: "ignore", timeout: 10000 });
			await sleep(500);
			throwIfAborted(signal);
			spawnSync(tmuxBin, ["-L", socket, "send-keys", "-t", session, "Enter"], { env, stdio: "ignore", timeout: 10000 });
			await until(() => fs.existsSync(path.join(dirs.loops, "leases")) && fs.readdirSync(path.join(dirs.loops, "leases")).some((name) => {
				try { const lease = JSON.parse(fs.readFileSync(path.join(dirs.loops, "leases", name), "utf8")); return lease.holder?.kind === "terminal" && lease.sessionFile && fs.existsSync(lease.sessionFile); } catch { return false; /* lease may be rewritten while pi starts */ }
			}), 45000, "terminal exchange did not create a session", signal);
		}
		throwIfAborted(signal);
		const pageLog = path.join(dirs.logs, "page.log");
		const resident = residentPage(dirs.product);
		pageProcess = startPage(dirs, { env, page, resident }, sessionIdFor(dirs));
		const output = await collect(pageProcess, 45000, "page did not become ready", signal, pageLog, resident ? READY_RESIDENT : READY_LEGACY);
		const address = output.match(resident ? READY_RESIDENT : READY_LEGACY);
		if (!address) throw new Error(`page failed to start: ${output}`);
		const url = address[1];
		const pageUrl = resident ? address[0].slice("pi-loops: ".length) : url;
		const token = fs.readFileSync(path.join(dirs.loops, "web-token"), "utf8").trim();
		await until(async () => await request(`${url}?token=${token}`) === 200, 45000, "page did not answer authenticated GET", signal);
		const launcher = pageProcess;
		return { url, pageUrl, token, tmux, loopsDir: dirs.loops, project: dirs.project, stop, closeSession: () => closeBrowser(browserSession), bootMs: Date.now() - bootMs, env, root, sessionId: sessionIdFor(dirs), product: dirs.product, browserSession, pageExitCode: () => launcher.exitCode };
	} catch (error) {
		await stop();
		throw error;
	}
}

function sessionIdFor(dirs) {
	if (!fs.existsSync(path.join(dirs.loops, "leases"))) return undefined;
	for (const file of fs.readdirSync(path.join(dirs.loops, "leases"))) {
		try {
			const row = JSON.parse(fs.readFileSync(path.join(dirs.loops, "leases", file), "utf8"));
			if (row.holder?.kind === "terminal" && row.sessionFile && fs.existsSync(row.sessionFile)) return row.sessionId;
		} catch { /* lease file may be rewritten during session start */ }
	}
	return undefined;
}

/** The `pi-loops:` link line a resident page prints before `pi-loops` exits (`pi-loops page:` in 0.24.0); trees before it print `web on`. */
const READY_RESIDENT = /pi-loops(?: page)?: (http:\/\/127\.0\.0\.1:\d+\/)c\/[^/\s?]+\//;
const READY_LEGACY = /web on (http:\/\/127\.0\.0\.1:\d+\/)/;

/** Whether the product under test serves the page from pi-loops in the background (0.24 on). */
function residentPage(product) {
	return fs.existsSync(path.join(product, "src", "page-server.ts")) && !fs.existsSync(path.join(product, "src", "web-entry.mjs"));
}

function startPage(dirs, options, sessionId) {
	const piArgs = [...(options.page === "attach" && sessionId ? ["--session", sessionId] : []), "--no-extensions", "-e", dirs.product, "--model", "fake/fake-model"];
	const ours = options.resident ? ["--web", "--no-open"] : ["--web", "--port", "0", "--no-open"];
	return spawn(path.join(dirs.bin, "pi-loops"), [...ours, "--", ...piArgs], { cwd: dirs.project, env: options.env, stdio: ["ignore", "pipe", "pipe"], detached: true }); /* a legacy launcher and its page share one group to stop */
}

function copyHeadProduct(git, product) {
	const listing = spawnSync(git, ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: repo, encoding: null, maxBuffer: 32 * 1024 * 1024 });
	if (listing.status !== 0) throw new Error(`git ls-files failed: ${listing.stderr?.toString()}`);
	for (const rel of listing.stdout.toString().split("\0").filter(Boolean)) {
		const source = path.join(repo, rel);
		let stat;
		try { stat = fs.lstatSync(source); } catch { continue; /* tracked path was deleted from this checkout */ }
		const target = path.join(product, rel);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), target);
		else fs.copyFileSync(source, target);
	}
}

function throwIfAborted(signal) { if (signal?.aborted) throw signal.reason ?? new Error("interrupted"); }
async function until(probe, ms, reason, signal) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) { throwIfAborted(signal); if (await probe()) { throwIfAborted(signal); return; } await sleep(50); }
	throw new Error(reason);
}
function collect(child, ms, reason, signal, logFile, readyLine) {
	return new Promise((resolve, reject) => {
		let output = "";
		let ready = false;
		let settled = false;
		const done = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			if (error) reject(error); else resolve(output);
		};
		const take = (data) => {
			fs.appendFileSync(logFile, data);
			if (ready || settled) return;
			output += data.toString();
			if (readyLine.test(output)) { ready = true; done(); }
		};
		const abort = () => { child.kill("SIGTERM"); done(signal.reason ?? new Error("interrupted")); };
		child.stdout.on("data", take);
		child.stderr.on("data", take);
		child.once("error", (error) => done(error));
		child.once("close", () => { child.stdout.off("data", take); child.stderr.off("data", take); });
		const timer = setTimeout(() => { child.kill("SIGTERM"); done(new Error(`${reason}: ${output}`)); }, ms);
		/* `close`, not `exit`: a resident launcher exits once it has printed, and its last output can arrive after `exit` */
		child.once("close", (code) => { if (!ready) done(new Error(`${reason} (exit ${code}): ${output}`)); });
		if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
	});
}
function waitChildExit(child, ms) {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		function done() { clearTimeout(timer); child.off("close", done); resolve(); }
		child.once("close", done);
	});
}
function quote(text) { return `'${text.replaceAll("'", "'\\''")}'`; }

function usageError() { return Object.assign(new Error("usage: node test/journey/boot.mjs --out <dir> [--tui] [--page new|attach] [--once]"), { usage: true }); }

async function cli() {
	const argv = process.argv.slice(2);
	let out, page = "new", tui = false, once = false;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--out" && argv[i + 1]) out = argv[++i];
		else if (argv[i] === "--page" && ["new", "attach"].includes(argv[i + 1])) page = argv[++i];
		else if (argv[i] === "--tui") tui = true;
		else if (argv[i] === "--once") once = true;
		else throw usageError();
	}
	if (!out) throw usageError();
	const controller = new AbortController();
	const abort = () => controller.abort(new Error("interrupted"));
	process.once("SIGINT", abort);
	process.once("SIGTERM", abort);
	let instance;
	try { instance = await boot({ out, page, tui, signal: controller.signal }); }
	finally {
		process.off("SIGINT", abort);
		process.off("SIGTERM", abort);
	}
	console.log(`URL ${instance.url}`);
	console.log(`TOKEN ${instance.token}`);
	if (instance.tmux) console.log(`TMUX ${instance.tmux.socket} ${instance.tmux.session}`);
	console.log(`LOOPS ${instance.loopsDir}`);
	console.log(`PROJECT ${instance.project}`);
	console.log(`BOOTMS ${instance.bootMs}`);
	console.log("READY");
	if (once) {
		const report = await instance.stop();
		if (report.survivors.length) process.exitCode = 1;
		return;
	}
	await new Promise((resolve) => {
		const finish = async () => {
			const report = await instance.stop();
			if (report.survivors.length) process.exitCode = 1;
			resolve();
		};
		const handle = () => { void finish().catch((error) => { process.stderr.write(`${error?.message ?? error}\n`); process.exitCode = 1; resolve(); }); };
		process.once("SIGINT", handle);
		process.once("SIGTERM", handle);
	});
}

const entry = process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url;
if (entry) cli().catch((error) => {
	const interrupted = error?.message === "interrupted";
	if (error?.missing) process.stderr.write(`MISSING ${error.missing}: install ${error.missing}\n`);
	else process.stderr.write(`${error?.message ?? error}\n`);
	process.exitCode = error?.usage ? 2 : interrupted ? 130 : 1;
});

