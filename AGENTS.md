# Working on pi-loops

pi-loops is an automation layer for pi, shipped as an extension that touches nothing in pi.
Read [LESSONS.md](LESSONS.md) before you start: it lists the mistakes that merged changes made here.
Keep these invariants:

- **Non-invasive.** Only public pi exports (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
  `typebox`). No monkeypatching, no private fields, no writes outside `~/.pi/agent/loops/`
  (override with `PI_LOOPS_DIR`). Two paths are the exceptions. The control socket's fallback directory
  `$TMPDIR/pi-loops-<uid>/` is used when the loops directory's path is too long for a unix socket.
  The other is the launcher, `pi-loops` in a directory already on your PATH. It is written on the
  first interactive session when a directory on PATH has room for it and the person has not removed
  it before (or by `install-launcher`), rewritten afterwards only where one of ours already is, and
  removed by `uninstall-launcher`. A session file that pi itself
  writes when we call its public session API is pi's write, not ours, the same class of write as
  `pi.sendUserMessage`: `/inbox open` asks `SessionManager.forkFrom` for a new conversation and never
  opens the run's transcript for writing, and pi-loops writes into a closed conversation
  (`SessionManager.open` and an `AgentSession`) only while it holds that conversation's lease.
- **No runtime dependencies.** Node built-ins plus pi's bundled packages. The TOML parser, tar
  writer, MCP client and file locks are in-tree on purpose.
- **Behaviour is specified in `docs/` and pinned by the tests.** When it is in doubt, the doc is
  the answer and the test is the proof — and if neither says, that is the bug to fix first. Wording,
  caps and failure modes are part of the behaviour: a message someone has learned to recognise is
  an interface. `docs/design.md` holds the decisions and what each one costs.
- **Sub-agents are in-process sessions** created with pi's SDK (`src/sdk-runner.ts`), never child
  processes: they share the MCP clients, extensions and model of the process that runs them (pi-loops,
  for loops and checks), get the automation tools at hop 1 as `customTools`, and never load a
  second copy of this extension. A held turn is the one that opens an existing conversation
  instead of a new transcript, and it loads its own resources rather than the shared set.

## Layout

