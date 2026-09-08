# Design

## What pie's pieces map onto

| pie | pi-loops |
|---|---|
| in-process timer in the runtime | `setInterval` started in `session_start`, cleared in `session_shutdown` |
| cron `InjectAndRun` | `pi.sendUserMessage` (followUp when busy), `[Trigger <id>] ` prefix |
| cron `SubAgent` / dynamic-rule sub-agent | `pi -p --mode json --session-dir …` child process, model/thinking inherited |
| session sidecars (`.cron.toml`, `.triggers.json`, `.loop-*.md`) | `jobs.json`, `triggers.json`, `state/<id>.md` under `~/.pi/agent/loops` |
| `cron_control_plane` / trigger audit as session custom entries | `pi.appendEntry` for cron control ops; `triggers-audit.jsonl` for trigger runs |
| TUI feed lines and right rail | transcript cards via `pi.appendEntry` + entry renderer; widget above the editor; footer badge via `ctx.ui.setStatus` |
| `PermissionClassification::Prompt` on tools | `ctx.ui.confirm` inside the tool |
| MCP client crate | `src/mcp.ts` |
| `hooks.rs` | `src/hooks.ts` |
| `session_archive.rs` | `src/archive.ts` |

## Deliberate differences from pie

1. **Machine-global jobs and rules** with a `cwd`, instead of session-scoped sidecars. Any pi
   process can run them; `/cron` and `/triggers rules` show the current project by default.
   Consequences that are handled: a plain (inject) job whose session is not open is listed as
   `[dormant: session … not open here]`; a stateful job whose `cwd` disappeared (deleted worktree)
   is disabled automatically with `[orphan: cwd missing]` instead of failing every tick.
2. **Leader election.** One process owns the timer (`scheduler.json`, pid + heartbeat); others
   stand by and take over. Because the runner may not be the creator, every job and rule records
   the **model and thinking level of the session that created it** and runs with those, not with
   whatever the timer owner happens to use (`--model` still overrides).
3. **Promotion stays in the right project.** A `promote_to_chat` result or an `inject_*` feed is
   inserted into the chat only if the process handling it is in the rule's `cwd`; otherwise the
   finding goes to the inbox and the audit says `redirected`. pie cannot cross projects because it
   is session-scoped; pi-loops reaches the same guarantee by routing.
4. **Every process consumes MCP pushes it receives**, and a machine-wide dedup window
   (`dedup.json`, 5 minutes) makes each push count once. Project-level servers are therefore
   handled by the pi that is in that project.
5. **Catch-up.** A tick missed while no pi was running is fired once at startup for stateful
   loops; plain inject jobs do not catch up (pie never backfills either) unless `--catchup`.
   A run that died with its process is retried, not skipped.
6. **No expiry.** Jobs exist until removed.
7. **8 KB prompts** (pie 4 KB); ids extracted from the full sub-agent reply (pie caps the summary at 4 KiB first).
8. **Cycle suppression by hop count, like pie:** sub-agents get `PI_LOOPS_HOP = parent + 1` and
   keep the cron/trigger tools while the hop is below 2, so a trigger action may schedule a job;
   deeper levels get no such tools. In sub-agents these tools do not ask for confirmation (there
   is no UI); the control-plane audit records `actor: sub-agent`.
9. **Hooks never block the agent** (sequential per event, queued); `session_shutdown` waits up
   to 3 seconds for the queue. pie awaits hooks inline.
10. **Stdio MCP servers reconnect** with backoff (20 attempts by default), reporting each distinct
    error once; pie marks them disconnected.

## Known costs of the process-isolation design

- Each loop run and trigger check is a fresh `pi -p` process: it starts pi, loads extensions and
  skills, and **spawns every configured stdio MCP server again**. pie's sub-agents share the
  parent's MCP clients. Stateful servers (browsers, database connections) start cold every run;
  use `--tools` to keep them out of loops that do not need them.
- Sub-agents cannot answer permission prompts; project-local resources in an untrusted `--cwd`
  are not loaded there.
- Opening any pi fires every loop on the machine whose tick was missed, at once (3 in parallel).
  That is the catch-up you asked for, but it costs a model call per loop.

## What it cannot do

Run with no pi open. The timer lives in a pi process. Keep one pi in tmux, or wrap `pi -p` in a
systemd timer for long unattended schedules.
