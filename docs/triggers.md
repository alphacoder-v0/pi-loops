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
Time-based requests ("every hour", "daily", "定时任务") are refused and routed to `cron_create`; a condition that merely names a routine ("when the daily build fails") is an event, and is accepted.

Tools: `new_trigger` (condition, action, spec, fire_once, promote_to_chat), `list_triggers`,
`remove_trigger` (id | all), `set_trigger_state`. Removing and re-enabling ask the user to
confirm, with `ctx.ui.confirm`.

`new_trigger` writes a **proposal**, in the person's own turn and in a scheduled or held turn
alike (see "A proposed watch" in [loops.md](loops.md)). In the person's own turn in a pi with no UI
(`pi -p`), where nobody could answer a proposal, it asks pi's confirm as 0.24.2 did, and a pi with
no UI refuses it. The
rule is in `triggers.json` with `enabled: false` and `proposed: { at, session }`; no check reads it,
and it does not expire. The model reads `proposed dynamic trigger dyn-…: the person sees a card …`.
The question's answers are Result, `promote_to_chat` (*this conversation*, the default in the
person's own turn, or *inbox*), and Repeats, `fire_once` (*once*, the default, or *every time*).
`/triggers enable <n|id>` on a proposal asks it in pi's selector; Set it up applies the answer only
while the rule is still proposed, then writes the audit line `enable` and a receipt in the
conversation; Cancel removes the rule, with the audit line `remove` and a receipt. A second answer
prints `already answered: set up` or `already answered: cancelled`. `/triggers rules` marks a
proposal `[proposed: waits for your yes]`, with `/triggers enable <n|id> asks again · /triggers
remove <n|id> cancels it` under it; `list_triggers` gives `[proposed]`; `/triggers enable --all`
passes over it and `set_trigger_state` refuses it. The page's **Watch for…** box sends one sentence as the chat message
`Watch for: <sentence>`; a sentence with no time and nothing to wait for is answered by the page
itself ("this reads like something to do now") and reaches no model. A sub-agent has no
`new_trigger`. See `docs/design.md`, decision 24.

The model-facing tools see the calling project only: `list_triggers` takes `all_projects: true`
when the user asks about the rest, and `remove_trigger { all: true }` clears this project's rules,
never the machine's.

### Rules that wait for a path

A condition that is only "a path exists or appears" gets a gate when the rule is created: `gate`
on the rule in `triggers.json`, `{"kind": "path", …}` with the condition it was read from, the path
as typed, and the absolute path. The rule also gets `precheck` with the same path, which is the field
0.24.2 reads. A rule that has only `precheck` (one that 0.24.2 made) is read through it, and the
next start of pi-loops gives it the `gate`. `triggers.json` stays `version: 1`. The path is one token: `~/…`, `$HOME/…`, `${HOME}/…`, an absolute
path, `./…` or `../…`, a relative path with a `/`, a file name with an extension (`build.done`), or a
quoted path that may hold spaces. The verb is one of `exists`, `appears`, `is created`, `shows up`,
`is there`, `is present`, `存在`, `出现`, `被创建`, `生成` (a `文件` or `目录` before the verb is the
noun only when a space sets it apart from the path: `~/备份文件 存在` waits for `~/备份文件`), with an optional leading `when`, `if`,
`once`, `当`, `如果` or `一旦` and an optional trailing `的时候`, `时` or `后`. `~` and `$HOME` are
resolved in the process that creates the rule, so they are your home even when pi-loops in the
background was started with another one; a relative path is resolved against the rule's project.
An aside in parentheses is a second clause: `/tmp/a exists (or /tmp/b exists)` is true while
`/tmp/a` is absent, so a condition with one is checked by the model.

Anything else is refused as path-only and checked by the model, as before: a glob, a second clause
(`~/x appears and it contains ERROR`, `~/a exists or ~/b exists`), another verb, a bare word with no
`/` or extension (`README`), a variable other than `$HOME`, `~user`, a URL, or a network path
(`//server/…`, `/net/…`, `/Network/…`). A rule created before
0.24.0 has no gate and keeps calling the model; create it again to get the pre-check. So does
a rule whose condition was edited by hand after it was created. An imported rule, from 0.22 or later,
is read again when it is imported, against the project it is imported into and this machine's home,
so a path-only one gets the pre-check then.

## Evaluation

While at least one enabled rule exists, every `[triggers] poll_interval_secs` in `config.toml`
(default 600; pi-loops re-reads it every minute) one check per project that has rules is run by pi-loops. The check receives the
event JSON and every enabled rule and is told to inspect the filesystem, commands, clock or network
as needed, execute the actions of matching rules, and reply `matched dyn-…` or exactly
`no dynamic trigger rule matched`. Matched fire-once rules are disabled with `fired_at`.

