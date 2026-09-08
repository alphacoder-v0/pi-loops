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
2. **Leader election.** One process owns the timer (`scheduler.json`, pid + heartbeat); others
   stand by and take over. MCP notifications are consumed by the leader only.
3. **Catch-up.** A tick missed while no pi was running is fired once at startup. pie never
   backfills. `--no-catchup` restores pie's behavior per job.
4. **No expiry.** Jobs exist until removed.
5. **8 KB prompts** (pie 4 KB); ids extracted from the full sub-agent reply (pie caps the summary at 4 KiB first).
6. **Cycle safety by construction** (sub-agents lack the cron/trigger tools) instead of hop counting.
7. **Hooks never block the agent** (sequential per event, queued); pie's agent listener awaits them.
8. **Stdio MCP servers reconnect** with backoff; pie marks them disconnected.

## What it cannot do

Run with no pi open. The timer lives in a pi process. Keep one pi in tmux, or wrap `pi -p` in a
systemd timer for long unattended schedules.
