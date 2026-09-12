import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { McpSource, mapNotification, mergeMcpConfigs, parseMcpConfig } from "../src/mcp.ts";
import { parseToml } from "../src/toml.ts";

test("parseMcpConfig: mcp.toml validation and defaults", () => {
	const cfg = parseMcpConfig(parseToml(`[[server]]\nname = "fs"\ncommand = "node"\nargs = ["x.js"]\n[[server]]\nname = "hub"\nkind = "streamable_http"\nendpoint = "https://h/mcp"\nauth = { kind = "bearer", token_keychain_ref = "HUB_TOKEN" }\nsse_idle_timeout_ms = 5000\nreconnect = { initial_ms = 100, max_ms = 1000, max_attempts = 3 }\ninject_and_run = true\n`)).servers;
	assert.equal(cfg[0].kind, "stdio");
	assert.equal(cfg[0].requestTimeoutMs, 30_000);
	assert.equal(cfg[0].bodyCapBytes, 1024 * 1024);
	assert.deepEqual(cfg[0].reconnect, { initialMs: 500, maxMs: 30_000, maxAttempts: undefined });
	assert.equal(cfg[1].injectAndRun, true);
	assert.equal(cfg[1].sseIdleTimeoutMs, 5000);
	assert.deepEqual(cfg[1].auth, { kind: "bearer", tokenKeychainRef: "HUB_TOKEN", token: undefined });
	assert.deepEqual(cfg[1].reconnect, { initialMs: 100, maxMs: 1000, maxAttempts: 3 });
	const bad = (doc: any, re: RegExp) => {
		const r = parseMcpConfig(doc);
		assert.equal(r.servers.length, 0);
		assert.match(r.diagnostics[0], re);
	};
	bad({ server: [{ name: "a", kind: "streamable_http", endpoint: "https://x", command: "c" }] }, /must set endpoint, not command/);
	bad({ server: [{ name: "a", command: "c", endpoint: "https://x" }] }, /must not set endpoint or auth/);
	bad({ server: [{ name: "a", kind: "streamable_http", endpoint: "http://example.com/mcp" }] }, /must be https/);
	assert.equal(parseMcpConfig({ server: [{ name: "a", kind: "streamable_http", endpoint: "http://127.0.0.1:9/mcp" }] }).servers[0].endpoint, "http://127.0.0.1:9/mcp");
	const mixed = parseMcpConfig({ server: [{ name: "ok", command: "x" }, { name: "bad", kind: "streamable_http", endpoint: "http://example.com" }] });
	assert.deepEqual(mixed.servers.map((x) => x.name), ["ok"], "one bad server does not take the file down");
	assert.match(mixed.diagnostics[0], /^mcp server 'bad' failed: /);
	bad({ server: [{ name: "a", kind: "streamable_http", endpoint: "https://x", auth: { kind: "basic" } }] }, /unsupported streamable_http auth kind; expected bearer/);
	bad({ server: [{ name: "a", kind: "streamable_http", endpoint: "https://x", auth: { kind: "bearer" } }] }, /requires token_keychain_ref/);
	bad({ server: [{ name: "a", kind: "streamable_http", endpoint: "https://x", request_timeout_ms: 0 }] }, /request_timeout_ms must be positive/);
	bad({ server: [{ name: "a", kind: "streamable_http", endpoint: "https://x", reconnect: { initial_ms: 0 } }] }, /reconnect delays must be positive/);
	const dup = parseMcpConfig({ server: [{ name: "a", command: "x" }, { name: "a", command: "y" }] });
	assert.equal(dup.servers.length, 1);
	assert.equal(dup.servers[0].command, "y", "the later entry wins");
	assert.match(dup.diagnostics[0], /duplicate name .* later entry wins/);
	const merged = mergeMcpConfigs(parseMcpConfig({ server: [{ name: "a", command: "user" }, { name: "b", command: "b" }] }).servers, parseMcpConfig({ server: [{ name: "a", command: "project" }] }, "project").servers);
	assert.deepEqual(merged.map((s) => [s.name, s.command, s.source]), [["a", "project", "project"], ["b", "b", "user"]]);
});

