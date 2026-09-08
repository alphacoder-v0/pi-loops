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

Each run starts a fresh `pi -p` sub-agent (full tools, the session's model and thinking level, no
conversation history) with this prompt shape:

```text
[loop-state] (your notes from the previous run of this loop)
<contents of the state file, or "(first run)">
[/loop-state]

<your prompt>

Output protocol (mandatory):
- End your reply with <loop-state>…</loop-state>: notes for the next run (replaces the saved state; ≤2000 chars).
- For each finding a human should act on, emit <inbox>one concise line</inbox>. No findings → no tags.
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

Global JSONL, shared by every session and project. Entries carry `id` (`inb-<32 hex>`), `source`
(`cron:<job>`), the finding, the run id, and a `new → claimed | dismissed` status.

```text
/inbox                 Inbox (N new): numbered list, newest last
/inbox all             history including claimed and dismissed
/inbox claim <n|id>    mark claimed and start a real agent turn: "A recurring loop (…) reported this finding — investigate and address it: …"
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

Jobs live in `~/.pi/agent/loops/jobs.json` and survive pi restarts. Exactly one pi process on the
machine owns the timer (`scheduler.json`, 30-second ticks, 90-second heartbeat); when it exits or
dies another open pi takes over on its next tick. A tick that was missed while no pi was running is
fired once at startup (collapsed, not replayed) unless the job was created with `--no-catchup`.
`/cron scheduler` shows who owns the timer.
