# Design

## What each piece is built out of

pi-loops is a plain extension. Everything below is a public pi API doing a job the runtime does not
do for you.

| the job | what does it |
|---|---|
| a clock | `setInterval` started in `session_start`, cleared in `session_shutdown` |
| a scheduled job that lands in your chat | `pi.sendUserMessage` (follow-up queue when busy), `[Trigger <id>] ` prefix |
| a scheduled job that must not touch your chat | an in-process `AgentSession` from pi's SDK (`src/sdk-runner.ts`): fresh context, own transcript, the parent's tools, MCP clients, extensions, model and trust |
| state that outlives a session | `jobs.json`, `triggers.json`, `state/<id>.md` under `~/.pi/agent/loops` |
| a record of who changed what | `pi.appendEntry` for cron control operations; `triggers-audit.jsonl` for trigger runs |
| something to look at | transcript cards via `pi.appendEntry` + an entry renderer; a widget above the editor; a footer badge via `ctx.ui.setStatus` |
| a decision only a person should make | `ctx.ui.confirm` inside the tool |
| notifications from outside | `src/mcp.ts`, a client that consumes them |
| a way to react to the session's own events | `src/hooks.ts` |
| a session you can carry to another machine | `src/archive.ts` |

## The decisions, and what each costs

The premise is that **"pi was restarted" is the normal case**. Automation that dies with the window
it was configured in is automation you cannot rely on, so jobs and rules live on disk for the whole
machine. Everything here follows from that, and each one has a price.

1. **Machine-global jobs and rules, each carrying a `cwd`.** `/cron` and
   `/triggers rules` show the current project by default, and say how many are elsewhere. A plain
   (inject) job belongs to the session that created it — its result is a message in that
   conversation — and everything that lists it agrees with dispatch about that: another session
   shows it as `[session <id> — resume it to run]` with no next run, `cron_list` says the same to
   the model, `/cron run` refuses it. Asleep is not broken. It is parked as disabled only once its
   session's file has been deleted (`/cron gc` removes it). A loop
   whose `cwd` disappeared waits half an hour — a mount can be late at boot — and is disabled after
   that.

   The cost: a list has to be scoped, and a job you cannot see reads as a job that is gone. Hence
   the counts, the markers, and `/cron all`.

2. **Who runs what.** Every process ticks. Loops run in the machine leader
   (`scheduler.json`, a pid and a heartbeat). A project's dynamic checks and push
   evaluations run in a pi that is *open in that project* — preferring the session that created the
   rules, lowest pid otherwise (`presence/`) — so a promotion lands in the conversation it belongs
   to. Only a project with no pi open falls to the leader, and its results go to the inbox
   (`redirected`). The poll interval is enforced machine-wide (`polls.json`), so a hand-over never
   double-checks.

3. **Model and thinking level are recorded when a job is created** and editable afterwards
   (`/cron set`, `/triggers set`; `--model -` follows the running session). A loop that was set up
   against a capable model does not quietly start running on whatever the newest session happens to
   be using.

4. **MCP pushes.** A push that injects into the chat reaches every window that has the server. A
   push evaluated against rules is evaluated once per project, by that project's owner. Sub-agents
   ignore pushes; anything that reaches hop ≥ 1 is audited as `cycle_suppressed`.

5. **Sub-agents are sessions, not processes** (`createAgentSession`). They share the parent's live
   MCP client instances — the browser tab or database session opened in the chat is the one a loop
   sees — its `-e` extensions, system prompt and skill flags, its model unless the job pins one, the
   project's trust when the run is in a project this session or an earlier `/trust` decision
   trusted (never by default), and the parent session's id, so plain jobs they schedule bind to it.
   The parent's extensions get their `session_start` / `session_shutdown` in every sub-session.
   Each run gets its own transcript file and a configurable cap (`[triggers] run_timeout_secs`,
   per-rule `--timeout`). Nothing is re-spawned per run.

   The cost: a sub-agent has no UI, so a tool that would ask for confirmation is denied
   fail-closed there. Nobody can say yes, so the answer has to be no.

6. **Catch-up.** A loop tick missed while no pi was running is fired once at startup, collapsed
   rather than replayed (`[cron] catch_up = false` or `--no-catchup` turns it off). Plain jobs do
   not catch up unless `--catchup`: they land in a conversation, and a conversation that opens to
   four hours of backfill is worse than one that opens to nothing. A run that died with its process
   is retried. `[cron] max_concurrent_runs` (3) bounds the burst.

7. **Audit is both a file and part of the session.** A machine-wide JSONL
   (`triggers-audit.jsonl`, rotated at 2 MB) *and* session custom entries (`trigger`,
   `trigger_result`, `trigger_promotion`), so it resumes and exports with the session it belongs
   to. `/triggers audit` shows this project's rows (`--all` for every project).

8. **Hooks are awaited inline**, so a hook that is slow is visibly slow rather than silently
   racing the turn that triggered it. `[hooks] mode = "async"` queues them off the turn instead.

