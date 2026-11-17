import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs `command` (argv) in a pseudo-terminal of `rows` x `cols` through test/journey/terminal.py and
 * keeps its screen. `dir` is a directory the driver owns (its key pipe and screen files go there).
 * Every method is synchronous.
 */
export function openTerminal({ dir, command, cwd, env, rows = 40, cols = 120 }) {
	fs.mkdirSync(dir, { recursive: true });
	const keys = path.join(dir, "keys");
	if (!fs.existsSync(keys)) spawnSyncMkdir(keys);
	const driver = path.join(path.dirname(fileURLToPath(import.meta.url)), "terminal.py");
	const child = spawn("python3", ["-I", driver, ...command], {
		cwd, env: { ...process.env, ...env, TERM: "xterm-256color", PTYTERM_DIR: dir, PTYTERM_ROWS: String(rows), PTYTERM_COLS: String(cols) },
		stdio: "ignore",
	});
	child.unref();
	// Read and write: an open for writing alone waits for a reader, and would wait forever if the driver never started.
	const keyFd = fs.openSync(keys, fs.constants.O_RDWR);
	let stopped = false;
	const write = (data) => { if (!stopped) fs.writeFileSync(keyFd, data); };
	const request = (value) => write(`\0${JSON.stringify(value)}\n`);
	return {
		type(text) { write(text); },
		press(...names) {
			const keysByName = { Enter: "\r", Escape: "\x1b", BSpace: "\x7f", Tab: "\t", "C-c": "\x03", "C-u": "\x15", "C-d": "\x04" };
			for (const name of names) {
				if (!(name in keysByName)) throw new Error(`unknown terminal key: ${name}`);
				write(keysByName[name]);
			}
		},
		screen({ history = 0, joined = false } = {}) {
			let state;
			try { state = JSON.parse(fs.readFileSync(path.join(dir, "screen.json"), "utf8")); }
			catch { return ""; /* the driver has not published its first screen */ }
			const lines = [...state.history.slice(-history), ...state.rows];
			const wraps = [...state.historyWrapped.slice(-history), ...state.wrapped];
			if (joined) {
				for (let i = 0; i + 1 < lines.length; i++) if (wraps[i]) { lines[i] += lines[i + 1]; lines.splice(i + 1, 1); wraps.splice(i + 1, 1); i--; }
			}
			while (lines.length && !lines.at(-1)) lines.pop();
			return lines.join("\n");
		},
		clearHistory() { request({ clearHistory: true }); },
		alive() {
			try { return !JSON.parse(fs.readFileSync(path.join(dir, "screen.json"), "utf8")).exited; }
			catch { return child.exitCode === null; }
		},
		stop() {
			if (stopped) return;
			if (this.alive()) request({ stop: true });
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline && child.exitCode === null && child.signalCode === null && processAlive(child.pid)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
			if (child.exitCode === null && child.signalCode === null && processAlive(child.pid)) { try { process.kill(child.pid, "SIGKILL"); } catch { /* driver exited */ } }
			stopped = true;
			fs.closeSync(keyFd);
		},
		pid: child.pid,
	};
}

function spawnSyncMkdir(file) {
	const result = spawnSync("python3", ["-I", "-c", "import os,sys; os.mkfifo(sys.argv[1], 0o600)", file], { stdio: "inherit" });
	if (result.status !== 0) throw new Error(`could not create terminal key pipe: ${file}`);
}

function processAlive(pid) {
	try { process.kill(pid, 0); }
	catch (error) { return error?.code === "EPERM"; }
	if (process.platform === "linux") {
		try {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
			return stat.slice(stat.lastIndexOf(") ") + 2)[0] !== "Z";
		} catch { return false; /* process exited while it was checked */ }
	}
	const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
	return result.status === 0 && !result.stdout.trim().startsWith("Z");
}
