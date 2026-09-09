/**
 * Minimal MCP client used only as a notification source (pie's
 * `mcp_notification_hook.rs` + the stdio / streamable-HTTP transports it relies on).
 * pi has no built-in MCP client, so this extension carries one: enough JSON-RPC to
 * initialize a server and consume its server→client notifications. Tools are not
 * proxied — the point is to turn pushes into triggers.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import type { ReplacementPolicy, Trigger } from "./triggers.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { newTraceId } from "./triggers.ts";
import { parseToml } from "./toml.ts";
import { PI_LOOPS_VERSION } from "./version.ts";

export interface McpServerConfig {
	name: string;
	kind: "stdio" | "streamable_http";
	command?: string;
	args?: string[];
	/** Extra environment for stdio servers (pi-loops addition; pie has no such field). */
	env?: Record<string, string>;
	endpoint?: string;
	/** pie: `auth = { kind = "bearer", token_keychain_ref = "<credential name>" }`. `token` inline is a pi-loops convenience. */
	auth?: { kind: string; tokenKeychainRef?: string; token?: string };
	requestTimeoutMs: number;
	sseIdleTimeoutMs: number;
	bodyCapBytes: number;
	reconnect: { initialMs: number; maxMs: number; maxAttempts?: number };
	injectSummary: boolean;
	injectAndRun: boolean;
	source: "user" | "project";
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_SSE_IDLE_TIMEOUT_MS = 60_000;
export const DEFAULT_BODY_CAP_BYTES = 1024 * 1024;
/** Only environment variables with this prefix may be named by an MCP config file. */
export const MCP_TOKEN_ENV_PREFIX = "PI_MCP_TOKEN_";

/**
 * The environment half of credential resolution, prefix-bound. Every caller must go through this:
 * reading `process.env[ref]` directly would let a project's `.pi/mcp.toml` name an unrelated secret
 * (a model API key) and have it sent as a bearer token to that server's own endpoint. pie resolves
 * refs against its credential store only (mcp_loader.rs:324).
 */
export function mcpTokenFromEnv(ref: string): string | undefined {
	return ref.startsWith(MCP_TOKEN_ENV_PREFIX) ? process.env[ref] : undefined;
}
const USER_AGENT = `pi-loops/${PI_LOOPS_VERSION} (mcp-streamable-http/2025-03-26)`;

export interface McpNotification {
	method: string;
	params: any;
}

export type HookState = "pending" | "connected" | "reconnecting" | "disconnected" | "disabled" | "auth_failed";

export interface SourceStatus {
	label: string;
	state: HookState;
	reason?: string;
	subscriptionLabels: string[];
	queuedCount: number;
	droppedCount: number;
	dedupedCount: number;
	lastEventAt?: string;
	/** Last stderr line of a stdio server; diagnostic only, never an error (pie never surfaces stderr). */
	lastStderr?: string;
	lastError?: string;
	requiresAttention?: string;
}

export interface ParsedMcpConfig {
	servers: McpServerConfig[];
	/** pie: one "mcp server '<name>' failed: …" line per bad server; the good ones still connect. */
	diagnostics: string[];
}

/** Parse one `mcp.toml` document (`[[server]]`) with pie's per-server validation. */
export function parseMcpConfig(doc: Record<string, unknown>, source: "user" | "project" = "user"): ParsedMcpConfig {
	const servers = Array.isArray(doc.server) ? (doc.server as any[]) : [];
	const out: ParsedMcpConfig = { servers: [], diagnostics: [] };
	const seen = new Set<string>();
	servers.forEach((s, i) => {
		try {
			const cfg = parseOneServer(s, i, source, seen);
			// pie's loader: a repeated name replaces the earlier entry (last wins); say so.
			const dup = out.servers.findIndex((x) => x.name === cfg.name);
			if (dup >= 0) {
				out.servers[dup] = cfg;
				out.diagnostics.push(`mcp server '${cfg.name}': duplicate name in the ${source} config; the later entry wins`);
			} else out.servers.push(cfg);
		} catch (err: any) {
			const name = typeof s?.name === "string" ? s.name : `#${i + 1}`;
			out.diagnostics.push(`mcp server '${name}' failed: ${err?.message ?? err}`);
		}
	});
	return out;
}

