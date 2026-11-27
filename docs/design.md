# Design

## What each piece is built out of

pi-loops is a plain extension. Everything below is a public pi API doing a job the runtime does not
do for you.

| the job | what does it |
|---|---|
| a clock | `setInterval` started in `session_start`, cleared in `session_shutdown` |
| a scheduled job that lands in your chat | a row in `requests/<session>.jsonl`, handed to pi as a `pi-loops:turn` custom message by the window holding the session once the agent is idle, `[Trigger <id>] ` prefix |
| a scheduled job that must not touch your chat | an in-process `AgentSession` from pi's SDK (`src/sdk-runner.ts`): fresh context, own transcript, and the tools, MCP clients, extensions and model of the process that runs it (pi-loops, for loops and checks) |
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
   conversation — and everything that lists it agrees with dispatch about that. While no window
   holds the conversation pi-loops fires it there, holding the conversation for that one turn
   (`[session <id> — in the background]`); when pi-loops is not running it is paused (`paused: <why>`), and for a
   conversation whose file pi-loops never saw it is asleep (`[session <id> — resume it to run]`, no
   next run, `/cron run` refuses).
   Asleep is not broken. It is parked as disabled only once its session's file has been deleted
   (`/cron gc` removes it). A conversation open in two windows is
   held by one of them: a lease in `leases/<session>.json` names the holding instance, and it changes
   hands when its holder releases it or that process is gone (its pid, or a recycled pid's start
   time), and a window takes it from pi-loops at once; never on a timer.
   The other window is a viewer and fires none of the conversation's plain jobs. A loop
   whose `cwd` disappeared waits half an hour — a mount can be late at boot — and is disabled after
   that.

   The cost: a list has to be scoped, and a job you cannot see reads as a job that is gone. Hence
   the counts, the markers, and `/cron all`. And a holder that is alive but frozen (stopped in a
   debugger, a wedged process) keeps its conversation's plain jobs waiting until it exits. The lease
   does not expire on a timer on purpose: a timer cannot tell a frozen window from a suspended
   laptop, and one is what used to move the clock away from a laptop that had only been asleep.
   pi-loops writing into a closed conversation costs one race, stated: a person who opens the
   conversation during the seconds pi-loops spends on a turn there takes it back at once and the
   turn stops, but what pi-loops wrote meanwhile is on disk and not on that screen. Their next
   entry is a sibling branch (a pi session is a tree, so nothing is lost), and the window says so;
   the prompt is owed, so that window then runs the job once more, and the conversation shows the
   stopped attempt before the answer. What is owed is a row: the turn's own row when its prompt
   was not written yet, and one successor row, under an id derived from it, when it was. A pi with the conversation open but without pi-loops in it is
   guarded against only by pi-loops leaving a file someone else wrote in the last two minutes alone.
   A held turn is a run like a loop's (a record, its own cost, a failure streak), and its extensions
   stay loaded for that conversation's later turns: up to eight conversations, released after an
   hour idle. It is a row with a claim. pi-loops in the background takes the conversation's lease,
   its clock writes the slot's row under an id derived from the slot and counts the slot, as a
   window's clock does, and one drain claims the row (`row.run`) before the prompt is written
   (`src/background-executor.ts`). The turn keeps that lease until its end. Its end is one closing
   (`closeRun`), which needs no lease and is decided by one table (`src/settle.ts`): the record,
   the job's patch, a successor row when one is due, and the row last. A later drain, in the
   background or in a window, makes the same closing for a claim whose process is gone. A turn
   that ended, well or with a failure, spends its slot: its record is in the run log, and the
   failure is the job's. A turn that did not end is delivered only by its prompt in the
   conversation: one whose process stopped before the prompt was written is tried again and
   reported after the third time, and a job whose turns are interrupted three times in a row is
   turned off. The cost: the slot is counted when its row is written, so `runs N` counts a turn
   that a person stopped; a process that dies in a turn leaves a record that says so, written by
   the closing; a stop that arrives after the lease is taken and before the claim is written is
   answered as a stop of nothing; and the job's patch is applied only for a record newer than the
   job's last stamp, which is the slot's until a record is applied. So when a process stops in
   the middle of two closings of one job, the older record's failure or interruption can go
   uncounted, and so can a turn that ends before its slot's stamp because the system clock was
   set back during it (never counted twice). One more cost: a turn is closed by itself, and
   nothing records what else its process had going when it stopped. So a turn is counted as
   interrupted also when other runs stopped with it, where a loop's run is counted only when no
   other loop's run did, and a loop beside a turn is counted as the one run. A job that only ran
   beside the run that stops the process can so be turned off with it. The count needs a record
   of the process's stop that every run of that process reads, and one name for a process in a
   lease, a claim and a marker (today: pid and instance, pid and start time, pid). Neither is
   there yet.

