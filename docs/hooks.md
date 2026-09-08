# Lifecycle hooks

`~/.pi/agent/loops/hooks.toml`, same format and events as pie's `docs/hooks.md`; a pie
`hooks.toml` works verbatim.

```toml
allow_project_hooks = false        # also: config.toml, or PI_ALLOW_PROJECT_HOOKS=1

[[hook]]
event = "tool_end"                  # agent_start agent_end turn_start turn_end message_start
tool = "bash"                       # message_update message_end tool_start tool_update tool_end compaction
command = "echo \"$PI_TOOL_NAME error=$PI_TOOL_IS_ERROR\" >> ~/tool-hooks.log"
timeout_ms = 3000                   # default 5000
cwd = "project"                     # project | pie | home
on_failure = "warn"                 # warn | ignore

[[hook]]
event = "turn_end"
webhook = "https://example.com/hooks"
[hook.headers]
Authorization = "Bearer your-token"
```

- Commands run through `sh -c` with `PI_*` **and** `PIE_*` variables (`HOOK_EVENT`, `HOOK_PAYLOAD`
  → path of a JSON file, `SESSION_ID`, `CWD`, `MODEL_PROVIDER`, `MODEL_ID`, `THINKING_LEVEL`,
  `MESSAGE_KIND`, `ASSISTANT_EVENT`, `TOOL_CALL_ID`, `TOOL_NAME`, `TOOL_IS_ERROR`,
  `COMPACTION_TRIGGER`, `COMPACTION_TOKENS_BEFORE`), set only when they have a value.
- Webhooks receive `Content-Type: application/json` with pie's payload fields (`event`, `session_id`,
  `cwd`, `model_provider`, `model_id`, `thinking_level`, `source`, `message_kind`, `message_summary`,
  `assistant_event`, `tool_call_id`, `tool_name`, `tool_is_error`, `tool_args`, `tool_result_summary`,
  `compaction_trigger`, `compaction_tokens_before`, `compaction_summary`). Summaries are truncated to
  2000 characters and not redacted (they are your own scripts).
- Rules for one event run sequentially in file order, never blocking the agent. A timeout or Ctrl-C
  kills the whole process tree. Failures warn (or are ignored per rule) and never fail a turn.
- A malformed rule is skipped with a diagnostic; the rest of the file still loads. Project hooks
  (`<project>/.pi/hooks.toml`) are ignored unless allowed.
- Sub-agent processes do not fire hooks; only the pi you are talking to does.
