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
- [x] Submitting while a turn is running queues instead of racing it, the way the TUI does — and a
      slash command typed into it runs while the turn runs, as it does in the terminal.
      `test/web.test.ts`: *a command typed while a turn is running reaches pi as one it can run*.
- [x] The queue is visible and can be cleared. `test/web-page.test.ts`: *the queue badge shows what is
      queued and clears it*.
- [x] "queued N ✕" clears all N: every row it counts, pi-loops' included, is cancelled as its own ✕
      would cancel it, and pi's own queue is emptied, as 0.22.8's clear emptied pi's whole queue.
      `test/web.test.ts`: *clear cancels every row the badge counts, pi-loops' included, and empties
      pi's own queue*.
- [x] What pi-loops addressed to this conversation is in the same queue as your messages, with its
      source ("you", "cron nightly", "rule 3f2a…"), in the order it runs, cancellable one at a time.
      A chat message is a request row in `requests/<session>.jsonl`, the file the pi holding the
      session drains; the page reads the file for the list and the count. What pi itself still holds
      (a slash command typed while busy) is listed after them as "pi", counted with them, and cleared
      with them. `test/web-page.test.ts`: *the queue lists requests from every source, in order*.
- [x] A message you sent survives pi stopping and is offered, never sent on its own, by the next
      page: "not sent before pi stopped", with send and discard. `test/web.test.ts`: *a message typed
      before pi exits is offered, not sent, by the next page*.
- [x] A send pi refuses (compaction in progress, no credentials) comes back to the composer with the
      error, images included. `test/web.test.ts`: *a send pi refuses comes back to the composer with
      the error*.
- [x] A session also open in a terminal is answered by that terminal, and the page says so: "open in
      a terminal: answered there", with no pid. `test/web.test.ts`: *a page's message for
      a session a terminal holds is answered there*; `test/web-page.test.ts`: *a send answered
      elsewhere says so, and one pi refused comes back to the composer with the error*.
- [x] It says so before you send, too: "Your terminal has this conversation. What you send here is
      answered there." above the composer, and the composer's placeholder says where the answer
      goes. Read from `/state`'s `holder`, which follows the rule `/prompt` uses for the line after a
      send, so the two never disagree, and which does not depend on the list. Not shown for a
      terminal that stands aside or a `pi -p` run, which do not answer. `test/web-page.test.ts`: *a
      conversation a terminal holds shows the held line above the composer; one that stands aside,
      or this page's own, does not*, *the held line comes from /state, so a list that fails still
      shows it, and the chat still works*; `test/page-server.test.ts`: */state says who holds the
      conversation, by the rule /prompt follows*.
- [x] The line promises only what happens. A message reaches the terminal only from a page pi with
      pi-loops in it; one without (its launch did not load pi-loops) answers the message itself, and
      the line then says so: answered here, beside the terminal. A conversation opened from the list
      starts with the pi arguments its project's latest conversation was opened with, so a launch
      that loads pi-loops with `-e` loads it there too; they are never taken from the request. A
      row's `terminal` tag has a title only when that terminal answers nothing sent to it: the one
      holder tag with a title, because its label cannot say that.
      `test/web-page.test.ts`: *a terminal's conversation in a page whose pi has no pi-loops says it
      is answered here, not there*, *a terminal that answers nothing is not said to answer, and that
      is the one holder tag with a title*;
      `test/page-server.test.ts`: */state says whether this page's pi has pi-loops, which is what
      sends a message to the terminal*, *a conversation opened with no arguments of its own starts
      with those of its project's latest conversation*.
- [x] A terminal that holds the session and cannot answer (its window stands aside, because its copy
      of the conversation is behind the file; a one-shot `pi -p` run) is passed over: it says so on
      its lease, the page's own pi answers your message, and the page does not call it "answered
      there". `test/person-rows.test.ts`: *a browser message for a conversation whose terminal stands
      aside, or runs pi -p, is answered once, by the page's own pi*; `test/web.test.ts`: *a message
      nobody took says why after fifteen seconds, and can be sent here instead*.
- [x] A message of yours nobody took in fifteen seconds while pi is idle says so on its queue row,
      "not taken (why)", and offers "send it here instead": the row leaves the queue, under
      its lock and only while no holder has stamped it, and the text goes to the page's pi over rpc,
      as every message went before 0.24; a message pi already has is refused, never answered twice.
      When the page's own pi is the one standing aside there is no send-here, since anything written
      then branches the conversation; the row and the send both say /resume. A terminal that holds
      the session and delivers is not called unanswering: "another pi holds this conversation and has not
      taken it yet (it may be busy)", and its offer reads "answer here instead (a branch the other pi will not
      see)". `test/web.test.ts`: *a message nobody took says why after fifteen seconds, and can be
      sent here instead*, *a page whose own pi stands aside says so and does not offer to send around
      it*, *a holder that delivers but has not taken the message is not called unanswering, and the
      offer says it forks*; `test/web-page.test.ts`: *a message nobody took says why and offers to send
      it here, unless this page's pi is the one standing aside*, *a send into a page whose own pi
      stands aside says so, and that pi reads it again*; `test/engine.test.ts`: *a row removed between
      the drain's read and its hand-over is not handed over*. A page's own pi that stands aside (it
      took the conversation back from a terminal that wrote after it read the file) reads the
      conversation again from disk once it is idle, so its messages are answered without a /resume:
      `test/page-server.test.ts`: *a page's pi that took its conversation back standing aside reads
      it again from disk, once per wait*.
- [x] A page whose pi has no pi-loops in it still chats: the text goes to pi over rpc, no row is
      written, and the queue shown is pi's own. The command list this is decided on is asked for
      again after every slash command and when it is older than thirty seconds, so `/reload` is seen.
      `test/web.test.ts`: *without pi-loops in the page's pi, chat goes over rpc as before, and no row
      is written*, *a command list that changes is asked for again before a message is routed on it*.
- [x] Abort stops the current turn. `test/web-page.test.ts`: *the stop button asks the server to abort
      the turn*; `test/web.test.ts`: *the run button sends pi the job's run command, and refuses an id
      it cannot use* (which also posts the abort route).
- [x] Busy, queued count, and "pi exited" are all visible without opening a terminal.
      `test/web-page.test.ts`: *a tool call and a dead pi both reach the page*.
- [x] Prompt history: ArrowUp and ArrowDown, but only while the caret is on the first or last line,
      so they still navigate a multi-line draft. `test/web-page.test.ts`: *prompt history recalls what
      was sent, and steps aside on a middle line*.

## Composing

- [x] `/` completes slash commands; `@` completes paths, and the mention is expanded before the
      prompt is sent — the expansion is anchored to the session's directory, not to anything the
      browser supplies. `test/web.test.ts`: *an @ mention is expanded from the session's directory,
      and one outside it is skipped*.
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
- [x] What is in the composer survives a reload, and belongs to the tab that typed it: the header's
      reload button, the stale-page banner and a phone that discards a backgrounded tab all come
      back to the same text, and a second tab of the same address keeps its own. A draft belongs to
      its conversation too: a row of the list loads another one in the same tab, and the box there
      starts empty. `test/web-page.test.ts`: *a reload keeps what is in the composer, in that tab
      only*, *a draft typed in another conversation of this tab stays with that conversation*.
- [x] The composer grows with what is typed into it, up to the ceiling the stylesheet declares, and
      comes back down when the text goes or is sent — a multi-line prompt is written and read at its
      own height rather than through a one-line slot. `test/web-page.test.ts`: *the composer grows
      with a multi-line prompt, and shrinks again*.

## What the feed shows

