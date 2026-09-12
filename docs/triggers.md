# Dynamic triggers

## Rules

A rule is a natural-language **condition** and **action**:

```text
/new-trigger when ~/build.done exists, run cargo test and show me the result
/new-trigger 当 $HOME/helloworld 存在的时候，打印它的内容
```

`/new-trigger` asks the agent to extract condition and action and call the `new_trigger` tool
(the agent may also do this from ordinary chat). Rules **fire once** by default (`fire_once=false`
for repeating), and their output stays in the TUI and audit unless `promote_to_chat` is set.
Time-based requests ("every hour", "daily", "定时任务") are refused and routed to `cron_create`.

Tools: `new_trigger` (condition, action, spec, fire_once, promote_to_chat), `list_triggers`,
`remove_trigger` (id | all), `set_trigger_state`. Creating, removing and re-enabling ask the user to
confirm, with `ctx.ui.confirm`.

The model-facing tools see the calling project only: `list_triggers` takes `all_projects: true`
when the user asks about the rest, and `remove_trigger { all: true }` clears this project's rules,
never the machine's.

## Evaluation

While at least one enabled rule exists, every `poll_interval_secs` (default 600; `--trigger-poll-secs`
or `config.toml`) one sub-agent per project that has rules is started — by a pi open in that project
(the session that created the rules if it is open, otherwise the lowest pid there), or by the
machine leader when no pi is open in the project. The check receives the
event JSON and every enabled rule and is told to inspect the filesystem, commands, clock or network
as needed, execute the actions of matching rules, and reply `matched dyn-…` or exactly
`no dynamic trigger rule matched`. Matched fire-once rules are disabled with `fired_at`.

Pushed MCP notifications (see [mcp.md](mcp.md)) enter the same runtime and are evaluated against
the rules unless the server is configured as an `inject_summary` / `inject_and_run` feed.

A rule whose check keeps failing is polled with a widening gap instead of at every interval: after
three failed checks in a row the rule waits 5 minutes, then 10, 20, … up to 6 hours (the scheduler's
job backoff, same numbers — literally the same function, `backoffWaitMs` in `src/schedule.ts`).
The count lives on the rule (`consecutive_failures`,
`last_check_failed_at`), a check that completes clears it — including `/triggers run <id>`, which is
the way to retry a backed-off rule now — and entering the backoff is audited as `backoff` with the
rule ids and the failure count. Pushes are unaffected: an event is worth one attempt.

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

A matched rule with `promote_to_chat` inserts `[Trigger <trace>] <result>` into the chat context
of the pi that ran the check (visible to future turns; no model call when idle, a follow-up turn
when the agent was busy). Because checks run in the rule's project, that is the right chat; only
when no pi is open there does the result go to the inbox (`redirected`). One check evaluates every
rule of the project at once, so it runs under **one** model: the first rule that has one recorded
(`/triggers set <id> --model … | -`), and that rule's thinking level with it — a thinking level
belongs to the model it was chosen for, and a rule with a model but no level falls back to the
running session's. Pin the model on the rule you want to decide it, or on all of them. The timeout is
the longest of the project's rules (`--timeout`), else `[triggers] run_timeout_secs`. Every trigger leaves audit records in `triggers-audit.jsonl` and as
session entries (`trigger`, `trigger_result`, `trigger_promotion`); `/triggers audit [N] [--all]`
shows this project's rows with decisions and transcript paths. The complete set of states:

- admission — `accepted`, `deduped`, `deferred` (no slot, or handed to the pi that owns the rules),
  `taken_over` (the owner did not claim it), `dropped` (the held list was full), `budget_exceeded`,
  `cycle_suppressed` (it reached a sub-agent), `backoff`, `disabled` (the rule's project is gone);
- the run — `running`, then `completed` / `failed` / `aborted`, or `no_rules`;
- promotion — `promoted`, `redirected` (to the inbox: no pi open in that project), `skipped` (no
  matched rule has `promote_to_chat`).

Rows of type `cron_control_plane` use the operation as the state instead: `add`, `enable`,
`disable`, `remove`.

A 5-minute dedup window collapses repeated events with the same idempotency key (per project for
rule evaluation, per window for injected pushes).

```text
/triggers status      rule counts, checker ownership, last check, push sources
/triggers rules       this project's rules  (--all for every project)
/triggers sources     local checker + each MCP server: state, queued/dropped/deduped, tools
/triggers run <id>    check one rule now, without waiting for its poll slot
/triggers running     sub-agents in flight (dynamic checks and cron runs)   /triggers abort <trace>|--all
/triggers audit [N]
/triggers panel on|off
```

Cron runs share this runtime's views: they appear in `/triggers running` and `/triggers audit`
and can be aborted by run id.

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
