# Changelog

All notable changes to pi-loops are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer.
Behavior is cross-checked against [pie](https://github.com/c4pt0r/pie) source, file by file.

## [Unreleased]

## [0.1.3] - 2026-09-09

### Added — nobody around: a headless host keeps the clock
- When the last interactive pi on the machine quits with loops, rules or MCP servers configured,
  it starts a headless host (`src/host.ts`: same stores, same in-process runner, its own MCP
  clients) that keeps running everything except chat-bound inject jobs; chat-bound results go to
  the inbox. The first pi to open takes the clock back (an interactive scheduler preempts a `host`
  leader) and the host exits. `/cron host [start|stop]`, `[host] auto`, `host.json` / `host.log`.
  `scripts/pi-loops-host.sh` is gone. Tools a host-run sub-agent uses act in that run's project and
  model, and its control-plane operations are audited into `triggers-audit.jsonl`
  (`cron_control_plane`); a host record whose process is gone is reported as a crash by the next
  pi, never signalled (pid-recycling, boot-time and exact entry-path guards). The host takes the
  handing-off pi's model and thinking level for unpinned work, writes its record under a lock so
  two pis quitting together leave exactly one host, and evaluates an MCP push once per project
  that has rules, in that project. `/cron host start|stop` override `[host] auto` for that pi.
- A scheduler tick no longer waits for the run it starts: heartbeats, leadership, presence and
  trigger checks keep going during long runs, `/cron run` returns at once, and `stop()` waits
  (bounded) for aborted runs to write their records.

### Changed — sub-agents run in-process, like pie's
- Loop runs, maker/checker runs and trigger checks/actions are no longer `pi -p` child processes.
  Each is an `AgentSession` opened inside the interactive pi through pi's SDK (`src/sdk-runner.ts`):
  fresh context and its own transcript file, but the parent's live MCP client instances (a browser
  tab or database session opened in the chat is the one the loop sees), its `-e` extensions,
  system-prompt and skill flags, its model unless the job pins one, and the project's trust when
  the run is in the same project. Nothing is re-spawned per run; the cold-start cost is gone.
  `PI_LOOPS_CHILD`, `PI_LOOPS_HOP`, `PI_LOOPS_PARENT_*` and `PI_LOOPS_PI_BIN` no longer exist.
- Sub-sessions get the automation tools at hop 1 as custom tools (`cron_create`, `cron_remove`,
  listing, disabling); Prompt-class operations stay denied there, and a sub-session never loads a
  second copy of this extension or runs the trigger runtime. The parent's extensions receive
  `session_start` and `session_shutdown` in each sub-session, like pi's own headless modes.
- Project-local resources of a sub-session's cwd are loaded only when that project is trusted —
  by this session, or by a decision pi saved earlier — never by default.

### Changed — the scenarios the old "by design" choices had closed
- A project's dynamic checks and push evaluations now run in a pi that is open in that project
  (preferring the session that created the rules; `presence/` registry), so `promote_to_chat`
  lands in the right chat like pie's session-scoped runtime. The machine leader covers only
  projects with no pi open (results to the inbox). The poll interval is enforced machine-wide.
- A plain cron job created by a sub-agent binds to the session the sub-agent acts for, not to
  the sub-agent's own throwaway session — pie's parent cron.toml.
- MCP pushes: injected pushes reach every window that has the server (per-process dedup), rule
  evaluation happens once per project by its owner; no more first-window-wins.
- Model, thinking level and timeout of a job or rule are editable: `/cron set`, `/triggers set`
  (`--model -` follows the running session). Trigger checks/actions are capped by
  `[triggers] run_timeout_secs` (900) or the rule's `--timeout` instead of a fixed 15 minutes.
- Sub-agents inherit the parent pi's runtime flags (`-e`, `--append-system-prompt`,
  `--system-prompt`, `--skill`, `--no-skills`, …) and the project's trust when the parent trusted
  the same project.
- Plain jobs whose session no longer exists are parked as disabled by the leader; `/cron gc`
  removes them. `/triggers rules` marks rules created by another session.
- Trigger audit rows also become pie's session custom entries (`trigger`, `trigger_result`,
  `trigger_promotion`) with the project's `cwd`; `/triggers audit [N] [--all]` shows this
  project's rows by default.
- Hooks are awaited inline like pie (`[hooks] mode = "async"` for the old queued behavior).
- `PI_LOOPS_HOST=1` lets a `pi -p` run host the timer for as long as it lives.
- `[cron] catch_up = false` switches start-up catch-up off for every job (the global switch wins
  over `--catchup`); `[cron] max_concurrent_runs` bounds the burst.
