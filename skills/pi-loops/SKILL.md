---
name: pi-loops
description: Schedule recurring or one-off work (cron jobs, stateful loops with an inbox, maker/checker verification) and condition-based triggers with the pi-loops tools. Use when the user asks to check, watch, monitor, remind, or run something later or periodically.
---

# pi-loops: cron, loops, triggers, inbox

The user's pi has pi-loops installed. Prefer its tools over ad-hoc `sleep` loops or shell cron.

## Pick the right primitive

| The user wants… | Use |
|---|---|
| "every day at 9 / hourly / 每小时 …" and the result belongs in this chat (a reminder, a question to answer here) | `cron_create` with `stateful: false` — it belongs to this session; while the session is closed, it runs in the background in the conversation, so the answer is there when the user comes back. Each run is a model turn. Its turns run with the chat's built-in tools under the dangerous-command guard. A dangerous command, or a command outside the job's built-in tools, is not run: pi-loops asks the person, in the conversation and in the inbox, and the turn goes on without it. A call of cron_remove, set_cron_job_state, remove_trigger or set_trigger_state is asked about the same way. Another built-in tool outside them is refused. pi-loops' other tools, and a tool of another extension or an MCP server, run. In the background they also run without this window's -e extensions or flags |
| work whose result should not land in a conversation — a nightly digest, a report, a watch | `cron_create` with `stateful: true`, even when the user did not say "loop" |
| recurring watch/triage: "check X and tell me what changed", "report new issues" | `cron_create` with `stateful: true` — the loop keeps notes between runs and reports findings to `/inbox` instead of interrupting the chat |
| the findings must be double-checked before the user sees them | `cron_create` with `stateful: true, verify: true` (a second adversarial sub-agent reviews each finding) |
| "when <condition> happens, do <action>" (a file appears, a PR merges, a build finishes) | `new_trigger` — condition + action, fires once unless the user asks for repeating |
| a reminder in N minutes | `cron_create` with schedule `in 10m` |
| run the project's issue tracker as a standing process (triage, build, review), an experiment loop against a research contract, a CI or dependency sweeper, a PR watch, a daily digest | tell the user to run `/recipe list` and `/recipe add <name>` — a packaged set of loops installed with one confirmation; do not recreate it with `cron_create` |

Never use `new_trigger` for time-based schedules; never use `cron_create` for conditions.

## Schedules

5-field cron (local time), `hourly` / `daily` / `weekly`, crontab's `@hourly` / `@daily` /
`@weekly` / `@monthly`, `every 30m`, `in 10m`, `at 2026-09-08T18:00`. `daily` means 09:00 local;
`@daily` means midnight.

Everything is the machine's own clock, and it has no timezone of its own to set: `0 9 * * *` is nine
in the morning where the machine is. With `at`, give a time and not only a date — `at 2026-09-08` is
midnight **UTC** by JavaScript's rule, while `at 2026-09-08T18:00` is local as you would expect. A
job that must run once a day and never twice is safer as `every 24h`: clocks go back one night a
year, and a job at `0 1 * * *` runs twice that night while one at `0 2 * * *` on the night they go
forward does not run at all.

## Writing a stateful loop prompt

The loop runs in a fresh sub-agent whose only memory is its own notes. Tell it what to track and
what counts as a finding, e.g. "check the GitHub issues of this repo; keep the ids you have already
reported in your notes; report only new or newly closed issues". Findings should be one line each.

## When a loop should call `wake_me`

Inside a loop's run, `wake_me` is the one way to change when the loop runs next. Call it when the
run knows of a time that matters to what it watches:

- Something is about to change, and the next scheduled run is too late: "CI on #12 finishes in
  about 20 minutes" is `wake_me({ when: "in 20m", note: "check CI on #12" })`.
- Nothing can change for a while, and the scheduled runs before then cost money for nothing:
  "nothing before Monday" is `wake_me({ when: "at <Monday 09:00 with its offset>", note: "...",
  quiet: true })`.

Do not call it to run more often in general: change the schedule for that (the user runs `/cron set
<ref> --schedule`). A loop has one wake, and a second call replaces the first. A wake is 60 seconds to
7 days ahead, and at most 24 runs in 24 hours start from wakes. The run a wake starts is a new
session: put what it needs in the note, which it reads under `[woken]`, and in the notes. Outside a
loop's run, `wake_me` is not offered: use `cron_create` for a new job.

## When to propose a gate

A gate is one shell command that runs before each scheduled run of a loop. While it prints what the
last run saw, the run is skipped and no model is called. Propose one with `gate` on `cron_create`
(or `new_trigger`) when the person asks for a watch whose news can be read by a cheap, read-only
command: "tell me about new or updated pull requests every 10 minutes" is `cron_create` with
`gate: "gh pr list --json number,updatedAt"`. Pick a command whose output changes exactly when there
is something new: no timestamps of now, no counters that move on their own. Keep it one line.

Only a person sets a gate. Pass `gate` only in the person's own turn, where the call proposes and
the person sees the command on the card. Where the tool creates at once (inside a loop's run, a
scheduled turn, a pi with no UI) a `gate` is refused whole. For `cron_create` the refusal is `a gate
needs a person: set it with /cron set <name> --gate`: create the job without it and tell the person
they can add one with that command. For `new_trigger` it is `a gate needs a person: new_trigger with a
gate proposes the rule, and the person sets it up`: a rule's gate comes only from a proposal. Inside a gated run, the `[gate]` block shows what the command printed this time.

## Triage

`/inbox` lists findings; `/inbox claim <n>` is the user's yes: the loop's run that reported the
finding picks it up in the background, not in this chat; `/inbox cancel <n>` takes back a yes that
has not started; `/inbox dismiss <n> [reason]` (a reason is shown to the loop's next run, so a
finding the user calls noise can say why).
`/cron` lists jobs, `/cron runs`, `/cron trace <job> [k]` shows what a run did. `/triggers rules`,
`/triggers audit` for dynamic triggers.
From a shell: `pi-loops inbox list --json`, `pi-loops inbox claim <id> --json`,
`pi-loops inbox dismiss <id> --reason <text> --json`.

## When a call is asked about

In a loop's or a rule check's run in the background, a dangerous call (or one that reads or writes
pi-loops' own files, or runs `pi-loops inbox claim` and the like) does not run. The result starts
with `asked a person:` and the question goes to the user's inbox. Do not wait for the answer, and do
not try another way to do the same thing. Finish what does not need the call, and say in the report
what is waiting on the user. If the user says yes, pi-loops resumes this run later and lets that one
call through once. A result that starts with `refused by pi-loops:` asked nobody: report what you
would need a person for.

## Confirmations

In the user's own turn in a pi with a UI, `cron_create` and `new_trigger` do not set anything up: they return
`proposed ...`, and the user sees a card ("Set up this watch?"). Nothing runs until they say yes.
Do not wait for the answer, do not do the action now, and do not call the tool again for it: a
message in the conversation tells you later what they chose (`[Trigger rcp-…] The person
answered …`). `new_trigger` proposes in a scheduled turn too. In a pi with no UI (`pi -p`),
`cron_create` creates the job at once and `new_trigger` is refused: nobody could answer a card. `cron_list` and `list_triggers` mark
a proposal `[proposed]`, and `set_cron_job_state` and `set_trigger_state` refuse one.
Removing a trigger, and re-enabling a job or trigger, asks the user to confirm. If the user cancels or declines, stop: do not retry with different arguments,
do not set it up another way, and do not do the action now.
