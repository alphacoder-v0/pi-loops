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
src/share.ts          /share: the transcript as redacted Markdown for `gh gist create`
test/                 node --test; test/fake-runner.ts and test/fake-mcp-server.mjs stand in for the model and an MCP server
scripts/              typecheck.mjs and lint.mjs — both borrow TypeScript through npx, no dependency
examples/pi-web.mjs   a browser front end for pi over `pi --mode rpc`, one dependency-free file
```

## Checks before you call something done

```bash
npm run ci           # what .github/workflows/ci.yml runs: typecheck, lint, tests
```

or one at a time:

```bash
npm run typecheck    # tsc --strict against the globally installed pi's type definitions
npm run lint         # scripts/lint.mjs — floating promises and silent catches (see below)
npm test             # 190 unit/integration tests, no network, no model calls (test/register-pi.mjs resolves pi's SDK from the global install)
```

CI runs the same three on Linux and macOS with **every provider credential cleared**. The suite is
offline by construction — sub-agents go through `test/fake-runner.ts` — and clearing the keys is
what keeps that a fact: a test that ever reaches a real provider fails there instead of quietly
spending money.

### The lint rules, and why these two

`scripts/lint.mjs` borrows the TypeScript compiler through npx (no dependency, the way
`typecheck.mjs` borrows `tsc`) and checks two things it can see with types that a reader cannot see
reliably:

- **floating-promise** — a promise that is neither awaited nor given a `.catch`. **pi installs no
  `unhandledRejection` handler**, so a rejection nobody is waiting for does not warn: it ends the
  editor, and with it every loop, trigger and MCP connection in that session. `void something()` is
  not an exemption — it is the shape this bug usually takes — so a `void` needs a `.catch` too.
  Three separate incidents in this project came from this one class.
- **silent-catch** — `catch {}` with no comment. Dropping an error is often right here (a torn
  line, a missing optional file); doing it without saying why is how the next reader loses an hour.

Add a rule when a class of mistake has cost the project twice. Do not add style rules: this is a
correctness gate, not a formatter.

Real-terminal verification (costs a model call per loop run, ~$0.04 with gpt-5.5):

```bash
D=$(mktemp -d); tmux new-session -d -s piloops -c "$PWD" "PI_LOOPS_DIR=$D pi --no-session -e $PWD"
tmux send-keys -t piloops '/cron add --stateful every 1m List src/*.ts; report each file as a finding' Enter
# wait ~90s, then: tmux send-keys -t piloops '/inbox' Enter; tmux capture-pane -t piloops -p
```

`pi -p` in text mode waits on stdin; redirect `</dev/null` when scripting it.
