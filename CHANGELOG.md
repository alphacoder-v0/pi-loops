# Changelog

All notable changes to pi-loops are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer.
Behavior is cross-checked against [pie](https://github.com/c4pt0r/pie) source, file by file.

## [0.12.2] - 2026-09-10

### Fixed
- **A page that stops receiving events now notices by itself.** Everything in the front end reacts
  to events, which is no use at all when the events are what stopped arriving — and they do: a
  server restarted under an open page, a stream the browser dropped while the tab sat in the
  background. The page went on looking alive, drawing what you typed and never showing an answer,
  until somebody thought to reload it. `/state` — which the page polls anyway — now carries the
  same two numbers the stream does, so a page that is behind can see that it is behind and take the
  conversation again. A restart is acted on at once; a stream that has merely gone quiet has to be
  behind on two polls in a row, because one poll can simply overtake an event in flight.
- The reload and the poll no longer call each other: a reload ends by refreshing, and a refresh
  polls.

### Note
This is the fix for "I send a message and no reply appears" after an upgrade. The cause was that
the event stream is numbered per run of the server process, and a page loaded before the upgrade
kept counting against the numbering of the process that had been replaced — skipping everything the
new one sent, for ever, while still polling happily. Reloading fixed it, which is why 0.12.1 said
so; now the page fixes itself.

## [0.12.1] - 2026-09-10

### Fixed
- An event arriving while the conversation was being reloaded was drawn *before* the transcript it
  belongs after, putting the newest message above the conversation. Events that land during a
  reload now wait their turn. (Nothing was lost: the feed is emptied before the wait, not after —
  an earlier note here said otherwise and was wrong.)

### Note
If a tab that was open before an upgrade stops responding, reload it. The server's event numbering
starts fresh with each run of the process, and a page loaded from a version before 0.12.0 has no
way to notice that — it goes on skipping numbers it thinks it has already seen. 0.12.0 and later
detect the restart and reload the conversation by themselves; that fix cannot reach a page that was
already open when it was installed.

## [0.12.0] - 2026-09-10

### Added
- **You can see what the session made.** A reply that says "the chart is in ./out/chart.png" is a
  reply you cannot see the chart in, and a page the model wrote was HTML source in a code block.
  Now: a Markdown image in a reply is an image; a link to a path is something to open — png, jpeg,
  webp, gif, pdf, html, csv, json, txt; an HTML block written into the reply has a **preview**
  button; and an image a tool returned is shown instead of being dropped, which is what happened to
  every screenshot until now.
- **The model and thinking level you chose are remembered**, in `ui.json` beside the loops, and the
  next session starts on them — the terminal window as well as the browser one, since the launcher
  is what applies them. Not when you said which model yourself, and not for `--continue`,
  `--resume` or `--session`, whose session already has the model its conversation was had with.

### Security
Everything a preview serves is anchored inside the session's own directory, restricted to a list of
types worth showing, capped, and sandboxed into an opaque origin — a page the model wrote can be
looked at and cannot act. From the review of that:
- **The token was in the URL of every generated link and preview**, where a page the model wrote
  could read it out of `location.search` and post it anywhere. It is gone: these are same-origin
  requests from this page and the cookie already authenticates them.
- **A request from an opaque origin (`Origin: null`) was treated as same-site.** Nothing on this
  server produced such a document before; the previews do. It is refused now, which is what keeps a
  sandboxed page out of `/rpc` on a browser that sends no `Sec-Fetch-Site`.
- **A path with a dot segment is refused.** A session started in a home directory has
  `.claude/.credentials.json` and `.env` inside it, and `.json` is a type worth showing. Nothing
  anybody wants to *look at* begins with a dot.
- The file is opened once and read through that descriptor, rather than resolved three times;
  `referrer-policy: no-referrer` on both routes, since a served page picks its own otherwise; and
  the MIME type of an image block is pinned to an image type rather than repeated from the tool
  result.
- **Events are numbered per run of the process.** A browser holding number 40 from the process that
  just exited was quietly ignoring the first forty events of the one that replaced it — every
  number looked like one it had already seen. A restart is not a gap, it is a different sequence.
- The notice that says the conversation was reloaded is written after the reload rather than
  before, where it was the first thing the reload removed.

## [0.11.0] - 2026-09-10

### Changed
- **A run of tool calls is one row of the conversation, not one each.** A turn that reads four
  files and runs two commands spent six rows saying so, and the conversation is the thing you are
  reading. Consecutive calls collect into a single line: while they run it says what is running, and
  afterwards it says what ran — `3 tools · read, bash`. Everything is still there, one click in.
  Closed, it is a line of text rather than a box drawn around one line.
- **Thinking says enough about itself to be worth a click.** It was already closed by default and
  has always opened on click; what it lacked was any reason to. The line now carries the first of
  what it says.
- **The model picker is grouped by provider and describes the models**: their own names, how much
  context, and whether they take images — with the ones you have chosen recently at the top of the
  list, remembered in that browser. Thirty-three lines of `provider/id` is a list, not a picker.
  (pi only offers models from providers you have configured, so nothing in there is unusable.)
- **The thinking picker offers the levels this model actually has.** pi maps them per model and the
  map has holes in it; a level a model does not implement did nothing at all.
- **Attaching or pasting an image into a model that cannot see one is refused, with the reason.**
  pi says which models take images and the button was guessing.

## [0.10.0] - 2026-09-10

A third pass against the reference UI. Two of these are things it does that this did not; two are
its lesson applied rather than copied; two are its problems avoided.

### Added
- **A way back to the newest message.** Reading back through a long conversation, an update never
  yanks the page — and until now it never announced itself either, so a reply could arrive with
  nothing on screen to say so. There is a pill above the composer while there is something below
  the fold.
- **Every block says when it happened**, on hover. A long session had no answer to "when was
  that".
- **A gap in the event stream reloads the conversation.** The reference UI streams a whole snapshot
  and re-renders, which is always consistent and costs it a selection, an open tool panel, and a
  mechanism to put both back. This keeps appending — and takes the consistency by noticing when a
  number is missing (a reconnect, a tab the browser suspended) and taking the transcript again
  rather than carrying on with a hole in it.
- **Ten images per message**, and it says so rather than silently building an enormous request.
- **Clicking away from a dialog closes it.** A native `<dialog>` does not do that on its own.

### Fixed
- **A tap on "send" could land on nothing while the keyboard was up.** Tapping a button beside the
  box blurs the box, which dismisses the soft keyboard, which relayouts the page before the click
  is dispatched. The button appears dead. This is invisible in a desktop browser, which has no
  soft keyboard — it came from reading how the reference UI solves it.

## [0.9.2] - 2026-09-10

A second pass through the front end in a real browser, this time clicking everything: completion,
prompt history, model and effort, queueing and stopping, approvals, the panel's counts and its run
buttons, search, undo, copy, image attach, the door page, pairing by typing the code, and pi dying
underneath it.

### Fixed
- **`@src/we` listed the whole of `src/`.** Every keystroke asks for completions and the answers do
  not come back in the order they were asked for — the reply to `@src/` arrived after the reply to
  `@src/we` and overwrote it. Only the newest request may draw now.
- The door page — the first screen a new device sees — had no viewport tag and no colour scheme:
  desktop-width text on a phone, and a white page on a device in dark mode.
- `undo` said "it is back in the composer" whether or not anything came back.

### Verified, not changed
Everything else behaved: slash and `@` completion including Tab and Enter, prompt history on the
arrow keys, switching model and thinking level, queueing a turn while one is running and clearing
it, stop leaving unfinished tool calls marked rather than spinning, a confirmation showing what it
is about to do with the focus on cancel, a question from an extension reaching a browser that
arrived *after* it was asked, a metric tile opening the list behind it when clicked on the number,
running a job from the panel, search across abandoned branches, copy, attaching an image and
removing it again, and pi exiting underneath the page saying so instead of going quiet.

The QR was checked the whole way again — encoded here, drawn as SVG, rendered by Chrome,
screenshotted, and decoded back out of the pixels by OpenCV to the exact pairing URL — and so was
the first-run path: cookies cleared, the door page, six digits typed, signed in, and still signed
in after a reload.

## [0.9.1] - 2026-09-10

Everything here was found by opening the page in a real browser and using it — typing, sending,
expanding, tapping — rather than by reading the code. 0.9.0 shipped without that, and this is what
was wrong with it.

### Fixed
- **A reply could freeze as raw Markdown with its tools stuck on "running".** The page replayed the
  transcript and then joined the live stream, and dropped every `message_end` for the first 300ms
  so the backlog would not double what it had just drawn. That guess also dropped the *live* ones
  whenever the backlog held a turn that was still running — which is to say, whenever you opened or
  reloaded the page while pi was answering. Both the tool results and the end-of-message that turns
  a streamed reply into rendered Markdown are `message_end`. Every event is numbered now and the
  transcript hand-off says which number it was taken at, so the skip is exact.
- **Every code block on the page was rendered with wide letter spacing.** The pairing code claimed
  `class="code"`, which is also what a fenced block gets. It is styled by its id now.
- **A tall block was squeezed instead of scrolling the feed.** The feed is a column flexbox with a
  definite height, so its children shrank to fit: an expanded tool call had its last line cut in
  half.
- **The composer on a phone was about 150px wide**, with three buttons beside it and a scrollbar of
  its own. The box takes the width now and the buttons take a row underneath.
- **The drawer could only be dismissed by tapping the 47px strip it did not cover.** It has a scrim
  now — the whole of "somewhere else" closes it, and what it covers is dimmed, which is also how
  you can tell the panel is on top of the conversation rather than beside it.
- The header on a phone gives up the working directory and the program's own name, which are in the
  session panel and on the home-screen icon respectively.

## [0.9.0] - 2026-09-10

### Changed
- **A tool call and what it returned are one block, and it starts closed.** They used to be two,
  both open: a wall of argument JSON followed by however many thousand characters came back. One
  shell command could push the conversation off the screen, and on a phone it did. The summary line
  is the part that matters — which tool, on what — and it says `running` until the result arrives.
- **You are on the right in a bubble; the model is full-width prose; status lines are small, quiet
  and monospace.** Three kinds of thing were being drawn in one voice, and a long session turned
  into a wall. The shape now says who is speaking before a word of it is read.
- **The conversation has a reading width.** It used to run the full width of the window, which on a
  wide monitor is a line nobody can read.
- **Prose is proportional now, and only what came from a terminal is monospace.** Both stacks name
  CJK faces: the mono one so a box drawn with line characters keeps its corners, the proportional
  one so Chinese reads like text rather than a grid.
- **Light and dark are both designed.** Every surface is a named colour instead of a translucent
  grey over whatever the browser happened to paint, and the stored theme is applied before the
  first paint rather than after it — applied late, a dark page renders light and then blinks.
- **An empty session says what it is.** A blank rectangle is the one thing a front end can show
  that says nothing at all, and it is also the first screen a newly paired phone gets.
- **Counts in the side panel are a row of figures**, each one a target big enough for a finger and
  each one opening the list behind it.
- **The header fits on a phone.** Eleven controls do not. The ones you reach for mid-conversation
  stay; the rest move — not copy — into a sheet behind one button.
- Image thumbnails have a visible ✕. "Click to remove" lived in a tooltip, and a finger cannot
  hover.
- The copy button waits for a hover on a mouse and is simply always there on a touch screen.

### Fixed
- **Two calls to the same tool no longer swap results.** They were paired by name, first in first
  out, which is only correct if results come back in call order — two shells started together
  finish when they finish. They are paired by call id now, with the name as a fallback.
- **A result nobody called for used to break every later pairing for that tool.** The orphan block
  was pushed onto the queue it had just failed to match, and everything after it was off by one for
  the life of the tab.
- A tool call that never returns stops saying it is running when the turn ends.
- `undo` clears the feed; it now also clears what was pointing into it, rather than appending later
  output to nodes that are no longer on the page.
- **The find bar could not be hidden.** A rule that sets `display` beats the browser's own `[hidden]`
  rule, so it was open on every page load and the button did nothing visible.
- A metric tile was only clickable on its 8px padding ring: the click almost always lands on the
  number or the label, and the handler was looking for the key on whatever it hit.
- An action tapped in the phone sheet now closes the sheet before it runs. A modal dialog makes the
  rest of the page inert, so `find` had its focus call ignored and no keyboard came up.

## [0.8.3] - 2026-09-10

### Documentation
- The browser front end's own configuration was not written down anywhere: `--port`, `--host`,
  `--allow-host`, `--no-auth`, `--no-open`, `PI_WEB_TOKEN`, and the `web-token` file — including
  what deleting that file does, which is sign every device out.
- Troubleshooting for the things a person actually hits with it: a browser that has not been here
  before, a phone that cannot reach it at all, a QR that scans to nowhere because it was pressed in
  a window on 127.0.0.1, a port already in use, a pairing code that stopped working, and every
  device signed out at once.
- The design note said reaching a session from another device had no equivalent here. It has a
  different one: `tailscale serve` puts the page on your phone with nothing of yours passing
  through a third party, rather than a hosted broker in the middle. What that does not cover — a
  phone on neither network — is now stated as the gap it is.

## [0.8.2] - 2026-09-10

### Fixed
- **A sub-session could load a second copy of pi-loops on macOS**, which pi refuses to start with
  (`Tool "cron_create" conflicts with …`). `isInsideDir` resolved symlinks only for paths that
  already exist, and fell back to the unresolved path otherwise — so a comparison between
  `/private/var/…` and `/var/…` said "outside" for a file that was plainly inside. On macOS that is
  every path under a temporary directory, since `/var` is a link to `/private/var`; anywhere else
  it is any project reached through a symlink. It now resolves the deepest ancestor that does exist
  and re-attaches the rest.
- CI has been failing on macOS since the pipeline was added, on these two tests, and every release
  since 0.4.0 shipped with it red. One was this bug; the other was a test comparing `piPackageDir`
  (which resolves symlinks, because `pi` is a bin symlink) against a path that had not been
  resolved. Running the suite locally on Linux is not the same as running it, and nothing was
  watching the part that said so.

## [0.8.1] - 2026-09-10

### Changed
- **Adding a device is a button, not a curl command.** 0.8.0 shipped the pairing code with `POST
  /pair` as the way to get another one, which is an instruction for an operator, not a product.
  Press **add device** in a browser that is already signed in: it shows a **QR code** to point the
  phone at — nothing typed at all — with the six digits underneath for when a camera is not what
  you want to use.
- The QR encodes the address *this browser reached the server on*, which under `tailscale serve` is
  the tailnet name and works from anywhere on your tailnet. Pressed in a window that is on
  `127.0.0.1`, there is no address that would work from a phone, so it says that and what to do
  about it instead of showing a QR that cannot work.
- The QR encoder is written here — byte mode, error correction M, versions 1 to 6, about 250 lines
  and no dependency. It was checked by *decoding* its output with a real scanner (OpenCV) at every
  payload length it supports, not by comparing against another encoder. Two bugs turned up that way
  and neither would have failed a self-consistent test, because both produced a well-formed
  picture: a Reed-Solomon generator polynomial built in the wrong direction, and the two copies of
  the format bits transposed. The test in the repo freezes a matrix that a decoder read.

### Security
- **The QR is no longer aimed at whichever address the machine happened to list first.** `internal`
  in Node means loopback and nothing else, so the candidate list also held every virtual bridge on
  the machine — docker0, libvirt, VirtualBox — and those addresses belong to something else on the
  phone's network. Named ones are dropped, the rest are ordered tailnet-first, and when more than
  one survives the dialog asks which rather than guessing: a live pairing code sent toward the
  wrong host is a secret handed to a stranger.
- **A pairing code expires after ten minutes**, and closing the dialog retires it. It used to stay
  armed for the life of the process, which was tolerable when one was minted per launch and is not
  now that a button mints them — a QR bundles the address and the code into one thing a camera
  resolves in a single frame, so one left on screen behind whatever you did next is a complete
  sign-in.
- Minting a code no longer resets the guess budget separately from the code itself, and JSON
  responses say `cache-control: no-store` — one of them now carries a code.

### Fixed
- A block comment opened and never closed had swallowed a hundred lines of the page — valid
  JavaScript, accepted by `node --check`, invisible to the linter, and the page still loaded with a
  hole where the encoder used to be. There is a test now that asks the page which of its own
  helpers it can actually see.

## [0.8.0] - 2026-09-09

### Added
- **The browser front end works from a phone.** It binds loopback, which a phone cannot reach, so
  there are now two ways across. `tailscale serve --bg 4173` is the good one: this server stays on
  127.0.0.1 and the tailnet does TLS and identity, so the request arrives looking local and
  carrying the tailnet name as its `Host` — accepted for that reason, and for no other name.
  `pi-loops --host 0.0.0.0` is the other, for a phone on the same wifi; `--no-auth` is refused
  outright in that mode, since it would put an unauthenticated shell on the network.
- **A six-digit pairing code**, printed at startup. The token is 32 hex characters, which is fine
  to click and miserable to type on a screen keyboard; the door page asks for the code instead, and
  that device stays signed in afterwards. One use, and twenty wrong guesses disable it.
- **The page is installable**: a web app manifest and an icon, so it opens from the home screen
  without browser chrome. No service worker — nothing here is worth caching, and a stale copy of a
  front end whose whole job is to be live is worse than no copy at all.
- **Replies are rendered as Markdown**: headings, lists, quotes, rules, tables, inline and fenced
  code, emphasis, and links that have to be http(s) before they are made into links. A model writes
  Markdown whether or not the front end reads it, and a page that shows the source is showing you
  asterisks where a list was meant. Everything is escaped first: a reply is not trusted input, and
  a tool result quoted inside one is whatever a web page said.
- **A count in the side panel leads to the list behind it.** "24 tools" answers the wrong question;
  which twenty-four is the question people have.
- **A theme switch** (system, light, dark) and a side panel that can be collapsed on a wide screen,
  both remembered in that browser and nowhere else.
- **[docs/web-ui-parity.md](docs/web-ui-parity.md)**: what the browser front end owes you, as a
  gate rather than a wish list. A release either keeps every line or moves one to "held" with the
  reason. Each line names the test that enforces it, where one does.
- **A copy button** on messages, tool calls and results, with a fallback for the plain-http case,
  where the clipboard API is unavailable because the context is not secure.

### Fixed
- **Enter no longer sends half a sentence while an input method is open.** Typing Chinese, Japanese
  or Korean means Enter picks a candidate from the IME's own list; the page was treating it as
  "send", posting the unfinished text and clearing the box. It now stands back while a composition
  is in progress, including on the browsers that end the composition first and hand the same Enter
  to the key handler afterwards.
- **The automation panel is reachable on a narrow screen.** It used to be hidden below 900px, which
  is where "what is my loop doing" is the reason to open this at all. It is a drawer now, behind a
  button in the header, and tapping the conversation puts it away.
- Layout for phones: `dvh` instead of `vh`, so a sliding address bar does not push the composer
  below the fold; safe-area padding for a notch; 16px inputs, because anything smaller makes iOS
  Safari zoom the page and never zoom back; finger-sized buttons where the pointer is coarse.
- **A confirmation shows what is about to run apart from the reasoning about it.** Run together as
  one paragraph they read as prose and get waved through. The focus starts on cancel, so a stray
  Enter cannot approve anything.
- `--host=0.0.0.0` is the same flag as `--host 0.0.0.0`. Written with an equals sign it used to
  parse as no `--host` at all, which bound loopback and skipped the refusal that goes with binding
  anywhere else.

### Security
- **`--no-auth` now means loopback, whatever route the request took.** Refusing it at bind time was
  not enough: a loopback-bound server reached through `tailscale serve` — or `tailscale funnel`,
  which is the open internet — arrives as a local socket carrying a tailnet name, and was served.
- The tailnet allowance is narrowed to connections that actually come from a tailnet: the local
  socket `tailscale serve` produces, or the 100.64/10 range Tailscale hands out. A `.ts.net` name
  from anywhere else is a name someone pointed at this machine.
- **The pairing path is behind the same cross-site lock as everything else.** Without it a page on
  any site could point an iframe at the pairing URL twenty times and burn the code your phone was
  waiting for — and, with a small probability each time, be handed the cookie.
- A pairing guess that is not six digits is a wrong guess, not a 500. It used to throw inside the
  constant-time compare, which told a stranger a code was armed and did it without spending one of
  the twenty tries.
- The pairing code is printed only on a terminal, like the token. It stays live until someone
  pairs, so a log file holding it is a log file holding the way in. `POST /pair` mints another for
  a browser that is already signed in.
- The manifest and the icon are behind the cross-site lock too. Served to anyone, an icon that
  loads is a load/no-load bit: a page could sweep ports and addresses and learn exactly where this
  is running.
- **A content security policy on the page.** It holds a token that outlives the process and it now
  turns model output into DOM; the renderer was reviewed and nothing got through it, but
  `connect-src 'self'` means a mistake there tomorrow still cannot send the token anywhere, and
  `frame-ancestors 'none'` means no other page can reach in.
- A Markdown link whose URL contains a code span is left as text: the address would not have been
  the one the link showed.

## [0.7.3] - 2026-09-09

### Added
- **`pi-loops --no-auth`.** No token, no cookie, nothing to carry: the browser UI is open to
  anything on this machine that can reach the port. The one check that stays is that the request
  did not come from another site, which is what keeps a page on `http://localhost:5173` from
  posting into your session. Right on a machine only you use; wrong on a shared host.

### Fixed
- **Every message you sent appeared twice.** The page draws it the moment you press Enter, and pi
  sends the same message back when it lands — which is how a window opened later learns about it.
  Both are right; showing both was not.
- **Terminal escape codes were shown as text.** An extension's startup banner, a coloured diff,
  anything written to the session for a terminal, arrived in the browser as literal `ESC[38;5;240m`
  around every character. They are stripped now — from the accumulated text, so a sequence split
  across two stream deltas goes too.
- **Chinese text broke every box and column.** Nothing in the font stack could draw CJK, so the
  browser reached for a proportional fallback whose characters are not twice the width of an ASCII
  one — and a box drawn by a terminal came apart on the first Chinese character. The stack now
  names monospace CJK faces; where one is installed, the corners line up.

### Changed
- **The browser front end has one address: `http://127.0.0.1:4173/`.** The port was already fixed;
  the token was not — it was made fresh every launch, so the address in your bookmark was stale by
  the next one. It now lives in `<loops dir>/web-token` at mode 0600, and the first visit leaves a
  `SameSite=Strict` cookie, so after that the bare address works and you never see a token again.
  `PI_WEB_TOKEN` still overrides it.
- There is a check at all because anything that reaches this server gets the whole session, and
  that includes a website open in another tab — it cannot read the answers, but nothing would stop
  it sending your agent instructions. `SameSite=Strict` is the browser's promise not to attach the
  cookie to anything another site started, which is what makes "no token in the URL" safe rather
  than merely convenient.
- **Running `pi-loops` while one is already up opens that window instead of failing.** A fixed port
  means colliding with yourself, and starting a session twice is a normal thing to do. The second
  process recognises the first, opens the browser at it, and leaves — taking its own `pi` with it
  rather than orphaning one behind a server that never bound. A port held by something else still
  says so, and `--port <n>` still moves it.
- A browser that has never been here gets a page that says what to do about it, instead of the
  words `bad or missing token`.

### Security
- **A request that another site started is refused, on every route.** `SameSite=Strict` sounds like
  it covers this and does not: a *site* ignores the port, so every page served from
  `http://localhost:5173` — any dev server on this machine, or anything with an XSS in it — is
  handed the cookie by the browser. The request's own account of where it came from
  (`Sec-Fetch-Site`, and `Origin` for browsers that do not send it) is what actually closes it.
- The second launch that finds the port busy no longer sends its token to whatever is listening
  there. It asks an unauthenticated question instead — an instance of this program answers the
  identifying header on its 403 too — because a secret sent to find out who is on the other end has
  already been sent.
- The token file is checked before it is trusted: a regular file, owned by you, and tightened to
  0600 if it came back from a backup at 0644. A symlink or a directory in its place is now an
  error that says so rather than something to write through.
- The token is printed to the terminal only when there is a terminal. It outlives the process now,
  and stdout redirected to a file would be a credential written to a file.

## [0.7.2] - 2026-09-09

### Fixed
- **The browser front end could not show a reply.** `renderRuntime` called a `num()` that was never
  defined, so the first `refresh()` threw, the startup sequence died with it, and no `EventSource`
  was ever created — you could send a message, pi would answer in full, and the page would show
  nothing but your own text, which it had drawn locally before sending. Present since the front end
  shipped, in every release since.
- What let it through: everything about this file was checked by asking its HTTP routes with curl,
  which never executes a line of the page. `node --check` parses and does not run; the linter reads
  `src/*.ts` and would not look inside a template literal either way. `test/web-page.test.ts` now
  runs the page's own script against a DOM stub and asserts that a streamed reply, a tool call, its
  result and a dead pi all reach the screen. Verified it fails without the fix.
- **One malformed job stopped the whole automation panel from redrawing.** The sidebar is built as
  one string and assigned at the end, so `lastError.slice(...)` on a job whose `lastError` was a
  number threw before anything was assigned — every other job's card went with it. Those files are
  written by earlier versions and by hand; the panel now draws what it is given.
- Counts from those files reach the panel through `num()` like every other one. `inboxNew` and the
  two lengths are computed here rather than read from disk, so nothing could be injected through
  them today — but they were the one place the rule was not being followed.

### Security
- `@mention` expansion and path completion are anchored to the session's own directory, which this
  process reads from pi, instead of to a directory the browser sends. The browser only ever echoed
  back what it was told, but a root supplied by the caller is not a boundary — `"/"` would have
  made the containment check pass for every file on the disk. Reaching those routes still requires
  the token, and the token still means the whole session, so this restores a stated invariant
  rather than closing a way in.
- `PI_WEB_TOKEN` is checked at startup. It is substituted into a JavaScript string literal in the
  page, where a quote would have ended the literal early and turned the rest into code.
- The one-shot browser-launch key is now subject to the same "request came from this machine" check
  as every other route, and the page that carries the token is served `cache-control: no-store`.

## [0.7.1] - 2026-09-09

### Fixed
- An unknown subcommand says which one, and which version this is, before the usage list. The
  likeliest reason a subcommand is unknown is that it was added after the copy you are running —
  `pi-loops upgrade` on 0.6.1 being the first example, since an upgrade command can never be in the
  version that predates it — and a usage list with no message is the wrong answer to that: it looks
  like you typed something wrong rather than that you are a version behind.

## [0.7.0] - 2026-09-09

### Added
- `pi-loops upgrade` installs the newest release from the repository this copy came from, and
  `--check` says whether there is one without doing it. `pi update --extensions` deliberately does
  not move you between versions — it reconciles a git package to the ref you pinned — so taking a
  release meant looking up which tag was newest and retyping it, which is work a command should do.
  It reads `repository.url` from the package's own `package.json`, so a fork upgrades from the
  fork; it compares versions numerically, so `v0.10.0` beats `v0.9.0`; and it ignores release
  candidates and branch-shaped tags, which are not things to move someone onto unasked.
- Both READMEs open with the five commands you actually type, before the explanation of any of them.
- `--port 0` takes any free port, and the URL printed is the one actually bound. A fixed default is
  a fight with whatever else is on the machine, and losing it should not need a second guess.

### Fixed
- A port already in use says so (`cannot listen on port 4173: …`) instead of an unhandled error.

## [0.6.1] - 2026-09-09

### Fixed
- The browser front end no longer dies with the pi it started, and says why that pi died. When pi
  refuses to start — two copies of an extension installed, a provider that will not authenticate —
  it exits before answering anything, and the front end wrote to a stdin that was already closed:
  an unhandled EPIPE that took the server down too, leaving a browser tab pointing at nothing and
  the reason visible only in a terminal you may have opened this window to avoid. pi's stderr is
  now kept, bounded, and shown on the page when it exits.
- `/pi-loops install-launcher` does from inside pi what `pi-loops install-launcher` could not do
  from a shell: put the `pi-loops` command on your `PATH`. The command line's own version needs
  itself to already be on the `PATH` it is about to write to, and 0.6.0's install instructions led
  with it anyway — a first step that cannot be the first step. pi is already on your `PATH` and the
  extension is already loaded there, so that is where the circle breaks. It asks before writing.
- Installing pi-loops twice — a checkout you are working on plus `pi install git:` of the published
  one — makes pi refuse to load the second copy and exit, because both register the same tools. The
  install instructions now say to pick one, and troubleshooting covers the message you get and the
  consequence nobody expects: `install-launcher` writes the path of whichever copy ran it, so
  removing that one leaves `pi-loops` pointing at a package that is no longer loaded.
- The install instructions now name the directory a `pi install git:` package actually lives in
  (`~/.pi/agent/git/<host>/<owner>/<repo>`) instead of saying "the package directory" and leaving
  you to find it.

## [0.6.0] - 2026-09-09

### Added — an onboarding path
- Both READMEs now read as five steps rather than a list of facts: confirm a provider actually
  answers before trusting anything unattended, install, put the command on your PATH, start a
  session, write your first loop, and set a spend cap before leaving it running overnight. The old
  version told you how to install and then dropped you into a `/cron add` example, which is the
  right example and the wrong place to meet it.

### Changed — `pi-loops` is how you start a session
- Bare `pi-loops` starts one, choosing the window the way pie does: the browser front end at a local
  terminal, pi itself over ssh or with no terminal at all, where a browser on this machine would
  help nobody. `--web` and `--tui` say which when the guess is wrong, and anything the command does
  not recognise goes to pi, so `pi-loops --model anthropic/claude-opus-5 -e .` means what it looks
  like — and `pi-loops --continue` opens the session you were just in, which is what people
  actually mean when they say the browser front end "starts a different session". A bare word is never passed on: `pi-loops exprot` is a typo, and starting a session instead
  of saying so would hide it.
- The front end moved from `examples/pi-web.mjs` to `src/web.mjs`. It was never an example — it was
  the product, filed where you would have to know a path inside a checkout to run it. Getting a copy
  of the repository in order to open a browser window is not an invocation anyone should have to
  learn.
- `pi-loops install-launcher` writes a launcher into a directory already on your `PATH`
  (`~/.local/bin` by default). `pi install` puts this package under pi's managed directory rather
  than on `PATH`, which left the command that is supposed to start your sessions reachable only by
  absolute path. It is a two-line `sh` script naming the node and the package it was written with,
  rather than a symlink, so it survives either of them moving for the other's reason.

### Fixed
- The model and thinking pickers in `examples/pi-web.mjs` were unreadable when open. A `<select>`'s
  dropdown is drawn by the platform rather than by the page, so a transparent background left the
  list painted on system white while the options kept the page's text colour — light text on white
  in a dark theme. They now use `Canvas` / `CanvasText`, which follow `color-scheme` in both
  directions, as the dialog and the completion popup in the same file already did.

## [0.5.0] - 2026-09-09

Everything here came out of one audit run from two opposite directions — one walking daily usage
scenarios from the outside, one inventorying mechanisms from the inside — and the eleven issues it
produced. The two passes converged on exactly one finding, which is the one that leads this list.


### Changed — a scheduled run has its own two hook events
- `run_start` and `run_end` join the hook vocabulary, and both the headless host and an interactive
  pi fire them for every scheduled run (#7). Until now the host fired `agent_start` / `agent_end`
  and an interactive pi fired nothing, so the same `hooks.toml`, the same job, and a notification
  that arrived or did not depending on which process happened to hold the clock. Silence that looks
  like success is worse than no notification at all.
  Reusing `agent_*` in both places would have fixed the asymmetry and broken something quieter: a
  rule you wrote about your own turns would have started firing for automation. These are not pie
  events, because pie has no unattended mode — every scheduled job there *is* a turn in the
  conversation. Here a run happens with no conversation at all, or beside one.
  The payload says what the run did: `run_job`, `run_id`, and on `run_end` also `run_ok`,
  `run_findings`, `run_error` and `run_cost_usd`, so "tell me when a loop fails" is
  `[ "$PI_RUN_OK" = false ]` rather than a string match on a summary. `run_*` hooks are always
  queued off the run in both processes, whatever `[hooks] mode` says: a webhook that hangs must not
  hold up the clock, and `sync` is about ordering inside a conversation turn.

### Fixed — three of the six gaps the September audit filed
- The headless host fires `hooks.toml` hooks for the runs it makes (#1). A webhook that told you a
  run finished worked while pi was open and went silent the moment the host took the clock, which
  is the window the host exists for. A run is the agent here, so it fires `agent_start` and
  `agent_end` and nothing else; the outcome rides in `message_kind` (`loop_run_ok` /
  `loop_run_failed`), so `$PI_MESSAGE_KIND` alone answers "did last night's loop fail". Each run
  gets its own runner bound to that job's project, and a project's own `hooks.toml` needs pi's
  trust for exactly that directory — `allow_project_hooks` is a statement about projects you open,
  not about a directory a model-chosen `cron_create` pointed at. `docs/hooks.md` now states
  exactly when hooks fire instead of listing exceptions.
- `/cron set --prompt` and `--schedule` change a job in place (#3). Rewording a loop used to mean
  remove-and-re-add, which minted a new id and abandoned `state/<old id>.md` — months of "what I
  have already reported" gone, so the next run reported all of it again. The schedule is validated
  through the same parser `/cron add` uses, the confirmation prints the new next run, and a cron
  change anchors `lastDueAt` to now so moving a daily job to `*/5` does not fire for slots that
  only exist retroactively. One-shot schedules are refused on an existing job: firing one deletes
  the job, which would destroy the notes this feature exists to protect.
- An MCP push refused while the machine is busy is held and retried instead of dropped (#5). A
  periodic check can be dropped safely — the next poll re-examines the world — but a push happened
  once and no server re-sends it, and both took the same path. Pushes now wait in a bounded list
  (32, about the width of the dedup window that defines a push's identity) and are retried oldest
  event first, carrying their original timestamp so the check knows when the thing actually
  happened. Over budget still drops rather than queues: too busy clears in minutes, a daily cap can
  last until midnight, and acting on the morning's deploy event at 23:59 is worse than not acting.
  A rule whose check keeps failing now backs off like a failing job instead of re-billing every
  poll forever.

### Fixed — the rest of the six gaps the September audit filed
- The daily budget stops a run that is already going, not just the next one to start (#4). A run
  admitted at $4.99 of a $5.00 cap could spend any amount, and three admitted together could each
  spend any amount — a limit consulted only at the entrance is a rate limiter, not a budget. The
  check now runs before setup, before the prompt, and after each completed turn, and it counts what
  this process has in flight as well as what the run log already knows: the runs beside this one,
  and the maker a `--verify` checker is reviewing. A stopped run is recorded as aborted rather than
  failed, so the slot is still owed and the job's failure streak is untouched; the reason says
  plainly that the budget stopped it, because "stopped" and "failed" must not be debugged the same
  way.
- A `/goal` continuation is held when you typed something else while the evaluator was running
  (#6). It used to be delivered as a follow-up on *your* new turn, so the goal quietly took over
  the question you had just asked. "The branch moved" deliberately does not mean "the leaf moved":
  run cards and panel snapshots move the leaf all the time, and treating those as your input would
  have stalled every goal on a busy machine. It means a user message arrived after the point the
  goal was judged at, or that point is gone.
- `/inbox` shows which project each finding came from, and defaults to this project with `--all`
  for every project — the scoping `/cron` and `/triggers` already use. With loops running in
  several projects, `/inbox claim 3` used to run a finding about one repository in another
  repository's directory. Note this scopes `/inbox all` (the history) too.
- A job that has been failing repeatedly says so in the status line and at startup, e.g.
  `2 job(s) failing (check-issues ×7)`. The count was already stored; nothing outside the backoff
  logic read it, so forty consecutive failures looked exactly like a healthy job until you typed
  `/cron`.
- `session_compact_failed` reaches the `compaction` hook with a `compaction_failed` field. A
  session that cannot compact is a session about to hit its context limit, which is the case a
  watcher most wants to hear about.
- Hook command stdout is captured into the per-process log, bounded and redacted, instead of being
  discarded — so the usual debugging move of printing something and looking at it works.

### Fixed — one limit, meaning what it says
- `[cron] max_concurrent_runs` bounds sub-agents, not sub-agents per pipeline (#2). Loop runs and
  trigger checks counted separately against the same number, so `= 3` permitted three of each plus
  a goal evaluator: seven. Both now draw from one pool (`src/slots.ts`), and `/triggers running`
  reports it, because a number that can be exceeded should at least be visible when it is.
  The point was never the arithmetic. Two pipelines each answering "am I under the limit" about
  themselves meant every admission rule had to be written twice, and the second copy drifted —
  which is how the deferred-versus-dropped difference between them came about. There is now one
  place that answers "may something start now", and it decides nothing about what a refusal means:
  the scheduler still leaves the tick owed, and the trigger runtime still queues a push and drops a
  periodic check.
  The `/goal` evaluator and `/cron run` take a slot but are never refused one — they are things you
  asked for directly, and a machine quietly declining to evaluate a goal is indistinguishable from
  a goal that was never set. That is also what makes `4 of 3 slots in use` a state you can reach
  and see.

### Fixed — a free delivery paying rent
- An injected summary arrives even when the day is over budget (#9). `inject_summary` puts the
  push's own text into the chat and runs no model call — its audit row has always recorded
  `cost_usd: 0` — and it was being refused by a cap it does not consume. The day the cap trips is
  the day you still want to be told what is arriving. Deliveries that do spend are still refused,
  and a summary that goes through while the cap is tripped says so in the audit and the log, so
  "everything else stopped today, why did this run" has an answer.

### Fixed — the follow-ups the parallel work left behind
- The headless host writes hook stdout to `host.log` (#11). Capturing it was added to the
  interactive extension by one agent while another was giving the host hooks, and neither could see
  the other's file — so the capture landed everywhere except the process where "what did my
  automation do last night" is actually asked.
- `/cron set --name` applies the rule `/cron add` applies (#10). A rename could store a name with a
  space, or a second `ci`, and a name is how a job is referred to — two of them make every later
  `/cron run ci` resolve to whichever the lookup reached first. The rule now lives in one function
  both paths call, so they cannot drift again. Renaming a job to what it is already called is not a
  collision.

### Fixed — a command of ours that pi already owned
- `/share` is now `/session-share`. pi has a built-in `/share` of its own, and an extension command
  that takes a built-in's name is dropped from autocomplete and shadowed at the prompt — so the
  command did nothing in the terminal while working fine everywhere without built-ins, which is
  where it had been verified. The new name matches `/session-export` and `/session-import`, which
  are about the same object. A test now reads pi's built-in list out of the installed build and
  fails if any of our command names collides, because this is not a mistake worth making twice.
  Worth knowing: pi's own `/share` is not the same command. It exports the raw session JSONL and
  offers it to a hosted gateway first, falling back to a private gist, unredacted and with nothing
  shown to you beforehand.

### Changed — a decision you can test
- `/cron set`'s decisions moved out of the command handler into `src/job-edit.ts` (#8). Nothing can
  import the extension's default export, so everything the handler decided was covered by reading:
  which stamp to anchor when a schedule changes, whether the job is now due at once, whether an
  expression that parses will ever match. `applyJobEdit(job, edit, ctx)` returns a patch, the lines
  worth logging, and when the job runs next; the handler is left with arguments, the store and
  printing. Behaviour is unchanged — the point was to be able to prove that.
  It returns a patch rather than a rebuilt job on purpose: `JobStore.update` re-reads under a lock,
  so a tick that started a run in between has already set `running`, and writing back a whole job
  built from a stale copy would erase it. That is now a property with a test rather than a habit.
  Two things nobody had checked are now checked: turning a job into a one-shot is refused (running
  one deletes the job, taking the loop's notes with it — the opposite of why editing in place
  exists), and an empty prompt is refused the way `/cron add` refuses one.
  This is the first seam; `AGENTS.md` now says where a decision goes, so the next one lands in the
  same shape.

## [0.4.0] - 2026-09-09

### Added — a browser front end, and the state one needs
- `examples/pi-web.mjs`: a browser UI for pi in one dependency-free file. It runs `pi --mode rpc`
  and passes that protocol through to a page — the session is a real pi session, and `pi --resume`
  picks it up afterwards. pie's `pie web` replaces its own terminal UI; pi keeps its terminal, so
  this is the same shape through the door pi already provides. Streaming feed, history, queue,
  abort, model/thinking, compact, images, `/` and `@` completion, `@file` expansion, search, undo,
  HTML export, cost, and pi-loops' approval dialogs answered in the browser.
- `pi_loops_snapshot`: a session entry carrying what only this process knows — which MCP servers
  connected and what they exposed, the active tools, hooks, whether this pi owns the clock, the
  last check. The TUI panel had it and nothing else could get at it; a front end that is not a
  terminal now reads it structurally instead of parsing text meant for a person. Written when it
  changes (not per tick — it goes into the session file), and `/cron snapshot` forces one.
- `/share` uploads this session's transcript as a GitHub gist through `gh`, like pie's `/share` —
  but redacted first, and it says what it is about to publish before it does: how many messages and
  tool results, how many secrets the redactor masked, whether the gist is public, and where the
  local copy is so you can read it. Secret by default; `--public` needs its own confirmation.
  pie renders the transcript unredacted and shells straight out to `gh gist create`, which sits
  badly next to a project that redacts everything else it puts on a screen.
- `/triggers run <id>` checks one rule now, without waiting for its poll slot — pie's "▶ run now",
  which existed for cron jobs (`/cron run`) but not for rules. It goes through the same path a
  periodic check takes, so dedup, audit, the sub-agent and promotion all behave identically, and
  it is refused for a rule belonging to another project: enabling one from here is one thing,
  starting a sub-agent there from a session that never listed it is another.

### Added — the checks themselves
- CI (`.github/workflows/ci.yml`): typecheck, lint and the test suite, on Linux and macOS, with
  every provider credential cleared. The suite is offline by construction; clearing the keys is
  what makes that a fact rather than an intention. This repository is installed straight from git,
  so a broken main was previously a broken install with nothing standing in the way.
- `npm run ci` runs exactly what CI runs.
- `scripts/lint.mjs`: two rules, no dependency (TypeScript is borrowed through npx, the way
  `typecheck.mjs` already borrowed `tsc`). **floating-promise** — pi installs no
  `unhandledRejection` handler, so a promise nobody awaits ends the whole session on a rejection;
  `void x()` counts, since that is the shape the bug takes here. **silent-catch** — an empty
  `catch {}` with no comment. It found ten floating promises on its first run.

### Fixed
- Ten promises that could have ended a session, found by the new lint rule. Most were safe by
  careful reasoning rather than by construction — `tick()` catches everything but its own error
  path calls back into hooks and logging; `handle()` is documented not to reject. One was a real
  latent bug: `HookRunner.fire` built its payload *outside* the try, so a throw in `payloadFor`
  rejected the shared queue promise, which every caller deliberately does not await.
- The redactor covers the shapes a secret takes in a *file*, not only in a prompt: Stripe-style
  `sk_live_…` keys, PEM private-key blocks, and `name: value` / `"name": "value"` pairs whose name
  mentions a token, secret, password or key. `/share` uploads whole transcripts, so the gap between
  "what a prompt looks like" and "what a config file looks like" started to matter.
- The headless host's control channel now works from a deeply nested `PI_LOOPS_DIR`. A unix socket
  path is capped at 108 bytes, so `<dir>/host.sock` under a long path failed to listen with EINVAL —
  the host ran on with no control channel and `pi-loops host status|abort|stop` reported a healthy
  host as "not answering". A long path falls back to a short one in the temp directory, named by a
  hash of the loops directory — inside a per-user directory this process owns, verified rather than
  assumed, because that socket accepts `abort` and `stop`: a predictable path loose in a shared
  temp directory is one any local account could bind first, and `host stop` would then report
  success against a forged reply while the real host kept running. `askHost` checks the socket is
  ours before believing it, a channel that cannot be opened no longer takes the host down with it,
  and what a snapshot prints is stripped of control characters like everything else that reaches a
  terminal.

## [0.3.0] - 2026-09-09

### Added — the last of the third audit's list
- `/cron disable --all` pauses every job in this project (`--all-projects` for the machine), and
  `/cron enable --all` resumes. Quitting pi is the *on* switch here — the host takes over — so
  "stop everything" needed to be one command rather than one per job.
- `/cron remove` keeps the loop's notes and transcripts; `--purge` deletes them, and `/cron gc`
  reports orphaned state with `--purge` to clear it. Remove-and-re-add is how a schedule or prompt
  gets changed, and that used to throw away months of accumulated state with no warning.
- `PI_LOOPS_DEBUG=1` traces what a sub-agent did — each tool call, provider retries, compactions —
  into the log file. pie has `--debug` for the same job.
- `pi-loops sessions [--all]` lists the session ids `export` accepts, and `pi-loops inspect <file>`
  shows what an archive contains without writing anything.

### Added — being able to tell what happened
- Every pi process writes its diagnostics to `logs/pi-<pid>.log` in the loops directory, rotated at
  2 MB with the newest five processes kept. Until now everything except the headless host went to a
  chat notification, which is never written to the session file — `/new` or a crash erased every
  warning the automation had produced, so a loop that failed at 03:00 left nothing to read at 09:00.
  `/cron scheduler` prints the path.
- Diagnostics that matter (a job disabled, a write that failed, a paused budget) are warnings, not
  info. pi replaces an info status line in place, so several in one tick collapsed to the last one.
- The headless host writes the same cron audit rows the interactive extension does, so
  `/triggers audit` is no longer blank for exactly the hours nobody was watching.
- A session says what it starts with: how many loops and rules are active here and when the next
  one is due, as pie prints on every start.
- `/triggers running` shows how long each run has been going and, for loop runs, the transcript
  being written right now — "is it stuck or is it working" no longer waits for the run to end.
- A deduplicated push says so instead of vanishing into an audit row.
- `pi-loops host status` falls back to the recorded pid and log path when the host does not answer,
  instead of reporting that no host is running; `host stop` escalates to SIGTERM.
- The host's snapshot carries health: the last few runs and their outcomes, jobs currently in error,
  the next due time and today's spend. A host that has failed every run for six hours no longer
  reads exactly like one that succeeded an hour ago.
- `[danger] allow` lets a project permit the exact command prefix an unattended run needs, without
  opening the whole class.

### Fixed
- `jobs.json` is version 2. The constant had been 1 since 0.1.0 while the on-disk shape gained
  `host` (which gates dispatch), `verify`, `timeoutMs` and the failure counter, so an older
  pi-loops sharing a `$HOME` silently rewrote the file without them.
- `polls.json` drops slots nobody has claimed for a day; it only ever grew, one entry per project
  and session, and is read and rewritten on every tick.
- A presence entry from a machine whose clock is ahead ages out. A negative age never exceeded the
  staleness window, so such an entry kept a dead session's jobs from ever being parked.
- A failed atomic write removes its temp file. On a full disk that was one abandoned file per
  process per tick, consuming inodes long after the failure itself was handled.
- Trigger transcripts are kept per project rather than sharing one 40-file budget across the
  machine, which three projects polling every ten minutes exhausted within hours.
- A job that fails three times in a row is retried on a widening gap (5 minutes, doubling, capped at
  six hours) instead of at every due tick. A loop whose sub-agent killed the process re-fired on the
  very next start, in a loop, with nothing counting the failures.
- Quitting no longer claims a hand-off that did not happen: it waits for the host to record itself,
  and says automation is not running if it never does. A host that died during module resolution
  used to be announced as a success.
- A holder that overran the stale window no longer deletes the lock of whoever broke it, which let a
  third caller in and lost writes. Each holder writes a token and only releases its own lock.
- A project MCP tool whose name collides with a built-in is offered as `<server>_<tool>` rather than
  silently dropped, as the interactive path already did.
- A run in an untrusted project says so once, instead of silently losing that project's AGENTS.md,
  skills, extensions and settings.

### Added — what automation costs, and a cap on it
- `[limits] daily_budget_usd` stops dispatching once today's automation has cost that much. Loop
  runs and trigger checks both stop, the job says why in `/cron`, and the slot stays owed rather
  than being skipped, so work resumes when the day rolls over or the cap is raised. pie has the
  same primitive and never exposes it, because its loops die with the session; a headless host runs
  for days, so nothing else bounds the bill.
- `/cron cost [today|7d|all]` adds up the run log by job and shows today's spend against the budget.
  Every number was already recorded and nothing added them up.
- The `/goal` evaluator is recorded in the run log like any other model call. It used to be spend
  that appeared nowhere at all.
- Trigger checks and actions share `[cron] max_concurrent_runs`. pie spawns every accepted trigger
  concurrently, which a person watching the feed bounds in practice; unattended, a server pushing
  distinct events opened one sub-agent per event with no limit.
- `/cron clear <ref>` releases a `running` marker left by a process that is gone. When its pid has
  been reused, nothing could clear it and the loop was parked for good; hand-editing `jobs.json`
  was the only way out.

### Fixed
- A timestamp from the future no longer wedges the clock. A wrong clock later corrected by NTP, a
  restored VM snapshot or a synced `$HOME` from a machine that was ahead used to leave `lastDueAt`,
  `lastFiredAt`, the poll ledger and the dedup window in a state where every comparison skipped
  forever — the job never fired again while `/cron` still rendered a next run.
- `inbox.jsonl` is rotated past 1 MB, dropping the oldest already-triaged entries and never
  anything still unread. It was the one log with no cap, and `newCount()` re-parses it on every
  badge refresh.
- `host.log` is rotated past 2 MB. It is the file the docs tell users to read, it also carries the
  host's stdout and stderr, and it was unbounded.
- Rules whose project no longer exists are disabled with the reason, like cron jobs already were.
  They used to start a sub-agent in the missing directory every poll interval, forever.

### Fixed — the pre-release security review
- `[danger] allow` means one command, not a prefix. It matched by raw prefix, so
  `allow = ["rm -rf /var/cache/mybuild"]` also permitted `rm -rf /var/cache/mybuild; rm -rf /` —
  arbitrary shell handed to exactly the actor the gate exists to stop, a model that may have been
  prompt-injected by repo content or tool output. Nor could "arguments may follow" be salvaged:
  `rm -rf /var/cache/mybuild /` needs no metacharacter at all, and an allowed wrapper (`ssh host`,
  `docker run`) would carry a whole second program as its arguments. An entry now matches that
  command exactly, or the same command aimed at a path strictly inside the one it names
  (`…/mybuild/tmp`, never `…/mybuild/../..`). The `rm -rf` scan also looks inside `` ` `` and
  `$( )`, so `echo $(rm -rf /)` is no longer invisible to it.
- The daily budget survives log rotation. It was summed from `runs.jsonl`, which is halved once it
  passes 1 MB — so on a busy machine the morning's costs disappeared and the cap read the day as
  cheap and resumed dispatching. Rotation now folds what it drops into a small per-day ledger, and
  `/cron cost` says how much of the total came from there.
- A run whose timestamp will not parse no longer counts toward today forever. `NaN < since` is
  false, so one such record above the cap would have paused every job on the machine permanently.
- The budget also gates plain (non-stateful) jobs. Injecting one makes the parent agent take a
  billed turn, and the check sat after the branch that handles them.
- `/cron gc` collects this project's dead jobs, not the machine's. It deleted other projects' jobs —
  and with `--purge` their loop state — from a session that had never listed them; `--all` is now
  how you ask for that.
- A lock holder whose token file has vanished no longer removes the directory, and neither does one
  that never managed to write a token. That was the same race the token was added to close,
  reopened from the other side: it fired in the window between a new holder's `mkdir` and their
  token write.
- A one-shot that already ran — or whose slot the scheduler declined because catch-up was off —
  stays retired across a clock correction, which used to drop its stamps and make it owe its single
  slot again.
- `pi-loops inspect` and `pi-loops import` strip control characters, newlines and bidi overrides
  from what they print of an archive. The archive is a file someone sent you and `inspect` is what
  you run before trusting it, so escape sequences in a prompt could repaint the listing you were
  reading it for, or forge a row in it.
- A running process's log is never pruned, however old it looks. A headless host that has been up
  for days is exactly the log someone goes looking for.

## [0.2.1] - 2026-09-09

### Fixed — found by the third audit, mostly in 0.2.0's own new code
- `pi-loops import` restored the transcript into a directory pi never reads. It hand-rolled the
  project directory name (`encodeURIComponent`) while pi uses `--home-u-proj--` and `list()` reads
  only that one directory — so the documented "restore on a fresh machine" flow imported a session
  `/resume` could not see. It now asks pi for the name.
- `/goal`'s evaluator judged only the run that had just ended, not the conversation. `agent_end`
  carries that run's messages, so evidence produced in an earlier turn was invisible and a
  satisfied goal kept returning "insufficient evidence" until the continuation budget ran out. It
  now reads the active branch through `sessionManager.buildContextEntries()`, as pie reads its
  transcript snapshot.
- A goal no longer evaluates after a turn the user aborted or the provider failed, so Esc actually
  stops a goal instead of paying for one more evaluator call and being sent back to work; `/goal
  pause|clear` and setting a new condition abort an evaluation already in flight; and a decision
  about a goal the user has since changed is discarded rather than written over the new one.
- A goal continuation is delivered with `deliverAs: "followUp"` when the session is not idle, like
  every other injection site. It used to throw into a swallowed rejection and be lost, after the
  iteration had already been counted.
- `/goal pause|resume|clear` are matched as whole words. `/goal clear all the type errors and get
  CI green` wiped a live goal instead of setting that condition; `/goal start …` is now refused
  with usage rather than becoming a condition named "start …". The evaluator also has its own
  2-minute timeout instead of the 15-minute trigger timeout, and its outcomes reach stderr in
  non-UI modes.
- Run cards, trigger cards and catch-up notices go to the project whose work they report, not to
  whichever window happens to own the timer.
- Every listing now uses the same project predicate as the runtime (realpath + containment), so a
  pi opened in a subdirectory, a worktree or through a symlink no longer shows "(none in this
  project)" while that project's rules fire into its chat. This covers `/cron`, `/triggers rules`,
  `/triggers audit`, the panel, both numeric-ref resolvers and the model-facing `cron_list` /
  `list_triggers`.
- A job or rule stamped with another machine's hostname is marked `[other host: <name>]` and shows
  no next run — it never had one, since the scheduler filters it out. `/cron set <ref> --host here`
  (and `--host -` for any machine) re-homes it, which a renamed machine or a rebuilt container
  needs as much as a second machine does.
- An existing but empty `jobs.json` is treated as damage instead of "no jobs", so the next tick can
  no longer overwrite every job with an empty store; the last content that parsed is kept as
  `jobs.json.bak`; and `writeFileAtomic` fsyncs the file and its directory so a crash cannot leave
  the rename applied and the data missing.
- A corrupt store can no longer kill the session. The badge and panel paths report the file and the
  problem once instead of throwing, the tick has a last-resort catch, and both leadership-hook call
  sites are guarded — pi installs no `unhandledRejection` handler, so any of those was fatal.
- The goal evaluator's transcript is redacted before it is sent and before it is kept as a
  sub-agent transcript — it now carries the whole branch, not one run's messages.
- A damaged store can no longer abort `session_shutdown` half way and strand MCP child processes:
  the hand-off decision is isolated, so the hooks, the MCP pool and the servers are always torn
  down. A tick that fails entirely is reported as a warning (and on stderr without a UI) rather
  than as routine chatter, and the dead-session check joins its guarded neighbours.
- `remove_trigger { all: true }` counts the rules it will actually remove: the approval preview and
  `clear()` now use the same project predicate.
- `jobs.json.bak` is written atomically, so a kill mid-write cannot destroy the backup the error
  message points at.
- Inbox appends wait for their lock instead of spinning on it. A lock directory left by a killed
  process froze the whole process for the full stale window (measured: 10 seconds with zero event
  loop ticks, once per finding); both lock helpers now also wait longer than a lock takes to go
  stale, so a stale lock is broken rather than waited out and then thrown on.

## [0.2.0] - 2026-09-09

### Added — the three things pie had and pi-loops did not
- **`/goal <condition>`** (`src/goal.ts`, pie's `goal.rs`): the session is held to a stop condition.
  After every settled turn an evaluator with no tools judges the condition against a bounded
  transcript and either stops with the evidence, sends the agent back to work with what is missing,
  or pauses. At most 8 continuations; an evaluator that cannot decide pauses rather than looping;
  the state is appended to the session so `--resume` picks it up. `/goal pause|resume|clear`.
- **A command line** (`pi-loops export|import`, `src/cli.ts`): pie's `pie session export|import` as
  subcommands that need no pi session, for backups from cron or CI and for restoring on a fresh
  machine. `--session` takes an id or a unique prefix, `--activate-triggers=off|ask|on` matches
  pie's flag, and a pie `.piesession` is accepted for its automation sidecars.
- **A window into the headless host** (`pi-loops host status|abort|stop`, `src/host-control-channel.ts`):
  while no pi is open the host publishes what it is running — loop runs, trigger checks, what is
  enabled, the inbox count, each MCP server's state — over a 0600 unix socket, and one run or check
  can be interrupted. `/cron host` shows the same snapshot. Read-mostly on purpose: a host you
  could prompt would be a second chat. pie's `--web` UI and its relay stay out of scope, because pi
  owns the terminal UI; this covers what they were needed for while nobody is at the terminal.

### Security — found by the pre-release review
- **An unattended run trusts only the exact directory the user trusted** (`src/trust.ts`). pi's own
  trust lookup inherits from ancestors, which is right for a person opening a subdirectory and wrong
  for a job whose cwd a model can choose: `<trusted repo>/node_modules/anything` used to count as
  trusted, so its `.pi/mcp.toml` could have its `command` spawned by the headless host with nobody
  watching.
- **An imported archive's schedule is validated** (`isValidSchedule`). A hand-made `.pisession`
  could carry `{kind:"cron",expr:"nope"}` or `{kind:"every",ms:0}`, and the throw from `computeDue`
  escaped the tick — killing an interactive pi outright (pi installs no `unhandledRejection`
  handler) and stopping the headless host's clock. A job that is somehow still unusable is now
  disabled with the reason instead of taking the tick down.
- The dangerous-command gate is no longer walked past by quoting (`su''do`), extra flags
  (`chmod -R 777 /`), a second pipe (`curl … | tee … | bash`), command substitution
  (`eval "$(curl …)"`), a force refspec (`git push origin +main`), or an unresolved target
  (`X=/; rm -rf $X`).
- The goal's continuation budget cannot be defeated by a `goal_state` entry with a non-numeric
  `iterations` (an archive carries those verbatim), and the evaluator's reason is redacted and
  capped before it is handed back to the agent as a user message.
- The loops directory is created 0700 and the host's control socket is closed rather than left
  reachable if its chmod fails; `listen()` creates it with the process umask, so the directory mode
  is what closes that window.
- `withFileLockSync` waits longer than a lock takes to go stale, so a lock left by a killed process
  is broken instead of waited out and then thrown on.
- Suppressing extension staleness across shared sub-session runs no longer disables pi's event-bus
  unsubscribers, which leaked every subscription a shared extension made in a long-lived host.
- A rule created with `/` or `$HOME` as its project governs only itself, not everything beneath it.

### Changed — multi-project correctness
- A rule belongs to the session that created it: while that session is open, its own window runs
  its checks and receives its promotions. Only when the creating session is gone does the project's
  owner take over. Two windows in one repo no longer answer each other's triggers.
- A project is a realpath, not a string: a pi opened in a subdirectory, through a symlink or in a
  worktree is the same project as the rule or job that names its root, for ownership, promotion
  routing, the audit filter and the listings.
- An MCP push deferred to a window that never claims it is taken back by the process that received
  it, instead of being lost with a `deferred` audit row.
- A promoted result carries pie's default template (`<source> fired <event>.\nResult: …`), and the
  trigger audit records the idempotency key, the replacement policy and the arrival time, so a
  dedup window can be reconstructed afterwards.
- A check killed by the run timeout still disarms the fire-once rules whose action already ran, so
  an action with external side effects is not repeated on the next poll.
- A sub-agent resolves its model through the parent's runtime, so `pi --api-key`, `/login` and a
  rotated credential reach loop runs. A pinned model that stops resolving (or loses its credential)
  falls back to the session's model with a warning on the run record instead of failing daily.
- Extension instances are loaded once per project and reused across runs, and a run no longer emits
  `session_shutdown` to them — a `-e` extension that opens a browser is no longer re-opened per run
  and no longer torn down under the interactive session.
- The run deadline and abort now cover setup, so a stalled `npm`/`git clone` in a project's package
  resolution cannot hold a job's claim and a concurrency slot forever.
- Run records keep cache tokens and record provider retries and context compactions, and `/cron`
  shows them: a run that silently retried five times no longer looks identical to a clean one.
- `jobs.json` is only written when something changed (pie's invariant), and an idle machine no
  longer creates it at all. A `version` newer than this build understands is refused, not rewritten.
- The run log rotates under its own lock, so records appended during a rotation are not dropped.
- A deferred run (concurrency cap) says so in `/cron` instead of looking like it never ran.
- A failed one-shot job is retried once and then removed, instead of sitting enabled forever with
  no next run.
- Importing an archive is idempotent: the same archive imported twice adds nothing the second time.
  An export carries the automation the exporting session created, not every session's in the
  project. A transcript with duplicate ids or dangling parents is refused instead of silently
  truncating history when the session is opened.

### Security — what an unattended run may do
- Loop, checker and trigger sub-agents run under pie's dangerous-command policy
  (`src/danger.ts`, ported from `permission.rs`): sudo, `curl … | sh`, `dd` to a block device,
  `mkfs`, `chmod 777 /`, shutdown/reboot, `git push --force` on main/master, pipes into `eval`,
  the fork bomb, and `rm -r -f` aimed at `/`, an absolute path or `$HOME` are refused before they
  run, with the reason handed back to the model. pie clones the parent's `before_tool_call` into
  every sub-agent; pi has no built-in denylist, so the gate is injected into each sub-session
  (`src/subagent-guard.ts`).
- `/triggers remove --all` and `remove_trigger{all:true}` clear only the current project.
  `/triggers remove --all-projects` is the new opt-in for the machine-wide sweep.
- `cron_list` and `list_triggers` show the calling project's automation; `all_projects: true`
  asks for the rest. Another project's prompts no longer reach a model that never asked for them.
- `cron_remove` goes through the same confirmation gate as the other control-plane tools, so a
  sub-agent can no longer delete a job (with its loop state and transcripts) unapproved, and a
  job outside the current project needs its exact id.
- An MCP config file can only name an environment variable prefixed `PI_MCP_TOKEN_` as a bearer
  credential; pi's credential store is unchanged. A project file naming `ANTHROPIC_API_KEY` no
  longer sends it to that server's endpoint, and the error no longer echoes the ref.

### Changed — a run belongs to its project, not to the window that happens to run it
- A sub-agent inherits the parent session's active tools (`pi.getActiveTools()`), the way pie hands
  its sub-agent the parent's live tool list. It used to fall back to pi's four-tool default, which
  both dropped what the session had (grep, find, web_fetch…) and restored what `-xt` had taken
  away. A job's `--tools` still narrows that set and can no longer widen it.
- A run in another project gets that project's own MCP servers (`src/mcp-pool.ts`), connected on
  demand and only when the user has trusted that project. The interactive process used to lend
  every run its own project's servers, and the headless host had none at all, so the same loop
  behaved differently depending on who owned the clock.
- The automation tools a sub-agent calls act in that run's project and model. A loop for project B
  that scheduled a follow-up used to pin it to whichever project the running pi was open in; the
  headless host already did this correctly.
- A run interrupted by quitting, a session swap (`/new`, `/resume`, `/reload`, `/fork`) or
  `/cron abort` hands its slot back instead of counting as a run, so the next tick re-fires it
  rather than skipping to the next due time. pi rebuilds the extension on a session swap, so the
  scheduler still stops there — but the tick is no longer lost.

### Fixed
- A `--verify` loop is no longer re-fired while its checker is still running. The run id now
  covers both sub-agents, so the overlap guard, `/triggers running`, the concurrency cap and
  abort all cover the checker phase (findings were entering the inbox twice, billed twice).
- A run interrupted by a crash is recovered by more than its pid: a marker written before the
  last boot is treated as dead (a recycled pid used to park the job forever), and a marker from
  another machine on a shared `$HOME` is left to that machine for a day instead of being cleared
  or trusted. `RunningMarker` records its host.
- `Inbox.append` takes the inbox lock, so a finding written while `/inbox dismiss|clear` rewrites
  the file is no longer lost. With machine-global loops the concurrent case is the normal one.
- A promoted trigger result keeps its line structure (`capRedacted`): diffs, file contents and
  test output arrive in the chat and in the audit as themselves, not collapsed onto one line.
  The one-line TUI previews still collapse, as before.
- An imported archive is re-stamped with this machine's hostname, so restored automation runs
  instead of sitting enabled and silent on the machine it was imported to.
- A streamable-HTTP server that answers `405`/`404` on the optional GET stream stays usable: tool
  calls keep working and the source no longer re-handshakes in a hot loop (the spec makes the
  server→client stream optional; pie keeps POST independent of it).
- The reconnect budget is refunded only after a connection has lasted 30 seconds, so a server that
  answers `initialize` and then exits is retried a bounded number of times instead of forever.
- A `Mcp-Session-Id` the server rejected (`404`/`400`) is dropped before the next attempt, so a
  restarted remote server recovers; a plain reconnect still resumes the stream with `Last-Event-ID`.
- Only a real `401`/`403` marks a server `auth_failed`. A command path containing "auth"
  (`authbind`, `/opt/oauth-mcp/…`) used to disable the server for the life of the process.
- A stdio MCP server that ignores SIGTERM is SIGKILLed after two seconds instead of being leaked.
- A source parked on a server with no push stream reconnects when that server rejects its session,
  instead of looking connected while every tool call fails.
- `Last-Event-ID` is recorded only from the server→client stream, not from POST response streams
  whose ids belong to a different space.
- MCP sources are restarted when a session swap changes the config or the project's trust; they
  used to keep running while the panel described the new configuration.
- Project MCP servers lent to another project's run are re-checked against that project's trust on
  every run, disconnected when trust is revoked, and the pool is bounded (8 projects, least
  recently used dropped).
- `PI_MCP_TOKEN_` is enforced where the environment is actually read, in both the interactive
  extension and the headless host. The restriction was previously bypassed by their own resolver.
- A project's MCP tool can no longer shadow a pi built-in in the headless host (`read`, `bash`,
  `grep`… are reserved everywhere, not just where a pi session could be asked).
- The model-facing tools take an id, prefix or name, never a bare ordinal: the list a model sees is
  not the one the user is looking at.
- Sub-agents cannot request the machine-wide listing (`all_projects` is ignored above hop 0), and
  disabling another project's job or rule needs the same approval enabling does.
- A run whose bookkeeping throws releases its run id instead of parking the job forever.
- `withFileLockSync` honours its deadline on every path, so an unreadable lock directory cannot
  spin with the event loop blocked.
- `rm -r -f /` is refused even when `HOME` is unset (only the `~`/`$HOME` rules need it).

## [0.1.3] - 2026-09-09

### Added — nobody around: a headless host keeps the clock
- When the last interactive pi on the machine quits with loops, rules or MCP servers configured,
  it starts a headless host (`src/host.ts`: same stores, same in-process runner, its own MCP
  clients) that keeps running everything except chat-bound inject jobs; chat-bound results go to
  the inbox. The first pi to open takes the clock back (an interactive scheduler preempts a `host`
  leader) and the host exits. `/cron host [start|stop]`, `[host] auto`, `host.json` / `host.log`.
  `scripts/pi-loops-host.sh` is gone. Tools a host-run sub-agent uses act in that run's project and
  model, and its control-plane operations are audited into `triggers-audit.jsonl`
  (`cron_control_plane`); a host record whose process is gone is reported as a crash by the next
  pi, never signalled (pid-recycling, boot-time and exact entry-path guards). The host takes the
  handing-off pi's model and thinking level for unpinned work, writes its record under a lock so
  two pis quitting together leave exactly one host, and evaluates an MCP push once per project
  that has rules, in that project. `/cron host start|stop` override `[host] auto` for that pi.
- A scheduler tick no longer waits for the run it starts: heartbeats, leadership, presence and
  trigger checks keep going during long runs, `/cron run` returns at once, and `stop()` waits
  (bounded) for aborted runs to write their records.

### Changed — sub-agents run in-process, like pie's
- Loop runs, maker/checker runs and trigger checks/actions are no longer `pi -p` child processes.
  Each is an `AgentSession` opened inside the interactive pi through pi's SDK (`src/sdk-runner.ts`):
  fresh context and its own transcript file, but the parent's live MCP client instances (a browser
  tab or database session opened in the chat is the one the loop sees), its `-e` extensions,
  system-prompt and skill flags, its model unless the job pins one, and the project's trust when
  the run is in the same project. Nothing is re-spawned per run; the cold-start cost is gone.
  `PI_LOOPS_CHILD`, `PI_LOOPS_HOP`, `PI_LOOPS_PARENT_*` and `PI_LOOPS_PI_BIN` no longer exist.
- Sub-sessions get the automation tools at hop 1 as custom tools (`cron_create`, `cron_remove`,
  listing, disabling); Prompt-class operations stay denied there, and a sub-session never loads a
  second copy of this extension or runs the trigger runtime. The parent's extensions receive
  `session_start` and `session_shutdown` in each sub-session, like pi's own headless modes.
- Project-local resources of a sub-session's cwd are loaded only when that project is trusted —
  by this session, or by a decision pi saved earlier — never by default.

### Changed — the scenarios the old "by design" choices had closed
- A project's dynamic checks and push evaluations now run in a pi that is open in that project
  (preferring the session that created the rules; `presence/` registry), so `promote_to_chat`
  lands in the right chat like pie's session-scoped runtime. The machine leader covers only
  projects with no pi open (results to the inbox). The poll interval is enforced machine-wide.
- A plain cron job created by a sub-agent binds to the session the sub-agent acts for, not to
  the sub-agent's own throwaway session — pie's parent cron.toml.
- MCP pushes: injected pushes reach every window that has the server (per-process dedup), rule
  evaluation happens once per project by its owner; no more first-window-wins.
- Model, thinking level and timeout of a job or rule are editable: `/cron set`, `/triggers set`
  (`--model -` follows the running session). Trigger checks/actions are capped by
  `[triggers] run_timeout_secs` (900) or the rule's `--timeout` instead of a fixed 15 minutes.
- Sub-agents inherit the parent pi's runtime flags (`-e`, `--append-system-prompt`,
  `--system-prompt`, `--skill`, `--no-skills`, …) and the project's trust when the parent trusted
  the same project.
- Plain jobs whose session no longer exists are parked as disabled by the leader; `/cron gc`
  removes them. `/triggers rules` marks rules created by another session.
- Trigger audit rows also become pie's session custom entries (`trigger`, `trigger_result`,
  `trigger_promotion`) with the project's `cwd`; `/triggers audit [N] [--all]` shows this
  project's rows by default.
- Hooks are awaited inline like pie (`[hooks] mode = "async"` for the old queued behavior).
- `PI_LOOPS_HOST=1` lets a `pi -p` run host the timer for as long as it lives.
- `[cron] catch_up = false` switches start-up catch-up off for every job (the global switch wins
  over `--catchup`); `[cron] max_concurrent_runs` bounds the burst.
- Jobs and rules record their `host`; other hosts sharing `$HOME` ignore them, leader election is
  per host (`scheduler.<host>.json`), and orphan detection never disables another host's loop.
- A promotion while the agent is busy goes to the follow-up queue and runs a turn after the
  current one, as pie's follow-up does.

### Changed — parity with pie in the small things
- Ids are pie-shaped (`cron-<32 hex>`); `inbox.jsonl` uses pie's record shape on disk
  (`created_at`, `trace_id`, `session_id`, …) and still reads lines written by earlier versions.
- Cron control-plane audit entries use pie's custom type `cron_control_plane` and carry an
  `audit_entry_id`, which `cron_create` / `cron_remove` / `set_cron_job_state` return in `details`;
  `cron_create` answers with pie's three lines and `cron_list` details include `next_run` and
  `last_due_at`; `verify = true` implies `stateful` on the tool path as on the slash path.
- `/inbox` lists the full finding with pie's `created_at[..16]` timestamp; `/cron` shows pie's
  `last fired:` line; `/cron`, `/triggers` and `/new-trigger` use pie's usage and error wording;
  `/triggers enable|disable` prints condition/action/fire-once; `/triggers sources` lists MCP
  servers, the cron hook and the dynamic checker in pie's order and `/triggers status` adds
  pie's `sources: N total, M connected, K require attention` line.
- Prompt-class tool confirmations show pie's approval card (Action / Tool / value-free Reason /
  args hash / redacted Preview) and log `approval required` / `approved` / `denied` feed lines;
  `new_trigger` requires `condition` and `action` and rejects unknown fields, like pie's schema.
- Promotions and injected summaries are `[Trigger <trace>] <text>` exactly like pie's engine
  (the `<source> fired <event>. Result:` wrapper is gone); running-trigger previews are 80 chars of
  the action prompt; inject-and-run turns announce `running triggered turn (trace …)`.
- Side panel: pie's Polling entry (source / event, trace, summary — shown whenever a check ran),
  MCP aggregate (`servers N · tools M · notification hooks N`), and Hooks / Runtime sections.
- Hooks: every payload field is present (`null` when absent), custom messages report their
  `customType` as `message_kind`, failures reach stderr when there is no UI, `<project>/.pie/hooks.toml`
  is read when `.pi/hooks.toml` is absent (same for `mcp.toml`).
- MCP: a repeated server name replaces the earlier entry (pie) with a diagnostic; a successful
  push clears `last error`; stdio stderr is reported separately as `stderr:`; dedup audit records
  the first arrival's replacement policy; idempotency keys hash any Unicode control character;
  the SSE frame cap counts bytes; stdio-server validation no longer says `streamable_http`.
- Session archives: pie's sensitivity warning is printed first and on failure; the imported header
  drops the source machine's parent-session pointer.
- Redaction masks browser-login and loopback-callback URLs like pie; an invalid poll interval
  (config or `--trigger-poll-secs`) is diagnosed instead of silently ignored; the loop prompt's
  `[loop-state]` line uses pie's wording; User-Agent / MCP clientInfo carry the real version.
- `examples/mcp-notify-server.mjs`: a dependency-free MCP push server (pie ships a Python one).

## [0.1.2] - 2026-09-09

### Fixed
- streamable_http MCP sources: the idle timeout was a deadline on the whole GET stream, so a busy
  stream was cut every `sse_idle_timeout_ms` (60 s), failing in-flight calls and re-handshaking.
  Like pie it now bounds only the wait for the response headers and for each chunk.
- Sub-agent processes (`pi -p` loop runs and trigger checks) consumed MCP pushes and could spawn
  nested trigger sub-agents with no ceiling. Like pie, sub-agents keep the MCP tools but ignore
  pushes, and the trigger runtime audits anything reaching hop ≥ 1 as `cycle_suppressed`.
- `/session-export --exclude-triggers` still bundled cron jobs and loop state; like pie it drops
  every automation sidecar. `/session-import` validates all sidecars before writing the session
  file and rolls back store writes on failure, so a rejected archive leaves nothing behind.
- A failing audit or dedup write inside trigger handling became an unhandled rejection. Audit
  writes are best-effort (pie's PersistenceError; `lastPersistenceError`, logged once per distinct
  error), `TriggerRuntime.handle()` never rejects, and scheduler hook failures cannot strand a run.
- Prompt-class control-plane tools (`new_trigger`, `remove_trigger`, re-enabling a trigger or a
  cron job) were auto-approved in sub-agents; like pie they are denied fail-closed there.

### Security
- `/session-import` rejects cron job and trigger rule ids that are not plain tokens: ids become
  file and directory names (`state/<id>.md`, `sessions/<id>/`), so an archive could otherwise
  reach outside the store through `/cron remove` or the import rollback.
- streamable_http MCP: `stop()` during the handshake now aborts it (the connection controller is
  held from the first POST) instead of leaving an unowned event stream.

## [0.1.1] - 2026-09-08

### Fixed
- `promote_to_chat` results and `inject_*` MCP feeds no longer land in another project's chat:
  they are promoted only into a chat in the rule's `cwd`, otherwise routed to the inbox (`redirected` in audit).
- Project-level MCP servers' notifications were dropped in processes that did not own the timer.
  Every process now consumes what it receives; a machine-wide dedup window (`dedup.json`) keeps it to once per push.
- Loops and trigger checks ran with the timer owner's model; jobs and rules now record the creating
  session's model/thinking and run with those.
- A run that died with its process was skipped until the next slot; it is retried on the next tick.
- Stdio MCP reconnects no longer notify on every attempt; each distinct error once, 20 attempts by default.
- Queued lifecycle hooks are drained (≤3 s) on shutdown instead of being lost.

### Changed
- Plain (inject) jobs no longer catch up missed ticks by default (pie never backfills); `--catchup` opts in. Loops still do.
- Sub-agents keep the cron/trigger tools while `PI_LOOPS_HOP < 2` (pie-style hop-bounded cycle suppression) instead of never having them.
- `/cron` marks plain jobs whose session is not open as `[dormant …]`; loops whose `cwd` vanished are auto-disabled and marked `[orphan]`.
- pie's `/cron status` means list; the scheduler view is `/cron scheduler`.

## [0.1.0] - 2026-09-08

First release. Everything pie ships in its automation layer, as a pure pi extension.

### Added
- `/cron add [--stateful] [--verify] "<schedule>" <prompt>` with pie's list/enable/disable/remove
  surface, schedule aliases (`hourly`, `daily`, `每小时`, …), `every 30m`, `in 10m`, `at <ISO>`.
- Stateful loops: fresh `pi -p` sub-agent per run, ≤2000-char notes carried between runs
  (`<loop-state>`), findings routed to the inbox (`<inbox>`), transcripts kept (`/cron trace`).
- Maker/checker (`--verify`, pie's phase 3): an adversarial second sub-agent keeps or drops each
  finding before it enters the inbox; fail-open on checker failure.
- `/inbox` triage with pie's exact list formats and `new → claimed/dismissed` lifecycle;
  `/inbox claim` starts a real agent turn.
- Dynamic triggers: `/new-trigger`, `/triggers status|rules|sources|enable|disable|remove|running|audit|abort`,
  `new_trigger` / `list_triggers` / `remove_trigger` / `set_trigger_state` tools, periodic sub-agent
  evaluation, fire-once, `promote_to_chat`, `[Trigger <trace>]` prefix, 5-minute dedup window.
- MCP: notification sources (stdio + streamable HTTP) with pie's `mcp.toml` schema, dedup keys,
  redacted summaries, `inject_summary` / `inject_and_run`; server tools registered with the agent.
- Lifecycle hooks (`hooks.toml`): pie's events, payload, `PI_*` and `PIE_*` env, command + webhook,
  sequential execution, process-tree kill on timeout, project hooks gated.
- Session archives: `/session-export` / `/session-import` (`.pisession`, pie's `.piesession`
  layout plus `loops/<id>.md` state files).
- pie-style side panel above the editor (`/cron panel on|off`), `Inbox: N new · running: …`
  status badge, run cards in the transcript.
- Machine-global job store with leader election across pi processes, one-shot catch-up of missed
  ticks (`--no-catchup` to opt out), per-job transcripts, run log, redaction everywhere.

### Differences from pie (deliberate)
- Jobs and rules are machine-global with a `cwd`, not session-scoped; `/cron` and `/triggers rules`
  list the current project by default.
- Missed ticks are caught up once by default; pie never backfills.
- Prompts may be up to 8 KB (pie: 4 KB).
- MCP notifications are consumed by the single process that owns the timer; every process still
  connects for tools.