function parseOneServer(s: any, i: number, source: "user" | "project", seen: Set<string>): McpServerConfig {
	const positive = (name: string, v: unknown, field: string): number | undefined => {
		if (v === undefined) return undefined;
		if (typeof v !== "number" || v <= 0) throw new Error(`MCP server '${name}' ${field} must be positive`);
		return v;
	};
	{
		if (!s || typeof s.name !== "string" || !s.name.trim()) throw new Error(`server #${i + 1} in the ${source} config needs a name`);
		seen.add(s.name);
		const kind = s.kind ?? "stdio";
		if (kind !== "stdio" && kind !== "streamable_http") throw new Error(`mcp server '${s.name}': unknown kind "${kind}" (stdio | streamable_http)`);
		if (kind === "stdio") {
			if (s.endpoint !== undefined || s.auth !== undefined) throw new Error(`stdio MCP server '${s.name}' must not set endpoint or auth; remove streamable_http fields`);
			if (typeof s.command !== "string") throw new Error(`stdio MCP server '${s.name}' missing command`);
		} else {
			if (s.command || (Array.isArray(s.args) && s.args.length)) throw new Error(`streamable_http MCP server '${s.name}' must set endpoint, not command/args`);
			if (typeof s.endpoint !== "string") throw new Error(`streamable_http MCP server '${s.name}' missing endpoint`);
			let url: URL;
			try {
				url = new URL(s.endpoint);
			} catch {
				throw new Error(`streamable_http MCP server '${s.name}': invalid endpoint`);
			}
			if (url.protocol !== "https:" && url.hostname !== "127.0.0.1") throw new Error(`streamable_http MCP server '${s.name}': endpoint must be https, except 127.0.0.1 test fixtures`);
		}
		let auth: McpServerConfig["auth"];
		if (s.auth !== undefined) {
			if (!s.auth || typeof s.auth !== "object") throw new Error(`streamable_http MCP server '${s.name}': auth must be a table`);
			if (s.auth.kind !== "bearer") throw new Error(`streamable_http MCP server '${s.name}': unsupported streamable_http auth kind; expected bearer`);
			if (typeof s.auth.token_keychain_ref !== "string" && typeof s.auth.token !== "string") throw new Error(`streamable_http MCP server '${s.name}': bearer auth requires token_keychain_ref`);
			auth = { kind: "bearer", tokenKeychainRef: s.auth.token_keychain_ref, token: s.auth.token };
		}
		const rc = s.reconnect;
		if (rc !== undefined && (!rc || typeof rc !== "object")) throw new Error(`streamable_http MCP server '${s.name}': reconnect must be a table`);
		if (rc && (rc.initial_ms === 0 || rc.max_ms === 0)) throw new Error(`streamable_http MCP server '${s.name}' reconnect delays must be positive`);
		return {
			name: s.name,
			kind,
			command: s.command,
			args: Array.isArray(s.args) ? s.args.map(String) : [],
			env: s.env && typeof s.env === "object" ? Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, String(v)])) : undefined,
			endpoint: s.endpoint,
			auth,
			requestTimeoutMs: positive(s.name, s.request_timeout_ms, "request_timeout_ms") ?? DEFAULT_REQUEST_TIMEOUT_MS,
			sseIdleTimeoutMs: positive(s.name, s.sse_idle_timeout_ms, "sse_idle_timeout_ms") ?? DEFAULT_SSE_IDLE_TIMEOUT_MS,
			bodyCapBytes: positive(s.name, s.body_cap_bytes, "body_cap_bytes") ?? DEFAULT_BODY_CAP_BYTES,
			reconnect: { initialMs: typeof rc?.initial_ms === "number" ? rc.initial_ms : 500, maxMs: typeof rc?.max_ms === "number" ? rc.max_ms : 30_000, maxAttempts: typeof rc?.max_attempts === "number" ? rc.max_attempts : undefined },
			injectSummary: s.inject_summary === true,
			injectAndRun: s.inject_and_run === true,
			source,
		};
	}
}

/** pie's `load_all`: user config first, project config overrides servers with the same name. */
export function mergeMcpConfigs(user: McpServerConfig[], project: McpServerConfig[]): McpServerConfig[] {
	const out = [...user];
	for (const s of project) {
		const i = out.findIndex((x) => x.name === s.name);
		if (i >= 0) out[i] = s;
		else out.push(s);
	}
	return out;
}

/* ------------------------------------------------- notification → trigger */

const SUMMARY_CAP = 200;

function redactNotificationText(value: string): string {
	return value
		.split(/\s+/)
		.map((part) => {
			const lower = part.toLowerCase();
			return lower.startsWith("hub_agent_") || lower.startsWith("hub_hs_") || lower.startsWith("hub_ep_") || lower.startsWith("sk-") || lower.includes("bearer") || lower.includes("token") ? "[redacted]" : part;
		})
		.join(" ");
}

function truncateChars(value: string, cap: number): string {
	const chars = Array.from(value);
	return chars.length <= cap ? value : `${chars.slice(0, cap - 1).join("")}…`;
}

export function safeDisplay(value: string, cap: number): string {
	return truncateChars(redactNotificationText(value).replace(/\n/g, " "), cap);
}

