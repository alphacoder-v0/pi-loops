import { spawn, spawnSync, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { randomUUID } from "node:crypto";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bin = (name) => {
	const result = spawnSync("sh", ["-c", "command -v \"$1\"", "sh", name], { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : undefined;
};
const executable = (name) => {
	const found = bin(name);
	if (!found) throw Object.assign(new Error(`MISSING ${name}`), { missing: name });
	return found;
};
const request = (url) => new Promise((resolve, reject) => {
	http.get(url, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject);
});
const descendants = (root, marker) => {
	const found = new Set();
	if (process.platform === "linux") {
		for (const name of fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
			const pid = Number(name);
			if (pid === process.pid || process.ppid === pid) continue;
			try {
				const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
				const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
				const env = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
				if (env.includes(marker) || cwd.startsWith(`${root}/`) || args.includes(root)) found.add(pid);
			} catch { /* process exited during the scan */ }
		}
		return found;
	}
	const listing = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout ?? "";
	for (const line of listing.split("\n")) {
		const m = line.trim().match(/^(\d+)\s+(.*)$/);
		if (m && Number(m[1]) !== process.pid && Number(m[1]) !== process.ppid && (m[2].includes(root) || m[2].includes(marker))) found.add(Number(m[1]));
	}
	return found;
};

export async function boot({ out, against, page = "new", tui = false, reply = "pong from the stand-in", seed }) {
	const node = executable("node");
	const pi = executable("pi");
	const git = executable("git");
	const tmuxBin = tui ? executable("tmux") : bin("tmux");
	const runId = randomUUID();
	const root = fs.realpathSync(out);
	const stale = fs.existsSync(path.join(root, "harness.json")) ? JSON.parse(fs.readFileSync(path.join(root, "harness.json"), "utf8")) : undefined;
	if (stale && stale.pid !== process.pid && !alive(stale.pid)) await sweep(root, stale.runId);
	for (const name of fs.readdirSync(root)) if (name !== "harness.json") fs.rmSync(path.join(root, name), { recursive: true, force: true });
	const dirs = Object.fromEntries(["home", "agent", "loops", "project", "bin", "logs", "product"].map((name) => [name, path.join(root, name)]));
	for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
	if (seed) await seed(dirs);
	fs.writeFileSync(path.join(root, "harness.json"), JSON.stringify({ pid: process.pid, runId }));
	if (against) {
		const archive = spawnSync(git, ["archive", against], { cwd: repo, encoding: null, maxBuffer: 128 * 1024 * 1024 });
		if (archive.status !== 0) throw new Error(`git archive ${against} failed: ${archive.stderr?.toString()}`);
		const tar = spawnSync("tar", ["-x", "-C", dirs.product], { input: archive.stdout });
		if (tar.status !== 0) throw new Error("could not unpack product archive");
	} else {
		fs.cpSync(repo, dirs.product, { recursive: true, filter: (source) => !source.includes(`${path.sep}.git${path.sep}`) && !source.endsWith(`${path.sep}.git`) && !source.includes(`${path.sep}node_modules${path.sep}`) && !source.endsWith(`${path.sep}node_modules`) });
	}
	for (const tool of [node, pi, git, ...(tmuxBin ? [tmuxBin] : []), ...["rg", "fd"].map(bin).filter(Boolean)]) {
		const target = path.join(dirs.bin, path.basename(tool));
		if (!fs.existsSync(target)) fs.symlinkSync(tool, target);
	}
	const cli = path.join(dirs.product, "src", "cli-entry.mjs");
	const shim = path.join(dirs.bin, "pi-loops");
	fs.writeFileSync(shim, `#!/bin/sh\nexec "${node}" "${cli}" "$@"\n`, { mode: 0o755 });
	const env = {
		HOME: dirs.home, PI_CODING_AGENT_DIR: dirs.agent, PI_LOOPS_DIR: dirs.loops,
		XDG_CONFIG_HOME: path.join(dirs.home, ".config"), XDG_CACHE_HOME: path.join(dirs.home, ".cache"),
		XDG_DATA_HOME: path.join(dirs.home, ".local", "share"), XDG_STATE_HOME: path.join(dirs.home, ".local", "state"),
		PATH: `${dirs.bin}:/usr/bin:/bin`, TERM: "xterm-256color", LANG: "C.UTF-8", TZ: "UTC",
		PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_LOOPS_HOST_MODEL: "fake/fake-model",
		NO_PROXY: "127.0.0.1,localhost", PI_JOURNEY_RUN: runId,
	};
	const portFile = path.join(root, "model.port");
	const model = spawn(node, [path.join(repo, "test/downstream/fake-model.mjs"), portFile], { cwd: dirs.project, env: { ...env, FAKE_MODEL_REPLY: reply, FAKE_MODEL_LOG: path.join(dirs.logs, "model.jsonl") }, stdio: "ignore" });
	const bootMs = Date.now();
	try {
		await until(() => fs.existsSync(portFile), 10000, "stand-in model did not start");
		fs.writeFileSync(path.join(dirs.agent, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${fs.readFileSync(portFile, "utf8").trim()}/v1`, api: "openai-completions", apiKey: "fake", models: [{ id: "fake-model" }] } } }));
		let tmux;
		let sessionId;
		if (tui) {
			const socket = `journey-${process.pid}`;
			const session = "main";
			const args = ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", session, "-c", dirs.project, `${shim} --tui --no-extensions -e ${dirs.product} --model fake/fake-model`];
			spawnSync(tmuxBin, args, { cwd: dirs.project, env, stdio: "ignore" });
			tmux = { socket, session };
			await until(() => spawnSync(tmuxBin, ["-L", socket, "has-session", "-t", session], { env, stdio: "ignore" }).status === 0, 15000, "terminal did not start");
			await until(() => fs.existsSync(path.join(dirs.loops, "logs")) && fs.readdirSync(path.join(dirs.loops, "logs")).some((name) => fs.readFileSync(path.join(dirs.loops, "logs", name), "utf8").includes("session start:")), 15000, "terminal extension did not start");
			spawnSync(tmuxBin, ["-L", socket, "send-keys", "-t", session, "-l", "hello from terminal"], { env, stdio: "ignore" });
			await sleep(500);
			spawnSync(tmuxBin, ["-L", socket, "send-keys", "-t", session, "Enter"], { env, stdio: "ignore" });
			await until(() => fs.existsSync(path.join(dirs.loops, "leases")) && fs.readdirSync(path.join(dirs.loops, "leases")).some((name) => {
				try { const row = JSON.parse(fs.readFileSync(path.join(dirs.loops, "leases", name), "utf8")); sessionId = row.sessionId ?? path.basename(name, ".json"); return !!row.sessionFile && fs.existsSync(row.sessionFile); } catch { return false; }
			}), 30000, `terminal exchange did not create a session: ${spawnSync(tmuxBin, ["-L", socket, "capture-pane", "-p", "-t", session], { env, encoding: "utf8" }).stdout}`);
		}
		const pageProcess = startPage(dirs, { node, env, page, port: 0 }, sessionId);
		const output = await collect(pageProcess, 20000, "page did not become ready");
		const m = output.match(/web on (http:\/\/127\.0\.0\.1:\d+\/)/);
		if (!m) throw new Error(`page failed to start: ${output}`);
		const url = m[1];
		const token = fs.readFileSync(path.join(dirs.loops, "web-token"), "utf8").trim();
		await until(async () => await request(`${url}?token=${token}`) === 200, 10000, "page did not answer authenticated GET");
		let stopped = false;
		const stop = async () => {
			if (stopped) return { survivors: [] };
			stopped = true;
			const failures = [];
			const browserBin = bin("agent-browser");
			if (browserBin) spawnSync(browserBin, ["--session", `journey-${process.pid}`, "close"], { stdio: "ignore" });
			try { pageProcess.kill("SIGTERM"); } catch { /* already exited */ }
			if (tmux) spawnSync(tmuxBin, ["-L", tmux.socket, "kill-server"], { env, stdio: "ignore" });
			spawnSync(shim, ["stop"], { cwd: dirs.project, env, stdio: "ignore" });
			try { model.kill("SIGTERM"); } catch { /* already exited */ }
			await sleep(500);
			const killed = await sweep(root, runId);
			const survivors = [...descendants(root, `PI_JOURNEY_RUN=${runId}`)];
			if (survivors.length) failures.push(`survivors: ${survivors.join(",")}`);
			if (failures.length) throw new Error(failures.join("; "));
			return { killed, survivors };
		};
		return { url, token, tmux, loopsDir: dirs.loops, project: dirs.project, stop, bootMs: Date.now() - bootMs, env, root, agent: dirs.agent, sessionId, product: dirs.product, pageProcess, model };
	} catch (error) {
		model.kill("SIGTERM");
		await sweep(root, runId);
		throw error;
	}
}

function startPage(dirs, product, sessionId) {
	return spawn(path.join(dirs.bin, "pi-loops"), ["--web", "--port", "0", "--no-open", "--", ...(product.page === "attach" && sessionId ? ["--session", sessionId] : []), "--no-extensions", "-e", dirs.product, "--model", "fake/fake-model"], { cwd: dirs.project, env: product.env, stdio: ["ignore", "pipe", "pipe"] });
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function until(probe, ms, reason) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) { if (await probe()) return; await sleep(50); }
	throw new Error(reason);
}
function collect(child, ms, reason) {
	return new Promise((resolve, reject) => {
		let output = "";
		const take = (d) => {
			output += d;
			if (output.includes("web on http")) { clearTimeout(timer); resolve(output); }
		};
		child.stdout.on("data", take);
		child.stderr.on("data", take);
		const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`${reason}: ${output}`)); }, ms);
		child.once("exit", (code) => { clearTimeout(timer); if (!output.includes("web on http")) reject(new Error(`${reason} (exit ${code}): ${output}`)); });
	});
}
async function sweep(root, runId) {
	const targets = new Set();
	const loops = path.join(root, "loops");
	for (const file of [path.join(loops, "host-service.json"), ...fs.existsSync(path.join(loops, "leases")) ? fs.readdirSync(path.join(loops, "leases")).map((n) => path.join(loops, "leases", n)) : []]) {
		try {
			const row = JSON.parse(fs.readFileSync(file, "utf8"));
			if (row.pid) targets.add(Number(row.pid));
			if (row.holder?.pid) targets.add(Number(row.holder.pid));
		} catch { /* absent or concurrently rewritten record */ }
	}
	for (const pid of targets) if (pid !== process.pid && pid !== process.ppid && alive(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* exited during cleanup */ }
	await sleep(100);
	for (const pid of descendants(root, `PI_JOURNEY_RUN=${runId}`)) if (pid !== process.pid && pid !== process.ppid && alive(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* exited during cleanup */ }
	return [...targets];
}
