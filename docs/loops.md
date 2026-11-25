# Cron jobs, stateful loops, the inbox, maker/checker

Everything here is `/cron`; `/crontab` and `/loop` are the same command under other names.

## Plain cron jobs

```text
/cron add "*/30 * * * *" summarize the repo state
```

When due, the prompt is written as a request addressed to the session that created the job
(`requests/<session>.jsonl`), and the window holding that session hands it to the agent as a user
message with the engine prefix `[Trigger <run-id>] ` once the agent is idle; the agent runs one turn
(an *inject-and-run* job). While the agent is busy the prompt waits in the queue, where Esc cannot
drop it and a window that quits leaves it for the next one, and runs once the agent is idle, as a
message you queued in a chat does: Esc, and the browser's Stop, end the current turn only. In
exchange the queue is visible and cancellable: the window says `queued: cron <name> runs after the
current turn` when the prompt is queued behind a busy turn, the status line shows `queued N` while
rows wait for this conversation, and `/cron queue` lists them numbered with their source, age and
text; `/cron queue cancel <n|id>` takes one out and `/cron queue clear` all of them, each cancel
audited. While the prompt waits, `/cron` marks the job `[queued <how long>]`,
with the reason when the queue knows one (`backing off until <when>` after a hand-over that failed),
and `cron_list` reports `queued` with `since`. A hand-over pi does not take (no model, no
credentials, another extension's input handler swallowing it: pi starts no turn and tells the
extension nothing) is judged ten seconds after pi's last input event, with pi idle, and offered
again after a minute, then five; the third refusal makes the prompt a finding in the inbox and frees
the job, and a slot due while a refused prompt waits replaces it instead of being skipped onto it,
so one refusal costs one slot, as it did in 0.22. A prompt pi dropped before writing it (Esc, or an
input handler that rewrote the `[Trigger <id>] ` prefix away) is offered again at most three times,
each turn under the job's cap, then goes to the inbox the same way. The prompt of a job you disabled
waits in the queue until you enable it again; a prompt `/cron run` queued runs even if the job was
disabled since, because you asked for it. A one-shot job is removed once its prompt is in the
conversation, not when it is queued. A plain job belongs to the session that created it:
its result is a message in that conversation, so it fires only in the process holding that session.
One window holds a conversation at a time. Open the same conversation in a second window and that
window is a viewer: it fires none of the conversation's plain jobs, `/cron` there marks each one
`[session <id> — open in a terminal]` (or `in the page`) with its next run, and `/cron run` says
where to run it.
When the holding window closes, the viewer takes the conversation over on its next tick. If the
other window added turns after the viewer opened the conversation, the viewer's copy is older than
the file, and a turn fired there would leave those turns on a dead branch. So that window says to
`/resume` the conversation, and its plain jobs and rule results wait until you do: `/cron` there
marks each one `[session <id> — this window shows an older copy; /resume it to run here]`, and
`/cron run` says the same.
When no window holds the conversation, pi-loops fires the job in it: it takes the conversation for
that one turn, runs the prompt there on the conversation's own model (a plain job pins none, and a
`model` a 0.22 chat stored on one is ignored) as the conversation's own turn, so `cron_create`,
`cron_list all_projects` and the other tools act for that conversation and a control-plane confirm
is refused with a sentence that says the turn ran in the background with nobody to ask,
and gives it back, so the answer is in the conversation when you resume it. `/cron` in another
window marks such a job `[session <id> — in the background]`, with its next run. pi-loops leaves a
conversation alone while someone else has written its file in the last two minutes (its own last
write does not count). A window that opens the conversation during pi-loops' turn takes it back at
once: the turn stops at its next step, the slot is owed, and that window runs the job straight away,
even long after its due time and with catch-up off, because the slot was tried, not missed. A turn
pi-loops stops itself (`pi-loops stop`, an upgrade, the daily budget) is owed the same way and runs
on pi-loops' next tick. A turn you stop (`/triggers abort`, `pi-loops abort`) is done: the slot is
spent and the prompt does not run again. Each turn is a run: it appears in `/cron runs` with its
cost, a failure sets the job's error and the same backoff a loop gets, and a one-shot that fails is
tried once more before it is retired. A conversation pi-loops has never seen open in a window (its
file is unknown) is asleep: `[session <id> — resume it to run]` with no next run, and `/cron run`
refuses it. When pi-loops is not running, the job shows `paused: <why>` instead. The daily budget (`[limits] daily_budget_usd`) covers these
turns as it covers loop runs, counting only what each turn adds, not the conversation's history. The
pi-loops loads a conversation's extensions once for its turns and releases them after an hour without
one. Something whose result should not land in a conversation (a nightly
digest, a watch) is a loop: `--stateful`, with the inbox as its outlet.

A plain job's turn is a scheduled turn wherever it runs, and it runs under the job's tools and the
dangerous-command policy (below) in an open window as in the background. So does the turn an MCP
server's `inject_and_run` push starts ([mcp.md](mcp.md)), with no declared tools: the
dangerous-command policy alone. A job made with `--tools` keeps that list. A dangerous command, or a
command outside the job's tools, is not run: pi-loops asks you, in the conversation and in the
inbox, and the turn goes on without it. A call of cron_remove, set_cron_job_state, remove_trigger or
set_trigger_state is asked about the same way. Another built-in tool outside them is refused, and so
is a tool of another extension or an MCP server. pi-loops' other tools run. A job made without it
keeps the chat's built-in tools. A dangerous command, or a command outside the job's built-in tools,
is not run: pi-loops asks you, in the conversation and in the inbox, and the turn goes on without
it. A call of cron_remove, set_cron_job_state, remove_trigger or set_trigger_state is asked about
the same way. Another built-in tool outside them is refused. pi-loops' other tools, and a tool of
another extension or an MCP server, run. This is the same in an open window and in the background. A
tool that is refused is not asked about, since a card cannot show what it would do. A message you
send into that turn makes the rest of it yours and nothing asks again. Your own turns, a `/goal`
continuation, a recipe hand-off, `/new-trigger` and `/cron run` never ask.
pi-loops' own create tools are not asked about: `cron_create` in such a turn makes a job capped to
the turn's tools, as a job a background run makes is capped to that run's, and `new_trigger`
proposes its rule (below). `cron_remove`, `set_cron_job_state`, `remove_trigger` and
`set_trigger_state` are asked about at every call in such a turn: the call is not run, and the
question names the tool, its input and what it would change (the job, or the rules). A turn
pi-loops runs in a closed conversation asks the same way. A yes runs that one call, in a window that
has the conversation open or in the background, only while it would change what the question
showed; otherwise the call is asked about again. In
your own turn these tools ask with pi's confirm, and in a loop's or a check's run they are refused.

### A proposed watch

