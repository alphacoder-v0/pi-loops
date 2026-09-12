/**
 * A window into the headless host, and a way to interrupt it.
 *
 * The answer to "I am away and want to look in" would normally be that its process is still open: `--web` serves
 * a loopback UI and `/web-connect` relays it. pi-loops' host has no chat at all, so it publishes
 * the same snapshot the extension builds for `/cron scheduler` and `/triggers` over a unix socket
 * in the loops directory, plus the one control a watcher actually needs: abort a run that has gone
 * wrong. Read-mostly by design — a host that could be prompted would be a second chat.
 *
 * The socket is created 0600 under `PI_LOOPS_DIR`, so only the user who owns the host can read it.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export const HOST_SOCKET = "host.sock";
const MAX_UNIX_SOCKET_PATH = 100; // 104 on macOS, minus headroom so a rename or a longer socket name cannot cross it

/**
 * Where the host listens. Normally `<dir>/host.sock`, but a unix socket path is capped at 108
 * bytes on Linux (104 on macOS) — the whole `sockaddr_un.sun_path` — and a loops directory nested
 * a few levels deep goes past that. `listen()` then fails with EINVAL, the host runs on with no
 * control channel, and `pi-loops host status|abort|stop` report a host that "is not answering"
 * while it is perfectly healthy. So a long path falls back to a short one, named by a hash of the
 * loops directory so two of them never collide.
 *
 * The fallback lives one directory down, in a per-user directory this process owns, never directly
 * in the shared temp directory: this socket accepts `abort` and `stop`, so a predictable path any
 * local account could bind first would let someone else answer for the host — `host stop` would
 * report success against a forged reply while the real host kept running unattended.
 */
export function hostSocketPath(dir: string): string {
	const preferred = path.join(dir, HOST_SOCKET);
	// A byte count, not a character count: the kernel measures bytes.
	if (Buffer.byteLength(preferred) <= MAX_UNIX_SOCKET_PATH) return preferred;
	const digest = createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 16);
	return path.join(os.tmpdir(), `pi-loops-${process.getuid?.() ?? "u"}`, `host-${digest}.sock`);
}

/**
 * The socket's directory, restricted to this user and verified rather than assumed: in a shared
 * temp directory the path can already exist as someone else's directory, or as a symlink into one.
 * Returns false when it cannot be made safe, and the caller then runs without a control channel
 * rather than listening somewhere anyone can reach.
 */
function prepareSocketDir(socketPath: string, log?: (message: string) => void): boolean {
	const parent = path.dirname(socketPath);
	try {
		fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
		const st = fs.lstatSync(parent);
		if (!st.isDirectory()) return fail(`${parent} is not a directory`);
		if (st.uid !== (process.getuid?.() ?? st.uid)) return fail(`${parent} belongs to another user`);
		if (st.mode & 0o077) {
			fs.chmodSync(parent, 0o700);
			if (fs.lstatSync(parent).mode & 0o077) return fail(`${parent} is readable by other users`);
		}
		return true;
	} catch (err: any) {
		return fail(err?.message ?? String(err));
	}
	function fail(reason: string): boolean {
		log?.(`control channel: refusing to listen — ${reason}`);
		return false;
	}
}

/**
 * Is this the socket we created, and not someone else's? The mode is deliberately not part of the
 * test: `listen()` creates the socket under the process umask and the chmod lands a tick later, so
 * a mode check here would reject a healthy host that had only just started. What actually gates
 * access is the directory — 0700 and ownership-checked — plus this uid comparison, which is what
 * stops another account's socket from answering for the host.
 */
function ownedSocket(socketPath: string): boolean {
	try {
		// lstat, so a symlink pointing at someone else's socket is rejected rather than followed.
		const st = fs.lstatSync(socketPath);
		return st.isSocket() && st.uid === (process.getuid?.() ?? st.uid);
	} catch {
		return false;
	}
}

