import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToml } from "../src/toml.ts";

test("parses pie-style mcp.toml / hooks.toml / config.toml", () => {
	const doc = parseToml(`
# comment
allow_project_hooks = true

[triggers]
poll_interval_secs = 600 # trailing comment

[[server]]
name = "filesystem"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", '/tmp']
inject_summary = false

[[server]]
name = "hub"
kind = "streamable_http"
endpoint = "https://example.com/mcp#frag"
auth = { kind = "bearer", token = "abc" }
inject_and_run = true

[[hook]]
event = "tool_end"
tool = "bash"
command = "echo \\"$PIE_TOOL_NAME error=$PIE_TOOL_IS_ERROR\\" >> ~/.pie/tool-hooks.log"
timeout_ms = 3000

[[hook]]
event = "turn_end"
webhook = "https://example.com/pie/hooks"

[hook.headers]
Authorization = "Bearer your-token"
`);
	assert.equal(doc.allow_project_hooks, true);
	assert.deepEqual(doc.triggers, { poll_interval_secs: 600 });
	const servers = doc.server as any[];
	assert.equal(servers.length, 2);
	assert.deepEqual(servers[0].args, ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]);
	assert.equal(servers[1].endpoint, "https://example.com/mcp#frag");
	assert.deepEqual(servers[1].auth, { kind: "bearer", token: "abc" });
	assert.equal(servers[1].inject_and_run, true);
	const hooks = doc.hook as any[];
	assert.equal(hooks[0].command, 'echo "$PIE_TOOL_NAME error=$PIE_TOOL_IS_ERROR" >> ~/.pie/tool-hooks.log');
	assert.equal(hooks[0].timeout_ms, 3000);
	assert.deepEqual(hooks[1].headers, { Authorization: "Bearer your-token" });
	assert.equal(hooks[1].webhook, "https://example.com/pie/hooks");
});

test("errors carry line numbers", () => {
	assert.throws(() => parseToml('a = "unterminated'), /line 1/);
	assert.throws(() => parseToml("x = 1\ny = [1, 2"), /line 2/);
});
