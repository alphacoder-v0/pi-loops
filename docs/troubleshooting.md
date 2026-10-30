# Troubleshooting

**Nothing fires.** `/pi-loops status` shows whether pi-loops is running. If it cannot start, the window
shows `loops paused: pi-loops could not start`; `/pi-loops status` gives the reason and log path. A job shows
`next …` when it will run somewhere: here, in another window, or in the background. `paused: <why>` means
pi-loops will not run it; `/pi-loops status` says why. A plain job marked `[session <id> — resume it to run]`
belongs to a conversation whose file pi-loops never saw (`--resume` it once, or `/cron add` it again
in this chat); a loop marked
`[orphan: cwd missing]` was disabled because its checkout is gone.

**A run failed.** `/cron runs` shows the error; `/cron trace <job> 1` shows the sub-agent's
transcript; `pi --session <file>` resumes it. Loop runs and rule checks run in the background. They
use the credentials pi saved, pi's default tools (or the job's `--tools`), the MCP servers in
`mcp.toml` and the project's trusted ones. They do not get `-e` extensions or flags from your pi
window. Keys saved with pi’s `/login` reach pi-loops in the background. Keys exported only in a shell do not. They cannot answer permission prompts.

**Findings never arrive.** The loop must end its reply with `<inbox>…</inbox>` tags; check
`/cron trace`. Quiet runs are normal. With `--verify`, dropped findings and reasons are on the run
card and in `/cron trace <job> 1 checker`.

**`Tool "cron_create" conflicts with …`, and pi exits.** The package is installed twice, and this
is fatal rather than cosmetic: the second copy fails to load and pi stops. It happens easily —
a local checkout you are working on plus `pi install npm:…` or `pi install git:…` of the published
one all sit in `packages` in `~/.pi/agent/settings.json`, and each registers the same tools. (An
older, milder symptom of the same thing was commands appearing as `/cron:1`.)

Keep one:

```bash
pi remove npm:@alphacoder-v0/pi-loops              # keep the checkout you are working on (installed from npm)
pi remove git:github.com/alphacoder-v0/pi-loops    # keep the checkout you are working on (installed from GitHub)
pi remove /path/to/your/checkout                   # or keep the installed one
```

Then re-run the launcher install from the copy you kept: `install-launcher` writes the path of
whichever copy ran it, so removing that one leaves `pi-loops` pointing at a package that is no
longer loaded.

**The browser window says "This browser has not been here before."** It has no cookie for this
address, which is normal for a new device, a new browser, a private window, or after clearing site
data. Press **add device** in a browser that is already signed in and scan the QR, or type the six
digits into the box on that page. The terminal that started the session printed a code too.

**The phone cannot reach it at all.** The server binds loopback by default, and a phone has no
route to that. Either `tailscale serve --bg 4173` (the server stays on loopback; the tailnet does
TLS) or start with `pi-loops --host 0.0.0.0` for a phone on the same wifi. See
[cli.md](cli.md#from-a-phone).

**The QR is offered but scanning it goes nowhere.** The QR encodes the address *the browser you
pressed the button in* is using. Press it in a window that is on `127.0.0.1` and there is no
address a phone could use — it says so instead of drawing one. Open the tailnet or LAN address on
the desktop first, then press it there. Where the machine has several addresses, the dialog lists
them with the interface each belongs to; a docker or libvirt bridge is not the one.

**"port 4173 is already in use" — or a second `pi-loops` opened the first one's window.** Starting
a second session while one is up hands you the window that is already there rather than failing.
That is deliberate. `--port <n>` starts a genuinely separate one, and the browser stays signed in:
the token is the one file both of them read, and a cookie is not scoped to a port — `localhost:4173`
and `localhost:4180` are the same site to a browser, which is the fact the `Sec-Fetch-Site` check
here is built around. A `--port` that is not a number is refused rather than quietly served on 4173.

**A pairing code stopped working.** They last ten minutes, are good for one use, and closing the
dialog retires the one it was showing. Twenty wrong guesses disable pairing until another code is
made. Press **add device** again.

**Every device was signed out at once.** Something removed `~/.pi/agent/loops/web-token`, or
`PI_LOOPS_DIR` points somewhere new — the token is that file, and the cookie every device holds is
its contents.

**The window stops answering — you type, your message appears, no reply ever does.** The event
stream is numbered per run of the server process, so a page that was open across a restart can end
up counting against numbering that no longer exists and skip everything the new process sends,
while still polling happily and looking alive. From 0.12.2 the page notices this by itself, within
a few seconds, and says "the conversation above was reloaded". A page older than that has to be
reloaded by hand — the fix cannot reach a tab that was already open when it was installed.

Reloading the plain address is enough: the page is served `no-store`, so a normal refresh always
fetches the current one, and the token in the URL is only needed by a browser that has never been
here. From 0.12.4 a window that is older than what is installed says so in a bar across the top.

**MCP server shows `disconnected` / `auth_failed`.** `/triggers sources` has the last error.
Bearer tokens come from `$TOKEN_REF` or pi's credential store; endpoints must be https except
127.0.0.1. Custom notifications without `_meta.pi_dedup_key` are dropped and counted.

**Hooks do not run.** Startup warnings list malformed rules. Project hooks need
`allow_project_hooks = true`. Hooks fire in the interactive pi, and `run_start` / `run_end` also fire in the background (output in
`host.log`); never in sub-agents.

**`/session-export` says the session is ephemeral.** pi writes the session file after the first
message; `--no-session` sessions cannot be exported.

**Costs.** A stateful run is one sub-agent call (~$0.04 with gpt-5.5); `--verify` adds a second;
a dynamic check runs only while enabled rules exist. `every 1m` loops add up — prefer hourly or
daily schedules for anything that is not a test. `/cron cost` adds up the run log;
`[limits] daily_budget_usd` stops dispatching once the day reaches it, and says so on the job. It
also stops a run that is already going when its own cost would carry the day past the cap — that
run is recorded as aborted rather than failed, so the slot is still owed and the job's failure
streak is untouched; it simply will not be dispatched again until the day rolls over or the cap is
raised.

**`pi-loops status` says pi-loops "is not answering" but it is running.** Before 0.4.0 this
happened whenever `PI_LOOPS_DIR` was deep: a unix socket path is capped at 108 bytes, so
the old socket path failed to bind and the control channel silently did not exist. It now falls back
to a short path under a per-user directory in the temp directory. If you still see it, pi-loops is
genuinely wedged — `host.log` has its last line, and `pi-loops stop` escalates to SIGTERM.

**pi-loops is running and you did not start it.** A window starts pi-loops when there is work to run, and
`pi-loops status` shows its state; `pi-loops stop`
stops it until `pi-loops start`. `[host] auto = false` prevents windows from starting it.
After testing with a throwaway `PI_LOOPS_DIR`, remember that pi-loops it started outlives the pi
that spawned it — it is polling and billing against *that* directory until stopped.

**The browser front end refuses a slash command.** It drives `pi --mode rpc`,
where pi's own built-in commands do not exist — only extension commands and skills do. Typing one
is refused with a pointer to the button that does the same thing rather than being passed to the
model as text. `/login` is the one with no equivalent at all: log in once with `pi` in a terminal,
then start the front end.