export interface HostSnapshot {
	pid: number;
	host: string;
	startedAt: string;
	model?: string;
	leader: boolean;
	runs: Array<{ runId: string; label: string; jobId: string; startedAt: string; promptPreview: string }>;
	checks: Array<{ traceId: string; sourceLabel: string; eventLabel: string; startedAt: string; cwd: string }>;
	jobs: { enabled: number; total: number };
	rules: { enabled: number; total: number };
	inboxNew: number;
	mcp: Array<{ name: string; state: string; lastError?: string }>;
	/** The last few runs, newest first: a host that has been failing for hours must not look idle. */
	recent?: Array<{ job: string; at: string; ok: boolean; error?: string; cost?: number }>;
	/** Jobs currently carrying an error, and when anything is next due. */
	failing?: Array<{ job: string; error: string }>;
	nextDue?: string;
	/** Today's spend against the cap, when one is configured. */
	budget?: { spent: number; cap: number };
}

export type HostRequest = { op: "status" } | { op: "abort"; runId?: string; traceId?: string } | { op: "stop" };
export type HostResponse = { ok: true; snapshot?: HostSnapshot; aborted?: boolean } | { ok: false; error: string };

export interface HostChannelHandlers {
	status: () => HostSnapshot;
	abortRun: (runId: string) => boolean;
	abortCheck: (traceId: string) => boolean;
	stop: () => void;
}

/** One newline-delimited JSON request per connection, answered and closed. */
export function serveHostChannel(dir: string, handlers: HostChannelHandlers, log?: (message: string) => void): net.Server {
	const socketPath = hostSocketPath(dir);
	if (!prepareSocketDir(socketPath, log)) return net.createServer();
	// The directory holds prompts, findings, transcripts and now a control socket: it is the
	// owner's alone. `listen()` creates the socket with the process umask (0775 under umask 002)
	// and only chmods afterwards, so the directory mode is what closes that window.
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(dir, 0o700);
	} catch (err: any) {
		log?.(`could not restrict ${dir} to this user: ${err?.message ?? err}`);
	}
	try {
		// `force` only swallows ENOENT: in a sticky temp directory this can be EPERM, and an
		// unhandled throw here would take the whole host down at startup.
		if (ownedSocket(socketPath)) fs.rmSync(socketPath, { force: true }); // left by a crashed host
		else if (fs.existsSync(socketPath)) throw new Error(`${socketPath} exists and is not ours`);
	} catch (err: any) {
		log?.(`control channel: ${err?.message ?? err}`);
		return net.createServer(); // an unbound server: the host runs, `host status` falls back to the pid
	}
	const server = net.createServer((socket) => {
		socket.setEncoding("utf8");
		let buf = "";
		socket.on("data", (chunk) => {
			buf += chunk;
			const nl = buf.indexOf("\n");
			if (nl < 0) {
				if (buf.length > 4096) socket.destroy();
				return;
			}
			let response: HostResponse;
			try {
				const req = JSON.parse(buf.slice(0, nl)) as HostRequest;
				if (req.op === "status") response = { ok: true, snapshot: handlers.status() };
				else if (req.op === "abort") response = { ok: true, aborted: req.runId ? handlers.abortRun(req.runId) : req.traceId ? handlers.abortCheck(req.traceId) : false };
				else if (req.op === "stop") {
					response = { ok: true };
					setTimeout(() => handlers.stop(), 50).unref?.();
				} else response = { ok: false, error: `unknown op ${JSON.stringify((req as any).op)}` };
			} catch (err: any) {
				response = { ok: false, error: err?.message ?? String(err) };
			}
			socket.end(`${JSON.stringify(response)}\n`, () => socket.destroy());
			buf = "";
			socket.removeAllListeners("data"); // one request per connection, never replayed
		});
		socket.on("error", () => socket.destroy());
		socket.setTimeout(10_000, () => socket.destroy());
	});
	server.on("error", (err: any) => log?.(`control channel: ${err?.message ?? err}`));
	server.listen(socketPath, () => {
		try {
			fs.chmodSync(socketPath, 0o600);
		} catch (err: any) {
			// Never leave a reachable control socket behind because a chmod failed.
			log?.(`could not restrict the control socket; closing it: ${err?.message ?? err}`);
			server.close();
		}
	});
	server.unref();
	return server;
}