function safeIdempotencySegment(value: string): string {
	const redacted = redactNotificationText(value);
	if (redacted !== value || Array.from(value).length > 200 || /\p{Cc}/u.test(value)) {
		return `hash:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
	}
	return value;
}

function extractDedupKey(params: any): string | undefined {
	const meta = params?._meta;
	for (const k of ["pie_dedup_key", "pi_dedup_key"]) if (typeof meta?.[k] === "string") return meta[k];
	for (const k of ["_pie_dedup_key", "_pi_dedup_key"]) if (typeof params?.[k] === "string") return params[k];
	return undefined;
}

function idempotencyFor(server: string, method: string, params: any): { key: string; policy: ReplacementPolicy } | undefined {
	const prefix = `mcp:${server}:`;
	switch (method) {
		case "notifications/tools/listChanged":
			return { key: `${prefix}tools`, policy: "latest_replaces" };
		case "notifications/resources/listChanged":
			return { key: `${prefix}resources`, policy: "latest_replaces" };
		case "notifications/prompts/listChanged":
			return { key: `${prefix}prompts`, policy: "latest_replaces" };
		case "notifications/resources/updated": {
			const uri = typeof params?.uri === "string" ? params.uri : "unknown";
			return { key: `${prefix}resources:${safeIdempotencySegment(uri)}`, policy: "latest_replaces" };
		}
		default: {
			const k = extractDedupKey(params);
			return k === undefined ? undefined : { key: `${prefix}custom:${safeIdempotencySegment(k)}`, policy: "drop" };
		}
	}
}

/** pie's `render_summary`: method name plus bounded, redacted display metadata; never raw params. */
function renderSummary(method: string, params: any): string {
	switch (method) {
		case "notifications/resources/updated":
			return typeof params?.uri === "string" ? `${method} uri=${safeDisplay(params.uri, SUMMARY_CAP)}` : method;
		case "notifications/tools/listChanged":
		case "notifications/resources/listChanged":
		case "notifications/prompts/listChanged":
			return method;
		default: {
			const meta = params?._meta;
			const custom = typeof meta?.pie_summary === "string" ? meta.pie_summary : typeof meta?.pi_summary === "string" ? meta.pi_summary : undefined;
			return custom ? `${method} ${safeDisplay(custom, SUMMARY_CAP)}` : method;
		}
	}
}

/** pie's status wording for a custom notification dropped at the adapter. */
export function droppedNotificationMessage(method: string): string {
	return `dropped custom notification ${JSON.stringify(method)}: missing \`_meta.pie_dedup_key\` or \`_pie_dedup_key\``;
}

/** pie's `map_notification`: undefined means "drop at the adapter" (custom method without a dedup key). */
export function mapNotification(server: string, n: McpNotification): Trigger | undefined {
	const idem = idempotencyFor(server, n.method, n.params);
	if (!idem) return undefined;
	return {
		source: { kind: "mcp", serverName: server, method: n.method },
		sourceKind: "mcp",
		sourceLabel: `mcp:${server}`,
		eventLabel: n.method,
		payloadSummary: renderSummary(n.method, n.params),
		idempotencyKey: idem.key,
		replacementPolicy: idem.policy,
		traceId: newTraceId(),
		receivedAt: new Date().toISOString(),
	};
}

/* ------------------------------------------------------------- client */

export interface McpClientHooks {
	onNotification: (n: McpNotification) => void;
	onStatus?: (s: SourceStatus) => void;
	/** Fired after the initialize handshake on every (re)connect; the host registers the server's tools here. */
	onConnected?: (source: McpSource) => void | Promise<void>;
	log?: (msg: string) => void;
	/** Resolve `auth.token_keychain_ref` to a bearer token (env var, pi credential store, …). */
	resolveToken?: (ref: string) => string | undefined;
}

/** `tools/list` entry (MCP `Tool`). */
export interface McpToolDef {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
}

/** `tools/call` result content, normalized. */
export type McpToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } | { type: "resource"; resource: unknown };

export interface McpToolCallResult {
	content: McpToolContent[];
	isError: boolean;
}


const CLIENT_INFO = { name: "pi-loops", version: PI_LOOPS_VERSION };
const PROTOCOL_VERSION = "2025-03-26";

export class McpSource {
	readonly config: McpServerConfig;
	readonly status: SourceStatus;
	private readonly hooks: McpClientHooks;
	private proc: ChildProcess | undefined;
	private stopped = false;
	private attempts = 0;
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
	private httpAbort: AbortController | undefined;
	private httpSessionId: string | undefined;
	/** The server rejected our session id: the next attempt must start a new MCP session. */
	private sessionLost = false;
	/** Resolves the "no server-push stream" park so the connect loop can retry. */
	private wakeParked: (() => void) | undefined;
	private lastEventId: string | undefined;
	/** Outbound frame sender for the live transport (stdio stdin or HTTP POST); undefined while disconnected. */
	private sendFrame: ((msg: unknown) => void) | undefined;
	/** Server tool catalog after `tools/list` (pie caches it on the client too). */
	catalog: McpToolDef[] = [];

