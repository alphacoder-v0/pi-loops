# Configuration

Everything lives under `~/.pi/agent/loops/` (override: `PI_LOOPS_DIR`).

| File | Purpose |
|---|---|
| `config.toml` | `allow_project_hooks`, `[triggers] poll_interval_secs = 600` / `run_timeout_secs = 900`, `[cron] catch_up = true` / `max_concurrent_runs = 3`, `[hooks] mode = "sync"`, `[host] auto = true`, `[limits] daily_budget_usd = 0`, `[danger] allow = []` |
| `logs/pi-<pid>.log` | what each pi process diagnosed: jobs disabled, writes that failed, sub-agent warnings. Rotated at 2 MB, newest 5 processes kept |
| `mcp.toml` | MCP servers — see [mcp.md](mcp.md) |
| `hooks.toml` | lifecycle hooks — see [hooks.md](hooks.md) |
| `ui.json` | preferences that outlive a session: `panel` (written by `/cron panel on\|off`), and `model` / `thinking` — the last ones you chose in the browser front end, applied to the next session that does not say otherwise |
| `jobs.json`, `triggers.json` | cron jobs and trigger rules (machine-global, each with a `cwd`) |
| `state/<id>.md` | loop notes; plain Markdown, editable |
| `inbox.jsonl` | the inbox |
| `runs.jsonl`, `triggers-audit.jsonl` | run log (rotated at 1 MB) and trigger audit (2 MB) |
| `spend.json` | per-day totals of what rotation dropped from the run log, so a daily budget still counts it |
| `sessions/<job-id>/`, `sessions/triggers/` | sub-agent transcripts (20 per job, 40 for checks) |
| `scheduler.<host>.json` | timer owner on this host: pid, heartbeat |
| `presence/` | one file per live pi process: pid, session, cwd (who acts for which project) |
| `host.json`, `host.log` | the headless host that keeps the clock while no pi is open: pid, and its log |
| `polls.json` | last dynamic check per project (shared, so a hand-over never double-checks) |
| `dedup.json` | machine-wide trigger dedup window (5 minutes) |
| `web-token` | the browser front end's token, mode 0600. It lives in a file rather than being made per launch so the address stays the same one and a signed-in device stays signed in across restarts and upgrades. Delete it to sign every device out |

Project-level: `<project>/.pi/mcp.toml` (trusted projects only) and `<project>/.pi/hooks.toml`
(when allowed); pie's `<project>/.pie/` names are read when the `.pi/` file is absent.
An invalid `[triggers] poll_interval_secs` (or `--trigger-poll-secs`) is reported at startup
and ignored, as in pie.

## `[cron] max_concurrent_runs`

How many **sub-agents** this pi process may have in flight at once — not how many loop runs. Loop
runs, dynamic-trigger checks and trigger actions all draw on the same counter, because they are the
same thing to the machine: an in-process pi session, on your model, on your bill. With
`max_concurrent_runs = 3` you get at most three of them together, in any mix.

The count is per process. Two pi windows are two processes and two counters; nothing is
coordinated across them, because what the cap protects — this process's memory, sockets and
in-flight requests — is not shared either.

What a refusal means differs by pipeline, on purpose:

- a **loop run** is deferred, not skipped: the tick stays owed, `/cron list` shows
  `deferred: N sub-agent(s) already in flight`, and the next tick tries again;
- an **MCP push** is held (up to 32) and retried on the next tick, because no server sends the same
  event twice;
- a **periodic trigger check** is dropped, because the next poll asks the same question of a world
  that has moved on.

Two kinds of sub-agent **count against the cap but are never refused a slot**: `/cron run`, and the
`/goal` evaluator. Both are things you asked for directly — the evaluator runs after every turn of a
session that has a goal, one at a time, and a busy machine quietly declining to evaluate would be
indistinguishable from a goal that was never set. They can therefore take the total past the limit,
which is why the in-flight count is reported against it (`4 of 3 slots in use`) rather than assumed
to be under it. If you have a goal running and want headroom for it, size the setting one higher.

## Flags and environment

| | |
|---|---|
| `--trigger-poll-secs <n>` | dynamic trigger poll interval for this run |
| `PI_LOOPS_DIR` | relocate the data directory |
| `PI_WEB_TOKEN` | use this instead of the token in `web-token`. Letters, digits, `-` and `_`, at least 8 of them: it is substituted into a JavaScript string in the page, and a quote there would end the string early |
| `PI_ALLOW_PROJECT_HOOKS=1` / `PIE_ALLOW_PROJECT_HOOKS=1` | allow project hooks |
| `PI_LOOPS_HOST=1` | let a `pi -p` run host the timer for as long as it lives (the headless host below is the normal answer) |

## What is remembered between sessions

A session opens on pi's default model, so choosing the same one every morning was the first thing
the browser front end asked of anybody. Changing the model or the thinking level there records it in
`ui.json`, and `pi-loops` applies it when it starts the next session — the terminal window too,
since the launcher is what applies it.

It is not applied when you said which model yourself (`pi-loops --model …`), and not when the
session already has one: `--continue`, `--resume`, `--session` and `--session-id` keep the model
their conversation was had with. Delete the keys from `ui.json` to go back to pi's default.

## The browser front end

`pi-loops` takes these for itself and passes everything else to pi. Full explanation in
[cli.md](cli.md); this is the list.

| | |
|---|---|
| `--web` / `--tui` | which window, when the guess is wrong |
| `--port <n>` | default 4173, fixed on purpose so the address is worth bookmarking |
| `--host <addr>` | bind somewhere other than loopback, so a phone on the same network can reach it. Prints the addresses it can be reached on, and says that they are unencrypted |
| `--allow-host <name,…>` | accept these values in the `Host` header, for a reverse proxy in front. A name resolved by public DNS puts the token back in charge of keeping strangers out |
| `--no-auth` | no token and no cookie. Loopback only, whatever route a request took, and refused outright with `--host` |
| `--no-open` | do not open a browser |
| `--loops-dir <dir>` | the same thing `PI_LOOPS_DIR` does |

Tailnet names (`*.ts.net`) are accepted from a tailnet connection without `--allow-host`, which is
what makes `tailscale serve --bg 4173` work with the server still on loopback.

## Per-job options (`/cron add`)

`--name`, `--cwd <dir>`, `--model provider/id`, `--thinking <level>`, `--tools a,b`
(allowlist for the sub-agent), `--timeout 20m` (default 15m), `--catchup` / `--no-catchup` (default: loops on, plain jobs off), `--stateful`,
`--verify`, `--checker-model provider/id`. Change model, thinking, timeout or name later with
`/cron set <id> …` (`-` = follow the running session). Sub-agents run inside the interactive pi
(pi's SDK) and share its live MCP servers, its `-e` extensions, system-prompt and skill flags, its
model unless the job pins one, and the project's trust when they run in the same project.
