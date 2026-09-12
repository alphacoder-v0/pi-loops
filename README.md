# pi-loops

An automation layer for [pi](https://github.com/earendil-works/pi), shipped as a plain pi extension.
Nothing in pi is patched.

![Two runs of the same loop in pi's browser window: the first ends "0 findings — nothing to report", the second reports one new TODO item, and /inbox lists what is waiting](docs/screenshot.png)

Cron jobs, **stateful loops with a triage inbox**, dynamic triggers, MCP notifications and lifecycle
hooks. A loop wakes up with the notes its last run left, does the work in a sub-agent with a clean
context, and files what it found; you read the findings when you want to and claim the ones worth a
turn. It all keeps running after you close pi.

中文说明见 [README.zh-CN.md](README.zh-CN.md)。

## Why this exists

Some work should happen while nobody is watching: the issues opened overnight, the dependency that
picked up a CVE, the test that started failing on main. An agent can do any of it, but only when you
sit down and ask — so the asking is the work. And the two obvious ways to automate it put the result
in the wrong place: a prompt on a timer interrupts you with something you did not want *now*, and a
script writes to a log nobody opens.

> "Stop prompting the agent. Build loops that prompt the agent for you."
> — Addy Osmani, *Loop Engineering*

So the run happens in a sub-agent that never touches your conversation, it starts with the notes its
last run left so it can tell what is new, and what it finds waits in an inbox you read when you want.

## Install

pi ≥ 0.84 and Node ≥ 22.6 (pi loads the TypeScript sources directly), and a provider you can
actually talk to — run `pi`, send one message, and make sure you get an answer. pi-loops runs
sub-agents while you are not watching; if the credentials are not working, the first sign of it
should not be an empty inbox tomorrow morning.

```bash
pi install git:github.com/alphacoder-v0/pi-loops@v0.16.0   # pinned tag
pi install /path/to/pi-loops          # or a local checkout — `pi install .` in this repo
```

Install one of them, not both. Two copies register the same tools, and pi refuses to load the
second — `Tool "cron_create" conflicts with …`, and it exits. If you are working on the code, the
checkout is the one to keep.

Then restart pi, and that is the whole install: `/cron`, `/inbox`, `/triggers` and `/goal` are
registered by the extension itself, so they work with nothing on your `PATH` and no launcher. The
`pi-loops` command is a separate thing, needed only for the browser window and the shell
subcommands — [The browser window, and the command line](#the-browser-window-and-the-command-line)
sets it up when you want it. pi-loops has no runtime dependencies.

## Your first loop

```text
/cron add --stateful "0 9 * * *" check the GitHub issues of this repo and report anything new or newly closed since the last run
```

Every morning a fresh sub-agent runs with the notes it wrote last time, does the work, and ends its
reply with `<loop-state>…</loop-state>` (notes for tomorrow) and `<inbox>one-line finding</inbox>`
tags. State goes to a Markdown file, findings go to the inbox, your conversation is never touched.
Here are two runs of a loop watching a TODO file, half an hour apart — the first:

```text
cron todo · 5s · $0.000 · 0 findings · state updated
MD5 unchanged (`06ff2ec8af3668bb89ecc6580110ecad`), git rev still `15b6562`. No new unchecked items — nothing to report.
/cron trace todo · /inbox
```

The second, after one commit:

```text
cron todo · 4s · $0.000 · 1 finding · state updated
md5 changed (06ff2ec8… → fe00aaad…). One new unchecked item appeared.
• TODO.md: new unchecked item — cache the /search results for 60s (commit 395a124 "todo: cache search results")
/cron trace todo · /inbox
```

The first run found nothing worth saying and said nothing; the second noticed one change and
reported only that. That is what the notes between runs buy — without them every run reports the
whole file every morning, and you stop reading it by Thursday. What they filed waits in the inbox:

```text
/inbox
Inbox (acme-api, 3 new, times +00:00):
  1. [inb-aae794d5] TODO: rate-limit the /search endpoint  (acme-api, cron:todo, 2026-09-12 05:25)
  2. [inb-74b73c72] TODO.md: new unchecked item — cache the /search results for 60s  (acme-api, cron:todo, 2026-09-12 05:28)
claim with /inbox claim <n>, dismiss with /inbox dismiss <n>
```

```text
/cron                  # what is scheduled here, and when it next runs
/cron run 1            # do not wait until 9am — run it now and watch
/inbox claim 1         # hand finding #1 to the agent as a real turn
/inbox dismiss 2       # not interesting
```

Add `--verify` and a second, adversarial sub-agent checks every finding before it reaches you.

## Loops worth stealing

```text
/cron add --stateful --name main-watch "0 9 * * *" read the commits on main since the revision in your notes, report anything that changes the public API, and record the new head revision
```

The shape the others vary: notes carry a revision, and only the difference earns an inbox line.

```text
/cron add --stateful --name deps "0 8 * * 1" run npm audit and report advisories whose id is not already in your notes; append every id you report to that list
```

Monday morning, and never the same advisory twice: the watermark is a list the loop keeps in its own
notes, which are plain Markdown you can read and correct (`/cron state deps`).

```text
/cron add --verify --name ci every 30m run the test suite and report only tests that changed status since your notes
```

`--verify` implies `--stateful` and puts a second sub-agent between the findings and you: a flake
that failed once is exactly what should be stopped there, with the reason in `/cron trace ci 1 checker`.

```text
/new-trigger when ~/build.done exists, run cargo test and show me the result
```

A condition instead of a clock: a sub-agent re-checks it every `[triggers] poll_interval_secs` (600
by default) and acts when it holds — once, unless you ask for a repeat.

```text
/cron add in 45m remind me to look at the deploy
```

No `--stateful`, so this is a plain job: in 45 minutes the prompt lands in *this* conversation and
is answered there rather than filed — a reminder belongs in the chat, a nightly report does not.

```text
/cron add --stateful --cwd /srv/acme-api --model openai/gpt-5.5 "0 7 * * *" summarize what changed in this repo since your notes
```

A job records its directory and model at creation, so it is not tied to the window it was typed in:
`--cwd` runs it in another checkout (absolute, or relative to this project — no shell, so nothing
expands `~`), and `--model` pins it whatever this session is on (`/cron set <ref> --model -` unpins).

## Before you leave it running overnight

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

## The browser window, and the command line

`pi-loops` is the part that needs a launcher: it opens a session, and carries the subcommands that
run with no pi open at all. `pi install` puts the package under pi's managed directory rather than
on your `PATH`, so the command does not exist yet — the one thing `install-launcher` cannot do for
itself. Either way round works:

```text
/pi-loops install-launcher            # from inside pi, where the extension is already loaded
```

```bash
cd ~/.pi/agent/git/github.com/alphacoder-v0/pi-loops    # or from a shell: a `pi install git:` package lives here
node src/cli-entry.mjs install-launcher
```

Either writes a launcher into `~/.local/bin` (or another directory already on your `PATH` — pass
`--dir` to choose). After that, `pi-loops` works from anywhere:

```bash
pi-loops                              # start a session — browser here, terminal over ssh
pi-loops --tui                        # the terminal one, when the guess is wrong
pi-loops --continue                   # pick up the newest session in this directory
pi-loops upgrade                      # take the newest release from GitHub
pi-loops host status                  # look in on automation running with no pi open
```

`pi-loops sessions|inspect|export|import` and `pi-loops host status|abort|stop` need no pi session
open — for backups from cron or CI, restoring on a fresh machine, and looking in on the headless
host. See [docs/cli.md](docs/cli.md).

At a local terminal the bare command opens the browser front end; over ssh, or with no terminal at
all, it runs pi itself, because a browser on the far machine helps nobody. `--web` says which when
the guess is wrong, and anything else you pass goes straight to pi (`pi-loops --model
anthropic/claude-opus-5 -e .`). Both windows are complete pi sessions — the browser one runs
`pi --mode rpc` behind a page — so the session file, `--resume`, your models, tools and extensions
are the same either way, and the model and thinking level you last chose start the next session
whichever window it opens in.

The browser one is a session, not a viewer: a streaming feed with replies rendered as Markdown, a
queue, abort, model and thinking pickers, images, `/` and `@` completion, search, undo, cost, copy
buttons, a light/dark switch, an automation panel that becomes a drawer on a phone, and pi-loops'
own approvals answered there. Starting over stays in the window too — **clear** begins a new
session, **resume** goes back to an earlier one in this project, **compact** summarises what is
there and says what it did, as buttons or as `/clear`, `/new`, `/resume` and
`/compact <what to keep>` in the composer. None of them deletes anything; the session you leave is a
file that `resume` lists.

It is always at **`http://127.0.0.1:4173/`** — a fixed port and a token that lives in a file, so the
address is the same one tomorrow and is worth bookmarking. The first visit leaves a cookie and you
never see the token again. Running `pi-loops` while one is already up opens that window instead of
failing on the port; `--no-auth` drops even that, on a machine only you use.

From a phone, the best route is `tailscale serve --bg 4173`: this server stays on loopback and the
tailnet does TLS and identity. On the same wifi, `pi-loops --host 0.0.0.0` works too (and refuses
`--no-auth`). Press **add device** in a browser that is already signed in and point the phone at the
QR it shows: nothing to type, that device stays signed in, and the page can go on the home screen.

### Keeping it up to date

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
| `/cron add [--stateful] [--verify] "<schedule>" <prompt>` | Schedule a job. Plain jobs inject their result into this chat; `--stateful` makes a loop with memory and inbox routing; `--verify` adds the checker. Schedules: 5-field cron, `hourly`/`daily`/`每天`, `every 30m`, `in 10m`, `at <ISO>` — all on this machine's clock ([which clock, and what the twice-yearly change does to it](docs/loops.md#time-and-which-clock-it-is)) |
| `/cron`, `/cron all`, `/cron enable\|disable\|remove <id>` | This project's jobs (or every project); every add, enable, disable and remove is written into the session as an audit entry |
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
configured MCP server. Creating or removing triggers and re-enabling automation ask you to confirm:
they are the operations that decide what runs while nobody is watching.

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
- [docs/design.md](docs/design.md) — architecture: what each piece is built out of, and the decisions behind it
- [docs/troubleshooting.md](docs/troubleshooting.md)
- [examples/](examples/README.md) — a dependency-free MCP push server to try notifications with
- [CHANGELOG.md](CHANGELOG.md), [AGENTS.md](AGENTS.md) for contributors

## Where things live

| Path | What |
|---|---|
| `~/.pi/agent/loops/jobs.json` | cron jobs (machine-global, each with its `cwd`) |
| `~/.pi/agent/loops/state/<id>.md` | loop notes — plain Markdown, edit it if the agent got something wrong |
| `~/.pi/agent/loops/inbox.jsonl` | the inbox |
| `~/.pi/agent/loops/runs.jsonl`, `sessions/<id>/` | run log and full sub-agent transcripts |
| `~/.pi/agent/loops/logs/pi-<pid>.log` | what each pi process's automation did — the file to read after an overnight failure |
| `~/.pi/agent/loops/triggers.json`, `triggers-audit.jsonl` | dynamic rules and trigger audit |
| `~/.pi/agent/loops/{config,mcp,hooks}.toml` | configuration |
| `~/.pi/agent/loops/scheduler.<host>.json` | which pi process currently owns the timer |

Set `PI_LOOPS_DIR` to relocate all of it.

## Automation outlives the window it was set up in

The thing that decides whether scheduled work is trustworthy is what happens when you close the
editor — so "pi was restarted" is treated as the normal case rather than the exception.

Jobs are machine-global, recorded per host, and never expire. Any open pi can own the timer:
leadership is a file with a heartbeat, and when the process holding it exits or dies, the next tick
in another window picks it up. A project's trigger checks run in a pi that is open in that project,
so a result that belongs in a conversation lands in the right one. A tick missed while nothing was
running is caught up once, collapsed rather than replayed. And when the last pi quits, a headless
host takes the clock and keeps loops, trigger checks and MCP pushes going until the next pi opens
and takes it back (`/cron host`, `[host] auto`).

Sub-agents are sessions opened inside the interactive pi through its SDK, not child processes: they
share its live MCP servers — the browser tab that is already logged in, the database session that is
already open — along with its extensions, model and thinking level.

[docs/design.md](docs/design.md) has the architecture and the reasoning behind each of these.

## Non-invasive by construction

Only pi's public extension API is used. `find <pi install> -newer package.json` is empty after
installing pi-loops; `~/.pi/agent` gains one `packages` entry and the `loops/` directory. Sub-agents
are sessions opened inside the same pi through its public SDK. Uninstalling is `pi remove`.

## Acknowledgements

Inspired by, and rewritten from, [pie](https://github.com/c4pt0r/pie).

## License

MIT