test("mapNotification: keys, policies, summaries, redaction, drop without key", () => {
	const upd = mapNotification("fs", { method: "notifications/resources/updated", params: { uri: "file:///tmp/a" } })!;
	assert.equal(upd.idempotencyKey, "mcp:fs:resources:file:///tmp/a");
	assert.equal(upd.replacementPolicy, "latest_replaces");
	assert.equal(upd.payloadSummary, "notifications/resources/updated uri=file:///tmp/a");
	const tools = mapNotification("fs", { method: "notifications/tools/listChanged", params: {} })!;
	assert.equal(tools.idempotencyKey, "mcp:fs:tools");
	assert.equal(tools.payloadSummary, "notifications/tools/listChanged");
	const custom = mapNotification("fs", { method: "notifications/x", params: { _meta: { pi_dedup_key: "k", pi_summary: "done token=abc" } } })!;
	assert.equal(custom.idempotencyKey, "mcp:fs:custom:k");
	assert.equal(custom.payloadSummary, "notifications/x done [redacted]");
	assert.equal(mapNotification("fs", { method: "notifications/y", params: { _meta: { pi_dedup_key: "k" } } })!.payloadSummary, "notifications/y");
	assert.equal(mapNotification("fs", { method: "notifications/x", params: {} }), undefined);
	assert.equal(mapNotification("fs", { method: "notifications/x", params: { _pi_dedup_key: "k" } }), undefined, "the key is read from `_meta` and nowhere else");
	const secretKey = mapNotification("fs", { method: "notifications/x", params: { _meta: { pi_dedup_key: "sk-abcdefghijklmnopqrstuvwxyz" } } })!;
	assert.match(secretKey.idempotencyKey, /^mcp:fs:custom:hash:/);
});


