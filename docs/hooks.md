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

## Exactly when hooks fire

- **The pi you are talking to** fires the whole event list. Sub-agent sessions — loop runs,
  checkers, trigger checks — fire nothing: they are not the session you are in.
- **The headless host** ([loops.md](loops.md)) has no conversation, so a *run* is its agent. It
  fires `agent_start` when a scheduled loop run starts and `agent_end` when that run finishes, and
  nothing else: `turn_*`, `message_*`, `tool_*` and `compaction` describe the inside of a
  conversation the host does not watch. Dynamic trigger checks and MCP pushes fire no hooks — they
  poll, and a hook on every poll is noise, not news.
- For those two host events the payload is about the run, not about a chat: `session_id` is the run
  id (the same on its `agent_start` and its `agent_end`), `cwd` — and any `cwd = "project"` rule —
  is the job's directory, `model_*` is the model the run uses, and

  | | `message_kind` | `message_summary` |
  |---|---|---|
  | run started | `loop_run` | `<loop>: <prompt>` |
  | run finished | `loop_run_ok` | `<loop>: ok · N finding(s)` |
  | run failed | `loop_run_failed` | `<loop>: failed: <error>` |

  so `$PI_MESSAGE_KIND` alone answers "did last night's loop fail":

  ```toml
  [[hook]]
  event = "agent_end"
  command = 'case "$PI_MESSAGE_KIND" in *_failed) notify-send "a loop failed" "$(cat "$PI_HOOK_PAYLOAD")";; esac'
  ```

- The host always queues hooks off the run, whatever `[hooks] mode` says — a webhook that hangs
  must not hold up the loop it is announcing — and drains for up to 3 seconds when it exits.
  Project hooks additionally need the job's cwd to be a directory you trusted in pi (that exact
  directory, not an ancestor): a job's cwd can be chosen by a model, and nobody is there to answer
  a trust prompt. Failures go to the host log, `~/.pi/agent/loops/host.log`.
