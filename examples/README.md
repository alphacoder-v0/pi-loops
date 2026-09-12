# Examples

## mcp-notify-server.mjs — an MCP server that pushes into pi-loops

An MCP server in Node with no dependencies, small enough to read in one sitting.
The server registers one tool (`demo_status`) and pushes a `notifications/pi/demo/heartbeat`
event every 10 seconds. Each push carries `_meta.pi_dedup_key` (unique per beat, so nothing is
deduplicated away) and `_meta.pi_summary` (the text the audit, the panel and — with
`inject_summary` — the chat will show).

```sh
cp examples/mcp.toml ~/.pi/agent/loops/mcp.toml    # or merge the [[server]] block
pi                                                  # then: /triggers sources
```

Without an `inject_*` flag each push is evaluated by the dynamic-rule sub-agent against your
`/new-trigger` rules; with `inject_summary = true` the summary lands in the chat directly;
with `inject_and_run = true` the agent also reacts to it. See [docs/mcp.md](../docs/mcp.md).
