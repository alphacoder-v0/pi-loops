# What a program may depend on

pi-loops has three interfaces for programs, and this page is all of them. Everything else is
private and changes without notice: **any file under `~/.pi/agent/loops` is not an interface**
(`jobs.json`, `inbox.jsonl`, `runs.jsonl`, `state/`, `host.json`, the logs — `hooks.toml` is the one
exception, below), and neither is the wording of a slash command, the browser page or its rpc
stream. `test/downstream/` holds these three to their word from the outside, with `sh` and `jq`.

## 1. A recipe is a directory

`recipe.toml` and the Markdown playbooks it names, side by side. `pi-loops recipe add ./dir` and
`/recipe add ./dir` accept it and copy the playbooks to `<project>/.agents/skills/<name>/`. A
manifest that breaks a rule is refused before anything is copied, and the command exits non-zero.

```toml
name = "nightly-audit"            # required: a letter, then lowercase letters, digits, dashes; at most 64
summary = "one line"              # required
levels = ["report", "propose"]    # required: one or more of report, propose, act
needs_tracker = false             # optional: the project needs docs/agents/issue-tracker.md (/recipe add writes it with you)
setup = "setup.sh"                # optional: a file in the directory, shown to a person, then run once
files = ["extra.md"]              # optional: more files copied beside the playbooks
tier = "starter"                  # optional: starter | advanced (default)
useful_when = ["one sentence"]    # optional
needs = ["gh"]                    # optional: gh, git-remote, ci-workflows, lockfile, tracker-github
needs_propose = ["git-remote"]    # optional: the same, checked at propose and act
budget_hint_usd = 5               # optional

[[job]]                           # one or more; each is a /cron add line
name = "audit"                    # required
schedule = "0 3 * * *"            # required: a cron expression or `every <duration>`; never in/at
playbook = "audit.md"             # required: a .md file in the directory; optional: verify, timeout, thinking, tools, prompt
```

A playbook is Markdown with `name` and `description` frontmatter; the install writes `Autonomy: <level>`
as the first line of its body, or sets the one that is there.

## 2. `run_start` and `run_end` in `hooks.toml`

`~/.pi/agent/loops/hooks.toml`, one `[[hook]]` per rule, `command` (run through `sh -c`) or `webhook`:

```toml
[[hook]]
event = "run_end"                 # or run_start
command = 'echo "$PI_RUN_JOB $PI_RUN_OK" >> ~/runs.log'
```

Both fire around every scheduled run, in a pi window and in the headless host alike. The command
gets `PI_HOOK_EVENT`, `PI_RUN_JOB` (the job's name, else its id), `PI_RUN_ID` (`run-<32 hex>`) and,
on `run_end`, `PI_RUN_OK` (`true` | `false`), `PI_RUN_FINDINGS`, `PI_RUN_ERROR` and
`PI_RUN_COST_USD`. `PI_HOOK_PAYLOAD` is the path of a JSON file with `event`, `run_job`, `run_id`,
`run_ok`, `run_findings`, `run_error`, `run_cost_usd` (`null` where not applicable, and the
variable is then unset); a webhook receives that JSON as its body. A hook that fails or hangs never fails the run.

## 3. `pi-loops inbox … --json`

No pi needs to be open. Exit 0 and one JSON object on stdout; on failure exit 1 and `{"error": "<why>"}`.

```
pi-loops inbox list [--all] [--cwd <dir>] --json      {"findings": [<finding>, …]}
pi-loops inbox claim <id> --json                       {"finding": <finding>}   now "claimed"
pi-loops inbox dismiss <id> [--reason <text>] --json   {"finding": <finding>}   now "dismissed"
```

`list` is what `/inbox` shows: the new findings of the project at `--cwd` (default: the current
directory), checkpoints first, then news, each oldest first; `--all` is every project. `claim` and
`dismiss` take a finding's `id`, or a unique prefix of it (never a number), among the new findings machine-wide, and
do what `/inbox claim` and `/inbox dismiss` do to the entry: `claim` marks it and stops, since there
is no session to hand it to; a `--reason` is shown to the loop's next run. A finding:

```json
{"id": "inb-<32 hex>", "created_at": "2026-09-16T09:00:00.000+08:00", "status": "new",
 "kind": "checkpoint", "source": "cron:nightly-audit", "run_id": "run-<32 hex>",
 "cwd": "/path/to/project", "text": "one line, at most 500 characters",
 "verified": null, "dismiss_reason": null}
```

`status` is `new` | `claimed` | `dismissed`; `kind` is `checkpoint` (a decision a person owes) |
`news`; `run_id` is the `PI_RUN_ID` of the run that filed it (a trigger's trace id for a trigger);
`verified` is `true` | `false` after a checker, else `null`; `text` is redacted as on screen.
Fields may be added to any object here; none of these will be renamed, removed or change type.