```
src/extension-entry.ts      what pi loads: checks pi's version (src/pi-floor.ts), then imports src/pi-loops.ts
src/pi-loops.ts             the extension: commands, tools, lifecycle, badge, panel
src/cli.ts                  `pi-loops`: the session launcher (web or terminal) and export|import|start|stop|restart|status|abort|recipe|inbox
src/cli-entry.mjs           the bin that loads it
src/ts-entry.mjs            how an .mjs entry point imports this package's .ts: Node's type stripping, or pi's jiti under node_modules

the pipelines
src/backoff.ts              the one table of waits after a failure: a row, a loop, a rule check
src/job-status.ts           what a list shows for one job, folded from its clock, rows and run history
src/clock.ts                the schedule cursor, pure tick decisions and their compare-and-set writes
src/settle.ts               how a plain job's turn ends, as one table: what becomes of its row and of its job, for each way a run ends
src/scheduler.ts            no longer fires anything: the clock rider writes every slot and the lanes run them. A window still builds one for `ownerView` (which plain jobs its clock fires), `runningRuns`, `runningCount` and `abortRun`; pi-loops in the background builds one too, as `HostRuntime.scheduler`, and stops it at its stop; the control channel and `src/tools.ts` fall back to it when they have no run list or stores; and `SessionSnapshot`, `PlainJobLeases` and a second `DEFAULT_RUN_TIMEOUT_MS` are still declared in it, imported by `src/loop-run.ts`, `src/tools.ts`, `src/host.ts`, `src/host-runtime.ts` and `src/pi-loops.ts`. M4b.5 moves these and deletes it
src/loop-run.ts              one loop run, its stop record, and its ordered closing writes
src/ticker.ts               one process timer and its typed, ordered riders
src/stores.ts               stores of a loops directory, opened once, and job removal
src/trigger-runtime.ts      dynamic-rule evaluation, deliveries, promotion, audit
src/triggers.ts             rule store, parsing, prompt, dedup window
src/goal.ts                 /goal: the stop-condition state machine, evaluator prompts, continuation budget
src/tools.ts                the cron/trigger tool definitions (interactive session and sub-sessions)
src/watch-plan.ts           a watch from one sentence, as the question cron_create and new_trigger ask before they create: the plan, its card, the dialog's title and options, and the one place an answer becomes store fields
src/protocol.ts             <loop-state>/<inbox>/<verdict> protocol, caps
src/schedule.ts             cron / every / once parsing, due computation
src/job-edit.ts             what /cron set decides, as a function: which stamp to anchor, what runs next
src/recipe.ts               what /recipe decides: manifest parsing (each [[job]] checked as the /cron add line it stands for), install, exclude, update merge
src/args.ts                 /cron add argument parsing
src/thinking.ts             which thinking levels exist, asked wherever one is typed or handed over
src/slots.ts                the one sub-agent concurrency pool both pipelines and /goal draw from
src/run-list.ts             the runs that are going in this process, as one list; a claim on a row is written only through it
src/job-health.ts           which loops and trigger rules count as failing, and the badge/summary line and `[failing ×N]` mark that say so
src/job-signal.ts           what a loop's runs came to: findings filed, claimed, dismissed, and the quiet streak `/cron` marks
src/job-lines.ts            the `/cron` listing itself, out of the unimportable extension so a marker or column is testable
src/job-owner.ts            where a job runs, as one question the scheduler, the lists and `/cron run` all ask the same way
src/job-tune.ts             the one change the page suggests for a loop, decided from its signal, never applied by itself
src/path-precheck.ts        a rule that only waits for a path: `stat` before any model is asked
src/run-card.ts             what a finished run writes into the conversation, and which runs are fresh (`freshRuns`)
src/inbox-card.ts           a finding as a person reads it: card, terminal line, `screenText`, and the claim prompt
src/activity.ts             the page's activity strip and attention counts, computed from the run, audit and inbox files

running a sub-agent
src/runner.ts               SubagentRunner interface, result shape, the parent's inheritable flags
src/sdk-runner.ts           the in-process runner on pi's SDK (createAgentSession per run)
src/danger.ts               the dangerous-command policy for unattended runs
src/window-guard.ts         the cap on a scheduled turn in an open window: declared tools and the dangerous-command policy
src/subagent-guard.ts       the synthetic extension that applies it inside every sub-session
src/transcript.ts           a sub-agent's session file, folded into readable lines

running with no pi open
src/host.ts                 the always-on pi-loops process: claim, self-check
src/host-entry.mjs          the process pi-loops runs as, loading TypeScript under node_modules
src/host-control.ts         the service record and ensure/spawn/evict decisions
src/host-control-channel.ts the control socket: snapshot, abort, stop, run and upgrade ops
src/page-server.ts          the browser page's server, run by pi-loops on 127.0.0.1:4173: routes under /c/<session>/, the token and Origin checks, pairing, the Background view
src/conversation-rows.ts    the page's conversation list as a file read: pi's session files, leases, requests and the inbox, never a pi
src/session-head.ts         a session file's header, name, first message and message count, without reading it whole
src/page-devices.ts         web-devices.json and the per-address keys: how a browser gets the token back without a cookie carrying it
src/open-file.ts            the 0600 file `pi-loops` opens the browser on, so the one-use open key is in no command line
src/browser-open.ts         which command opens a browser on each platform (WSL included), and whether one did
src/page-children.ts        one `pi --mode rpc` per conversation open in the page: spawn, JSONL, idle stop and cap, orphans stopped
src/held-read.ts            how big a conversation this process parses, and whether a conversation's file is readable here
src/host-runtime.ts         what pi-loops runs (scheduler + triggers + per-request tools), the one list of its runs, and the wiring of the background executor
src/background-executor.ts  what pi-loops in the background does to the queue of a closed conversation: takes its lease, delivers a rule's result, claims a plain job's row, runs its turn and closes it
src/lease.ts                leases/<session>.json: which instance holds a conversation, taken only from a dead pid, or by a terminal from the page's pi (`page`) while no turn runs (`turnSince`)
src/requests.ts             requests/<lane>.jsonl: what is addressed to a lane (a conversation's is its session id), kept until it is in it (the row, claimed or not, append, remove, claim)
src/engine.ts               decideDrain, the pure decision for a lane's rows: classify, take the lane, start; drain, which applies it through an executor; the exits, attempts and dead letters
src/window-executor.ts      the engine's executor in a window: a turn row as a `pi-loops:turn` custom message with its mark and cap, the person's page message as a user message, the list of what it gave pi, and the cap of each turn
src/window-claim.ts         the window's three decisions over that list: whose a message is, what a settle leaves, the editor without our prompts
src/mark.ts                 the mark { lane, id } on the entry pi writes for a row: one writer, one reader; `TURN_TYPE` and the row a turn's message names
src/turn-render.ts          how a terminal draws a `pi-loops:turn` message: as a message the person typed
src/register-pi.mjs         node --import hook resolving pi's packages outside pi (pi-loops, tests)
src/pi-resolver.mjs         where that hook looks for them

storage
src/lane.ts                 a lane's id and its one grammar: a conversation's session id, `@cron-…` for a loop, `@check-…` for a project's checks; the file name it gives
src/store.ts                jobs.json, state/, runs.jsonl, sessions/
src/inbox.ts                inbox.jsonl
src/archive.ts              .pisession export/import
src/lock.ts                 the mkdir lock, atomic writes, is-that-pid-alive
src/convert-v2.ts           what older versions left in the loops directory, removed at every start; the only module that names it
src/paths.ts                realpathish: the deepest existing ancestor's realpath, so a path that is not there yet resolves as its parent does
src/snapshot.ts             the pi_loops_snapshot fingerprint, and when a new entry is worth writing
src/config.ts               config.toml and the environment overrides
src/ui-prefs.ts             ui.json: the preferences that outlive a session, merged one key at a time
src/seen.ts                 seen.json: when each conversation last listed /inbox, and what its loops did since

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

src/web.mjs                 the browser page as strings (`DOOR`, `ICON`, `PAGE`), with src/web/ inlined at import; src/web.d.mts declares them
src/web/page.js             the page's script: plain browser JavaScript, one classic script, no imports
src/web/page.css            the page's stylesheet, with the token block the Background view reads too
skills/pi-loops/            when the agent should reach for cron_create, new_trigger and the inbox
recipes/<name>/             a recipe: recipe.toml, the playbooks its jobs read, an optional setup script; _tracker-setup.md and _tracker/ are the prompt and templates the wizard hands to the session
examples/                   a dependency-free MCP push server, and an mcp.toml to point at it
test/                       node --test; test/fake-runner.ts and test/fake-mcp-server.mjs stand in for the model and an MCP server
test/downstream/            the contract in docs/downstream.md checked from the outside: sh + jq driving `pi-loops`, a loop run in the background against fake-model.mjs, no import of src/
test/journey/               the journeys J1-J12 (`npm run journey -- J1 …`), `boot.mjs` and `terminal.mjs`, a sandboxed page with a stand-in model
test/sim/                   the seeded simulation of the request engine that test/sim.test.ts runs: world.ts (the real engine and stores around a simulated pi, lease, clock and crashes, and what that leaves out), schedule.ts (the steps a seed draws), invariants.ts (what is checked after every step), prng.ts; claims.ts (a lane the background runs: rows a run claims, runs that end in every way, a process that dies at any write), which test/sim-claims.test.ts runs; held.ts (a held turn in a closed conversation: the real closing and settle table around a simulated runner, a window that takes the conversation, a process that dies at any write), which test/sim-held.test.ts runs; clock.ts (interleaved ticker decisions and T2/T3 writes, crashes, row proofs and loop settlement; checks I1: one row per job and slot), which test/sim-clock.test.ts runs
test/tmp.ts                 every test's temporary directory: removed when the test passes, kept and named when it fails (PI_LOOPS_KEEP_TMP=1 keeps all), strays it started ended
scripts/                    typecheck.mjs, lint.mjs, check-docs.mjs — TypeScript comes through npx, nothing is a dependency
```

