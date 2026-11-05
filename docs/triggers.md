# Dynamic triggers

## Rules

A rule is a natural-language **condition** and **action**:

```text
/new-trigger when ~/build.done exists, run cargo test and show me the result
/new-trigger 当 $HOME/helloworld 存在的时候，打印它的内容
```

`/new-trigger` asks the agent to extract condition and action and call the `new_trigger` tool
(the agent may also do this from ordinary chat). Rules **fire once** by default (`fire_once=false`
for repeating). A matched rule's result is a finding in the inbox and a row in the page's loop
activity strip, whatever `promote_to_chat` says; `promote_to_chat` also puts it in the conversation,
and it is still one finding. The finding is news whatever the result says: it comes from outside, so
a `· waits:` in it does not make it a decision. Its card and its strip row lead with what the check
said after the `matched <rule-id>` it starts with; the finding keeps the whole text. A check whose
result says exactly what the latest new finding of the same rule and project says files nothing
more. The check records on its result's audit row whether it filed the finding or skipped it as a
repeat; when the promotion falls back to the inbox, or its row dies, nothing more is filed for that
check. A result that no check decided, such as a push with no rule, is filed once by its trace id.
Time-based requests ("every hour", "daily", "定时任务") are refused and routed to `cron_create`.

Tools: `new_trigger` (condition, action, spec, fire_once, promote_to_chat), `list_triggers`,
`remove_trigger` (id | all), `set_trigger_state`. Creating, removing and re-enabling ask the user to
confirm, with `ctx.ui.confirm`.

In a conversation open in the browser page, `new_trigger` creates nothing: in the person's own turn
it checks everything a create would, keeps a plan in that pi's memory for thirty minutes, and
returns it (`details.watch` on the tool result, which the model does not see). The page draws the
plan as a card with two choices, and only the card's **Set it up** creates the rule: Result is
`promote_to_chat` (*Show it in this conversation*, the default, or *Put it in my inbox*) and Repeats is `fire_once` (*Once, then turn itself off*, the default, or *Every
time it happens*). Cancel writes nothing. The page's **Watch for…** box sends one sentence as the
chat message `Watch for: <sentence>`; a sentence with no time and nothing to wait for is answered
by the page itself ("this reads like something to do now") and reaches no model. A conversation a
terminal holds is answered in that terminal, which has no card: a rule asks there with
`ctx.ui.confirm`; a schedule is created there at once, as `cron_create` always has. A sub-agent, a
scheduled turn and the terminal keep today's behaviour. See `docs/design.md`, decision 24.

The model-facing tools see the calling project only: `list_triggers` takes `all_projects: true`
when the user asks about the rest, and `remove_trigger { all: true }` clears this project's rules,
never the machine's.

### Rules that wait for a path

A condition that is only "a path exists or appears" is recorded as pre-checkable when the rule is
created (`precheck` on the rule in `triggers.json`: the condition it was read from, the path as
typed, and the absolute path). The path is one token: `~/…`, `$HOME/…`, `${HOME}/…`, an absolute
path, `./…` or `../…`, a relative path with a `/`, a file name with an extension (`build.done`), or a
quoted path that may hold spaces. The verb is one of `exists`, `appears`, `is created`, `shows up`,
`is there`, `is present`, `存在`, `出现`, `被创建`, `生成` (a `文件` or `目录` before the verb is the
noun only when a space sets it apart from the path: `~/备份文件 存在` waits for `~/备份文件`), with an optional leading `when`, `if`,
`once`, `当`, `如果` or `一旦` and an optional trailing `的时候`, `时` or `后`. `~` and `$HOME` are
resolved in the process that creates the rule, so they are your home even when pi-loops in the
background was started with another one; a relative path is resolved against the rule's project.

