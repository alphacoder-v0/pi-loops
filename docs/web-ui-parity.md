# What the browser front end owes you

`pi-loops` opens a browser window instead of a terminal one when you are at a local terminal. That
makes the page an alternative to the TUI, not a lesser chat box bolted onto the side of it — and the
difference between those two things is a list, kept here, of what a person can still do after the
window changed.

This is a gate, not a wish list. Anything below is either implemented, or marked as held with the
reason. A release that drops one of these silently is the failure this file exists to prevent.

Where a line is enforced by a test, the test is named. The rest are checked by reading, which is
weaker, and worth converting whenever one of them breaks.

## Sending, and what happens while it runs

- [x] Enter sends. Shift+Enter inserts a newline.
- [x] Enter does nothing while an input method is composing — typing Chinese, Japanese or Korean
      means Enter picks a candidate, not "send". `test/web-page.test.ts`: *Enter while an input
      method is mid-word does not send*.
- [x] Submitting while a turn is running queues instead of racing it, the way the TUI does.
- [x] The queue is visible and can be cleared.
- [x] Abort stops the current turn.
- [x] Busy, queued count, and "pi exited" are all visible without opening a terminal.
      `test/web-page.test.ts`: *a tool call and a dead pi both reach the page*.
- [x] Prompt history: ArrowUp and ArrowDown, but only while the caret is on the first or last line,
      so they still navigate a multi-line draft.

## Composing

- [x] `/` completes slash commands; `@` completes paths, and the mention is expanded before the
      prompt is sent — the expansion is anchored to the session's directory, not to anything the
      browser supplies.
- [x] A command with an argument can be typed straight through. The completion list closes on the
      space, and an answer still in flight does not put it back — which it did, so Enter accepted
      the completion instead of sending the line and anything taking an argument was mouse-only.
      `test/web-page.test.ts`: *a completion answer in flight does not reopen a list the space just
      closed*.
- [x] A command that takes no argument runs on one Enter, the way it does in a terminal. When what
      you have typed is already the whole of the highlighted completion there is nothing left to
      accept, so Enter sends the line; a shorter prefix still gets completed, and Tab only ever
      inserts. `test/web-page.test.ts`: *Enter on a command already typed in full sends it instead of
      completing it again*.
- [x] Images: attach, paste, and a strip showing what is attached, each with a visible way to take
      it off again. An image-only prompt is valid; ten per message is the cap, and it says so. PNG,
      JPEG, GIF, WebP and AVIF, the same set however it arrived — anything else is refused with the
      same visible notice rather than sent under a type it is not.
      `test/web-page.test.ts`: *a message carries at most ten images*, *an image type the page cannot
      render is refused rather than sent as a broken PNG*.
- [x] A tap on a composer button lands on that button, even with a soft keyboard open — tapping it
      blurs the box, which dismisses the keyboard, which moves everything.
      `test/web-page.test.ts`: *a phone's soft keyboard cannot steal the tap on send*.

## What the feed shows

- [x] Assistant text, thinking, tool calls, tool results, errors, and the end of a turn.
- [x] The conversation is what the conversation is for. A whole stretch of work — thinking and tool
      calls, interleaved as they arrive — is **one** row, closed: what is happening while it happens,
      what happened afterwards. One button in the header opens or closes every one of them.
      `test/web-page.test.ts`: *a stretch of work is one row, and one button opens every one of
      them*.
- [x] Replies render as Markdown — headings, lists, quotes, rules, tables, inline code, fenced
      code, and http(s) links. Everything is escaped first: a reply is not trusted input, and a
      tool result quoted inside one is whatever some web page said. `test/web-page.test.ts`: *a
      reply is rendered as Markdown, and cannot smuggle markup through it*.
- [x] Terminal escape sequences are stripped rather than shown. Plenty of what reaches a session
      was written for a terminal. `test/web-page.test.ts`: *terminal escape codes do not reach the
      screen as text*.
- [x] Your own message appears once, whether the page drew it or pi echoed it back.
      `test/web-page.test.ts`: *your own message is drawn once*.
