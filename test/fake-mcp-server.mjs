// Fake MCP stdio server: answers initialize, then pushes a few notifications.
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
rl.on("line", (line) => {
	let msg;
	try { msg = JSON.parse(line); } catch { return; }
	if (msg.method === "tools/list") {
		send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
			{ name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
			{ name: "slow", description: "Never answers", inputSchema: { type: "object", properties: {} } },
			{ name: "fail", description: "Returns isError", inputSchema: { type: "object", properties: {} } },
		] } });
	} else if (msg.method === "tools/call") {
		const { name, arguments: args } = msg.params ?? {};
		if (name === "echo") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `echo: ${args?.text ?? ""}` }, { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", mimeType: "image/png" }], isError: false } });
		else if (name === "fail") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "boom" }], isError: true } });
		else if (name === "slow") { /* never reply; record cancellation */ }
		else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } });
	} else if (msg.method === "notifications/cancelled") {
		send({ jsonrpc: "2.0", method: "notifications/custom/cancelled-seen", params: { _meta: { pie_dedup_key: `cancel-${msg.params?.requestId}` } } });
	} else if (msg.method === "initialize") {
		send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "0" } } });
	} else if (msg.method === "notifications/initialized") {
		send({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri: "file:///tmp/a.txt" } });
		send({ jsonrpc: "2.0", method: "notifications/custom/thing", params: { _meta: { pie_dedup_key: "k1", pie_summary: "build finished token=abc" } } });
		send({ jsonrpc: "2.0", method: "notifications/custom/nokey", params: {} });
		send({ jsonrpc: "2.0", id: 99, method: "roots/list", params: {} });
		if (process.env.FAKE_MCP_EXIT) setTimeout(() => process.exit(0), 100);
	}
});
