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

## The commands you type

```bash
pi-loops                              # start a session — browser here, terminal over ssh
pi-loops --tui                        # the terminal one, when the guess is wrong
pi-loops --continue                   # pick up the newest session in this directory
pi-loops upgrade                      # take the newest release from GitHub
pi-loops host status                  # look in on automation running with no pi open
```

Everything else is a slash command inside the session (`/cron`, `/inbox`, `/triggers`, `/goal`).
First time here, read on.

## Getting started

### 1. What you need first

pi ≥ 0.84 and Node ≥ 22.6 (pi loads the TypeScript sources directly), and a provider you can
actually talk to — run `pi`, send one message, and make sure you get an answer. pi-loops runs
sub-agents on your behalf while you are not watching; if the credentials are not working, the first
sign of it should not be an empty inbox tomorrow morning.

pi-loops itself has no runtime dependencies.

### 2. Install it

```bash
pi install git:github.com/alphacoder-v0/pi-loops@v0.13.0   # pinned tag
pi install /path/to/pi-loops          # or a local checkout — `pi install .` in this repo
```

Install one of them, not both. Two copies register the same tools, and pi refuses to load the
second — `Tool "cron_create" conflicts with …`, and it exits. If you are working on the code, the
checkout is the one to keep.

Then put the command on your `PATH`, once. `pi install` puts the package under pi's managed
directory rather than on your `PATH`, so `pi-loops` does not exist yet — which is the one thing
`install-launcher` cannot do for itself. Either way round works:

```text
/pi-loops install-launcher            # from inside pi, where the extension is already loaded
```

```bash
# or from a shell, in the directory pi installed the package into
cd ~/.pi/agent/git/github.com/alphacoder-v0/pi-loops    # a `pi install git:` package lives here
node src/cli-entry.mjs install-launcher
```

Either writes a launcher into `~/.local/bin` (or another directory already on your `PATH` — pass
`--dir` to choose). After that, `pi-loops` works from anywhere.

### 3. Start a session

```bash
pi-loops                              # a session, in whichever window makes sense here
```

At a local terminal that opens the browser front end; over ssh, or with no terminal at all, it runs
pi itself, because a browser on the far machine helps nobody. `--web` and `--tui` say which when
the guess is wrong, `--continue` picks up where you left off, and anything else you pass goes
straight to pi:

```bash
pi-loops --tui                        # the terminal one
pi-loops --continue                   # the newest session in this directory
pi-loops --model anthropic/claude-opus-5 -e .
```

Both windows are complete pi sessions — the browser one runs `pi --mode rpc` behind a page — so the
session file, `--resume`, your models, tools and extensions are the same either way. See
[docs/cli.md](docs/cli.md).

The browser one is always at **`http://127.0.0.1:4173/`** — a fixed port and a token that lives in
a file, so the address is the same one tomorrow and is worth bookmarking. The first visit leaves a
cookie and you never see the token again. Running `pi-loops` while one is already up opens that
window instead of failing on the port. `--no-auth` drops even that, on a machine only you use.

From a phone, the best route is `tailscale serve --bg 4173`: this server stays on loopback and the
tailnet does TLS and identity. On the same wifi, `pi-loops --host 0.0.0.0` works too (and refuses
`--no-auth`). Press **add device** in a browser that is already signed in and point the phone at
the QR it shows: nothing to type, and that device stays signed in. The page can be added to the
home screen.

### 4. Your first loop

```text
/cron add --stateful "0 9 * * *" check the GitHub issues of this repo and report anything new or newly closed since the last run
```

Every morning a fresh sub-agent runs with the notes it wrote last time, does the work, and ends its
reply with `<loop-state>…</loop-state>` (notes for tomorrow) and `<inbox>one-line finding</inbox>`
tags. State goes to a Markdown file, findings go to the inbox, your conversation is never touched.

```text
/cron                  # what is scheduled here, and when it next runs
/cron run 1            # do not wait until 9am — run it now and watch
/inbox                 # list new findings
/inbox claim 1         # hand finding #1 to the agent as a real turn
/inbox dismiss 2       # not interesting
```

Add `--verify` and a second, adversarial sub-agent checks every finding before it reaches you.

### 5. Before you leave it running overnight

```text
/cron cost             # what automation has spent today
```

Set a cap in `~/.pi/agent/loops/config.toml` before you rely on it:

```toml
[limits]
daily_budget_usd = 5.0
```

When the last pi quits, a headless host takes over the clock so the 9am run happens whether or not
you are at the machine (`/cron host`, `pi-loops host status`). If you would rather it did not, put
`[host] auto = false` in the same file.

### Upgrading

```bash
pi-loops upgrade                      # take the newest release
pi-loops upgrade --check              # just say whether there is one
```

It reads the release tags from the repository this copy came from, compares them with what you are
running, and installs the newest — because `pi update --extensions` deliberately will not. pi pins
the ref you asked for and reconciles the clone to *that* ref; moving to a new release is a separate
decision, and making it means knowing which tag is newest, which is a thing a command should do for
you rather than something to look up and retype.

Restart pi (or run `pi-loops` again) to load it. The launcher does not need reinstalling: pi keeps
each git package at `~/.pi/agent/git/<host>/<owner>/<repo>`, so a version change keeps the path.

Releases are tags on GitHub; [CHANGELOG.md](CHANGELOG.md) says what is in each one.

### Uninstall

```bash
pi remove /path/to/pi-loops           # state stays in ~/.pi/agent/loops until you delete it
pi -e /path/to/pi-loops               # or: try it for one run without installing anything
pi update --extensions                # reconcile packages
```