	constructor(config: McpServerConfig, hooks: McpClientHooks) {
		this.config = config;
		this.hooks = hooks;
		this.status = { label: `mcp:${config.name}`, state: "pending", subscriptionLabels: [`mcp:${config.name}`], queuedCount: 0, droppedCount: 0, dedupedCount: 0 };
	}

	start(): void {
		this.stopped = false;
		void this.connectLoop();
	}

	get connected(): boolean {
		return this.status.state === "connected" && this.sendFrame !== undefined;
	}

	/** JSON-RPC request over the live transport. Rejects when disconnected or on timeout. */
	async call(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
		const send = this.sendFrame;
		if (!send) throw new Error(`mcp:${this.config.name} is not connected`);
		return this.request(send, method, params, signal);
	}

	/** pie's `tools_list`: fetch and cache the server's tool catalog. */
	async listTools(): Promise<McpToolDef[]> {
		const result = await this.call("tools/list", {});
		const tools = Array.isArray(result?.tools) ? result.tools : [];
		this.catalog = tools
			.filter((t: any) => t && typeof t.name === "string")
			.map((t: any) => ({ name: t.name, description: typeof t.description === "string" ? t.description : undefined, inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} } }));
		return this.catalog;
	}

	/** pie's `tools_call`: invoke a server tool; an aborted signal sends `notifications/cancelled` best-effort. */
	async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpToolCallResult> {
		const result = await this.call("tools/call", { name, arguments: args ?? {} }, signal);
		const content: McpToolContent[] = [];
		for (const block of Array.isArray(result?.content) ? result.content : []) {
			if (block?.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text });
			else if (block?.type === "image" && typeof block.data === "string") content.push({ type: "image", data: block.data, mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/png" });
			else if (block?.type === "resource") content.push({ type: "resource", resource: block.resource });
		}
		return { content, isError: result?.isError === true };
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.cancelStableTimer();
		this.wakeParked?.();
		this.sendFrame = undefined;
		this.setState("disabled");
		this.httpAbort?.abort();
		if (this.proc) {
			const proc = this.proc;
			this.proc = undefined;
			try {
				proc.kill("SIGTERM");
				// pie kills outright (stdio.rs:118). A server that traps SIGTERM would otherwise be
				// orphaned when pi exits, so it gets a grace period and then SIGKILL.
				const hard = setTimeout(() => {
					try {
						proc.kill("SIGKILL");
					} catch {
						/* gone */
					}
				}, 2000);
				hard.unref?.();
				proc.once("exit", () => clearTimeout(hard));
			} catch {
				/* gone */
			}
		}
		this.failPending("stopped");
	}

	private setState(state: HookState, reason?: string): void {
		if (this.stopped && state !== "disabled") return; // stop() has the last word
		this.status.state = state;
		this.status.reason = reason;
		if (reason) this.status.lastError = reason;
		this.hooks.onStatus?.(this.status);
	}

	/** Default reconnect budget: ~10 minutes of backoff, then give up until pi restarts. */
	static readonly DEFAULT_MAX_ATTEMPTS = 20;
	/** A connection must last this long before its reconnect budget is refunded. */
	static readonly STABLE_MS = 30_000;
	private stableTimer?: NodeJS.Timeout;

	private async connectLoop(): Promise<void> {
		const rc = this.config.reconnect;

		const maxAttempts = rc.maxAttempts ?? McpSource.DEFAULT_MAX_ATTEMPTS;
		let lastLogged: string | undefined;
		while (!this.stopped) {
			try {
				this.attempts++;
				if (this.config.kind === "stdio") await this.runStdio();
				else {
					// A restarted remote server drops its sessions: carrying the old id would 404 every
					// POST for the life of the process. A plain reconnect keeps the id (and resumes the
					// stream from Last-Event-ID); a session the server rejected is started fresh.
					if (this.sessionLost) {
						this.httpSessionId = undefined;
						this.lastEventId = undefined;
						this.sessionLost = false;
					}
					await this.runHttp();
				}
				this.cancelStableTimer();
				if (this.stopped) return;
				this.setState("reconnecting", "connection closed");
			} catch (err: any) {
				this.cancelStableTimer();
				if (this.stopped) return;
				const msg = err?.message ?? String(err);
				// Only a real auth status stops the loop for good, and only from the HTTP transport: a
				// stdio command path containing "auth" (`authbind`, /opt/oauth-mcp/…) or an exit code
				// that happens to read 403 used to disable the server permanently.
				if (this.config.kind !== "stdio" && /MCP HTTP (SSE )?status (401|403)\b|unauthori[sz]ed/i.test(msg)) {
					this.setState("auth_failed", msg);
					this.hooks.log?.(`mcp:${this.config.name}: ${msg}`);
					return;
				}
				this.setState("reconnecting", msg);
				// Say it once per distinct error, not once per attempt: a broken command must not
				// turn into a notification every 30 seconds.
				if (msg !== lastLogged) {
					lastLogged = msg;
					this.hooks.log?.(`mcp:${this.config.name}: ${msg} (retrying with backoff, up to ${maxAttempts} attempts)`);
				}
			}
			if (this.attempts >= maxAttempts) {
				this.setState("disconnected", `reconnect attempts exhausted (${this.attempts}); last error: ${this.status.lastError ?? "unknown"}`);
				this.status.requiresAttention = "fix the server config and restart pi, or /reload";
				this.hooks.log?.(`mcp:${this.config.name}: giving up after ${this.attempts} attempts`);
				return;
			}
			const delay = Math.min(rc.maxMs, rc.initialMs * 2 ** Math.min(this.attempts - 1, 16));
			await new Promise((r) => setTimeout(r, delay));
		}
	}

	/* stdio transport */
	private runStdio(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const proc = spawn(this.config.command!, this.config.args ?? [], {
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, ...(this.config.env ?? {}) },
			});
			this.proc = proc;
			let buffer = "";
			let settled = false;
			const finish = (err?: Error) => {
				if (settled) return;
				settled = true;
				this.proc = undefined;
				this.sendFrame = undefined;
				this.failPending("transport closed");
				err ? reject(err) : resolve();
			};
			this.sendFrame = (msg) => proc.stdin?.write(`${JSON.stringify(msg)}\n`);
			proc.stdout?.on("data", (chunk) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) this.handleFrame(line, (msg) => proc.stdin?.write(`${JSON.stringify(msg)}\n`));
			});
			proc.stderr?.on("data", (chunk) => {
				// Kept apart from lastError (pie never surfaces stderr): chatter must not mask a real error.
				const text = chunk.toString().trim();
				if (text) this.status.lastStderr = text.split("\n").slice(-1)[0].slice(0, 200);
			});
			proc.on("error", (err) => finish(new Error(`failed to spawn ${this.config.command}: ${err.message}`)));
			proc.on("close", (code) => finish(this.stopped ? undefined : new Error(`server exited with code ${code}`)));
			void this.initialize((msg) => proc.stdin?.write(`${JSON.stringify(msg)}\n`)).catch((err) => {
				proc.kill("SIGTERM");
				const hard = setTimeout(() => proc.kill("SIGKILL"), 2000);
				hard.unref?.();
				proc.once("exit", () => clearTimeout(hard));
				finish(err);
			});
		});
	}

	private bearerToken(): string | undefined {
		const auth = this.config.auth;
		if (!auth) return undefined;
		if (auth.tokenKeychainRef) {
			// pie resolves a ref against its credential store only (mcp_loader.rs:324). Reading any
			// environment variable a config file names would let `.pi/mcp.toml` send an unrelated
			// secret (a model API key) to its own endpoint, so the env fallback is prefix-bound.
			const ref = auth.tokenKeychainRef;
			const token = this.hooks.resolveToken?.(ref) ?? mcpTokenFromEnv(ref);
			if (!token) throw new Error(`configured bearer credential was not found; store it with pi's credential store, or export it as ${MCP_TOKEN_ENV_PREFIX}… and name that variable`);
			return token;
		}
		return auth.token;
	}

	/**
	 * Streamable HTTP (pie's `http.rs`): POST initialize + initialized, then hold the
	 * server→client GET stream. Body cap, SSE idle timeout, `Last-Event-ID` resume,
	 * and POST responses that are themselves event streams are all honored.
	 */
	private async runHttp(): Promise<void> {
		const endpoint = this.config.endpoint!;
		const token = this.bearerToken();
		// One controller for the whole connection, held from the first POST: stop() during the
		// handshake aborts it instead of leaving a stream nobody owns.
		const abort = new AbortController();
		this.httpAbort = abort;
		abort.signal.addEventListener("abort", () => this.failPending("stopped"), { once: true });
		const base: Record<string, string> = { "User-Agent": USER_AGENT, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
		const withSession = (h: Record<string, string>) => (this.httpSessionId ? { ...h, "Mcp-Session-Id": this.httpSessionId } : h);
		const cap = this.config.bodyCapBytes;
		const post = async (body: unknown): Promise<void> => {
			const json = JSON.stringify(body);
			if (Buffer.byteLength(json) > cap) throw new Error("MCP HTTP request exceeded body cap");
			const res = await fetch(endpoint, {
				method: "POST",
				headers: withSession({ ...base, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }),
				body: json,
				signal: AbortSignal.any([abort.signal, AbortSignal.timeout(this.config.requestTimeoutMs)]),
			});
			const sid = res.headers.get("mcp-session-id");
			if (sid) this.httpSessionId = sid;
			if (res.status === 404 || res.status === 400) {
				this.sessionLost = true;
				this.wakeParked?.(); // a source parked on "no push stream" has to reconnect to recover
			}
			if (!res.ok) throw new Error(`MCP HTTP status ${res.status}; response body redacted`);
			const ct = (res.headers.get("content-type") ?? "").toLowerCase();
			if (ct.startsWith("text/event-stream")) {
				await this.readSse(res, undefined, (data) => this.handleFrame(data, (m) => void post(m).catch(() => {})));
				return;
			}
			const text = await this.cappedText(res, cap);
			if (text.trim()) this.handleFrame(text.trim(), (m) => void post(m).catch(() => {}));
		};
		await this.request((m) => void post(m).catch((err) => this.hooks.log?.(`mcp:${this.config.name}: ${err?.message ?? err}`)), "initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
		await post({ jsonrpc: "2.0", method: "notifications/initialized" });
		this.sendFrame = (m) => void post(m).catch((err) => this.hooks.log?.(`mcp:${this.config.name}: ${err?.message ?? err}`));
		if (this.stopped) throw new Error("stopped during handshake");
		this.markConnected();
		await this.hooks.onConnected?.(this);
		if (this.stopped) throw new Error("stopped during handshake");
		const headers = withSession({ ...base, Accept: "text/event-stream", ...(this.lastEventId ? { "Last-Event-ID": this.lastEventId } : {}) });
		// pie's http.rs: sse_idle_timeout bounds the wait for the response headers and then for
		// each chunk (readSse). It is never a deadline on the whole stream, which stays open as
		// long as the server keeps talking.
		const connect = new AbortController();
		const connectTimer = setTimeout(() => connect.abort(new Error(`MCP HTTP SSE connect timed out after ${Math.round(this.config.sseIdleTimeoutMs / 1000)}s`)), this.config.sseIdleTimeoutMs);
		connectTimer.unref();
		let res: Response;
		try {
			try {
				res = await fetch(endpoint, { method: "GET", headers, signal: AbortSignal.any([abort.signal, connect.signal]) });
			} finally {
				clearTimeout(connectTimer);
			}
			// The server→client GET stream is optional in the spec: 405/404 means "this server has
			// no push channel", not "this server is unusable". pie keeps POST working regardless
			// (http.rs:168-194); tool calls must not depend on the stream existing.
			if (res.status === 404 && this.httpSessionId) {
				this.sessionLost = true;
				throw new Error("MCP HTTP SSE status 404 (session expired); reconnecting with a new session");
			}
			if (res.status === 405 || res.status === 404) {
				this.status.lastError = `no server-push stream (HTTP ${res.status} on GET); tools work, notifications do not`;
				this.hooks.log?.(`mcp:${this.config.name}: ${this.status.lastError}`);
				// Park until stopped — or until a POST tells us the server dropped our session, which
				// only a reconnect can repair. Without this the source would look connected forever
				// while every tool call failed.
				await new Promise<void>((r) => {
					if (abort.signal.aborted) return r();
					abort.signal.addEventListener("abort", () => r(), { once: true });
					this.wakeParked = r;
				});
				this.wakeParked = undefined;
				if (this.sessionLost) throw new Error("server rejected the MCP session; reconnecting");
				return;
			}
			if (!res.ok) throw new Error(`MCP HTTP SSE status ${res.status}`);
			await this.readSse(res, this.config.sseIdleTimeoutMs, (data) => this.handleFrame(data, (m) => void post(m).catch(() => {})), true);
		} finally {
			this.sendFrame = undefined;
			this.failPending("transport closed");
		}
	}

	private failPending(reason: string): void {
		for (const p of [...this.pending.values()]) p.reject(new Error(reason));
		this.pending.clear();
	}

	private async cappedText(res: Response, cap: number): Promise<string> {
		if (!res.body) return "";
		const reader = res.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > cap) {
				await reader.cancel().catch(() => {});
				throw new Error("MCP HTTP response body exceeded cap");
			}
			chunks.push(value);
		}
		return Buffer.concat(chunks).toString("utf8");
	}

	/** Parse an SSE body; `idleTimeoutMs` bounds the wait for the next chunk (pie's sse_idle_timeout). */
	/**
	 * `isEventStream` marks the server→client GET stream, the only one whose `id:` fields belong to
	 * the resume cursor. A POST response that happens to be an event stream has its own id space,
	 * and recording those would make a reconnect ask the GET stream to resume from an id it never
	 * issued (replaying or skipping notifications).
	 */
	private async readSse(res: Response, idleTimeoutMs: number | undefined, onData: (data: string) => void, isEventStream = false): Promise<void> {
		if (!res.body) return;
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		const cap = this.config.bodyCapBytes;
		let buffer = "";
		for (;;) {
			let timer: NodeJS.Timeout | undefined;
			const next = idleTimeoutMs
				? Promise.race([
						reader.read(),
						new Promise<never>((_, reject) => {
							timer = setTimeout(() => {
								reader.cancel().catch(() => {});
								reject(new Error(`MCP HTTP SSE idle for ${Math.round(idleTimeoutMs / 1000)}s`));
							}, idleTimeoutMs);
							timer.unref();
						}),
					])
				: reader.read();
			let result: ReadableStreamReadResult<Uint8Array>;
			try {
				result = await next;
			} finally {
				if (timer) clearTimeout(timer);
			}
			if (result.done) return;
			buffer += decoder.decode(result.value, { stream: true });
			if (Buffer.byteLength(buffer) > cap) throw new Error("MCP HTTP SSE frame exceeded cap");
			let idx: number;
			while ((idx = buffer.indexOf("\n\n")) >= 0) {
				const raw = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				let id: string | undefined;
				const data: string[] = [];
				for (const line of raw.split("\n")) {
					if (!line || line.startsWith(":")) continue;
					if (line.startsWith("id:")) id = line.slice(3).trimStart();
					else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
				}
				if (id !== undefined && isEventStream) this.lastEventId = id;
				if (data.length) onData(data.join("\n"));
			}
		}
	}

	private async initialize(send: (msg: unknown) => void): Promise<void> {
		const result = await this.request(send, "initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
		if (!result || typeof result !== "object") throw new Error("initialize returned no result");
		send({ jsonrpc: "2.0", method: "notifications/initialized" });
		this.markConnected();
		await this.hooks.onConnected?.(this);
	}

	/**
	 * A handshake is not yet a working server: one that answers `initialize` and then exits (a
	 * missing key, a bad argument) would reset the counter every time and be respawned forever.
	 * The attempt counter is only cleared once the connection has lasted `STABLE_MS`.
	 */
	private markConnected(): void {
		this.setState("connected");
		this.cancelStableTimer();
		this.stableTimer = setTimeout(() => {
			this.attempts = 0;
			this.stableTimer = undefined;
		}, McpSource.STABLE_MS);
		this.stableTimer.unref?.();
	}

	/** The refund is owed to a connection that lasted; a dropped one takes it back with it. */
	private cancelStableTimer(): void {
		if (this.stableTimer) clearTimeout(this.stableTimer);
		this.stableTimer = undefined;
	}

	private request(send: (msg: unknown) => void, method: string, params: unknown, signal?: AbortSignal): Promise<any> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const settle = (fn: () => void) => {
				const p = this.pending.get(id);
				if (!p) return;
				this.pending.delete(id);
				clearTimeout(p.timer);
				signal?.removeEventListener("abort", onAbort);
				fn();
			};
			const onAbort = () => {
				// pie's cancel path: drop the in-flight entry, tell the server best-effort, return Cancelled.
				settle(() => reject(new Error("cancelled")));
				try {
					send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "client cancelled" } });
				} catch {
					/* transport gone */
				}
			};
			const timer = setTimeout(() => settle(() => reject(new Error(`${method} timed out after ${Math.round(this.config.requestTimeoutMs / 1000)}s`))), this.config.requestTimeoutMs);
			this.pending.set(id, { resolve: (v) => settle(() => resolve(v)), reject: (e) => settle(() => reject(e)), timer });
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			send({ jsonrpc: "2.0", id, method, params });
		});
	}

	/** One JSON-RPC frame from the server. Responses settle requests; notifications flow out; requests get a polite error. */
	handleFrame(line: string, send: (msg: unknown) => void): void {
		const text = line.trim();
		if (!text) return;
		let msg: any;
		try {
			msg = JSON.parse(text);
		} catch {
			return;
		}
		const frames = Array.isArray(msg) ? msg : [msg];
		for (const f of frames) {
			if (!f || typeof f !== "object") continue;
			if (f.id !== undefined && f.method === undefined) {
				const p = this.pending.get(f.id);
				if (!p) continue;
				// resolve/reject settle the entry themselves (delete + clear timer + detach abort listener).
				if (f.error) p.reject(new Error(f.error.message ?? JSON.stringify(f.error)));
				else p.resolve(f.result);
			} else if (f.method !== undefined && f.id !== undefined) {
				if (f.method === "ping") send({ jsonrpc: "2.0", id: f.id, result: {} });
				else send({ jsonrpc: "2.0", id: f.id, error: { code: -32601, message: `pi-loops is a notification-only client; ${f.method} is not supported` } });
			} else if (typeof f.method === "string") {
				this.status.lastEventAt = new Date().toISOString();
				this.status.queuedCount++;
				this.status.lastError = undefined; // pie: a successful push clears the last error
				this.hooks.onNotification({ method: f.method, params: f.params ?? {} });
			}
		}
	}
}