9. **A promotion that arrives while the agent is busy** goes to pi's follow-up queue and runs a
   turn after the current one; when the agent is idle it is inserted without a model call.

10. **Nobody around.** When the last interactive pi on the machine quits with loops, rules or MCP
    servers configured, it starts a headless host (`src/host.ts`, a plain `node` process using the
    same stores, the same in-process runner and its own MCP clients) that keeps the clock: loops,
    trigger checks for every project, pushes, catch-up. Chat-bound output goes to the inbox. The
    first interactive pi to open takes the clock back — its scheduler preempts a `host` leader —
    and the host exits. `/cron host [start|stop]`, `[host] auto = false` to opt out, `host.log` for
    its output.

    What triggers it is pi shutting a session down cleanly with reason `quit`: `/quit` in a terminal,
    or SIGTERM/SIGHUP, which are the signals pi handles. Nothing else does — so the browser front end
    starts its pi in a process group of its own and turns a Ctrl-C into that SIGTERM itself
    (`src/web.mjs`). A pi that shares the terminal's group is killed by the group's SIGINT, which pi
    has no handler for, and the hand-off never happens.

    The cost: nothing restarts it after a machine reboot until a pi opens. It is a hand-off between
    processes, not a system service, and installing one would mean asking for privileges this does
    not otherwise need.

11. **Bounded everywhere, and no expiry.** Loop state ≤ 2000 characters, a finding ≤ 500, at most
    16 per run, prompts ≤ 8 KB. A job disappears when you remove it, when a one-shot has fired, or
    when `/cron gc` collects one whose session is gone — never because time passed. Each of the
    three is recorded in the control-plane audit, the self-removals included.

12. **Cycle suppression by hop count.** Sub-agents run at hop 1 and keep the cron and trigger tools
    (`cron_create`, `cron_remove`, listing, disabling), so a loop can manage automation; the
    operations that would need a human's yes are denied there, and sub-sessions never run the
    trigger runtime, so nothing nests.

13. **Stdio MCP servers reconnect** with backoff (20 attempts by default), each distinct error
    reported once rather than on every retry.

14. **A bill, and a cap on it.** A headless host can run for days, so cost cannot be something you
    discover at the end of the month: `[limits] daily_budget_usd` gates every dispatch, `/cron cost`
    adds up the run log, and what log rotation drops is folded into `spend.json` first so the cap
    does not quietly stop capping. A run stopped by the budget is recorded as aborted rather than
    failed — the slot is still owed and the failure streak does not advance. Diagnostics go to
    `logs/pi-<pid>.log` rather than only to a chat notification that a new session erases.

15. **Recipes are files, not code.** A recipe (`CONTEXT.md` has the vocabulary) is a directory:
    a `recipe.toml` manifest whose `[[job]]` fields are the arguments of `/cron add` and nothing
    else, one playbook per job, an optional setup script. Anything the wizard does with one is
    something a person could have done by hand with `/cron add` and `cp`. The first catalogue is
    seven: issue-loop, daily-digest, changelog-draft, pr-watch, ci-sweeper, autoresearch, and
    ecosystem — the last capped at `propose`, because every outward word it drafts is a finding a
    person claims before it is said.

    The cost: a project cannot add a recipe by writing TypeScript, only by writing a directory,
    and the wizard can only ask what a manifest can declare.

16. **Playbooks are copied into the project and kept out of its history.** `/recipe add` copies
    them to `<project>/.agents/skills/<recipe>/` — where pi also discovers them as `/skill:`
    commands, so a person can run one step by hand — and lists the directory in
    `.git/info/exclude`, so the repository is not touched. A loop's prompt is a pointer to that
    file; the procedure is read fresh on every run. The tracker description the playbooks read
    (`docs/agents/issue-tracker.md`, in the layout Matt Pocock's engineering skills use, so a
    repository that has those reads the same file) is excluded the same way: it names an account
    and a workflow, which are the project's to keep and not the repository's to publish.

    The cost: two clones of one project each install the recipe, and a playbook edited on one
    machine is not on the other. Upgrading pi-loops upgrades the packaged recipes, not the copies:
    `/recipe update` is a three-way merge against the untouched copy kept at install (under
    `.orig/` beside the playbooks), silent when the person changed nothing, and conflicts are handed to the
    session as a prompt to resolve with the person rather than left as markers in a file the next
    run will read.

17. **The wizard is deterministic; one step is not.** Choosing a recipe, its autonomy level, the
    copy and the `/cron add` lines run with no model and end in a confirmation that shows exactly
    what will be created. The one thing a template cannot do — describe *this* project's tracker —
    is handed to the running session with `sendUserMessage`, the way `/inbox claim` hands over a
    finding: explore the remote, propose, confirm, write the file — and when that turn settles with
    the file there, the wizard resumes by itself, so the command is typed once. `pi-loops recipe`
    in the terminal does the deterministic part only.