- [x] A conversation a terminal holds shows what the terminal wrote. The page reads it from the
      file, never by switching its own pi to it. The terminal says on its lease when a turn starts
      and ends, and the held line says "answering since 12:03" meanwhile; when the turn is over and
      the file holds a new message, the page reads it again once, with "your terminal answered" as
      the reason. A reload that starts while another one replays what it held draws each message
      once. The run cards saved in the conversation are drawn where they were written, after a
      reload too. A file over 32 MB is not read by the page; the page's pi answers it.
      `test/page-server.test.ts`: *a terminal-held conversation is read from its file, never
      by switching the page's pi, and read again once when the terminal's turn ends*; *a
      terminal-held conversation's run cards come back with its messages, in file order*; *a held
      conversation's file over 32 MB is not read in the always-on process*; *what a terminal added
      is found to hold a message when a large result comes after the message line starts*; *a
      pi-loops view is redacted and capped on the server before the page sees it*; *the page's pi's
      conversation comes back with its run cards in place, asked fresh each time*; *the page's pi's
      conversation over 32 MB is answered with its messages alone*. `test/web-page.test.ts`:
      *a held conversation read again shows its three run cards, and a card saved while the page
      looks is drawn as it lands*; *a run card in the transcript and replayed as it landed is drawn
      once, by its entry id*.
      `test/web-page.test.ts`: *a reload that starts while another replays what it held draws each
      message once, in order*; *the terminal's answer arrives as one numbered reread*; *while the
      terminal answers, the held line says since when*. `test/lease.test.ts`: *shouldReadAgain*.

- [x] Assistant text, thinking, tool calls, tool results, errors, and the end of a turn.
- [x] The conversation is what the conversation is for. A whole stretch of work — thinking and tool
      calls, interleaved as they arrive — is **one** row, closed: what is happening while it happens,
      what happened afterwards. The reply that follows it shares the row — its label and copy
      button sit in the summary, so "ASSISTANT" and "6 steps · thinking, bash" are one line, not
      two — and the stretch continues past the reply rather than being cut in two. One button in
      the header opens or closes every one of them.
      `test/web-page.test.ts`: *a stretch of work is one row, and one button opens every one of
      them*, *a reply without work keeps its own label row*, *the work row's live line is cut in
      characters, not the units a string is counted in*.
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
      `test/web-page.test.ts`: *an update while you are reading back does not yank the page, and the
      pill is the way back*.
- [x] Every block says when it happened: in a tooltip on a mouse, and written under the block on a
      touch screen, which has no hover to show a tooltip with. `test/web-page.test.ts`: *every block
      keeps its time where a touch screen can show it, not only in a tooltip* (the data; the
      coarse-pointer rule that draws it is checked by reading).
- [x] Every message, tool call and result can be copied, including over plain http where the
      clipboard API is unavailable. The button waits for a hover on a mouse and is simply always
      there on a touch screen, which has no hover to wait for.
- [x] Tool results, an extension's messages and pi's dying words are capped, and every cap says how
      much was dropped — one helper for the three of them, because they used to report it three
      different ways and one of them not at all, so a result that stopped at 8000 characters looked
      like a result that ended there. The count and the cut are characters, not UTF-16 code units, so
      an astral character is counted once and a cut cannot end on half of one. `test/web-page.test.ts`:
      *a capped result counts characters, not the units a string is counted in*; `test/web.test.ts`:
      *pi's dying words are cut by characters, and the cut says how much it dropped*.
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
      `test/web-page.test.ts`: *a run of tool calls is one row, and the reply shares it*.
- [x] You are on the right in a bubble and the model is full-width prose: the shape says who is
      speaking before a word is read. Status lines are small, monospace and quiet — context, not
      conversation.
- [x] The conversation has a reading width. A line the width of a 27-inch monitor is not readable.
- [x] An empty conversation is a blank feed above a focused composer, whose placeholder says what
      to type; the first message is its first row. `test/web-page.test.ts`: *an empty conversation
      is a blank feed, and the first message is its first row*.
- [x] The conversation's whole id is the last line of the ⋯ sheet, one click to select and copy;
      ⋯ is there at every width. `test/web-page.test.ts`: *the ⋯ sheet ends with the conversation's
      whole id, to copy*.

## Automation, which is the reason this project exists

- [x] Jobs, loops and rules: what they are, whether they are enabled, and what the last error was.
      A disabled card says `disabled` in words, as `/cron` does, as well as being drawn faint.
      `test/web-page.test.ts`: *a disabled job or rule says so in words, not only by being faint*.
- [x] **What this project has is what this project has, and the rest is counted rather than
      dropped.** The store is machine-wide and this list is not, so a job made in another directory
      says so as a count — without it, a job somewhere else is indistinguishable from a job that is
      gone. Loops and rules are counted and labelled apart, each line counted as its command counts
      it: one number covering both agrees with neither command. The project switcher above is the
      way there; the terminal's `/cron all` and `/triggers rules --all` list them. The inbox counts
      other projects' new findings the same way, with no command.
      What counts as "this project" is what the extension says it is — symlinks resolved, `$HOME`
      too broad to be one — because a panel that disagrees with the command is worse than either.
      `test/web.test.ts`: *the panel and /cron agree about what this project is*.
      `test/web-page.test.ts`: *what the machine has that this project does not is counted, apart*.
- [x] **When each job runs next, whatever its schedule.** The page used to work this out itself and
      understood only `every <interval>`, so a job on `0 9 * * *` — the first example in the
      README — showed nothing. A second cron parser in a page with no dependencies was the wrong
      fix: pi-loops has the evaluator, and writes the answers to
      `next-runs.json` beside the store when one of them changes; when pi-loops is not running, a window
      writes the same file, so a person with only plain jobs still sees their next run. Another
      conversation's plain job is marked as `/cron` marks it, from the same function: open in a
      terminal, in the page, in the background, or resume it to run. A time that has already passed is
      shown as no next run rather than as a past one, a job that is disabled or belongs to another
      machine is not promised one, and a next run that is not today says which day it is.
      `test/scheduler.test.ts`: *pi-loops writes when each job runs next*.
      `test/web.test.ts`: *the panel shows the next run of a cron-expression job*.
      `test/web-page.test.ts`: *a next run in April does not render as a time of day*.
- [x] The name of a job is never abbreviated: it is what `/cron set <name> …` takes, so a clipped
      one is a name you cannot act on. It wraps; the schedule beside it does not break in half.
- [x] **The whole prompt, condition and action are one click away, and a last error is one line
      when closed and whole when open.** They used to be cut — a job's prompt at ninety characters,
      a rule's condition and action at eighty, the error at one hundred and twenty — with no way to
      see the rest, which made the panel a place where things looked shorter than they were. Each
      card is a `<details>` now: closed, a two-line preview and, for a failing job, a one-line error
      hint; open, the whole text and the fields the terminal's `/cron` line has. What is shown in
      full is masked with the same secret patterns as the stderr tail, and a card keeps its open or
      closed state across the panel's eight-second redraw.
      `test/web-page.test.ts`: *a job's whole prompt is one click away, and stays open across a
      redraw*; *a rule's condition and action are shown in full*; *a job with a last error says so
      before it is opened*.
      `test/web.test.ts`: *a key in a job's prompt does not reach the page*.
- [x] Run a job now. `test/web.test.ts`: *the run button sends pi the job's run command, and refuses an
      id it cannot use*.
