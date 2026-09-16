# pi-loops — CONTRACT

Version 0.21 · 2026-09-16 · Status: draft · Section 2 frozen at 29 lines

This file does one thing. It says which things never change (the contract), which things can be
replaced at any time (the mechanisms), and how to prove that a mechanism has not quietly become
part of the contract (the refinement checks). Section 2 says what the project is. Every other
section can be deleted or rewritten without changing the project.

## 0. One sentence

The loops directory on one machine holds jobs, findings and each loop's notes. pi-loops runs the
jobs on a clock, queues the findings, and emits an event before and after each run. A program
talks to it only through a recipe directory, `hooks.toml`, and the `pi-loops inbox` command.

## 1. Terms

- **Loops directory**: the directory pi-loops reads and writes on one machine (default
  `~/.pi/agent/loops`, overridden by `PI_LOOPS_DIR`).
- **Project**: the directory a job runs in (`cwd`).
- **Job**: one schedule and one prompt, belonging to one project.
- **Run**: one execution of a job, with one `run_id`.
- **Finding**: one line a run leaves for a person, with a status `new`, `claimed` or `dismissed`.
- **Notes**: the Markdown a loop's run leaves for its next run.
- **Recipe**: a directory: `recipe.toml` and the playbooks it names.
- **Playbook**: the Markdown a run reads, copied into the project at install.
- **Level**: the line `Autonomy: report | propose | act` in a playbook.
- **Event**: the payload a `hooks.toml` rule sees when a run starts and when it ends.

## 2. Contract (MUST)

### 2.1 Instance

