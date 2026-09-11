# The `pi-loops` command line

`pi-loops` starts a session. With no arguments it opens the browser front end when you are at a
local terminal, and pi itself when you are not — over ssh, or with no terminal at all, where a
browser on this machine would help nobody. `--web` and `--tui` say which when the guess is wrong.

```
pi-loops                             # start a session, in whichever window makes sense here
pi-loops --tui                       # the terminal one
pi-loops --web --port 4200           # the browser one, on a port you chose
pi-loops --model anthropic/claude-opus-5 -e .   # anything it does not recognise goes to pi
```

Both are complete pi sessions: the browser one runs `pi --mode rpc` behind a page ([src/web.mjs](../src/web.mjs)),
so the session file, `--resume`, your models, tools and extensions are the same either way. What
the browser cannot do is pi's own built-in slash commands, which do not exist in that mode, and
`/login`, whose OAuth flow has no equivalent — log in once with `pi` and the rest follows.

### The address

Always `http://127.0.0.1:4173/`. Bookmark it. The port is fixed rather than "whatever was free",
and the token that guards it lives in `~/.pi/agent/loops/web-token` (mode 0600) rather than being
made fresh every launch — so the address is the same one tomorrow, and the first visit leaves a
cookie that means you never see the token again. `--port <n>` moves it if 4173 is spoken for.

There is a token at all because anything that reaches this server gets your whole session, and
"anything" includes a website you have open in another tab: it cannot read the answers, but
without a check it could still tell your agent what to do. The cookie is `SameSite=Strict`, which
is a browser's promise not to send it on anything another site started, so the cost of this to you
is one visit and then nothing.

Running `pi-loops` a second time while one is up does not fail on the busy port — it opens the
window that is already there and leaves.

### From a phone

The front end binds loopback, which a phone cannot reach. Two ways round it, and the first is
better:

**Tailscale.** Leave the server where it is and put Tailscale in front:

```
tailscale serve --bg 4173
```

Your phone then opens `https://<machine>.<tailnet>.ts.net/` — TLS terminated on the tailnet, only
your own devices, and this server still bound to 127.0.0.1. It arrives here looking local and
carrying the tailnet name as its `Host`, which is accepted for that reason.

**The local network.** `pi-loops --host 0.0.0.0` binds every interface and prints the addresses a
phone on the same wifi can use. Anything that can open the port is then talking to your session, so
the token is not optional here — `--no-auth` is refused outright in this mode.

`tailscale funnel` is the same shape and puts it on the open internet; the token is what stands
between that and anyone, so `--no-auth` refuses to serve anything but loopback no matter which
route a request took to arrive.

Either way the phone has to get in once, and the token is 32 hex characters, which is fine to click
and miserable to type. So: press **add device** in the browser you are already signed in on. It
shows a **QR code** — point the phone at it and it is in, having typed nothing — and the same six
digits underneath for when a camera is not the thing you want to use. The terminal prints a code at
startup too.

The QR encodes the address *this browser reached the server on*, which under `tailscale serve` is
the tailnet name and is the one that works from anywhere on your tailnet. If the window you press it
in is on `127.0.0.1`, there is no address to put in a QR that would work from a phone, and it says
so instead of showing you one that does not.

A code is good for one use, and twenty wrong guesses disable it until you ask for another.

On a network you do not own, remember that `--host` is plain http: the cookie it hands out carries
a token that outlives the process, and anyone on the wire can read it. That is the case
`tailscale serve` exists for, and the startup output says so.

Add it to the home screen and it opens without browser chrome: there is a web app manifest, and no
service worker — nothing here is worth caching, and a stale copy of a live front end is worse than
no copy.

### Dropping the token

`pi-loops --no-auth` drops the token entirely: no cookie, no query string, nothing to carry, and
anything on this machine that can open port 4173 has your session. What is left is the check that
the request did not come from another site — a browser tells the truth about that, and it is what
keeps a page on `http://localhost:5173` from posting into your agent — but any *program* running as
any user on this machine is then in. It is the right trade on a machine only you use, and the wrong
one on a shared host.

