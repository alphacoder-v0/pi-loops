# Design

## What pie's pieces map onto

| pie | pi-loops |
|---|---|
| in-process timer in the runtime | `setInterval` started in `session_start`, cleared in `session_shutdown` |
| cron `InjectAndRun` | `pi.sendUserMessage` (followUp when busy), `[Trigger <id>] ` prefix |
| cron `SubAgent` / dynamic-rule sub-agent | an in-process `AgentSession` from pi's SDK (`src/sdk-runner.ts`): fresh context, own transcript, the parent's tools, MCP clients, extensions, model and trust |
| session sidecars (`.cron.toml`, `.triggers.json`, `.loop-*.md`) | `jobs.json`, `triggers.json`, `state/<id>.md` under `~/.pi/agent/loops` |
| `cron_control_plane` / trigger audit as session custom entries | `pi.appendEntry` for cron control ops; `triggers-audit.jsonl` for trigger runs |
| TUI feed lines and right rail | transcript cards via `pi.appendEntry` + entry renderer; widget above the editor; footer badge via `ctx.ui.setStatus` |
| `PermissionClassification::Prompt` on tools | `ctx.ui.confirm` inside the tool |
| MCP client crate | `src/mcp.ts` |
| `hooks.rs` | `src/hooks.ts` |
| `session_archive.rs` | `src/archive.ts` |

## Where pi-loops departs from pie, and what that costs

pie scopes automation to a session. pi-loops keeps jobs and rules on disk for the whole machine,
because "pi was restarted" must be the normal case; sub-agents run in-process exactly as pie's do.
Everything below is what that choice implies and how each scenario pie supports is restored (0.1.3).

1. **Machine-global jobs and rules with a `cwd` and a `host`.** `/cron` and `/triggers rules` show
   the current project by default. A plain (inject) job belongs to the session that created it:
   listed as `[dormant …]` while that session is not open, parked as disabled once the session no
   longer exists (`/cron gc` removes it — pie loses it with the session's sidecars). A loop whose
   `cwd` disappeared is disabled with `[orphan: cwd missing]`. Jobs and rules of another host
   (shared `$HOME`) are ignored on this one; leader election is per host.
2. **Who runs what.** Every process ticks. Loops run in the machine leader (`scheduler.<host>.json`
   heartbeat). A project's dynamic checks and push evaluations run in a pi that is *open in that
   project* — preferring the session that created the rules, lowest pid otherwise (`presence/`) —
   so promotions land in the right chat exactly as in pie; only a project with no pi open is
   covered by the leader, and its results go to the inbox (`redirected`). The poll interval is
   enforced machine-wide (`polls.json`), so a hand-over never double-checks.
3. **Model and thinking level.** Recorded at creation and editable (`/cron set`, `/triggers set`,
   `--model -` to follow the running session); pie always uses the parent's current model.
4. **MCP pushes.** A push that injects into the chat reaches every window that has the server
   (pie: every session). A push evaluated against rules is evaluated once per project, by that
   project's owner. Sub-agents ignore pushes (pie's sub-agents register no notification hooks);
   anything reaching hop ≥ 1 is audited `cycle_suppressed`.
5. **Sub-agents are in-process sessions** (pi's SDK `createAgentSession`, like pie's SubAgent):
   they share the parent's live MCP client instances (a browser tab or database session opened in
   the chat is the one a loop sees), its `-e` extensions, system-prompt and skill flags, its model
   unless the job pins one, the project's trust when the run is in a project this session or an
   earlier `/trust` decision trusted (never by default), and the parent session's id (plain jobs
   they schedule bind to it, like pie's parent cron.toml). The parent's extensions get their
   `session_start` / `session_shutdown` in every sub-session. They get their own transcript file
   and a configurable cap (`[triggers] run_timeout_secs`, per-rule `--timeout`; pie is unbounded).
   Nothing is re-spawned per run.
6. **Catch-up.** A loop tick missed while no pi was running is fired once at startup
   (`[cron] catch_up = false` or `--no-catchup` turns it off); plain jobs do not catch up unless
   `--catchup`. A run that died with its process is retried. `[cron] max_concurrent_runs` (3)
   bounds the burst.
