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

## Promotion and audit

A matched rule with `promote_to_chat` inserts `[Trigger <trace>] <result>` into the chat context
of the pi that ran the check (visible to future turns; no model call when idle, a follow-up turn
when the agent was busy). Because checks run in the rule's project, that is the right chat; only
when no pi is open there does the result go to the inbox (`redirected`). Checks run with the model
recorded on the rule (`/triggers set <id> --model … | -`), capped by `[triggers] run_timeout_secs`
or the rule's `--timeout`. Every trigger leaves audit records (`accepted`, `deduped`, `deferred`,
`running`, `completed` / `failed` / `aborted`, `promoted` / `skipped`) in `triggers-audit.jsonl`
and as session entries (`trigger`, `trigger_result`, `trigger_promotion`) like pie; `/triggers audit
[N] [--all]` shows this project's rows with decisions and transcript paths. A 5-minute dedup window
collapses repeated events with the same idempotency key (per project for rule evaluation, per
window for injected pushes).

```text
/triggers status      rule counts, checker ownership, last check, push sources
/triggers rules       this project's rules  (--all for every project)
/triggers sources     local checker + each MCP server: state, queued/dropped/deduped, tools
/triggers running     sub-agents in flight (dynamic checks and cron runs)   /triggers abort <trace>|--all
/triggers audit [N]
/triggers panel on|off
```

Cron runs share this runtime's views: they appear in `/triggers running` and `/triggers audit`
and can be aborted by run id.

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