Anything else is refused as path-only and checked by the model, as before: a glob, a second clause
(`~/x appears and it contains ERROR`, `~/a exists or ~/b exists`), another verb, a bare word with no
`/` or extension (`README`), a variable other than `$HOME`, `~user`, a URL, or a network path
(`//server/…`, `/net/…`, `/Network/…`). A rule created before
0.24.0 has no `precheck` and keeps calling the model; create it again to get the pre-check. So does
a rule whose condition was edited by hand after it was created, and an imported rule is read again
against the project it is imported into.

## Evaluation

While at least one enabled rule exists, every `[triggers] poll_interval_secs` in `config.toml`
(default 600; pi-loops re-reads it every minute) one check per project that has rules is run by pi-loops. The check receives the
event JSON and every enabled rule and is told to inspect the filesystem, commands, clock or network
as needed, execute the actions of matching rules, and reply `matched dyn-…` or exactly
`no dynamic trigger rule matched`. Matched fire-once rules are disabled with `fired_at`.

A rule that waits for a path (`precheck`, above) is looked at first: after the poll is claimed,
pi-loops `stat`s the path, which follows symlinks, and gives up after 2 seconds. At most two looks
are out at once in the process, and one per path; past that a look counts as one that cannot answer. While the path is
absent the rule is left out of the check, so a project whose only rules wait for absent paths
makes no model call and writes no `running` row. The audit gets one `trigger` row `waiting`
("no model call until ~/build.done exists") at the first look pi-loops makes and whenever the path
goes away, and one `appeared` when it is back; the check that follows names the rules the look let
through in `details.prechecked` on its `running` row. When the look cannot answer (no permission, a
mount that does not answer in time) the model checks the rule, as before. A repeating rule is
checked every poll while its path exists, and matches again after the path is deleted and comes
back. The rule's row on the page says what it waits for and when the next look is: "waits for
~/build.done · next look 09:22 · no model call until the file exists".

Pushed MCP notifications (see [mcp.md](mcp.md)) enter the same runtime and are evaluated against
the rules unless the server is configured as an `inject_summary` / `inject_and_run` feed.

A rule whose check keeps failing is polled with a widening gap instead of at every interval: after
three failed checks in a row the rule waits 5 minutes, then 10, 20, … up to 6 hours (the scheduler's
job backoff, same numbers — literally the same function, `backoffWaitMs` in `src/schedule.ts`).
The count lives on the rule (`consecutive_failures`,
`last_check_failed_at`), a check that completes clears it — including `/triggers run <id>`, which is
the way to retry a backed-off rule now — and entering the backoff is audited as `backoff` with the
rule ids and the failure count. Pushes are unaffected: an event is worth one attempt. While a rule
is in that state `/triggers rules` marks it `[failing ×N]` after its state bracket; a disabled rule
is not polled and is not marked.

## What happens when the machine is busy or over budget

A trigger that finds every check slot taken (`[cron] max_concurrent_runs`, default 3) or the day over
`[limits] daily_budget_usd` is refused before it claims the dedup key, and what happens next depends
on what was refused:

- A **periodic check** is dropped (`deferred`). The next poll looks at the world again and reaches
  the same conclusion, so re-running the held one would only check twice.
- A **push** refused for want of a slot is held in a bounded list (32 events, keyed by idempotency
  key and project) and retried oldest first on the next scheduler tick — a push is an event that
  happened once and no server re-sends it. Its audit row says `deferred` with `queued` (`queued`,
  `replaced` when the envelope's `latest_replaces` policy supersedes one already waiting,
  `collapsed` when it does not) and the current `pending` depth. The retry goes through dedup,
  audit and the normal delivery, and its check prompt carries the event's original `received_at`
  plus `deferred_ms` and a line saying how long it was held, so a time-sensitive rule can re-check
  before acting. When 32 are already waiting, the **oldest** is dropped with its own `dropped` row.
- A push refused because the day is **over budget** is dropped (`budget_exceeded`), not held: too
  busy clears in minutes, but the cap can last until midnight, and acting on the morning's event at
  23:59 is worse than not acting. The same applies to a held push whose retry finds the cap
  exceeded. Held pushes live in memory, so they do not survive the process quitting.