- [x] **Stop this run** on a loop row that is running, with an inline confirm in the row (*Stop this
      run of pr-watch? Its notes are not updated. The next run happens on schedule.*, or *It will not
      run again by itself.* for a one-shot) and two buttons, **Stop it** and **Keep running**. No
      dialog and no key handler: closing the confirm by any means sends nothing (Keep running, or a
      click anywhere outside the row), and the 8-second redraw keeps it open. Stop this run is shown
      only for a run pi-loops in the background holds. Stop it posts the run's whole id to
      `POST /loops/stop`, which starts no pi; the row says *stopping…*, then *Stopped by you.* when
      the run's record says a person stopped it, *The run ended.* when it ended some other way first,
      *stopping is taking longer than usual* after 8 seconds, or *It finished before the stop reached
      it.*; a run that ends while the confirm is open says *This run has finished.* The waiting
      page's Stop it takes the same path. At 390 px the buttons stack at full width.
      `test/web-page.test.ts`: *a running loop row has Stop this run; the confirm opens inline,
      survives a redraw, and Keep running closes it with nothing sent*; *Stop it posts the whole run id
      to /loops/stop; the row says stopping, then stopped by you once the run is gone*; *a run that
      ends while its confirm is open says so; a stop that came too late says the run finished first*;
      *the loop row's confirm is built around clicks only, and at 390 px its buttons stack at full
      width and at least 32 px tall*; *a click anywhere outside the loop row closes its confirm and sends
      nothing; a running row says running once*; `test/page-server.test.ts`: *POST /loops/stop: the whole run id
      goes to pi-loops, which answers at once; a run that already ended says finished*; *the waiting page's Stop it goes through the same stop as a loop row's, as
      the page's*; *a loop row carries its run, its signal and one suggestion; apply writes one patch
      and a cron_control_plane row, Keep only the kept key, a stale key is 409* (Stop only for a run
      pi-loops holds); *the loop
      routes take the checks every POST takes, a 1 KB body, exactly their fields, and whole ids;
      nothing refused writes or starts a pi*. *Stop it posts the whole run id to /loops/stop…* also
      checks *The run ended.* when the record does not say a person stopped it.
- [x] A loop row shows its worth when it is not zero, only the parts that are not (*6 findings in 30
      days · 6 dismissed · quiet ×12*), and at
      most one suggestion, **Run hourly instead** or **Pause**, with **Keep**. Nothing applies itself.
      Applying posts the loop's id and the suggestion's key to `POST /loops/tune`; the server works
      the suggestion out again and refuses a key it would not suggest now, and applying writes a
      `cron_control_plane` audit row. Keep changes nothing but the loop's memory of the answer, and the
      suggestion stays dismissed. `test/web-page.test.ts`: *a loop row shows its 30-day signal and
      one suggestion; Keep and the suggestion post only the job, the key and the choice*; *right
      after Apply the row's next run and the note say one time, in one format, and the note is set
      apart from the signal*; the row never shows a next time earlier than now: once the applied
      time has passed, it shows the store's (*an applied next run that has passed gives way to the
      store's, so a row never shows a next time earlier than now*); *a
      suggestion that changed under the page says so instead of acting; nothing applies itself*;
      `test/page-server.test.ts`: *a loop row carries its run, its signal and one suggestion; apply
      writes one patch and a cron_control_plane row, Keep only the kept key, a stale key is 409*; *a
      loop whose findings were all dismissed is offered Pause, and applying it turns the loop off*;
      `test/job-tune.test.ts`.
- [x] A rule that waits for a path says so on its row: *waits for ~/build.done · next look 09:22 · no
      model call until the file exists*. `test/web-page.test.ts`: *a rule that waits for a path says
      what it waits for and when it looks next*; `test/page-server.test.ts`: *a rule that waits for a
      path says so on its row, with the next look from the process that checks rules*.
- [x] The inbox as cards above the conversations: decisions first under **Needs you**, each with
      **Waiting on** and **If you don't** when the loop said them, then news. A card names its loop
      only when the list holds more than one loop's findings, and says where a claim runs only when
      that is not the conversation on screen (another conversation's or project's finding, or a
      terminal that takes no messages). **See the run** is there only when the finding has a run.
      Every card carries its finding's whole id; no button names a position. `test/web-page.test.ts`:
      *the inbox shows decisions before news, each row only with a value, and where a claim runs
      only when that is not here*. `test/page-server.test.ts`: *GET /inbox: one project's cards, decisions first,
      fifty at most, a torn line left out, and starts no pi*.
- [x] **Yes, do it** on a decision and **Look into it** on news claim the finding into the
      conversation that created its loop, and the card says where it runs: queued for your
      terminal, running in a conversation open in the page, starting one, or waiting on pi-loops'
      scheduled turn. `test/web-page.test.ts`: *Yes posts the finding's id and this conversation,
      nothing else, and shows where it runs*. `test/page-server.test.ts`: *a claim from the page
      queues the born-left inbox: row for the terminal that holds the conversation, once*; *a claim
      for a conversation nobody holds starts its pi and rings it with the row's fingerprint*; *a
      claim for a conversation whose pi has no pi-loops sends that pi nothing*.
- [x] A finding whose loop belongs to its project (a starter added before its conversation was
      saved) runs in the conversation you claim it from: **Yes, do it here** claims it into the one
      open here. `test/web-page.test.ts`: *a project-owned finding runs in the conversation it is
      claimed from: Yes, do it here, and no line to say so*. `test/page-server.test.ts`: *a
      project-owned finding (a starter's loop installed before its conversation was saved) says it
      runs where it is claimed from, and is claimed into the asking conversation*.
      `test/scoping.test.ts`: *a recipe installed in a conversation pi has not saved makes a
      project-owned loop; in a saved one the loop keeps its conversation*. Live: J7 checks the
      starter's job has no creating conversation.
- [x] A finding whose conversation is gone is claimed into the one open here, when it is in the
      finding's project (**Yes, do it here**). `test/page-server.test.ts`: *a claim whose
      conversation is gone runs in the page's own when it is in the project, and is refused
      otherwise*. Listed for another project, it says "its conversation is gone; runs in a new
      conversation in <project>", and **Yes, do it** starts that conversation (as + New does
      there), claims the finding into it and goes to it; one that cannot start claims nothing and
      says why. `test/web-page.test.ts`: *a card whose conversation is gone runs in this one in its
      own project, and in a new conversation there in another project*.
- [x] A project-owned finding listed for another project says "runs in a new conversation in
      <project>", and **Yes, do it** starts that conversation, claims the finding into it and goes
      to it, as a gone one does; in the open conversation's project it stays as above.
      `test/web-page.test.ts`: *a project-owned card listed for another project runs in a new
      conversation there: started, claimed into, and opened*.
- [x] The Loops pane lists loops and rules and nothing else; the list's cards and the tab title
      count the inbox. The desktop rail and the phone's tab bar call the list
      **Inbox**. `test/web-page.test.ts`: *the Loops pane lists loops: no inbox count and no summary
      line, and its rail button says Inbox for the list*.
- [x] Every loop row is ▸, its name and schedule, and **run** on its first line; a long name moves
      the schedule under it, never ▸ or run onto a line of their own. In a pane of loops, the plain
      job is the one marked: its schedule ends `· in its conversation`.
      `test/web-page.test.ts`: *a loop row is its name, schedule and run on one line; the 30-day
      line only when it is not zero*.
- [x] **No…** and **Dismiss…** take a reason chip (`Not a bug`, `Already fixed`, `Duplicate`, `Too
      noisy`, `Not now`), a typed reason of at most 500 characters, or none; the card then says
      whether the loop's next run hears it. `test/web-page.test.ts`: *No then Not a bug posts that
      reason and says it goes to the loop's next run*; *a typed reason is sent as typed, and the
      field holds at most 500 characters*. `test/page-server.test.ts`: *a dismiss from the page
      stores the reason for the loop's next run and says so; past 500 characters it is refused*.
- [x] What was found while you were away, above the cards: "Since yesterday 23:10 · 3 findings, 1
      from this conversation · $0.41", counted per project by the function the
      terminal's session-start line uses, each part kept whole when the line wraps; "N from this
      conversation" only when that is not every finding (`test/web-page.test.ts`: *the away card
      names the findings from this conversation only when they are not all of them, as src/seen.ts
      does*). Runs are the
      activity strip's to count, so a card shows only when something was found. The time is the browser's local time measured from the
      server's clock. The first card after a load is scrolled into view, ahead of the open
      conversation's row (measured at 390 px by J6, test/journey/journeys/j06-away.mjs, step *the
      away card on a phone*). `test/web-page.test.ts`: *the away card says what was found since the cursor,
      leaves runs to the strip, and has Mark all seen*; *the page's
      since words are src/seen.ts's, across midnight, in two time zones*; *the away card wraps
      between its parts and keeps the inbox card's buttons*. `test/away-agree.test.ts`: *the
      terminal's helper and the page's GET /inbox give the same away summary from the same files*.
      `test/page-server.test.ts`: *GET /inbox carries the project's away summary, counted as the
      terminal counts it*.