- [x] Text selection works, and is never destroyed by an update: the feed is appended to, never
      rebuilt. The cost of appending is that a missed event leaves a hole, so events are numbered
      and a gap reloads the transcript rather than drawing on top of one. A page that stops being
      told anything at all notices that from its own polling, rather than sitting there looking
      alive. `test/web-page.test.ts`: *a page that stops receiving events notices by itself*.
      `test/web-page.test.ts`: *a gap in the event stream reloads the conversation*.
- [x] While you are reading back through the conversation, an update never yanks the page — and
      never arrives silently either: there is a way back to the newest.
- [x] Every block says when it happened.
- [x] Every message, tool call and result can be copied, including over plain http where the
      clipboard API is unavailable. The button waits for a hover on a mouse and is simply always
      there on a touch screen, which has no hover to wait for.
- [x] Tool results, an extension's messages and pi's dying words are capped, and every cap says how
      much was dropped — one helper for the three of them, because they used to report it three
      different ways and one of them not at all, so a result that stopped at 8000 characters looked
      like a result that ended there.
- [x] **You can see what the session made, not only read about it.** A picture in a reply is a
      picture — including one named in ordinary prose rather than as a link; a path is something to
      open; a page written into the reply has a preview; an image a tool returned is shown rather
      than dropped. `test/web-page.test.ts`: *a path written in prose becomes something to open*.
      Everything served that way is anchored inside the session's directory — and inside `$HOME`,
      because an agent asked to make something for a person leaves it where a person keeps things,
      but there only for the types one *looks* at, so a service-account key named like ordinary JSON
      is not previewed. Both roots exclude every dot segment and the directory holding the token.
      Restricted to file types worth showing, and sandboxed into an opaque origin — a page the model
      wrote can be looked at and cannot act.
      `test/web.test.ts`: *a file the session made can be looked at, and nothing else can*.
      `test/web-page.test.ts`: *a reply can show a picture*, *an image that came back from a tool*.
- [x] A tool call and what it returned are one block, and it starts closed. A tool that prints two
      hundred lines must not push the conversation off the screen to do it.
      `test/web-page.test.ts`: *a run of tool calls is one row, and the next run is a new one*.
- [x] You are on the right in a bubble and the model is full-width prose: the shape says who is
      speaking before a word is read. Status lines are small, monospace and quiet — context, not
      conversation.
- [x] The conversation has a reading width. A line the width of a 27-inch monitor is not readable.
- [x] An empty session says what it is and what to type, rather than being a blank rectangle —
      which is also the first thing a newly paired phone shows, and what is left when the last
      message is undone: a line the page wrote about itself is not a conversation.
      `test/web-page.test.ts`: *an empty session says what it is*, *undoing the only message shows
      the empty state*.

## Automation, which is the reason this project exists

- [x] Jobs, loops and rules: what they are, whether they are enabled, and what the last error was.
- [x] **What this project has is what this project has, and the rest is counted rather than
      dropped.** The store is machine-wide and this list is not, so a job made in another directory
      says so as a count — without it, a job somewhere else is indistinguishable from a job that is
      gone. Jobs and rules are counted and labelled apart, each line naming the command that lists
      them (`/cron all`, `/triggers rules --all`): one number covering both agrees with neither
      command, and the line exists to send you to the command.
      What counts as "this project" is what the extension says it is — symlinks resolved, `$HOME`
      too broad to be one — because a panel that disagrees with the command is worse than either.
      `test/web.test.ts`: *the panel and /cron agree about what this project is*.
      `test/web-page.test.ts`: *a job this machine no longer owns is listed, not hidden*.