## Promotion and audit

A matched rule with `promote_to_chat` is a request addressed to a conversation: the one that
created the rule while a window holds it; else the conversation a window holds in the rule's project
(lowest pid first, as 0.22.8 chose its owner), so the result reaches the chat you are working in;
else the closed creating conversation. It is one row in `requests/<session>.jsonl`, which stays there until `[Trigger <trace>] <result>` is
in the conversation. The window holding the conversation inserts it (visible to future turns; no
model call when idle, a follow-up turn when busy: `promoted`, `to: "chat"` in the audit when it
landed at once, `to: "queued"` when another process or a later drain delivers it). If no window
holds the conversation, pi-loops appends the result to it, holding the conversation for that one
write, so it is there when the conversation is resumed (`appended`); the next session start there
counts it in its `[inbox] since you last looked` line. It does so within moments of the row being
written: pi-loops watches `requests/` and `leases/`, and a window that wrote the row rings it over
the control socket; its 30-second tick is the floor under both, so a ring that is lost costs at most
one tick, and never a row. If pi-loops cannot take the conversation at
that instant (someone wrote it in the last two minutes), the row waits and pi-loops appends it on a
later tick. A row whose delivery fails waits a minute, then five, and blocks nothing behind it; at
the third failure, or when the conversation's file is gone, it is a dead letter: a finding in the
inbox marked for the conversation, then a `request` audit row (`dead`), then the row is removed, in
that order so a crash in between loses nothing. A rule's result has its finding already (every match is one), so its dead letter files no second one; any other row's finding reads `could not be delivered (<why>): <prompt>`. A rule with no
creating conversation (made from a shell, imported, or made by a loop's run) sends results to the
project's open window as above, and to the inbox (`redirected`, which finds the match's finding and adds nothing) when none is open. One check evaluates every
rule of the project at once, so it runs under **one** model: the first rule that has one recorded
(`/triggers set <id> --model … | -`), and that rule's thinking level with it — a thinking level
belongs to the model it was chosen for, and a rule with a model but no level falls back to the
running session's. Pin the model on the rule you want to decide it, or on all of them. The timeout is
the longest of the project's rules (`--timeout`), else `[triggers] run_timeout_secs`. Every trigger leaves audit records in `triggers-audit.jsonl` and as
session entries (`trigger`, `trigger_result`, `trigger_promotion`); `/triggers audit [N] [--all]`
shows this project's rows with decisions and transcript paths. The complete set of states:

