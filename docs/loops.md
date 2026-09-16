# Cron jobs, stateful loops, the inbox, maker/checker

Everything here is `/cron`; `/crontab` and `/loop` are the same command under other names.

## Plain cron jobs

```text
/cron add "*/30 * * * *" summarize the repo state
```

When due, the prompt is injected into the session that created the job as a user message with the
engine prefix `[Trigger <run-id>] `, and the agent runs one turn (an *inject-and-run* job). If the agent
is busy the message is queued as a follow-up. A plain job belongs to the session that created it:
its result is a message in that conversation, so it fires only in the process holding that session.
Open another session and `/cron` lists it as `[session <id> — resume it to run]` with no next run,
`cron_list` says the same to the model, and `/cron run` refuses it; `--resume` the session it
belongs to and it wakes, catching up a missed slot if it was created with `--catchup`. It is not
broken while it sleeps — it is waiting for its conversation. Something that should run whether or
not a window is open (a nightly digest, a watch) is a loop: `--stateful`, with the inbox as its
outlet.

Schedules are local time: 5-field cron (`*/n`, ranges, lists, `mon-fri`, `jan`), the aliases
(`hourly` / `every hour` / `once an hour` → `0 * * * *`; `daily` / `every day` → `0 9 * * *`;
`weekly` → `0 9 * * 1`; `每小时`, `每天`, `每周`), and crontab's `@hourly` / `@daily` / `@weekly` /
`@monthly`. `daily` means 09:00 local; `@daily` means midnight. Also `every 30m`, `in 10m` and
`at 2026-09-08T18:00` (one-shot jobs are removed after they fire).

## Stateful loops

```text
/cron add --stateful "0 9 * * *" check the repo issues and report anything new since the last run
```

Each run is a fresh sub-session inside the interactive pi, through pi's SDK: full tools including the parent's live MCP servers, the session's model and thinking
level, no conversation history, its own transcript file. Every run gets the same prompt: the output
protocol, preceded by one line of context (the job's name, when the run started, whether it is a
catch-up):

```text
You are running the recurring loop "<name>" (current run started <when it started, on the clock of the machine running it, with that machine's offset>; write any time in your notes with its offset, as that one has). This is a background run: nobody is watching, and your final reply is parsed by a program.

[loop-state] (your notes from the previous run of this recurring job)
<contents of the state file, or "(first run)">
[/loop-state]

<your prompt>

Output protocol (mandatory):
- End your reply with <loop-state>notes for the next run</loop-state> — it REPLACES the saved state; keep it under 2000 characters and make it the information your next run needs (baselines, ids already seen, watermarks).
- For each finding a human should act on, emit <inbox>one concise line</inbox>. No findings → no inbox tags; do not invent work.
- Keep everything after the last tool call short so the tags are not truncated.
```

Then:

- the last `<loop-state>` block replaces `state/<id>.md` (capped at 2000 characters);
- up to 16 `<inbox>` tags (each ≤500 characters) are appended to the inbox; extras are counted as dropped
  — the count is exact up to the first 1000 tags, past which a reply is a runaway rather than a report;
- missing or malformed tags never fail a run: the state stays untouched, nothing enters the inbox;
- a run that is still going when the next tick arrives is skipped and counted (`skipped overlaps`).

Every run leaves a trail: the sub-agent's full transcript (`/cron trace <job> [k]`, 20 per job), a
run log with exit code, duration, cost and finding counts (`/cron runs`), and a card in the
transcript when the run finishes. Prompts are capped at 8 KB.

## The inbox

Global JSONL, shared by every session and project, with a stable record shape (`id` = `inb-<32 hex>`,
`created_at`, `source` = `cron:<job>`, `text`, `trace_id` = the run id, `session_id`, `status`
`new → claimed | dismissed`) plus pi-loops' `job_id`, `cwd`, `claimed_by`, `verified`,
`verified_reason`, `dismissed_at`, `dismiss_reason`, `kind`. Job ids are `cron-<32 hex>`; prefixes, names
and list numbers resolve.

