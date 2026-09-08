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

## Evaluation

While at least one enabled rule exists, every `poll_interval_secs` (default 600; `--trigger-poll-secs`
or `config.toml`) the timer owner starts one sub-agent per project that has rules. It receives the
event JSON and every enabled rule and is told to inspect the filesystem, commands, clock or network
as needed, execute the actions of matching rules, and reply `matched dyn-…` or exactly
`no dynamic trigger rule matched`. Matched fire-once rules are disabled with `fired_at`.

Pushed MCP notifications (see [mcp.md](mcp.md)) enter the same runtime and are evaluated against
the rules unless the server is configured as an `inject_summary` / `inject_and_run` feed.

## Promotion and audit

A matched rule with `promote_to_chat` inserts `[Trigger <trace>] <source> fired <event>.\nResult: …`
into the chat context (visible to future turns, no extra model turn). Every trigger leaves audit
records (`accepted`, `deduped`, `running`, `completed` / `failed` / `aborted`, `promoted` /
`skipped`) in `triggers-audit.jsonl`; `/triggers audit [N]` shows them with decisions and
transcript paths. A 5-minute dedup window collapses repeated events with the same idempotency key.

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

pie suppresses trigger cycles by counting trace hops. pi-loops makes cycles impossible instead:
sub-agents (loop runs, dynamic checks) do not register the cron and trigger tools, so an action
cannot create another trigger.