2. **Who runs what.** One always-on process runs stateful loops, dynamic-rule checks and MCP push
   evaluation for a loops directory. A window starts it when there is work to run, including the plain jobs and queued rule results of
   closed conversations. Windows run only
   the plain jobs for conversations whose leases they hold. Rule results go to the conversation
   that created the rule, queued for its holder when needed; when no window holds it, pi-loops
   appends the result to the conversation. A queued row pi-loops cannot run (an attended one, which
   waits for a window) costs it no read of the conversation on a tick where the conversation,
   `jobs.json` and the queue are as they were and no backoff has ended; it remembers the three at
   the last "nothing to do" and reads again when one moves. The inbox gets a result only when the conversation cannot
   be written; shell-created rules go to the inbox. An older pi-loops gets no special treatment while it
   runs: nothing writes `presence/` or `scheduler.json` for it. Instead the conversion of a
   directory an older version worked in pauses pi-loops (`upgrade-hold.json`, written before the
   version 3 `jobs.json`, the conversion's one commit point; src/upgrade-hold.ts), owner decision of
   2026-11-26. While it holds, nothing automated starts in a window or in the background, whoever
   drains: the engine holds every row that no person is there for (`decideDrain`: a person's message,
   a command typed in a window and a goal's continuation go; `/cron run` waits), the run list refuses every
   claim (`RunList`), and the clock and the rule checks do not pass, so no slot is decided and no
   gate's command runs. Two places, not one per caller: two rounds of review found a caller that the
   per-rider gates missed (the requests watcher, the doorbell). Each job and rule keeps the on or off it had, so an archive, a downgrade and the lists see them
   as they were. `pi-loops resume` (or `/pi-loops resume`, or the page's Resume pi-loops) ends it, and refuses
   while a fresh `presence/` entry of a live pid says pi-loops 0.22 still runs here, or
   `host-service.json` names a live older pi-loops in the background; while the pause holds, a start
   keeps `presence/`, which it otherwise removes. Two designs that
   detected an older pi-loops and waited for it, and one that turned every job and rule off and marked
   each, were withdrawn: reviews found one more path around the first two each round, and the third
   carried its marks into archives, downgrades and answers. The cost: every person who upgrades runs
   one command, and a 0.24.2 terminal that was not restarted is not seen by `resume`.

   The cost: loops pause while pi-loops cannot start, whereas they previously ran in an interactive pi.
   A loop no longer shares a window's live MCP connections; it connects its own from `mcp.toml`
   and the project. A pi-loops process that is alive but frozen blocks nothing: a window replaces it after three
   failed probes and a heartbeat it stopped writing. After a reboot, nothing runs until a pi window opens, unless the person installed
   a user-managed service (decision 21).

3. **Model and thinking level are recorded when a job is created** and editable afterwards
   (`/cron set`, `/triggers set`; `--model -` clears the pin: a loop then uses pi's default model, a
   plain job its conversation's). A loop that was set up
   against a capable model does not quietly start running on whatever the newest session happens to
   be using.

4. **MCP pushes.** A push that injects into the chat reaches every window that has the server. A
   push evaluated against rules is evaluated once per project, by pi-loops. Sub-agents
   ignore pushes; anything that reaches hop ≥ 1 is audited as `cycle_suppressed`.

5. **Sub-agents are sessions, not processes** (`createAgentSession`). They share the live MCP
   clients, extensions and model of the process that runs them. For loops and checks that process
   is pi-loops: a loop sees pi-loops' own MCP connections and pi's default model unless the job
   pins one, not a window's browser tab, `-e` extensions or flags. A run reads a project's own
   resources only when pi has saved a trust decision for that exact directory (never by default).
   That process's extensions get their `session_start` / `session_shutdown` in every sub-session.
   Each run gets its own transcript file and a configurable cap (`[triggers] run_timeout_secs`,
   per-rule `--timeout`). Nothing is re-spawned per run.

   The cost: a sub-agent has no UI, so a tool that would ask for confirmation is denied
   fail-closed there. Nobody can say yes, so the answer has to be no.

6. **Catch-up.** A loop tick missed while pi-loops was not running is fired once when pi-loops starts, collapsed
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

10. **One always-on process per loops directory.** It is a `node` process recorded in
    `host-service.json`, with output in `host.log`. A window starts it on session start, every
    30-second tick, and immediately after a loop, rule or relevant MCP server is added, when there is
    enabled work. It runs stateful loops, dynamic-rule checks and MCP pushes, and the plain jobs of
    conversations no window holds (decision 1).
    It does not exit when windows open or close. `/pi-loops status` shows its pid, version, start time,
    work, held conversations and log. `/pi-loops stop` records a manual stop until `/pi-loops start`, or until `pi-loops` opens the
    page and says that loops and rules resume;
    `[host] auto = false` and `PI_LOOPS_HOST=off` prevent automatic starts. When pi-loops cannot start, it is retried after 1, 5 and 30 minutes. pi-loops does not catch an error and carry on from inside the
    process, because its state after an uncaught error cannot be trusted. An uncaught exception is logged first, with the runs in
    flight, then counted and the process exits; a record left naming a dead process (SIGKILL, OOM)
    counts the same, and so does an eviction. Three of those within five minutes pause pi-loops
    for half an hour, twice as long for each pause in a row and a day at most, and `/pi-loops
    start` ends the pause at once; a job whose runs die with their process three
    times in a row is parked with the reason. When pi-loops cannot run here at all, it exits with code 78, which a systemd unit configured as in [cli.md](cli.md#running-pi-loops-under-your-own-service-manager) does not restart. A
    window replaces pi-loops (SIGTERM, then SIGKILL after 10 seconds) only after three unanswered
    control-socket probes and a heartbeat pi-loops stopped writing; pi-loops still ticking
    with a broken socket is reported, not killed, and a starting pi-loops process is never killed. A newer
    window replaces an older pi-loops process and starts its own at once; an older window never replaces a newer
    pi-loops process, nor starts an old one while the newer window that asked for the upgrade is open. Under bun
    pi-loops runs on the `node` found on PATH; with none, loops pause and say why. A pi-loops
    0.22 window that is still open is not held back (decision 2): close it before an upgrade. After a reboot nothing runs until a pi opens, or under a service manager configured by the user. The costs are decision 2's, and one more:
    when pi-loops is updated while only a browser page is open, the page's pi loads the new
    version and asks the older pi-loops in the background to leave, which stops the page's pi too.
    Nothing starts pi-loops again until a pi or `pi-loops` runs, as in 0.24.2; the upgrade notes
    say to start one pi.

    The claim on a job is a read-modify-write of `jobs.json` under `jobs.lock`, a directory lock
    that is broken as stale after 10 seconds (`src/lock.ts`). It has no fencing token. A process
    stopped (SIGSTOP, a debugger) for more than 10 seconds between reading a job as idle and
    writing its claim, and long enough for another process to take the clock and claim the same
    job, writes its claim over that one when it resumes, and the job runs twice. That is outside
    the guarantee: it needs a stop inside a synchronous section that takes microseconds, and a
    laptop that sleeps stops every process at once, so the resumed holder finishes its write before
    any other process's timer fires.

11. **Bounded everywhere, and no expiry.** Loop state ≤ 2000 characters, a finding ≤ 500, at most
    16 per run, prompts ≤ 8 KB. A job disappears when you remove it, when a one-shot has fired, or
    when `/cron gc` collects one whose session is gone — never because time passed. Each of the
    three is recorded in the control-plane audit, the self-removals included.

    The cost: a loop sees what it reported only through `[reported]` in its prompt, which lists its
    newest 12 new findings and its newest 12 claimed or dismissed in the last 14 days; the prompt
    tells it not to keep ids in its notes. A finding outside that window, or a dismiss reason older
    than 14 days, can be reported again in other words. pr-watch counts a pull request's stall days
    from its line in `[reported]`, so with more than 12 open findings an older pull request
    can be reported again as if new. The bound keeps the prompt small.

12. **Cycle suppression by hop count.** Sub-agents run at hop 1 and keep the cron and trigger tools
    (`cron_create`, listing, disabling), so a loop can manage automation; the tools whose every
    call needs a human's yes are not offered there, the other operations that need one are
    denied, and sub-sessions never run the
    trigger runtime, so nothing nests.

13. **Stdio MCP servers reconnect** with backoff (20 attempts by default), each distinct error
    reported once rather than on every retry.

14. **A bill, and a cap on it.** pi-loops can run for days, so cost cannot be something you
    discover at the end of the month: `[limits] daily_budget_usd` gates every dispatch, `/cron cost`
    adds up the run log, and what log rotation drops is folded into `spend.json` first so the cap
    does not quietly stop capping. A run stopped by the budget is recorded as aborted rather than
    failed — the slot is still owed and the failure streak does not advance. Diagnostics go to
    `logs/pi-<pid>.log` rather than only to a chat notification that a new session erases.

15. **Recipes are files, not code.** A recipe (`CONTEXT.md` has the vocabulary) is a directory:
    a `recipe.toml` manifest whose `[[job]]` fields are the arguments of `/cron add` and nothing
    else, one playbook per job, an optional setup script. Anything the wizard does with one is
    something a person could have done by hand with `/cron add` and `cp`. The catalogue is eight:
    issue-loop, daily-digest, changelog-draft, pr-watch, ci-sweeper, autoresearch, deps-sweeper,
    and ecosystem — `ecosystem` capped at `propose`, because every outward word it drafts is a
    finding a person claims before it is said.

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
    is a request addressed to the running session (`requests/<session>.jsonl`), handed to the agent
    once it is idle: explore the remote, propose, confirm, write the file — and when that turn settles with
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
    machine sharing the `$HOME` ignored it and listed it as belonging to another machine, `/cron set --host`
    re-homed it, and the leader file was named per machine. None of it matched the way pi-loops is
    used: pi runs on one machine, the loops run there, and a phone or a
    laptop reaches the browser front end over a tailnet (`tailscale serve`) without moving the
    execution anywhere. So machine ownership fields are gone from jobs and rules (an old field is
    dropped when the file is read). `--host`, the marker, `scheduler.json` and `next-runs.json` are
    gone too. Host is the code’s name for the background process; user-facing text says
    pi-loops or in the background.

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
    and forth. With no launcher anywhere, the first interactive session writes one into a directory
    already on the PATH without asking, and says so in one line with the command that removes it,
    because a confirm dialog and a second start cost more than the file does (0.24.1, #180).
    `uninstall-launcher` removes only a launcher of ours and records `declined` in `ui.json`, so it
    is not written again; `/pi-loops install-launcher` still writes one whenever you want it, and
    clears that mark. A write that failed is recorded with its directory and not retried until the
    target changes. A `pi-loops` carrying no marker of ours is somebody's own wrapper and is left
    alone, and a checkout is never given one that is not there — nobody ran `pi install`. The
    decision is `launcherAction`, `launcherState` and `refreshLauncher` in
    [../src/cli.ts](../src/cli.ts), beside the one function that renders the script, so it is
    testable without pi; the extension is the caller.

    The cost: a write outside the loops directory, which the Non-invasive invariant names as one of
    its two exceptions, and a file written on somebody's first start without asking, announced in
    one line.

21. **The background process serves the one page.** pi-loops in the background owns the browser
    page: `127.0.0.1:4173` for the default loops directory (`[page] port`), a free port for a moved
    one, recorded in `host-service.json`. `pi-loops` with no arguments asks it over the control
    socket (`page-open`) to open a conversation and answers the address and a one-shot open key,
    then opens the browser and exits. Neither the token nor the key enters argv, which any account
    on the machine can read in `/proc/<pid>/cmdline`: the background process writes the keyed
    address into `pages/open/<random>.html` (0600, in a 0700 directory) and answers its path, the
    browser is opened on that `file:` address, and the file sends it on. The file is removed when
    the key is spent or after 60 seconds, whichever comes first, and every one left is removed
    when the page starts. The cost: a process that runs as you can read the file in those 60
    seconds, as it could read `web-token` itself. A browser confined by snap or flatpak cannot read
    a file under a hidden directory, so for it the hand-off fails; the launcher also prints the
    conversation's address with a second one-use key (10 minutes), and never the token, because a
    terminal's scrollback, recordings and shared screens keep what it prints. It asks as soon as
    the control socket is open: the conversation's pi starts while the page is still binding, and only
    the answer, which carries the address, waits for the bind. A pairing code is
    made only when asked for, by `pi-loops pair` or the page's add device button. Each
    open conversation is one `pi --mode rpc` child of the background process under `/c/<session>/`
    (`src/page-children.ts`), stopped after 15 idle minutes, six at most. What 4174 used to show is
    the Background view of the same page, at `/background`.

    The page keeps `web-token` and checks the Host header against DNS rebinding. The token never
    travels in a cookie, because a cookie ignores ports: the browser sends it to every server on
    127.0.0.1, so any local process that binds a port and gets one request from the browser would
    hold the token. Every route that needs the token takes it from the `x-pi-web-token` header (or,
    on a GET, `?token=`); a POST that carries it anywhere else is refused with 403 before its body is
    read and before anything is written to `requests/`. The page keeps the token in memory. Three
    addresses a browser fetches without that header — the event stream, a file, a preview — take a
    key minted for that address at `POST /c/<session>/key`: 16 random bytes, bound to the
    conversation and the kind, a file's key to its exact path and a preview's to its id, held in
    memory (256 at most). A file or preview key opens one load within 60 seconds; an event-stream
    key lasts 10 minutes, because an EventSource reconnects with the address it was given.

    A reload does not need the open key or the pairing code again. The first visit (the open key,
    the six digits, or the token itself) sets `pi_web_device`, a device id (`HttpOnly`,
    `SameSite=Strict`, one year), records it in `web-devices.json` (0600, keyed by a hash of the
    token, so a new token starts with no devices), and hands the page a device secret once, which
    the page keeps in `localStorage`. A later load with a known device cookie gets the page without
    the token or the secret in it, and the page trades the cookie and the secret, in the
    `x-pi-web-device-secret` header, for the token at `POST /c/<session>/token`. A wrong secret is
    403, and twenty of them forget the device. `localStorage` belongs to this origin, port included,
    so a server on another port that receives the cookie fetches what has no token in it (the page and the
    Background view) and nothing else. A browser paired before 0.24.0 pairs once more. 0.24.0 keeps
    0.22.8's `web-token`, and 0.22.8 kept it in a `pi_web_token` cookie; any answer to a request that
    still carries that cookie clears it (`Max-Age=0`), so the live token stops travelling to every
    port. Abort, run, stop,
    upgrade and ring (the doorbell: `request:<session>` or `lease:<session>`, answered before the
    delivery runs) stay on the control socket.

    A page child is a window: it holds its conversation's lease as a terminal in `rpc` mode, and
    marks the lease `page: true`, with `turnSince` from `agent_start` until `agent_settled` (pi
    retries, compacts and continues after `agent_end`) and while a compaction runs. A `tui` window takes a
    conversation from an idle page child at once; while the child's turn runs, the terminal is a
    viewer and takes it at its next refresh after the turn, and the page then shows that the
    conversation is answered in the terminal. An `rpc`, `print` or `json` window does not take it.

    The cost: a stolen token reaches every existing conversation for as long as pi-loops runs, not
    one session for as long as one terminal stays open, and there is no unauthenticated page any
    more (`--no-auth` is gone). Rotate it by deleting `web-token` and running `pi-loops restart`;
    every browser then signs in again. A device that pairs is trusted until the token is rotated.
    The token is a shell. `/rpc` passes pi's `bash` command, and a prompt reaches pi's `bash` tool,
    so whoever holds the token runs commands as you, in the project of every conversation.
    `pi-loops status --url` prints the address with the token in it, so that output is a
    credential: keep it out of issues, chats and shared terminal logs.
    A script that runs on this origin (an XSS in the page) still reads the token from memory and the
    device secret from `localStorage`. A process that holds a sniffed device cookie can load a
    conversation's page, which starts that conversation's pi as a person's visit does, read the
    masked stderr tail a crash-looping conversation's page shows and start it again, and spend the
    twenty tries, which signs that browser out. After `[page] port` changes, a browser pairs
    again: its secret stays with the old origin. A conversation no lease names opens from one of
    pi's own session files under its sessions root whose header id is the one in the address
    (`ConversationIndex.byId`, `src/conversation-rows.ts`), which is what `pi --session <id>`
    accepts, and which widens what `/c/<id>/` opens from the conversations pi-loops has seen to
    every one pi has written. `+ New` in a project other than the open conversation's posts
    `/conversations/new`, which starts a pi in that project with that project's arguments, never
    the request's; the cost is that a page request can start a pi in any project the page already
    lists. A project with no arguments of its own gets only `-e <this package>`, and only when a
    page pi or this process was started with it, so a launch that loads pi-loops with `-e` has
    pi-loops in every project's conversations without carrying a model or another extension
    across projects.

22. **A scheduled prompt runs under its own cap, whichever process runs it.** Every request row
    carries the `mode` its source gets: `attended` for what you typed, a `/goal` continuation, a
    recipe hand-off and `/new-trigger`; `unattended` for the clock, an `inject_and_run` push and a
    yes to a finding (an answer row, src/ask.ts); `none` for a result. The process that runs a row recomputes it and refuses, audited, one
    that says otherwise, and a window believes an attended source only on a row it wrote itself,
    so a line in the file cannot widen a turn. An unattended turn runs under
    the job's declared tools and the dangerous-command policy in a window exactly as in the
    background, and neither runs a call the policy names: pi-loops asks you, in the conversation
    and in the inbox, and the turn goes on without it. A yes runs that call once, after the turn.
    pi-loops' read-only tools and its two create tools get no question from the guard, since a
    create tool carries its own rule: `cron_create` makes a job capped to the turn's tools (the
    window's `toolHost` reads the current turn, as the background scopes a run's), and
    `new_trigger` writes a proposal (decision 24). The control-plane tools (`cron_remove`,
    `set_cron_job_state`, `remove_trigger`, `set_trigger_state`) are asked about at every call in a
    conversation's unattended turn at hop 0 (a window's scheduled turn, or a turn pi-loops runs in a
    closed conversation), with the tool's name and its input on the card, and `confirmTool` asks
    nothing more there. In the person's own turn `confirmTool` asks with pi's confirm, and at hop 1 (a
    loop's or a check's run) its preflight refuses. The cost is a question about a turn you did not start,
    answered after it. Nothing turns the cap off in a window: `[engine] window_guard` is retired in
    0.24.3, and a `config.toml` that still sets it gets one line at startup. The
    background process runs no attended row at all; one waits for a window, and a `/cron run` row
    left in a closed conversation does not hold the clock's slots, which run as if it were not there.
    `/cron run` is typed: its row goes before the clock's rows.

23. **A chat message from the browser is a request too.** The page posts `/prompt` as before; for
    chat text `src/web.mjs` appends a `person` row (`kind: input`, `wake: turn`, `mode: attended`,
    the text and images as the payload, the page's UUID as the id, `created_by` the web.mjs that
    wrote it) to `requests/<session>.jsonl` and answers `{queued: <id>}` at once. Text that starts
    with `/`, a steer and Stop stay rpc: they act on the process or on the running turn, not on the
    queue. The pi holding the session drains the row when it is idle, so a chat message runs in one
    order with what pi-loops addressed to the conversation, survives Esc and pi exiting, and the
    page lists the whole queue, each row with its source and a cancel (a `cancel` row), with what pi
    itself still holds (a command typed while busy) after them, labelled "pi". Every row has one
    proof of delivery, whatever its source: the mark `{ lane, id }` in the entry pi persists for it
    (`src/mark.ts`). A turn row that pi-loops writes (a plain job's, a rule's or a push's turn, a
    yes to a question of the conversation, a recipe hand-off, `/new-trigger`, a goal's continuation) goes to pi as a custom message
    of type `pi-loops:turn` (`pi.sendMessage` with `triggerTurn`), its mark and its cap in the
    message's `details`. The owner chose this on 2026-11-16, after a review of eight rounds of fixes
    found the window inferring our messages from their words over a channel that carries no
    identity. pi gives the details back unchanged at `message_start` and `message_end`, writes them
    into the entry and never sends them to the model, which reads the content as user text; no
    `input` handler sees the message, so no other extension rewrites it (probes P8, P10 to P17). The
    window knows the message by the row it names and reads no words for it. A mark names its row's
    lane, its id and when the row was queued (`at`). A message the window aborts as it starts (a
    stop or a cancel named its row) gets `aborted` in its mark at `message_end` (probe P18): it
    proves only the row queued at its `at`, never a row of the same id queued later, which runs
    (#262). An answered message proves its id, so a slot the clock queues again is not
    written twice. The person's own page message (a person row the page's pi was rung for) is the
    one row that goes as a user message, in their words alone. The cost: a page message that a
    terminal holding the conversation delivers goes as a `pi-loops:turn` message, so the page labels
    it "pi-loops", not as the person's, and the page's undo goes back past it to the last user
    message; 0.24.2 sent it as a user message. For it the window keeps one list of what it gave pi and of the inputs of others,
    and decides as each user message starts whose it is (`claimOf`, `src/window-claim.ts`): an input
    of someone else with the very same words is theirs; a person row with them is that row's;
    otherwise the input or row whose words start the message, the longest, someone else's before
    ours when two are as long; otherwise nobody's. What the window is not sure of only takes a mark
    away: the person's message then goes back to the page as failed, once, with its words in the
    input box, even when pi answered it. That is paid when another extension changes the words at
    the start of the person's message. The words of a turn still start with its row's
    `[Trigger <id>]`, for the person and the model, and an older version proves a row it queued by
    them; this version proves nothing by a prefix. The proof is read from the conversation at every
    drain and never from an event. A row of a version 2 line, queued by an earlier version, is still
    proved by its prefix, or by its words after `handed_at`, in an entry with no mark. In the window,
    a turn's message runs under the cap the window gave its row when it sent it, for as long as its
    slot lasts (the mode recomputed from the source, and an attended mode only for a row this window
    wrote, below). An older version's text proof can end a version 2 row's slot before its message
    starts, and the message then runs as one this window did not send. One
    that no hand-over of this window sent (pi kept it over a `/reload`, or another extension sent a
    message of that type) runs under the cap of its row in the file, read as a row this instance did
    not write, and under the strictest cap when the file has no such row: unattended, no tool
    declared. Under that cap a shell command and a control-plane call are asked about. Every other
    tool, except pi-loops' own read-only and self-gated ones, is refused and nobody is asked, since a
    card cannot show what it would read or write. The cap
    in the details is a record and is never read for a cap. A turn row of a source that asks for no
    turn (a rule's result written into the file as a turn) runs as unattended. A user message lifts
    a row's cap, since it is the person's, except while an input of another extension was seen since
    the cap began, or one seen before still waits for its message: the cap then stays until the turn
    settles, since that message may carry the scheduled turn on. A message with the very words of a
    waiting input takes that input out of the list (`claimOf`), and it keeps the cap no more.
    Whether an input is another extension's or the echo of our person row's send is read from its
    words when it comes outside our send. Those are the three places words touch a cap, and none
    gives a turn a wider cap than an older version did. And its attended mode has to be believed:
    after the
    append the page sends `/pi-loops ring <id> <fingerprint>` over its pi's rpc stdin, a channel no
    model tool can write to; the extension records the row as produced by this window only when the
    row now in the file has that fingerprint (a hash of kind, source, wake, text, the images and the
    declared tools), then drains; a ring that arrives after the row was handed over upgrades its
    cap, started or not, while the cap in force is that row's.
    A person row is handed over only once rung for, or two seconds after it was written, so the bell
    normally wins the race with the file watcher, and the drain that waits schedules one for when the
    wait ends; one nobody rang for (a terminal answering a page's row, owner decision O2; a line
    written into the file by hand) runs capped as unattended, and the window asks before a dangerous
    command. `/pi-loops ring` with no arguments only drains; it is plumbing, and not in
    `/pi-loops help`. A person row is sent only while its web.mjs lives: one left behind when pi
    exited is offered by the next page as "not sent before pi stopped", with send (which rewrites
    `created_by` to that page under the lock, then rings) and discard (a `cancel` row). A person row's send that pi
    refuses (`prompt()` throws before any run starts: compaction in progress, no model, no
    credentials) is found by the holder's tick, or by the drain the page's follow-up ring causes (a
    command handler, outside pi's event cycle), never by the drain `agent_settled` runs, since pi
    defers a prompt sent while it emits that event: a row handed to an idle pi with no `agent_start`
    since, ten seconds after pi's last `input` or `message_start` (its pre-run phase after `input`,
    the other input handlers and the credential check, is what the grace covers), is refused. A
    person row gets `last_error` and is never handed over again (its cap is kept, so a send pi runs
    late still runs under it); the page, which reads the file for `/state`, removes it, audits
    `failed`, and puts the text back in the composer with the error.
    A turn row's custom message is never refused in silence (probes S2, P17): one sent to an idle
    pi holds the lane until a run takes it up, with no grace, also from an `agent_settled` handler,
    where pi starts the run after the handler returns. pi drops one with no word on Esc in a terminal
    and on the page's clear queue, and never counts one in `hasPendingMessages()`, so the window
    keeps it until its message is written or a run settles: on a stop in a terminal it is `dropped`,
    with no stop and not written it is `lost`, and either is offered again; on the page's Stop pi
    keeps it and writes it in the next run. No turn is handed over while pi compacts the
    conversation (a turn sent then runs beside the compaction, P14). A turn's images are resized and
    their type read as pi's user path does it, since pi does neither for a custom message (P16). A pi-loops row counts an attempt and is offered again after the backoff, a dead letter at the third;
    a slot due while it waits replaces it rather than collapsing onto it. After Stop (rpc
    `abort`), as after Esc in a terminal, what is queued runs once pi is idle: the owner decided
    (2026-11-02) that Esc and Stop end the current turn only, as in 0.22.8, and that the queue is
    visible and cancellable everywhere instead (the page's per-row ✕, the terminal's `/cron queue`,
    `queued N` on the status line). The post-abort hold this design first had (a minute for
    pi-loops' rows, the person's next input for theirs, `released_at` and "send queued (n)" to lift
    it) is gone with it: a timer that sends words a person stopped was the cost it was meant to avoid,
    and a queue the person can see and cancel is the plainer answer. Send on an offered row makes the
    row this page's under the lock, then rings. `handed_at` is not part of the fingerprint. An offered row is listed
    with its whole text, since send vouches for all of it. The row's image bytes are a file beside
    the queue, one per row (`requests/<session>.<digest of the id>.images.json`), removed with the
    row; the row carries each image's type and SHA-256, the fingerprint covers those, and the holder
    refuses bytes that do not match them, so three screenshots are a line in the queue and not
    thirty megabytes rewritten under the lock at every update; an append that fails takes the file
    back, and the background process sweeps files no row names once they are a minute old. Each
    session's queue has its own lock (`requests/<session>.lock`): one `requests.lock` left by a
    process killed mid-rewrite held every writer of every session for the stale wait, and now holds
    that session's alone. A queue is a lane's (`src/lane.ts`): a conversation's lane is its
    session id, and a name that starts with `@` is a loop's lane (`@cron-<id>`) or a project's
    checks' lane (`@check-<project>`). The clock writes each slot row of a loop into its loop's
    lane. A check tick, a push and `/triggers run` write `check:` rows into the project's check
    lane. A yes writes its answer row into the lane that its finding names. The engine takes a row
    out of its queue by a named exit and in no other way: delivered, dead, cancelled, stale,
    refused, job-removed, stopped, parked (a loop's row, when its third interrupted run in a row
    turns the loop off). Three others remove
    rows, each for a reason of its own and with its own audit line where one is due: the page,
    which takes back or cancels a message it queued; a window, which drops its own goal's
    continuations and what it queued once that ran; and a clock. A window's clock puts a job's
    new slot in the place of a prompt that pi did not take. A window's clock or the
    background's, under the lease it took, takes back the row of a slot another process fired
    first. In the background a new slot is spent onto a row of its job that failed, and that row
    keeps its attempts. A row that a run has claimed leaves
    through the closing of that run only. The lane is taken from all
    the rows before any of them is started, and a turn handed to an idle pi that no run has taken
    up holds the lane, so an idle pi gets one prompt of ours at a time. A dead letter is filed once for a row, under an
    id derived from the row's lane and id (`Inbox.fileOnce`), so a crash between the finding and
    the removal files nothing the second time. The cost: a row that is queued again in the same
    queue under the same id and fails again gets no second finding, also when the first one was
    decided. A request line is version 3 and names its `lane`. A version 2 line is read as it
    is: it keeps its bytes at a rewrite, and stays version 2 while its row is only patched, so a
    0.24.2 window goes on reading the rows it wrote and its background process keeps their
    images. A claimed row is always version 3. What this version queues is a version 3 line,
    which an earlier version leaves unread: a result, a prompt, a message from the page, a stop
    or a cancel for a conversation that a terminal of an earlier version has open waits until
    that terminal is restarted. A holder that will not deliver a person row says so on its lease: a window standing
    aside writes `aside` on its holder (`print` and `json` mode are there already; `holderDelivers`
    in src/lease.ts reads all three), the page's own pi then runs the page's rows it was rung for in
    that holder's place, and the page does not say "answered there"; when the page's own pi is the
    one standing aside, the page says so with `/resume` and nothing writes into the conversation. A
    row of the page's nobody took in fifteen seconds with pi idle (past the ten-second refusal grace,
    so a refused send comes back as "not sent" and never as both; short of the thirty-second lease
    tick) is listed as "not taken (why)" with "send it here instead", which removes the row
    (audited `cancelled`) and sends the text over rpc `prompt`, as 0.22 did; a holder that delivers
    and is another process is not called unanswering, since the page sees only its own pi's idle
    state: the row reads "another pi holds this conversation and has not taken it yet (it may be busy)" and
    the offer "answer here instead (a branch the other pi will not see)". The removal and the check that no
    holder has stamped the row are one critical section under the queue's lock, and a drain whose
    stamp finds no row hands nothing over, so a message is answered once. A pi with no pi-loops in
    it gets chat text over rpc `prompt` and no row is written: nobody would drain it, and the ring
    would reach the model as the person's message; the command list is asked for again after every
    slash command (`/reload` changes it) and when it is older than thirty seconds. The
    cost is a second writer of the request file and a bell on every send; what it buys is a queue
    that Esc cannot clear and a message that outlives the process it was typed into.

    A claim from the page's inbox, from `/inbox claim` and from the selector a terminal opens when
    a turn settles is the same answer, and none of them is a turn of its own in a conversation. The
    claim marks the finding's answer pending and appends an answer row to the lane the finding
    names: a loop's, a project's checks' or the conversation's (src/answers.ts). The run that row
    wakes resumes the transcript of the run that reported the finding, and for a question it admits
    the one call the person saw, once. A conversation's answer runs in the window that holds the
    conversation once pi is idle (`createWindowAnswers`), and in the background when nobody has it
    open. The cost: a yes waits while its conversation is busy, and a yes to a finding whose
    transcript is gone starts from the finding's text. A yes to a loop's or a check's finding starts
    at the next tick of pi-loops in the background, up to 30 seconds later, since nothing rings it
    for an answer lane. `/inbox` and the status bar count new findings only; a yes that waits or
    runs is listed by `/inbox all` and `/inbox cancel`. A yes with no lane is recorded and not run:
    a finding that a 0.24.2 rule filed names no lane and no job of today, and a one-shot loop removes
    itself once it is done, so a yes to its findings reads "the loop was removed". In 0.24.2 a claim
    of such a finding was a turn in the conversation; a yes now runs only where the finding came
    from, so that it admits the call the person saw and nothing wider. A question stays open after
    its loop is removed, and its card names the loop by its id. A yes to a question finds the
    blocked call by its tool-call id, at the first assistant message that uses that id; a provider
    that uses one id twice in a conversation makes the yes fail closed ("it could not be started").

24. **A watch is a proposal, not a held turn.** In the person's own turn (hop 0, a UI, not a
    scheduled turn), `cron_create` and `new_trigger` run every check a create would, then write the
    job or the rule as proposed (`enabled: false`, `proposed: { at, session }`) and return at once.
    `new_trigger` does the same in a scheduled turn and in a turn pi-loops holds in a closed
    conversation. Nothing runs a proposal, and it does not expire. The model reads `proposed cron
    job …` or `proposed dynamic trigger …`, and is told not to wait, not to do the action now and not
    to call the tool again. The question is drawn from the record: `Set up this watch?`, the card's
    rows, and the options `watchOptions` gives (`src/watch-plan.ts`), the model's own choice first.
    `watchChoice` is the one place an answer becomes the stores' fields. The page draws it as a card
    in the conversation; a terminal asks in pi's selector when a turn settles, and `/cron enable` or
    `/triggers enable` asks it again. Set it up applies once, under the store's lock, while
    `proposed` is still set, and writes a receipt row into the conversation the watch was proposed
    in, which the model reads at its next turn. Cancel removes the record the same way. A sub-agent's
    `cron_create`, `cron_create` in a scheduled or held turn, `/cron add` and a recipe still create
    an enabled job. The question shows no directory, so a `cwd` outside the project is refused when
    the tool is called. A proposal needs a saved conversation, for its receipt. What it costs: the
    agent learns the answer only at a later turn, never in the call that proposed the watch, and a
    second identical call is a second proposal; the result tells the model not to call again, and
    nothing enforces it. A `pi --mode rpc` that the page did not start (another client) offers no
    proposal and no question when a turn settles, but the tool result still says that the person
    sees a card; the proposal waits until a person runs `/cron enable` or `/triggers enable`. Such a client is not a surface this project serves.

25. **A run writes into the conversation only when there is something to see.** A loop's first three
    runs and every failed run are one compact card each, saved in the conversation that created the
    loop, and every run a person asked for (`/cron run`, or a yes given in a conversation) is a
    card in the conversation it was asked from; every other run is a line in the terminal's panel
    and the page's activity strip, read from `runs.jsonl` when asked, with no store of its own. Deciding needs to know which run of its loop a
    run was, and the run log is halved as it grows, so the record carries it (`ordinal`), and a
    stopped run carries `aborted`, which is neither a failure nor a card. A 15-minute loop writes
    three entries into its conversation, not 96 a day. The cost: a loop that has worked for a week
    and then fails at night shows that failure, and nothing of the runs before it, in the
    conversation; the strip and `/cron runs` have those. A run whose every finding repeats an open
    finding reads `0 findings` on its card, in `/cron runs` and in `/cron cost`: the record keeps
    `repeats`, and only the loop's quiet streak reads it. The card of a yes's run has the same shape
    as a scheduled run's and does not name the finding it answered, so two cards of one loop can
    look the same. Both were accepted for 0.24.3 to keep one card shape for every run.

    Every matched rule result is one finding in the inbox, whatever `promote_to_chat` says; with
    `promote_to_chat` it is also in the conversation. `Inbox.appendOnce` is the one rule that keeps
    it one finding when the promotion falls back to the inbox or its row dies, the three writers that
    used to file it. A rule result is filed as news: its text comes from outside, and a `· waits:`
    in it would otherwise make a "Needs you" card and a notification on every page. A repeating
    rule that says what its latest new finding says files nothing, or it would fill the inbox one
    poll at a time. The cost: a result read in the chat waits in the inbox too, until someone
    dismisses it.

    A terminal writes `turnSince` on its lease while a turn runs, as the page's pi does, and `turns`
    says it will. The page reads a terminal-held conversation from the file with pi's exported
    parse, migration and projection functions instead of switching its own pi to it, and reads it
    again once the turn is over and a new message is there. The read is synchronous in the process
    every page shares, so a file over 32 MB is left to the page's pi. A switch changed the epoch under the
    page and answered `get_messages` from either session; a guess at the end of a turn from 8 s of
    quiet read half a turn. The cost: two small lease writes per terminal turn, and a terminal
    older than 0.24 is never read again by the page.

26. **A condition that is only a path is looked at with `stat` first.** A rule such as "when
    ~/build.done appears" used to cost a model call every poll, for hours, to learn that one file was
    not there yet. `src/gate.ts` decides when the rule is created whether its condition is
    only "a path exists or appears", resolves `~` and `$HOME` in the creating process, and records
    the result on the rule as a path `gate`, and as `precheck` with the same path for 0.24.2. Each
    poll, after the poll ledger's claim, `stat`s the path (2 s timeout, one in flight per rule);
    while it is absent the rule stays out of the check's prompt and no `running` row is written,
    the look is counted in `clock.json`, and the audit says `waiting` once. A look that lets the
    rule through is stored in `events.jsonl` before the check starts. Anything the stat
    cannot answer goes to the model, so a refusal or a doubt costs what it cost before and never a
    match. The costs: a condition worded outside the grammar still bills; the grammar knows English
    and Chinese only; a rule created before 0.24.0 keeps billing until it is created again, because
    the path was never resolved by the person's own process; and a repeating rule still matches
    every poll while the file stays, as it always did. An export writes a rule's `gate` and
    `precheck` as they are, with the exporting machine's path. 0.24.2 resolves only `precheck` again
    when it imports, and this version reads `gate` first and fills it from `precheck` only when it
    is not there. So a path rule exported by this version, imported by 0.24.2 on another machine and
    upgraded there again looks at the first machine's path and never wakes; created again, it looks
    at its own. The sequence needs a downgrade between two machines, and an import by this version
    resolves the path again.

27. **What happened while you were away is counted per project.** One cursor per project in
    `seen.json`, moved by `/inbox` in any of its conversations and by the page's **Mark all seen**;
    the terminal's session-start line and the page's away card are one function over the same files
    (`src/seen.ts` `awayFor`). Every loop of the project counts, a recipe's included, and a finding
    from this conversation is marked as such. The cost: a look in one conversation clears the
    count for all of them, and the page's mark clears the terminal's next line. A cursor per
    conversation was the alternative, and it is what left a recipe's findings out: they belonged
    to the one conversation that installed it. With no cursor the first count is the last day,
    never the whole run log.

28. **The dangerous-command policy asks about what it cannot read, and about a git setup an
    unattended run writes.** A question costs one tap, so the policy stops a command it cannot read
    with confidence: a command of one line that ends inside a quote, a `$'…'` with a backslash (bash
    and sh read it differently), and a verb after `pi-loops` or a git key or sub-command that the shell
    rewrites (`$`, a brace, a backslash) are asked about (#231). A command over several lines is read
    as written, every quote in it: bash reads lines in ways the policy would have to copy to set a
    quoted phrase aside (a heredoc's body, a comment, a backslash that continues one line and not
    another), and each copy missed one. A shell command that writes a git setting on the policy's list
    (`git config` in any scope, `git clone -c`, a template, `git config --edit`), or that writes a git
    setup file (a git directory's `config`, `hooks`, `info/attributes`, `modules`, `worktrees`;
    `.gitattributes`; `~/.gitconfig`; `~/.config/git/`) with anything but a reader, is asked about.
    pi's `write` and `edit` of such a file are refused, not asked: a card cannot show what the write
    puts there. git's options are read against lists of the ones the policy knows, and an option it
    does not know is taken as one that may write, since git takes any unique prefix of a long option.
    The cost: `echo it's`, `ls # don't`, `git config core.pager less`, `git checkout -- .gitattributes`
    and a command such as `du -sh .git` are each one question; a command over several lines that the
    policy stops is refused, since a card shows one line, and so is one whose quoted text names a
    pi-loops stop or claim or the loops directory. What this does not see (#172): a setting or a hook
    that something other than an unattended turn wrote (a person, another tool, a clone), which a later
    unattended `git` call runs as you; a setting given for one command (git's global `-c`, `GIT_*`
    variables) other than a template, which runs a program the way the run could run it itself; a
    path or a name the shell builds at run time or reaches after a `cd`; a program that runs git
    another way; a setting the list does not name. Reading a repository's setup before each unattended
    git call was built and withdrawn: four reviews each found programs git runs that the read did not
    see (a hooksPath an `includeIf` sets, submodule hooks, `ext::` remote URLs, the scripts a setting
    names). The policy
    is a guard against mistakes and a plain injection, not a sandbox.

29. **0.24.3 keeps some losses against 0.24.2.** Each was found in the review before the release
    and accepted, so that the release carries the queue, the guard and the inbox as one design. Each
    is a candidate for a later release.

    - An archive carries neither the inbox nor a loop's notes directory (`state/<id>/`). A recipe
      now keeps what it reported in `[reported]` and in its notes directory, so a moved loop starts
      with neither, and its first runs can report again what it reported before the move.
    - A loop run's request is larger: the first run's prompt by about 88%, the tool schemas by about
      1.5 KB (`wake_me` is always offered), and the whole request by about 21% (10,739 to 12,987
      bytes with the stand-in model). The skill text grew from 4,318 to 8,298 bytes. Every run and
      every session that loads the skill pays those tokens, for the notes, `[reported]` and the
      guard's words.
    - With many findings, reads are slower: `pi-loops status` by about 60% (421 ms), and the page's
      inbox read with 2,000 findings about three times (92 ms). Both stay below what a person
      notices.
    - A project's checks fail and back off as one, counted from the run log: after the third
      failure in a row they wait 1, 5 and 30 minutes, then 2 and 6 hours. A `/triggers run` that
      fails counts too. 0.24.2 counted per rule, so one failing rule now delays every rule of its
      project.
    - An unattended run's shell command that reads or writes pi-loops' own files (`runs.jsonl`,
      `host.log`, `jobs.json`, `web-token`) is asked about, and pi's file tools are refused there,
      except in a loop's own notes directory. A loop that watched other loops by reading the run log
      now asks each run; `pi-loops status` and `pi-loops inbox list --json` are the reads to use.
      The rule also keeps `web-token` away from a run.
    - `pi-loops inbox list --json` does not mark a question, so a script that claims every new
      finding stops at a question with exit 1.
    - On the page, a project with no loop and no rule shows "+ Add a loop" in place of the runtime
      box, so its MCP servers and an `mcp.toml` error are not shown there. Loops and rules are
      what use those servers, and `pi-loops status` lists the servers pi-loops connected. During a turn Stop takes the place of Send, and only Enter queues a message. A watch's
      receipt shows as a raw `pi-loops:trigger` message with its `[Trigger rcp-…]` id, and after a
      reload it is folded into the step group. While a terminal runs a turn that the page sent, the
      page shows no "working…" and no Stop, as in 0.24.2.

## Where the browser front end came from

pi owns the `pi` command and its terminal, so a second front end cannot replace the first one. It
goes through the door pi already provides: `pi --mode rpc` — pi with no terminal UI, commands in
and events out as JSON lines — with [src/web.mjs](../src/web.mjs), a browser front end in one
dependency-free file, passing that protocol through to a page. The session is a real pi session,
and `pi --resume` picks it up afterwards. What only the process knows — which MCP servers connected,
what they exposed, the active tools, whether pi-loops is running and its pid — reaches the page as the
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
without anything of yours passing through a third party, and `[page] host` does the same over a local
network for people who would rather not run a tailnet. What both need is a way in that a phone can
manage — the pairing code and the QR ([cli.md](cli.md)). A phone on neither network is the case
this does not cover; that one would need a relay.

While nobody is at the terminal, pi-loops’ control channel is what answers "what is it doing":
`pi-loops status|abort|stop` ([cli.md](cli.md)), and the Background view of the page, which
`tailscale serve` puts on a phone the same way.

In 0.24 the page moved out of the terminal. Until then `pi-loops` ran the page's server and its one
pi itself, so closing that terminal took the page off the phone, and pi-loops in the background
served a separate read-only status page on 4174. Now pi-loops in the background serves the one page
on 4173, with a pi for each open conversation, and `pi-loops` only asks it to open one and exits
(decision 21). `src/web.mjs` keeps the page strings; the server is `src/page-server.ts`. The
listener flags became `[page]` in `config.toml`, because a page that outlives the command cannot
take its address from one.

## What this is not

An agent. Writing code, reading the web, managing skills — those are pi's, and this does not
duplicate them. What it decides is *when* work happens, *where* it runs, and *what context it
carries*; the work itself is done by the agent you already have.