```text
/inbox                 Inbox (<project>, N new, K need a decision, times <offset>): "<n>. [<id prefix>] <finding>  (<project>, <source>, <created_at>)"
/inbox --all           the same, every project on this machine
/inbox all [--all]     history including claimed and dismissed
/inbox claim <n|id>    mark claimed and start a real agent turn:
                       "A recurring loop (<source>, running in <cwd>) reported this finding — investigate and address it: …"
                       (the loop's cwd is part of the line; a checker-kept finding adds a line saying so)
/inbox dismiss <n|id> [reason]   mark dismissed; the reason, if you give one, is shown to the loop's next run
/inbox clear [--all]
```

A dismiss with words after the number — `/inbox dismiss 2 that file is generated, ignore it` — is
the one way a person talks back to a loop. The reason is stored on the entry and put in front of
the **next run of the loop that reported it**, between its notes and its task, in a `[dismissed]`
block that says not to report the finding again unless what it describes has changed, and to carry
into the notes whatever it needs to remember that. It is shown to that one run only: a loop has
nothing but its notes between runs, and a second memory the notes cap does not bound would be one
the loop could not edit or forget. Up to eight reasons per run, the newest kept. A bare
`/inbox dismiss 2` and `/inbox clear` stay silent, as before — "not interesting" is not something
the next run can act on. `/inbox all` shows the reason on the dismissed line. For a dismiss,
`--all` counts only before the reason begins (`/inbox dismiss --all 3 …` or `/inbox dismiss 3 --all …`);
a reason that mentions `--all` in passing does not re-number the list you were looking at.

The file is machine-wide because loops are; triage is not. `/inbox` lists this project's findings
the way `/cron` lists its jobs, names the project on every line, and says how many are waiting
elsewhere; `--all` lifts the filter. Numbers are the numbers on screen — `/inbox claim 3` claims
the third line of *this* project's list, never another repository's finding run in this directory —
while an id or an id prefix still resolves machine-wide. `/inbox clear` dismisses what it listed,
not the unread findings of four other projects. A finding stored without a cwd belongs to no
project and is listed in all of them.