- [x] **When each job runs next, whatever its schedule.** The page used to work this out itself and
      understood only `every <interval>`, so a job on `0 9 * * *` — the first example in the
      README — showed nothing. A second cron parser in a page with no dependencies was the wrong
      fix: the process that owns the clock has the evaluator, and writes the answers to
      `next-runs.json` beside the store when one of them changes. A time that has already passed is
      shown as no next run rather than as a past one, a job that is disabled or belongs to another
      machine is not promised one, and a next run that is not today says which day it is.
      `test/scheduler.test.ts`: *the leader writes when each job runs next*.
      `test/web.test.ts`: *the panel shows the next run of a cron-expression job*.
      `test/web-page.test.ts`: *a next run in April does not render as a time of day*.
- [x] The name of a job is never abbreviated: it is what `/cron set <name> …` takes, so a clipped
      one is a name you cannot act on. It wraps; the schedule beside it does not break in half.
- [x] Run a job now.
- [x] Inbox count.
- [x] Runtime: scheduler state and whether this pi owns the clock, MCP servers and their state,
      hook count and events, tool count, last poll, snapshot age and version.
- [x] A count leads to the list behind it — "24 tools" answers the wrong question on its own.
      `test/web-page.test.ts`: *a count in the panel leads to the list behind it*.
- [x] Goal state and the session's own metadata.
- [x] A malformed job in a store file does not blank the panel. `test/web-page.test.ts`: *a job
      with the wrong types in it does not blank the sidebar*.
- [x] On a narrow screen the panel is a drawer, not something that disappears: what a loop is doing
      is the reason to open this on a phone.
- [x] Thirteen controls do not fit across a phone. The ones you reach for mid-conversation stay in
      the header; the rest move — not copy — into a sheet behind one button.
      `test/web-page.test.ts`: *the header's secondary actions move into a sheet and back*.

## How it looks

- [x] Light and dark are both designed: every surface is a named colour, not a translucent grey
      over whatever the browser paints, so the page looks the same on a machine whose default
      background is not white.
- [x] The stored theme is applied before the first paint. Applied later, a dark page renders light
      and then blinks. `test/web-page.test.ts`: *the stored theme is applied before the first
      paint*.
- [x] Prose is proportional and anything from a terminal is monospace — with CJK faces named in
      both stacks, because the default fallback is neither the right shape for reading nor the
      right width for a box someone drew with line characters.

## Confirmations

- [x] Anything an extension asks — select, confirm, input, editor, notify — is answerable in the
      browser. A session whose only question is on a terminal you closed is a stuck session. One
      asked while no browser was attached is held for a browser that turns up, and the list of those
      is bounded the way the event backlog is: an abandoned dialog was otherwise re-offered every
      eight seconds for as long as the process lived.
- [x] A confirmation shows what is about to happen apart from the reasoning about it, so it cannot
      be read as prose and waved through. `test/web-page.test.ts`: *a confirmation shows what is
      about to run*.
- [x] Enter does not approve: the focus starts on cancel.
- [x] A slash command that waits in a dialog is not reported as timed out while the person reads:
      the browser waits up to fifteen minutes for a `/…` prompt, sixty seconds for anything else.
- [x] Clicking away from any dialog closes it. `test/web-page.test.ts`: *clicking outside a dialog
      closes it*.

## Session

- [x] Model and thinking level, switchable, with the failure reported when credentials are missing,
      and **remembered**: the next session starts on the model you last chose.
      `test/cli.test.ts`: *the model you chose last time starts the next session*.
      The picker is grouped by provider and says what decides the choice — the model's own name, its
      context window, whether it takes images — with the ones you have used recently at the top. pi
      only offers models from providers you have configured, so everything in it is usable.
- [x] The model in use is in the picker even when pi's catalog has never heard of it. A session can
      be running on a provider this machine has no credentials for, and pi lists only the ones it
      does — so the picker had nothing to select and showed an empty control beside a panel naming
      the model, which reads as "no model". It is offered under its own provider, marked as not in
      the catalog so the reason is on the screen.
      `test/web-page.test.ts`: *the model in use is in the picker even when the catalog has never
      heard of it*.
- [x] The thinking levels offered are the ones this model has — asked for per model rather than
      drawn from one fixed list, because picking a level a model does not implement does nothing at
      all.