A browser that has never been here (a different one, or after clearing cookies) gets a page saying
so. Start a session from a terminal on this machine and it will open a window that works from then
on, or use the `?token=…` address the terminal printed.

### It starts a session; it does not attach to one

The browser front end starts its own `pi --mode rpc`. It does not join a pi you already have open
in a terminal — two front ends driving one agent is not something pi offers, and pretending
otherwise would mean two windows disagreeing about whose turn it is.

Picking up where you left off is a different thing, and pi already has it. The flags reach pi
unchanged, so:

```
pi-loops --continue                  # the newest session in this directory, in the browser
pi-loops --resume                    # pick one
pi-loops --session <id-or-path>      # a particular one
```

That also means you can hand a session between windows: quit the terminal one, `pi-loops --continue`,
and carry on in the browser with the same transcript.

### Starting over, without leaving the window

The context is finished with far more often than the window is, so the things you do between turns
are in the page rather than in the terminal that launched it:

| | |
|---|---|
| **clear** / `/clear`, `/new` | start a new session here |
| **resume** / `/resume` | go back to an earlier session in this project |
| **compact** / `/compact <what to keep>` | summarise what is there and carry on |

Nothing is deleted by any of them. The session you leave is a file on disk, and **resume** lists
this project's sessions newest first, each labelled by what was said in it rather than by a
filename. Compaction reports what the context was, what it became, and what the summary cost.

Underneath, **clear** and **resume** are pi's `switch_session`: the session is replaced inside the
process that is already running, so the model, the MCP connections and the extensions are the same
ones, rebuilt against the new session. That is what `/new` and `/resume` do in the terminal, and
automation follows it the same way — the scheduler stops and starts with the session rather than
handing the clock to the headless host, and a scheduled run the swap interrupts gives its slot back
and fires again on the next tick.

Both are refused while a turn is running, because the swap would abort it: stop the turn first. A
session started this way is named by the front end rather than by pi, which is invisible everywhere
except that its filename does not contain its session id — pi and pi-loops both identify a session
by the id in its header.

## Getting the command onto your PATH

`pi install` puts this package under pi's managed directory rather than on your `PATH`, so the
command that is meant to start your sessions is otherwise reachable only by absolute path:

The command does not exist yet at this point, which is the one thing it cannot do for itself. Run
it from inside pi, where the extension is already loaded:

```text
/pi-loops install-launcher
```

or from the directory pi installed the package into — for a `pi install git:` package that is
`~/.pi/agent/git/<host>/<owner>/<repo>`:

```bash
node src/cli-entry.mjs install-launcher
node src/cli-entry.mjs install-launcher --dir ~/bin
```
It writes a two-line `sh` script that names the node you ran it with and the package it lives in —
a launcher rather than a symlink, so it keeps working if either moves for the other's reason.

## Upgrading

```bash
pi-loops upgrade                     # install the newest release
pi-loops upgrade --check             # say whether there is one, and stop
```

It reads release tags from the repository this copy came from (`repository.url` in its
`package.json`, so a fork upgrades from the fork), takes the highest `vN.N.N` — comparing
numerically, so `v0.10.0` beats `v0.9.0` — and runs `pi install` for it. Release candidates and
branch-shaped tags are ignored: those are not things to move someone onto without being asked.

`pi update --extensions` does something different and both are useful: it reconciles every package
to the ref already pinned in your settings, which is how you repair a clone, not how you take a new
version.

## The tools

The rest of the command line does not need a pi session and has no build step; it resolves pi's
packages the way the headless host does. `PI_LOOPS_DIR` selects the loops directory, as everywhere.

```
pi-loops sessions [--all] [--limit <n>]
pi-loops inspect <file>
pi-loops export [--session <id>] [--cwd <dir>] [--output <file>] [--exclude-triggers]
pi-loops import <file> [--cwd <dir>] [--activate-triggers=off|ask|on]
pi-loops host status | abort <run-id|trace-id> | stop
```



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
