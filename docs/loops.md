# Cron jobs, stateful loops, the inbox, maker/checker

This mirrors pie's [docs/loops.md](https://github.com/c4pt0r/pie/blob/main/docs/loops.md) and
`crates/coding-agent/src/triggers/cron.rs`. Where pi-loops behaves differently it says so.

## Plain cron jobs

```text
/cron add "*/30 * * * *" summarize the repo state
```

When due, the prompt is injected into the session that created the job as a user message with the
engine prefix `[Trigger <run-id>] `, and the agent runs one turn (pie's *InjectAndRun*). If the agent
is busy the message is queued as a follow-up. Plain jobs fire only from the process whose current
session created them; `--resume` brings that back.

Schedules are local time: 5-field cron (`*/n`, ranges, lists, `mon-fri`, `jan`), pie's aliases
(`hourly` / `every hour` / `once an hour` → `0 * * * *`; `daily` / `every day` → `0 9 * * *`;
`weekly` → `0 9 * * 1`; `每小时`, `每天`, `每周`), plus `@daily`-style aliases, `every 30m`,
`in 10m` and `at 2026-09-08T18:00` (one-shot jobs are removed after they fire).

## Stateful loops

```text
/cron add --stateful "0 9 * * *" check the repo issues and report anything new since the last run
```

Each run is a fresh sub-session inside the interactive pi — pie's in-process SubAgent, through
pi's SDK: full tools including the parent's live MCP servers, the session's model and thinking
level, no conversation history, its own transcript file — with this prompt shape — pie's block verbatim, preceded by one line of
context pie does not have (the job's name, when the run started, whether it is a catch-up):

```text
You are running the recurring loop "<name>" (current run started 2026-09-09 09:00 UTC). This is a background run: nobody is watching, and your final reply is parsed by a program.

[loop-state] (your notes from the previous run of this recurring job)
<contents of the state file, or "(first run)">
[/loop-state]

<your prompt>

Output protocol (mandatory):
- End your reply with <loop-state>notes for the next run</loop-state> — it REPLACES the saved state; keep it under 2000 characters and make it the information your next run needs (baselines, ids already seen, watermarks).
- For each finding a human should act on, emit <inbox>one concise line</inbox>. No findings → no inbox tags; do not invent work.
- Keep everything after the last tool call short so the tags are not truncated.
```

Then, exactly like pie:

- the last `<loop-state>` block replaces `state/<id>.md` (capped at 2000 characters);
- up to 16 `<inbox>` tags (each ≤500 characters) are appended to the inbox; extras are counted as dropped;
- missing or malformed tags never fail a run: the state stays untouched, nothing enters the inbox;
- a run that is still going when the next tick arrives is skipped and counted (`skipped overlaps`).

pi-loops additionally keeps the sub-agent's full transcript (`/cron trace <job> [k]`, 20 per job),
a run log with exit code, duration, cost and finding counts (`/cron runs`), and shows a card in the
transcript when a run finishes. Prompts are capped at 8 KB (pie: 4 KB).

## The inbox

Global JSONL, shared by every session and project, in pie's record shape (`id` = `inb-<32 hex>`,
`created_at`, `source` = `cron:<job>`, `text`, `trace_id` = the run id, `session_id`, `status`
`new → claimed | dismissed`) plus pi-loops' `job_id`, `cwd`, `claimed_by`, `verified`,
`verified_reason`. Job ids are `cron-<32 hex>` like pie's; prefixes, names and list numbers resolve.

```text
/inbox                 Inbox (N new): "<n>. [<id prefix>] <finding>  (<source>, <created_at UTC>)"
/inbox all             history including claimed and dismissed
/inbox claim <n|id>    mark claimed and start a real agent turn:
                       "A recurring loop (<source>, running in <cwd>) reported this finding — investigate and address it: …"
                       (pie's wording plus the loop's cwd; a checker-kept finding adds a line saying so)
/inbox dismiss <n|id>  /inbox clear
```

Corrupt lines are skipped on read and never deleted. The footer shows `Inbox: N new`; the side
panel shows it too. Entries kept by the checker carry a `✓`.

## Maker/checker (`--verify`)

pie's phase 3, sketched in its issue 23 and implemented here. With `--verify` (implies
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

Jobs live in `~/.pi/agent/loops/jobs.json` and survive pi restarts. Exactly one pi process per
host owns the timer (`scheduler.<host>.json`, 30-second ticks, 90-second heartbeat); when it exits
or dies another open pi takes over on its next tick. A tick that was missed while no pi was running
is fired once at startup (collapsed, not replayed) for stateful loops unless `[cron] catch_up = false`;
plain inject jobs do not catch up unless created with `--catchup` (`--no-catchup` turns it off for
loops). A run that died with its process is retried on the next tick; at most
`[cron] max_concurrent_runs` (3) run at once. Jobs run with the model and thinking level recorded
on them (`/cron set <id> --model … --thinking … --timeout …`, `-` to follow the running session).
`/cron scheduler` shows who owns the timer; `/cron` marks jobs as `[dormant …]` when their session
is not open here, parks them as disabled once that session no longer exists (`/cron gc` removes
them), and `[orphan: cwd missing]` (auto-disabled) when their checkout is gone. A job created by a
sub-agent belongs to the session that ran it, like pie's parent cron.toml. A job stamped with
another machine's hostname (a synced `$HOME`, a renamed machine, a rebuilt container) is listed as
`[other host: <name>]` with no next run; `/cron set <ref> --host here` re-homes it.

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
busy morning would stop capping halfway through the day. pie has the same primitive
(`budget_cap_usd`) but never exposes it, because its loops die with the session — a headless host
runs for days, so a cap is the only thing bounding the bill.

Trigger checks share `[cron] max_concurrent_runs`: a server pushing many distinct events can no
longer open one sub-agent per event.

If a loop is stuck showing `running` after a process was killed and its pid reused, `/cron clear
<ref>` releases the marker (it asks first).

`/cron disable --all` pauses every job in this project (`--all-projects` for the machine) and
`/cron enable --all` resumes them — quitting pi hands the clock to the host rather than stopping
anything, so this is how you actually go quiet.

`/cron remove` keeps the loop's notes (removing and re-adding is how a schedule or prompt gets
changed); `--purge` deletes them, and `/cron gc` reports state left behind by jobs that are gone.
`/cron gc` collects this project's jobs whose session is gone; `--all` collects every project's.

