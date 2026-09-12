# Lifecycle hooks

`~/.pi/agent/loops/hooks.toml`; a
`hooks.toml` works verbatim.

```toml
allow_project_hooks = false        # also: config.toml, or PI_ALLOW_PROJECT_HOOKS=1

[[hook]]
event = "tool_end"                  # agent_start agent_end run_start run_end turn_start turn_end
tool = "bash"                       # message_start message_update message_end tool_start tool_update tool_end compaction
command = "echo \"$PI_TOOL_NAME error=$PI_TOOL_IS_ERROR\" >> ~/tool-hooks.log"
timeout_ms = 3000                   # default 5000
cwd = "project"                     # project | loops | home
on_failure = "warn"                 # warn | ignore

[[hook]]
event = "turn_end"
webhook = "https://example.com/hooks"
[hook.headers]
Authorization = "Bearer your-token"
```

- Commands run through `sh -c` with `PI_*` variables (`HOOK_EVENT`, `HOOK_PAYLOAD`
  → path of a JSON file, `SESSION_ID`, `CWD`, `MODEL_PROVIDER`, `MODEL_ID`, `THINKING_LEVEL`,
  `MESSAGE_KIND`, `ASSISTANT_EVENT`, `TOOL_CALL_ID`, `TOOL_NAME`, `TOOL_IS_ERROR`,
  `COMPACTION_TRIGGER`, `COMPACTION_TOKENS_BEFORE`, `COMPACTION_FAILED`), set only when they have
  a value. `cwd = "loops"` runs the command in `~/.pi/agent/loops`.
- What a hook prints on **stdout** is written to this process's log, `~/.pi/agent/loops/logs/pi-<pid>.log`,
  as `hook <source> <event>: <output>` — redacted and rotated like everything else there, and cut
  off after 4000 characters so a chatty hook cannot rotate away the night's history. `echo` and
  read the file is the usual way to find out what a hook did. stderr is still kept for the failure
  message only. The headless host does the same into `host.log`, which is where the question is
  usually asked.
- Webhooks receive `Content-Type: application/json` with a payload whose every field is always
  present, `null` when it does not apply. `message_kind` is `user` | `assistant` | `tool_result`
  | the custom message's type. Summaries are truncated to 2000 characters and not redacted (they
  are your own scripts).

  ```json
  {"event": "tool_end", "session_id": "…", "cwd": "/path/to/repo", "model_provider": "openai",
   "model_id": "gpt-5.5", "thinking_level": "off", "source": "user", "message_kind": null,
   "message_summary": null, "assistant_event": null, "tool_call_id": "call_…", "tool_name": "bash",
   "tool_is_error": false, "tool_args": {"command": "ls"}, "tool_result_summary": "…",
   "compaction_trigger": null, "compaction_tokens_before": null, "compaction_summary": null,
   "compaction_failed": null}
  ```

- `message_update` fires for every streamed delta; use it only when you really need
  streaming-level callbacks. `compaction` carries a truncated summary of your conversation
  (`compaction_trigger` = `auto` | `manual`, `compaction_tokens_before`); send it only to
  destinations you trust.
- `compaction` also fires when a compaction **failed or was cancelled**, with
  `compaction_failed: true` (`$PI_COMPACTION_FAILED`) and no summary or token count — nothing was
  written. This is the case a watcher most wants: a session
  that cannot compact is a session about to fail on context length. A hook that only cares about
  successful compactions should test it:

  ```toml
  [[hook]]
  event = "compaction"
  command = 'if [ "$PI_COMPACTION_FAILED" = true ]; then notify-send "compaction failed" "$PI_SESSION_ID"; fi'
  ```
- Rules for one event run sequentially in file order and are awaited inline, so
  a hook always finishes before the agent moves on and nothing is lost at exit. `[hooks] mode =
  "async"` in `config.toml` queues them off the turn instead (then shutdown waits up to 3 seconds).
  A timeout or Ctrl-C kills the whole process tree. Failures warn (or are ignored per rule) and never
  fail a turn.
- A malformed rule is skipped with a diagnostic; the rest of the file still loads. Project hooks
  (`<project>/.pi/hooks.toml`) are ignored unless allowed.
  Without a UI (`pi -p`) hook failures go to stderr.

## Exactly when hooks fire

- **`agent_*`, `turn_*`, `message_*`, `tool_*` and `compaction` are about a conversation.** The pi
  you are talking to fires them. Sub-agent sessions — loop runs, checkers, trigger checks — fire
  nothing: they are not the session you are in.
- **`run_start` and `run_end` are about a scheduled run**, and they fire wherever the run happens:
  in the pi you are talking to, and in the headless host ([loops.md](loops.md)). Whether a 3am job
  ran under a host or under a pi you left open is an accident of who held the clock, and a hook rule
  should not be able to tell.

  They exist because a scheduled run is not a turn. It happens with no conversation at all, or
  beside one — and overloading `agent_*` would mean a rule you wrote about your own turns quietly
  started firing for automation.

  Dynamic trigger checks and MCP pushes fire no hooks: they poll, and a hook on every poll is noise,
  not news.
- The `run_*` payload describes the run. Alongside the usual fields it carries `run_job` (the job's
  name or id), `run_id`, and on `run_end` also `run_ok`, `run_findings`, `run_error` and
  `run_cost_usd` — each as `$PI_RUN_JOB`, `$PI_RUN_OK` and so on. So "tell me when a loop fails" is:

  ```toml
  [[hook]]
  event = "run_end"
  command = '[ "$PI_RUN_OK" = false ] && notify-send "loop $PI_RUN_JOB failed" "$PI_RUN_ERROR"'
  ```

  In the host, where there is no conversation, `session_id` is the run id and `cwd` — including any
  `cwd = "project"` rule — is the job's directory.

- `run_*` hooks are always queued off the run, whatever `[hooks] mode` says, in both processes — a
  webhook that hangs must not hold up the clock, and the run it announces has already started or
  already finished. `mode = "sync"` is about ordering within a conversation turn, and a run is not
  one. The host drains for up to 3 seconds when it exits. Failures go to the host log,
  `~/.pi/agent/loops/host.log`.

- Project hooks in the host additionally need the job's cwd to be a directory you trusted in pi
  (that exact directory, not an ancestor): a job's cwd can be chosen by a model, and nobody is
  there to answer a trust prompt.
