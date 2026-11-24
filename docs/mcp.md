# MCP: notification sources and tools

pi has no built-in MCP client; pi-loops carries a small one (stdio and streamable HTTP) that consumes
notifications and registers the servers' tools with pi.

## Configuration

`~/.pi/agent/loops/mcp.toml`, plus `<project>/.pi/mcp.toml` for trusted projects (same server
name → project wins). A project that has nothing of pi's own to protect is one pi never asks about,
so there `.pi/mcp.toml` loads only once `/trust` has saved trust for it (pi applies that at its
next start) or pi was started with `--approve`; until then the window says it ignored the file. The schema:

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
need `_meta.pi_dedup_key`. One without it is stored in `events.jsonl` like any push, counted, and
nothing acts on it. Summaries contain only the
method name plus bounded, redacted metadata (`notifications/resources/updated uri=…`,
`_meta.pi_summary` capped at 200 chars) — never raw params.

Delivery per server: `inject_summary` (promotion only), `inject_and_run` (a user message and one turn, queued as a request and run once the agent is idle),
or the default: evaluation against the dynamic rules by a sub-agent. An `inject_and_run` turn is a
scheduled turn, as a plain job's is: a command the dangerous-command policy names is not run.
pi-loops asks you, in the conversation and in the inbox, and the turn goes on without it
([loops.md](loops.md), [configuration.md](configuration.md)).

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

A sub-agent shares the live clients of the process that runs it rather than opening its own. Loops
and rule checks run in the background, so a loop sees pi-loops' clients from the user-level `mcp.toml`,
not a browser tab or database session opened in a chat. A run's own project's `.pi/mcp.toml`
servers are connected on demand and lent to the run (only if the user has trusted that project).
A sub-agent ignores what its own connection pushes: sub-agents register no notification hooks. A
push that injects into the chat (`inject_summary` / `inject_and_run`) reaches every window that
holds a conversation and has the server; pi-loops files it in the inbox only when no window lists
that server on its lease. A push evaluated against dynamic rules is evaluated once per project, by
pi-loops. That includes a project's own `.pi/mcp.toml` servers: pi-loops keeps the push servers of
every trusted project that has enabled rules connected (the first eight such projects), and a push
from one is checked against that project's rules only. A project whose trust is revoked, or whose
last rule is removed or disabled, has its servers stopped within a minute.

A repeated `[[server]]` name replaces the earlier entry (a diagnostic says so); the project file is
`<project>/.pi/mcp.toml`.
Each push is stored in `events.jsonl` as it arrives, before anything acts on it. A push evaluated
against the rules then waits on disk as a row in each project's check lane, so it survives a
restart. At most 32 pushes wait in one lane; when one more arrives, the oldest waiting push is
dropped with a `dropped` audit row. A push with the same idempotency key as one in the last 5
minutes counts once: per project for rule evaluation, and per process for an injected push. The
window is read from `events.jsonl`, not kept beside it. When pi-loops starts in the background, it
writes the rows again for the pushes it stored in the last 5 minutes whose rows a stop or a crash
kept from being written. It does that for user-level servers only: a project's own server's push is
not written again, because the log does not say which project it was for. `pi-loops events replay
<id>` runs a stored push again ([cli.md](cli.md#events)). A rule's result goes to the conversation
that created it (see [triggers.md](triggers.md)). Crashed stdio servers are reconnected with
exponential backoff, 20 attempts by default, each distinct error reported once (rather than marking them
disconnected). `/triggers sources` lists MCP servers first, then the cron hook, then the dynamic
checker, in registration order; a stdio server's last stderr line is shown as `stderr:`
(diagnostic only — a successful push clears `last error`, stderr never sets it).
`examples/mcp-notify-server.mjs` is a dependency-free push server to try this with.