A rule that waits for a path (its `gate`, above) is looked at first: after the poll is claimed,
pi-loops `stat`s the path, which follows symlinks, and gives up after 2 seconds. At most two looks
are out at once in the process, and one per path; past that a look counts as one that cannot answer. While the path is
absent the rule is left out of the check, so a project whose only rules wait for absent paths
makes no model call and writes no `running` row. Such a look stores nothing: it adds one to the
rule's look count in `clock.json`, where the rule's last look is kept too. A look that lets the rule
through is stored as it was taken before the check starts: one line in `events.jsonl` with source
`gate:<rule id>` and the path, the absolute path and what the look found. The audit gets one
`trigger` row `waiting` ("no model call until ~/build.done exists") at the first look and whenever
the path goes away, and one `appeared` when it is back; the check that follows names the rules the
look let through in `details.prechecked` on its `running` row, and the stored looks in
`details.events`. When the look cannot answer (no permission, a
mount that does not answer in time) the model checks the rule, as before. A repeating rule is
checked every poll while its path exists, and matches again after the path is deleted and comes
back. The rule's row on the page says what it waits for and when the next look is: "waits for
~/build.done · next look 09:22 · no model call until the file exists".

A rule can also have a command gate: `gate` is `{"kind": "command", "command": "…"}`. Only a
proposal sets one: `new_trigger` with `gate`, which the person sees in the card's `Checks first`
row before they say yes. `new_trigger` where it creates at once (a pi with no UI) refuses a `gate`
whole: `a gate needs a person: new_trigger with a gate proposes the rule, and the person sets it up`.
`/cron set` cannot set a rule's gate. After the poll is claimed,
pi-loops runs the command in the rule's project, as a loop's gate runs (see [loops.md](loops.md), "A
gate: no model call while nothing changed"): the same checks where it is set, the
dangerous-command policy with the loops directory first, 5 seconds, the first 4000 characters, its
process group killed when the look ends, at most once a minute for each rule. While it prints what the last check that did
not fail saw, the rule is left out of the check and the look is counted in `clock.json`. Any other
reading, and a look that fails, lets the rule through, stored first in `events.jsonl` (source
`gate:<rule id>`). When the check ends without a failure, that reading is the rule's `seen`; a check
that fails leaves it. A rule with a command gate has no `precheck`, so 0.24.2 checks it with the
model each poll.

A pushed MCP notification (see [mcp.md](mcp.md)) is stored in `events.jsonl` first. Then it is a
row in the check lane of each project with an enabled rule, and that check evaluates it against the
rules, unless the server is configured as an `inject_summary` / `inject_and_run` feed.

A rule whose check keeps failing is polled with a widening gap instead of at every interval: after
three failed checks in a row it waits 1 minute, then 5 minutes, 30 minutes, 2 hours and 6 hours from
the seventh failure on. Loops and rule checks use the same table in `src/backoff.ts`.
The count is the project's checks in the run log (`runs.jsonl`, the records of the project's check
lane), not a field on the rule: one check covers every rule of the project, so the count is the
project's. A check that completes ends it — including `/triggers run <id>`, which still retries a
backed-off rule now — and entering the backoff is audited as `backoff` with the rule ids and the
failure count. Pushes are unaffected: an event is worth one attempt. While a project is in that
state `/triggers rules` marks each of its rules `[failing ×N]` after its state bracket; a disabled
rule is not polled and is not marked. A rule that 0.24.2 wrote with `consecutive_failures` and
`last_check_failed_at` is read as it is, and those two fields are ignored.

## What happens when the machine is busy or over budget

Every check is a row of its project's check lane, `requests/<lane>.jsonl`: a periodic check, a
push and `/triggers run`. The row waits there on disk, so it survives pi-loops stopping and starting
again.

- While every check slot is taken (`[cron] max_concurrent_runs`, default 3), the row waits for a
  free one. A **periodic check** that comes due while an earlier periodic check or `/triggers run`
  of the same project waits or runs writes no second row: the next poll looks at the world again
  and reaches the same conclusion.
- A **push** waits as a row too, because a push is an event that happened once and no server
  re-sends it. A second push with the same idempotency key inside five minutes joins the waiting
  row (audited `deduped`), or takes its place when the envelope's policy is `latest_replaces`
  (audited `accepted` with `replaces`). At most 32 pushes wait in one lane: when one more
  arrives, the **oldest** waiting push is dropped with its own `dropped` row. The check prompt carries the event's original `received_at`, so a
  time-sensitive rule can re-check before acting.