/* -------------------------------------------------- config files, tool definitions */

/**
 * pie's `mcp_loader`: the user file, then the project file (`.pi/mcp.toml`, or pie's `.pie/mcp.toml`)
 * when the project is trusted. Diagnostics are collected, never thrown.
 */
/** Just `<cwd>/.pi/mcp.toml` (or pie's `.pie/`), for lending a project's own servers to a run in it. */
export function loadProjectMcpConfig(cwd: string): { servers: McpServerConfig[]; diagnostics: string[] } {
	const diagnostics: string[] = [];
	const file = [path.join(cwd, ".pi", "mcp.toml"), path.join(cwd, ".pie", "mcp.toml")].find((f) => fs.existsSync(f));
	if (!file) return { servers: [], diagnostics };
	try {
		const parsed = parseMcpConfig(parseToml(fs.readFileSync(file, "utf8")), "project");
		return { servers: parsed.servers, diagnostics: parsed.diagnostics };
	} catch (err: any) {
		return { servers: [], diagnostics: [`mcp config (project, ${file}): parse failed: ${err?.message ?? err}`] };
	}
}

export function loadMcpConfigFiles(opts: { dir: string; cwd?: string; projectTrusted: boolean }): { servers: McpServerConfig[]; diagnostics: string[] } {
	const diagnostics: string[] = [];
	const read = (file: string, source: "user" | "project"): McpServerConfig[] => {
		let text: string;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch (err: any) {
			if (err?.code !== "ENOENT") diagnostics.push(`mcp config (${source}, ${file}): read failed: ${err?.message ?? err}`);
			return [];
		}
		try {
			const parsed = parseMcpConfig(parseToml(text), source);
			diagnostics.push(...parsed.diagnostics);
			return parsed.servers;
		} catch (err: any) {
			diagnostics.push(`mcp config (${source}, ${file}): parse failed: ${err?.message ?? err}`);
			return [];
		}
	};
	const user = read(path.join(opts.dir, "mcp.toml"), "user");
	let project: McpServerConfig[] = [];
	if (opts.cwd) {
		const projectFile = [path.join(opts.cwd, ".pi", "mcp.toml"), path.join(opts.cwd, ".pie", "mcp.toml")].find((f) => fs.existsSync(f));
		if (projectFile) {
			if (opts.projectTrusted) project = read(projectFile, "project");
			else diagnostics.push(`project MCP config ignored at ${projectFile}: project is not trusted (pi --approve, or trust it when prompted)`);
		}
	}
	return { servers: mergeMcpConfigs(user, project), diagnostics };
}

