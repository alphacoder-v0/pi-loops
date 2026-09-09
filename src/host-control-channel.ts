/**
 * A window into the headless host, and a way to interrupt it.
 *
 * pie's answer to "I am away and want to look in" is that its process is still open: `--web` serves
 * a loopback UI and `/web-connect` relays it. pi-loops' host has no chat at all, so it publishes
 * the same snapshot the extension builds for `/cron scheduler` and `/triggers` over a unix socket
 * in the loops directory, plus the one control a watcher actually needs: abort a run that has gone
 * wrong. Read-mostly by design — a host that could be prompted would be a second chat.
 *
 * The socket is created 0600 under `PI_LOOPS_DIR`, so only the user who owns the host can read it.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

export const HOST_SOCKET = "host.sock";

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
export function serveHostChannel(dir: string, handlers: HostChannelHandlers, log?: (m: string) => void): net.Server {
	const socketPath = path.join(dir, HOST_SOCKET);
	// The directory holds prompts, findings, transcripts and now a control socket: it is the
	// owner's alone. `listen()` creates the socket with the process umask (0775 under umask 002)
	// and only chmods afterwards, so the directory mode is what closes that window.
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(dir, 0o700);
	} catch (err: any) {
		log?.(`could not restrict ${dir} to this user: ${err?.message ?? err}`);
	}
	fs.rmSync(socketPath, { force: true }); // a socket left by a crashed host
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
	const socketPath = path.join(dir, HOST_SOCKET);
	return new Promise((resolve) => {
		if (!fs.existsSync(socketPath)) return resolve(undefined);
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

/** The lines `/cron host` shows for a live host. */
export function renderHostSnapshot(s: HostSnapshot): string[] {
	const lines = [
		`  pid ${s.pid} on ${s.host}, started ${s.startedAt}${s.model ? `, model ${s.model}` : ""}`,
		`  ${s.leader ? "owns the clock" : "standby"} · ${s.jobs.enabled}/${s.jobs.total} loop(s), ${s.rules.enabled}/${s.rules.total} rule(s) enabled · inbox: ${s.inboxNew} new`,
	];
	for (const r of s.runs) lines.push(`  running ${r.label} (${r.runId.slice(0, 12)}) since ${r.startedAt}: ${r.promptPreview}`);
	for (const c of s.checks) lines.push(`  checking ${c.sourceLabel}/${c.eventLabel} (${c.traceId.slice(0, 8)}) in ${c.cwd}`);
	for (const m of s.mcp) lines.push(`  mcp ${m.name}: ${m.state}${m.lastError ? ` — ${m.lastError}` : ""}`);
	if (!s.runs.length && !s.checks.length) lines.push(`  nothing running right now${s.nextDue ? ` · next due ${s.nextDue}` : ""}`);
	if (s.budget && s.budget.cap > 0) lines.push(`  spent today: $${s.budget.spent.toFixed(2)} of $${s.budget.cap.toFixed(2)}${s.budget.spent >= s.budget.cap ? " — dispatching is paused" : ""}`);
	for (const f of s.failing ?? []) lines.push(`  ! ${f.job}: ${f.error}`);
	for (const r of s.recent ?? []) lines.push(`  ${r.ok ? "ok  " : "FAIL"} ${r.at}  ${r.job}${r.cost ? ` · $${r.cost.toFixed(3)}` : ""}${r.error ? ` — ${r.error}` : ""}`);
	return lines;
}