A finding that asks for a decision is a **checkpoint**, and the inbox knows one by its shape:
the ` · waits: … · if not: …` clauses every packaged playbook writes
([recipes.md](recipes.md#checkpoints)). The run's text is read once, when its findings are
appended, and the entry carries `kind: "checkpoint"` from then on; news carries nothing. `/inbox`
lists checkpoints first, marked `⚑`, and says how many there are in its header (`3 new, 1 needs a
decision`); the numbers on screen are the numbers `claim` and `dismiss` take, so the order is
decided in one place. Claiming a checkpoint tells the turn that the claim is the person's approval
of the decision the finding recommends, and to carry it out rather than investigate it again.

Corrupt lines are skipped on read and never deleted. The footer shows `Inbox: N new`, with
`(K decisions)` after it when any are checkpoints (the whole machine, as the badge always has), and `N job(s) failing (<worst> ×<count>)` once a loop has failed
often enough for the scheduler to start backing off; the same clause is on the `[cron] … active
here` line at session start, for this project. Until then a job that has failed forty nights in a
row looked exactly like a healthy one. The side panel shows the inbox count too. Entries kept by
the checker carry a `✓`.

## Maker/checker (`--verify`)

With `--verify` (implies
`--stateful`; `--checker-model provider/id` picks another model) the maker's findings do not go to
the inbox directly. A second sub-agent receives the loop goal, the maker's notes and the numbered
findings and is told to assume each may be wrong, stale, duplicated or trivial, verify with tools,
and answer with one `<verdict n="i">keep|drop — reason</verdict>` per finding (plus an optional
`<rewrite n="i">…</rewrite>`).

- Kept findings enter the inbox marked verified; the checker's reason travels with the claim.
- Dropped findings and their reasons go to the run log and the run card; `/cron trace <job> <k> checker` shows the checker's transcript.
- Findings without a verdict enter unverified.
- **Fail-open:** if the checker fails or times out, every finding enters the inbox marked unverified. A broken checker must not silence the loop.
- The checker never touches the state spine.

## Restart behavior

Jobs live in `~/.pi/agent/loops/jobs.json` and survive pi restarts. Exactly one pi process on the
machine owns the timer (`scheduler.json`, 30-second ticks, 90-second heartbeat); when it exits
or dies another open pi takes over on its next tick. A tick that was missed while no pi was running
is fired once at startup (collapsed, not replayed) for stateful loops unless `[cron] catch_up = false`;
plain inject jobs do not catch up unless created with `--catchup` (`--no-catchup` turns it off for
loops). A run that died with its process is retried on the next tick; at most
`[cron] max_concurrent_runs` (3) run at once. Trigger checks share `[cron] max_concurrent_runs`, so
a server pushing many distinct events cannot open one sub-agent per event.
Jobs run with the model and thinking level recorded
on them (`/cron set <id> --model … --thinking … --timeout …`, `-` to follow the running session).
`/cron scheduler` shows who owns the timer; `/cron` marks a plain job as `[session <id> — resume it
to run]` when its session is not open here, parks it as disabled once that session's file has been
deleted (`/cron gc` removes it), and marks a loop `[orphan: cwd missing]` when their checkout is gone — disabled half an hour later, since a
mount can be late at boot. A job created by a sub-agent belongs to the session that ran it.

pi-loops runs on one machine. Two machines syncing one `$HOME` would both run every job; that is
not supported (until 0.19.0 a hostname stamp on each job half-handled it, and is now ignored). To
reach a running pi from elsewhere, use the browser front end over your tailnet ([cli.md](cli.md));
the loops keep running where pi runs.

## Time, and which clock it is

**Everything is this machine's clock.** Cron expressions are matched against local time — `0 9 * * *`
is nine in the morning where the machine is, not 09:00 UTC — and there is no per-job timezone. Move
the machine, or change its `TZ`, and the jobs move with it.

Timestamps are written the same way, with the offset that makes them unambiguous — this is what a
machine at `+08:00` writes; yours writes its own:

```json
{"startedAt": "2026-09-11T20:37:59.405+08:00", "finishedAt": "2026-09-11T20:38:12.880+08:00"}
```

That is the same instant `2026-09-11T12:37:59.405Z` names, and anything that parsed one parses the
other — including what earlier versions wrote. The difference is that opening
`runs.jsonl` shows the hour you were at your desk, and it agrees with the `next` on the `/cron` line
that sent you there. `/cron` and `/inbox` say the offset in their header; a timestamp that travels
somewhere without one — into a sub-agent's prompt, into a tool result a model reads — carries its
own.

Two things are deliberately still UTC, because neither is a time anybody reads: the name of a
session file, which cannot hold the `+` and `:` an offset brings, and pi's own session header, whose
format is pi's to decide.

The offset in the run line above is the offset of the machine **at the time it ran**, not a fixed
part of the prompt. A machine's clock is not a constant: `TZ` gets set, a laptop travels, a
container is rebuilt in UTC. A loop's notes are free text the model writes — watermarks,
"everything up to here has been seen" — and a watermark without an offset is a watermark the next
run cannot read once the clock has moved. The prompt asks for the offset for that reason. Notes
written before 0.14.1 do not have it; a loop that keeps a watermark on a machine whose timezone has
changed is worth one look at `/cron state <id>`.

### Daylight saving

Local time means the clock does what the clock does, and twice a year it does something strange.
Measured, not assumed (`America/New_York`, 2026) — and pinned by `test/dst.test.ts`, which sets the
zone it needs rather than reading the one the machine happens to have.

| | what happens |
|---|---|
| Spring forward — `0 2 * * *` on 8 March | 02:00 does not exist that day, so the job **does not run**. It runs again the next day. |
| Fall back — `0 1 * * *` on 1 November | 01:00 happens twice, so the job **runs twice**. |

Vixie cron special-cases both (it runs a skipped job once, and a repeated one once). pi-loops does
not: it matches the wall clock, and the wall clock is what it is. If a job must run exactly once a
day whatever the clock does, `every 24h` is immune — it counts elapsed time and never consults a
calendar.

### `in` and `at`

`every 30m` is an interval: no timezone, no DST, no wall clock at all.

`in 10m` and `at <ISO time>` are resolved **once, when the job is created**, and stored as the
instant they landed on. Changing the machine's timezone afterwards does not move them. Note what
JavaScript does with the text you give `at`, which is the standard's rule rather than ours:

```text
at 2026-09-08T18:00    → 18:00 local
at 2026-09-08T18:00Z   → 18:00 UTC
at 2026-09-08          → midnight UTC   ← a date with no time is UTC, not local
```

Write the time if you mean a time.

## Changing a job in place

```text
/cron set <ref> --prompt "check the CI and report only what changed"
/cron set <ref> --schedule "0 9 * * 1-5"
```

The first version of a loop's prompt is always slightly wrong, and the fix used to be
remove-and-re-add — which mints a new job id and leaves the loop's notes behind at the old
`state/<id>.md`. `--prompt` and `--schedule` edit the job in place, so the id, the notes and the
run history stay. Both values are one token: quote anything with spaces in it. Unlike the pins,
neither takes `-` — a job always has a prompt and a schedule, so `-` would have nothing to fall
back to and is refused rather than silently emptying the prompt (`--prompt "-"`, quoted, is the
literal text). The previous wording goes to the loops log, so a loop that starts behaving
differently can be traced to the edit that caused it.

The new schedule is parsed before it is stored: a typo leaves the job untouched, and so does an
expression that can never match (`0 0 30 2 *`). The confirmation prints the next run time, which is
where a plausible-but-wrong expression shows itself. Changing the schedule does not backfill: a
cron job's clock restarts at the edit, so slots that only exist retroactively under the new
expression are not owed. An `every <dur>` job is still measured from its last run — if it last ran
longer ago than the new interval, it is genuinely overdue and the confirmation says `due now`
instead of promising a later time. One-shots (`in 10m`, `at <ISO>`) are refused here: the scheduler
deletes a `once` job after it fires, notes included.

`/cron run <ref>` fires a job now instead of at its next due time, and that run counts as a run: a
`once` job is fired and then removed (an enabled job with nothing left to fire is worse than none),
an `every <dur>` job's interval restarts from now, and a `cron` job's next run is unchanged — the
expression says when it runs, not the last run. A disabled plain job is refused rather than run: its
prompt would land in whichever chat is open now rather than the one it was written for, and a job the
dead-session sweep parked has to keep the marker `/cron gc` collects it by.

A project is matched by realpath and containment, so a pi opened in a subdirectory, a worktree or
through a symlink sees and runs that project's automation.

## What it costs, and capping it

`/cron cost [today|7d|all]` adds up the run log by job, and shows today's spend against the budget
if one is set. Every loop run, its checker and every trigger check is counted; so is the `/goal`
evaluator.

```toml
[limits]
daily_budget_usd = 5.0   # 0 (the default) means no cap
```

Once today's automation has cost that much, nothing more is dispatched: loop runs, plain jobs and
trigger checks stop, the job's `last_error` says so, and the slot stays owed rather than being
skipped, so work resumes when the day rolls over or the cap is raised. The run log is rotated by
size, so what it drops is folded into a small per-day ledger first — a cap that forgot yesterday's
busy morning would stop capping halfway through the day.

The cap is also checked **while a run is in flight**, not only before it is dispatched: a run
admitted at $4.99 of a $5.00 budget would otherwise be free to spend any amount, and three runs
admitted in the same tick would each be free to. A run is measured once per model turn against
today's recorded spend plus everything this process has in flight — its own cost so far, the runs
beside it, and, with `verify = true`, the maker whose findings its checker is reviewing. When that
total reaches the cap the run is stopped the way the run timeout stops one: pi aborts the
sub-session and the run is recorded with what it had spent. It is treated as an interruption rather
than as a job that failed — the concurrency slot is released, the tick stays owed, the job's
failure streak is untouched and a one-shot is not retired — so the loop simply resumes when the day
rolls over or the cap is raised, held back until then by the check at dispatch.

A stopped run is a failed run in `/cron runs` and `/cron trace`, but never an unexplained one — its
error is the reason, and the reason leads with the cap:

```
FAILED: stopped by today's $5.00 daily budget ($4.62 already spent, $0.41 in flight); raise…
```

The same line lands in the job's `last_error` and in the diagnostics log. A run stopped this way
keeps its transcript, and its findings up to that point are not written to the inbox — the run did
not finish, so its `<loop-state>` and `<inbox>` tags are not trusted.

## Stopping, removing, and jobs that keep failing

`/cron disable --all` pauses every job in this project (`--all-projects` for the machine) and
`/cron enable --all` resumes them — quitting pi hands the clock to the host rather than stopping
anything, so this is how you actually go quiet.

If a loop is stuck showing `running` after a process was killed and its pid reused, `/cron clear
<ref>` releases the marker (it asks first).

`/cron remove` keeps the loop's notes (to change a prompt or a schedule, edit the job in place with
`/cron set` instead); `--purge` deletes them. `/cron gc` collects this project's jobs whose session
is gone — `--all` every project's, `--purge` also the loop state left behind by jobs that are gone.

A job that fails three times in a row is retried on a widening gap (5 minutes, doubling, up to six
hours) instead of at every due tick, and says so; one success clears the streak.

## Was it worth running

A loop was judged, until now, by whether it ran: `runs 42`, a last error, the failing badge. None
of that says whether anyone wanted what it found. So `/cron` puts two more facts on a loop's lines,
both computed from the run log and the inbox and nothing else:

```text
 3. cron-b91def87 "pr-watch"  enabled  */15 * * * *  [stateful]  [quiet ×12]
    next 2026-09-15 10:15 · runs 412 · 30d: 6 findings · 6 dismissed (4 with a reason) · ~/code/acme-api
```

`30d: 6 findings · 6 dismissed` is the last thirty days: findings filed, and of those still in the
inbox, how many a person claimed and how many they dismissed (with how many reasons). A loop whose
findings are all dismissed is noise at any price; one whose findings are all claimed is the one to
keep. `/cron cost` shows the same counts beside each job's spend, for its own window, so
`$0.410  28 run(s)  pr-watch  —  6 findings · 6 dismissed` is a line that answers itself.

`[quiet ×12]` means the twelve newest runs found nothing, whatever the window. It is not a fault —
a watch on a quiet thing is supposed to be quiet — and pi-loops does not slow the job down for it:
the schedule is the schedule. It is the number to read before deciding that a fifteen-minute
watch could be hourly (`/cron set <ref> --schedule "0 * * * *"`), or that the loop is looking at
the wrong thing. `cron_list` gives the model both facts (`signal_30d`, `quiet_streak`), so asking
"which of my loops are worth keeping" gets an answer from the numbers rather than the names.

## When something looks wrong

Every diagnostic a pi process produces is written to `logs/pi-<pid>.log` in the loops directory —
jobs that were disabled, writes that failed, sub-agent warnings — so a loop that failed at 03:00
still has something to read at 09:00. `/cron scheduler` prints the path. The headless host writes
`host.log` the same way; both are rotated.

`PI_LOOPS_DEBUG=1` adds a line per tool call, provider retry and compaction to that log, which is
the quickest way to tell a stuck run from a busy one.

`/cron snapshot` writes a `pi_loops_snapshot` entry into the session: which MCP servers connected
and what they exposed, the active tools, the hooks, whether this pi owns the clock, the last
check. One is written automatically whenever that state changes. The TUI panel shows the same
thing; the entry is for a front end that is not a terminal — the browser one in
[src/web.mjs](../src/web.mjs) reads it, and so can anything else that speaks to a session.

`/triggers running` shows how long each run has been going and, for loop runs, the transcript that
is being written right now (`pi --session <file>`), so "is it stuck or is it working" is answerable
before the run ends. A run gets the tools the
session that owns the clock has active (a job's `--tools` narrows that, never widens it), plus its
own project's MCP servers, and the automation tools it calls act in its own project.

An unattended run refuses a corpus of dangerous commands: sudo, `curl … | sh`, writing to a block
device, `mkfs`, `chmod 777 /`, shutdown/reboot, `git push --force` on main/master, pipes into
`eval`, the fork bomb, and `rm -r -f` aimed at `/`, an absolute path or `$HOME`. The model is told
why and can do the safe part.

When the last pi on the machine quits, it hands the clock to a headless host (`/cron host`): a
small `node` process with the same stores and runner that keeps loops, trigger checks and MCP
pushes going — findings still reach the inbox — until the next pi opens and takes the clock back.
It is started only when there is work for it: an enabled loop or rule for this machine, or an MCP
server whose pushes inject or have rules to match. `pi-loops host status` shows what it is doing
while it runs, and `pi-loops host abort <id>` interrupts one run (see [cli.md](cli.md)). `[host] auto = false` turns that off;
`/cron host start` hands off on quit anyway (this pi only), `/cron host stop` ends a running host
and cancels the hand-off. `host.log` shows what it did; a host that died is reported by the next
pi to open. After a reboot nothing runs until a pi opens (which hands off again when it quits).
