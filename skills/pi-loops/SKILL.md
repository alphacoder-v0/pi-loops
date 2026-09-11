---
name: pi-loops
description: Schedule recurring or one-off work (cron jobs, stateful loops with an inbox, maker/checker verification) and condition-based triggers with the pi-loops tools. Use when the user asks to check, watch, monitor, remind, or run something later or periodically.
---

# pi-loops: cron, loops, triggers, inbox

The user's pi has pi-loops installed. Prefer its tools over ad-hoc `sleep` loops or shell cron.

## Pick the right primitive

| The user wants… | Use |
|---|---|
| "every day at 9 / hourly / 每小时 …" run something, result in this chat | `cron_create` with `stateful: false` |
| recurring watch/triage: "check X and tell me what changed", "report new issues" | `cron_create` with `stateful: true` — the loop keeps notes between runs and reports findings to `/inbox` instead of interrupting the chat |
| the findings must be double-checked before the user sees them | `cron_create` with `stateful: true, verify: true` (a second adversarial sub-agent reviews each finding) |
| "when <condition> happens, do <action>" (a file appears, a PR merges, a build finishes) | `new_trigger` — condition + action, fires once unless the user asks for repeating |
| a reminder in N minutes | `cron_create` with schedule `in 10m` |

Never use `new_trigger` for time-based schedules; never use `cron_create` for conditions.

## Schedules

5-field cron (local time), `@daily`, `hourly` / `daily` / `weekly`, `every 30m`, `in 10m`,
`at 2026-09-08T18:00`. `daily` means 09:00 local, like pie.

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

## Triage

`/inbox` lists findings; `/inbox claim <n>` hands one to you as a real turn; `/inbox dismiss <n>`.
`/cron` lists jobs, `/cron runs`, `/cron trace <job> [k]` shows what a run did. `/triggers rules`,
`/triggers audit` for dynamic triggers.

## Confirmations

Creating or removing a trigger, and re-enabling a job or trigger, asks the user to confirm. If the
confirmation is declined, stop; do not retry with different arguments.