- Instance data in the loops directory: the jobs, the trigger rules, the findings, the notes, the run records (including each run's transcript), `hooks.toml`, `config.toml`, `mcp.toml`. Every other file and directory there is private state and can be deleted at any time.
- Instance data in a project: the playbooks and recipe files installed under `.agents/skills/<recipe>/`, and, when a recipe declares `needs_tracker`, `docs/agents/issue-tracker.md`.
- Tool code does not enter an instance. Instance data does not enter the tool.

### 2.2 Unit formats

- **Recipe**: `recipe.toml` is TOML. Required: `name` (a lowercase letter, then lowercase letters, digits and hyphens), `summary`, `levels` (non-empty, from the three levels), at least one `[[job]]`. Each `[[job]]` requires `name`, `schedule` (a recurring schedule) and `playbook` (a file in the same directory). Optional keys: `needs_tracker`, `setup`, `files`, `tier`, `useful_when`, `needs`, `needs_propose`, `budget_hint_usd`; per job `verify`, `timeout`, `thinking`, `tools`, `prompt`.
- **Playbook**: Markdown with pi's skill frontmatter (`name`, `description`), one level line, and one `## Never` section.
- **Finding**: one JSON object with the fields `id`, `created_at` (RFC 3339), `status`, `kind` (`checkpoint` | `news`), `source`, `run_id`, `cwd`, `text`, `verified` (`true` | `false` | `null`), `dismiss_reason` (string | `null`). Fields are only added at the end; none is renamed, removed or changed in type.
- **Event**: `run_start` and `run_end`. The payload has `run_job` and `run_id`; on `run_end` also `run_ok`, `run_findings`, `run_error`, `run_cost_usd`. Each field also enters the command's environment as `PI_<FIELD IN UPPER CASE>`, unset when the payload has `null`.
- **Rule**: a `[[hook]]` in `hooks.toml` with `event` and either `command` or `webhook`.

### 2.3 Permitted actions

- **Install a recipe**: copy the playbooks into the project with the level line written, and create the jobs the manifest declares. A manifest that breaks a rule is refused whole; no file is copied.
- **Run**: emit one `run_start` and one `run_end` with the same `run_id`. The run's findings enter the queue with `status = new` and `run_id` = that run.
- **Claim** and **dismiss**: take a finding's `id` or a unique prefix of it, and succeed once each, only on a `new` finding. Dismiss can carry a `reason`, written to `dismiss_reason`.

### 2.4 Ledger

The events are the ledger of runs: each run has exactly one `run_start` / `run_end` pair. A finding's `status` is its own ledger: `new → claimed` or `new → dismissed`, never back.

### 2.5 Write conditions

A finding is written only by a run, and its `text` is what the run said. `status` changes only through claim or dismiss. A rule that fails or hangs does not change the run's result. An install is complete or does not happen.

### 2.6 Deterministic rules

- `kind`: `text` contains `· waits:` (preceded by the start of the text or whitespace, case-insensitive) → `checkpoint`; otherwise `news`.
- Level line: the first line that is exactly `Autonomy: <one word>`. When that word is one of the three levels, it is the level; otherwise the playbook has no level.
- Manifest validity: the required keys and values of 2.2. TOML is parsed as standard TOML.

### 2.7 Downstream interface

1. A recipe is a directory. `/recipe add <dir>` and `pi-loops recipe add <dir>` install it.
2. A `hooks.toml` rule with `event = "run_start" | "run_end"` receives the event of 2.2.
3. `pi-loops inbox list [--all] [--cwd <dir>] --json`, `inbox claim <id> --json`, `inbox dismiss <id> [--reason <text>] --json`: exit 0 and one JSON object (`{"findings": [...]}` or `{"finding": {...}}`); on failure exit 1 and `{"error": "<why>"}`.

Any file, field, path or command not listed above is not an interface.

### 2.8 Boundary

That is all. This section fits on one screen.

## 3. Mechanisms (SHOULD, replaceable)

Three sentences each: what it is, what it depends on, and why the contract does not move when it is replaced.

- **Findings are stored in `inbox.jsonl`, one object of 2.2 per line.** Depends on line-atomic appends. Another container keeps the object; `inbox` returns it as before.
- **An id is `inb-` and 32 hex characters; a run_id is `run-` and the same.** Depends on `randomBytes(16)`. The contract asks only that ids be unique and resolvable by prefix.
- **`created_at` carries the local UTC offset.** Depends on `stamp()` in `schedule.ts`. The contract asks only for RFC 3339.
- **`source` is `cron:<job name or id>`.** Depends on the scheduler. The contract asks only for a string.
- **`inbox list` puts checkpoints first, then news, each oldest first.** Depends on the sort in `inbox.ts`. The contract asks only for the right set.
- **A finding's `text` is at most 500 characters, a run files at most 16, notes are at most 2000 characters, a prompt at most 8 KB.** Depends on the model's context and the queue staying readable. Changing a number does not touch 2.2.
- **`inbox.jsonl` drops its oldest handled entries past 1 MB.** Depends on disk and list length. The contract only requires that `new` findings can be listed.
- **Jobs live in `jobs.json` (`version: 2`), notes in `state/<id>.md`, run records in `runs.jsonl`.** Depends on the current store. A job's full description is its `/cron add` line; reinstalling the recipe recreates it.
- **An install leaves an `.orig/` copy and `.recipe.json` in the project and lists the directory in `.git/info/exclude`.** Depends on the three-way merge of `/recipe update` and on keeping playbooks out of the repository's history. Another merge strategy leaves 2.1 and 2.3 as they are.
- **The values of `needs` and `needs_propose` are the preflight checks this version performs (`gh`, `git-remote`, `ci-workflows`, `lockfile`, `tracker-github`).** Depends on this version's set of checks. A recipe that names a check this version does not have is refused; that binds the recipe to a version and does not change the contract.
- **A recipe name is at most 64 characters.** Depends on the install directory name staying readable.
- **A rule's command times out after 5000 ms, its stdout is cut at 4000 characters, summaries at 2000, and the host drains for 3 seconds before it exits; output goes to `logs/pi-<pid>.log` or `host.log`.** Depends on log rotation. Changing any of these numbers leaves the event fields of 2.2 as they are.
- **Creating a job needs a pi (interactive, or `pi --mode rpc`).** `pi-loops recipe add` in a terminal only copies files and prints the `/cron add` lines. Depends on the decision that a job belongs to a session. The "create the jobs" of 2.3 is done by `/recipe add` inside pi.
- **A headless host runs the jobs while no pi is open.** Depends on the process hand-off. Events and findings have the same shape in both processes.

## 4. Not done

- No public format for `jobs.json`: a job is created by a recipe install or by a person in pi, and a reinstall recreates it (2.3 + mechanism "jobs live in `jobs.json`").
- No second on-disk shape for a finding (such as another tool's field names): a line is the object of 2.2, and another tool reads it as it is (2.2 + mechanism "`inbox.jsonl`").
- Playbooks do not read files in the loops directory: a run learns its own health from the `cron_list` tool and the findings from `pi-loops inbox` (2.7).
- `mcp.toml` is not a program interface: it is a person's configuration file (instance data in 2.1, not in 2.7).
- No command that creates a job from a terminal: `pi --mode rpc` already runs `/recipe add` without a terminal (mechanism "creating a job needs a pi").
- No multi-machine support: one loops directory belongs to one machine (design.md, decision 19).

## 5. Refinement checks

The scripts are in `test/contract/`. `sh test/contract/run.sh` runs all five; each also runs alone.

1. **Second implementation** `test/contract/1-second-implementation.sh`: `test/downstream/closed-loop.sh` (sh and jq install a recipe, let it run, find its finding by `run_id` and claim it, touching no private file), then python3 `tomllib` reads every packaged `recipe.toml` and checks the required keys of 2.2; then every packaged recipe is installed with `pi-loops recipe add` and its files are searched for the names of the loops directory's files. Pass: every step exits 0 and no playbook names a private file. A failure means private state has leaked into the contract, or a recipe depends on it.
2. **Stopped machine** `test/contract/2-stopped.sh`: with no pi and no host running, write a `hooks.toml` rule, install a directory with `pi-loops recipe add`, and dismiss a finding with `pi-loops inbox dismiss`. Pass: all three succeed. A failure means a write depends on a mechanism.
3. **Cross-check** `test/contract/3-cross-check.sh`: four rules, each run through two implementations that share nothing, over the same samples; pass when the outputs are equal line for line. TOML: `src/toml.ts` against python3 `tomllib`, over every `recipe.toml` in the repository and `examples/mcp.toml`. `kind`: `src/protocol.ts` against `grep -E`, over every `<inbox>` text the repository has shown. Level line: `src/recipe.ts` against `awk`, over every playbook in `recipes/` and in this repository's `.agents/skills/`. Finding: `pi-loops inbox list --all --json` against `jq` reading the ten fields of 2.2 off each line of `inbox.jsonl` directly. Event: the same loop run once by the host and once by a pi driven over rpc; the two `run_end` payloads have the same fields and the same run values.
4. **Private state cleared** `test/contract/4-private-state.sh`: after one run, delete everything in the loops directory that 2.1 does not name as instance data and start the host again. Pass: it runs the loop again and the earlier findings are unchanged field for field.
5. **Contract size** `test/contract/5-size.sh`: section 2 has no more non-empty lines than the count frozen in this file's header. Pass when it does not. A line added there must name, in the CHANGELOG, the mechanism it replaced.

## 6. Mapping of requirements and features

| Requirement or feature | Where it lands |
|---|---|
| `docs/downstream.md` §1, the recipe directory | Contract 2.2 / 2.7.1 |
| `docs/downstream.md` §2, the hook events | Contract 2.2 / 2.7.2 |
| `docs/downstream.md` §3, the inbox command and the finding object | Contract 2.2 / 2.3 / 2.7.3 |
| `inb-<32 hex>`, 500 characters and the list order in `docs/downstream.md` | Mechanism |
| `docs/recipes.md`, "Writing a recipe" | Contract 2.2; `.orig/`, `.recipe.json`, exclude, preflight names → mechanism |
| Timeouts, truncation and log paths in `docs/hooks.md` | Mechanism |
| The on-disk line shape (`trace_id`) that `docs/loops.md` used to document | Removed, unreleased: a line is the object of 2.2 (CHANGELOG, "One shape for a finding") |
| The four caps in `docs/design.md`, decision 11 | Mechanism |
| `docs/design.md`, decisions 15–18 (recipes are files, copied into the project, deterministic wizard, the level is a sentence) | Contract 2.1 / 2.2 / 2.3; details → mechanism |
| `recipes/daily-digest` reads `runs.jsonl` and `jobs.json` | Not done, item 3 |
| `examples/mcp.toml` | Not done, item 4 |
| `test/downstream/` | Part of refinement check 1 |

## 7. Revision rules

- The required fields and the actions of section 2 are only added, never changed or removed.
- No number derived from a mechanism appears in the contract.
- A mechanism paragraph can be replaced whole; replacing one only requires rerunning section 5.
- This file is part of the repository; a change to it goes through the ledger.