- Jobs and rules record their `host`; other hosts sharing `$HOME` ignore them, leader election is
  per host (`scheduler.<host>.json`), and orphan detection never disables another host's loop.
- A promotion while the agent is busy goes to the follow-up queue and runs a turn after the
  current one, as pie's follow-up does.

### Changed — parity with pie in the small things
- Ids are pie-shaped (`cron-<32 hex>`); `inbox.jsonl` uses pie's record shape on disk
  (`created_at`, `trace_id`, `session_id`, …) and still reads lines written by earlier versions.
- Cron control-plane audit entries use pie's custom type `cron_control_plane` and carry an
  `audit_entry_id`, which `cron_create` / `cron_remove` / `set_cron_job_state` return in `details`;
  `cron_create` answers with pie's three lines and `cron_list` details include `next_run` and
  `last_due_at`; `verify = true` implies `stateful` on the tool path as on the slash path.
- `/inbox` lists the full finding with pie's `created_at[..16]` timestamp; `/cron` shows pie's
  `last fired:` line; `/cron`, `/triggers` and `/new-trigger` use pie's usage and error wording;
  `/triggers enable|disable` prints condition/action/fire-once; `/triggers sources` lists MCP
  servers, the cron hook and the dynamic checker in pie's order and `/triggers status` adds
  pie's `sources: N total, M connected, K require attention` line.
- Prompt-class tool confirmations show pie's approval card (Action / Tool / value-free Reason /
  args hash / redacted Preview) and log `approval required` / `approved` / `denied` feed lines;
  `new_trigger` requires `condition` and `action` and rejects unknown fields, like pie's schema.
- Promotions and injected summaries are `[Trigger <trace>] <text>` exactly like pie's engine
  (the `<source> fired <event>. Result:` wrapper is gone); running-trigger previews are 80 chars of
  the action prompt; inject-and-run turns announce `running triggered turn (trace …)`.
- Side panel: pie's Polling entry (source / event, trace, summary — shown whenever a check ran),
  MCP aggregate (`servers N · tools M · notification hooks N`), and Hooks / Runtime sections.
- Hooks: every payload field is present (`null` when absent), custom messages report their
  `customType` as `message_kind`, failures reach stderr when there is no UI, `<project>/.pie/hooks.toml`
  is read when `.pi/hooks.toml` is absent (same for `mcp.toml`).
- MCP: a repeated server name replaces the earlier entry (pie) with a diagnostic; a successful
  push clears `last error`; stdio stderr is reported separately as `stderr:`; dedup audit records
  the first arrival's replacement policy; idempotency keys hash any Unicode control character;
  the SSE frame cap counts bytes; stdio-server validation no longer says `streamable_http`.
- Session archives: pie's sensitivity warning is printed first and on failure; the imported header
  drops the source machine's parent-session pointer.
- Redaction masks browser-login and loopback-callback URLs like pie; an invalid poll interval
  (config or `--trigger-poll-secs`) is diagnosed instead of silently ignored; the loop prompt's
  `[loop-state]` line uses pie's wording; User-Agent / MCP clientInfo carry the real version.
- `examples/mcp-notify-server.mjs`: a dependency-free MCP push server (pie ships a Python one).

## [0.1.2] - 2026-09-09

### Fixed
- streamable_http MCP sources: the idle timeout was a deadline on the whole GET stream, so a busy
  stream was cut every `sse_idle_timeout_ms` (60 s), failing in-flight calls and re-handshaking.
  Like pie it now bounds only the wait for the response headers and for each chunk.
- Sub-agent processes (`pi -p` loop runs and trigger checks) consumed MCP pushes and could spawn
  nested trigger sub-agents with no ceiling. Like pie, sub-agents keep the MCP tools but ignore
  pushes, and the trigger runtime audits anything reaching hop ≥ 1 as `cycle_suppressed`.
- `/session-export --exclude-triggers` still bundled cron jobs and loop state; like pie it drops
  every automation sidecar. `/session-import` validates all sidecars before writing the session
  file and rolls back store writes on failure, so a rejected archive leaves nothing behind.
- A failing audit or dedup write inside trigger handling became an unhandled rejection. Audit
  writes are best-effort (pie's PersistenceError; `lastPersistenceError`, logged once per distinct
  error), `TriggerRuntime.handle()` never rejects, and scheduler hook failures cannot strand a run.
