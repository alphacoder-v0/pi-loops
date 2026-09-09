# Dynamic triggers

Mirrors pie's `triggers/dynamic.rs` and the trigger runtime in its `agent` crate.

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
confirm — pie's `Prompt` permission class, implemented with `ctx.ui.confirm`.

The model-facing tools see the calling project only, the way pie's per-session sidecar contains
them; `list_triggers` takes `all_projects: true` when the user asks about the rest, and
`remove_trigger { all: true }` clears this project's rules, never the machine's.

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
job backoff, same numbers). The count lives on the rule (`consecutive_failures`,
`last_check_failed_at`), a check that completes clears it — including `/triggers run <id>`, which is
the way to retry a backed-off rule now — and entering the backoff is audited as `backoff` with the
rule ids and the failure count. Pushes are unaffected: an event is worth one attempt.

## What happens when the machine is busy or over budget

A trigger that finds every check slot taken (`max_concurrent`, default 3) or the day over
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
when no pi is open there does the result go to the inbox (`redirected`). Checks run with the model
recorded on the rule (`/triggers set <id> --model … | -`), capped by `[triggers] run_timeout_secs`
or the rule's `--timeout`. Every trigger leaves audit records (`accepted`, `deduped`, `deferred`,
`dropped`, `backoff`, `running`, `completed` / `failed` / `aborted`, `promoted` / `skipped`) in `triggers-audit.jsonl`
and as session entries (`trigger`, `trigger_result`, `trigger_promotion`) like pie; `/triggers audit
[N] [--all]` shows this project's rows with decisions and transcript paths. A 5-minute dedup window
collapses repeated events with the same idempotency key (per project for rule evaluation, per
window for injected pushes).

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

Like pie, cycles are bounded by a hop count: sub-agents run at hop 1 and still have the
cron/trigger tools, so a trigger action can schedule a job; they never run the trigger runtime, so
nothing nests. Prompt-class operations — creating or removing a trigger,
re-enabling a trigger or a cron job — are denied fail-closed in sub-agents (pie: no control-plane
prompt channel there); `cron_create` and `cron_remove` work and the control-plane audit records
`actor: sub-agent`. Sub-agents never handle triggers themselves: they ignore MCP pushes, and the
runtime audits anything reaching hop ≥ 1 as `cycle_suppressed` (pie's label; pie counts hops per
trace up to 5, pi-loops simply never lets a sub-agent session act on a trigger).

## Command output, approvals, promotion

`/triggers enable|disable <id>` prints the rule's state, condition and action (and the
fire-once note) like pie; `/triggers sources` lists MCP servers, the cron hook and the dynamic
checker in pie's registration order with pie's `sources: N total, M connected, K require
attention` summary in `/triggers status`. Errors use pie's wording (`unknown /triggers command:
…`, `usage: /triggers remove <id>|--all`, `/new-trigger` parse messages). `/triggers remove --all`
clears this project's rules; `--all-projects` is the explicit machine-wide sweep.

Prompt-class tool calls (`new_trigger`, `remove_trigger`, re-enabling a trigger or a cron job)
show pie's approval card — Action, Tool, a value-free Reason, an args hash and a redacted
Preview — and leave `approval required` / `approved` / `denied` lines in the feed. Promoted
results and injected summaries are inserted as `[Trigger <trace>] <text>` exactly as pie's
engine does (no extra wrapper); an inject-and-run turn announces itself with
`running triggered turn (trace …)`.