- [x] Attaching an image is refused, with the reason, by a model that cannot see one.
- [x] Cost and token counts.
- [x] Compact, undo (fork from your last message), find across the whole session including
      abandoned branches, export to HTML, and share as a redacted gist. Undo reloads the
      conversation through the one path every other thing that empties the feed uses, so an undone
      session is as empty as a new one rather than a blank rectangle with a notice on it.
      `test/web-page.test.ts`: *undoing the only message shows the empty state*.
- [x] Compaction says what it did — what the context was and what it became, and what the summary
      cost — and what it keeps can be steered: `/compact keep the API shapes`, as in the terminal.
      A line that reports neither is a line asking to be taken on faith.
      `test/web.test.ts`: *the compact button can steer what the summary keeps*.
      `test/web-page.test.ts`: *clear, resume and compact are typed as well as clicked*.
- [x] **Starting over does not mean going back to a terminal.** The context is finished with far
      more often than the window is: a new session and going back to an earlier one are both here,
      by button and by `/clear`, `/new` and `/resume` typed in the composer — the habit comes from a
      terminal and the muscle memory arrives with it. Neither deletes anything: the session being
      left is a file that `resume` lists, labelled by what was said in it rather than by a filename.
      `test/web.test.ts`: *a new session is a path pi has not written yet, and going back is one it
      has*. `test/web-page.test.ts`: *the session you are in is not offered as one to go back to*.
- [x] **The session commands are two words here.** `/sessions` prints this project's sessions into
      the feed — short id, when, what was first said — and `/session export [path]` / `/session
      import <path>` are the archive commands, sent as `/session-export` / `/session-import`. pi's
      own `/session` is a terminal command that does not exist over rpc, which is why the extension
      had to hyphenate its names in the terminal and why the page is free to spell them plainly.
      `test/web-page.test.ts`: */sessions and /session export are typed here*.
- [x] A session started here is a session pi-loops recognises. pi names the sessions it starts after
      their id and the front end cannot know that id in time, so anything identifying a session by
      its file name is wrong about this one — which parked every inject-and-run cron job made in a
      session started from the page. `test/store.test.ts`: *sessionExists scans pi's sessions root*.
- [x] Nothing read off the disk can make a line say something other than what it is: terminal
      escapes and the bidi overrides that reorder text are stripped from every name and message
      shown, and the picker is where that matters most.
      `test/web-page.test.ts`: *a name cannot reorder the line it is drawn on*.
- [x] A session is not swapped out from under a turn that is running — the swap would abort it, and
      losing a reply you are waiting for is not something to find out afterwards. The refusal is on
      the server, so a tab left open across an upgrade cannot skip it.
      `test/web.test.ts`: *a session is not swapped out from under a turn that is running*.
- [x] Going back to a session puts it back on the model it was last using. A `--model` on the launch
      command line — yours, or the remembered one the launcher adds — lasts as long as the process
      rather than the session, so pi re-applies it on every swap and a resumed conversation landed on
      a model it was never had with. A model whose credentials are gone is reported rather than
      forced. `test/web.test.ts`: *going back to an earlier session puts it back on the model it was
      last using*.
- [x] `--continue`, `--resume` and `--session` reach pi unchanged, so a session moves between the
      two windows.
- [x] **Ending the window ends the session, properly.** Ctrl-C in the terminal that started it means
      `/quit`, not a kill: pi is started in a process group of its own so the terminal's SIGINT
      cannot reach it, is asked to shut down with the signal it does handle, and is waited for — which
      is what hands the clock to the headless host and what puts the line saying so in front of you
      before the window closes.
      `test/web.test.ts`: *the pi behind the page runs in a process group of its own*, *Ctrl-C in that
      terminal ends the session the way /quit does, and waits for it*.
