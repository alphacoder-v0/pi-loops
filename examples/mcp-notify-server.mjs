#!/usr/bin/env node
// Minimal MCP stdio server that pushes notifications into pi-loops' trigger runtime.
// Node built-ins only. JSON-RPC 2.0, one message per line. Registers one tool and emits a
// `notifications/pi/demo/heartbeat` event every 10 seconds; each carries a unique
// `_meta.pie_dedup_key` (so every beat counts as a distinct trigger) and a human-readable
// `_meta.pie_summary` (what the audit and the chat see).
import readline from "node:readline";

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
let beats = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	if (msg.method === "initialize") {
		send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "pi-loops-notify-demo", version: "0.1.0" } } });
	} else if (msg.method === "notifications/initialized") {
		setInterval(() => {
			beats++;
			send({ jsonrpc: "2.0", method: "notifications/pi/demo/heartbeat", params: { _meta: { pie_dedup_key: `beat-${process.pid}-${beats}`, pie_summary: `demo heartbeat #${beats} at ${new Date().toISOString()}` } } });
		}, 10_000).unref?.();
	} else if (msg.method === "tools/list") {
		send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "demo_status", description: "How many heartbeats this demo server has pushed", inputSchema: { type: "object", properties: {} } }] } });
	} else if (msg.method === "tools/call") {
		send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `pushed ${beats} heartbeat(s) so far` }], isError: false } });
	} else if (msg.method === "ping") {
		send({ jsonrpc: "2.0", id: msg.id, result: {} });
	} else if (msg.id !== undefined) {
		send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unsupported method ${msg.method}` } });
	}
});