/** Ask a running host something. Returns undefined when no host is listening. */
export function askHost(dir: string, request: HostRequest, timeoutMs = 2000): Promise<HostResponse | undefined> {
	const socketPath = hostSocketPath(dir);
	return new Promise((resolve) => {
		// Not just "does it exist": whoever is listening there gets to answer for the host, and this
		// answer decides whether `host stop` sends a signal. Someone else's socket is no host at all.
		if (!ownedSocket(socketPath)) return resolve(undefined);
		const socket = net.createConnection(socketPath);
		let buf = "";
		const done = (value: HostResponse | undefined) => {
			socket.destroy();
			resolve(value);
		};
		const timer = setTimeout(() => done(undefined), timeoutMs);
		timer.unref?.();
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", (chunk) => {
			buf += chunk;
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			clearTimeout(timer);
			try {
				done(JSON.parse(buf.slice(0, nl)) as HostResponse);
			} catch {
				done(undefined);
			}
		});
		socket.on("error", () => {
			clearTimeout(timer);
			done(undefined);
		});
	});
}

/**
 * Everything here arrived over a socket and is printed to a terminal. Even with the socket
 * ownership-checked, a snapshot is data from another process: escape sequences would repaint the
 * lines around it, and a number that is not a number would throw out of `toFixed`.
 */
function line(text: unknown): string {
	return String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}
function money(n: unknown, digits: number): string {
	return Number.isFinite(Number(n)) ? Number(n).toFixed(digits) : "?";
}

/** The lines `/cron host` shows for a live host. */
export function renderHostSnapshot(s: HostSnapshot): string[] {
	const lines = [
		`  pid ${line(s.pid)} on ${line(s.host)}, started ${line(s.startedAt)}${s.model ? `, model ${line(s.model)}` : ""}`,
		`  ${s.leader ? "owns the clock" : "standby"} · ${line(s.jobs?.enabled)}/${line(s.jobs?.total)} loop(s), ${line(s.rules?.enabled)}/${line(s.rules?.total)} rule(s) enabled · inbox: ${line(s.inboxNew)} new`,
	];
	for (const r of s.runs ?? []) lines.push(`  running ${line(r.label)} (${line(r.runId).slice(0, 12)}) since ${line(r.startedAt)}: ${line(r.promptPreview)}`);
	for (const c of s.checks ?? []) lines.push(`  checking ${line(c.sourceLabel)}/${line(c.eventLabel)} (${line(c.traceId).slice(0, 8)}) in ${line(c.cwd)}`);
	for (const m of s.mcp ?? []) lines.push(`  mcp ${line(m.name)}: ${line(m.state)}${m.lastError ? ` — ${line(m.lastError)}` : ""}`);
	if (!s.runs?.length && !s.checks?.length) lines.push(`  nothing running right now${s.nextDue ? ` · next due ${line(s.nextDue)}` : ""}`);
	if (s.budget && Number(s.budget.cap) > 0) lines.push(`  spent today: $${money(s.budget.spent, 2)} of $${money(s.budget.cap, 2)}${Number(s.budget.spent) >= Number(s.budget.cap) ? " — dispatching is paused" : ""}`);
	for (const f of s.failing ?? []) lines.push(`  ! ${line(f.job)}: ${line(f.error)}`);
	for (const r of s.recent ?? []) lines.push(`  ${r.ok ? "ok  " : "FAIL"} ${line(r.at)}  ${line(r.job)}${r.cost ? ` · $${money(r.cost, 3)}` : ""}${r.error ? ` — ${line(r.error)}` : ""}`);
	return lines;
}