The package also ships a skill (`skills/pi-loops`) so the agent knows when to reach for
`cron_create`, `new_trigger` and the inbox.

## Commands

| Command | What it does |
|---|---|
| `/cron add [--stateful] [--verify] "<schedule>" <prompt>` | Schedule a job. Plain jobs inject their result into this chat; `--stateful` makes a loop with memory and inbox routing; `--verify` adds the checker. Schedules: 5-field cron, `hourly`/`daily`/`每天`, `every 30m`, `in 10m`, `at <ISO>` |
| `/cron`, `/cron all`, `/cron enable\|disable\|remove <id>` | This project's jobs (or every project), pie's list format and control-plane audit |
| `/cron run`, `/cron state`, `/cron runs`, `/cron trace <job> [k] [checker]`, `/cron scheduler`, `/cron panel` | Fire now, read the loop's notes, run log, full sub-agent transcript, scheduler ownership, side panel |
| `/cron set <job> …`, `/cron gc`, `/cron host [start\|stop]` | Change a job in place — `--prompt`, `--schedule`, model, thinking, timeout, name — keeping its id and therefore its notes; remove jobs of deleted sessions; the headless host that keeps the clock after the last pi quits |
| `/cron cost [today\|7d\|all]`, `/cron disable --all`, `/cron clear <ref>` | What automation has cost against `[limits] daily_budget_usd`, stop everything, release a stuck run marker |
| `/cron snapshot` | Write what only this process knows — connected MCP servers and their tools, active tools, hooks, who owns the clock — into the session as a `pi_loops_snapshot` entry, for a front end that is not a terminal |
| `/inbox [all\|claim <n>\|dismiss <n>\|clear] [--all]` | Triage findings from stateful loops. This project's by default, `--all` for every project — the same scoping `/cron` and `/triggers` use |
| `/goal <condition>`, `/goal pause\|resume\|clear` | Hold the session to a stop condition: after every turn an evaluator with no tools decides whether it is met, and sends the agent back to work if not (max 8 continuations) |
| `/new-trigger <natural language>` | Create a condition-based rule ("when ~/build.done exists, run cargo test") |
| `/triggers [status\|rules\|sources\|enable\|disable\|remove\|run <id>\|running\|audit [N]\|abort]` | Dynamic triggers, MCP sources, running actions, audit; `run` checks one rule now instead of waiting for its poll slot |
| `/session-export [path]`, `/session-import <path>` | Portable `.pisession` archive: transcript + jobs + rules + loop state |
| `/session-share [--public]` | Upload a redacted transcript as a GitHub gist via `gh`, after showing you what it contains. (pi has its own `/share`, which sends the raw session elsewhere first — see [docs/session-archive.md](docs/session-archive.md)) |
| `/pi-loops [install-launcher]` | Version and paths; `install-launcher` puts the `pi-loops` command on your `PATH` |

Tools for the model: `cron_create`, `cron_list`, `cron_remove`, `set_cron_job_state`,
`new_trigger`, `list_triggers`, `remove_trigger`, `set_trigger_state`, plus every tool of every
configured MCP server. Creating or removing triggers and re-enabling automation ask you to confirm,
as pie's `Prompt` permission class does.

## Documentation

- [docs/loops.md](docs/loops.md) — cron jobs, stateful loops, the inbox, maker/checker
- [docs/triggers.md](docs/triggers.md) — dynamic triggers and the trigger runtime
- [docs/mcp.md](docs/mcp.md) — MCP notification sources and tool registration (`mcp.toml`)
- [docs/hooks.md](docs/hooks.md) — lifecycle hooks (`hooks.toml`), including `run_start` / `run_end` for scheduled runs
- [docs/goal.md](docs/goal.md) — `/goal`: holding a session to a stop condition
- [docs/session-archive.md](docs/session-archive.md) — `/session-export`, `/session-import`
- [docs/cli.md](docs/cli.md) — the `pi-loops` command line: export, import, and looking in on the host
- [docs/web-ui-parity.md](docs/web-ui-parity.md) — what the browser front end owes you, as a gate rather than a wish list
- [docs/configuration.md](docs/configuration.md) — paths, `config.toml`, flags, environment
- [docs/design.md](docs/design.md) — architecture, how each pie piece maps onto pi's API, deliberate differences
- [docs/troubleshooting.md](docs/troubleshooting.md)
- [examples/](examples/README.md) — a dependency-free MCP push server to try notifications with
- [CHANGELOG.md](CHANGELOG.md), [AGENTS.md](AGENTS.md) for contributors

`pi-loops export|import` and `pi-loops host status|abort|stop` work from a shell with no pi session
open — for backups from cron or CI, restoring on a fresh machine, and looking in on the headless
host. See [docs/cli.md](docs/cli.md).

`pi-loops` starts a session — the browser front end at a local terminal, pi itself over ssh or with
no terminal at all, and `--web` / `--tui` when the guess is wrong. Both are complete pi sessions;
the browser one runs `pi --mode rpc` behind a page, so the session file, `--resume`, your models,
tools and extensions are the same either way. The model and thinking level you last chose start the
next session. Streaming feed with replies rendered as Markdown,
queue, abort, model and thinking pickers, images, `/` and `@` completion, search, undo, cost, copy
buttons, a light/dark switch, an automation panel that becomes a drawer on a phone, and pi-loops'
approvals answered in the browser. It works from a phone over Tailscale, and a device is added by
pointing its camera at a QR. Run `/pi-loops install-launcher` once to get the command on your PATH.
See [docs/cli.md](docs/cli.md) and [docs/web-ui-parity.md](docs/web-ui-parity.md).

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