A job that fails three times in a row is retried on a widening gap (5 minutes, doubling, up to six
hours) instead of at every due tick, and says so; one success clears the streak.

## When something looks wrong

Every diagnostic a pi process produces is written to `logs/pi-<pid>.log` in the loops directory —
jobs that were disabled, writes that failed, sub-agent warnings — so a loop that failed at 03:00
still has something to read at 09:00. `/cron scheduler` prints the path. The headless host writes
`host.log` the same way; both are rotated.

`PI_LOOPS_DEBUG=1` adds a line per tool call, provider retry and compaction to that log, which is
the quickest way to tell a stuck run from a busy one.

`/triggers running` shows how long each run has been going and, for loop runs, the transcript that
is being written right now (`pi --session <file>`), so "is it stuck or is it working" is answerable
before the run ends. A run gets the tools the
session that owns the clock has active (a job's `--tools` narrows that, never widens it), plus its
own project's MCP servers, and the automation tools it calls act in its own project.

An unattended run refuses pie's dangerous-command corpus: sudo, `curl … | sh`, writing to a block
device, `mkfs`, `chmod 777 /`, shutdown/reboot, `git push --force` on main/master, pipes into
`eval`, the fork bomb, and `rm -r -f` aimed at `/`, an absolute path or `$HOME`. The model is told
why and can do the safe part. pie applies the same policy to its sub-agents.

When the last pi on the machine quits, it hands the clock to a headless host (`/cron host`): a
small `node` process with the same stores and runner that keeps loops, trigger checks and MCP
pushes going — findings still reach the inbox — until the next pi opens and takes the clock back.
It is started only when there is work for it: an enabled loop or rule for this machine, or an MCP
server whose pushes inject or have rules to match. `pi-loops host status` shows what it is doing
while it runs, and `pi-loops host abort <id>` interrupts one run (see [cli.md](cli.md)). `[host] auto = false` turns that off;
`/cron host start` hands off on quit anyway (this pi only), `/cron host stop` ends a running host
and cancels the hand-off. `host.log` shows what it did; a host that died is reported by the next
pi to open. After a reboot nothing runs until a pi opens (which hands off again when it quits).
