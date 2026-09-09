# Configuration

Everything lives under `~/.pi/agent/loops/` (override: `PI_LOOPS_DIR`).

| File | Purpose |
|---|---|
| `config.toml` | `allow_project_hooks`, `[triggers] poll_interval_secs = 600` / `run_timeout_secs = 900`, `[cron] catch_up = true` / `max_concurrent_runs = 3`, `[hooks] mode = "sync"`, `[host] auto = true` |
| `mcp.toml` | MCP servers — see [mcp.md](mcp.md) |
| `hooks.toml` | lifecycle hooks — see [hooks.md](hooks.md) |
| `ui.json` | `{"panel": true}` — written by `/cron panel on|off` |
| `jobs.json`, `triggers.json` | cron jobs and trigger rules (machine-global, each with a `cwd`) |
| `state/<id>.md` | loop notes; plain Markdown, editable |
| `inbox.jsonl` | the inbox |
| `runs.jsonl`, `triggers-audit.jsonl` | run log (rotated at 1 MB) and trigger audit (2 MB) |
| `sessions/<job-id>/`, `sessions/triggers/` | sub-agent transcripts (20 per job, 40 for checks) |
| `scheduler.<host>.json` | timer owner on this host: pid, heartbeat |
| `presence/` | one file per live pi process: pid, session, cwd (who acts for which project) |
| `host.json`, `host.log` | the headless host that keeps the clock while no pi is open: pid, and its log |
| `polls.json` | last dynamic check per project (shared, so a hand-over never double-checks) |
| `dedup.json` | machine-wide trigger dedup window (5 minutes) |

Project-level: `<project>/.pi/mcp.toml` (trusted projects only) and `<project>/.pi/hooks.toml`
(when allowed); pie's `<project>/.pie/` names are read when the `.pi/` file is absent.
An invalid `[triggers] poll_interval_secs` (or `--trigger-poll-secs`) is reported at startup
and ignored, as in pie.

## Flags and environment

| | |
|---|---|
| `--trigger-poll-secs <n>` | dynamic trigger poll interval for this run |
| `PI_LOOPS_DIR` | relocate the data directory |
| `PI_ALLOW_PROJECT_HOOKS=1` / `PIE_ALLOW_PROJECT_HOOKS=1` | allow project hooks |
| `PI_LOOPS_HOST=1` | let a `pi -p` run host the timer for as long as it lives (the headless host below is the normal answer) |

## Per-job options (`/cron add`)

`--name`, `--cwd <dir>`, `--model provider/id`, `--thinking <level>`, `--tools a,b`
(allowlist for the sub-agent), `--timeout 20m` (default 15m), `--catchup` / `--no-catchup` (default: loops on, plain jobs off), `--stateful`,
`--verify`, `--checker-model provider/id`. Change model, thinking, timeout or name later with
`/cron set <id> …` (`-` = follow the running session). Sub-agents run inside the interactive pi
(pi's SDK) and share its live MCP servers, its `-e` extensions, system-prompt and skill flags, its
model unless the job pins one, and the project's trust when they run in the same project.
