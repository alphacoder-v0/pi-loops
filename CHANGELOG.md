# Changelog

All notable changes to pi-loops are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer.
Behavior is cross-checked against [pie](https://github.com/c4pt0r/pie) source, file by file.

## [Unreleased]

### Fixed — found by the third audit, mostly in 0.2.0's own new code
- `pi-loops import` restored the transcript into a directory pi never reads. It hand-rolled the
  project directory name (`encodeURIComponent`) while pi uses `--home-u-proj--` and `list()` reads
  only that one directory — so the documented "restore on a fresh machine" flow imported a session
  `/resume` could not see. It now asks pi for the name.
- `/goal`'s evaluator judged only the run that had just ended, not the conversation. `agent_end`
  carries that run's messages, so evidence produced in an earlier turn was invisible and a
  satisfied goal kept returning "insufficient evidence" until the continuation budget ran out. It
  now reads the active branch through `sessionManager.buildContextEntries()`, as pie reads its
  transcript snapshot.
- A goal no longer evaluates after a turn the user aborted or the provider failed, so Esc actually
  stops a goal instead of paying for one more evaluator call and being sent back to work; `/goal
  pause|clear` and setting a new condition abort an evaluation already in flight; and a decision
  about a goal the user has since changed is discarded rather than written over the new one.
- A goal continuation is delivered with `deliverAs: "followUp"` when the session is not idle, like
  every other injection site. It used to throw into a swallowed rejection and be lost, after the
  iteration had already been counted.
- `/goal pause|resume|clear` are matched as whole words. `/goal clear all the type errors and get
  CI green` wiped a live goal instead of setting that condition; `/goal start …` is now refused
  with usage rather than becoming a condition named "start …". The evaluator also has its own
  2-minute timeout instead of the 15-minute trigger timeout, and its outcomes reach stderr in
  non-UI modes.
- Run cards, trigger cards and catch-up notices go to the project whose work they report, not to
  whichever window happens to own the timer.
- Every listing now uses the same project predicate as the runtime (realpath + containment), so a
  pi opened in a subdirectory, a worktree or through a symlink no longer shows "(none in this
  project)" while that project's rules fire into its chat. This covers `/cron`, `/triggers rules`,
  `/triggers audit`, the panel, both numeric-ref resolvers and the model-facing `cron_list` /
  `list_triggers`.
- A job or rule stamped with another machine's hostname is marked `[other host: <name>]` and shows
  no next run — it never had one, since the scheduler filters it out. `/cron set <ref> --host here`
  (and `--host -` for any machine) re-homes it, which a renamed machine or a rebuilt container
  needs as much as a second machine does.
- An existing but empty `jobs.json` is treated as damage instead of "no jobs", so the next tick can
  no longer overwrite every job with an empty store; the last content that parsed is kept as
  `jobs.json.bak`; and `writeFileAtomic` fsyncs the file and its directory so a crash cannot leave
  the rename applied and the data missing.
- A corrupt store can no longer kill the session. The badge and panel paths report the file and the
  problem once instead of throwing, the tick has a last-resort catch, and both leadership-hook call
  sites are guarded — pi installs no `unhandledRejection` handler, so any of those was fatal.
- The goal evaluator's transcript is redacted before it is sent and before it is kept as a
  sub-agent transcript — it now carries the whole branch, not one run's messages.
- A damaged store can no longer abort `session_shutdown` half way and strand MCP child processes:
  the hand-off decision is isolated, so the hooks, the MCP pool and the servers are always torn
  down. A tick that fails entirely is reported as a warning (and on stderr without a UI) rather
  than as routine chatter, and the dead-session check joins its guarded neighbours.
- `remove_trigger { all: true }` counts the rules it will actually remove: the approval preview and
  `clear()` now use the same project predicate.
- `jobs.json.bak` is written atomically, so a kill mid-write cannot destroy the backup the error
  message points at.
