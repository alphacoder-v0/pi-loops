# Configuration

Everything lives under `~/.pi/agent/loops/` (override: `PI_LOOPS_DIR`).

| File | Purpose |
|---|---|
| `config.toml` | `allow_project_hooks`, `[triggers] poll_interval_secs = 600` / `run_timeout_secs = 900`, `[cron] catch_up = true` / `max_concurrent_runs = 3`, `[hooks] mode = "sync"`, `[host] auto = true`, `[limits] daily_budget_usd = 0`, `[danger] allow = []`, `[engine] window_guard = true`, `[page] port = 4173` / `host = "127.0.0.1"` / `allow_host = []` |
| `logs/pi-<pid>.log` | what each pi process diagnosed: jobs disabled, writes that failed, sub-agent warnings. Rotated at 2 MB, newest 5 processes kept |
| `mcp.toml` | MCP servers — see [mcp.md](mcp.md) |
| `hooks.toml` | lifecycle hooks — see [hooks.md](hooks.md) |
| `ui.json` | preferences that outlive a session: `panel` (written by `/cron panel on\|off`); `model` / `thinking` — the last ones you chose in the browser page, applied to the next session that does not say otherwise; `host` (`"stopped"` after a manual stop); `launcher` (your answer to the launcher offer); `heldJobsNotice` (the one-time notice about plain jobs of closed conversations); `lastPage` (the conversation `GET /` opens) |
| `jobs.json`, `triggers.json` | cron jobs and trigger rules (machine-global, each with a `cwd`) |
| `jobs.json.bak` | the last `jobs.json` that read cleanly, kept so a damaged store can be restored |
| `state/<id>.md` | loop notes; plain Markdown, editable |
| `inbox.jsonl` | the inbox (past 1 MB the oldest triaged findings are dropped; nothing still new) |
| `runs.jsonl`, `triggers-audit.jsonl` | run log (halved past 1 MB) and trigger audit (2 MB) |
| `spend.json` | per-day totals of what rotation dropped from the run log, so a daily budget still counts it |
| `sessions/<job-id>/`, `sessions/triggers-<project>-<hash>/` | sub-agent transcripts (20 per job, 40 per project's checks; the hash of the project's path keeps two projects named alike apart) |
| `next-runs.json` | job id → when it runs next, as computed by pi-loops, or by a window while pi-loops is not running (`{ at, next }`). Written only when an answer changes, so it can be older than the last tick; the browser panel reads it rather than parsing schedules a second time |
| `presence/` | records written by pi-loops 0.22 windows, read only during an upgrade |
| `host-service.json`, `host.log` | pi-loops process record (pid, version, heartbeat, the page's address and token, or why the page is waiting; 0600) and log |
| `host-spawns.json` | pi-loops start attempts, the retry backoff and the crash pause |
| `host-service.sock` | pi-loops' control socket (0600): status, abort, run, stop, and opening a conversation in the page |
| `pages/<session>.json` | one per conversation open in the page: its pi's pid and start time, and when a tab last used it (0600). A pi-loops that restarts stops the pis these name, rather than adopt them |
| `pages/args/<session>.json` | the pi arguments of the launch that last opened that conversation in the page (0600). Kept after its pi stops: a pi the page starts again for it gets the same ones |
| `leases/<session>.json` | which process holds each conversation |
| `requests/<session>.jsonl` | requests addressed to a conversation (rule results), each kept until it is in the conversation or in the inbox as a dead letter |
| `seen.json` | when each project was last looked at (`/inbox`, or the page's Mark all seen), for the "since you last looked" line and the page's away card |
| `scheduler.json` | written by pi-loops during an upgrade only, so pi-loops 0.22 windows do not run loops beside it |
| `*.lock` | short-lived locks around writes |
| `polls.json` | last dynamic check per project (shared with 0.22 windows during an upgrade, so a project is not checked twice in one interval) |
| `dedup.json` | machine-wide trigger dedup window (5 minutes) |
| `web-token` | the browser page's token, mode 0600. It lives in a file rather than being made per start so the address stays the same one and a signed-in device stays signed in across restarts and upgrades. Delete it and run `pi-loops restart` to sign every device out. The first 0.24 start replaces a token from an earlier version once, and writes `web-token.v024` beside it to record that; a token you write into `web-token` after that is kept |

Project-level: `<project>/.pi/mcp.toml` (trusted projects only) and `<project>/.pi/hooks.toml`
(when allowed).
An invalid `[triggers] poll_interval_secs` is reported at startup
and ignored.

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
which is why the in-flight count is reported against it (`4 of 3 sub-agent slot(s) in use`) rather than assumed
to be under it. If you have a goal running and want headroom for it, size the setting one higher.

## `[host] auto`

`true`, the default: a pi window starts pi-loops in the background when there is a loop, a rule, a
push server or a closed conversation's plain job to run, and pi-loops keeps running after every
window has closed. `false` means what it meant in 0.22.8: loops run only while a pi window is open.
The first window still starts pi-loops; loops, rule checks and `/cron run <loop>` work in that
window; and pi-loops leaves once the last window has closed, after giving the window that started it
a minute to announce itself. Nothing runs with no window open, and the line a quitting window prints
says so. The browser page counts as a window: `pi-loops` opening it starts pi-loops, and a
conversation open in the page, or a tab on one, keeps it running. pi-loops leaves once the last
terminal window, page conversation and tab are gone. A `pi-loops start --foreground` run by a service manager, or a `pi-loops start` /
`/pi-loops start` you typed, is yours to stop, and stays either way. An invalid value is reported at startup and leaves the default.

## `[engine] window_guard`

A plain job's prompt runs under the job's own `--tools` and the dangerous-command policy
([loops.md](loops.md)) wherever it runs, and so does the turn an MCP server's `inject_and_run` push
starts, under the dangerous-command policy alone ([mcp.md](mcp.md)). In the background nobody can be asked, so a call outside
them is refused. In an open window you can be: the same call shows a question with a 60-second
countdown and two answers, `No, refuse it` focused and `Yes, run it once` under it, so Enter
refuses. The yes answer runs it this once; anything else, Escape or no answer refuses it with the
wording the background uses, so the model does the safe part and reports. `[danger] allow` applies in both places. The guard
asks nothing about pi-loops' own tools: `cron_list` and `list_triggers` only read; `cron_create` in
such a turn makes a job capped to the turn's tools, so it widens nothing; and `new_trigger`, the
trigger tools, `cron_remove` and `set_cron_job_state` ask through their own confirm, once, the same
question with the same minute, where the background would refuse. The cap holds until the turn settles, through pi's own retries and follow-ups. A row
written into `requests/<session>.jsonl` by anything but this window, with a source that would make
it yours, runs as a scheduled turn with no declared tools: the danger check asks you. Your own
turns, a `/goal` continuation, a claimed finding, a recipe hand-off and `/new-trigger` never ask:
they are yours, and a message you send into a scheduled turn makes the rest of it yours too.

`window_guard = false` turns the cap off in windows (the background is unchanged): a scheduled
prompt in an open window then runs as your own message would, as it did in pi-loops 0.22. An
invalid value is reported at startup and leaves the guard on.

## Flags and environment

| | |
|---|---|
| `--trigger-poll-secs <n>` | ignored: pi-loops checks rules every `[triggers] poll_interval_secs`; passing it warns at session start |
| `PI_LOOPS_DIR` | relocate the data directory |
| `PI_ALLOW_PROJECT_HOOKS=1` | allow project hooks. `true` works too; anything else is off |
| `PI_LOOPS_HOST=off` | prevent this process from starting pi-loops |
| `PI_LOOPS_DEBUG=1` | add a line per provider retry, compaction and tool call of a sub-agent run to `logs/pi-<pid>.log` |
| `PI_BIN` | the pi executable to start for `pi-loops --tui` and for each conversation in the page; without it the page starts the pi that pi-loops in the background runs on, never the one on `PATH` |

## What is remembered between sessions

A session opens on pi's default model, so choosing the same one every morning was the first thing
the browser page asked of anybody. Changing the model or the thinking level there records it in
`ui.json`, and `pi-loops` applies it when it starts the next session — the terminal window too,
since the launcher is what applies it.

It is not applied when you said which model yourself (`pi-loops --model …`), and not when the
session already has one: `--continue`, `--resume`, `--session` and `--session-id` keep the model
their conversation was had with. Delete the keys from `ui.json` to go back to pi's default.

A `--model` — yours or the remembered one — lasts as long as the process, not as long as the
session: pi re-resolves it every time the session inside the process is replaced. So **resume** in
the browser page re-applies the model the session it is going back to was last using, which is
what a fresh `pi --resume` would have done.

## `[page]`

The browser page's address. pi-loops in the background serves it, so it is set here rather than on
the command line, and a change takes effect after `pi-loops restart`. Full explanation in
[cli.md](cli.md#the-address).

```toml
[page]
port = 4173
host = "127.0.0.1"
allow_host = []
```

| | |
|---|---|
| `port` | default 4173, fixed on purpose so the address is worth bookmarking. Only the default loops directory uses it: a loops directory moved with `PI_LOOPS_DIR` takes a free port, so two of them do not fight over one. A port another program holds costs the page, never the loops: `pi-loops status` and `host.log` say so |
| `host` | the address to bind. Anything but loopback puts the page on the local network, unencrypted: `host.log` says `page on the local network, unencrypted: http://<ip>:<port>/`, and anyone on the wire can read the cookie. `tailscale serve` gets a phone in over TLS with the page still on loopback |
| `allow_host` | names the page answers to in the `Host` header besides loopback and a tailnet's, for a reverse proxy in front. A name resolved by public DNS puts the token alone in charge of keeping strangers out |

Tailnet names (`*.ts.net`) are accepted from a tailnet connection without `allow_host`, which is
what makes `tailscale serve --bg 4173` work with the page still on loopback. An invalid value is
reported at startup and leaves the default.

### The browser page

`pi-loops` takes these for itself and passes everything else to pi. Full explanation in
[cli.md](cli.md); this is the list.

| | |
|---|---|
| `--web` / `--tui` | which window, when the guess is wrong |
| `--no-open` | print the page's address without opening a browser |
| `--loops-dir <dir>` | the same thing `PI_LOOPS_DIR` does |
| `--port`, `--host`, `--allow-host` | refused (exit 2) with the `[page]` lines that replace them |
| `--no-auth` | refused (exit 2): gone in 0.24, the page is always behind its token |

## Per-job options (`/cron add`)

`--name`, `--cwd <dir>`, `--model provider/id`, `--thinking <level>`, `--tools a,b`
(allowlist for the sub-agent), `--timeout 20m` (default 15m), `--catchup` / `--no-catchup` (default: loops on, plain jobs off), `--stateful` (or `--loop`),
`--inject` (a plain job — the default, spelled out), `--verify`, `--checker-model provider/id`. Change model, thinking, timeout or name later with
`/cron set <id> …` (`-` = follow the running session). Sub-agents run inside the interactive pi
(pi's SDK) and share its live MCP servers, its `-e` extensions, system-prompt and skill flags, its
model unless the job pins one, and the project's trust when they run in the same project.
