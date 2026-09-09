import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { McpSource } from "../src/mcp.ts";

/** A streamable-http server that answers POSTs but refuses the optional GET stream, as the spec allows. */
function noPushServer(): Promise<{ url: string; close: () => void; gets: () => number }> {
	let gets = 0;
	const server = http.createServer((req, res) => {
		if (req.method === "GET") {
			gets++;
			res.writeHead(405).end();
			return;
		}
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const msg = JSON.parse(body || "{}");
			if (msg.method === "notifications/initialized") return void res.writeHead(202).end();
			const result = msg.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "nopush", version: "1" } } : { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: {} } }] };
			res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as any).port;
			resolve({ url: `http://127.0.0.1:${port}/mcp`, close: () => server.close(), gets: () => gets });
		});
	});
}

test("a server with no server-push stream stays usable instead of hot-looping", async () => {
	const s = await noPushServer();
	const source = new McpSource({ name: "nopush", kind: "streamable_http", endpoint: s.url, requestTimeoutMs: 5000, sseIdleTimeoutMs: 5000, bodyCapBytes: 1 << 20, reconnect: { initialMs: 20, maxMs: 100, maxAttempts: 5 } } as any, {});
	try {
		source.start();
		const end = Date.now() + 5000;
		while (source.status.state !== "connected" && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
		assert.equal(source.status.state, "connected");
		const tools = await source.listTools();
		assert.equal(tools[0].name, "echo", "tool calls work without the optional stream");
		await new Promise((r) => setTimeout(r, 600));
		assert.equal(source.status.state, "connected", "and it stays connected");
		assert.ok(s.gets() <= 2, `the GET is not retried in a hot loop (saw ${s.gets()})`);
		assert.match(source.status.lastError ?? "", /no server-push stream/);
	} finally {
		await source.stop();
		s.close();
	}
});

test("a server that answers initialize and then dies is not respawned forever", async () => {
	const source = new McpSource({ name: "crashloop", kind: "stdio", command: process.execPath, args: ["-e", `
		let buf = "";
		process.stdin.on("data", (d) => {
			buf += d;
			let i;
			while ((i = buf.indexOf("\\n")) >= 0) {
				const line = buf.slice(0, i); buf = buf.slice(i + 1);
				const msg = JSON.parse(line);
				if (msg.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "x", version: "1" } } }) + "\\n");
				if (msg.method === "notifications/initialized") process.exit(1);
			}
		});
	`], requestTimeoutMs: 5000, bodyCapBytes: 1 << 20, reconnect: { initialMs: 10, maxMs: 40, maxAttempts: 4 } } as any, {});
	try {
		source.start();
		const end = Date.now() + 10_000;
		while (source.status.state !== "disconnected" && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
		assert.equal(source.status.state, "disconnected", "the reconnect budget is spent and the source gives up");
		assert.match(source.status.requiresAttention ?? "", /fix the server config/);
	} finally {
		await source.stop();
	}
});
