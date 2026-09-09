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
  `cwd = "pie"` runs the command in `~/.pi/agent/loops` (pie: `~/.pie`).
- Webhooks receive `Content-Type: application/json` with pie's payload: every field is always
  present, `null` when it does not apply. `message_kind` is `user` | `assistant` | `tool_result`
  | the custom message's type. Summaries are truncated to 2000 characters and not redacted (they
  are your own scripts).

  ```json
  {"event": "tool_end", "session_id": "…", "cwd": "/path/to/repo", "model_provider": "openai",
   "model_id": "gpt-5.5", "thinking_level": "off", "source": "user", "message_kind": null,
   "message_summary": null, "assistant_event": null, "tool_call_id": "call_…", "tool_name": "bash",
   "tool_is_error": false, "tool_args": {"command": "ls"}, "tool_result_summary": "…",
   "compaction_trigger": null, "compaction_tokens_before": null, "compaction_summary": null}
  ```

- `message_update` fires for every streamed delta; use it only when you really need
  streaming-level callbacks. `compaction` carries a truncated summary of your conversation
  (`compaction_trigger` = `auto` | `manual`, `compaction_tokens_before`); send it only to
  destinations you trust.
- Rules for one event run sequentially in file order and are awaited inline like pie's listener, so
  a hook always finishes before the agent moves on and nothing is lost at exit. `[hooks] mode =
  "async"` in `config.toml` queues them off the turn instead (then shutdown waits up to 3 seconds).
  A timeout or Ctrl-C kills the whole process tree. Failures warn (or are ignored per rule) and never
  fail a turn.
- A malformed rule is skipped with a diagnostic; the rest of the file still loads. Project hooks
  (`<project>/.pi/hooks.toml`, or pie's `<project>/.pie/hooks.toml`) are ignored unless allowed.
  Without a UI (`pi -p`) hook failures go to stderr.
- Sub-agent sessions do not fire hooks; only the session you are talking to does.