- [x] **And the terminal is told what became of the automation.** pi-loops announces the hand-off
      through `ctx.ui.notify`, and `ctx.hasUI` is true in rpc mode — so the note is an event addressed
      to a page whose server is the process on its way out, and the person who pressed Ctrl-C saw only
      `pi exited (143)` while their loops kept running somewhere nobody had told them about. That note is
      relayed to the terminal when it arrives; when it does not, the loops directory is read the way
      `pi-loops host status` reads it — the live host and how to see or stop it, or that none started
      and which log says why, or nothing at all when nothing was going to run.
      `test/web.test.ts`: *Ctrl-C says where the automation went, when pi's own note never arrives*,
      *pi's own word on the hand-off reaches the terminal when it arrives in time*.
- [x] **A window older than what is installed says so, across the top, with the button that fixes
      it.** A tab left open across an upgrade looks exactly like a current one — the panel even
      shows a version, but that is the server's, read live — and three rounds of "no reply appears"
      were spent on a page that could not have received one.
      `test/web-page.test.ts`: *a page left open across an upgrade says so*.

### Held, with the reason

- **pi's own built-in slash commands.** They do not exist in `pi --mode rpc`; there is nothing to
  call. The extension's own commands work.
- **`/login`.** Its OAuth flow has no rpc equivalent. Log in once with `pi` and the rest follows.

## Transport

- [x] Loopback by default. `--host` binds elsewhere, and refuses `--no-auth` when it does.
      `test/web.test.ts`: *--no-auth is refused when the front end is put on the network*.
- [x] A name you put in front of this — a reverse proxy, a hostname on your own network — is named
      with `--allow-host`, nothing else is accepted under it, and the flag is in `--help`: a flag
      that relaxes a security check and is not documented is a flag nobody can audit.
      `test/web.test.ts`: *--allow-host admits the name you put in front of it, and no other*.
- [x] A `--port` that is not a port is refused out loud rather than served somewhere else.
      `test/web.test.ts`: *a --port that is not a number is refused rather than quietly served
      somewhere else*.
- [x] **Every route keeps its own guards, the escape hatch included.** `/rpc` carries anything in
      pi's protocol this front end has not grown a button for, and refuses the commands that do have
      a route here — reaching pi through it skipped the mid-turn refusal, the "one of this project's
      sessions" check, and the reset the attached browsers are owed when a session is swapped. It
      also refuses `new_session` and `clone`, which replace that session with no route to do the
      resetting: opening a fresh session is `/switch_session`-shaped work.
      `test/web.test.ts`: *the escape hatch cannot be used to skip a route's own guards*.
- [x] The routes that only read are only read from: `/state`, `/history` and `/stats` answer GET and
      nothing else. `test/web.test.ts`: *the routes that only read are only read from*.
- [x] A request another site started is refused on every route, whatever cookie the browser
      attached. `test/web.test.ts`: *a request another site started is refused*.
- [x] One address that does not change between launches, and a device is added by pointing its
      camera at a QR — with the six digits as the fallback, never a curl command.
      `test/web.test.ts`: *the token outlives the process*, *a phone gets in with the six-digit
      code*. `test/web-page.test.ts`: *adding a device shows a code and something to point a camera
      at*, *the QR encoder still produces the matrix a scanner was shown*. A guess spends one of
      twenty tries, so a browser that is already signed in is recognised as signed in first —
      otherwise reloading a bookmark with a stale code on it burns the budget the phone needs.
      `test/web.test.ts`: *a signed-in browser reloading a stale pairing code does not spend a
      guess*.
- [x] Pairing survives an upgrade: the token is a file outside the package, so a device stays signed
      in across restarts and new versions. `test/web.test.ts`: *the token outlives the process*.
- [x] Events are incremental. The backlog a late-joining browser replays is bounded.
- [x] Events carry no credential and no oversized tool payload; the image bytes a message already
      contains travel with it, and the page renders them rather than fetching them. The page itself
      is handed the token — in the cookie, and in the URL on a first visit — and nothing else is. The
      one event that could have carried a credential was pi's stderr, broadcast when it exits to say
      why: a provider that refuses to authenticate prints the key it was refused with, so that tail
      is capped and redacted before it leaves this process. The terminal that started the session
      still has the whole of it.
      `test/web.test.ts`: *a credential in pi's dying words does not reach the page*.