18. **One autonomy dial, three positions, in prose.** `report` reads and files findings; `propose`
    may also write to the tracker and open draft pull requests but never reach a terminal state;
    `act` may. A manifest declares which positions a recipe supports, the wizard defaults to the
    lowest, and the chosen one is a line at the top of each playbook — text the model reads and a
    person edits, enforced by nothing in code. The cost is exactly that: the level is an instruction,
    not a permission, and the permissions that exist (the danger policy, the daily budget, branch
    protection on the remote) are the ones that hold.

19. **One machine.** Until 0.19.0 every job and rule carried the hostname that created it, another
    machine sharing the `$HOME` ignored it and listed it as `[other host]`, `/cron set --host`
    re-homed it, and the leader file was named per host. None of it matched the way pi-loops is
    used: pi runs on one machine, the loops run there, and a phone or a
    laptop reaches the browser front end over a tailnet (`tailscale serve`) without moving the
    execution anywhere. So the concept is gone: no `host` on a job or a rule (a stamp an older
    build left is dropped when the file is read), no `--host`, no marker, `scheduler.json` and
    `next-runs.json` plain. "Host" now means one thing here, the headless process.

    The cost: two machines syncing one `$HOME` both run every job. That is not supported, and it
    is said rather than half-handled.

20. **The extension keeps the launcher.** `pi install` puts this package under pi's directory and
    nothing on your PATH, so `pi-loops` existed only after someone ran `install-launcher` once — and
    the first time there was no `pi-loops` to run it with, which is why the README handed people a
    bare `node ~/.pi/agent/npm/node_modules/@alphacoder-v0/pi-loops/src/cli-entry.mjs
    install-launcher`. The launcher then went stale by itself: a package reinstalled by the other
    route moved, and every `pi-loops` after that ended in Node's `Cannot find module` (0.22.1). Both
    endings were a path a person had to type out. pi loads this extension at every session start,
    and at that moment it knows where it runs and where a launcher would go — so `session_start`
    does it. A launcher of ours is rewritten in two cases and only two: the copy it names is not on
    disk any more (the package moved, which is the reading that ends in `Cannot find module`), or
    the copy it names is this one and the node or the shape of the script has changed. Either way
    one line says that it was rewritten and why. One naming another copy that is still there is that
    copy's to keep current, so an install and a checkout both being opened never trade the file back
    and forth. With no launcher anywhere, the question `install-launcher` already asks is asked once,
    and a no is remembered in `ui.json` and never asked again; `/pi-loops install-launcher` still
    writes one whenever you want it, and clears that mark. A `pi-loops` carrying no marker of ours
    is somebody's own wrapper and is left alone, and a checkout is never asked for one that is not
    there — nobody ran `pi install`. The decision is `launcherState` / `refreshLauncher` in
    [../src/cli.ts](../src/cli.ts), beside the one function that renders the script, so it is
    testable without pi; the extension is the caller.

    The cost: a write outside the loops directory, which the Non-invasive invariant now names as its
    one exception, and a question on somebody's first start — an interruption this project otherwise
    does not make.

## Where the browser front end came from

pi owns the `pi` command and its terminal, so a second front end cannot replace the first one. It
goes through the door pi already provides: `pi --mode rpc` — pi with no terminal UI, commands in
and events out as JSON lines — with [src/web.mjs](../src/web.mjs), a browser front end in one
dependency-free file, passing that protocol through to a page. The session is a real pi session,
and `pi --resume` picks it up afterwards. What only the process knows — which MCP servers connected,
what they exposed, the active tools, who owns the clock — reaches the page as the
`pi_loops_snapshot` session entry.

`pi-loops` with no arguments starts a session and picks the window: the browser at a local
terminal, pi itself over ssh or with no terminal at all, because a browser on the far machine helps
nobody. `--web` and `--tui` say which when the guess is wrong.

Two things stay in the terminal. `/login` is one: OAuth has no rpc command, so a provider is logged
in once with `pi` and the browser front end started afterwards. pi's built-in slash commands are
the other — they do not exist in rpc mode, and the front end implements the ones that matter (cost,
find, undo, save, compact, model, thinking, clear, resume) from rpc primitives rather than
pretending. What the page owes you is kept as a gate rather than a wish list in
[web-ui-parity.md](web-ui-parity.md).

Reaching that page from a phone is solved without putting a broker in the middle: `tailscale serve`
terminates TLS on your tailnet and proxies to this server on loopback, so the page is on your phone
without anything of yours passing through a third party, and `--host` does the same over a local
network for people who would rather not run a tailnet. What both need is a way in that a phone can
manage — the pairing code and the QR ([cli.md](cli.md)). A phone on neither network is the case
this does not cover; that one would need a relay.

While nobody is at the terminal, the host's control channel is what answers "what is it doing":
`pi-loops host status|abort|stop` ([cli.md](cli.md)).

## What this is not

An agent. Writing code, reading the web, managing skills — those are pi's, and this does not
duplicate them. What it decides is *when* work happens, *where* it runs, and *what context it
carries*; the work itself is done by the agent you already have.
