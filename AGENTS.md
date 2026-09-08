# Working on pi-loops

pi-loops is a pi extension that re-implements pie's automation layer without touching pi.
Keep these invariants:

- **Non-invasive.** Only public pi exports (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
  `typebox`). No monkeypatching, no private fields, no writes outside `~/.pi/agent/loops/`
  (override with `PI_LOOPS_DIR`).
- **No runtime dependencies.** Node built-ins plus pi's bundled packages. The TOML parser, tar
  writer, MCP client and file locks are in-tree on purpose.
- **pie is the reference.** When behavior is in doubt, read the corresponding pie source
  (`crates/coding-agent/src/{triggers/cron.rs,triggers/dynamic.rs,inbox.rs,hooks.rs,
  mcp_loader.rs,session_archive.rs}`, `crates/mcp/`) and match its wording, caps and failure modes.
  Deliberate differences are listed in `CHANGELOG.md` and `docs/design.md`.
- **Sub-agents are `pi -p` children** with `PI_LOOPS_CHILD=1`; the extension stays dormant there
  (no scheduler, no hooks, no cron/trigger tools) but still connects MCP servers for tools.

## Layout

```
src/pi-loops.ts          extension entry: commands, tools, lifecycle, badge, panel
src/scheduler.ts      tick loop, leader election, due/catch-up/overlap, sub-agent runs, checker
src/trigger-runtime.ts dynamic-rule evaluation, deliveries, promotion, audit
src/triggers.ts       rule store, parsing, prompt, dedup window
src/mcp.ts            MCP client (stdio, streamable HTTP), notification mapping, tools
src/hooks.ts          hooks.toml loading and execution
src/archive.ts        .pisession export/import
src/runner.ts         spawn `pi -p --mode json`, parse the event stream
src/protocol.ts       <loop-state>/<inbox>/<verdict> protocol, caps
src/store.ts          jobs.json, state/, runs.jsonl, sessions/
src/inbox.ts          inbox.jsonl
src/schedule.ts       cron / every / once parsing, due computation
src/redact.ts         secret redaction for anything user-visible
src/toml.ts           TOML subset parser
test/                 node --test; test/fake-pi.sh and test/fake-mcp-server.mjs stand in for pi and an MCP server
```

## Checks before you call something done

```bash
npm test             # 52+ unit/integration tests, no network, no model calls
npm run typecheck    # tsc --strict against the globally installed pi's type definitions
```

Real-terminal verification (costs a model call per loop run, ~$0.04 with gpt-5.5):

```bash
D=$(mktemp -d); tmux new-session -d -s piloops -c "$PWD" "PI_LOOPS_DIR=$D pi --no-session -e $PWD"
tmux send-keys -t piloops '/cron add --stateful every 1m List src/*.ts; report each file as a finding' Enter
# wait ~90s, then: tmux send-keys -t piloops '/inbox' Enter; tmux capture-pane -t piloops -p
```

`pi -p` in text mode waits on stdin; redirect `</dev/null` when scripting it.