- [x] **Mark all seen** moves the project's cursor to what the card counted and clears the
      terminal's next session-start line too; the findings stay new and the cards stay. A refused
      mark keeps the card and says why. `test/web-page.test.ts`: *the away card: the first window's
      words, nothing without a finding, and a refused mark keeps the card*. `test/page-server.test.ts`: *POST /inbox/seen takes the checks every POST takes, a
      512-byte body, a known project and a time not in the future, and writes only seen.json*.
- [x] A project with no loop and no rule offers three starters above the cards (daily-digest,
      pr-watch, changelog-draft), each its name, a `≈ $N/day` chip when it costs something, its
      recipe's `line` (one sentence of at most twelve words; its summary when it has none), whole, and
      **Add**. Only for the open conversation's project, since Add installs there.
      `test/web-page.test.ts`: *a starter's line shows whole, never cut, and a starter that costs
      nothing shows no cost*. `test/recipe.test.ts`: *every packaged recipe says what it does in one
      sentence of at most twelve words*; *a starter carries its line whole, and a recipe without one
      carries its summary*. `test/page-server.test.ts`: *GET /inbox offers three starters, in the design's
      order, only for the open conversation's project and only while it has no loop and no rule*.
- [x] **Add** sends `/recipe add <name> --level report` to this conversation's pi, exactly what a
      person may type in the composer, and the wizard's questions are this page's dialogs; closing
      one installs nothing and Add is live again. A refusal says why. In a conversation a terminal
      holds, Add is replaced by the terminal command, with **Copy**. `test/web-page.test.ts`: *an
      empty project shows three starters, each its name, one line and Add, and Add runs the wizard
      with the constant command*; *a starter the pi refuses says why; a terminal-held conversation shows
      the terminal command instead of Add*.
- [x] An open reason box keeps its text, its selection and its focus when the list is drawn again
      (the 15-second poll, or an action on another card), and closing it with **Cancel** or **No…**
      keeps the text for when it is opened again. `test/web-page.test.ts`: *an open reason box
      keeps its text, selection and focus across the list's redraw and a button's*.
- [x] A finding another page or a terminal handled first says so, and a post that failed keeps its
      buttons. `test/web-page.test.ts`: *a finding another page already handled says so; a failed
      post keeps the buttons*.
- [x] A finding's text is shown as text: HTML in it makes no element. `test/web-page.test.ts`: *a
      finding's HTML is shown as text and creates no element*.
- [x] **See the run** opens the run's transcript read-only, folded and redacted, and its close
      button closes it.
      `test/web-page.test.ts`: *See the run opens the run's lines read-only, as text*.
      `test/page-server.test.ts`: *See the run reads a run's transcript under sessions/ and nothing
      else*.
- [x] On a phone, inbox buttons are at least 32 px tall (40 px on a touch screen) and a card wraps
      rather than scroll sideways. Measured in a real browser at 390 px by the J3 journey, in its
      step *the inbox pane on a phone* (test/journey/journeys/j03-decide.mjs: every visible card
      button's `offsetHeight`, and `scrollWidth` against `innerWidth`); the rules themselves are
      pinned by `test/web-page.test.ts`: *inbox card buttons are at least 32 px tall and the card
      wraps rather than scroll sideways*.
- [x] A claim's card follows the server: queued while its row waits, then "Handed to that
      conversation." once the row is gone, also when it is gone before the page looks again; the
      list's and the panel's counts are asked for again with it. A disabled button looks disabled
      and does not change on hover. `test/web-page.test.ts`: *a claim's card follows the server*;
      *a claim whose row is taken before the page looks again says it was handed over, at once*;
      a claim whose row is cancelled from this page's queue says "Cancelled; nothing was sent. The
      finding stays claimed." instead (*a claim cancelled from this page's queue says nothing was
      sent and the finding stays claimed, not that it was handed over*);
      *a disabled card button looks disabled, and a disabled button does not change on hover*.