- admission — `accepted`, `deduped`, `deferred` (no slot), `dropped` (the held list was full),
  `budget_exceeded`,
  `cycle_suppressed` (it reached a sub-agent), `backoff`, `disabled` (the rule's project is gone),
  `waiting` (a rule's path is absent: no model call until it exists) and `appeared` (it is back);
- the run — `running`, then `completed` / `failed` / `aborted`, or `no_rules`;
- promotion — `promoted` (into this chat, or queued for the conversation), `appended` (pi-loops wrote
  a queued result into the closed conversation), `redirected` (to the inbox: no window is open in the rule's project, and the rule has no
  conversation or its conversation's file is unknown or gone; or a pi-loops 0.22 window has it open), `skipped` (no matched rule has `promote_to_chat`).

Rows of type `request` record what became of a row in `requests/<session>.jsonl` that did not end
in the conversation: `failed` (one delivery failed, pi refused the hand-over, or pi dropped it
unwritten; the row waits out a backoff, or is offered again), `dead` (three failures, or the
conversation's file is gone: it is a finding in the inbox now; never a person's message), `cancelled`,
`done` (a stop or cancel that acted: the turn aborted, or the queued row taken out), `stale` (a stop
or cancel with nothing to act on, a goal row without a goal, or a person's message whose
conversation is gone), `job-removed`, `refused` (the row's
`mode` is not the one its source gets, so a line edited in the file, or written by another version,
cannot widen what a turn may do; the row never runs). Two more come from the inbox in the browser
page: `claimed` (a finding's claim was queued for the conversation that created its loop; the row
is the `inbox:<id>` one `/inbox claim` writes, and the trace id is its id) and `dismissed` (a
finding was dismissed from the page; the trace id is the finding's, and `details.reason` is what the
person gave, redacted, or null).

Rows of type `cron_control_plane` use the operation as the state instead: `add`, `set` (a
schedule changed in place by `/cron set --schedule` or by a suggestion applied from the page, with
`details.before_schedule` and `details.after_schedule`; an edit that leaves the schedule alone
writes none), `enable`, `disable`, `remove`. The page's and `/cron set`'s rows are in
`triggers-audit.jsonl` (source `page` or `slash`); the others are also session entries.

A 5-minute dedup window collapses repeated events with the same idempotency key (per project for
rule evaluation, per window for injected pushes).

```text
/triggers status      rule counts, checker ownership, last check, push sources
/triggers rules       this project's rules  (--all for every project)
/triggers sources     local checker + each MCP server: state, queued/dropped/deduped, tools
                      (/triggers hooks is the same view)
/triggers enable <id> /triggers disable <id> /triggers remove <id>   also --all | --all-projects
/triggers set <id>    --model | --thinking | --timeout: what the action runs with
/triggers run <id>    check one rule now, without waiting for its poll slot
/triggers running     sub-agents in flight (dynamic checks and cron runs)   /triggers abort <trace>|--all
/triggers audit [N]
/triggers panel on|off
/triggers help        all of the above, in the terminal
```

Cron runs share this runtime's views: they appear in `/triggers running` and `/triggers audit`
and can be aborted by run id. A plain job's turn running in a closed conversation in the background
is stopped through a request (`stop` in `requests/<session>.jsonl`), which that process reads within
a tick whether or not its socket answers: `/triggers abort <run-id>` says `requested stop for
<run-id> (session <id>)`. Loop runs and checks, and `--all`, are asked of it over the socket as before.

`/triggers run <id>` takes the same path a periodic check takes — dedup, audit, the check
sub-agent, promotion — and skips only the poll ledger, which is what running it now means. The
poll interval is unaffected: the next scheduled check happens when it would have anyway.

## Cycle safety

Cycles are bounded by a hop count: sub-agents run at hop 1 and still have the
cron/trigger tools, so a trigger action can schedule a job; they never run the trigger runtime, so
nothing nests. Prompt-class operations — creating or removing a trigger,
re-enabling a trigger or a cron job — are denied fail-closed in sub-agents (no control-plane
prompt channel there); `cron_create` and `cron_remove` work and the control-plane audit records
`actor: sub-agent`. Sub-agents never handle triggers themselves: they ignore MCP pushes, and the
runtime audits anything reaching hop ≥ 1 as `cycle_suppressed` (hops are counted per trace, but the
bound that matters is structural: a sub-agent session never acts on a trigger at all).

## Command output, approvals, promotion

`/triggers enable|disable <id>` prints the rule's state, condition and action (and the
fire-once note); `/triggers sources` lists MCP servers, the cron hook and the dynamic
checker in registration order with a `sources: N total, M connected, K require
attention` summary in `/triggers status`. Errors are worded once and kept that way (`unknown /triggers command:
…`, `usage: /triggers remove <id>|--all`, `/new-trigger` parse messages). `/triggers remove --all`
clears this project's rules; `--all-projects` is the explicit machine-wide sweep.

Prompt-class tool calls (`new_trigger`, `remove_trigger`, re-enabling a trigger or a cron job)
show an approval card — Action, Tool, a value-free Reason, an args hash and a redacted
Preview — and leave `approval required` / `approved` / `denied` lines in the feed. Promoted
results and injected summaries are inserted as `[Trigger <trace>] <text>`, with no extra
wrapper; an inject-and-run turn announces itself with
`running triggered turn (trace …)`.
