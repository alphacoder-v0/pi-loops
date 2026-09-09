# Changelog

All notable changes to pi-loops are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer.
Behavior is cross-checked against [pie](https://github.com/c4pt0r/pie) source, file by file.

## [Unreleased]

### Fixed
- The model and thinking pickers in `examples/pi-web.mjs` were unreadable when open. A `<select>`'s
  dropdown is drawn by the platform rather than by the page, so a transparent background left the
  list painted on system white while the options kept the page's text colour — light text on white
  in a dark theme. They now use `Canvas` / `CanvasText`, which follow `color-scheme` in both
  directions, as the dialog and the completion popup in the same file already did.

## [0.5.0] - 2026-09-09

Everything here came out of one audit run from two opposite directions — one walking daily usage
scenarios from the outside, one inventorying mechanisms from the inside — and the eleven issues it
produced. The two passes converged on exactly one finding, which is the one that leads this list.


### Changed — a scheduled run has its own two hook events
- `run_start` and `run_end` join the hook vocabulary, and both the headless host and an interactive
  pi fire them for every scheduled run (#7). Until now the host fired `agent_start` / `agent_end`
  and an interactive pi fired nothing, so the same `hooks.toml`, the same job, and a notification
  that arrived or did not depending on which process happened to hold the clock. Silence that looks
  like success is worse than no notification at all.
  Reusing `agent_*` in both places would have fixed the asymmetry and broken something quieter: a
  rule you wrote about your own turns would have started firing for automation. These are not pie
  events, because pie has no unattended mode — every scheduled job there *is* a turn in the
  conversation. Here a run happens with no conversation at all, or beside one.
  The payload says what the run did: `run_job`, `run_id`, and on `run_end` also `run_ok`,
  `run_findings`, `run_error` and `run_cost_usd`, so "tell me when a loop fails" is
  `[ "$PI_RUN_OK" = false ]` rather than a string match on a summary. `run_*` hooks are always
  queued off the run in both processes, whatever `[hooks] mode` says: a webhook that hangs must not
  hold up the clock, and `sync` is about ordering inside a conversation turn.

### Fixed — three of the six gaps the September audit filed
- The headless host fires `hooks.toml` hooks for the runs it makes (#1). A webhook that told you a
  run finished worked while pi was open and went silent the moment the host took the clock, which
  is the window the host exists for. A run is the agent here, so it fires `agent_start` and
  `agent_end` and nothing else; the outcome rides in `message_kind` (`loop_run_ok` /
  `loop_run_failed`), so `$PI_MESSAGE_KIND` alone answers "did last night's loop fail". Each run
  gets its own runner bound to that job's project, and a project's own `hooks.toml` needs pi's
  trust for exactly that directory — `allow_project_hooks` is a statement about projects you open,
  not about a directory a model-chosen `cron_create` pointed at. `docs/hooks.md` now states
  exactly when hooks fire instead of listing exceptions.
- `/cron set --prompt` and `--schedule` change a job in place (#3). Rewording a loop used to mean
  remove-and-re-add, which minted a new id and abandoned `state/<old id>.md` — months of "what I
  have already reported" gone, so the next run reported all of it again. The schedule is validated
  through the same parser `/cron add` uses, the confirmation prints the new next run, and a cron
  change anchors `lastDueAt` to now so moving a daily job to `*/5` does not fire for slots that
  only exist retroactively. One-shot schedules are refused on an existing job: firing one deletes
  the job, which would destroy the notes this feature exists to protect.
- An MCP push refused while the machine is busy is held and retried instead of dropped (#5). A
  periodic check can be dropped safely — the next poll re-examines the world — but a push happened
  once and no server re-sends it, and both took the same path. Pushes now wait in a bounded list
  (32, about the width of the dedup window that defines a push's identity) and are retried oldest
  event first, carrying their original timestamp so the check knows when the thing actually
  happened. Over budget still drops rather than queues: too busy clears in minutes, a daily cap can
  last until midnight, and acting on the morning's deploy event at 23:59 is worse than not acting.
  A rule whose check keeps failing now backs off like a failing job instead of re-billing every
  poll forever.

### Fixed — the rest of the six gaps the September audit filed
- The daily budget stops a run that is already going, not just the next one to start (#4). A run
  admitted at $4.99 of a $5.00 cap could spend any amount, and three admitted together could each
  spend any amount — a limit consulted only at the entrance is a rate limiter, not a budget. The
  check now runs before setup, before the prompt, and after each completed turn, and it counts what
  this process has in flight as well as what the run log already knows: the runs beside this one,
  and the maker a `--verify` checker is reviewing. A stopped run is recorded as aborted rather than
  failed, so the slot is still owed and the job's failure streak is untouched; the reason says
  plainly that the budget stopped it, because "stopped" and "failed" must not be debugged the same
  way.
- A `/goal` continuation is held when you typed something else while the evaluator was running
  (#6). It used to be delivered as a follow-up on *your* new turn, so the goal quietly took over
  the question you had just asked. "The branch moved" deliberately does not mean "the leaf moved":
  run cards and panel snapshots move the leaf all the time, and treating those as your input would
  have stalled every goal on a busy machine. It means a user message arrived after the point the
  goal was judged at, or that point is gone.
- `/inbox` shows which project each finding came from, and defaults to this project with `--all`
  for every project — the scoping `/cron` and `/triggers` already use. With loops running in
  several projects, `/inbox claim 3` used to run a finding about one repository in another
  repository's directory. Note this scopes `/inbox all` (the history) too.
- A job that has been failing repeatedly says so in the status line and at startup, e.g.
  `2 job(s) failing (check-issues ×7)`. The count was already stored; nothing outside the backoff
  logic read it, so forty consecutive failures looked exactly like a healthy job until you typed
  `/cron`.
- `session_compact_failed` reaches the `compaction` hook with a `compaction_failed` field. A
  session that cannot compact is a session about to hit its context limit, which is the case a
  watcher most wants to hear about.
- Hook command stdout is captured into the per-process log, bounded and redacted, instead of being
  discarded — so the usual debugging move of printing something and looking at it works.

### Fixed — one limit, meaning what it says
- `[cron] max_concurrent_runs` bounds sub-agents, not sub-agents per pipeline (#2). Loop runs and
  trigger checks counted separately against the same number, so `= 3` permitted three of each plus
  a goal evaluator: seven. Both now draw from one pool (`src/slots.ts`), and `/triggers running`
  reports it, because a number that can be exceeded should at least be visible when it is.
  The point was never the arithmetic. Two pipelines each answering "am I under the limit" about
  themselves meant every admission rule had to be written twice, and the second copy drifted —
  which is how the deferred-versus-dropped difference between them came about. There is now one
  place that answers "may something start now", and it decides nothing about what a refusal means:
  the scheduler still leaves the tick owed, and the trigger runtime still queues a push and drops a
  periodic check.
  The `/goal` evaluator and `/cron run` take a slot but are never refused one — they are things you
  asked for directly, and a machine quietly declining to evaluate a goal is indistinguishable from
  a goal that was never set. That is also what makes `4 of 3 slots in use` a state you can reach
  and see.

### Fixed — a free delivery paying rent
- An injected summary arrives even when the day is over budget (#9). `inject_summary` puts the
  push's own text into the chat and runs no model call — its audit row has always recorded
  `cost_usd: 0` — and it was being refused by a cap it does not consume. The day the cap trips is
  the day you still want to be told what is arriving. Deliveries that do spend are still refused,
  and a summary that goes through while the cap is tripped says so in the audit and the log, so
  "everything else stopped today, why did this run" has an answer.

### Fixed — the follow-ups the parallel work left behind
- The headless host writes hook stdout to `host.log` (#11). Capturing it was added to the
  interactive extension by one agent while another was giving the host hooks, and neither could see
  the other's file — so the capture landed everywhere except the process where "what did my
  automation do last night" is actually asked.
- `/cron set --name` applies the rule `/cron add` applies (#10). A rename could store a name with a
  space, or a second `ci`, and a name is how a job is referred to — two of them make every later
  `/cron run ci` resolve to whichever the lookup reached first. The rule now lives in one function
  both paths call, so they cannot drift again. Renaming a job to what it is already called is not a
  collision.

### Fixed — a command of ours that pi already owned
- `/share` is now `/session-share`. pi has a built-in `/share` of its own, and an extension command
  that takes a built-in's name is dropped from autocomplete and shadowed at the prompt — so the
  command did nothing in the terminal while working fine everywhere without built-ins, which is
  where it had been verified. The new name matches `/session-export` and `/session-import`, which
  are about the same object. A test now reads pi's built-in list out of the installed build and
  fails if any of our command names collides, because this is not a mistake worth making twice.
  Worth knowing: pi's own `/share` is not the same command. It exports the raw session JSONL and
  offers it to a hosted gateway first, falling back to a private gist, unredacted and with nothing
  shown to you beforehand.

### Changed — a decision you can test
- `/cron set`'s decisions moved out of the command handler into `src/job-edit.ts` (#8). Nothing can
  import the extension's default export, so everything the handler decided was covered by reading:
  which stamp to anchor when a schedule changes, whether the job is now due at once, whether an
  expression that parses will ever match. `applyJobEdit(job, edit, ctx)` returns a patch, the lines
  worth logging, and when the job runs next; the handler is left with arguments, the store and
  printing. Behaviour is unchanged — the point was to be able to prove that.
  It returns a patch rather than a rebuilt job on purpose: `JobStore.update` re-reads under a lock,
  so a tick that started a run in between has already set `running`, and writing back a whole job
  built from a stale copy would erase it. That is now a property with a test rather than a habit.
  Two things nobody had checked are now checked: turning a job into a one-shot is refused (running
  one deletes the job, taking the loop's notes with it — the opposite of why editing in place
  exists), and an empty prompt is refused the way `/cron add` refuses one.
  This is the first seam; `AGENTS.md` now says where a decision goes, so the next one lands in the
  same shape.

## [0.4.0] - 2026-09-09

### Added — a browser front end, and the state one needs
- `examples/pi-web.mjs`: a browser UI for pi in one dependency-free file. It runs `pi --mode rpc`
  and passes that protocol through to a page — the session is a real pi session, and `pi --resume`
  picks it up afterwards. pie's `pie web` replaces its own terminal UI; pi keeps its terminal, so
  this is the same shape through the door pi already provides. Streaming feed, history, queue,
  abort, model/thinking, compact, images, `/` and `@` completion, `@file` expansion, search, undo,
  HTML export, cost, and pi-loops' approval dialogs answered in the browser.
- `pi_loops_snapshot`: a session entry carrying what only this process knows — which MCP servers
  connected and what they exposed, the active tools, hooks, whether this pi owns the clock, the
  last check. The TUI panel had it and nothing else could get at it; a front end that is not a
  terminal now reads it structurally instead of parsing text meant for a person. Written when it
  changes (not per tick — it goes into the session file), and `/cron snapshot` forces one.
- `/share` uploads this session's transcript as a GitHub gist through `gh`, like pie's `/share` —
  but redacted first, and it says what it is about to publish before it does: how many messages and
  tool results, how many secrets the redactor masked, whether the gist is public, and where the
  local copy is so you can read it. Secret by default; `--public` needs its own confirmation.
  pie renders the transcript unredacted and shells straight out to `gh gist create`, which sits
  badly next to a project that redacts everything else it puts on a screen.
- `/triggers run <id>` checks one rule now, without waiting for its poll slot — pie's "▶ run now",
  which existed for cron jobs (`/cron run`) but not for rules. It goes through the same path a
  periodic check takes, so dedup, audit, the sub-agent and promotion all behave identically, and
  it is refused for a rule belonging to another project: enabling one from here is one thing,
  starting a sub-agent there from a session that never listed it is another.

### Added — the checks themselves
- CI (`.github/workflows/ci.yml`): typecheck, lint and the test suite, on Linux and macOS, with
  every provider credential cleared. The suite is offline by construction; clearing the keys is
  what makes that a fact rather than an intention. This repository is installed straight from git,
  so a broken main was previously a broken install with nothing standing in the way.
- `npm run ci` runs exactly what CI runs.
- `scripts/lint.mjs`: two rules, no dependency (TypeScript is borrowed through npx, the way
  `typecheck.mjs` already borrowed `tsc`). **floating-promise** — pi installs no
  `unhandledRejection` handler, so a promise nobody awaits ends the whole session on a rejection;
  `void x()` counts, since that is the shape the bug takes here. **silent-catch** — an empty
  `catch {}` with no comment. It found ten floating promises on its first run.

### Fixed
- Ten promises that could have ended a session, found by the new lint rule. Most were safe by
  careful reasoning rather than by construction — `tick()` catches everything but its own error
  path calls back into hooks and logging; `handle()` is documented not to reject. One was a real
  latent bug: `HookRunner.fire` built its payload *outside* the try, so a throw in `payloadFor`
  rejected the shared queue promise, which every caller deliberately does not await.
- The redactor covers the shapes a secret takes in a *file*, not only in a prompt: Stripe-style
  `sk_live_…` keys, PEM private-key blocks, and `name: value` / `"name": "value"` pairs whose name
  mentions a token, secret, password or key. `/share` uploads whole transcripts, so the gap between
  "what a prompt looks like" and "what a config file looks like" started to matter.
- The headless host's control channel now works from a deeply nested `PI_LOOPS_DIR`. A unix socket
  path is capped at 108 bytes, so `<dir>/host.sock` under a long path failed to listen with EINVAL —
  the host ran on with no control channel and `pi-loops host status|abort|stop` reported a healthy
  host as "not answering". A long path falls back to a short one in the temp directory, named by a
  hash of the loops directory — inside a per-user directory this process owns, verified rather than
  assumed, because that socket accepts `abort` and `stop`: a predictable path loose in a shared
  temp directory is one any local account could bind first, and `host stop` would then report
  success against a forged reply while the real host kept running. `askHost` checks the socket is
  ours before believing it, a channel that cannot be opened no longer takes the host down with it,
  and what a snapshot prints is stripped of control characters like everything else that reaches a
  terminal.

## [0.3.0] - 2026-09-09

### Added — the last of the third audit's list
- `/cron disable --all` pauses every job in this project (`--all-projects` for the machine), and
  `/cron enable --all` resumes. Quitting pi is the *on* switch here — the host takes over — so
  "stop everything" needed to be one command rather than one per job.
- `/cron remove` keeps the loop's notes and transcripts; `--purge` deletes them, and `/cron gc`
  reports orphaned state with `--purge` to clear it. Remove-and-re-add is how a schedule or prompt
  gets changed, and that used to throw away months of accumulated state with no warning.
- `PI_LOOPS_DEBUG=1` traces what a sub-agent did — each tool call, provider retries, compactions —
  into the log file. pie has `--debug` for the same job.
- `pi-loops sessions [--all]` lists the session ids `export` accepts, and `pi-loops inspect <file>`
  shows what an archive contains without writing anything.

### Added — being able to tell what happened
- Every pi process writes its diagnostics to `logs/pi-<pid>.log` in the loops directory, rotated at
  2 MB with the newest five processes kept. Until now everything except the headless host went to a
  chat notification, which is never written to the session file — `/new` or a crash erased every
  warning the automation had produced, so a loop that failed at 03:00 left nothing to read at 09:00.
  `/cron scheduler` prints the path.
- Diagnostics that matter (a job disabled, a write that failed, a paused budget) are warnings, not
  info. pi replaces an info status line in place, so several in one tick collapsed to the last one.
- The headless host writes the same cron audit rows the interactive extension does, so
  `/triggers audit` is no longer blank for exactly the hours nobody was watching.
- A session says what it starts with: how many loops and rules are active here and when the next
  one is due, as pie prints on every start.
- `/triggers running` shows how long each run has been going and, for loop runs, the transcript
  being written right now — "is it stuck or is it working" no longer waits for the run to end.
- A deduplicated push says so instead of vanishing into an audit row.
- `pi-loops host status` falls back to the recorded pid and log path when the host does not answer,
  instead of reporting that no host is running; `host stop` escalates to SIGTERM.
- The host's snapshot carries health: the last few runs and their outcomes, jobs currently in error,
  the next due time and today's spend. A host that has failed every run for six hours no longer
  reads exactly like one that succeeded an hour ago.
- `[danger] allow` lets a project permit the exact command prefix an unattended run needs, without
  opening the whole class.

### Fixed
- `jobs.json` is version 2. The constant had been 1 since 0.1.0 while the on-disk shape gained
  `host` (which gates dispatch), `verify`, `timeoutMs` and the failure counter, so an older
  pi-loops sharing a `$HOME` silently rewrote the file without them.
- `polls.json` drops slots nobody has claimed for a day; it only ever grew, one entry per project
  and session, and is read and rewritten on every tick.
- A presence entry from a machine whose clock is ahead ages out. A negative age never exceeded the
  staleness window, so such an entry kept a dead session's jobs from ever being parked.
- A failed atomic write removes its temp file. On a full disk that was one abandoned file per
  process per tick, consuming inodes long after the failure itself was handled.
- Trigger transcripts are kept per project rather than sharing one 40-file budget across the
  machine, which three projects polling every ten minutes exhausted within hours.
- A job that fails three times in a row is retried on a widening gap (5 minutes, doubling, capped at
  six hours) instead of at every due tick. A loop whose sub-agent killed the process re-fired on the
  very next start, in a loop, with nothing counting the failures.
- Quitting no longer claims a hand-off that did not happen: it waits for the host to record itself,
  and says automation is not running if it never does. A host that died during module resolution
  used to be announced as a success.
- A holder that overran the stale window no longer deletes the lock of whoever broke it, which let a
  third caller in and lost writes. Each holder writes a token and only releases its own lock.
- A project MCP tool whose name collides with a built-in is offered as `<server>_<tool>` rather than
  silently dropped, as the interactive path already did.
- A run in an untrusted project says so once, instead of silently losing that project's AGENTS.md,
  skills, extensions and settings.

### Added — what automation costs, and a cap on it
- `[limits] daily_budget_usd` stops dispatching once today's automation has cost that much. Loop
  runs and trigger checks both stop, the job says why in `/cron`, and the slot stays owed rather
  than being skipped, so work resumes when the day rolls over or the cap is raised. pie has the
  same primitive and never exposes it, because its loops die with the session; a headless host runs
  for days, so nothing else bounds the bill.
- `/cron cost [today|7d|all]` adds up the run log by job and shows today's spend against the budget.
  Every number was already recorded and nothing added them up.
- The `/goal` evaluator is recorded in the run log like any other model call. It used to be spend
  that appeared nowhere at all.
- Trigger checks and actions share `[cron] max_concurrent_runs`. pie spawns every accepted trigger
  concurrently, which a person watching the feed bounds in practice; unattended, a server pushing
  distinct events opened one sub-agent per event with no limit.
- `/cron clear <ref>` releases a `running` marker left by a process that is gone. When its pid has
  been reused, nothing could clear it and the loop was parked for good; hand-editing `jobs.json`
  was the only way out.

### Fixed
- A timestamp from the future no longer wedges the clock. A wrong clock later corrected by NTP, a
  restored VM snapshot or a synced `$HOME` from a machine that was ahead used to leave `lastDueAt`,
  `lastFiredAt`, the poll ledger and the dedup window in a state where every comparison skipped
  forever — the job never fired again while `/cron` still rendered a next run.
- `inbox.jsonl` is rotated past 1 MB, dropping the oldest already-triaged entries and never
  anything still unread. It was the one log with no cap, and `newCount()` re-parses it on every
  badge refresh.
- `host.log` is rotated past 2 MB. It is the file the docs tell users to read, it also carries the
  host's stdout and stderr, and it was unbounded.
- Rules whose project no longer exists are disabled with the reason, like cron jobs already were.
  They used to start a sub-agent in the missing directory every poll interval, forever.

### Fixed — the pre-release security review
- `[danger] allow` means one command, not a prefix. It matched by raw prefix, so
  `allow = ["rm -rf /var/cache/mybuild"]` also permitted `rm -rf /var/cache/mybuild; rm -rf /` —
  arbitrary shell handed to exactly the actor the gate exists to stop, a model that may have been
  prompt-injected by repo content or tool output. Nor could "arguments may follow" be salvaged:
  `rm -rf /var/cache/mybuild /` needs no metacharacter at all, and an allowed wrapper (`ssh host`,
  `docker run`) would carry a whole second program as its arguments. An entry now matches that
  command exactly, or the same command aimed at a path strictly inside the one it names
  (`…/mybuild/tmp`, never `…/mybuild/../..`). The `rm -rf` scan also looks inside `` ` `` and
  `$( )`, so `echo $(rm -rf /)` is no longer invisible to it.
- The daily budget survives log rotation. It was summed from `runs.jsonl`, which is halved once it
  passes 1 MB — so on a busy machine the morning's costs disappeared and the cap read the day as
  cheap and resumed dispatching. Rotation now folds what it drops into a small per-day ledger, and
  `/cron cost` says how much of the total came from there.
- A run whose timestamp will not parse no longer counts toward today forever. `NaN < since` is
  false, so one such record above the cap would have paused every job on the machine permanently.
- The budget also gates plain (non-stateful) jobs. Injecting one makes the parent agent take a
  billed turn, and the check sat after the branch that handles them.
- `/cron gc` collects this project's dead jobs, not the machine's. It deleted other projects' jobs —
  and with `--purge` their loop state — from a session that had never listed them; `--all` is now
  how you ask for that.
- A lock holder whose token file has vanished no longer removes the directory, and neither does one
  that never managed to write a token. That was the same race the token was added to close,
  reopened from the other side: it fired in the window between a new holder's `mkdir` and their
  token write.
- A one-shot that already ran — or whose slot the scheduler declined because catch-up was off —
  stays retired across a clock correction, which used to drop its stamps and make it owe its single
  slot again.
- `pi-loops inspect` and `pi-loops import` strip control characters, newlines and bidi overrides
  from what they print of an archive. The archive is a file someone sent you and `inspect` is what
  you run before trusting it, so escape sequences in a prompt could repaint the listing you were
  reading it for, or forge a row in it.
- A running process's log is never pruned, however old it looks. A headless host that has been up
  for days is exactly the log someone goes looking for.

## [0.2.1] - 2026-09-09

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