- Inbox appends wait for their lock instead of spinning on it. A lock directory left by a killed
  process froze the whole process for the full stale window (measured: 10 seconds with zero event
  loop ticks, once per finding); both lock helpers now also wait longer than a lock takes to go
  stale, so a stale lock is broken rather than waited out and then thrown on.

## [0.2.0] - 2026-09-09

### Added — the three things pie had and pi-loops did not
- **`/goal <condition>`** (`src/goal.ts`, pie's `goal.rs`): the session is held to a stop condition.
  After every settled turn an evaluator with no tools judges the condition against a bounded
  transcript and either stops with the evidence, sends the agent back to work with what is missing,
  or pauses. At most 8 continuations; an evaluator that cannot decide pauses rather than looping;
  the state is appended to the session so `--resume` picks it up. `/goal pause|resume|clear`.
- **A command line** (`pi-loops export|import`, `src/cli.ts`): pie's `pie session export|import` as
  subcommands that need no pi session, for backups from cron or CI and for restoring on a fresh
  machine. `--session` takes an id or a unique prefix, `--activate-triggers=off|ask|on` matches
  pie's flag, and a pie `.piesession` is accepted for its automation sidecars.
- **A window into the headless host** (`pi-loops host status|abort|stop`, `src/host-control-channel.ts`):
  while no pi is open the host publishes what it is running — loop runs, trigger checks, what is
  enabled, the inbox count, each MCP server's state — over a 0600 unix socket, and one run or check
  can be interrupted. `/cron host` shows the same snapshot. Read-mostly on purpose: a host you
  could prompt would be a second chat. pie's `--web` UI and its relay stay out of scope, because pi
  owns the terminal UI; this covers what they were needed for while nobody is at the terminal.

### Security — found by the pre-release review
- **An unattended run trusts only the exact directory the user trusted** (`src/trust.ts`). pi's own
  trust lookup inherits from ancestors, which is right for a person opening a subdirectory and wrong
  for a job whose cwd a model can choose: `<trusted repo>/node_modules/anything` used to count as
  trusted, so its `.pi/mcp.toml` could have its `command` spawned by the headless host with nobody
  watching.
- **An imported archive's schedule is validated** (`isValidSchedule`). A hand-made `.pisession`
  could carry `{kind:"cron",expr:"nope"}` or `{kind:"every",ms:0}`, and the throw from `computeDue`
  escaped the tick — killing an interactive pi outright (pi installs no `unhandledRejection`
  handler) and stopping the headless host's clock. A job that is somehow still unusable is now
  disabled with the reason instead of taking the tick down.
- The dangerous-command gate is no longer walked past by quoting (`su''do`), extra flags
  (`chmod -R 777 /`), a second pipe (`curl … | tee … | bash`), command substitution
  (`eval "$(curl …)"`), a force refspec (`git push origin +main`), or an unresolved target
  (`X=/; rm -rf $X`).
- The goal's continuation budget cannot be defeated by a `goal_state` entry with a non-numeric
  `iterations` (an archive carries those verbatim), and the evaluator's reason is redacted and
  capped before it is handed back to the agent as a user message.
- The loops directory is created 0700 and the host's control socket is closed rather than left
  reachable if its chmod fails; `listen()` creates it with the process umask, so the directory mode
  is what closes that window.
- `withFileLockSync` waits longer than a lock takes to go stale, so a lock left by a killed process
  is broken instead of waited out and then thrown on.
- Suppressing extension staleness across shared sub-session runs no longer disables pi's event-bus
  unsubscribers, which leaked every subscription a shared extension made in a long-lived host.
- A rule created with `/` or `$HOME` as its project governs only itself, not everything beneath it.

### Changed — multi-project correctness
- A rule belongs to the session that created it: while that session is open, its own window runs
  its checks and receives its promotions. Only when the creating session is gone does the project's
  owner take over. Two windows in one repo no longer answer each other's triggers.
- A project is a realpath, not a string: a pi opened in a subdirectory, through a symlink or in a
  worktree is the same project as the rule or job that names its root, for ownership, promotion
  routing, the audit filter and the listings.
- An MCP push deferred to a window that never claims it is taken back by the process that received
  it, instead of being lost with a `deferred` audit row.
- A promoted result carries pie's default template (`<source> fired <event>.\nResult: …`), and the
  trigger audit records the idempotency key, the replacement policy and the arrival time, so a
  dedup window can be reconstructed afterwards.
- A check killed by the run timeout still disarms the fire-once rules whose action already ran, so
  an action with external side effects is not repeated on the next poll.
- A sub-agent resolves its model through the parent's runtime, so `pi --api-key`, `/login` and a
  rotated credential reach loop runs. A pinned model that stops resolving (or loses its credential)
  falls back to the session's model with a warning on the run record instead of failing daily.
- Extension instances are loaded once per project and reused across runs, and a run no longer emits
  `session_shutdown` to them — a `-e` extension that opens a browser is no longer re-opened per run
  and no longer torn down under the interactive session.
- The run deadline and abort now cover setup, so a stalled `npm`/`git clone` in a project's package
  resolution cannot hold a job's claim and a concurrency slot forever.
- Run records keep cache tokens and record provider retries and context compactions, and `/cron`
  shows them: a run that silently retried five times no longer looks identical to a clean one.
- `jobs.json` is only written when something changed (pie's invariant), and an idle machine no
  longer creates it at all. A `version` newer than this build understands is refused, not rewritten.
- The run log rotates under its own lock, so records appended during a rotation are not dropped.
- A deferred run (concurrency cap) says so in `/cron` instead of looking like it never ran.
- A failed one-shot job is retried once and then removed, instead of sitting enabled forever with
  no next run.
- Importing an archive is idempotent: the same archive imported twice adds nothing the second time.
  An export carries the automation the exporting session created, not every session's in the
  project. A transcript with duplicate ids or dangling parents is refused instead of silently
  truncating history when the session is opened.

### Security — what an unattended run may do
- Loop, checker and trigger sub-agents run under pie's dangerous-command policy
  (`src/danger.ts`, ported from `permission.rs`): sudo, `curl … | sh`, `dd` to a block device,
  `mkfs`, `chmod 777 /`, shutdown/reboot, `git push --force` on main/master, pipes into `eval`,
  the fork bomb, and `rm -r -f` aimed at `/`, an absolute path or `$HOME` are refused before they
  run, with the reason handed back to the model. pie clones the parent's `before_tool_call` into
  every sub-agent; pi has no built-in denylist, so the gate is injected into each sub-session
  (`src/subagent-guard.ts`).
- `/triggers remove --all` and `remove_trigger{all:true}` clear only the current project.
  `/triggers remove --all-projects` is the new opt-in for the machine-wide sweep.
- `cron_list` and `list_triggers` show the calling project's automation; `all_projects: true`
  asks for the rest. Another project's prompts no longer reach a model that never asked for them.
- `cron_remove` goes through the same confirmation gate as the other control-plane tools, so a
  sub-agent can no longer delete a job (with its loop state and transcripts) unapproved, and a
  job outside the current project needs its exact id.
- An MCP config file can only name an environment variable prefixed `PI_MCP_TOKEN_` as a bearer
  credential; pi's credential store is unchanged. A project file naming `ANTHROPIC_API_KEY` no
  longer sends it to that server's endpoint, and the error no longer echoes the ref.

### Changed — a run belongs to its project, not to the window that happens to run it
- A sub-agent inherits the parent session's active tools (`pi.getActiveTools()`), the way pie hands
  its sub-agent the parent's live tool list. It used to fall back to pi's four-tool default, which
  both dropped what the session had (grep, find, web_fetch…) and restored what `-xt` had taken
  away. A job's `--tools` still narrows that set and can no longer widen it.
- A run in another project gets that project's own MCP servers (`src/mcp-pool.ts`), connected on
  demand and only when the user has trusted that project. The interactive process used to lend
  every run its own project's servers, and the headless host had none at all, so the same loop
  behaved differently depending on who owned the clock.
- The automation tools a sub-agent calls act in that run's project and model. A loop for project B
  that scheduled a follow-up used to pin it to whichever project the running pi was open in; the
  headless host already did this correctly.
- A run interrupted by quitting, a session swap (`/new`, `/resume`, `/reload`, `/fork`) or
  `/cron abort` hands its slot back instead of counting as a run, so the next tick re-fires it
  rather than skipping to the next due time. pi rebuilds the extension on a session swap, so the
  scheduler still stops there — but the tick is no longer lost.

### Fixed
- A `--verify` loop is no longer re-fired while its checker is still running. The run id now
  covers both sub-agents, so the overlap guard, `/triggers running`, the concurrency cap and
  abort all cover the checker phase (findings were entering the inbox twice, billed twice).
- A run interrupted by a crash is recovered by more than its pid: a marker written before the
  last boot is treated as dead (a recycled pid used to park the job forever), and a marker from
  another machine on a shared `$HOME` is left to that machine for a day instead of being cleared
  or trusted. `RunningMarker` records its host.
- `Inbox.append` takes the inbox lock, so a finding written while `/inbox dismiss|clear` rewrites
  the file is no longer lost. With machine-global loops the concurrent case is the normal one.
- A promoted trigger result keeps its line structure (`capRedacted`): diffs, file contents and
  test output arrive in the chat and in the audit as themselves, not collapsed onto one line.
  The one-line TUI previews still collapse, as before.
- An imported archive is re-stamped with this machine's hostname, so restored automation runs
  instead of sitting enabled and silent on the machine it was imported to.
- A streamable-HTTP server that answers `405`/`404` on the optional GET stream stays usable: tool
  calls keep working and the source no longer re-handshakes in a hot loop (the spec makes the
  server→client stream optional; pie keeps POST independent of it).
- The reconnect budget is refunded only after a connection has lasted 30 seconds, so a server that
  answers `initialize` and then exits is retried a bounded number of times instead of forever.
- A `Mcp-Session-Id` the server rejected (`404`/`400`) is dropped before the next attempt, so a
  restarted remote server recovers; a plain reconnect still resumes the stream with `Last-Event-ID`.
- Only a real `401`/`403` marks a server `auth_failed`. A command path containing "auth"
  (`authbind`, `/opt/oauth-mcp/…`) used to disable the server for the life of the process.
- A stdio MCP server that ignores SIGTERM is SIGKILLed after two seconds instead of being leaked.
- A source parked on a server with no push stream reconnects when that server rejects its session,
  instead of looking connected while every tool call fails.
- `Last-Event-ID` is recorded only from the server→client stream, not from POST response streams
  whose ids belong to a different space.
- MCP sources are restarted when a session swap changes the config or the project's trust; they
  used to keep running while the panel described the new configuration.
- Project MCP servers lent to another project's run are re-checked against that project's trust on
  every run, disconnected when trust is revoked, and the pool is bounded (8 projects, least
  recently used dropped).
- `PI_MCP_TOKEN_` is enforced where the environment is actually read, in both the interactive
  extension and the headless host. The restriction was previously bypassed by their own resolver.
- A project's MCP tool can no longer shadow a pi built-in in the headless host (`read`, `bash`,
  `grep`… are reserved everywhere, not just where a pi session could be asked).
- The model-facing tools take an id, prefix or name, never a bare ordinal: the list a model sees is
  not the one the user is looking at.
- Sub-agents cannot request the machine-wide listing (`all_projects` is ignored above hop 0), and
  disabling another project's job or rule needs the same approval enabling does.
- A run whose bookkeeping throws releases its run id instead of parking the job forever.
- `withFileLockSync` honours its deadline on every path, so an unreadable lock directory cannot
  spin with the event loop blocked.
- `rm -r -f /` is refused even when `HOME` is unset (only the `~`/`$HOME` rules need it).

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
