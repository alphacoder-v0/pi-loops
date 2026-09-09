# pi-loops

[pie](https://github.com/c4pt0r/pie)'s automation layer for [pi](https://github.com/earendil-works/pi),
shipped as a plain pi extension. Nothing in pi is patched.

> "Stop prompting the agent. Build loops that prompt the agent for you."
> — Addy Osmani, *Loop Engineering*, the design north star pie borrowed

pie is a Rust rewrite of pi that grew cron jobs, **stateful loops with a triage inbox**, dynamic
triggers, MCP notifications and lifecycle hooks into the runtime itself. pi-loops re-creates that
layer on top of pi's public extension API, matching pie's commands, wording, caps and failure modes
source file by source file, and adds the two pieces pie left on its roadmap (maker/checker
verification, loop state in session archives).

中文说明见 [README.zh-CN.md](README.zh-CN.md)。

## Install

```bash
pi install /path/to/pi-loops          # local checkout (what `pi install .` does in this repo)
pi install git:github.com/alphacoder-v0/pi-loops@v0.3.0   # once the repo is hosted; pinned tag
pi update --extensions                # reconcile packages
pi remove /path/to/pi-loops           # uninstall; state stays in ~/.pi/agent/loops until you delete it
pi -e /path/to/pi-loops               # try it for one run without installing
```

Requirements: pi ≥ 0.84, Node ≥ 22.6 (pi loads the TypeScript sources directly). No runtime
dependencies. The package also ships a skill (`skills/pi-loops`) so the agent knows when to reach
for `cron_create`, `new_trigger` and the inbox.

## Quick start

```text
/cron add --stateful "0 9 * * *" check the GitHub issues of this repo and report anything new or newly closed since the last run
```

Every morning a fresh sub-agent runs with the notes it wrote last time, does the work, and ends its
reply with `<loop-state>…</loop-state>` (notes for tomorrow) and `<inbox>one-line finding</inbox>`
tags. State goes to a Markdown file, findings go to the inbox, your conversation is never touched.

```text
/inbox                 # list new findings
/inbox claim 1         # hand finding #1 to the agent as a real turn
/inbox dismiss 2       # not interesting
```

Add `--verify` and a second, adversarial sub-agent checks every finding before it reaches you.

## Commands

| Command | What it does |
|---|---|
| `/cron add [--stateful] [--verify] "<schedule>" <prompt>` | Schedule a job. Plain jobs inject their result into this chat; `--stateful` makes a loop with memory and inbox routing; `--verify` adds the checker. Schedules: 5-field cron, `hourly`/`daily`/`每天`, `every 30m`, `in 10m`, `at <ISO>` |
| `/cron`, `/cron all`, `/cron enable\|disable\|remove <id>` | This project's jobs (or every project), pie's list format and control-plane audit |
| `/cron run`, `/cron state`, `/cron runs`, `/cron trace <job> [k] [checker]`, `/cron scheduler`, `/cron panel` | Fire now, read the loop's notes, run log, full sub-agent transcript, scheduler ownership, side panel |
| `/cron set <job> …`, `/cron gc`, `/cron host [start\|stop]` | Change model/thinking/timeout/name, remove jobs of deleted sessions, the headless host that keeps the clock after the last pi quits |
| `/cron cost [today\|7d\|all]`, `/cron disable --all`, `/cron clear <ref>` | What automation has cost against `[limits] daily_budget_usd`, stop everything, release a stuck run marker |
| `/inbox [all\|claim <n>\|dismiss <n>\|clear]` | Triage findings from stateful loops |
| `/goal <condition>`, `/goal pause\|resume\|clear` | Hold the session to a stop condition: after every turn an evaluator with no tools decides whether it is met, and sends the agent back to work if not (max 8 continuations) |
| `/new-trigger <natural language>` | Create a condition-based rule ("when ~/build.done exists, run cargo test") |
| `/triggers [status\|rules\|sources\|enable\|disable\|remove\|running\|audit [N]\|abort]` | Dynamic triggers, MCP sources, running actions, audit |
| `/session-export [path]`, `/session-import <path>` | Portable `.pisession` archive: transcript + jobs + rules + loop state |

Tools for the model: `cron_create`, `cron_list`, `cron_remove`, `set_cron_job_state`,
`new_trigger`, `list_triggers`, `remove_trigger`, `set_trigger_state`, plus every tool of every
configured MCP server. Creating or removing triggers and re-enabling automation ask you to confirm,
as pie's `Prompt` permission class does.

## Documentation

- [docs/loops.md](docs/loops.md) — cron jobs, stateful loops, the inbox, maker/checker
- [docs/triggers.md](docs/triggers.md) — dynamic triggers and the trigger runtime
- [docs/mcp.md](docs/mcp.md) — MCP notification sources and tool registration (`mcp.toml`)
- [docs/hooks.md](docs/hooks.md) — lifecycle hooks (`hooks.toml`)
- [docs/goal.md](docs/goal.md) — `/goal`: holding a session to a stop condition
- [docs/session-archive.md](docs/session-archive.md) — `/session-export`, `/session-import`
- [docs/cli.md](docs/cli.md) — the `pi-loops` command line: export, import, and looking in on the host
- [docs/configuration.md](docs/configuration.md) — paths, `config.toml`, flags, environment
- [docs/design.md](docs/design.md) — architecture, how each pie piece maps onto pi's API, deliberate differences
- [docs/troubleshooting.md](docs/troubleshooting.md)
- [examples/](examples/README.md) — a dependency-free MCP push server to try notifications with
- [CHANGELOG.md](CHANGELOG.md), [AGENTS.md](AGENTS.md) for contributors

`pi-loops export|import` and `pi-loops host status|abort|stop` work from a shell with no pi session
open — for backups from cron or CI, restoring on a fresh machine, and looking in on the headless
host. See [docs/cli.md](docs/cli.md).

## Where things live

| Path | What |
|---|---|
| `~/.pi/agent/loops/jobs.json` | cron jobs (machine-global, each with its `cwd`) |
| `~/.pi/agent/loops/state/<id>.md` | loop notes — plain Markdown, edit it if the agent got something wrong |
| `~/.pi/agent/loops/inbox.jsonl` | the inbox |
| `~/.pi/agent/loops/runs.jsonl`, `sessions/<id>/` | run log and full sub-agent transcripts |
| `~/.pi/agent/loops/logs/pi-<pid>.log` | what each pi process's automation did — the file to read after an overnight failure |
| `~/.pi/agent/loops/triggers.json`, `triggers-audit.jsonl` | dynamic rules and trigger audit |
| `~/.pi/agent/loops/{config,mcp,hooks}.toml` | configuration (pie-compatible schemas) |
| `~/.pi/agent/loops/scheduler.json` | which pi process currently owns the timer |

Set `PI_LOOPS_DIR` to relocate all of it.

## How it differs from pie

pie scopes automation to a session and stops the clock when pie exits. pi-loops treats "pi was
restarted" as the normal case: jobs are machine-global (per host), any open pi can own the timer
(leader election with a heartbeat), a project's checks run in a pi open in that project so results
land in the right chat, a loop's tick missed while nothing was running is caught up once, and
nothing expires. Sub-agents run inside the interactive pi through pi's SDK, exactly like pie's,
sharing its live MCP servers. When the last pi quits, a headless host takes the clock and keeps
loops, trigger checks and MCP pushes running until the next pi opens and takes it back
(`/cron host`, `[host] auto`).
The full account of the differences and their costs is in
[docs/design.md](docs/design.md#where-pi-loops-departs-from-pie-and-what-that-costs).

## Non-invasive by construction

Only pi's public extension API is used. `find <pi install> -newer package.json` is empty after
installing pi-loops; `~/.pi/agent` gains one `packages` entry and the `loops/` directory. Sub-agents
are sessions opened inside the same pi through its public SDK. Uninstalling is `pi remove`.

## License

MIT