- A row that would start while the day is **over budget** (`[limits] daily_budget_usd`) leaves its
  lane with `budget_exceeded`, a push and a periodic check alike. Too busy clears in minutes, but
  the cap can last until midnight, and acting on the morning's event at 23:59 is worse than not
  acting.

Each check writes a run record in `runs.jsonl`, so its cost counts toward today's budget, and
`/cron cost` shows a project's checks as `checks of <directory>`. `pi-loops events replay <id>`
makes the row of a stored push or gate reading again ([cli.md](cli.md#events)).

## Promotion and audit

A matched rule with `promote_to_chat` is a request addressed to a conversation: the one that
created the rule while a window holds it; else the conversation a window holds in the rule's project
(lowest pid first, as 0.22.8 chose its owner), so the result reaches the chat you are working in;
else the closed creating conversation. It is one row in `requests/<session>.jsonl`, which stays there until `[Trigger <trace>] <result>` is
in the conversation. The window holding the conversation inserts it (visible to future turns; no
model call when idle, a follow-up turn when busy: `promoted`, `to: "chat"` in the audit when it
landed at once, `to: "queued"` when another process or a later drain delivers it). If no window
holds the conversation, pi-loops appends the result to it, holding the conversation for that one
write, so it is there when the conversation is resumed (`appended`); the rule's finding in the
inbox is what the next session start's `[inbox] since you last looked` line counts. pi-loops appends it within moments of the row being
written: pi-loops watches `requests/` and `leases/`, and a window that wrote the row rings it over
the control socket; its 30-second tick is the floor under both, so a ring that is lost costs at most
one tick, and never a row. If pi-loops cannot take the conversation at
that instant (someone wrote it in the last two minutes), the row waits and pi-loops appends it on a
later tick. A row whose delivery fails waits a minute, then five, and blocks nothing behind it; at
the third failure, or when the conversation's file is gone, it is a dead letter: a finding in the
inbox marked for the conversation, then a `request` audit row (`dead`), then the row is removed, in
that order so a crash in between loses nothing. A rule's result has its finding already (every match is one), so its dead letter files no second one; any other row's finding reads `could not be delivered (<why>): <prompt>` and carries `"undelivered": true`. Only that field makes a claim carry the prompt out; a loop's finding in the same words is claimed as a finding. A rule with no
creating conversation (made from a shell, imported, or made by a loop's run) sends results to the
project's open window as above, and to the inbox (`redirected`, which finds the match's finding and adds nothing) when none is open. One check evaluates every
rule of the project at once, so it runs under **one** model: the first rule that has one recorded
(`/triggers set <id> --model … | -`), and that rule's thinking level with it — a thinking level
belongs to the model it was chosen for, and a rule with a model but no level falls back to the
running session's. Pin the model on the rule you want to decide it, or on all of them. The timeout is
the longest of the project's rules (`--timeout`), else `[triggers] run_timeout_secs`. Every trigger leaves audit records in `triggers-audit.jsonl` and as
session entries (`trigger`, `trigger_result`, `trigger_promotion`); `/triggers audit [N] [--all]`
shows this project's rows with decisions and transcript paths. The complete set of states:

- admission — `accepted`, `deduped`, `dropped` (32 pushes already waited in the lane),
  `budget_exceeded`, `backoff`, `disabled` (the rule's project is gone),
  `waiting` (a rule's path is absent: no model call until it exists) and `appeared` (it is back);
- the run — `running`, then `completed` / `failed` / `aborted`, or `no_rules`;
- promotion — `promoted` (into this chat, or queued for the conversation), `appended` (pi-loops wrote
  a queued result into the closed conversation), `redirected` (to the inbox: no window is open in the rule's project, and the rule has no
  conversation or its conversation's file is unknown or gone), `skipped` (no matched rule has `promote_to_chat`).

Rows of type `request` record what became of a row in `requests/<session>.jsonl` that did not end
in the conversation: `failed` (one delivery failed, pi refused the hand-over, or pi dropped it
unwritten; the row waits out a backoff, or is offered again), `dead` (three failures, or the
conversation's file is gone: it is a finding in the inbox now; never a person's message), `cancelled`,
`done` (a stop or cancel that acted: the turn aborted, or the queued row taken out), `stale` (a stop
or cancel with nothing to act on, a goal row without a goal, or a person's message whose
conversation is gone), `job-removed`, `refused` (the row's
`mode` is not the one its source gets, so a line edited in the file, or written by another version,
cannot widen what a turn may do; the row never runs). Two more come from the inbox in the browser
page: `claimed` (a finding was claimed from the page: its yes was queued in the lane the finding
names, or, when there is no lane to run it in, the yes is recorded and is not run; the trace id
is the finding's id) and `dismissed` (a
finding was dismissed from the page; the trace id is the finding's, and `details.reason` is what the
person gave, redacted, or null).

Rows of type `cron_control_plane` use the operation as the state instead: `add`, `set` (a
schedule changed in place by `/cron set --schedule` or by a suggestion applied from the page, with
`details.before_schedule` and `details.after_schedule`; an edit that leaves the schedule alone
writes none), `enable`, `disable`, `remove`. The page's and `/cron set`'s rows are in
`triggers-audit.jsonl` (source `page` or `slash`); the others are also session entries.

A proposed rule leaves `trigger` rows with the operation as the state too: `add` when the tool
proposes it (source `tool`), `enable` when the person sets it up, and `remove` when the person
cancels it (source `slash` or `page`).

A 5-minute identity window collapses repeated pushes with the same idempotency key: per project
for rule evaluation, per process for injected pushes. For rule evaluation it is read from
`events.jsonl` and the lane, so it holds across a restart.

```text
/triggers             this project's rules; the same as /triggers rules  (--all for every project)
/triggers status      rule counts, what checks them, the last check, push sources
/triggers sources     local checker + each MCP server: state, queued/dropped/deduped, tools
                      (/triggers hooks is the same view)
/triggers enable <id> /triggers disable <id> /triggers remove <id>   also --all | --all-projects
/triggers set <id>    --model | --thinking | --timeout: what the action runs with
/triggers run <id>    check one rule now, without waiting for its poll slot
/triggers running     sub-agents in flight (dynamic checks and cron runs)   /triggers abort <run|trace id>|--all
/triggers audit [N]
/triggers panel on|off
/triggers help        all of the above, in the terminal
```

Cron runs share this runtime's views: they appear in `/triggers running` and `/triggers audit`
and can be aborted by run id. A plain job's turn running in a closed conversation in the background
is stopped through a request (`stop` in `requests/<session>.jsonl`), which that process reads within
a tick whether or not its socket answers: `/triggers abort <run-id>` says `requested stop for
<run-id> (session <id>)`. Loop runs and checks, and `--all`, are asked of it over the socket as before.

`/triggers run <id>` writes a check row for that one rule in its project's check lane, and pi-loops
in the background runs it as it runs every check: audit, the check sub-agent, promotion. It skips
only the wait for the next poll, which is what running it now means. The poll interval is
unaffected: the next scheduled check happens when it would have anyway.

## Cycle safety

Cycles are bounded by a hop count: sub-agents run at hop 1 and still have
`cron_create`, `cron_list`, `set_cron_job_state`, `list_triggers` and `set_trigger_state`, so a
trigger action can schedule a job; they never run the trigger runtime, so nothing nests.
`new_trigger`, `remove_trigger` and `cron_remove` are not offered at hop 1: every call of each
needs a person, and a sub-agent has nobody to ask. The other
prompt-class operations — re-enabling a trigger or a cron job — are denied fail-closed in
sub-agents (no control-plane prompt channel there). `cron_create` works there, and so does disabling a job of the sub-agent's own
project; the control-plane audit records `actor: sub-agent`. Re-enabling a job and
touching another project's job are denied there like the other prompt-class operations. Sub-agents never handle triggers themselves: they ignore MCP pushes, and a sub-agent
session never acts on a trigger at all, so the bound is structural.

## Command output, approvals, promotion

`/triggers enable|disable <id>` prints the rule's state, condition and action (and the
fire-once note); `/triggers sources` lists MCP servers, the cron hook and the dynamic
checker in registration order with a `Sources: N, M connected, K need attention` summary in
`/triggers status` (the last part only when K is not 0). Errors are worded once and kept that way (`unknown /triggers command:
…`, `usage: /triggers remove <id>|--all`, `/new-trigger` parse messages). `/triggers remove --all`
clears this project's rules; `--all-projects` is the explicit machine-wide sweep.

Prompt-class tool calls (`remove_trigger`, re-enabling a trigger or a cron job)
show an approval card — Action, Tool, a value-free Reason, an args hash and a redacted
Preview — and leave `approval required` / `approved` / `denied` lines in the feed. Promoted
results and injected summaries are inserted as `[Trigger <trace>] <text>`, with no extra
wrapper; an inject-and-run turn announces itself with
`running triggered turn (trace …)`.
