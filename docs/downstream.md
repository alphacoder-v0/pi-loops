# What a program may depend on

Three things, and this page is the whole list. A program that is not pi-loops and does not import
its source may rely on these and on nothing else.

**Any file under `~/.pi/agent/loops/` is not an interface.** `jobs.json`, `inbox.jsonl`,
`runs.jsonl`, `state/`, `host.json`, the logs: private, and they change without notice. The one
file there a program writes is `hooks.toml`, and only for the two events below. The same goes for
every command, field and path this page does not name, the wording of the slash commands, and the
browser page.

## 1. A recipe is a directory

`recipe.toml` and the Markdown playbooks it names, side by side; `/recipe add ./dir` and
`pi-loops recipe add ./dir` install it from a local path. What the manifest may say, and what a
playbook is, is one section of [recipes.md](recipes.md#writing-a-recipe). The keys, so a program
knows the vocabulary: `name`, `summary`, `levels`, `needs_tracker`, `setup`, `files`, `tier`,
`useful_when`, `needs`, `needs_propose`, `budget_hint_usd`, and per `[[job]]` `name`, `schedule`,
`playbook`, `verify`, `timeout`, `thinking`, `tools`, `prompt`. A manifest that breaks a rule is
refused before anything is copied.

## 2. `run_start` and `run_end` in `hooks.toml`

A `[[hook]]` rule with `event = "run_start"` or `event = "run_end"` fires around every scheduled
run, in a pi window and in the headless host alike; the file, the rule keys and when the two fire
are in [hooks.md](hooks.md#exactly-when-hooks-fire). What the rule's command sees: `PI_RUN_JOB`,
`PI_RUN_ID` on both, and on `run_end` also `PI_RUN_OK`, `PI_RUN_FINDINGS`, `PI_RUN_ERROR`,
`PI_RUN_COST_USD`, each unset where the payload (`PI_HOOK_PAYLOAD`, a JSON file with the same as
`run_job`, `run_id`, `run_ok`, `run_findings`, `run_error`, `run_cost_usd`) has `null`. A hook
that fails or hangs never fails the run.

## 3. `pi-loops inbox list | claim <id> | dismiss <id> --json`

No pi needs to be open. Exit 0 and one JSON object on stdout; on failure exit 1 and `{"error": "<why>"}`.

```
pi-loops inbox list [--all] [--cwd <dir>] --json      {"findings": [<finding>, …]}
pi-loops inbox claim <id> --json                       {"finding": <finding>}   now "claimed"
pi-loops inbox dismiss <id> [--reason <text>] --json   {"finding": <finding>}   now "dismissed"
```

`list` is what `/inbox` shows: the new findings of the project at `--cwd` (default: the current
directory), checkpoints first, then news, each oldest first; `--all` is every project. `claim` and
`dismiss` take a finding's `id` or a unique prefix of it (never a number), among the new findings
machine-wide, and do to the entry what `/inbox claim` and `/inbox dismiss` do: `claim` marks it and
stops, since there is no session to hand it to; a `--reason` is shown to the loop's next run.

```json
{"id": "inb-<32 hex>", "created_at": "2026-09-16T09:00:00.000+08:00", "status": "new",
 "kind": "checkpoint", "source": "cron:nightly-audit", "run_id": "run-<32 hex>",
 "cwd": "/path/to/project", "text": "one line, at most 500 characters", "verified": null, "dismiss_reason": null}
```

`status` is `new` | `claimed` | `dismissed`; `kind` is `checkpoint` | `news`; `run_id` is the
`PI_RUN_ID` of the run that filed it; `verified` is `true` | `false` after a checker, else `null`.
Fields may be added; none of these will be renamed, removed or change type.

Not listed here means private. `test/downstream/` is the proof this list is enough: a recipe that
uses only it, checked from the outside with `sh` and `jq`.
