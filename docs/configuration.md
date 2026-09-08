# Configuration

Everything lives under `~/.pi/agent/loops/` (override: `PI_LOOPS_DIR`).

| File | Purpose |
|---|---|
| `config.toml` | `[triggers] poll_interval_secs = 600`, `allow_project_hooks = false` |
| `mcp.toml` | MCP servers — see [mcp.md](mcp.md) |
| `hooks.toml` | lifecycle hooks — see [hooks.md](hooks.md) |
| `ui.json` | `{"panel": true}` — written by `/cron panel on|off` |
| `jobs.json`, `triggers.json` | cron jobs and trigger rules (machine-global, each with a `cwd`) |
| `state/<id>.md` | loop notes; plain Markdown, editable |
| `inbox.jsonl` | the inbox |
| `runs.jsonl`, `triggers-audit.jsonl` | run log (rotated at 1 MB) and trigger audit (2 MB) |
| `sessions/<job-id>/`, `sessions/triggers/` | sub-agent transcripts (20 per job, 40 for checks) |
| `scheduler.json` | timer owner: pid, host, heartbeat |
| `dedup.json` | machine-wide trigger dedup window (5 minutes) |

Project-level: `<project>/.pi/mcp.toml` (trusted projects only) and `<project>/.pi/hooks.toml`
(when allowed).

## Flags and environment

| | |
|---|---|
| `--trigger-poll-secs <n>` | dynamic trigger poll interval for this run |
| `PI_LOOPS_DIR` | relocate the data directory |
| `PI_ALLOW_PROJECT_HOOKS=1` / `PIE_ALLOW_PROJECT_HOOKS=1` | allow project hooks |
| `PI_LOOPS_CHILD=1` | set on sub-agents by pi-loops; no scheduler and no hooks there |
| `PI_LOOPS_HOP=<n>` | trigger hop of a sub-agent (cycle suppression); cron/trigger tools exist while `n < 2` |
| `PI_LOOPS_PI_BIN` | which `pi` binary to spawn for sub-agents (defaults to the running one) |

## Per-job options (`/cron add`)

`--name`, `--cwd <dir>`, `--model provider/id`, `--thinking <level>`, `--tools a,b`
(allowlist for the sub-agent), `--timeout 20m` (default 15m), `--catchup` / `--no-catchup` (default: loops on, plain jobs off), `--stateful`,
`--verify`, `--checker-model provider/id`.