7. **Audit** is a machine-wide JSONL (`triggers-audit.jsonl`, rotated at 2 MB) *and* pie's session
   custom entries (`trigger` / `trigger_result` / `trigger_promotion`), so it resumes and exports
   with the session; `/triggers audit` shows this project's rows (`--all` for every project).
8. **Hooks** are awaited inline like pie's listener (`[hooks] mode = "async"` queues them off the
   turn instead).
9. **Promotion while the agent is busy** goes to pi's follow-up queue and runs a turn after the
   current one, as pie's follow-up does; when idle it is inserted without a model call.
10. **Nobody around.** When the last interactive pi on the machine quits with loops, rules or MCP
    servers configured, it starts a headless host (`src/host.ts`, a plain `node` process using the
    same stores, the same in-process runner and its own MCP clients) that keeps the clock: loops,
    trigger checks for every project, pushes, catch-up. Chat-bound output goes to the inbox. The
    first interactive pi to open takes the clock back (its scheduler preempts a `host` leader) and
    the host exits. `/cron host [start|stop]`, `[host] auto = false` to opt out, `host.log` for its
    output. Nothing restarts it after a reboot until a pi opens. pie stops with its process;
    pi-loops does not.
11. **No expiry**; **8 KB prompts** (pie 4 KB); ids extracted from the full sub-agent reply.
12. **Cycle suppression by hop count, like pie:** sub-agents run at hop 1 and keep the cron/trigger
    tools (`cron_create`, `cron_remove`, listing, disabling); Prompt-class operations are denied
    fail-closed there, as in pie; sub-sessions never run the trigger runtime, so nothing nests.
13. **Stdio MCP servers reconnect** with backoff (20 attempts by default), each distinct error
    reported once; pie marks them disconnected.
14. **A bill, and a cap on it.** pie has `budget_cap_usd` and never exposes it, because its loops
    die with the session. Here a host can run for days, so `[limits] daily_budget_usd` gates every
    dispatch, `/cron cost` adds up the run log, and what log rotation drops is folded into
    `spend.json` first so the cap does not quietly stop capping. Diagnostics go to
    `logs/pi-<pid>.log` rather than only to a chat notification that `/new` erases.

## What it still cannot do

Nothing in pie's automation layer. Plain (inject) jobs stay dormant while no chat is open, as in
pie; the headless host runs everything else.

pie's local web UI has an equivalent, and so does the way you reach it. pie has no `pie web`
subcommand: `--web` is a flag on `pie` itself, and `resolve_ui_mode` opens the browser by default
on a local terminal, falling back to the terminal UI over ssh. The web UI is not an addition there,
it is one of the two front ends you start a session with. `pi-loops` is the same shape — bare, it
starts a session and picks the window the same way — because pi owns the `pi` command and cannot be
asked to. The front end itself is [src/web.mjs](../src/web.mjs), a
browser front end in one dependency-free file. pie's UI replaces pie's own terminal UI; pi keeps
its terminal, so this goes through the door pi already provides — `pi --mode rpc`, pi with no
terminal front end, speaking JSON lines — and passes that protocol through to a page. The session
is a real pi session, and `pi --resume` picks it up afterwards. What only the process knows (which
MCP servers connected, what they exposed, the active tools, who owns the clock) reaches it as the
`pi_loops_snapshot` session entry.

Two things stay in the terminal. `/login` is one: OAuth has no rpc command, so a provider is
logged in once with `pi` and the browser front end started afterwards. pi's other built-in slash
commands are the other: they do not exist in rpc mode, and the front end implements the ones that
matter (cost, find, undo, save, compact, model, thinking) from rpc primitives rather than pretending.

pie's relay (`/web-connect`, a hosted broker for reaching a session from another device) has no
equivalent. Nothing in pi stands in the way — it is a websocket client — but it is not built.
While nobody is at the terminal, the host's control channel is what answers "what is it doing":
`pi-loops host status|abort|stop` ([cli.md](cli.md)).
