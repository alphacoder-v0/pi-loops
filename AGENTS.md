# Working on pi-loops

pi-loops is an automation layer for pi, shipped as an extension that touches nothing in pi.
Keep these invariants:

- **Non-invasive.** Only public pi exports (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
  `typebox`). No monkeypatching, no private fields, no writes outside `~/.pi/agent/loops/`
  (override with `PI_LOOPS_DIR`).
- **No runtime dependencies.** Node built-ins plus pi's bundled packages. The TOML parser, tar
  writer, MCP client and file locks are in-tree on purpose.
- **Behaviour is specified in `docs/` and pinned by the tests.** When it is in doubt, the doc is
  the answer and the test is the proof — and if neither says, that is the bug to fix first. Wording,
  caps and failure modes are part of the behaviour: a message someone has learned to recognise is
  an interface. `docs/design.md` holds the decisions and what each one costs.
- **Sub-agents are in-process sessions** created with pi's SDK (`src/sdk-runner.ts`), never child
  processes: they share the interactive pi's MCP clients, extensions and model, get the automation
  tools at hop 1 as `customTools`, and never load a second copy of this extension.

## Layout

```
src/pi-loops.ts             extension entry: commands, tools, lifecycle, badge, panel
src/cli.ts                  `pi-loops`: the session launcher (web or terminal) and export|import|host
src/cli-entry.mjs           the bin that loads it

the pipelines
src/scheduler.ts            tick loop, leader election, due/catch-up/overlap, sub-agent runs, checker
src/trigger-runtime.ts      dynamic-rule evaluation, deliveries, promotion, audit
src/triggers.ts             rule store, parsing, prompt, dedup window
src/goal.ts                 /goal: the stop-condition state machine, evaluator prompts, continuation budget
src/tools.ts                the cron/trigger tool definitions (interactive session, sub-sessions, host)
src/protocol.ts             <loop-state>/<inbox>/<verdict> protocol, caps
src/schedule.ts             cron / every / once parsing, due computation
src/job-edit.ts             what /cron set decides, as a function: which stamp to anchor, what runs next
src/args.ts                 /cron add argument parsing
src/thinking.ts             which thinking levels exist, asked wherever one is typed or handed over
src/slots.ts                the one sub-agent concurrency pool both pipelines and /goal draw from
src/job-health.ts           which loops count as failing, and the badge/summary line that says so

running a sub-agent
src/runner.ts               SubagentRunner interface, result shape, the parent's inheritable flags
src/sdk-runner.ts           the in-process runner on pi's SDK (createAgentSession per run)
src/danger.ts               the dangerous-command policy for unattended runs
src/subagent-guard.ts       the synthetic extension that applies it inside every sub-session
src/transcript.ts           a sub-agent's session file, folded into readable lines

running with no pi open
src/host.ts                 the headless host that keeps the clock after the last pi quits
src/host-control.ts         host.json, spawn/stop, the hand-off decision
src/host-control-channel.ts the host's unix socket: snapshot, abort, stop
src/host-runtime.ts         what the host runs (scheduler + triggers + per-request tool host)
src/presence.ts             one file per live pi: who is open where, so a result lands in the right chat
src/register-pi.mjs         node --import hook resolving pi's packages outside pi (host, tests)
src/pi-resolver.mjs         where that hook looks for them

storage
src/store.ts                jobs.json, state/, runs.jsonl, sessions/
src/inbox.ts                inbox.jsonl
src/archive.ts              .pisession export/import
src/lock.ts                 the mkdir lock, atomic writes, is-that-pid-alive
src/paths.ts                realpathish: the deepest existing ancestor's realpath, so a path that is not there yet resolves as its parent does
src/snapshot.ts             the pi_loops_snapshot fingerprint, and when a new entry is worth writing
src/config.ts               config.toml and the environment overrides

connections and output
src/mcp.ts                  MCP client (stdio, streamable HTTP), notification mapping, tools
src/mcp-pool.ts             another project's MCP servers, connected on demand for its runs
src/hooks.ts                hooks.toml loading and execution
src/share.ts                /session-share: the transcript as redacted Markdown for `gh gist create`
src/redact.ts               secret redaction for anything user-visible
src/log.ts                  logs/pi-<pid>.log: rotation, and who gets to write
src/trust.ts                whether pi trusts a directory, asked before anything reads that project
src/toml.ts                 TOML subset parser
src/version.ts              the version every archive, payload and `/pi-loops` line reports

src/web.mjs                 the browser front end: `pi --mode rpc` behind a page, one dependency-free file
skills/pi-loops/            when the agent should reach for cron_create, new_trigger and the inbox
examples/                   a dependency-free MCP push server, and an mcp.toml to point at it
test/                       node --test; test/fake-runner.ts and test/fake-mcp-server.mjs stand in for the model and an MCP server
scripts/                    typecheck.mjs and lint.mjs — both borrow TypeScript through npx, no dependency
```

## Checks before you call something done

```bash
npm run ci           # what .github/workflows/ci.yml runs: typecheck, lint, tests
```

or one at a time:

```bash
npm run typecheck    # tsc --strict against the globally installed pi's type definitions
npm run lint         # scripts/lint.mjs — floating promises and silent catches (see below)
npm test             # the unit/integration suite: no network, no model calls (src/register-pi.mjs resolves pi's SDK from the global install)
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

The browser front end has a second rule of its own: [docs/web-ui-parity.md](docs/web-ui-parity.md)
lists what a person can still do after the window changed. It is a gate — a release either keeps
every line or says which one it dropped and why. Adding an affordance means adding a line; removing
one means moving it to the "held" section with the reason, not deleting it.

The page inside `src/web.mjs` is a blind spot for both: it is a string, so the linter never sees it
and `node --check` only parses the file around it. `test/web-page.test.ts` runs that script against
a DOM stub for exactly this reason — an undefined identifier in it used to ship silently and leave
the front end unable to display anything. Anything you add to the page needs a line there.

## Where a decision goes

`src/pi-loops.ts` is the extension's default export, so nothing can import it and nothing in it can
be tested. Anything it *decides* — which stamp to anchor when a schedule changes, whether a name is
usable, what a run's hook payload says — belongs in a module beside it, taking state and returning
the change (`src/job-edit.ts` is the pattern: `applyJobEdit(job, edit, ctx)` returns a patch, the
lines to log, and when the job runs next). What is left in the handler is reading arguments,
writing the store and printing, which is the part a person can check by looking.

Return a *patch*, not a rebuilt object: `JobStore.update` re-reads under a lock, and a whole object
built from a stale copy erases whatever a tick wrote in between.

Real-terminal verification (costs a model call per loop run, ~$0.04 with gpt-5.5):

```bash
D=$(mktemp -d); tmux new-session -d -s piloops -c "$PWD" "PI_LOOPS_DIR=$D pi --no-session -e $PWD"
tmux send-keys -t piloops '/cron add --stateful every 1m List src/*.ts; report each file as a finding' Enter
# wait ~90s, then: tmux send-keys -t piloops '/inbox' Enter; tmux capture-pane -t piloops -p
```

`pi -p` in text mode waits on stdin; redirect `</dev/null` when scripting it.
