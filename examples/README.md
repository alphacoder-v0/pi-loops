# Examples

## mcp-notify-server.mjs — an MCP server that pushes into pi-loops

pie ships `examples/mcp-notify-python`; this is the same idea in Node with no dependencies.
The server registers one tool (`demo_status`) and pushes a `notifications/pi/demo/heartbeat`
event every 10 seconds. Each push carries `_meta.pie_dedup_key` (unique per beat, so nothing is
deduplicated away) and `_meta.pie_summary` (the text the audit, the panel and — with
`inject_summary` — the chat will show).

```sh
cp examples/mcp.toml ~/.pi/agent/loops/mcp.toml    # or merge the [[server]] block
pi                                                  # then: /triggers sources
```

Without an `inject_*` flag each push is evaluated by the dynamic-rule sub-agent against your
`/new-trigger` rules; with `inject_summary = true` the summary lands in the chat directly;
with `inject_and_run = true` the agent also reacts to it. See [docs/mcp.md](../docs/mcp.md).

## pi-web.mjs — a browser front end for pi, in one file

pie has `pie web`: a browser UI that replaces its terminal UI and drives the same agent. pi keeps
its own terminal UI, so this takes the other door pi already provides — `pi --mode rpc`, which is
pi with no terminal front end at all, speaking JSON lines on stdin and stdout. `pi-web.mjs` runs
that, serves a page, and passes the protocol through. The session is a real pi session: same
models, tools, extensions, session file, and `pi --resume` picks it up afterwards.

```sh
node examples/pi-web.mjs                                  # prints a loopback URL with a token
node examples/pi-web.mjs -- --model anthropic/claude-opus-5   # after -- goes to pi
node examples/pi-web.mjs -- --continue                        # continue pi's newest session here
```

`pi-web.mjs` starts a separate `pi --mode rpc` process; it does not attach to an
already-open terminal pi. Pass pi arguments after `--` to continue or choose an existing session,
for example `-- --continue`, `-- --resume` or `-- --session <id-or-path>`.

No dependencies, no build step: one `.mjs` with the page inlined, the same way pie keeps its UI in
one `web_index.html`. It binds `127.0.0.1` only and there is no flag to change that; every route
needs the token and a loopback `Host`, and the browser is launched with a one-shot key rather than
the token, because on Linux any local account can read another process's command line.

What it does: streaming feed with thinking and tool calls, history replay, prompt queue (and
clearing it), abort, model and thinking-level pickers, compact, images, `/` and `@` completion,
`@file` expansion, session search, undo (fork from your last message), HTML export, cost and
context gauge, and the extension dialogs — pi-loops' control-plane approvals are answered in the
browser instead of the terminal.

The Automation panel reads `jobs.json`, `triggers.json` and `inbox.jsonl` directly; the Runtime
panel reads the `pi_loops_snapshot` entry pi-loops writes into the session (`/cron snapshot`
forces a fresh one), because which MCP servers actually connected, what they exposed, which tools
are active and who owns the clock exist only inside the pi process.

Two things are terminal-only and stay that way: `/login` (OAuth has no rpc command — log in once
with `pi`, then start this) and pi's other built-in slash commands, which do not exist in rpc mode.
Typing one is refused with a pointer to the button that does the same thing, rather than being
passed to the model as text.