In your own turn in a pi with a UI, `cron_create` does not create a running job. It writes a **proposal**: the job,
with every check a create makes, `enabled: false` and `proposed: { at, session }` in `jobs.json`.
`new_trigger` does the same for a rule, in your own turn and in a scheduled or held turn. Nothing
runs a proposal: the clock, the loop lanes and the rule checks pass over it, and it does not
expire. The model reads `proposed cron job cron-… "pr-watch": the person sees a card …` and is told
not to wait, not to do the action now and not to call the tool again. A sub-agent's `cron_create`
(hop 1), `cron_create` in a scheduled or held turn, `/cron add` and a recipe still create an
enabled job. A `gate` passed to `cron_create` where it creates at once is refused whole: `a gate
needs a person: set it with /cron set <name> --gate`. Where the call writes a proposal, the gate is
on it, and the card shows the command in a `Checks first` row: ``runs `gh pr list` first; no model
call while it says the same``. A gated watch is a loop, so its card does not offer *this
conversation* (see "A gate: no model call while nothing changed"). A proposal needs a saved conversation: with
`--no-session` the tools refuse it. In your own turn in a pi with no UI (`pi -p`) nobody could
answer a proposal, so the tools do what 0.24.2 did: `cron_create` creates an enabled job, and
`new_trigger` asks pi's confirm, which a pi with no UI refuses (`create dynamic trigger requires
interactive confirmation; a person can do it with the slash command`).

The question is drawn from the record, so it is the same after a reload and a restart: the card's
rows, `Set up this watch?` and the options of the watch card. The first option is the model's own
choice: *inbox* (a loop, with its notes between runs, with or without a checker) or *this
conversation* (a plain job of the conversation the watch was proposed in). The question shows no
directory, so a `cwd` outside this project is refused when the tool is called ([design.md](design.md),
decision 24). `/cron enable <name>` on a proposal asks it again in pi's selector and prints the
result: `set up: pr-watch · every 10m · inbox`, `cancelled: pr-watch is removed and nothing ran`, or
after Esc `pr-watch is still proposed`. Esc is not Cancel. A proposal is answered once: when another
surface answered first, the second prints `already answered: set up` or `already answered:
cancelled` and changes nothing.

When a turn settles in a terminal, the window asks you about what waits for you in its
conversation, one selector at a time: first each open question of the conversation (see "When
something looks wrong" below), oldest first, then each proposal of the conversation, oldest first. A
proposal's selector is the one `/cron enable` opens, and it prints the same lines. Esc leaves the
proposal and prints `the watch stays proposed: /cron enable pr-watch asks again` (for a rule,
`/triggers enable <id>`). The window asks only while it holds the conversation, pi is idle and
nothing is queued for the conversation, and it checks this again before each selector. It asks
about each question and each proposal once per pi process, whatever the answer. The page's pi and
a pi with no UI do not ask: the page draws its own cards. A question of a loop is not asked here:
it is in the inbox.

Set it up is one write under the store's lock, applied only while `proposed` is still set: the
fields of the choice, `enabled: true`, `proposed` deleted, and the job's schedule counted from the
answer. Then the audit line `enable`, then a receipt in the conversation the watch was proposed in:
an `append` row (`source: "answer"`, `mode: "none"`, id `rcp-…`) that says what the person chose,
which the model reads at its next turn. Cancel removes the job the same way, with the audit line
`remove` and a receipt. `/cron remove` removes a proposal like any job, with no receipt. `/cron
enable --all` passes over proposals, and `set_cron_job_state` refuses one.

`/cron` lists a proposal where it lists a disabled job:

```
 3. cron-5d1c…  "pr-watch"  proposed: waits for your yes  every 10m  [stateful]
    action: report new or updated pull requests
    next — · runs 0
    /cron enable pr-watch asks again · /cron remove pr-watch cancels it