## Checks before you call something done

```bash
npm run ci           # what .github/workflows/ci.yml runs: typecheck, lint, both checks, tests, the downstream checks
```

or one at a time:

```bash
npm run typecheck     # tsc --strict against the globally installed pi's type definitions
npm run lint          # scripts/lint.mjs — floating promises and silent catches (see below)
npm run check:scripts # node --check on the .mjs entry points: nothing here is type-checked or bundled
npm run check:docs    # scripts/check-docs.mjs — the install commands in every document, read back against package.json
npm test              # the unit/integration suite: no network, no model calls (src/register-pi.mjs resolves pi's SDK from the global install)
npm run check:downstream # test/downstream/run.sh — docs/downstream.md held to its word by sh and jq, with a loopback stand-in for the model
npm run check:contract   # test/contract/run.sh — CONTRACT.md held to its word: five checks, two unrelated implementations per rule (needs python3 3.11+ for tomllib)
npm run journey -- J1 J2 J3 J4 J5 J6 J7 # test/journey/run.mjs — a person's flows in the browser page, against a stand-in model (not in CI; needs agent-browser)
```

CI runs the same seven on Linux and macOS with **every provider credential cleared**. The suite is
offline by construction — sub-agents go through `test/fake-runner.ts` — and clearing the keys is
what keeps that a fact: a test that ever reaches a real provider fails there instead of quietly
spending money.

