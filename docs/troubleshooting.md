# Troubleshooting

**Nothing fires.** `/cron scheduler`: is this process the timer owner or standby? If the owner died
without cleanup, a standby takes over within 90 seconds. Jobs show `next …` when enabled. A plain
job marked `[dormant …]` only fires in the session that created it (`--resume` it); a loop marked
`[orphan: cwd missing]` was disabled because its checkout is gone.

**A run failed.** `/cron runs` shows the error; `/cron trace <job> 1` shows the sub-agent's
transcript; `pi --session <file>` resumes it. Sub-agents are `pi -p` processes: they need the same
credentials as your interactive pi and cannot answer permission prompts (use `--tools` to restrict).

**Findings never arrive.** The loop must end its reply with `<inbox>…</inbox>` tags; check
`/cron trace`. Quiet runs are normal. With `--verify`, dropped findings and reasons are on the run
card and in `/cron trace <job> 1 checker`.

**Duplicate commands (`/cron:1`).** The package is registered twice (e.g. once under `extensions`
and once under `packages` in `~/.pi/agent/settings.json`). Keep one entry.

**MCP server shows `disconnected` / `auth_failed`.** `/triggers sources` has the last error.
Bearer tokens come from `$TOKEN_REF` or pi's credential store; endpoints must be https except
127.0.0.1. Custom notifications without `_meta.pie_dedup_key` are dropped and counted.

**Hooks do not run.** Startup warnings list malformed rules. Project hooks need
`allow_project_hooks = true`. Hooks fire only in the interactive pi, not in sub-agents.

**`/session-export` says the session is ephemeral.** pi writes the session file after the first
message; `--no-session` sessions cannot be exported.

**Costs.** A stateful run is one sub-agent call (~$0.04 with gpt-5.5); `--verify` adds a second;
a dynamic check runs only while enabled rules exist. `every 1m` loops add up — prefer hourly or
daily schedules for anything that is not a test.