- Prompt-class control-plane tools (`new_trigger`, `remove_trigger`, re-enabling a trigger or a
  cron job) were auto-approved in sub-agents; like pie they are denied fail-closed there.

### Security
- `/session-import` rejects cron job and trigger rule ids that are not plain tokens: ids become
  file and directory names (`state/<id>.md`, `sessions/<id>/`), so an archive could otherwise
  reach outside the store through `/cron remove` or the import rollback.
- streamable_http MCP: `stop()` during the handshake now aborts it (the connection controller is
  held from the first POST) instead of leaving an unowned event stream.

## [0.1.1] - 2026-09-08

### Fixed
- `promote_to_chat` results and `inject_*` MCP feeds no longer land in another project's chat:
  they are promoted only into a chat in the rule's `cwd`, otherwise routed to the inbox (`redirected` in audit).
- Project-level MCP servers' notifications were dropped in processes that did not own the timer.
  Every process now consumes what it receives; a machine-wide dedup window (`dedup.json`) keeps it to once per push.
- Loops and trigger checks ran with the timer owner's model; jobs and rules now record the creating
  session's model/thinking and run with those.
- A run that died with its process was skipped until the next slot; it is retried on the next tick.
- Stdio MCP reconnects no longer notify on every attempt; each distinct error once, 20 attempts by default.
- Queued lifecycle hooks are drained (≤3 s) on shutdown instead of being lost.

### Changed
- Plain (inject) jobs no longer catch up missed ticks by default (pie never backfills); `--catchup` opts in. Loops still do.
- Sub-agents keep the cron/trigger tools while `PI_LOOPS_HOP < 2` (pie-style hop-bounded cycle suppression) instead of never having them.
- `/cron` marks plain jobs whose session is not open as `[dormant …]`; loops whose `cwd` vanished are auto-disabled and marked `[orphan]`.
- pie's `/cron status` means list; the scheduler view is `/cron scheduler`.

## [0.1.0] - 2026-09-08

First release. Everything pie ships in its automation layer, as a pure pi extension.

### Added
- `/cron add [--stateful] [--verify] "<schedule>" <prompt>` with pie's list/enable/disable/remove
  surface, schedule aliases (`hourly`, `daily`, `每小时`, …), `every 30m`, `in 10m`, `at <ISO>`.
- Stateful loops: fresh `pi -p` sub-agent per run, ≤2000-char notes carried between runs
  (`<loop-state>`), findings routed to the inbox (`<inbox>`), transcripts kept (`/cron trace`).
- Maker/checker (`--verify`, pie's phase 3): an adversarial second sub-agent keeps or drops each
  finding before it enters the inbox; fail-open on checker failure.
- `/inbox` triage with pie's exact list formats and `new → claimed/dismissed` lifecycle;
  `/inbox claim` starts a real agent turn.
- Dynamic triggers: `/new-trigger`, `/triggers status|rules|sources|enable|disable|remove|running|audit|abort`,
  `new_trigger` / `list_triggers` / `remove_trigger` / `set_trigger_state` tools, periodic sub-agent
  evaluation, fire-once, `promote_to_chat`, `[Trigger <trace>]` prefix, 5-minute dedup window.
- MCP: notification sources (stdio + streamable HTTP) with pie's `mcp.toml` schema, dedup keys,
  redacted summaries, `inject_summary` / `inject_and_run`; server tools registered with the agent.
- Lifecycle hooks (`hooks.toml`): pie's events, payload, `PI_*` and `PIE_*` env, command + webhook,
  sequential execution, process-tree kill on timeout, project hooks gated.
- Session archives: `/session-export` / `/session-import` (`.pisession`, pie's `.piesession`
  layout plus `loops/<id>.md` state files).
- pie-style side panel above the editor (`/cron panel on|off`), `Inbox: N new · running: …`
  status badge, run cards in the transcript.
- Machine-global job store with leader election across pi processes, one-shot catch-up of missed
  ticks (`--no-catchup` to opt out), per-job transcripts, run log, redaction everywhere.

### Differences from pie (deliberate)
- Jobs and rules are machine-global with a `cwd`, not session-scoped; `/cron` and `/triggers rules`
  list the current project by default.
- Missed ticks are caught up once by default; pie never backfills.
- Prompts may be up to 8 KB (pie: 4 KB).
- MCP notifications are consumed by the single process that owns the timer; every process still
  connects for tools.