`npm test` includes the simulation (`test/sim.test.ts`): 2700 seeded schedules of appends, drains,
pi's turns, stops, crashes and restarts against the real request engine, with every invariant of
`test/sim/invariants.ts` checked after every step. One world in four has another extension that
rewrites every message, and in half of all worlds a message takes a millisecond. A failure names its seed, the step, the invariant
and the schedule, with a shorter schedule that fails the same way. To run one schedule again and
print it, give its seed (`SIM_STEPS` too, when the run that failed set it):

```bash
SIM_SEED=<seed> SIM_SCHEDULES=1 PI_LOOPS_HOST=off node --import ./src/register-pi.mjs --test test/sim.test.ts
```

A check named in `KNOWN` (`test/sim/invariants.ts`) is a defect of `src/` the simulation found and
nobody has fixed: it runs under `todo`, visible and not red. Fix the defect, then take the name out.
`KNOWN` is empty: every check holds in every world, the ones with a rewriting extension too.

`test/sim-model.test.ts` holds the simulated pi to what a real pi was measured to do, in scenes
written out step by step: what the page's Stop keeps and when pi writes it, what Esc in a terminal
puts into the editor and what it drops, an abort asked as a follow-up starts, and a turn that a stop named and Esc
dropped. A fact of pi that `test/sim/world.ts` states and no scene holds is checked by nobody: a
change to pi's part of that file needs a measurement first and a scene here.

A second simulation, `test/sim-claims.test.ts`, runs 400 schedules of a lane that pi-loops in the
background runs: rows a run claims (`row.run`), runs that end in every way, and a process that dies
at any write. Its executor is simulated; the engine's rules for a claimed row are the real ones.
It takes the same `SIM_SEED`, `SIM_SCHEDULES` and `SIM_STEPS`.

A third, `test/sim-held.test.ts`, runs 400 schedules of a held turn: a plain job's row in a closed
conversation, claimed through the real `RunList`, its prompt written or not, its run ended in every
way and closed by the real `closeRun` and `settle`, a window that takes the conversation at any
step, and a process that dies at any write. It checks that a run has one record, that no prompt is
answered twice, that no attempt or failure is counted twice, and that no row is stuck.

A fourth simulation, `test/sim-clock.test.ts`, interleaves real clock writes from multiple tickers,
crashes between T2 and T3, then drains rows through real proofs and loop settlement. It checks I1:
one row per job and slot, including cursor commits, fires, collapses and spent runs. It runs 200
schedules by default. An interleaving that random schedules reach only rarely is not left to a larger
count: it is a scene of its own in `test/clock-scenes.test.ts`, which drives the real code step by
step in milliseconds.

`check:docs` is there because nothing else in CI reads a README: 0.17.0 was tagged green with an
install line that answered 404. It holds every install command in every document to what
`package.json` declares — the route (`piLoops.publishedToNpm` is the one place that says whether npm
is a route yet), the pinned tag, the repository and the package name. Only fenced blocks count, so
prose about pi's own layout stays free.

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

The page's script, `src/web/page.js`, is browser JavaScript with no types. `check:scripts` parses
it, and the linter reads it with the DOM's types for two faults only: **undefined-name** (a name
that is never declared) and **silent-catch**. floating-promise does not apply there, because a
rejection in a browser does not stop pi. Nothing checks what the page does, so
`test/web-page.test.ts` runs the script against a DOM stub — an undefined identifier in it once
shipped in four releases and left the front end unable to display anything. Anything you add to the
page needs a line there.

To see a page edit without a restart, start pi-loops with `PI_LOOPS_PAGE_DEV=1` (for example
`PI_LOOPS_PAGE_DEV=1 pi-loops restart`): each page load then reads `src/web/` again.

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

Run pi with the extension in any terminal by hand (`PI_LOOPS_DIR=$(mktemp -d) pi --no-session -e $PWD`), type `/cron add --stateful every 1m List src/*.ts; report each file as a finding`, wait about 90 seconds, then type `/inbox`.

For a script, use `openTerminal` from `test/journey/terminal.mjs`:

```js
import { openTerminal } from "./test/journey/terminal.mjs";
const term = openTerminal({ dir, command: ["pi", "--no-session", "-e", process.cwd()], cwd: process.cwd(), env: process.env });
term.type("/cron add --stateful every 1m List src/*.ts; report each file as a finding");
term.press("Enter");
term.stop();
```

`pi -p` in text mode waits on stdin; redirect `</dev/null` when scripting it.
