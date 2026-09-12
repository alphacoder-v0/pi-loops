# MCP: notification sources and tools

pi has no built-in MCP client; pi-loops carries a small one (stdio and streamable HTTP) that is

## Configuration

`~/.pi/agent/loops/mcp.toml`, plus `<project>/.pi/mcp.toml` for trusted projects (same server
name → project wins). The schema:

```toml
[[server]]
name = "filesystem"                    # kind defaults to stdio
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
# env = { FOO = "bar" }                # extra environment for the server process

[[server]]
name = "hub"
kind = "streamable_http"
endpoint = "https://example.com/mcp"   # https required, 127.0.0.1 excepted
auth = { kind = "bearer", token_keychain_ref = "PI_MCP_TOKEN_HUB" }  # pi's credential store, or a PI_MCP_TOKEN_* env var
request_timeout_ms = 30000
sse_idle_timeout_ms = 60000            # reconnect when the event stream goes silent
body_cap_bytes = 1048576
reconnect = { initial_ms = 500, max_ms = 30000, max_attempts = 10 }
inject_summary = true                  # summary straight into the chat, no model call
# inject_and_run = true                # summary into the chat + one agent turn
```

A misconfigured server is reported as `mcp server '<name>' failed: …`; the others still connect.
stdio servers must not set `endpoint`/`auth`; timeouts, caps and reconnect delays must be positive;
only bearer auth is supported.

## Notifications → triggers

Server pushes are mapped: `tools/resources/prompts listChanged` use stable
keys and collapse to the latest event; `resources/updated` is keyed per URI; custom notifications
need `_meta.pi_dedup_key` or are dropped at the source and counted. Summaries contain only the
method name plus bounded, redacted metadata (`notifications/resources/updated uri=…`,
`_meta.pi_summary` capped at 200 chars) — never raw params. `pie_dedup_key` and `pie_summary` are
older names for the same two fields and are still read.

Delivery per server: `inject_summary` (promotion only), `inject_and_run` (user message + one turn),
or the default: evaluation against the dynamic rules by a sub-agent.

## Tools

After the handshake each server's `tools/list` is registered with pi:
original names (prefixed with `<server>_` on collision), schemas passed through, `tools/call` text /
image / resource content mapped to tool results, `isError` surfaced as a tool error, and
`notifications/cancelled` sent when the user interrupts. `/triggers sources` lists the tools per
server.

## Processes

An unattended run refuses a corpus of dangerous commands (see [loops.md](loops.md)); a project that
legitimately needs one of those commands can list it:

```toml
[danger]
allow = ["rm -rf /var/cache/mybuild"]
```

An entry means that command and nothing else. `rm -rf /var/cache/mybuild/tmp` is covered — a path
strictly inside the one the entry names — but `rm -rf /var/cache/mybuild /`,
`rm -rf /var/cache/mybuild/../..` and `rm -rf /var/cache/mybuild; rm -rf /` are not: they lose the
exemption and are scanned like any other command. The commands reaching this gate are written by a
model that may have read something hostile, so an entry has to mean one command and not a foothold;
a run that needs two shapes of a command lists both.

A sub-agent shares this process's live clients rather than opening its own, so a browser tab or
database session opened in the chat is the one the loop sees. When a run's project is not this
process's own, that project's `.pi/mcp.toml` servers are connected on demand and lent to the run
(only if the user has trusted that project), so a loop is not at the mercy of which window owns
the clock; the headless host does the same. Notifications are consumed by interactive processes only; a
sub-agent ignores what its own connection pushes: sub-agents register no notification
hooks. A push that injects into the chat (`inject_summary` / `inject_and_run`) reaches every window
that has the server; a push evaluated against dynamic rules is
evaluated once per project, by the pi that owns that project's checks. A repeated `[[server]]` name replaces the earlier entry (a diagnostic says
so); the project file is `<project>/.pi/mcp.toml`, or `<project>/.pie/mcp.toml` under that directory's older name, which is still read so a project already carrying one needs no second copy.
A machine-wide dedup window (`~/.pi/agent/loops/dedup.json`, 5 minutes) makes each push count once
no matter how many pi windows are open, and results are promoted only into a chat that belongs to
the rule's project (otherwise they go to the inbox). Crashed stdio servers are reconnected with
exponential backoff, 20 attempts by default, each distinct error reported once (rather than marking them
disconnected). `/triggers sources` lists MCP servers first, then the cron hook, then the dynamic
checker, in registration order; a stdio server's last stderr line is shown as `stderr:`
(diagnostic only — a successful push clears `last error`, stderr never sets it).
`examples/mcp-notify-server.mjs` is a dependency-free push server to try this with.