- [x] **Loop activity** between the conversation and the composer: closed, one line ("loop
      activity · 5 runs today · 1 failed · 1 rule result"); open, a row for each loop run and each
      matched or failed rule check of this project over the last day, newest first, at most 100. A
      run that carded in the conversation on the screen says `in chat`, and no other row does; a removed loop says `(removed)`; a rule result names its
      condition and points at its card. Only a loop's first three runs and its failures write into
      the conversation (docs/loops.md "Run cards"), so the strip is where every other run is seen.
      The rule rows come from the last 256 KB of the trigger audit, which can hold less than a day
      when checks write long summaries. All text is drawn as text. `test/web-page.test.ts`: *the
      activity strip is one line until opened, then lists every run and rule result as text*; *the
      strip draws 96 items open within 200 ms*; *the strip says in chat only for a carded run of the
      conversation on the screen*. `test/page-server.test.ts`: *GET /activity: one
      project's runs and rule results*. `test/activity.test.ts`: *five runs of a loop are five items*.
- [x] On a phone the strip stays one line closed and opens as a sheet that scrolls inside itself;
      nothing in it scrolls sideways. The open strip takes its own room below the conversation, and a
      conversation read to its end stays at its end. `test/web-page.test.ts`: *the strip stays one
      line on a phone and nothing in it scrolls sideways*; *opening the strip keeps the end of the
      conversation in view*.
- [x] The tab title counts this conversation's project: new decisions, then other new findings,
      each part left out at zero: `(1⚑ 2) pi-loops`, `(2) pi-loops`, `pi-loops`. A finding with no
      project counts in every project, as the inbox lists it; a conversation in no project known
      counts nothing and gets no strip rows. An installed page shows the decisions as its badge too.
      `test/web-page.test.ts`: *the tab title counts this project's new decisions, then its news,
      each left out at zero*. `test/activity.test.ts`: *a finding with no cwd is counted in the title
      of every project, as the inbox lists it*; *a conversation in no project known is told nothing
      of any project*.
- [x] Notifications, off until switched on in the session menu, fire only while the tab is hidden:
      a new decision anywhere on the machine, a loop entering a streak of three failures, the daily
      budget reached. Never for a run, news, a rule result, a visible tab or what was there when the
      page loaded; each fires once. Permission is asked only from the switch. On plain http (a phone
      over a tailnet without https) the switch says it needs https or localhost. The page asks on its
      eight-second poll, which a browser slows to about once a minute in a hidden tab, so a
      notification can be up to a minute late. `test/web-page.test.ts`: *a notification fires only
      while the tab is hidden*; *on plain http the notification switch says it needs https or
      localhost and does nothing*.
- [x] A rule result's card names the rule's condition on its origin line, and its headline is what
      the check said after its `matched <rule-id>`. `test/web-page.test.ts`: *a rule result's card
      names its rule's condition on the origin line*. `test/inbox-card.test.ts`: *a rule result's
      card names the rule's condition, redacted and clipped*; *a rule result's headline is what the
      check said after its `matched <rule-id>` token*.
- [x] While nothing runs loops, a loop's card promises no next run and says `paused: <why>`, and
      the status bar names the reason. `test/web.test.ts`: *with nothing running loops, the panel
      promises no next run, says paused, and still shows the last check*.
- [x] Every time on the page is in one format, the away card's 24-hour words ("15:05", "yesterday
      15:05", "tomorrow 09:00", "Apr 3 2027 09:00"), the same as the terminal's.
      `test/web-page.test.ts`: *every time on the page is in one format, the away card's 24-hour
      words, ahead as well as behind*.
- [x] Runtime: MCP servers and their state, hook count and events, tool count, last poll, snapshot
      age and version. Whether pi-loops is running is the status bar's.
- [x] A count leads to the list behind it — "24 tools" answers the wrong question on its own.
      `test/web-page.test.ts`: *a count in the panel leads to the list behind it*.
- [x] Goal state when a goal is set, and pi-loops for the runtime, each one click open.
      `test/web-page.test.ts`: *the Loops pane shows Goal only while a goal is set, and has no This
      conversation section*.
- [x] A malformed job in a store file does not blank the panel. `test/web-page.test.ts`: *a job
      with the wrong types in it does not blank the sidebar*.
- [x] The panel is the loops rail, and it never disappears: what a loop is doing is the reason to
      open this on a phone. Wide, it is a column beside the conversation, which the rail's Loops
      button gives back to the conversation, remembered; up to 1100 px it is a drawer from that
      button; on a phone (760 px and less) it is the Loops tab.
- [x] Thirteen controls do not fit across a narrow conversation. Below 1000 px of conversation,
      whatever is beside it, the ones you reach for mid-conversation (undo, find, compact and resume)
      stay in the header on one row with ⋯, and the header stays two rows at a 1280 or 1440 px
      window; reload, save, share, clear, add device, theme and notifications go behind ⋯. The
      sheet lists all of them, moved — not copied — into it. On a phone (760 px and less) every one is behind ⋯.
      `test/web-page.test.ts`: *the header's secondary actions move into a sheet and back*, *below
      1000 px of conversation, undo, find, compact and resume stay in the header and the rest go
      behind ⋯*.

- [x] **A watch from one sentence.** `+ Watch for…` beside `+ New` opens the box *Watch for…*: one
      sentence field, named for a screen reader, and three example sentences (English and Chinese);
      an example fills the box. `Read it` sends the
      sentence as the ordinary chat message `Watch for: <sentence>`, queued and cancellable like
      any other; `cron_create` and `new_trigger` answer it by asking the person, through pi's own
      select, before they create anything.
      `test/web-page.test.ts`: *the Watch for… box opens with three examples and no caption, and an
      example fills it*.
- [x] A sentence with no time word and nothing to wait for gets the card "This reads like something
      to do now, not something to watch." from the page itself: nothing is sent and no model is
      called. `test/web-page.test.ts`: *a sentence with no time and nothing to wait for gets the now
      card, and nothing is sent*.
- [x] The question is a card, in the box and in the transcript, drawn from the select's title rows
      and options alone: the kind (*On a schedule* / *When something happens*), when it runs or
      waits for, how often the background looks for a rule, what it does, for a schedule whose
      result goes to the inbox what it remembers and whether a checker reviews each finding, the
      policy's reason when the action is one the unattended guard would refuse, and the choices:
      Result (this conversation or the inbox; a rule's inbox chip reads *Put it in my inbox*, since
      a matched rule's result reaches the inbox and the loop activity strip), for a rule Repeats
      (once or every time), and for a schedule in the inbox Checks (none or each finding). The chips start on the first option, which is the model's own choice. A select that
      is not a watch question stays a dialog. Nothing is written until the person answers.
      `test/web-page.test.ts`: *a watch question draws the card from its title and options, in the
      box and in the transcript, and no dialog*, *a select that is not a watch question stays a
      dialog*; `test/scoping.test.ts`: *with a person in their own turn, new_trigger asks through
      pi's select and Set it up creates the rule in the same call*.
- [x] `Set it up` answers the select with the one option the chips name, and `Cancel` with
      *Cancel*, through `/ui-response` like any dialog; one answer per question. Cancel writes
      nothing to `jobs.json` or `triggers.json`. Cancel comes first so Enter hits it.
      `test/web-page.test.ts`: *the card's chips name the option Set it up sends, and Cancel sends
      Cancel*; `test/page-server.test.ts`: *a watch question is a select like any dialog:
      /ui-response carries the chosen option to pi, and the /watch route is gone*;
      `test/scoping.test.ts`: *Cancel, Esc, a timeout and an abort all return cancelled in the same
      call and leave jobs.json and triggers.json as they were*.
- [x] The tool's result in the same turn turns every card of the question into a receipt (*Set up
      dyn-… · shows here · once*, *Not set up*, or *Not set up:* and why the create failed).
      `test/web-page.test.ts`: *the tool's result in the same turn turns every card of the question
      into a receipt*.
- [x] A card in the box that is set up or cancelled closes the box, the way its close button does,
      and gives the focus back to the composer; the transcript's card keeps the receipt. A create
      that failed keeps the box open, with the sentence in it to change. A watch that is set up
      refreshes the page's state and the inbox at once, so the starters and the inbox count do not
      wait for the next timer. `test/web-page.test.ts`: *Set it up closes the Watch for… box, gives
      the composer back and refreshes the state and the inbox; a failure keeps the box*.
- [x] The card shows the whole action and condition, redacted, never cut; an action's further lines
      stay in its own row. `test/watch-plan.test.ts`: *the card shows the whole action and
      condition, redacted, and says when a loop is checked*, *askTitle indents a value's further
      lines, so no line of an action can pass for a row of its own*.
- [x] On a short screen the box's body scrolls, Read it stays in the box's own menu, a card's
      Cancel and Set it up stick to the bottom of what is in view, and a card is scrolled to the top
      of the box when it is drawn, with its status and buttons as one footer so the bar never
      covers the status. Closing the box keeps a waiting card; it is there when you reopen it, and a
      settled one goes. `test/web-page.test.ts`: *closing the box keeps a waiting card; it is there
      when you reopen it*.
- [x] The now-check knows weekdays (plural too), *nightly*, *noon*, *midnight*, *daily*, *weekly*,
      *at 9am*, *in an hour*, *twice a day*, *weeknights*, *later today* and the Chinese time
      words, and a sentence queued behind a busy turn waits for its own turn's question.
      `test/web-page.test.ts`: *a sentence with no time and nothing to wait for gets the now card,
      and nothing is sent*, *a sentence queued behind a busy turn waits for its own turn's question,
      not the earlier turn's reply*.
- [x] A question waits thirty minutes, then pi cancels it and the tool says so: the card says *Not
      set up: nobody answered in time*. A question pi answered on its own (an abort, the turn's end)
      says *Not set up* and sends nothing. One still waiting when a tab opens is drawn once, below
      the conversation; one a tool asked whose run ended is not offered again, and one a slash
      command opened during the run (`/session-share`) still is. `test/web-page.test.ts`: *a
      question pi answered on its own is not left waiting: the turn's end, or the question's own
      time, says it was not set up*, *a question still waiting when the page opens is drawn once,
      after the transcript*; `test/page-children.test.ts`: *a dialog a tool asked is dropped
      when the run ends: pi answered it already, and a later tab is not offered it*.
- [x] A turn that ends with no question shows pi's reply in the box (a question of pi's own, for
      instance) and keeps the sentence for editing; ninety seconds with neither a card nor the end
      of the turn says pi did not answer. `test/web-page.test.ts`: *a turn that ends with no plan
      shows pi's reply and keeps the box*.
- [x] A conversation a terminal holds is answered there (owner decision O2): both tools ask in that
      terminal before they set anything up, and the box says so.
      `test/web-page.test.ts`: *a terminal that holds the conversation answers the sentence there*.
- [x] **The terminal asks the same question.** In a terminal, in the person's own turn, both tools
      show pi's selector with the card's rows as its title and the same options, the model's choice
      first; it replaces `new_trigger`'s confirm, so there is one question, never two. A scheduled
      turn, a sub-agent and pi-loops in the background ask nobody. `test/scoping.test.ts`: *the answer
      is promote_to_chat and fire_once for a rule, and stateful and verify for a schedule*, *a
      sub-agent, a scheduled turn and a pi with no dialog keep today's gate: new_trigger asks the
      host's confirm once and cron_create creates*; J8 in `test/journey/journeys/j08-watch.mjs`
      drives the selector in tmux.
- [x] At 390 px the box and the card fit: nothing scrolls sideways, the chips and buttons wrap, and
      every button is at least 32 px tall (J8 in `test/journey/journeys/j08-watch.mjs`).

## How it looks

- [x] Light and dark are both designed: every surface is a named colour, not a translucent grey
      over whatever the browser paints, so the page looks the same on a machine whose default
      background is not white. The colours are Inspire's, in both schemes: three paper levels
      instead of borders (light `#f2f2f7`, `#ffffff`, `#efeff4`; dark `#000000`, `#1c1c1e`,
      `#2c2c2e`), one amber for what you can act on (`#9a5500` light, `#ffb340` dark), and colour
      for state only, so a hue other than amber is a fault. No colour is written outside the token
      block, except the QR code's black on white, which a scanner needs. The Background view is
      drawn from the same block. `test/web-page.test.ts`: *the stylesheet carries Inspire's paper
      and amber in both schemes, and no colour outside its tokens*; `test/page-server.test.ts`: *the
      Background view is drawn in the page's palette, both schemes, and links back to the page*.
- [x] Focus is visible wherever the keyboard puts it: an amber ring on `:focus-visible`, and no
      rule hides it. `test/web-page.test.ts`: *the stylesheet carries Inspire's paper and amber in
      both schemes, and no colour outside its tokens*.
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
      eight seconds for as long as the process lived. `test/web.test.ts`: *dialogs held for a browser
      that turns up are bounded, oldest first*.
- [x] A confirmation shows what is about to happen apart from the reasoning about it, so it cannot
      be read as prose and waved through. `test/web-page.test.ts`: *a confirmation shows what is
      about to run*.
- [x] A question with a countdown (the scheduled-turn guard, a control-plane confirm) closes when
      its time is up and says `timed out with no answer: refused`, since pi refuses it then and tells
      the page nothing; an approve after that is neither sent nor reported as approved, and the next
      question gets the dialog. A browser that attaches later is not offered it, and one offered again
      carries only the time it has left. `test/web-page.test.ts`: *a question pi times out closes
      itself, says it was refused, and a late approve is not reported*; `test/web.test.ts`: *a dialog
      pi times out is not offered again, and one replayed carries the time it has left*.
- [x] Enter does not approve: the focus starts on cancel, which is written before approve so the
      first menu button is the one Enter hits. `test/web-page.test.ts`: *Enter in a confirmation
      dialog hits cancel, not approve*.
- [x] **A tab in the background does not hold one of the browser's six connections.** Every tab
      used to keep an event stream open for as long as it existed, so the sixth tab — or a few
      forgotten behind the first — left nothing for the request that sends what you typed, and the
      message sat drawn and unsent (#14). A tab closes its stream fifteen seconds after going into the
      background and says `paused in background`; looked at again, it subscribes anew and polls, and
      the seq/epoch check reloads what it missed. The pi behind the page runs, and its jobs run, either
      way. `test/web-page.test.ts`: *a tab in the background gives its connection back, and takes a
      new one when looked at again*.
- [x] **A send that goes nowhere says so.** Six seconds without an answer to `/prompt` and the
      status line reads `still sending — if it never lands, close the other tabs of this address`;
      the request is not abandoned, and the line goes when it settles. `test/web-page.test.ts`: *a
      send that goes nowhere says so instead of looking alive*.
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
      all. When the per-model list is unknown, the picker offers the whole menu pi accepts rather
      than a list of its own.
      `test/web-page.test.ts`: *the thinking-level picker offers every level pi knows, not a list of its own*.
- [x] Attaching an image is refused, with the reason, by a model that cannot see one.
      `test/web-page.test.ts`: *a model that cannot see images has attach disabled and a pasted image
      refused*.
- [x] Cost and token counts.
- [x] Compact, undo (fork from your last message), find across the whole session including
      abandoned branches, export to HTML, and share as a redacted gist. Undo reloads the
      conversation through the one path every other thing that empties the feed uses, so an undone
      session is as empty as a new one. `test/web-page.test.ts`: *undoing the only message empties
      the conversation and puts the message back in the composer*.
- [x] Compaction says what it did — what the context was and what it became, and what the summary
      cost — and what it keeps can be steered: `/compact keep the API shapes`, as in the terminal.
      A line that reports neither is a line asking to be taken on faith.
      `test/web.test.ts`: *the compact button can steer what the summary keeps*.
      `test/web-page.test.ts`: *clear, resume and compact are typed as well as clicked*.
- [x] **This project's conversations are listed beside the conversation, and reading the list starts
      no pi.** Each row is the conversation's title (its `/name`, else the first thing said), when it
      last changed, and who holds it: `terminal`, `open` (the page), `pi-loops` (in the background), or
      no tag; `· open here` when the page also has it. Grouped Today and Earlier when both are there,
      the open one marked.
      A row loads that conversation's own page, so Back, a new tab and a bookmark work as links do.
      Conversations from before 0.23, or from a pi without pi-loops, are listed and open too: pi's
      own session files are what is read. `test/web-page.test.ts`: *the list shows this project's
      conversations, grouped Today and Earlier when both are there, with the open one marked, and
      each row is its address*, *a row says who holds it: terminal, open, pi-loops, or nothing at all*, *showing the
      list asks for no other conversation, and rides on the page's own poll at most every fifteen
      seconds*, *a title cannot carry markup or reorder its line*; `test/page-server.test.ts`: *GET
      /conversations lists a project's conversations from pi's files, behind the token, and starts no
      pi*, *a conversation no lease names opens from pi's own session file, and a made-up id is still
      404*; `test/conversation-rows.test.ts`.
- [x] A row says what needs you (`⚑ N`, a loop it made is waiting on a decision) and has a dot when
      it changed since this browser last looked; a terminal's conversation never has the dot. The
      conversation on the screen is read as of each poll, so the one you watched never gets it back.
      `test/web-page.test.ts`: *the list has no tabs: every row is shown, the dot marks what changed
      since this browser last looked*, *the conversation on the screen is read as of now, not as of
      the list's last draw*.
- [x] Another project is one choice away: the switcher lists every project pi has conversations in,
      and those with only a loop or a lease, each by its folder's name with the whole path as its
      title. It is the one place the page names the project. `test/web-page.test.ts`: *choosing
      another project asks for that project's list by its cwd*.
- [x] + New starts the conversation in the project the list shows. In the open conversation's
      project it is a new session of this page's pi, as before; in another project the server starts
      a pi there (`POST /conversations/new`, a project the list offers and nothing else) and the
      page goes to it, or says why not. `test/web-page.test.ts`: *+ New starts the conversation in
      the project the list shows: a new session here for the open one's, POST /conversations/new and
      its address for another*; `test/page-server.test.ts`: *POST /conversations/new starts one pi in
      a project the page lists, with that project's arguments, and refuses any other cwd without
      starting one*. A project with no arguments of its own still gets pi-loops when the launch
      loaded it with `-e`, and nothing else of another project's: *a new conversation in a project
      with no arguments of its own loads pi-loops with the -e another page's pi was given, and
      nothing else of it*.
- [x] The list, the composer and send are reachable by keyboard: one row is in the Tab order, the
      arrow keys, Home and End move between rows, Enter opens one, and focus is shown.
      `test/web-page.test.ts`: *the keyboard moves through the list one row at a time, and Enter opens
      the row*.
- [x] A phone shows one pane at a time, Inbox (the list), Chat and Loops, from tabs at the bottom;
      the pane is in the address, so Back returns to the one before and a row opens on Chat.
      `test/web-page.test.ts`: *on a phone one pane shows at a time, picked by the Inbox, Chat and
      Loops tabs, and a row opens on Chat*.
- [x] The status bar says whether pi-loops is running in the background (or why loops and checks
      are paused). It is the one place that says pi-loops runs, and its link to the Background view.
      `test/web-page.test.ts`: *the status bar follows the host file the server reads, not the
      snapshot the session last wrote, and the Loops pane does not repeat it*, *the status bar says
      whether pi-loops runs*.
- [x] **Starting over does not mean going back to a terminal.** The context is finished with far
      more often than the window is: a new session and going back to an earlier one are both here,
      by button (the list's + New is the header's clear) and by `/clear`, `/new` and `/resume` typed
      in the composer — the habit comes from a
      terminal and the muscle memory arrives with it. Neither deletes anything: the session being
      left is a file that `resume` lists, labelled by what was said in it rather than by a filename.
      `test/web.test.ts`: *a new session is a path pi has not written yet, and going back is one it
      has*. `test/web-page.test.ts`: *the session you are in is not offered as one to go back to*.
- [x] Going back to a conversation that is already open in the page, in another tab, goes to it:
      the server answers with that conversation's address and the page opens it, as 0.22.8
      switched to it. `test/web-page.test.ts`: *resuming a conversation that is already open in the
      page goes to it*.
- [x] **The session commands are two words here.** `/sessions` prints this project's sessions into
      the feed — short id, when, what was first said — and `/session export [path]` / `/session
      import <path>` are the archive commands, sent as `/session-export` / `/session-import`. pi's
      own `/session` is a terminal command that does not exist over rpc, which is why the extension
      had to hyphenate its names in the terminal and why the page is free to spell them plainly.
      `test/web-page.test.ts`: */sessions and /session export are typed here*.
- [x] A session an extension switches to inside pi is followed: `/inbox open` (a finding's run,
      forked into a new conversation) and `/session import <path> --resume` reload the page onto
      it, as a switch made with the buttons does. A rule's result, or a finding from another
      project, is refused with the reason. `test/web.test.ts`: *a session an extension switched to
      inside pi is followed: the page is told to reload*.
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
- [x] `--continue` and `--session <id|prefix>` open that conversation in the page, so a session
      moves between the two windows. `--resume` is pi's picker, which the page has as **resume**;
      `pi-loops --resume` says so rather than open a picker nobody can see.
      `test/cli.test.ts`: *--continue and --session name a conversation pi already has, and leave
      pi's other arguments*, *the page's address flags are refused with the config.toml lines that
      replace them*.
- [x] **The page outlives the terminal.** pi-loops in the background serves it, and `pi-loops`
      opens it and exits 0, so closing that terminal ends nothing: the page still answers a message,
      and `pi-loops status` counts it as an open conversation. `test/journey/journeys/j01-close-terminal.mjs`
      (J1); `test/cli.test.ts`: *pi-loops asks the running pi-loops to open the conversation, prints
      its page and exits 0*.
- [x] **One pi per conversation.** Each conversation open in the page has its own `pi --mode rpc`,
      and two opens of one share one start. A conversation with no tab, no turn, no question waiting
      and nothing unsent stops after 15 minutes; at most six are open, and opening a seventh stops the
      least recently used idle one, or says, on a page with a way back, that none is idle.
      `test/page-children.test.ts`: *two opens of one conversation share one start*, *an idle child is
      stopped after the idle time, and one somebody needs never is*, *opening one more than the cap
      stops the least recently used idle child, and none idle is full*; `test/page-server.test.ts`:
      *a conversation that cannot open because the page is full answers a page with the reason and a
      way back*.
- [x] **Opening a conversation pi-loops is running a scheduled turn in waits for that turn**, on a
      page that names it and has **Stop it**; opening it then would abort the turn. A conversation
      whose pi keeps stopping shows pi's last words and **Start again** instead of starting it a
      fourth time. `test/page-children.test.ts`: *opening reuses, waits for a turn pi-loops is
      running, refuses after the crash budget, else starts*; `test/web.test.ts`: *a pi that refuses
      to start leaves the server answering, and its page says why*.
- [x] **The Background view.** What pi-loops in the background is doing, in the page's words: every
      conversation with where it is open (a terminal, this page, the background), its loops, rules
      and what waits for it, and what waits in `pi-loops status`'s words, with no pid, every time in
      the page's own format, at `/background`, behind the page's token or a paired browser's device
      cookie. `/background.json` keeps every field. `test/page-server.test.ts`: *GET / with no
      conversation to open is the Background view; /background and /background.json answer to the
      token or a paired browser*, *the Background view shows what waits in the words pi-loops status
      uses, where it is open left to the table*, *the Background view uses the page's words and the
      page's times*, *the Background view's times are written by the page's own clock, from the
      page*. The status bar's "pi-loops running in the background" is the one link to it, and a phone
      shows the status bar under its Loops pane; it links back to the page,
      follows the theme chosen on the page before its first paint, and draws a conversation's title
      as text, as the list does. `test/page-server.test.ts`: *the Background view draws a
      conversation's title as text: no escape sequence or bidi override*; `test/web-page.test.ts`:
      *the status bar is the one way to the Background view, and a phone shows it under the Loops
      pane*.
- [x] The bare address does not land on the Background view because the conversation looked at
      last was empty and never saved: it opens a new conversation in that one's project.
      `test/page-server.test.ts`: *GET / after the last conversation was an empty one pi never saved
      opens a new conversation in its project, not the Background view*.
- [x] **A window older than what is installed says so, across the top, with the button that fixes
      it.** A tab left open across an upgrade looks exactly like a current one — the panel even
      shows a version, but that is the server's, read live — and three rounds of "no reply appears"
      were spent on a page that could not have received one.
      `test/web-page.test.ts`: *a page left open across an upgrade says so*.

### Held, with the reason

- **A watch card posts only the plan's id, the verdict and the two choices to `POST /c/<sid>/watch`.**
  The route, the desk that kept the plan and the `/pi-loops watch` line pi read from its stdin are
  gone: the card answers pi's own select through `/ui-response`, as every dialog does, with one
  option of a fixed vocabulary that the tool checks against what it offered.
- **The `pi-loops:watch` note as the receipt, and Read it again on a card that failed or was gone.**
  The tool result in the same turn is the receipt now, and the model reads that result; nothing
  else is written into the conversation. A failure keeps the box open with the sentence in it, so
  the box's own Read it does what Read it again did; a plan cannot be gone while its question is open.
- **A Set it up with no note in a minute gives the buttons back.** The answer goes to the select pi
  is waiting on, in the same process, so there is no second step that can stall; a question pi
  stopped waiting for says *Not set up* at the turn's end or its own timeout instead.

- **An empty conversation that says what it is ("A pi session, in a browser.").** Owner decision
  for 0.24.0, the layout explains: a blank conversation with a focused composer explains itself,
  and the composer's placeholder says what to type. The undo that empties a conversation still goes
  through the one reload path (*undoing the only message empties the conversation and puts the
  message back in the composer*).
- **The hint row under the composer ("Enter send · Shift+Enter newline · paste images").** It
  repeated the placeholder. Enter sends and Shift+Enter inserts a newline as before (the first line
  of this list), and pasting an image still attaches it. The conversation's id it showed is the last
  line of the ⋯ sheet.
- **A starter's meta line (`reads only`, the budget in words, "asks you to describe your tracker
  first") and the "or describe a loop" link.** `reads only` was true of every starter; the cost is
  a chip by the name; the wizard asks for the tracker when it needs it; and `+ Watch for…` above the
  list is the one way to describe a loop.
- **A dim `not said` under a decision, the meta line on every card, and a greyed See the run.** A row
  shows only when the loop gave it a value, a card says where a claim runs only when that is not the
  conversation on screen, and See the run shows only when there is a run to see. The claim's own
  answer still says where it runs (*Yes posts the finding's id and this conversation, nothing else,
  and shows where it runs*).
- **"pi-loops running in the background (pid N): loops and checks run there" in the Loops pane, its
  link "What pi-loops is doing in the background", and the rail's Background icon.** The status bar
  says it and is the link to the Background view, on a phone under the Loops pane; a paused reason
  is said there too.
- **The Loops pane's summary line ("inbox 3 new (1 decision) · 2 job(s) · 0 rule(s)") and its "last
  run" line.** The inbox's cards and the tab title count the inbox; the pane lists the loops; the
  activity strip lists every run.
- **The away card's run count and its Show what needs me button.** The activity strip counts runs
  and their failures; the **Needs you** heading leads to the decisions.
- **The Loops pane's This conversation section (its name, message count and model), and Goal's
  `none`.** The conversation is on screen; the model is in the header. Goal shows only while a goal
  is set.
- **A loop row's `runs N`.** The activity strip counts runs.
- **The status bar's loop count ("2 loops") and its terminal count ("1 conversation open in a
  terminal").** The pane lists them; the row's `terminal` tag says it.
- **The All, Needs you and Unread tabs above the list, and their counts.** They counted and filtered
  the conversation rows only, yet sat above the finding cards and shared their **Needs you**
  heading. The cards are the view of what needs you, and each row keeps its `⚑ N` and its unread
  dot (*the list has no tabs: every row is shown, the dot marks what changed since this browser last
  looked*).
- **The Watch card's terminal line (`/new-trigger …`, `/cron add …`), its *Model: only once the path
  exists* row, and the `WATCH` tag over it in the transcript.** The rows are the plan; the
  terminal's question keeps the line. Which model runs, and when, is a cost detail the person does
  not choose. The card's heading says what the card is.
- **The Watch for… box's label, its "For example" caption, its project in the title, and the plan
  card's "Not right?" line.** The title and the placeholder say what the box takes, the examples
  are examples, and *Read it* reads the edited sentence again. The project is the one the list
  shows above the button.

- **`/inbox open` (start a new conversation from the run that filed a finding).** A fork writes a
  conversation, and the page's **See the run** covers looking at the run. The terminal keeps it.

- **"After Stop, nothing queued starts a turn until you send again", and the "send queued (n)"
  button.** Owner decision, 2026-11-02: Esc in the terminal and Stop in the browser end the current
  turn only, as in 0.22.8, and what is queued runs once pi is idle, as messages queued in any chat
  do. In exchange the queue is visible and cancellable everywhere: the page keeps its per-row ✕ and
  "queued N ✕", and the terminal has `/cron queue [cancel <n|id>|clear]`. `test/web.test.ts`: *after
  Stop, the queue is untouched and runs on its own: Stop is pi's abort and nothing else*;
  `test/engine.test.ts`: *after Stop, the person's queued rows run once pi is idle, oldest first, one
  lane*; `test/web-page.test.ts`: *the queue lists requests from every source, in order* (no
  send-queued button after Stop).
- **pi's own built-in slash commands.** They do not exist in `pi --mode rpc`; there is nothing to
  call. The extension's own commands work.
- **`/login`.** Its OAuth flow has no rpc equivalent. Log in once with `pi` and the rest follows.
- **`--no-auth`, and loopback only under it.** The page is now an always-on chat with a shell
  behind it, so an unauthenticated page is refused in 0.24: there is no flag that serves one, and
  `pi-loops --no-auth` exits 2 saying so. The token is required on every address.
- **`--host`, `--allow-host` and `--port` on the command line.** The page outlives the command, so
  a flag on it would last until the next restart; its address is `[page]` in `config.toml`, and
  each flag exits 2 with the line to write there. A `--port` that is not a number is refused the
  same way, and a `[page] port` that is not one is reported at startup and leaves 4173.
  `test/cli.test.ts`: *the page's address flags are refused with the config.toml lines that replace
  them*.
- **`PI_WEB_TOKEN`.** pi-loops in the background serves the page, and it is not started from the
  shell that would set the variable, so an override there would hold only until the next restart.
  The token is `web-token` in the loops directory and nothing else: write your own there (letters,
  digits, `-` and `_`, at least 8 of them) and run `pi-loops restart`. A new token signs every
  paired device out (`test/page-server.test.ts`: *a new token signs every paired browser out*).
- **Ctrl-C in the terminal ends the session the way `/quit` does.** No terminal holds the page any
  more: `pi-loops` has exited before there is anything to press Ctrl-C on. `pi-loops stop` is what
  ends every conversation in the page, and each pi is still asked to quit with the signal it
  handles (SIGTERM, which pi takes as `/quit`) and waited for.
- **The terminal is told what became of the automation on the way out.** There is no way out from
  the terminal now: `pi-loops` prints the page's address and exits, and pi-loops keeps running
  loops whatever the page does. `pi-loops status` shows the page and what is open in it.

## Transport

- [x] Loopback by default. `[page] host` binds elsewhere, and only then does a bare address in Host get
      in. `test/page-server.test.ts`: *a foreign Host is refused, whatever it carries*.
- [x] Every write is checked for where it came from before its body is read. A POST carries the
      token in the `x-pi-web-token` header, never in its URL and never in a cookie; it is JSON or it
      is refused. A form post that the browser attached the device cookie to writes nothing.
      `test/page-server.test.ts`: *a POST takes the token from the header, never from its URL*, *a
      refused POST writes nothing under the loops directory*.
- [x] The token never rides in a cookie, which every port on this machine is sent. A reload gets
      it by trading the device cookie and the secret the page keeps for this origin; the event
      stream, a file and a preview open with a key minted for that address.
      `test/page-server.test.ts`: *a sniffed device cookie: a server on another port receives it,
      and nothing it does with it reaches /state, /prompt or the token*, *the event stream, a file
      and a preview open with a key minted for them, and not with the cookie or ?token=*.
- [x] A name you put in front of this — a reverse proxy, a hostname on your own network — is named
      in `[page] allow_host`, and nothing else is accepted under it.
      `test/page-server.test.ts`: *an allow-listed name passes, in any case*, *a foreign Host is
      refused, whatever it carries*.
- [x] **Every route keeps its own guards, the escape hatch included.** `/rpc` carries anything in
      pi's protocol this front end has not grown a button for, and refuses the commands that do have
      a route here — reaching pi through it skipped the mid-turn refusal, the "one of this project's
      sessions" check, and the reset the attached browsers are owed when a session is swapped. It
      also refuses `new_session` and `clone`, which replace that session with no route to do the
      resetting: opening a fresh session is `/switch_session`-shaped work.
      `test/web.test.ts`: *the escape hatch cannot be used to skip a route's own guards*.
- [x] The routes that only read are only read from: `/state`, `/history` and `/stats` answer GET and
      nothing else. `test/web.test.ts`: *the routes that only read are only read from*.
- [x] A request another site started is refused on every route, whatever the browser attached. `test/web.test.ts`: *a request another site started is refused*.
- [x] One address that does not change between launches, and a device is added by pointing its
      camera at a QR — with the six digits as the fallback, never a curl command.
      `test/web.test.ts`: *the token outlives the server*, *a phone gets in with the six-digit
      code*. `test/web-page.test.ts`: *adding a device shows a code and something to point a camera
      at*, *the QR encoder still produces the matrix a scanner was shown*. A guess spends one of
      twenty tries, so a browser that is already signed in is recognised as signed in first —
      otherwise reloading a bookmark with a stale code on it burns the budget the phone needs.
      `test/web.test.ts`: *a signed-in browser reloading a stale pairing code does not spend a
      guess*.
- [x] Pairing survives an upgrade: the token and the paired devices are files outside the package,
      so a device stays signed in across restarts and new versions. A browser paired before 0.24.0
      pairs once more, because its cookie held the token, which no cookie may hold now.
      `test/web.test.ts`: *the token outlives the server*. `test/page-server.test.ts`: *a new token
      signs every paired browser out*.
- [x] Events are incremental. The backlog a late-joining browser replays is bounded.
      `test/web.test.ts`: *the event backlog a late-joining browser replays is bounded*.
- [x] Events carry no credential and no oversized tool payload; the image bytes a message already
      contains travel with it, and the page renders them rather than fetching them. The page itself
      is handed the token — in a first visit's HTML, or for the device secret at `/token` — and
      nothing else is. The
      one event that could have carried a credential was pi's stderr, broadcast when it exits to say
      why: a provider that refuses to authenticate prints the key it was refused with, so that tail
      is capped and redacted before it leaves this process. `host.log`, in the owner's 0600 loops
      directory, has all of it, uncapped but masked by the same `maskSecrets`.
      `test/web.test.ts`: *a credential in pi's dying words does not reach the page*.
