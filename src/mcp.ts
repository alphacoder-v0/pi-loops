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
import { newTraceId } from "./triggers.ts";

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
const USER_AGENT = "pi-loops/0.1.0 (mcp-streamable-http/2025-03-26)";

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
			out.servers.push(parseOneServer(s, i, source, seen));
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
		if (typeof v !== "number" || v <= 0) throw new Error(`streamable_http MCP server '${name}' ${field} must be positive`);
		return v;
	};
	{
		if (!s || typeof s.name !== "string" || !s.name.trim()) throw new Error(`server #${i + 1} in the ${source} config needs a name`);
		if (seen.has(s.name)) throw new Error(`duplicate server name in the ${source} config`);
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
	if (redacted !== value || Array.from(value).length > 200 || /[\x00-\x1f\x7f]/.test(value)) {
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


const CLIENT_INFO = { name: "pi-loops", version: "0.1.0" };
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
		this.sendFrame = undefined;
		this.setState("disabled");
		this.httpAbort?.abort();
		if (this.proc) {
			try {
				this.proc.kill("SIGTERM");
			} catch {
				/* gone */
			}
			this.proc = undefined;
		}
		this.failPending("stopped");
	}

	private setState(state: HookState, reason?: string): void {
		this.status.state = state;
		this.status.reason = reason;
		if (reason) this.status.lastError = reason;
		this.hooks.onStatus?.(this.status);
	}

	private async connectLoop(): Promise<void> {
		const rc = this.config.reconnect;
		const maxAttempts = rc.maxAttempts;
		while (!this.stopped) {
			try {
				this.attempts++;
				if (this.config.kind === "stdio") await this.runStdio();
				else await this.runHttp();
				if (this.stopped) return;
				this.setState("reconnecting", "connection closed");
			} catch (err: any) {
				if (this.stopped) return;
				const msg = err?.message ?? String(err);
				if (/401|403|unauthori[sz]ed|auth/i.test(msg)) {
					this.setState("auth_failed", msg);
					return;
				}
				this.setState("reconnecting", msg);
				this.hooks.log?.(`mcp:${this.config.name}: ${msg}`);
			}
			if (maxAttempts !== undefined && this.attempts >= maxAttempts) {
				this.setState("disconnected", "reconnect attempts exhausted");
				this.status.requiresAttention = "restart pi or fix the server; see /triggers sources";
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
				const text = chunk.toString().trim();
				if (text) this.status.lastError = text.split("\n").slice(-1)[0].slice(0, 200);
			});
			proc.on("error", (err) => finish(new Error(`failed to spawn ${this.config.command}: ${err.message}`)));
			proc.on("close", (code) => finish(this.stopped ? undefined : new Error(`server exited with code ${code}`)));
			void this.initialize((msg) => proc.stdin?.write(`${JSON.stringify(msg)}\n`)).catch((err) => {
				proc.kill("SIGTERM");
				finish(err);
			});
		});
	}

	private bearerToken(): string | undefined {
		const auth = this.config.auth;
		if (!auth) return undefined;
		if (auth.tokenKeychainRef) {
			const token = this.hooks.resolveToken?.(auth.tokenKeychainRef) ?? process.env[auth.tokenKeychainRef];
			if (!token) throw new Error(`configured bearer credential '${auth.tokenKeychainRef}' was not found; export it as an environment variable or store it with pi's credential store`);
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
				signal: AbortSignal.timeout(this.config.requestTimeoutMs),
			});
			const sid = res.headers.get("mcp-session-id");
			if (sid) this.httpSessionId = sid;
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
		this.attempts = 0;
		this.setState("connected");
		await this.hooks.onConnected?.(this);
		this.httpAbort = new AbortController();
		const headers = withSession({ ...base, Accept: "text/event-stream", ...(this.lastEventId ? { "Last-Event-ID": this.lastEventId } : {}) });
		let res: Response;
		try {
			res = await fetch(endpoint, { method: "GET", headers, signal: AbortSignal.any([this.httpAbort.signal, AbortSignal.timeout(this.config.sseIdleTimeoutMs)]) });
			if (!res.ok) throw new Error(`MCP HTTP SSE status ${res.status}`);
			await this.readSse(res, this.config.sseIdleTimeoutMs, (data) => this.handleFrame(data, (m) => void post(m).catch(() => {})));
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
	private async readSse(res: Response, idleTimeoutMs: number | undefined, onData: (data: string) => void): Promise<void> {
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
			if (buffer.length > cap) throw new Error("MCP HTTP SSE frame exceeded cap");
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
				if (id !== undefined) this.lastEventId = id;
				if (data.length) onData(data.join("\n"));
			}
		}
	}

	private async initialize(send: (msg: unknown) => void): Promise<void> {
		const result = await this.request(send, "initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
		if (!result || typeof result !== "object") throw new Error("initialize returned no result");
		send({ jsonrpc: "2.0", method: "notifications/initialized" });
		this.attempts = 0;
		this.setState("connected");
		await this.hooks.onConnected?.(this);
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
				this.hooks.onNotification({ method: f.method, params: f.params ?? {} });
			}
		}
	}
}