/** pie's `McpAgentTool`: one server tool as a pi tool definition (schema passed through, content mapped, cancel forwarded). */
export function mcpToolDefinition(source: McpSource, tool: McpToolDef, name: string): ToolDefinition<any, any> {
	return {
		name,
		label: `${source.config.name}: ${tool.name}`,
		description: tool.description ?? `${tool.name} (MCP server ${source.config.name})`,
		parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
		async execute(_id, params, signal) {
			let result: Awaited<ReturnType<McpSource["callTool"]>>;
			try {
				result = await source.callTool(tool.name, params as Record<string, unknown>, signal);
			} catch (err: any) {
				const msg = err?.message ?? String(err);
				return { content: [{ type: "text", text: msg === "cancelled" ? "cancelled" : `mcp call: ${msg}` }], isError: true, details: { name: tool.name, server: source.config.name, isError: true } };
			}
			const content = result.content.map((b) => (b.type === "text" ? { type: "text" as const, text: b.text } : b.type === "image" ? { type: "image" as const, data: b.data, mimeType: b.mimeType } : { type: "text" as const, text: `<resource>${JSON.stringify(b.resource)}</resource>` }));
			if (result.isError) {
				return { content: [{ type: "text", text: content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n") || "tool reported an error" }], isError: true, details: { name: tool.name, server: source.config.name, isError: true } };
			}
			return { content: content.length ? content : [{ type: "text", text: "(no content)" }], details: { name: tool.name, server: source.config.name, isError: false } };
		},
	};
}

/**
 * Register a server's tools under collision-free names (pie prefixes with the server name on a
 * clash). `taken` holds every name already known; returns the new definitions and names.
 */
/**
 * pi's built-in tool names. A custom tool registered under one of these replaces it in pi's
 * registry (custom tools are applied after built-ins), so every `taken` set must start from here —
 * including where the parent excluded a built-in with `-xt`, which keeps the name reserved.
 * Mirrors `allToolNames` in pi's `core/tools`, which the package does not re-export; the test
 * `mcp.test.ts` pins the list against the installed pi.
 */
export const PI_BUILTIN_TOOL_NAMES: readonly string[] = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

export function mcpToolDefinitions(source: McpSource, tools: McpToolDef[], taken: Set<string>, already: string[]): Array<{ name: string; def: ToolDefinition<any, any> }> {
	const out: Array<{ name: string; def: ToolDefinition<any, any> }> = [];
	for (const tool of tools) {
		if (already.some((n) => n === tool.name || n === `${source.config.name}_${tool.name}`)) continue;
		const name = taken.has(tool.name) ? `${source.config.name}_${tool.name}` : tool.name;
		if (taken.has(name)) continue;
		taken.add(name);
		already.push(name);
		out.push({ name, def: mcpToolDefinition(source, tool, name) });
	}
	return out;
}