test("stdio client initializes a fake server and surfaces its notifications", async () => {
	const seen: string[] = [];
	const src = new McpSource(
		{ name: "fake", kind: "stdio", command: process.execPath, args: [path.join(import.meta.dirname, "fake-mcp-server.mjs")], injectSummary: false, injectAndRun: false, requestTimeoutMs: 5000, sseIdleTimeoutMs: 60_000, bodyCapBytes: 1024 * 1024, reconnect: { initialMs: 100, maxMs: 1000, maxAttempts: 1 }, source: "user" },
		{ onNotification: (n) => void seen.push(n.method) },
	);
	src.start();
	const end = Date.now() + 5000;
	while (seen.length < 3 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
	assert.deepEqual(seen, ["notifications/resources/updated", "notifications/custom/thing", "notifications/custom/nokey"]);
	assert.equal(src.status.state, "connected");
	assert.equal(src.status.queuedCount, 3);
	await src.stop();
	assert.equal(src.status.state, "disabled");
});

test("streamable_http client: POST initialize, GET SSE stream, idle reconnect with Last-Event-ID, bearer from token_keychain_ref", async () => {
	const http = await import("node:http");
	const seen: string[] = [];
	const auths: string[] = [];
	const lastEventIds: string[] = [];
	let posts = 0;
	let gets = 0;
	const server = http.createServer((req, res) => {
		auths.push(req.headers.authorization ?? "");
		if (req.method === "POST") {
			let body = "";
			req.on("data", (d) => (body += d));
			req.on("end", () => {
				posts++;
				const msg = JSON.parse(body);
				res.setHeader("Mcp-Session-Id", "sess-42");
				if (msg.method === "initialize") {
					// Reply over SSE to exercise the POST-response-is-a-stream path.
					res.writeHead(200, { "Content-Type": "text/event-stream" });
					res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake-http", version: "0" } } })}\n\n`);
				} else {
					res.writeHead(202);
					res.end();
				}
			});
		} else {
			gets++;
			lastEventIds.push(String(req.headers["last-event-id"] ?? ""));
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write(`id: ev-${gets}\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/listChanged", params: {} })}\n\n`);
			// then go silent: the client's idle timeout must trip and reconnect
		}
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as any).port;
	const src = new McpSource(
		{ name: "h", kind: "streamable_http", endpoint: `http://127.0.0.1:${port}/mcp`, auth: { kind: "bearer", tokenKeychainRef: "FAKE_HUB_TOKEN" }, injectSummary: false, injectAndRun: false, requestTimeoutMs: 3000, sseIdleTimeoutMs: 300, bodyCapBytes: 65536, reconnect: { initialMs: 50, maxMs: 100, maxAttempts: 10 }, source: "user" },
		{ onNotification: (n) => void seen.push(n.method), resolveToken: (ref) => (ref === "FAKE_HUB_TOKEN" ? "tok-123" : undefined) },
	);
	src.start();
	const end = Date.now() + 5000;
	while (seen.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
	await src.stop();
	server.close();
	assert.ok(seen.length >= 2, `expected a notification per (re)connect, got ${seen.length}`);
	assert.ok(seen.every((m) => m === "notifications/tools/listChanged"));
	assert.ok(auths.every((a) => a === "Bearer tok-123"), "bearer token resolved from token_keychain_ref on every request");
	assert.ok(gets >= 2, "idle timeout reconnected the event stream");
	assert.equal(lastEventIds[1], "ev-1", "reconnect resumes with Last-Event-ID");
	assert.ok(posts >= 2, "initialize + initialized were POSTed");
});

test("stdio client: tools/list, tools/call (text+image, isError, error frame), cancel sends notifications/cancelled", async () => {
	const seen: string[] = [];
	let connected = 0;
	const src = new McpSource(
		{ name: "fake", kind: "stdio", command: process.execPath, args: [path.join(import.meta.dirname, "fake-mcp-server.mjs")], injectSummary: false, injectAndRun: false, requestTimeoutMs: 5000, sseIdleTimeoutMs: 60_000, bodyCapBytes: 1024 * 1024, reconnect: { initialMs: 100, maxMs: 1000, maxAttempts: 1 }, source: "user" },
		{ onNotification: (n) => void seen.push(n.method), onConnected: () => void connected++ },
	);
	src.start();
	const end = Date.now() + 5000;
	while (!src.connected && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
	assert.equal(connected, 1);
	const tools = await src.listTools();
	assert.deepEqual(tools.map((t) => t.name), ["echo", "slow", "fail"]);
	assert.deepEqual(tools[0].inputSchema, { type: "object", properties: { text: { type: "string" } }, required: ["text"] });
	const ok = await src.callTool("echo", { text: "hi" });
	assert.deepEqual(ok, { content: [{ type: "text", text: "echo: hi" }, { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", mimeType: "image/png" }], isError: false });
	const bad = await src.callTool("fail", {});
	assert.equal(bad.isError, true);
	await assert.rejects(src.callTool("nope", {}), /unknown tool nope/);
	const ctrl = new AbortController();
	const slow = src.callTool("slow", {}, ctrl.signal);
	setTimeout(() => ctrl.abort(), 50);
	await assert.rejects(slow, /cancelled/);
	const end2 = Date.now() + 2000;
	while (!seen.includes("notifications/custom/cancelled-seen") && Date.now() < end2) await new Promise((r) => setTimeout(r, 25));
	assert.ok(seen.includes("notifications/custom/cancelled-seen"), "server received notifications/cancelled");
	await src.stop();
	await assert.rejects(src.callTool("echo", { text: "x" }), /not connected/);
});

test("streamable_http client: an active event stream is not cut by the idle timeout, which bounds a chunk rather than the stream", async () => {
	const http = await import("node:http");
	const seen: string[] = [];
	let gets = 0;
	const timers: NodeJS.Timeout[] = [];
	const server = http.createServer((req, res) => {
		if (req.method === "POST") {
			let body = "";
			req.on("data", (d) => (body += d));
			req.on("end", () => {
				const msg = JSON.parse(body);
				if (msg.method === "initialize") {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake-http", version: "0" } } }));
				} else {
					res.writeHead(202);
					res.end();
				}
			});
		} else {
			gets++;
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			let n = 0;
			// Busy stream: one event every 100 ms, well inside the 300 ms idle timeout.
			const t = setInterval(() => res.write(`id: ev-${++n}\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/listChanged", params: {} })}\n\n`), 100);
			timers.push(t);
			res.on("close", () => clearInterval(t));
		}
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as any).port;
	const src = new McpSource(
		{ name: "busy", kind: "streamable_http", endpoint: `http://127.0.0.1:${port}/mcp`, injectSummary: false, injectAndRun: false, requestTimeoutMs: 3000, sseIdleTimeoutMs: 1000, bodyCapBytes: 65536, reconnect: { initialMs: 50, maxMs: 100, maxAttempts: 10 }, source: "user" },
		{ onNotification: (n) => void seen.push(n.method) },
	);
	src.start();
	await new Promise((r) => setTimeout(r, 2000));
	await src.stop();
	for (const t of timers) clearInterval(t);
	server.close();
	assert.ok(seen.length >= 10, `expected a steady stream of pushes, got ${seen.length}`);
	assert.equal(gets, 1, "a stream that keeps delivering events must never be aborted by the idle timeout");
});

test("streamable_http client: stop() during the handshake aborts it, never opens the event stream, and stays disabled", async () => {
	const http = await import("node:http");
	let gets = 0;
	const pending: NodeJS.Timeout[] = [];
	const server = http.createServer((req, res) => {
		if (req.method === "POST") {
			let body = "";
			req.on("data", (d) => (body += d));
			req.on("end", () => {
				const msg = JSON.parse(body);
				// Slow handshake: the client is stopped while this reply is still pending.
				pending.push(setTimeout(() => {
					if (msg.method === "initialize") {
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "slow", version: "0" } } }));
					} else {
						res.writeHead(202);
						res.end();
					}
				}, 400));
			});
		} else {
			gets++;
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write(": hello\n\n");
		}
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as any).port;
	const src = new McpSource(
		{ name: "slow", kind: "streamable_http", endpoint: `http://127.0.0.1:${port}/mcp`, injectSummary: false, injectAndRun: false, requestTimeoutMs: 3000, sseIdleTimeoutMs: 5000, bodyCapBytes: 65536, reconnect: { initialMs: 50, maxMs: 100, maxAttempts: 10 }, source: "user" },
		{},
	);
	src.start();
	await new Promise((r) => setTimeout(r, 100));
	await src.stop();
	await new Promise((r) => setTimeout(r, 1000));
	for (const t of pending) clearTimeout(t);
	server.close();
	assert.equal(src.status.state, "disabled", "stop() wins over a handshake that completes later");
	assert.equal(gets, 0, "no event stream is opened after stop()");
});

test("the built-in tool names pi-loops reserves match the installed pi", async () => {
	const { PI_BUILTIN_TOOL_NAMES } = await import("../src/mcp.ts");
	// The resolver hook (src/pi-resolver.mjs) knows where pi lives; ask it for the package root.
	const fs = await import("node:fs");
	// The resolver maps the bare specifier to <pi package>/dist/index.js.
	const dist = path.dirname(new URL(import.meta.resolve("@earendil-works/pi-coding-agent")).pathname);
	const src = fs.readFileSync(path.join(dist, "core", "tools", "index.js"), "utf8");
	const block = src.slice(src.indexOf("allToolNames = new Set(["));
	const names = [...block.slice(0, block.indexOf("]")).matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
	assert.deepEqual([...PI_BUILTIN_TOOL_NAMES].sort(), names.sort(), "pi added or removed a built-in tool: update PI_BUILTIN_TOOL_NAMES");
});
