# What a program may depend on

Three things, and this page is the whole list. A program that is not pi-loops and does not import
its source may rely on these and on nothing else.

**Any file under `~/.pi/agent/loops/` is not an interface.** `jobs.json`, `inbox.jsonl`,
`runs.jsonl`, `state/`, `host.json`, the logs: private, and they change without notice. The one
file there a program writes is `hooks.toml`, and only for the two events below. The same goes for
every command, field and path this page does not name, the wording of the slash commands, and the
browser page.

The three are named in [CONTRACT.md](../CONTRACT.md) §2.7 and their shapes in §2.2 — that is where
the rule lives, and the text that moves when one of them changes. This page is the three in use.

## 1. A recipe is a directory

`recipe.toml` and the Markdown playbooks it names, side by side; `/recipe add ./dir` and
`pi-loops recipe add ./dir` install it from a local path. What the manifest may say — every key it
requires and every one it allows — is [CONTRACT.md](../CONTRACT.md) §2.2; what a playbook is, and
how one is written, is one section of [recipes.md](recipes.md#writing-a-recipe). A manifest that
breaks a rule is refused before anything is copied.

```toml
# nightly/recipe.toml, beside the audit.md it names
name = "nightly"
summary = "read the day's diff and say what looks wrong"
levels = ["report"]

[[job]]
name = "nightly-audit"
schedule = "0 3 * * *"
playbook = "audit.md"
```

## 2. `run_start` and `run_end` in `hooks.toml`

A `[[hook]]` rule with `event = "run_start"` or `event = "run_end"` fires around every scheduled
run, in a pi window and in the headless host alike; what the payload carries is
[CONTRACT.md](../CONTRACT.md) §2.2, and the file, the rule keys and when the two fire are in
[hooks.md](hooks.md#exactly-when-hooks-fire). Each field reaches the rule's command as a `PI_*`
variable, unset where the payload has `null`, and all of them together as JSON in the file at
`PI_HOOK_PAYLOAD`. A hook that fails or hangs never fails the run.

```toml
[[hook]]
event = "run_end"
command = '[ "$PI_RUN_OK" = false ] && notify-send "loop $PI_RUN_JOB failed" "$PI_RUN_ERROR"'
```

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
machine-wide, and do to the entry what `/inbox claim` and `/inbox dismiss` do — the two actions of
[CONTRACT.md](../CONTRACT.md) §2.3: `claim` marks it and stops, since there is no session to hand
it to; a `--reason` is shown to the loop's next run. The object they print is the one of §2.2,
field for field:

```json
{"id": "inb-<32 hex>", "created_at": "2026-09-16T09:00:00.000+08:00", "status": "new",
 "kind": "checkpoint", "source": "cron:nightly-audit", "run_id": "run-<32 hex>",
 "cwd": "/path/to/project", "text": "one line, at most 500 characters", "verified": null, "dismiss_reason": null}
```

Fields may be added; none of these will be renamed, removed or change type.

Not listed here means private. `test/downstream/` is the proof this list is enough: a recipe that
uses only it, checked from the outside with `sh` and `jq`. `test/contract/` holds the checks of
CONTRACT.md itself.
