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
- [x] Images: attach, paste, and a strip showing what is attached. An image-only prompt is valid.
- [x] Image bytes never appear in the feed or in any event this server broadcasts.

## What the feed shows

- [x] Assistant text, thinking, tool calls, tool results, errors, and the end of a turn.
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
      rebuilt.
- [x] Every message, tool call and result can be copied, including over plain http where the
      clipboard API is unavailable. The button waits for a hover on a mouse and is simply always
      there on a touch screen, which has no hover to wait for.
- [x] Tool results and errors are capped, and the cap says how much was dropped.
- [x] A tool call and what it returned are one block, and it starts closed. A tool that prints two
      hundred lines must not push the conversation off the screen to do it.
      `test/web-page.test.ts`: *a tool call and a dead pi both reach the page*.
- [x] You are on the right in a bubble and the model is full-width prose: the shape says who is
      speaking before a word is read. Status lines are small, monospace and quiet — context, not
      conversation.
- [x] The conversation has a reading width. A line the width of a 27-inch monitor is not readable.
- [x] An empty session says what it is and what to type, rather than being a blank rectangle —
      which is also the first thing a newly paired phone shows. `test/web-page.test.ts`: *an empty
      session says what it is*.

## Automation, which is the reason this project exists

- [x] Jobs, loops and rules: what they are, when they run next, whether they are enabled, and what
      the last error was.
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
- [x] Eleven controls do not fit across a phone. The ones you reach for mid-conversation stay in
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
      browser. A session whose only question is on a terminal you closed is a stuck session.
- [x] A confirmation shows what is about to happen apart from the reasoning about it, so it cannot
      be read as prose and waved through. `test/web-page.test.ts`: *a confirmation shows what is
      about to run*.
- [x] Enter does not approve: the focus starts on cancel.

## Session

- [x] Model and thinking level, switchable, with the failure reported when credentials are missing.
- [x] Cost and token counts.
- [x] Compact, undo (fork from your last message), find across the whole session including
      abandoned branches, export to HTML, and share as a redacted gist.
- [x] `--continue`, `--resume` and `--session` reach pi unchanged, so a session moves between the
      two windows.

### Held, with the reason

- **pi's own built-in slash commands.** They do not exist in `pi --mode rpc`; there is nothing to
  call. The extension's own commands work.
- **`/login`.** Its OAuth flow has no rpc equivalent. Log in once with `pi` and the rest follows.

## Transport

- [x] Loopback by default. `--host` binds elsewhere, and refuses `--no-auth` when it does.
      `test/web.test.ts`: *--no-auth is refused when the front end is put on the network*.
- [x] A request another site started is refused on every route, whatever cookie the browser
      attached. `test/web.test.ts`: *a request another site started is refused*.
- [x] One address that does not change between launches, and a device is added by pointing its
      camera at a QR — with the six digits as the fallback, never a curl command.
      `test/web.test.ts`: *the token outlives the process*, *a phone gets in with the six-digit
      code*. `test/web-page.test.ts`: *adding a device shows a code and something to point a camera
      at*, *the QR encoder still produces the matrix a scanner was shown*.
- [x] Pairing survives an upgrade: the token is a file outside the package, so a device stays signed
      in across restarts and new versions. `test/web.test.ts`: *the token outlives the process*.
- [x] Events are incremental. The backlog a late-joining browser replays is bounded.
- [x] Nothing this server sends carries an API key, a credential, a raw image, or an oversized tool
      payload.
