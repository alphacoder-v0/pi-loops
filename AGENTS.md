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
- **Sub-agents are in-process sessions** created with pi's SDK (`src/sdk-runner.ts`), never child
  processes: they share the interactive pi's MCP clients, extensions and model, get the automation
  tools at hop 1 as `customTools`, and never load a second copy of this extension.

## Layout

```
src/pi-loops.ts          extension entry: commands, tools, lifecycle, badge, panel
src/scheduler.ts      tick loop, leader election, due/catch-up/overlap, sub-agent runs, checker
src/trigger-runtime.ts dynamic-rule evaluation, deliveries, promotion, audit
src/triggers.ts       rule store, parsing, prompt, dedup window
src/mcp.ts            MCP client (stdio, streamable HTTP), notification mapping, tools
src/hooks.ts          hooks.toml loading and execution
src/archive.ts        .pisession export/import
src/runner.ts         SubagentRunner interface, result shape, the parent's inheritable flags
src/sdk-runner.ts     the in-process runner on pi's SDK (createAgentSession per run)
src/tools.ts          the cron/trigger tool definitions (interactive session, sub-sessions, host)
src/goal.ts           /goal: the stop-condition state machine, evaluator prompts, continuation budget
src/cli.ts            `pi-loops export|import|host`; src/cli-entry.mjs is its bin
src/host.ts           the headless host that keeps the clock after the last pi quits
src/host-control.ts   host.json, spawn/stop, the hand-off decision
src/host-control-channel.ts  the host's unix socket: snapshot, abort, stop
src/host-runtime.ts   what the host runs (scheduler + triggers + per-request tool host)
src/mcp-pool.ts       another project's MCP servers, connected on demand for its runs
src/danger.ts         pie's dangerous-command policy for unattended runs
src/subagent-guard.ts the synthetic extension that applies it inside every sub-session
src/register-pi.mjs   node --import hook resolving pi's packages outside pi (host, tests)
src/protocol.ts       <loop-state>/<inbox>/<verdict> protocol, caps
src/store.ts          jobs.json, state/, runs.jsonl, sessions/
src/inbox.ts          inbox.jsonl
src/schedule.ts       cron / every / once parsing, due computation
src/redact.ts         secret redaction for anything user-visible
src/toml.ts           TOML subset parser
test/                 node --test; test/fake-runner.ts and test/fake-mcp-server.mjs stand in for the model and an MCP server
```

## Checks before you call something done

```bash
npm test             # 145 unit/integration tests, no network, no model calls (test/register-pi.mjs resolves pi's SDK from the global install)
npm run typecheck    # tsc --strict against the globally installed pi's type definitions
```

Real-terminal verification (costs a model call per loop run, ~$0.04 with gpt-5.5):

```bash
D=$(mktemp -d); tmux new-session -d -s piloops -c "$PWD" "PI_LOOPS_DIR=$D pi --no-session -e $PWD"
tmux send-keys -t piloops '/cron add --stateful every 1m List src/*.ts; report each file as a finding' Enter
# wait ~90s, then: tmux send-keys -t piloops '/inbox' Enter; tmux capture-pane -t piloops -p
```

`pi -p` in text mode waits on stdin; redirect `</dev/null` when scripting it.
