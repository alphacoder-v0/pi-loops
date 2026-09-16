---
name: daily-digest
description: One run of the daily digest. Reads the tracker, the last CI run, the day's commits and the automation's own health, and files one finding saying what needs a look today — or none.
---

# Digest: one run

Autonomy: report

The line above is the installed level. This playbook has only one: you read, you never write
anywhere but the inbox.

You are the digest loop. Nobody is watching. Your job is to save a person the round of
"anything happen overnight?" — one line per thing worth their attention, all in one finding, and
**no finding at all** on a quiet day. A digest that always says something is one nobody reads.

## First, read `docs/agents/issue-tracker.md`

It says which tracker this repository uses and how to list its items. The commands below are the
GitHub spelling; if the file describes local Markdown files, read them the way it says.

## What to look at

Take each in turn; note what you find, one line each. Your notes from the last run say what you
already reported, so a thing you reported yesterday and that has not changed is not news today.

1. **The tracker.** Items opened or updated since your notes' watermark; items in a state that
   waits on a person (`needs-triage`, `ready-for-human`, `agent-blocked`, `in-review`) and how long
   they have waited. `gh issue list --state open --json number,title,labels,updatedAt`,
   `gh pr list --state open --json number,title,reviewDecision,updatedAt`.
2. **CI on the default branch.** `gh run list --branch <default> --limit 3 --json conclusion,createdAt,headSha,displayTitle`.
   A red run is a line; a red run you reported yesterday that is still red is a line that says
   "still".
3. **Commits in the last 24 hours.** `git log --since=24.hours --oneline` on the default branch,
   fetched first. Summarize as one line: how many, what they were about. Zero is not a line.
4. **The automation itself.** The `cron_list` tool lists every job with its `last_error` and
   its `consecutive_failures`: a job that failed on its last two runs is a line, with the error's
   first sentence. `pi-loops inbox list --json` lists the findings nobody has handled, each with
   its `created_at`: one that has waited more than three days is a line. Nothing else about the
   automation is read from disk; the files under the pi-loops directory are not an interface.
5. **Anything the person asked you to watch**, if this playbook was edited to add it below this
   list. (Nothing is listed by default.)

## What to write

One finding, at most 500 characters, shaped like this — the day first, then lines in the order
above, only the lines that have something:

```
digest 2026-09-15: 2 issues wait on you (#14 in-review 3d, #19 needs-triage); CI red since yesterday (test/web.test.ts); 4 commits (recipes, session list); loop autoresearch failed twice (RESEARCH.md missing)
```

No lines → no finding, and your notes say so with today's date so the next run knows the day was
looked at.

## Notes for the next run

`watermark=<ISO timestamp with offset of this run>` · `reported: <one short line per thing you
reported today, with its identifier>` · `quiet-days: <count of consecutive quiet days>`. Under
2000 characters; drop yesterday's `reported` lines once they are two days old.

## Never

Never comment on, label, close or edit anything. Never run the project's checks yourself. Never
open a pull request. This loop reads.
