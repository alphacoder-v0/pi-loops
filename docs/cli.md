# The `pi-loops` command line

pie exposes `pie session export|import` as CLI subcommands that dispatch before any UI exists, so a
backup can run from cron, from CI, or on a fresh machine before anything is opened. `pi-loops` does
the same, and adds a window into the headless host.

```
pi-loops sessions [--all] [--limit <n>]
pi-loops inspect <file>
pi-loops export [--session <id>] [--cwd <dir>] [--output <file>] [--exclude-triggers]
pi-loops import <file> [--cwd <dir>] [--activate-triggers=off|ask|on]
pi-loops host status | abort <run-id|trace-id> | stop
```

`pi install` puts the package under pi's managed directory rather than on your `PATH`; run it as
`node <package-dir>/src/cli-entry.mjs`, or `npm i -g pi-loops` if you want the bare name.

## sessions, inspect

`sessions` lists the ids `export --session` accepts, newest first — without it an unknown id was
the only error you could get. `inspect` prints an archive's schedules, prompts and rules without
writing anything, which is what you want before restoring on a machine you care about.

It needs no pi session and no build step; it resolves pi's packages the way the headless host does.
`PI_LOOPS_DIR` selects the loops directory, as everywhere else.

## export

Bundles a session's transcript with the automation that session created — its cron jobs, trigger
rules and loop state — into one `.pisession` archive.

With no `--session`, the newest session recorded for `--cwd` (default: the current directory) is
taken. `--session` accepts a full id or a unique prefix. `--exclude-triggers` drops every automation
sidecar, as pie's flag does.

```
pi-loops export --session 01a084a0 --output ~/backups/api.pisession
```

## import

Restores an archive into `--cwd` (default: the current directory), rewriting ids, project and
machine so the automation runs where it landed.

Imported automation stays disabled unless `--activate-triggers=on`; `ask` prompts on a terminal.
Importing the same archive twice adds nothing the second time. A pie `.piesession` is accepted for
its cron and trigger sidecars only — the transcript formats differ — and says so.

## host

The headless host has no chat, so `host status` is how you see what it is doing while no pi is
open: the loop runs and trigger checks in flight, what is enabled, the inbox count, and each MCP
server's state.

```
$ pi-loops host status
background host
  pid 2949521 on box, started 2026-09-09T05:33:16.652Z, model openai-codex/gpt-5.5
  owns the clock · 1/1 loop(s), 0/0 rule(s) enabled · inbox: 0 new
  running nightly (run-97ffb250) since 2026-09-09T05:34:16.676Z: check the repo issues
```

`host abort <id>` interrupts one run or trigger check (the shortened ids the status prints are
accepted). `host stop` ends the host; the next pi to open would have taken the clock back anyway.

The channel is a unix socket at `host.sock` in the loops directory, created 0600, and it is
read-mostly on purpose: a host you could prompt would be a second chat.
