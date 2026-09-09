# Troubleshooting

**Nothing fires.** `/cron scheduler`: is this process the timer owner or standby? If the owner died
without cleanup, a standby takes over within 90 seconds. Jobs show `next …` when enabled. A plain
job marked `[dormant …]` only fires in the session that created it (`--resume` it); a loop marked
`[orphan: cwd missing]` was disabled because its checkout is gone.

**A run failed.** `/cron runs` shows the error; `/cron trace <job> 1` shows the sub-agent's
transcript; `pi --session <file>` resumes it. Sub-agents run inside your interactive pi with its
credentials, tools and MCP servers; they cannot answer permission prompts (use `--tools` to restrict).

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
daily schedules for anything that is not a test. `/cron cost` adds up the run log;
`[limits] daily_budget_usd` stops dispatching once the day reaches it, and says so on the job. It
also stops a run that is already going when its own cost would carry the day past the cap — that
run is recorded as aborted rather than failed, so the slot is still owed and the job's failure
streak is untouched; it simply will not be dispatched again until the day rolls over or the cap is
raised.

**`pi-loops host status` says the host "is not answering" but it is running.** Before 0.4.0 this
happened whenever `PI_LOOPS_DIR` was deep: a unix socket path is capped at 108 bytes, so
`<dir>/host.sock` failed to bind and the control channel silently did not exist. It now falls back
to a short path under a per-user directory in the temp directory. If you still see it, the host is
genuinely wedged — `host.log` has its last line, and `pi-loops host stop` escalates to SIGTERM.

**A host is running that you did not start.** That is the design: the last interactive pi to quit
hands the clock to a headless host when there is work for it (an enabled loop or rule for this
machine, or an MCP server that pushes). `pi-loops host status` says what it is doing and what it
has spent; `pi-loops host stop` ends it; `[host] auto = false` stops the hand-off happening at all.
After testing with a throwaway `PI_LOOPS_DIR`, remember that the host it spawned outlives the pi
that spawned it — it is polling and billing against *that* directory until stopped.

**The browser front end refuses a slash command.** `examples/pi-web.mjs` drives `pi --mode rpc`,
where pi's own built-in commands do not exist — only extension commands and skills do. Typing one
is refused with a pointer to the button that does the same thing rather than being passed to the
model as text. `/login` is the one with no equivalent at all: log in once with `pi` in a terminal,
then start the front end.