```

`cron_list` gives the model `[proposed]` where it gives `[disabled]`, and `/cron run` refuses a
proposal. The panel above the editor counts a proposal as proposed: `Loops  2 · 1 proposed`. At session start a proposal of this conversation says `[cron] 1 watch waits for your yes:
/cron enable pr-watch asks again`.

Schedules are local time: 5-field cron (`*/n`, ranges, lists, `mon-fri`, `jan`), the aliases
(`hourly` / `every hour` / `once an hour` → `0 * * * *`; `daily` / `every day` → `0 9 * * *`;
`weekly` → `0 9 * * 1`; `每小时`, `每天`, `每周`), and crontab's `@hourly` / `@daily` / `@weekly` /
`@monthly`. `daily` means 09:00 local; `@daily` means midnight. Also `every 30m`, `in 10m` and
`at 2026-09-08T18:00` (one-shot jobs are removed after they fire). The minimum `every <dur>` is
`1m`: the tick is 30 s, and a sub-minute interval would run on every tick, so it is refused with
the reason at creation rather than created and then disabled by the first tick.

## Stateful loops

```text
/cron add --stateful "0 9 * * *" check the repo issues and report anything new since the last run
```

Each run is a fresh sub-session in pi-loops in the background, through pi's SDK: the built-in
tools of the chat the loop was made in (or its `--tools`), the MCP servers it connects itself from
`mcp.toml` and the project, the model and thinking level of the chat it was made in, no
conversation history, its own transcript file. It does not get the window's `-e` extensions, flags
or live MCP connections. Every run gets the same prompt: the output
protocol, preceded by one line of context (the job's name, when the run started, whether it is a
catch-up, the job's timeout):

```text
You are running the recurring loop "<name>" (current run started <when it started, on the clock of the machine running it, with that machine's offset>; write any time in your notes with its offset, as that one has). This is a background run: nobody is watching, and your final reply is parsed by a program. The run is stopped after <the job's timeout> and counted as a failure, so finish inside that time.

[woken] (why this run started)
you asked to be woken: check CI on #12
[/woken]

[loop-state] (your notes from the previous run of this recurring job)
<contents of the state file, or "(first run)">
[/loop-state]

[notes-files] (longer notes you keep as files in <loops dir>/state/<id>/; read one when you need it)
- prs.md · 3.1 KB · changed 2026-11-13
[/notes-files]

[reported] (what this loop already told a person, and what they did with it; do not report these again unless what they describe has changed)
- 11-12 new: PR #12 has failing CI
- 11-11 dismissed ("Not a bug"): flaky test in foo.test.ts
- 11-10 claimed: draft the release notes for 0.24.2
[/reported]

[asked] (questions of yours that wait for a person; do not ask them again)
- 11-13 run `git push --force origin fix/login`
[/asked]

<your prompt>

Output protocol (mandatory):
- End your reply with <loop-state>notes for the next run</loop-state>: it REPLACES the saved notes; keep it under 2000 characters and make it what your next run needs and cannot look up again (baselines, watermarks, decisions). What you reported is listed for you under [reported]: do not keep ids of reported things here. Put anything longer in a file under <loops dir>/state/<id>/ and name the file in your notes.
- For each finding a human should act on, emit <inbox>one concise line</inbox>, at most 16 per run and 500 characters each. No findings → no inbox tags; do not invent work.
- When a finding needs a person to decide, write it as <inbox><the decision> · waits: <what waits on it> · if not: <what happens if nobody acts></inbox>.
- To be woken before your next scheduled run, or to skip scheduled runs until a time, call wake_me.
- Keep everything after the last tool call short so the tags are not truncated.
```

A block with nothing to list is left out. The `[woken]` block is there only in a run that the loop's
own wake started (see "A loop wakes itself" below). Then:

- the last `<loop-state>` block replaces `state/<id>.md`, the notes (see "A loop's notes" below);
- up to 16 `<inbox>` tags (each ≤500 characters) are appended to the inbox; extras are counted as dropped
  — the count is exact up to the first 1000 tags, past which a reply is a runaway rather than a report;
- a finding whose text is the same as a `new` finding of the same loop is not filed again, and is
  not counted in the run's findings: the run log counts it as a repeat. The run that goes on after
  your yes to the loop's question files its findings by the same rule. When you claim or dismiss that
  finding, the same words are filed again the next time the loop reports them;
- missing or malformed tags never fail a run: the state stays untouched, nothing enters the inbox;
- a run that is still going when the next tick arrives is skipped and counted (`skipped overlaps`).

### A loop's notes

A loop writes one text each run, its notes, and the text replaces the notes of the run before. A
run sees the notes in its `[loop-state]` block. The notes are capped at 2000 characters when they
are written, and the cap is never silent. When a run writes more, `state/<id>.md` keeps the leading
whole lines that fit and ends with one line:

```text
(cut by pi-loops: you wrote 3200 characters and 1890 are kept here. The whole text is in overflow.md. Move what matters into files and keep these notes under 2000 characters.)
```

The whole text goes to `state/<id>/overflow.md`, so nothing is lost. The run log records the cut,
pi-loops writes one warning in its log, and `/cron runs` adds `, notes cut 3200→1890 (whole text in
overflow.md)` to the run's line. A run that fails, times out or is stopped does not change the
notes.

A loop can keep longer notes as files in its notes directory, `state/<id>/` in the loops directory.
The `[notes-files]` block lists each file with its size and the date it changed, at most 50 files:
the files are listed, not loaded, so a file costs one line of the prompt. The run reads a file when
it needs it. Files that a run writes stay when the run fails. A run of a loop can read, write and
edit files in its own notes directory with pi's file tools (`read`, `write`, `edit`, `grep`, `find`,
`ls`). The path is judged by its real path: `state/<id>.md` is not in the directory, and another
loop's notes, the rest of the loops directory, a `../` out of the directory and a symbolic link in it
that leads back into the loops directory are refused, as for every other run. A shell command that
reaches the directory is a question, as before (see "When something looks wrong").

The `[reported]` block lists what the loop already told a person and what that person did: its `new`
findings (the newest 12) and its findings that a person claimed or dismissed in the last 14 days (the
newest 12), newest first. Each line has the date, the status, the reason of a dismiss, and the text
cut at 200 characters. The date of a claimed or dismissed finding is the day of the claim or the
dismiss, from the page, a terminal or `pi-loops inbox`. pi-loops builds the block from the inbox, so the loop does not keep ids of
what it reported in its notes. Its questions about a call are in the `[asked]` block instead.

`/cron gc --purge` and `/cron remove --purge` remove the notes directory with the notes.

### A loop wakes itself

Every run of a loop has the tool `wake_me`, whatever the job's `--tools` say. A run calls it to have
the loop run once more at a time the run chooses, with a note of what to look at then:

```text
wake_me({ when: "in 20m", note: "check CI on #12" })
wake_me({ when: "at 2026-11-16T09:00+08:00", note: "nothing changes over the weekend", quiet: true })
```

- `when` is `in <duration>` or `at <ISO time with its offset>`, the forms `/cron add` reads for one
  time. It is at least 60 seconds and at most 7 days ahead.
- `note` is at most 500 characters. The run that the wake starts reads it in its `[woken]` block.
- `quiet: true` also skips the loop's scheduled runs before that time. Each skipped slot is decided
  and spent, with the note `quiet until <time>, asked by the loop: "<note>"`.
- A loop has one wake. A second call replaces everything the first set: the time, the note and the
  quiet. A call without `quiet` removes the quiet of the call before.
- At most 24 runs in 24 hours start from wakes, counted from the run log.

A refused call sets nothing, and says which bound it crossed and when the loop's next scheduled
run is:

```text
not set: a wake is at least 60 seconds and at most 7 days ahead. Its next scheduled run is 15:00.
not set: this loop has woken itself 24 times in the last 24 hours. Its next scheduled run is 15:00.
```

A call that sets a wake says so, and says the wake it replaces:

```text
set: this loop wakes at 2026-11-14 14:20 +08:00 ("check CI on #12"). This replaces the wake you set for 16:00. Its next scheduled run is 15:00.
```

The wake is written to `clock.json` for the loop whose run called the tool, and for no other. When
its time comes, pi-loops queues one run in the loop's lane, and then removes the wake. A wake that
comes due while a scheduled run of the loop waits in the queue adds its note to that run, and a
slot that comes due while the wake's run waits is counted onto it: the loop runs once, for both
reasons. A wake always starts a new session: what the run wants to carry over goes in the note and
in its notes. A wake of a disabled loop waits until the loop is enabled. With `clock.json` gone, the
wake and the quiet are gone, and the loop runs at its next scheduled time.

`/cron` says what the loop set, under the loop:

```text
    next wake 14:20, asked by the loop: "check CI on #12"
    quiet until Mon 09:00, asked by the loop: "nothing changes over the weekend" (/cron run nightly wakes it now)
```

`cron_list` gives the model the same facts as `next_wake` and `quiet_until`, with full stamps. The
page's loop row shows the same two lines, each with a ✕. `/cron set <ref> --wake -` and the ✕ remove
the wake and the quiet. `/cron runs` adds `, woke itself: "<note>"` to a run that a wake started.

### A gate: no model call while nothing changed

A loop can have a gate: one shell command that pi-loops runs before a scheduled run, to see whether
anything changed. While the command prints what the last run saw, the slot is held: no row, no run
and no model call. Set it when you add the loop, or later:

```text
/cron add --stateful --gate 'gh pr list --json number,updatedAt' "every 10m" report new or updated pull requests
/cron set pr-watch --gate 'gh pr list --json number,updatedAt'
/cron set pr-watch --gate -
```

`--gate` makes the job a loop: a plain job's turn has no gate. A recipe sets one with its job's
`gate` key (see [recipes.md](recipes.md)). A model sets one only when it proposes the watch, and you
see the command on the card, in its `Checks first` row (see "A proposed watch"). A model that
creates a job at once, in a scheduled turn or in a loop's run, is refused with `a gate needs a
person: set it with /cron set <name> --gate`.

How a look works:

- A gate is one line of at most 1000 characters. It is refused where it is set (`/cron add`,
  `/cron set`, a recipe, a proposal, an imported archive) when the dangerous-command policy would
  refuse it or ask about it in an unattended run, with the loops directory: a gate runs with nobody
  there to ask. Where a gate is set, the policy is asked without `[danger] allow`. Only a look, when
  the gate runs, also lets through the prefixes `[danger] allow` lists.
- A gate is shown as itself everywhere, whole: on the card, in `/cron`, `cron_list`, the page, an
  archive's question and the run's `[gate]` block. So a command that would not show as itself is
  refused where it is set: one with a line break, a control character (a terminal escape among
  them), a format character (a bidi override, a zero-width space, any Unicode `Cf`), or a part that
  reads as a secret (`password=…`), which every surface would hide. A person never says yes to part
  of what runs. The text beside a gate is cleaned too: each line of `/cron`, `/cron runs`,
  `/triggers rules` and `cron_list`'s text has every control and format character made a space as
  its last step, whichever field it shows (a name, a note, a wake's note, an error, a prompt).
- An archive's gates are shown before anything runs them: `pi-loops inspect` shows each loop's and
  rule's gate, and `pi-loops import` prints each gate it brings before it enables anything, with
  `--activate-triggers=on` as in the question it asks.
- When a slot comes due, pi-loops runs the command in the loop's directory, with `sh -c`, stdin
  closed, a timeout of 5 seconds, and the first 4000 characters of its output. It runs the policy
  first, as for every unattended command. When the look ends, its whole process group is killed, so
  a command that the shell left running in the background does not outlive the look. It looks at
  most once a minute for each loop, also when the time of the last look could not be written to
  `clock.json`. A slot that comes due while a run of the loop is queued or going is counted onto
  that run, and nothing is looked at.
- The reading is the exit code and the output. When it is the reading the last gated run saw (its
  `seen` in `clock.json`), the slot is held. The slot is decided, the look is counted in
  `clock.json`, and nothing else is written.
- Any other reading opens the slot. pi-loops first stores it in `events.jsonl` (source
  `gate:<job id>`, with the command, the exit code and the output), then writes the row, which names
  that event. The run reads it in its `[gate]` block: the command, the exit code and the output.
- When the run ends without a failure, that reading becomes `seen`. A run that fails, times out or
  is stopped leaves `seen` as it was, so the same change opens the next slot again.
- A look that fails opens the slot, which is what a loop with no gate does. A look fails when the
  policy refuses the command, after 5 seconds, when the command cannot start, when a signal ends it,
  and when it exits with 126 or more. Any other exit code is a reading.

`/cron` says what the gate does, under the loop:

```text
    gate: `gh pr list --json number,updatedAt`: the same for 37 looks since 09:00; no model call until it changes
    gate failing: timed out after 5s; pr-watch runs without the gate until it works
```

Before the first gated run ends, the line says ``no run has seen its output yet; the next look
wakes the loop``. The page's loop row says ``No model call while `gh pr list --json number,updatedAt` says
the same · last changed 09:00``, or `Gate failing: <why>`. `cron_list` gives the model the gate and its state. A
held slot is not a run: it is in no run list and writes no card. A slot that `quiet` skips (see "A
loop wakes itself") is not looked at. A wake that the loop set, and `/cron run`, run without a look.

Every run leaves a trail: the sub-agent's full transcript (`/cron trace <job> [k]`, 20 per job) and
a run log with exit code, duration, cost and finding counts (`/cron runs`). Prompts are capped at 8 KB.

### Run cards

A run writes into the conversation that created its loop only when there is something to see:

- a loop's first three runs each get one compact card, so you see that it works and what it reports;
- every failed run gets a card, and a terminal also shows it as a warning;
- a run a person asked for (`/cron run <loop>`, or the run button in the page) gets a card in the
  conversation that asked, whatever its place among the loop's runs and whichever conversation created
  the loop. Its card also shows the first line of the run's reply, cut at 120 characters, with escape
  codes and bidi controls taken out;
- a terminal and the page's pi save a card the same way: the page draws it when it is saved and when
  it reads the conversation again. A window that does not hold the conversation only shows the line.
  The page does not draw the cards of a conversation whose session file is over 32 MB: reading its
  entries would hold up every page. A conversation a terminal holds also shows, in the page, the
  pi-loops views that terminal wrote into it (`/cron`, `/inbox`), redacted and cut at 4000 characters;
- every other run writes nothing into the conversation. A terminal lists the latest three loop runs of
  the project in the panel above the editor (`Runs`), the page lists the project's runs and rule results
  of the last day in its loop activity strip above the composer, and `/cron runs` has them all.

A card is one line: `todo · 5s · $0.003 · 1 finding`, or `todo FAILED · 4s · <error>`; a loop made without `--name` is named from the first words of its prompt (`check-new-issues`); an older loop that has no name is labelled by the first 13 characters of its id (`cron-15c11c9f`), as every surface but `/cron`, `cron_list` and `inbox --json` labels it. It
is saved in the conversation, so a resumed conversation still shows how its loop started, and
`/session-share` leaves it out. A run that was stopped (by a person, a quit or a restart) is not a
failure and gets no card. When more than five carded runs finish between two looks at the run log,
five are shown and the rest is one line: `+4 more runs finished (4 failed) — /cron runs`.

Who asked for a run is in its run log record as `requestedBy: { sessionId }`. A scheduled run, and a
record written before 0.24.0, has none.

A run's place among its loop's runs is in its run log record (`ordinal`). A stopped run does not
count, so the run after it has the same place. A record written before 0.24 has no place and is not
one of the first three.

## The inbox

Global JSONL, shared by every session and project. Each line is one finding in the shape
[CONTRACT.md](../CONTRACT.md) §2.2 fixes, followed by pi-loops' own fields. Job ids are
`cron-<32 hex>`; prefixes, names and list numbers resolve.

```text
/inbox                 Inbox (<project>, N new, K need a decision, times <offset>): "<n>. [<id prefix>] <finding>  (<project>, <loop label or source>, <created_at>)"
                       a decision is listed on up to three lines, its clauses under it:
                       "<n>. [<id prefix>] ⚑ <decision>  (<project>, <source>, <created_at>)"
                       "       waiting on: <what waits on it>"
                       "       if you don't: <what happens if nobody acts>"   (left out when the loop left it out)
                       a question also has its command and why it asks, and the two answers:
                       "<n>. [<id prefix>] ⚑ nightly asks to run a command  (<project>, <source>, <created_at>)"
                       "       command: git push --force origin fix/login"
                       "       why it asks: git push --force on main/master"
                       "       waiting on: nightly went on without it"
                       "       if you don't: it stays undone"
                       "       /inbox claim <n> runs it once · /inbox dismiss <n> [reason] says no"
                       a news finding about an answer (see "One thread" below) is set in under its question
/inbox --all           the same, every project on this machine
/inbox all [--all]     history including claimed and dismissed
/inbox claim <n|id>    say yes: the run that reported the finding picks it up in the background
                       "claimed: <loop> picks this up in the run that reported it, in the background. A card comes here when it ends."
                       (on a question: "approved: <loop> resumes the run that asked, with this one command allowed. …")
/inbox dismiss <n|id> [reason]   say no: mark dismissed; the reason, if you give one, is shown to the loop's next run
/inbox cancel [<n|id>] take back a yes that has not started: the finding is new again, under the same id
                       (with no argument: the answers that wait or run, numbered)
/inbox clear [--all]   dismiss every new finding listed but a question; a finding with an answer is not touched
                       ("dismissed N inbox entries in <project>; left K questions for you to answer: …" when it left one)
```

A yes is an answer to the finding, and it runs where the finding came from. pi-loops resumes the
transcript of the loop's or the rule check's run that filed it, in the background, and tells that
run that a person read the finding and said yes. On a checkpoint, the yes is the person's approval
of the decision the finding recommends; on news, it asks the run to investigate and address it.
The finding's text is given to the run as a quote of what it reported, not as your words. When the
run's transcript is gone, the run starts from the finding's text. A card comes to your
conversation when the run ends. A yes does not run, and says why, when the loop was removed or the
finding has nowhere to run (no loop and no lane). A yes to a finding of a conversation runs in that
conversation. While a window or the page has the conversation open, the yes runs there, as a turn
after the current one (see "When something looks wrong" below). When nobody has it open,
pi-loops in the background takes the conversation, as for its plain job's turn, and runs the yes as
a turn in the conversation's own file, then gives the conversation back. A conversation written in
the last two minutes is left for a later tick. A yes to a finding of a conversation that was deleted
does not run, and says why. `/inbox cancel` takes back a yes while it waits; a yes that has
started or ended cannot be cancelled. A yes to a loop's or a rule check's finding, and one of a
closed conversation, is work for pi-loops in the background, so a window starts it, and while it is
not running the line after `/inbox claim` adds "It runs when pi-loops runs in the background."
`/inbox claim` on a question of the window's own conversation prints `approved: it runs in this
conversation after the current turn, with this one command allowed.`

A dismiss with words after the number — `/inbox dismiss 2 that file is generated, ignore it` — is
the one way a person talks back to a loop. The reason is stored on the entry, and the loop that
reported the finding sees it for 14 days in the `[reported]` block of its prompt (see "A loop's
notes"), which tells it not to report the finding again unless what it describes has changed. A
bare `/inbox dismiss 2` and `/inbox clear` are listed there as dismissed, with no reason.
`/inbox all` shows the reason on the dismissed line. For a dismiss,
`--all` counts only before the reason begins (`/inbox dismiss --all 3 …` or `/inbox dismiss 3 --all …`);
a reason that mentions `--all` in passing does not re-number the list you were looking at.

The file is machine-wide because loops are; triage is not. `/inbox` lists this project's findings
the way `/cron` lists its jobs, names the project on every line, and says how many are waiting
elsewhere; `--all` lifts the filter. Numbers are the numbers on screen — `/inbox claim 3` claims
the third line of *this* project's list, never another repository's finding run in this directory —
while an id or an id prefix still resolves machine-wide. `/inbox clear` dismisses what it listed,
not the unread findings of four other projects. A finding stored without a cwd belongs to no
project and is listed in all of them.

A loop's finding names the conversation that created the loop and the transcript of the run that
filed it. What happened while nobody looked is counted per project: when a conversation starts,
one line counts the project's loop runs and new findings since `/inbox` was last listed in any
conversation of the project, or the page's **Mark all seen** was pressed for it:
`[inbox] since you last looked (yesterday 23:10): 41 loop runs (3 failed), 3 new findings (1 from
this conversation) — /inbox`. Every loop of the project counts, a recipe's included, whichever
conversation created it; `from this conversation` counts the findings whose loop or rule was made
in this one, and is said only when that is not every finding. A loop that belongs to its project rather than a conversation (a recipe installed in
a conversation pi had not saved yet, [recipes.md](recipes.md)) is counted in the project and is
from no conversation; a yes to its finding runs in the background, in the run that reported it, as
for any loop, and `pi-loops inbox claim` marks it claimed and runs nothing, so the caller handles it
([cli.md](cli.md#inbox)). Such a loop is stored with `owner:
"project"` and no `createdBy`, and a `.pisession` archive keeps it the project's on import. A
rule check that filed a finding for two conversations is one finding. A stopped run
is a run, not a failure. A finding counts while it is new, and a finding stored without a cwd
counts in every project, as `/inbox` lists it. The time is local: `09:14` today, `yesterday
23:10`, a weekday within the week, a date before that.

Listing `/inbox` clears the line for the project, in every conversation of it and in the page;
`/inbox --all` clears it for every project. The page's away card counts the same way, from the
same function (it says the findings and leaves the runs to the activity strip), and its **Mark all seen** clears the terminal's line too: the next session start
says nothing until something new happens. Marking moves only the cursor; the findings stay new.
The terminal's `/inbox` marks the time it finished listing, so a finding filed in the milliseconds
while it listed counts as seen; the page sends the time of the answer its card shows, so what
arrived after that is still counted.
The cursors are in `seen.json`, one per project. When nobody has looked yet (a new project, or the
first start after an upgrade from 0.22.x, which kept no cursor), the line counts the last day
(`(in the last day)`), never the whole run log. A cursor from an older 0.24 build, kept per
conversation, counts for the project its conversation's records are in, so nothing is counted
twice. A cursor more than five minutes ahead of the clock counts as none, and the next look
replaces it. A clock moved back can hide records written in the gap until the next look.

`/inbox open <n|id>` starts a new conversation from the run that filed the finding: pi copies the
run's transcript into a new session and switches to it, and the run's own transcript is never
written. A transcript a new finding points at is kept when older runs are pruned, up to 100 per
loop; one that is gone anyway is reported as such.

A finding that asks for a decision is a **checkpoint**, and the inbox knows one by its shape:
the ` · waits: … · if not: …` clauses every packaged playbook writes
([recipes.md](recipes.md#checkpoints)). The run's text is read once, when its findings are
appended, and the entry carries `kind: "checkpoint"` from then on; news carries nothing. `/inbox`
lists checkpoints first, marked `⚑`, and says how many there are in its header (`3 new, 1 needs a
decision`); the numbers on screen are the numbers `claim` and `dismiss` take, so the order is
decided in one place. A yes to a checkpoint tells the run that it is the person's approval of the
decision the finding recommends, and to carry it out rather than investigate it again.
`/inbox`, `pi-loops inbox list` and the page read a finding through one parser
(`src/inbox-card.ts`): a checkpoint's headline is the text before `· waits:`, and its two clauses
are shown apart as **waiting on** and **if you don't**; a clause the loop left out is not shown.
The stored line does not change. `pi-loops inbox list --json` prints the stored fields, unsplit.

**One thread.** A question, its answer and the news about that answer are one thread. When a yes
could not be started, or was started and did not finish, pi-loops files one news finding about it
(`Your yes to … could not be started (…)`, `Your yes to … was started and did not finish (…)`). That
news finding carries `re`, the id of the finding the yes was to. `/inbox` lists it under that
finding, set in by four spaces: when the finding is not new any more, its first line heads the
thread, unnumbered, with what became of it (`[claimed]`). The numbers on screen are the numbers
`claim` and `dismiss` take, in the order of the threads. The page draws the news card right under
its root's card, and `pi-loops inbox list --json` shows `re` after the ten fields
([downstream.md](downstream.md)). A news finding whose root is gone is listed on its own.

The browser page shows this project's findings as cards above its conversations, decisions first.
**Yes, do it** (on news, **Look into it**; on a question, **Yes, run it once**) is the yes of
`/inbox claim`: the run that reported the finding picks it up in the background, and the card says
"Running in the background, in the run that reported it." A question's card shows who asks, the
command under it, **Why it asks**, **Waiting on** and **If you don't**. A yes to a question that a
conversation's scheduled turn asked says "Approved. It runs in this conversation after the current
turn." While that yes waits, the card has **Cancel**, which is `/inbox cancel`.
**No…** (on news, **Dismiss…**) takes a reason
chip or a typed reason of up to 500 characters, which goes to the loop's next run as the terminal's
reason does; with none it is a silent dismiss. **Open the run**, on a finding that names its run,
shows the run's transcript, read-only. A card names its loop only when the list holds more than one
loop's findings.

Claim and dismiss each succeed once, and only on a finding that is still new: two windows, a
window and a shell, or two pages that both listed it get one success between them, and the other
is told the finding was already claimed or dismissed. A yes marks the finding under the inbox's
lock, only once it has found the finding still new, and then queues its answer, so a yes that loses
queues nothing and the answer runs once. If the answer could not be queued, pi-loops queues it on
its next tick. A cancel succeeds only while the answer waits: the answer leaves the queue, then the
finding is `new` again.

Corrupt lines are skipped on read and never deleted: a claim, a dismiss, `/inbox clear` and
rotation write them back as they were, in their place. A line whose id is not `inb-` and 32 hex
digits is one of them. A field that this version does not read is written back as it was, too. The footer shows `Inbox: N new`, with
`(K decisions)` after it when any are checkpoints (the whole machine, as the badge always has), and `N loops failing (<worst> ×<count>)` once a loop has failed
often enough for the scheduler to start backing off; the same clause is on the `[cron] … active
here` line at session start, for this project. Until then a job that has failed forty nights in a
row looked exactly like a healthy one. Entries kept by
the checker carry a `✓`.

## Maker/checker (`--verify`)

With `--verify` (implies
`--stateful`; `--checker-model provider/id` picks another model) the maker's findings do not go to
the inbox directly. A second sub-agent receives the loop goal, the maker's notes and the numbered
findings and is told to assume each may be wrong, stale, duplicated or trivial, verify with tools,
and answer with one `<verdict n="i">keep|drop — reason</verdict>` per finding (plus an optional
`<rewrite n="i">…</rewrite>`).

- Kept findings enter the inbox marked verified, with the checker's reason when it gave one.
- Dropped findings and their reasons go to the run log; `/cron trace <job> <k> checker` shows the checker's transcript.
- Findings without a verdict enter unverified.
- **Fail-open:** if the checker fails or times out, every finding enters the inbox marked unverified. A broken checker must not silence the loop.
- The checker never touches the state spine.

## Restart behavior

Jobs live in `~/.pi/agent/loops/jobs.json` and survive pi restarts. Stateful loops run in one
always-on process ([pi-loops in the background](#pi-loops-in-the-background)), which ticks every 30 seconds. A loop tick that was
missed while pi-loops was not running is fired once when it starts (collapsed, not replayed) unless
`[cron] catch_up = false`; a loop that does not catch up records `missed <time> while pi-loops was
not running (catch-up disabled)`. Plain inject jobs do not catch up unless created with `--catchup`
(`--no-catchup` turns it off for loops), and a missed one records `missed <time> while no pi was
running (catch-up disabled)` in a window, or `while pi-loops was not running` in the background. A run that died with its process is retried on the next tick; at most
`[cron] max_concurrent_runs` (3) run at once. Trigger checks share `[cron] max_concurrent_runs`, so
a server pushing many distinct events cannot open one sub-agent per event.
Jobs run with the model and thinking level recorded
on them (`/cron set <id> --model … --thinking … --timeout …`; `-` clears one: a loop then uses pi's
default, a plain job its conversation's).
`/cron scheduler` shows this window (its pid, and whether its conversation's plain jobs run here),
pi-loops (pid, version, start time), the store and the log. `/cron` marks another conversation's plain
job `open in a terminal`, `in the page`, `in the background`, `paused: <why>`, or `resume it to run` (pi-loops never saw its file), parks it as disabled once that session's file has been
deleted (`/cron gc` removes it), and marks a loop `[orphan: cwd missing]` when its checkout is gone
— disabled half an hour later, since a mount can be late at boot. A job created by a sub-agent
belongs to the session that ran it.

pi-loops runs on one machine. Two machines syncing one `$HOME` would both run every job; that is
not supported (until 0.19.0 a hostname stamp on each job half-handled it, and is now ignored). To
reach a running pi from elsewhere, use the browser front end over your tailnet ([cli.md](cli.md));
the loops keep running where pi runs.

## Time, and which clock it is

**Everything is this machine's clock.** Cron expressions are matched against local time — `0 9 * * *`
is nine in the morning where the machine is, not 09:00 UTC — and there is no per-job timezone. Move
the machine, or change its `TZ`, and the jobs move with it.

Timestamps are written the same way, with the offset that makes them unambiguous — this is what a
machine at `+08:00` writes; yours writes its own:

```json
{"startedAt": "2026-09-11T20:37:59.405+08:00", "finishedAt": "2026-09-11T20:38:12.880+08:00"}
```

That is the same instant `2026-09-11T12:37:59.405Z` names, and anything that parsed one parses the
other — including what earlier versions wrote. The difference is that opening
`runs.jsonl` shows the hour you were at your desk, and it agrees with the `next` on the `/cron` line
that sent you there. `/cron` and `/inbox` say the offset in their header; a timestamp that travels
somewhere without one — into a sub-agent's prompt, into a tool result a model reads — carries its
own.

Two things are deliberately still UTC, because neither is a time anybody reads: the name of a
session file, which cannot hold the `+` and `:` an offset brings, and pi's own session header, whose
format is pi's to decide.

The offset in the run line above is the offset of the machine **at the time it ran**, not a fixed
part of the prompt. A machine's clock is not a constant: `TZ` gets set, a laptop travels, a
container is rebuilt in UTC. A loop's notes are free text the model writes — watermarks,
"everything up to here has been seen" — and a watermark without an offset is a watermark the next
run cannot read once the clock has moved. The prompt asks for the offset for that reason. Notes
written before 0.14.1 do not have it; a loop that keeps a watermark on a machine whose timezone has
changed is worth one look at `/cron state <id>`.

### Daylight saving

Local time means the clock does what the clock does, and twice a year it does something strange.
Measured, not assumed (`America/New_York`, 2026) — and pinned by `test/dst.test.ts`, which sets the
zone it needs rather than reading the one the machine happens to have.

| | what happens |
|---|---|
| Spring forward — `0 2 * * *` on 8 March | 02:00 does not exist that day, so the job **does not run**. It runs again the next day. |
| Fall back — `0 1 * * *` on 1 November | 01:00 happens twice, so the job **runs twice**. |

Vixie cron special-cases both (it runs a skipped job once, and a repeated one once). pi-loops does
not: it matches the wall clock, and the wall clock is what it is. If a job must run exactly once a
day whatever the clock does, `every 24h` is immune — it counts elapsed time and never consults a
calendar.

### `in` and `at`

`every 30m` is an interval: no timezone, no DST, no wall clock at all.

`in 10m` and `at <ISO time>` are resolved **once, when the job is created**, and stored as the
instant they landed on. Changing the machine's timezone afterwards does not move them. Note what
JavaScript does with the text you give `at`, which is the standard's rule rather than ours:

```text
at 2026-09-08T18:00    → 18:00 local
at 2026-09-08T18:00Z   → 18:00 UTC
at 2026-09-08          → midnight UTC   ← a date with no time is UTC, not local
```

Write the time if you mean a time.

## Changing a job in place

```text
/cron set <ref> --prompt "check the CI and report only what changed"
/cron set <ref> --schedule "0 9 * * 1-5"
```

The first version of a loop's prompt is always slightly wrong, and the fix used to be
remove-and-re-add — which mints a new job id and leaves the loop's notes behind at the old
`state/<id>.md`. `--prompt` and `--schedule` edit the job in place, so the id, the notes and the
run history stay. Both values are one token: quote anything with spaces in it. Unlike the pins,
neither takes `-` — a job always has a prompt and a schedule, so `-` would have nothing to fall
back to and is refused rather than silently emptying the prompt (`--prompt "-"`, quoted, is the
literal text). The previous wording goes to the loops log, so a loop that starts behaving
differently can be traced to the edit that caused it.

The new schedule is parsed before it is stored: a typo leaves the job untouched, and so does an
expression that can never match (`0 0 30 2 *`). The confirmation prints the next run time, which is
where a plausible-but-wrong expression shows itself. Changing the schedule does not backfill: a
cron job's clock restarts at the edit, so slots that only exist retroactively under the new
expression are not owed. An `every <dur>` job is still measured from its last run — if it last ran
longer ago than the new interval, it is genuinely overdue and the confirmation says `due now`
instead of promising a later time. One-shots (`in 10m`, `at <ISO>`) are refused here: the scheduler
deletes a `once` job after it fires, notes included, and records the removal in the control-plane
audit like any other.

`/cron run <ref>` fires a job now instead of at its next due time, and that run counts as a run: a
`once` job is fired and then removed (an enabled job with nothing left to fire is worse than none),
an `every <dur>` job's interval restarts from now, and a `cron` job's next run is unchanged — the
expression says when it runs, not the last run. A disabled plain job is refused rather than run: its
prompt would land in whichever chat is open now rather than the one it was written for, and a job the
dead-session sweep turned off has to keep the reason `/cron gc` collects it by. A plain job's `/cron run`
is your own turn: it runs uncapped and goes before anything the clock queued. Left queued when you
quit, it waits for a window, and the job's
schedule goes on in the background as if it were not there.

A project is matched by realpath and containment, so a pi opened in a subdirectory, a worktree or
through a symlink sees and runs that project's automation.

## What it costs, and capping it

`/cron cost [today|7d|all]` adds up the run log by job, and shows today's spend against the budget
if one is set. Every loop run, its checker and every trigger check is counted; so is the `/goal`
evaluator. A project's rule checks are one line, `checks of <project directory>`.

```toml
[limits]
daily_budget_usd = 5.0   # 0 (the default) means no cap
```

Once today's automation has cost that much, nothing more is dispatched: loop runs, plain jobs and
trigger checks stop, the job's `last_error` says so, and the slot stays owed rather than being
skipped, so work resumes when the day rolls over or the cap is raised. The run log is rotated by
size, so what it drops is folded into a small per-day ledger first — a cap that forgot yesterday's
busy morning would stop capping halfway through the day.

The cap is also checked **while a run is in flight**, not only before it is dispatched: a run
admitted at $4.99 of a $5.00 budget would otherwise be free to spend any amount, and three runs
admitted in the same tick would each be free to. A run is measured once per model turn against
today's recorded spend plus everything this process has in flight — its own cost so far, the runs
beside it, and, with `verify = true`, the maker whose findings its checker is reviewing. When that
total reaches the cap the run is stopped the way the run timeout stops one: pi aborts the
sub-session and the run is recorded with what it had spent. Unlike a timeout, a budget stop is treated as an interruption rather
than as a job that failed — the concurrency slot is released, the tick stays owed, the job's
failure streak is untouched and a one-shot is not retired — so the loop simply resumes when the day
rolls over or the cap is raised, held back until then by the check at dispatch.

A stopped run is a failed run in `/cron runs` and `/cron trace`, but never an unexplained one — its
error is the reason, and the reason leads with the cap:

```
FAILED: stopped by today's $5.00 daily budget ($4.62 already spent, $0.41 in flight); raise…
```

The same line lands in the job's `last_error` and in the diagnostics log. A run stopped this way
keeps its transcript, and its findings up to that point are not written to the inbox — the run did
not finish, so its `<loop-state>` and `<inbox>` tags are not trusted.

## Stopping, removing, and jobs that keep failing

`/cron disable --all` pauses every job in this project (`--all-projects` for the machine) and
`/cron enable --all` resumes them. Closing every pi window stops nothing, because pi-loops keeps
running, so this is how you actually go quiet; `/pi-loops stop` pauses every loop and check on the
machine until `/pi-loops start`.

A loop shows `running` while a live process holds the claim on its run's row; the claim is closed
when that process is gone, so there is nothing to release by hand. `/cron clear <ref>` says so.

`/cron remove` takes a name of this project, a number from its listing, or the exact id of a job
anywhere — the rule `cron_remove` follows, because a removal cannot be undone and a name this
project does not have should not reach another checkout. A job removed by its exact id from outside
this project is named with the project it was in.

`/cron remove` keeps the loop's notes (to change a prompt or a schedule, edit the job in place with
`/cron set` instead); `--purge` deletes them. `/cron gc` collects this project's jobs whose session
is gone — `--all` every project's, `--purge` also the loop state and transcripts left behind by jobs that are gone.

A loop run you stop (`pi-loops abort <run-id>`, `/triggers abort <run-id>`, or the page) ends with a
run log record (`runs.jsonl`) that says `aborted` and `stoppedBy: "person"`. The
slot it was running is spent: the loop runs again at its next scheduled time, not on the next
tick. A stop is not a failure, so the run does not count toward `runs` or the failure streak. A
one-shot loop you stop is turned off with `last error: stopped by a person; /cron run <ref> runs it
now`, and keeps its notes. A run stopped by quitting, an upgrade or the daily budget gives its slot
back and runs again on the next tick, as before.

A run that passes its timeout (`--timeout`, default 15m) is a failed run, `timed out after <n>s`:
its slot is spent, it counts toward `runs` and the failure streak, and the loop runs again at its
next scheduled time.

A job that fails three times in a row is not retried at every due tick: it waits 1 minute after
the third failure, then 5 minutes, 30 minutes, 2 hours, and 6 hours from the seventh failure on, and
says so. One success clears the streak. `/cron` says the last failure under the job, with the count
and the next try while the wait holds it back:

```text
    last run failed: 401 Unauthorized (7 in a row; next try 16:10)
```

A time on another day has its date. Under a loop with a note of its clock, `/cron` says `note:
<the note>` (`note: missed 2026-11-14 09:00 while pi-loops was not running (catch-up disabled)`),
and under a loop whose next run waits, `queued since <time>: <why>` (`queued since 09:00: deferred:
3 sub-agent(s) already in flight (max 3)`). Any other word is `last error: <the word>`.
`cron_list` gives the model the same facts as `last_error` (with the count and the next try),
`note` and `queued`, with full stamps.

## Was it worth running

A loop was judged, until now, by whether it ran: `runs 42`, a last error, the failing badge. None
of that says whether anyone wanted what it found. So `/cron` puts two more facts on a loop's lines,
both computed from the run log and the inbox and nothing else:

```text
 3. cron-b91def87c2a04e5f9d3b6a7e1c0f4d28 "pr-watch"  */15 * * * *  [stateful]  [quiet ×12]
    next 2026-09-15 10:15 · runs 412 · 30d: 6 findings · 6 dismissed (4 with a reason)
```

`30d: 6 findings · 6 dismissed` is the last thirty days: findings filed, and of those still in the
inbox, how many a person claimed and how many they dismissed (with how many reasons). A loop whose
findings are all dismissed is noise at any price; one whose findings are all claimed is the one to
keep. `/cron cost` shows the same counts beside each job's spend, for its own window, so
`$0.410  28 run(s)  pr-watch  —  6 findings · 6 dismissed` is a line that answers itself.

`[quiet ×12]` means the twelve newest runs found nothing, whatever the window. A run that reported
only findings that are open already is not quiet: it found them again. It is not a fault —
a watch on a quiet thing is supposed to be quiet — and pi-loops does not slow the job down for it:
the schedule is the schedule. It is the number to read before deciding that a fifteen-minute
watch could be hourly (`/cron set <ref> --schedule "0 * * * *"`), or that the loop is looking at
the wrong thing. `cron_list` gives the model both facts (`signal_30d`, `quiet_streak`), so asking
"which of my loops are worth keeping" gets an answer from the numbers rather than the names.

The page's loop row shows the same numbers, only those that are not zero (`6 findings in 30 days · 6
dismissed · quiet ×12`), and at most one suggestion, which never applies itself:

- **Run hourly instead**, when the quiet streak is at least 12 and the loop runs more often than
  hourly. An `every` loop becomes `every 1h`; a cron loop becomes `0 * * * *`. A cron loop's
  clock restarts at the change, as `/cron set --schedule`'s does; an `every` loop's next run is
  counted from its last run, so one that last ran more than an hour ago runs at the next tick. The
  row says the new schedule and the next run, in the browser's local time.
- **Pause**, when the last thirty days have at least 5 findings and 5 dismissed, and none claimed.

A disabled loop, a plain job, a one-shot or a running loop gets none. Applying one changes the loop
and writes a `cron_control_plane` audit row (`set` for the schedule, `disable` for Pause, source
`page`). `/cron set --schedule` in a terminal writes the same `set` row (source `slash`) in
`triggers-audit.jsonl`; an edit that leaves the schedule alone writes none. **Keep** leaves the loop as it is and
records the answer on the job (`tuneKept`), so the same suggestion is not offered again. The
suggestion is named with the schedule it was made for, so a loop whose schedule changes can get a
new one.

A running loop's row has **Stop this run**, with a confirm in the row; see "Stopping, removing, and
jobs that keep failing" for what a stop does to the loop.

## When something looks wrong

Every diagnostic a pi process produces is written to `logs/pi-<pid>.log` in the loops directory —
jobs that were disabled, writes that failed, sub-agent warnings. `/cron scheduler` prints the path.
pi-loops writes `host.log`; both logs are rotated.

`PI_LOOPS_DEBUG=1` adds a line per tool call, provider retry and compaction to that log, which is
the quickest way to tell a stuck run from a busy one.

`/cron snapshot` writes a `pi_loops_snapshot` entry into the session: which MCP servers connected
and what they exposed, the active tools, the hooks, whether pi-loops is running and its pid, the last
check. One is written automatically whenever that state changes. The TUI panel is not the same:
it lists rules, loops, the latest runs, MCP servers and hooks; it shows no pid, and shows the last
check only when it went wrong. The entry is for a front end that is not a terminal — the browser one in
[src/web.mjs](../src/web.mjs) reads it, and so can anything else that speaks to a session.

`/triggers running` shows how long each run has been going and, for loop runs, the transcript that
is being written right now (`pi --session <file>`), so "is it stuck or is it working" is answerable
before the run ends. A loop's run in the background gets pi's default tools, or exactly the ones its
`--tools` names, plus its own project's MCP servers, and the automation tools it calls act in its
own project.

An unattended run refuses a corpus of dangerous commands: sudo, `curl … | sh`, writing to a block
device, `mkfs`, `chmod 777 /`, shutdown/reboot/halt/poweroff anywhere in the command (after `sudo`,
`systemctl`, `timeout` or `sh -c` too; the exception is a search, described below), `git push --force` on main/master, pipes into
`eval`, the fork bomb, `rm -r -f` aimed at `/`, an absolute path or `$HOME`, and `pi-loops abort`,
`stop` or `restart` as a command (after `env`, `npx`, a path or `sh -c` too, and with a verb the shell
expands, `pi-loops $V`; `git add -A && git commit -m "pi-loops: stop retrying"` only mentions it). The model is told
why and can do the safe part.

A loop's run, a rule check's run and a plain job's turn, in an open window or a closed
conversation, ask you in the inbox instead. The call does
not run, and the inbox gets one question about it, with the command, the reason and **Yes** and
**No**. The run is told `asked a person: <reason>`, and not to wait or to try another way: it
finishes what does not need the call. The loop's next runs see the open questions of their lane in
an `[asked]` block of their prompt. A yes resumes the run that asked, from its transcript, and
lets that one call through once, when its input is the same as the input that was asked about.
A no is told to the loop or the rule on its next run, and the same command is refused for 14 days.
While a yes to a question waits to run or runs, the question stays in the `[asked]` block, and a
later run of its lane that makes the same call is told that a person was asked: no second question
is filed. A question is answered in pi or on the page. `/inbox clear` leaves every question for its
own yes or no, since a no refuses the command for 14 days, and says how many it left. `pi-loops
inbox claim` refuses a question, since a claim from a shell allows no command: it says to answer
it on the page or in pi with `/inbox`, and the question stays new.
For a plain job's turn, the question is in its conversation's lane: a yes runs as a turn in that
conversation, as described below for a yes to a finding of a conversation. The checker and a
`/goal` continuation have nobody to ask, and refuse as before.

While a window has a conversation open, a terminal asks each question of that conversation's lane
in pi's selector when a turn settles (see "A proposed watch" above):

```
Allow this once?
The scheduled prompt "deploy-check" asked to run bash: sudo invocation.
sudo systemctl restart api
It went on without it. Yes runs it once in a new turn. Esc leaves the question open (/inbox).
  No, do not run it
  Yes, run it once
```

Yes prints `queued: your yes to "deploy-check" runs after the current turn`, and the yes runs as a
turn in that window. No prints `said no: "deploy-check" is told in this conversation`. The model
reads the no as a message in the conversation, with the reason when you gave one:

```
[Trigger no-…] The person said no to `sudo systemctl restart api`: not during the release
Do not run it, and do not try another way to do the same thing.
```

Esc leaves the question open for `/inbox` or the page. When another surface answered first, the line says so,
for example `inbox entry inb-… was already dismissed`.

A run cannot answer for a person, because a yes in the inbox lets a dangerous call through. In an
unattended run, a built-in file tool (`read`, `write`, `edit`, `grep`, `find`, `ls`) whose path is
in the loops directory is refused, and nobody is asked: the question could not show what the tool
would read or write. The one exception is a loop's run in its own notes directory,
`state/<id>/` (see "A loop's notes"). A shell command that reaches the loops directory is a question, "reads or
writes pi-loops' own files". The directory that holds the control socket when the path of the
loops directory is too long for a socket, `pi-loops-<uid>` in the temporary directory, counts as
pi-loops' own files too. A question with the reason "answers for a person" comes from these
commands:

- `pi-loops` with a verb that answers or changes state: `inbox claim`, `dismiss`, `cancel` or
  `clear`, `recipe add`, `import` and `start`.
- `pi-loops` with a verb that gives out what signs a browser in to the page: `status --url`, which
  prints the page's token, `pair`, `open`, `web`, `tui`, and `pi-loops` with no verb.
- `pi` itself, with anything but `--version` or `--help`. A pi that a run starts is your session:
  it loads pi-loops, so an `/inbox claim` that it gets as an argument, on its input or in
  `--mode rpc` is your yes, and the tools of its model are not checked.

The same is true behind `env`, `timeout`, `nohup`, `sudo`, `npx` and the like. These rules stop a
model when it types a command that answers for you through one of these known ways. They do not
stop a run that sets out to make a yes another way. A run is a process of your user, and every file
and process of pi-loops belongs to that user too, so such a run can reach them. Your own sandbox is
the boundary for that. A path that the shell builds at run time, or a program that reaches the file or the page another
way, is not caught.

The same boundary holds inside pi: another extension that pi loads runs as you, and the guard
defends you against the model, not against code beside it. As defence in depth, a yes that runs in
an open conversation lets its call through only until the first message in that run that pi-loops
did not hand to pi, such as another extension's message or what you type. After that message, the
call is blocked.

A search for one of the words shutdown, reboot, halt and poweroff is not refused, when the command
is no more than a search: `grep -rn shutdown src/`, `rg -n "halt" src | wc -l`,
`cd src && grep -n halt host.ts`. The command must be one line. Each part of it, between `|`,
`&&`, `||` and `;`, must start with the bare name of one of `grep`, `egrep`, `fgrep`, `rg`, `cat`,
`wc`, `head`, `tail`, `cut`, `tr`, `cd` and `ls`. The line must have no parenthesis, brace,
backtick, `$`, backslash, `<` or `>` (`2>/dev/null` and `2>&1` are permitted), no `&` that runs a
command in the background, and no quote left open. `rg --pre` and `rg --hostname-bin` are refused,
because they run a program. Every other command that has one of the words is refused, also when
the word is only text: `git log --grep=reboot`, `echo reboot`, `grep "reboot()" src`.

## pi-loops in the background

A pi window starts the always-on `node` process on session start and each 30-second tick, and just after
a loop or rule is added, when an enabled loop, enabled rule or relevant MCP push server exists, or a closed conversation
has a plain job or a queued rule result. pi-loops runs stateful loops, dynamic-rule checks, MCP
pushes, and the plain jobs of conversations no window holds. A window runs the plain jobs of the
conversation it holds. pi-loops does not exit when windows open or close. `/pi-loops status` shows
its pid, version, start time, work, held conversations and log. `/pi-loops stop` records a manual
stop; windows do not restart it until `/pi-loops start`, or until `pi-loops` opens the page and
says that loops and rules resume. `[host] auto = false` makes pi-loops run
only while a pi window is open, as 0.22.8 did: the first window starts it, it leaves once the last
window has closed, and nothing runs with none open ([configuration.md](configuration.md#host-auto));
`PI_LOOPS_HOST=off` keeps one process from starting it. While a stop or `PI_LOOPS_HOST=off` keeps pi-loops from running,
nothing it would run runs, and every surface says so instead of promising a schedule: the status line
reads `loops paused: <why>`, `/cron` marks each loop (and each plain job of a closed conversation)
`paused: <why>` with no next run, and the session-start line says this project's loops are paused. When pi-loops cannot start, it is retried after 1, 5
and 30 minutes, with the reason in `/pi-loops status` and `host.log`. If pi-loops crashes, it is restarted by
the next window tick, and one that crashes three times within five minutes is paused (`loops paused:
pi-loops keeps crashing`) for half an hour, then tried again on its own; each pause that follows the
last one at once is twice as long, a day at most, and `/pi-loops start` ends a pause at once. The error
is the first thing `host.log` says about each crash. A loop whose runs keep stopping with pi-loops is
parked after three such runs, each the only run in flight when pi-loops stopped, with the reason in
`/cron`; `/cron enable <id>` tries again. A window replaces pi-loops after three failed control-socket
probes only when pi-loops' heartbeat has stopped as well (SIGTERM, then SIGKILL after 10 seconds); a
pi-loops process that is still ticking but does not answer on its socket is left running and reported as not
answering, and a starting pi-loops process is not killed. A control socket that is removed while pi-loops
runs (an OS temp cleaner, a manual cleanup) is re-bound by pi-loops within the next 30 s tick. A
window with a newer version stops the old process with SIGTERM only when the socket file is not there
and the old process has ticked at least once: the upgrade request can then never arrive. This is not
counted as a crash. When the socket file is there and the old process does not answer in 2 seconds,
the window sends no signal and asks again on its next tick. pi-loops needs node: under bun it uses the `node` on
your PATH.
After a reboot, nothing runs until a pi opens. What pi-loops is doing is the Background view of the browser page, at `http://127.0.0.1:4173/background`;
`pi-loops status --url` prints the page's address with the token ([cli.md](cli.md#the-background-view)).
