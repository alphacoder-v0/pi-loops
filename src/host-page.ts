/**
 * The host's status page: a read-only window onto the always-on host, on loopback (127.0.0.1:4174
 * for the default loops directory, an ephemeral port for any other). It shows which process holds
 * each conversation and what is running, which is what `pi-loops host status` prints plus the
 * sessions. Every mutation (abort, run, stop, upgrade) stays on the 0600 unix socket, so a page
 * anyone on this machine could load with the token can look and never act: a host you could
 * prompt would be a second chat (docs/cli.md). Three locks, in the order they are checked: the
 * method (GET only), the Host header (the DNS-rebinding guard src/web.mjs uses), and the token from
 * `host-service.json`, compared in constant time.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { URL } from "node:url";
import type { HostSnapshot } from "./host-control-channel.ts";
import type { LeaseHolder, SessionLease } from "./lease.ts";
import type { SinceYouLooked } from "./seen.ts";

/**
 * The page's token, kept in `host-page-token` so a bookmark survives the host restarting: it is 0600
 * in the loops directory, next to `host-service.json`, which holds it too. A symlink or a file that is
 * not this user's is refused rather than read or written through — whoever chose that path is not
 * the person whose token this is — and a fresh token is used for this host's life instead.
 */
export function pageToken(dir: string, log: (message: string) => void = () => undefined): string {
	const file = path.join(dir, "host-page-token");
	try {
		const st = fs.lstatSync(file);
		if (!st.isFile()) throw new Error(`${file} is not a regular file`);
		if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${file} belongs to another user`);
		if (st.mode & 0o077) fs.chmodSync(file, 0o600);
		const found = fs.readFileSync(file, "utf8").trim();
		if (/^[0-9a-f]{32}$/.test(found)) return found;
	} catch (err: any) {
		if (err?.code !== "ENOENT") {
			log(`status page token: ${err?.message ?? err}; using a token for this run only`);
			return randomBytes(16).toString("hex");
		}
	}
	const made = randomBytes(16).toString("hex");
	try {
		fs.writeFileSync(file, `${made}\n`, { mode: 0o600, flag: "wx" });
	} catch (err: any) {
		log(`status page token: could not keep it in ${file} (${err?.message ?? err})`);
	}
	return made;
}

/** The default directory's fixed port; every other loops directory binds port 0. */
export const HOST_PAGE_PORT = 4174;

export type SessionHolderView =
	| { kind: "terminal"; pid: number; mode?: string; since: string; pushServers: string[] }
	| { kind: "host"; busy?: string; since: string }
	| { kind: "nobody" }
	| { kind: "legacy-pi"; pid: number };

export interface SessionRow {
	sessionId: string;
	cwd?: string;
	file?: string;
	holder: SessionHolderView;
	plainJobs: number;
	rules: number;
	mailbox: number;
	sinceYouLooked: SinceYouLooked;
}

export interface HostStatus {
	snapshot: HostSnapshot;
	managed: "spawned" | "systemd" | "launchd";
	sessions: SessionRow[];
}

export interface SessionRowsInput {
	leases: readonly SessionLease[];
	plainJobSessions: readonly string[];
	ruleSessions: readonly string[];
	mailbox: ReadonlyMap<string, number>;
	legacy: ReadonlyArray<{ sessionId: string; pid: number }>;
	alive: (holder: LeaseHolder) => boolean;
	since: (sessionId: string) => SinceYouLooked;
}

/** Combines ownership and automation counts so an idle conversation remains visible. */
export function sessionRows(input: SessionRowsInput): SessionRow[] {
	const leases = new Map(input.leases.map((lease) => [lease.sessionId, lease]));
	const legacy = new Map(input.legacy.map((entry) => [entry.sessionId, entry.pid]));
	const ids = new Set([...leases.keys(), ...input.plainJobSessions, ...input.ruleSessions, ...input.mailbox.keys(), ...legacy.keys()]);
	const counts = (sessions: readonly string[]) => {
		const out = new Map<string, number>();
		for (const id of sessions) out.set(id, (out.get(id) ?? 0) + 1);
		return out;
	};
	const jobs = counts(input.plainJobSessions);
	const rules = counts(input.ruleSessions);
	const rank = { terminal: 0, host: 1, "legacy-pi": 2, nobody: 3 };
	return [...ids].map((sessionId): SessionRow => {
		const lease = leases.get(sessionId);
		const holder = lease?.holder;
		let view: SessionHolderView;
		if (holder && input.alive(holder)) {
			if (holder.kind === "terminal") view = { kind: "terminal", pid: holder.pid, ...(holder.mode ? { mode: holder.mode } : {}), since: holder.acquiredAt, pushServers: holder.pushServers };
			else view = { kind: "host", ...(holder.busy ? { busy: holder.busy.jobId ?? holder.busy.runId } : {}), since: holder.acquiredAt };
		} else if (legacy.has(sessionId)) view = { kind: "legacy-pi", pid: legacy.get(sessionId)! };
		else view = { kind: "nobody" };
		return {
			sessionId,
			...(lease?.cwd !== undefined ? { cwd: lease.cwd } : {}),
			...(lease?.sessionFile !== undefined ? { file: lease.sessionFile } : {}),
			holder: view,
			plainJobs: jobs.get(sessionId) ?? 0,
			rules: rules.get(sessionId) ?? 0,
			mailbox: input.mailbox.get(sessionId) ?? 0,
			sinceYouLooked: input.since(sessionId),
		};
	}).sort((a, b) => rank[a.holder.kind] - rank[b.holder.kind] || a.sessionId.localeCompare(b.sessionId));
}

export interface PageRequest {
	method?: string;
	url?: string;
	headers: Record<string, string | string[] | undefined>;
	remoteAddress?: string;
}
export interface PageResponse { status: number; headers: Record<string, string>; body: string }

const SECURITY_HEADERS = {
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function response(status: number, body: string, contentType = "text/plain; charset=utf-8", extra: Record<string, string> = {}): PageResponse {
	return { status, headers: { ...SECURITY_HEADERS, "content-type": contentType, ...extra }, body };
}

function header(req: PageRequest, name: string): string | undefined {
	const found = Object.entries(req.headers).find(([key]) => key.toLowerCase() === name);
	const value = found?.[1];
	return Array.isArray(value) ? value[0] : value;
}

function fromTailnet(address: string | undefined): boolean {
	const from = String(address ?? "").replace(/^::ffff:/, "");
	if (from === "127.0.0.1" || from === "::1") return true;
	const octets = from.split(".").map(Number);
	return octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

function hostAllowed(req: PageRequest): boolean {
	const raw = header(req, "host");
	if (!raw) return false;
	const host = raw.replace(/:\d+$/, "").toLowerCase();
	return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || (host.endsWith(".ts.net") && fromTailnet(req.remoteAddress));
}

/**
 * Constant-time compare. The lengths are compared as bytes, not characters: `timingSafeEqual`
 * throws on buffers of different byte lengths, and a 32-character token with one `é` in it is 33
 * bytes — a throw there, before any token is known, ended the host.
 */
function sameToken(given: string | undefined, token: string): boolean {
	if (typeof given !== "string") return false;
	const a = Buffer.from(given);
	const b = Buffer.from(token);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** Answers a read-only request after checking its method, host name and bearer token. */
export function handleHostPageRequest(req: PageRequest, token: string, status: () => HostStatus): PageResponse {
	if (req.method !== "GET") return response(405, "method not allowed\n", undefined, { allow: "GET" });
	if (!hostAllowed(req)) return response(403, "forbidden host\n");
	let url: URL;
	try {
		url = new URL(req.url ?? "/", "http://localhost");
	} catch {
		// A request line that is not a path names nothing this page has.
		return response(404, "not found\n");
	}
	const queryToken = url.searchParams.get("token") ?? undefined;
	const authorization = header(req, "authorization");
	const bearer = authorization && /^Bearer (.+)$/i.exec(authorization)?.[1];
	if (!sameToken(queryToken, token) && !sameToken(bearer, token)) return response(401, "bad or missing token\n");
	try {
		if (url.pathname === "/") return response(200, renderHostPage(status(), token), "text/html; charset=utf-8");
		if (url.pathname === "/status.json") return response(200, `${JSON.stringify(status(), null, 2)}\n`, "application/json; charset=utf-8");
		return response(404, "not found\n");
	} catch {
		// The error text can carry a path or a provider's message; the log is where it belongs, not a page.
		return response(500, "status unavailable\n");
	}
}

function escapeHtml(value: unknown): string {
	return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function heldBy(holder: SessionHolderView): string {
	switch (holder.kind) {
		case "terminal": return `terminal pid ${holder.pid}${holder.mode ? ` (${holder.mode})` : ""}`;
		case "host": return `the host${holder.busy ? ` — running ${holder.busy}` : ""}`;
		case "legacy-pi": return `pi-loops 0.22 window, pid ${holder.pid}`;
		case "nobody": return "nobody";
	}
}

/** Renders a static page; escaping each displayed status value keeps session and model text inert. */
export function renderHostPage(s: HostStatus, token: string): string {
	const e = escapeHtml;
	const snap = s.snapshot;
	const rows = s.sessions.map((row) => `<tr><td>${e(row.sessionId.slice(0, 8))}</td><td>${e(row.cwd ?? "—")}</td><td>${e(heldBy(row.holder))}</td><td>${e(row.plainJobs)}</td><td>${e(row.rules)}</td><td>${e(row.mailbox)}</td><td>${e(row.sinceYouLooked.runs === 0 && row.sinceYouLooked.failed === 0 && row.sinceYouLooked.findings === 0 ? "—" : `${row.sinceYouLooked.runs} runs, ${row.sinceYouLooked.failed} failed, ${row.sinceYouLooked.findings} findings`)}</td></tr>`).join("");
	const table = `<div class="scroll"><table><thead><tr><th>session</th><th>directory</th><th>held by</th><th>plain jobs</th><th>rules</th><th>mailbox</th><th>since you looked</th></tr></thead><tbody>${rows}</tbody></table></div>`;
	const running = [...snap.runs.map((run) => `run ${run.label} (${run.runId}) since ${run.startedAt}: ${run.promptPreview}`), ...snap.checks.map((check) => `check ${check.sourceLabel}/${check.eventLabel} (${check.traceId}) since ${check.startedAt}: ${check.cwd}`)];
	const runningHtml = running.length ? `<ul>${running.map((line) => `<li>${e(line)}</li>`).join("")}</ul>` : `<p>nothing running right now</p>`;
	const due = snap.nextDue ? `<p>next due ${e(snap.nextDue)}</p>` : "";
	const failing = snap.failing?.length ? `<section><h2>Failing</h2><ul>${snap.failing.map((item) => `<li>${e(item.job)}: ${e(item.error)}</li>`).join("")}</ul></section>` : "";
	const recent = snap.recent?.length ? `<section><h2>Recent runs</h2><ul>${snap.recent.map((item) => `<li>${e(item.ok ? "ok" : "FAIL")} ${e(item.at)} ${e(item.job)}${item.cost === undefined ? "" : ` · $${e(Number(item.cost).toFixed(3))}`}${item.error ? ` — ${e(item.error)}` : ""}</li>`).join("")}</ul></section>` : "";
	const mcp = snap.mcp.length ? `<section><h2>MCP</h2><ul>${snap.mcp.map((item) => `<li>${e(item.name)}: ${e(item.state)}${item.lastError ? ` — ${e(item.lastError)}` : ""}</li>`).join("")}</ul></section>` : "";
	const budget = snap.budget ? `<section><h2>Budget</h2><p>$${e(Number(snap.budget.spent).toFixed(2))} of $${e(Number(snap.budget.cap).toFixed(2))} today</p></section>` : "";
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="15"><title>pi-loops host</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#17202a;--muted:#596579;--line:#d7dce2}body{font:16px system-ui,sans-serif;max-width:1100px;margin:0 auto;padding:1rem;background:var(--bg);color:var(--fg)}h1{font-size:1.35rem}h2{font-size:1.1rem}.muted{color:var(--muted)}section{margin:1.5rem 0}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.55rem;border-bottom:1px solid var(--line);vertical-align:top}th{white-space:nowrap}ul{padding-left:1.4rem}li{margin:.35rem 0}footer{margin-top:2rem}@media(prefers-color-scheme:dark){:root{--bg:#15191f;--fg:#e8edf2;--muted:#a6b0bd;--line:#3b434d}}
</style></head><body>
<header><h1>pi-loops host</h1><p>pid ${e(snap.pid)} · pi-loops ${e(snap.version ?? "—")} · ${e(s.managed)} · started ${e(snap.startedAt)}${snap.model ? ` · model ${e(snap.model)}` : ""}</p></header>
<section><h2>Sessions</h2>${table}</section>
<section><h2>Running</h2>${runningHtml}${due}</section>
${budget}${failing}${recent}${mcp}
<footer><a href="status.json?token=${encodeURIComponent(token)}">status.json</a></footer></body></html>`;
}

/** Serves the status page on loopback so another machine cannot reach the host's status directly. */
export function serveHostPage(opts: { port: number; token: string; status: () => HostStatus; log: (message: string) => void }): Promise<{ url?: string; close: () => void }> {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			req.resume();
			// Anything a request can make throw is a 500 for that request, never an uncaught error in the host.
			let answer: PageResponse;
			try {
				answer = handleHostPageRequest({ method: req.method, url: req.url, headers: req.headers, remoteAddress: req.socket.remoteAddress }, opts.token, opts.status);
			} catch (err: any) {
				opts.log(`status page: ${err?.message ?? err}`);
				answer = { status: 500, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, body: "status unavailable\n" };
			}
			res.writeHead(answer.status, answer.headers);
			res.end(answer.body);
		});
		server.requestTimeout = 10_000;
		server.headersTimeout = 10_000;
		let listening = false;
		server.on("error", (err: NodeJS.ErrnoException) => {
			if (!listening) {
				if (err.code === "EADDRINUSE") opts.log(`status page unavailable: 127.0.0.1:${opts.port} in use`);
				else opts.log(`status page unavailable: ${err.message}`);
				resolve({ url: undefined, close: () => {} });
			} else opts.log(`status page unavailable: ${err.message}`);
		});
		server.listen(opts.port, "127.0.0.1", () => {
			listening = true;
			const address = server.address();
			const port = address && typeof address === "object" ? address.port : opts.port;
			resolve({ url: `http://127.0.0.1:${port}/`, close: () => { server.close(); } });
		});
	});
}
