# Changelog

All notable changes to pi-loops are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer.

## [Unreleased]

### Added
- **One shape for a finding.** A line of `inbox.jsonl` is now the very object `pi-loops inbox
  --json` prints — the ten fields of [docs/downstream.md](docs/downstream.md) §3, in their order,
  under their names — instead of a third spelling of the same record (`trace_id` for the run id,
  camelCase in memory, keys left out when they were empty). The entry in memory has those names
  too, so both translations are a copy and a subset: nothing is renamed on the way in or out, and
  a field that has to be added is added in one place. Lines written by earlier versions are still
  read, and rewritten in the new shape the next time a claim or a dismiss touches them. `kind` is
  now on every finding (`news` when the text is not a checkpoint) rather than only on checkpoints.
  Keeping pi-loops' own fields — `job_id`, `session_id`, `claimed_by`, `verified_reason`,
  `dismissed_at` — on the same line after the ten is this version's choice, not something the
  interface asks for: they are private state and a program that reads them is reading what it was
  told not to.
- **What a program may depend on.** [docs/downstream.md](docs/downstream.md) is the whole list of
  what a program that is not pi-loops may rely on: a recipe directory, `run_start` / `run_end` in
  `hooks.toml` with their `PI_RUN_*` variables, and `pi-loops inbox list | claim <id> | dismiss <id>
  [--reason <text>] --json` — a new command that does what `/inbox` does with no pi open — and it
  says that nothing else is one: no file under `~/.pi/agent/loops`, no slash command's wording,
  not the browser page. The list is small on purpose: every name on it is a promise never to
  rename or remove, so it holds only what a closed loop needs. That the list is *enough* is
  proved rather than asserted: `test/downstream/fixture-recipe/` is a recipe that uses only it —
  installed from its directory, its run commits a file and files a checkpoint, and its `run_end`
  hook finds that finding by `PI_RUN_ID` and claims it — and `test/downstream/closed-loop.sh`
  checks the file, the commit and the claim from the outside with `sh` and `jq`, importing none
  of this package's code; the model is a loopback stand-in (`npm run check:downstream`, part of
  `npm run ci`). The third item was added for that proof: with only the first two, a hook could
  count a run's findings but neither read nor mark one. A test keeps the page honest the other
  way: every `PI_RUN_*` variable, manifest key and finding field it names must exist in `src/`.
- **A dismiss can say why, and the loop hears it.** `/inbox dismiss <n> <reason>` keeps the
  reason on the entry (`dismiss_reason`, with `dismissed_at`) and puts it in front of the next run
  of the loop that reported the finding, in a `[dismissed]` block between its notes and its task:
  do not report this again unless what it describes has changed, and carry into your notes what
  you need to remember that. Shown to that one run only — the notes are the loop's only memory,
  and a channel the notes cap does not bound would be one it could not edit. Up to eight per run,
  newest kept. A bare dismiss and `/inbox clear` stay silent as before; `/inbox all` shows the
  reason on the dismissed line. Until now the only answer to a finding was to claim it or to say
  nothing, and a loop that misjudged what counts as a finding went on misjudging it every night.
- **`deps-sweeper` recipe.** Mondays at eight: the project's audit and outdated commands, and one
  finding per advisory or major-version gap not already in its notes. Under `propose`, patch and
  minor updates are applied in a worktree, the project's check command run, and a pull request
  opened — one per run, never a major, never a package on the playbook's deny list, and the same
  package attempted twice without a green check is a stop. Eight recipes now ship.
- **Was it worth running.** `/cron` shows, per loop, the last thirty days of findings filed and
  what a person did with them (`30d: 6 findings · 6 dismissed (4 with a reason)`), and marks
  `[quiet ×N]` once the N newest runs found nothing. `/cron cost` puts the same counts beside each
  job's spend. `cron_list` gives the model both (`signal_30d`, `quiet_streak`). Computed from the
  run log and the inbox (`src/job-signal.ts`); nothing is stored and no schedule is changed — a
  quiet watch is supposed to be quiet, and the number is what to read before making it hourly.
- **Every checkpoint says three things.** A finding that asks a person to decide now carries, in
  every packaged playbook, the decision, what waits on it, and what happens if nobody acts
  (`… · waits: your merge · if not: the branch stays; later runs build on it`). docs/recipes.md
  has the shape. News — a merged pull request, a red check — stays as it was.
- **autoresearch looks back.** Five retired experiments in a row since the last kept one is a
  finding asking whether the contract is wrong, and the loop stays out of the idea classes it has
  exhausted; ten in a row stops it until `RESEARCH.md` changes. Before this an hourly loop in the
  wrong search space ran until the budget cap.

- **What a recipe may never do, before it is installed.** `/recipe show` and the install
  confirmation print each playbook's `## Never` section — the safety envelope of an unattended
  run, which until now was read after the install, if at all — with a `tier` line and the
  situations the recipe is for (`useful_when` in the manifest). `/recipe list` shows the eight in
  two groups: three starters that only read and file findings (`daily-digest`, `pr-watch`,
  `changelog-draft`), and the advanced ones that write to a worktree, a tracker or a pull request.
  The four playbooks that kept their prohibitions in the body (`triage`, `implement`, `release`,
  `experiment`) gain the section, with nothing new in it; `/recipe update` carries it into
  installed copies.

- **A recipe is checked against the project before it is installed.** The confirmation ends
  with *Before the first run*: whether `gh` is there and logged in, whether there is an `origin`,
  a CI workflow, a lockfile, whether the tracker is GitHub — each a line with ✓ or ✗ and what the
  miss means for the runs. Nothing blocks the install. A manifest names its checks (`needs`,
  `needs_propose`); a recipe that reads the tracker is checked for `gh` only when the tracker
  description uses it, so a local Markdown tracker is asked for nothing. `/recipe show` prints
  the same lines. Until now the first sign of a missing login was an empty inbox the next morning.

- **The inbox tells a decision from news.** A finding in the checkpoint shape
  (` · waits: … · if not: …`) is stored with `kind: "checkpoint"` when the run's findings are
  appended. `/inbox` lists checkpoints first, marks them `⚑`, and says `3 new, 1 needs a decision`
  in its header; the footer badge and the browser panel say `(1 decision)`. Claiming one tells the
  turn that the claim is the person's approval of the decision the finding recommends, so it is
  carried out rather than investigated again. Entries written before this read as news.

- **Esc pauses the goal.** Stopping a turn with Esc while a `/goal` is pursued pauses the goal —
  appended to the session, so `--resume` finds it paused — until `/goal resume`. Until now the
  aborted turn was merely not judged, and the next message ended with the evaluator sending the
  agent back to work. Esc during an evaluation stopped it before and still does.

### Fixed
- **One archive, one set of answers.** `/session-export` and `pi-loops export`, and
  `/session-import` and `pi-loops import`, decided the same three things twice and had drifted
  apart on all three; each decision now lives once, in `src/archive.ts`. What changes:
  `pi-loops export` follows the session that created a job or rule, the way the slash command
  always has, instead of archiving every loop in the project — including a colleague's, and
  including none of your own reached through a worktree or a symlinked path, which its
  string comparison of directories missed. `/session-import` takes `--activate-triggers=ask` and
  the space-separated `--activate-triggers ask`, both of which it used to refuse. `pi-loops import`
  defaults to `ask` like the slash command (it defaulted to `off`), asks after the import rather
  than before it, with the counts, and rolls a half-written import back — a failed store write
  used to leave the jobs in, the loop state on disk, and a session file nothing pointed at.
- **issue-loop installs on a local Markdown tracker.** Its setup script ran `gh label create`
  whatever the tracker was, so a project with `.scratch/issues/` and no `gh` stopped at "setup
  script failed; no jobs were created". The script now reads `docs/agents/issue-tracker.md`: a
  local tracker has no labels to create and it says so; a GitHub tracker without `gh`, or with
  `gh` not logged in, is told what to run by hand and the install goes on — the first run reports
  what it cannot do. The local tracker description gains the two operations it never named:
  requesting changes (a comment and the status back to `agent-working`) and merging (`git merge`,
  status `done`, file to `closed/`), and the implement playbook reads review feedback from the
  item's comments where there is no pull request.

## [0.20.0] - 2026-09-14

### Added
- **Five more recipes.** `daily-digest` files one finding a morning saying what needs a look —
  open items, a red default branch, a loop that failed its last two runs — or none on a quiet day.
  `pr-watch` gives every open pull request one state and reports only what changed, or a stall
  that lasted another day; under `propose` it may leave one comment per stall. `ci-sweeper` turns
  a red default branch into a finding, or under `propose` a fix in a worktree and a pull request,
  with the failure signature as memory and a stop after two failed attempts. `ecosystem` finds who
  uses or forks the project and drafts the one reply or invitation worth sending, every draft a
  finding a person sends by claiming it, its only level `propose`. `changelog-draft` gains
  `propose`: the entry and the version bump in a release pull request. None of these touch
  `src/`; `test/recipe.test.ts` holds every packaged manifest and playbook to the same rules.

### Fixed
- `@earendil-works/pi-ai` is listed in `peerDependencies`: two files import a type from it, and
  pi's packaging rules ask that every bundled package imported be listed.
- The "escape hatch" front-end test read the fake pi's log unconditionally and failed on runs
  where nothing had reached pi yet — which is the fact it was asserting. A missing log now reads
  as empty.

## [0.19.3] - 2026-09-14

### Fixed
- **Six tabs of the browser front end and nothing you typed was sent** (#14). A browser gives one
  address six connections, and every open tab held one for its event stream — so the sixth tab, or
  a few left behind the first, left nothing for `POST /prompt`: the fetch queued, neither
  succeeding nor failing, the bubble drawn and the message never delivered. A tab now closes its
  stream fifteen seconds after going into the background (`paused in background`) and opens a new
  one when looked at again, polling at once so the seq/epoch check reloads what it missed; the pi
  process behind the page, and its jobs, are not involved either way. And a send that has not
  settled in six seconds says `still sending — if it never lands, close the other tabs of this
  address` instead of looking alive.

## [0.19.2] - 2026-09-14

### Fixed
- **A plain job of another session was promised a next run, could be run into the wrong chat, and
  was called dormant as if that were a fault** (#15). A plain job belongs to the session that
  created it — its result is a message in that conversation — and dispatch has always honoured
  that; the lists did not. `cron_list` printed a `next_run` for a job this process would never
  dispatch (the same class the `[other host]` fix closed for the machine half of the predicate),
  the browser panel showed the time it read from `next-runs.json`, and `/cron run` injected the job
  into whatever chat was open. On 2026-09-14 a daily digest missed its slot exactly this way, and
  the only surface that knew was the terminal's `[dormant …]` marker. Now one predicate
  (`src/job-owner.ts`) answers "does it run here" for dispatch, `/cron`, `cron_list`, the panel and
  `/cron run`: another session lists it as `[session <id> — resume it to run]` with no next run,
  `cron_list` says the same and sets `owner_session` / `asleep`, the panel says what would wake it,
  and `/cron run` refuses it with the same sentence. "Asleep" replaces "dormant" in the vocabulary:
  it is waiting for its conversation, not broken. The `catch_up` description now says when a
  plain job's missed slot is honoured (when its session is next opened); the skill tells the model
  that anything meant to run unattended is a loop. Parking stays what it was and is now documented
  as such: a plain job is disabled once its session's file has been deleted, not before.

## [0.19.1] - 2026-09-14

### Changed
- **`pi-loops sessions` says what a session is, not only which.** It printed the id, the mtime and
  the cwd, so telling two sessions apart meant opening them. It now prints one line a person can
  tell them apart by: the short id, when the session started, the automation it has
  (`[2 cron, 1 trigger]`, `[automation off]`), and what was first said in it — the name it was
  given, or the first message cut at eighty characters, by characters and never inside one.
  `--all` puts the cwd after the id. `src/session-head.ts` reads the head of a session file for
  it; the browser front end's own copy of that reading is unchanged.
- **The session commands are two words in the browser front end.** `/sessions` lists this
  project's sessions in the feed, and `/session export [path]` / `/session import <path>` are the
  archive commands, delivered as `/session-export` / `/session-import`. pi's built-in `/session` is
  a terminal command that does not exist over rpc — that is why the extension's commands are
  hyphenated in the terminal, and why the page can spell them plainly.

## [0.19.0] - 2026-09-14

### Removed
- **The machine, as a concept.** Every job and rule used to carry the hostname that created it;
  another machine sharing the `$HOME` ignored it and listed it as `[other host: <name>]`,
  `/cron set <ref> --host here|-` and `/triggers set --host` re-homed it, `cron_list` printed
  `other_host:`, the leader and next-runs files were named `scheduler.<host>.json` and
  `next-runs.<host>.json`, and an imported archive was re-stamped for the importing machine. None
  of it matches the way pi-loops is used: pi runs on one machine, the loops run
  there, and a phone or a laptop reaches the browser front end over a tailnet without moving the
  execution anywhere. All of it is gone. A `host` field an older build left in `jobs.json`,
  `triggers.json` or a `.pisession` archive is ignored when read and dropped on the next write; the
  leader file is `scheduler.json`, the next-runs file `next-runs.json`. Two machines syncing one
  `$HOME` now both run every job — not supported, and said so rather than half-handled
  (`docs/design.md` §19). "Host" means one thing here now: the headless process.

## [0.18.0] - 2026-09-14

### Added
- **Recipes: a project run on loops, installed in one command.** A recipe is a directory —
  `recipe.toml`, one playbook per job, an optional setup script — and `/recipe add <name>` installs
  it into the open project: one question (the autonomy level, `report` / `propose` / `act`, written
  as the first line of each playbook), one confirmation showing every file, the setup script and
  every `/cron add` line, then the jobs through the same code path `/cron add` uses. The playbooks
  are copied to `.agents/skills/<name>/` — where pi also discovers them as `/skill:` commands — and
  the directory is listed in `.git/info/exclude`, so the repository is untouched; a job's prompt is
  a pointer to its playbook, read fresh on every run, so editing the file changes the next run.
  `/recipe update` is a three-way merge against the untouched copy kept at install (under `.orig/`), and a conflict
  is handed to the agent to resolve with you rather than left as markers in a file a loop would
  follow. `/recipe remove` takes the jobs and leaves the files unless `--purge`. Each `[[job]]` in a
  manifest is validated by building the `/cron add` line it stands for and parsing it with the same
  parser. The one step no template can do — describing this project's tracker — is handed to the
  session with the prompt in `recipes/_tracker-setup.md`, the way `/inbox claim` hands over a
  finding, written to `docs/agents/issue-tracker.md` in the layout Matt Pocock's engineering
  skills use and excluded from the repository like the playbooks — and the wizard resumes on its
  own once that turn ends with the file in place. `pi-loops recipe list|show|add` in a shell does the deterministic part and stops
  before the setup script and the jobs. `docs/recipes.md`; vocabulary in `CONTEXT.md`, decisions in
  `docs/design.md` §15–18.
- **Two recipes.** `issue-loop`: the tracker as a state machine (Matt Pocock's five triage states
  plus `agent-working`, `in-review`, `agent-blocked`) that two loops turn, a triage loop that
  reproduces, checks `.out-of-scope/` and writes agent briefs, and an implement loop that claims
  one issue per run, builds it in a worktree and opens the pull request; a person promotes and
  merges. `autoresearch`: one experiment per run against a `RESEARCH.md` contract you wrote, a
  `results.tsv` ledger where retired ideas stay as negative evidence, a worktree per experiment,
  and promotion only when the `--verify` checker has re-run the held-out command itself; with a
  pure-Python exact k-NN example whose baseline is a speedup of 1.0. `changelog-draft` is packaged
  as the release-side half of the issue loop.

### Fixed
- **The browser front end reported a slash command as timed out while it waited in a dialog.** A
  `/…` prompt is answered by pi when the command has finished, and a command that shows a setup
  script and asks for a yes finishes when the person answers; sixty seconds later the feed said
  `timed out after 60000ms` and the install went on to succeed. A slash command now gets fifteen
  minutes; everything else keeps sixty seconds.

## [0.17.6] - 2026-09-14

### Added
- **A pi version floor, and a refusal that names it.** pi-loops needs pi ≥ 0.84.3 — found by
  type-checking `src/` against older releases: 0.80.8 fails on `ctx.thinkingLevel` and
  `session_compact_failed`, 0.84.3 passes clean — and nothing said so. `peerDependencies` is `*`
  because pi's docs ask for that and pi installs with `--legacy-peer-deps`, which reads no range
  anyway; so on an older pi the first sign was a link error, "does not provide an export named
  ModelRuntime", from which nobody could read "your pi is too old". The manifest now points at
  `src/extension-entry.ts`, which imports nothing pi has not exported for a long time, reads
  pi's `VERSION` against `PI_MIN_VERSION` in `src/pi-floor.ts`, and only then imports the
  extension; an old pi prints `pi-loops needs pi 0.84.3 or newer and this is pi 0.80.8: upgrade pi`.
  Both READMEs state the floor and a test keeps them, the manifest and the code on one number.

## [0.17.5] - 2026-09-14

### Fixed
- **`/pi-loops install-launcher` ignored `--dir`, and asked about a directory it was not going to
  use.** Found by following the README, which says either route takes `--dir <dir>`: the
  command-line `install-launcher` did, the one inside pi called `installLauncher(undefined)` and
  showed a confirmation naming `~/.local/bin` whatever it was about to do. Answering yes to that
  question, with a launcher you already rely on in `~/.local/bin`, replaced it. The slash command now
  reads `--dir` (quoted, or starting with a `~` that no shell expanded on the way in) and the
  question names the absolute directory that will be written, which is then the one written — and says when that directory is not on your PATH instead
  of promising that `pi-loops` will work from anywhere. With nowhere to write it asks nothing and
  prints the refusal, which already explains `--dir`. The menu shows the flag.
- **The browser window used `~/.pi/agent/loops` even when pi's agent directory was somewhere else.**
  `PI_CODING_AGENT_DIR` moves everything pi keeps and the extension follows it; the launcher and
  `web.mjs` did not. With the variable set, the page's token, its automation panel and the
  `ui.json` holding the model you pick all lived in the default directory while the session behind
  the page wrote to the moved one — so the page opened on another setup's remembered model (a
  `Model "…" not found` warning, in the case that found it) and picking a model overwrote that
  setup's choice. Both now resolve the directory the way the extension does, `~` included.
  `PI_LOOPS_DIR` and `--loops-dir` still come first.

## [0.17.4] - 2026-09-14

### Added
- **pi-loops is on npm, and the documents say so.** `@alphacoder-v0/pi-loops` was published at
  0.17.3, installed from the registry into a clean directory, its `pi-loops` bin run from that
  `node_modules` layout, and loaded with `pi -e npm:@alphacoder-v0/pi-loops` before anything here
  changed. `piLoops.publishedToNpm` is now `true`, which is the one line `check:docs` was waiting
  for, and both READMEs lead with `pi install npm:@alphacoder-v0/pi-loops` — without a version,
  because pi treats an npm spec without an exact version as one `pi update --extensions` moves, and
  that is what someone who did not ask for a pin wants. GitHub stays the pinned route. The launcher
  instructions, the upgrade notes, the uninstall line and `docs/troubleshooting.md` name the npm
  install beside the git one.

### Fixed
- **`pi-loops upgrade` pinned an npm install that was following releases.** It answered every npm
  copy with `npm:<name>@<version>`, and pi skips an exact version in every later
  `pi update --extensions` — so the first upgrade of a bare install would also have been the last one
  anything but `upgrade` ever did. It now reads the entry pi recorded in the `settings.json` beside
  the install root (`~/.pi/agent/settings.json` for `~/.pi/agent/npm`, `.pi/settings.json` for a
  project's `.pi/npm`): an exact pin stays a pin, moved to the new version; a bare name, `@latest` or
  a range gets `npm:<name>@latest`. Not the bare name, which reads as the obvious answer and is wrong:
  over an existing install, `npm install <name>` keeps the range it saved the first time and installs
  nothing, so `upgrade` would have printed "upgraded" over the version it started from — checked
  against npm itself, not assumed. With no entry to read, it pins, as before. The unknown-command hint
  names the same spec.

## [0.17.3] - 2026-09-13

### Fixed
- **The `/cron` and `/triggers` subcommand menus named some of what exists.** `/cron`'s one-line
  menu — the thing printed when you get the command wrong — listed fourteen subcommands and left
  out `set`, `clear`, `cost`, `gc` and `host`; `/cron help` covered everything except `snapshot`;
  `/triggers` had lost `hooks` and `panel` from its menu *and* its completions, and its `set` clause
  showed three of the four flags the command takes. `/inbox`'s menu had lost `list`. None of this is
  cosmetic: a subcommand missing from every list a person can read is a subcommand nobody finds. The
  menus now name every subcommand and nothing but; because five more names and their argument
  spellings do not fit on a line a notification can show, the menus name the subcommands and
  `<command> help` holds the arguments, which the menus say. `/triggers` had no help behind its
  usage line — `/triggers help` printed the line itself — so it now has a real one (`TRIGGERS_HELP`,
  the shape `/cron help` and `/inbox help` already had), with the argument spellings that used to be
  crammed into the menu and the ones that were never written down anywhere: `hooks`, `panel`,
  `set --host`, `audit --all`, `enable|disable --all-projects`.
- **A test holds all three lists to the dispatcher.** `test/command-names.test.ts` reads the `case`
  labels out of each `switch (sub)` in `src/pi-loops.ts` and asserts that every non-alias subcommand
  is named in the menu, spelled in the help text and offered in the completions — with the aliases
  (`ls`, `status`, `resume`, `pause`, `rm`, `delete`, the bare command) declared once as deliberate
  omissions. Adding a `case` now fails the suite until every list that claims to describe the
  command is updated. The three lists had drifted because nothing had ever compared them.

## [0.17.2] - 2026-09-12

### Fixed
- **`cron_remove` told the agent that removal destroys notes it keeps.** Its tool description ended
  "Removal also deletes the job's saved notes and transcripts", and the tool calls `store.remove`
  with no `purge`, which deletes neither. That string is what the agent repeats to you in the
  sentence before it asks you to confirm, so it frightened anyone who wanted their loop's
  accumulated notes and misled anyone who wanted them gone — the state file and the whole run
  transcript directory were still on disk under an id nothing schedules any more. The description
  now says what removal actually costs and names `/cron gc --purge`, and the tool's own answer says
  it too, with the state path in `details` where a tool puts a path. The comment explaining why the
  confirmation gate exists carried the same error and now says what the gate is really about: what
  stops running, not what is destroyed.
- **`/cron add`'s usage line advertised one flag out of thirteen.** It is printed when you get the
  command wrong, which is the moment you most need to know what exists, and it named only
  `--stateful`. It now also names `--verify` — the other flag that decides what kind of job this is
  rather than what it runs with, and the other one `/cron set` cannot change afterwards — and points
  at `/cron help` for the rest. A test holds the line to the parser, so a flag added later forces a
  decision about whether it belongs there.

### Added
- **`npm run check:docs`, because nothing in CI read a README.** That is how 0.17.0 was tagged green
  with an install line that answered 404. The check reads every install command in every tracked
  Markdown file back against `package.json`: the pinned tag must be this version, the repository and
  package name must be the ones declared, and a route may only be advertised if the project offers
  it — `piLoops.publishedToNpm` is the single place that says whether npm is a route yet, so the day
  this is published is a one-line change and the check then stops failing rather than needing a
  rewrite. Only fenced blocks count, so prose about pi's own layout (`docs/cli.md` explaining where
  `pi install npm:` packages land) and the changelog's own history stay free. It fails if it finds no
  install commands at all, because a check over nothing is not a check.

## [0.17.1] - 2026-09-12

### Fixed
- **The install instructions named a package that is not on npm.** 0.17.0 was cut with an npm
  release ready to go and the documents written as though it had happened: both READMEs led their
  install block with `pi install npm:@alphacoder-v0/pi-loops`, the uninstall lines named the npm
  package, and `docs/troubleshooting.md` used it as its example. The publish did not happen, so that
  command answers 404 and the first thing a reader was told to do could not work. GitHub is the
  install route — `pi install git:github.com/alphacoder-v0/pi-loops@<tag>`, a local checkout, or
  `pi -e` for one run — and the documents say only that. The code that reaches an npm layout is
  correct and stays: it is tested, and it is what the scope is reserved for.

## [0.17.0] - 2026-09-12

### Changed
- **The package is named `@alphacoder-v0/pi-loops`.** The unscoped `pi-loops` on npm is someone
  else's package, so this one takes a scope of its own rather than a name that would collide — the
  scope is reserved, deliberately, for the day this is published. That day is not today: nothing is
  on npm, and `pi install git:github.com/alphacoder-v0/pi-loops@<tag>` remains the way in. Only the
  package name moved: the command is still `pi-loops` and the data still lives in
  `~/.pi/agent/loops/`.

### Fixed
- **Nothing with a command line worked from an npm install: `pi-loops` and the headless host both
  died on their first import.** Node strips TypeScript types itself, which is how this package gets
  to have no build step — but it refuses to do it for files under `node_modules`
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), and `pi install npm:@alphacoder-v0/pi-loops` puts
  the package exactly there. The extension was fine the whole time (pi loads extensions through
  jiti); it was the launcher, `install-launcher`, `upgrade`, `host status`, `export` and `import`
  that were dead, and the host the last pi hands the clock to that could never start. Both entry
  points now ask the path whether Node can strip it and, when it cannot, load the same sources
  through the jiti that ships inside pi's own install — pi is already a peer dependency, so this
  installs nothing and the "no runtime dependencies" rule holds. When that jiti is missing too, the
  message says which pi was looked for and where, instead of a stack trace naming the wrong problem.
- **`pi-loops upgrade` handed every copy a `git:` spec, whatever it had been installed from.** A
  `pi install` with the other source replaces nothing — it adds a *second* package, both copies
  register `cron_create` and the rest, and pi refuses to load the second one and exits with
  `Tool "cron_create" conflicts with …`. That is exactly the failure both READMEs and
  `docs/troubleshooting.md` warn about, and a copy that came from anywhere but a `git:` tag walked
  into it by doing nothing except upgrading. `upgrade` now reads pi's install layout to see where
  this copy actually came from and offers the matching spec: `npm:@alphacoder-v0/pi-loops@<version>`
  for an npm install (npm knows the release `v0.17.0` as `0.17.0`), `git:<host>/<owner>/<repo>@<tag>`
  for a git one, and for a local checkout no install at all — that copy has a remote, so it is told
  to `git pull` and restart pi. The hint printed for an unknown command follows the same rule, for
  the same reason.

## [0.16.0] - 2026-09-12

### Removed
- **The compatibility paths for this project's older names are gone.** Each existed so a config or
  an archive written against an older name would keep working — but two spellings of one thing make
  the current one look optional, and a reader cannot tell which is which. These are breaking changes,
  removed on purpose:
  - The second archive format `import` accepted. `import` reads `.pisession` archives only; anything
    else is refused as `unsupported archive schema …` rather than half-salvaged, and the summary no
    longer carries a flag for the case where a transcript could not come across.
  - `cwd = "pie"` in `hooks.toml`. The values are `project | loops | home`; `loops` is that same
    directory, and a hook that still says the old name is skipped with that diagnostic rather than
    run somewhere unexpected.
  - The `.pie/` project directory. `hooks.toml` and `mcp.toml` are read from `<project>/.pi/` and
    nowhere else, so a project still carrying the other one needs the file moved.
  - The `PIE_*` hook environment variables and `PIE_ALLOW_PROJECT_HOOKS`. A hook command is handed
    `PI_*` only, and the flag is read from `PI_ALLOW_PROJECT_HOOKS`.
  - The MCP notification fields `pie_dedup_key` and `pie_summary`, and both top-level forms,
    `_pi_dedup_key` included. A custom notification's idempotency key is read from
    `_meta.pi_dedup_key` and its summary from `_meta.pi_summary`; the message a dropped push produces
    names exactly the one field it wanted (`missing _meta.pi_dedup_key`).

### Fixed
- **Scheduling and triggers.**
  - Trigger check transcripts were never pruned: they are written under `triggers-<project>` and the
    prune asked for `triggers/<project>`, a directory that does not exist — so it found nothing to
    delete and silently kept every check ever run. Pruned where they are written now, 40 per project
    as the docs promise — and per project really means per project: the key was the directory's
    basename, so `~/a/web` and `~/b/web` shared one budget of 40 and each project's prune deleted the
    other's evidence. It is `triggers-<project>-<hash of its path>` now.
  - A cron expression that parses and never matches (`0 0 30 2 *`) cost about 300 ms of every
    30-second tick, in every open window: the scan walked five years of minutes to conclude nothing.
    It skips by the day now, on the same vixie-cron rule the match uses, and `/cron add` refuses an
    expression with no next run (`… has no next run`), which `/cron set` has always done. `import`
    refuses one too: an archive is somebody else's file, and it was the one way in that still
    installed a job nothing would ever fire.
  - `/cron run` on a plain job was a second copy of what the timer does, and it had drifted: a
    one-shot was not retired, `lastDueAt` and `lastCompletedAt` were not written, `lastError` was
    never cleared. One function does both now, headless-host guard included — and `/cron run`
    reports what it did rather than only whether the job was busy: a disabled plain job is refused
    (its prompt would land in whichever chat is open now, not the one it was written for), and so is a
    job on the headless host, which has no chat to inject into. Running one used to clear `lastError`,
    which for a job the dead-session sweep parked is the marker `/cron gc` collects it by — leaving a
    job nothing could fire and nothing could collect.
  - `next-runs.<host>.json` listed jobs pinned to other machines — a next run this host will never
    dispatch. It is filtered the way dispatch filters, and so is `cron_list`, which promised a model a
    `next_run` for another machine's job while `/cron` said `[other host: …]` with none.
  - A job created with no session project of its own — the headless host, `--no-session` — needs an
    absolute `cwd`, and says so. A relative one was resolved against the process's own directory,
    which for the host is `$HOME`: a sub-agent's `cron_create {cwd: "code/piz"}` silently pinned the
    job to a real, unrelated project. (Before that it doubled the segment: `cwd: "sub"` ran in
    `<process cwd>/sub/sub`.)
  - One trigger delivery could write its audit rows under two different projects, splitting a trace,
    when the session's directory moved during a check that takes minutes; the project is resolved
    once per delivery. And a check could pair one rule's model with another rule's thinking level —
    a budget the model does not have. Both now come from the first rule that recorded a model.
- **Logs.** A log over 2 MB in a single line was rewritten identical for ever — `slice(-0)` is the
  whole array — so every later write paid a full read and write of it. It carries the guard the run
  log and the inbox carry. One log line is capped at 4000 characters, the bound a hook's output has:
  the text is usually something else's stdout, and an unbounded diagnostic is how a log becomes one
  line in the first place.
- **Locks and paths.**
  - `withFileLock` could spin at 100 % of a core forever on a lock path that exists for `mkdir` and
    not for `stat` — a dangling symlink is how that happens — because the deadline was only checked
    on the branch that could read the lock's age. It times out and says so, like its synchronous
    sibling.
  - A checkout under a path containing a space or a `#` reported version `0.0.0` in every manifest,
    log line and `/pi-loops` output: a file URL's `pathname` is percent-encoded, so no package.json
    was read and the fallback is silent. `fileURLToPath` now.
  - A run with `--cwd ./sub`, in a worktree, or through a symlinked path inside the project this pi
    has open was treated as another project: a spurious "project MCP config … ignored" and a second
    copy of servers this process already runs.
  - `realpathish` (`src/paths.ts`) is the one answer to "what path is this, really". Presence and the
    sub-agent runner had one each, and they agreed only about paths that exist — which a job's cwd
    often does not yet, so the two could call one pair of directories the same project and two.
- **The headless host.**
  - `PI_LOOPS_HOST_THINKING` is validated instead of cast into every model call: an unknown level is
    dropped with a line naming the ones that exist, rather than being first heard about from a
    provider refusing it. Every other way in is checked the same way, against the same list
    (`src/thinking.ts`): `/cron add --thinking`, `/cron set --thinking` and `/triggers set --thinking`
    refuse a level that does not exist — `--thinking hgih` was stored as typed and only surfaced hours
    later, as a failed run.
  - The host re-resolves its default model every minute, so a credential or provider added after the
    hand-off reaches a process that can live for days. It was resolved once, at startup.
  - An error introduced by editing `config.toml` while the host is up reaches its log. The host
    re-reads the file every minute and reported nothing, so the setting fell back to its default for
    the rest of a process that can live for days. Each new error is logged once.
  - `host status` reads each store once for the whole snapshot. `jobs.json` was read four times, so a
    tick landing in between could have `enabled` counted against one version of the file and `total`
    against another — a status line contradicting itself.
- **The browser front end.**
  - **Ctrl-C in the terminal that started the session now ends it the way `/quit` does, hand-off
    included.** pi handles SIGTERM and SIGHUP and has no handler for SIGINT, and a terminal's Ctrl-C
    goes to every process in the foreground group — so pi died of that SIGINT instantly, before the
    front end could ask it to quit: no headless host, no line saying so, automation simply off, by the
    most ordinary way there is to stop a program. pi is started in a process group of its own now, so
    the only signal it gets is the SIGTERM the front end sends it, and the front end waits (up to 15
    seconds) for pi to finish quitting — which is what puts "handed the clock to a background host" in
    front of the person who pressed the key.
  - **And that line now actually reaches the terminal.** pi-loops announces the hand-off through
    `ctx.ui.notify`, and `ctx.hasUI` is true in rpc mode — pi binds a real UI context there whose
    `notify` is an event on stdout — so the note was addressed to the page, and the page's server is
    the process on its way out. pi did hand the clock over, `host status` showed the host, and the
    terminal said `pi exited (143)` and nothing else: automation running somewhere the person who
    stopped the session was never told about. A notification arriving while pi quits is relayed to the
    terminal, and when none does (rpc mode does not flush stdout on SIGTERM) the loops directory is
    read the way `pi-loops host status` reads it: `automation handed to a background host (pid N);
    pi-loops host status | stop`, or `no background host started; automation is not running — see
    <loops dir>/host.log`, or `[host] auto = false: automation stops with this pi` — and nothing at
    all when there was no loop or rule for a host to keep running.
  - A slash command that takes no argument runs on one Enter. Typing `/inbox` and pressing Enter
    accepted the completion it was already equal to, added a space, and sent nothing; a second Enter
    was needed, where a terminal runs it on the first. Enter now sends when there is nothing left to
    complete, and still completes a prefix that is genuinely shorter. Tab only ever inserts.
  - The model picker shows the model in use even when pi's catalog does not have it. pi lists only
    providers you have credentials for, and a session can be running on one you do not —
    `--model deepseek` resolving to a gateway that will not authenticate — so nothing matched and
    the picker was blank beside a panel naming the model, which reads as "no model". It is listed
    under its own provider, marked as not in the catalog.
  - **Going back to a session puts it back on the model it was last using.** A `--model` on the launch
    command line — yours, or the one the launcher adds from the model you last chose — lasts as long
    as the process, not the session: pi re-resolves it every time the session inside the process is
    replaced. So resuming a conversation had with one model landed it on a different one, which is
    what a fresh `pi --resume` would never do. A model whose credentials have since gone is reported
    in the terminal rather than forced.
  - A clear or a resume logged `session start:` twice, three milliseconds apart — and ran the whole
    start twice: two MCP source starts, two hook loads, two attempts to take the clock back from the
    headless host. pi rebinds the extensions to a replaced session twice in rpc mode and re-emits the
    session's start event on each bind; a start is now a start until its shutdown, which pi emits
    once.
  - `/rpc` is the escape hatch for what has no route, and it now refuses the commands that do have
    one. Posting `switch_session` through it skipped the mid-turn refusal, the same-session check, the
    "one of this project's sessions" allowlist, and the epoch, backlog and pending-dialog reset a swap
    owes every attached browser. `cycle_model` and `cycle_thinking_level` are refused for the same
    reason (`/model` and `/thinking` refresh the catalog and remember the choice), and `new_session`
    and `clone` outright: both replace the session every browser is watching, with no route to do any
    of that resetting and nothing on the page to notice it. The routes that only read — `/state`,
    `/history`, `/stats` — answer GET and nothing else.
  - pi's dying words are redacted and *then* cut to their last 4000 characters before they are
    broadcast. A provider that refuses to authenticate prints the key it was refused with, so the one
    event whose whole purpose is to explain a failure was the one that could carry a credential — and
    cutting first meant a key straddling the boundary lost the prefix its pattern starts at, so
    nothing matched and the rest of it went out.
  - Everything the panel draws from disk or from pi goes through `plain()` as well as escaping — a
    job's name, schedule and error, a rule's condition and action, an MCP server's name, state and
    last error, a dialog's title, the goal and meta lines, a detail list. Escaping does nothing about
    a bidi override, which makes one line read as another.
  - A pairing guess spends one of twenty tries, so a browser that is already signed in is recognised
    as signed in first: reloading a bookmark that still carried an old `?pair=` burned a try the phone
    across the room needed, and spent the one-shot launcher key the same way.
  - Undo goes through `resync`, the one path that empties the feed. Its own copy left the sequence
    number and the epoch pointing at a transcript it had just replaced, dropped whatever arrived while
    it was reading, and never showed the empty state — so undoing the only message in a session left
    one grey sentence on a blank screen.
  - Unanswered dialogs are bounded at 50 and only one is on the screen at a time; an abandoned one was
    offered again to every browser that attached, every eight seconds, for as long as the process lived.
  - A failed request always yields a value: `api()` catches, so the fire-and-forget callers read
    `success` and `error` whether the request failed at the server or never left the browser.
  - The panel counts jobs and rules apart, each line naming the command that lists them (`/cron all`,
    `/triggers rules --all`). They were added together, and one number covering both agreed with
    neither command — in a line whose whole job is to send someone to the command.
  - `/CLEAR` from a stale tab is recognised as the command the page implements and answered with
    "reload", instead of being told it is not a command at all.
  - An image the page cannot render is refused, with the same visible notice the ten-image cap uses,
    rather than relabelled: a pasted SVG or TIFF went out as `image/png` — bytes claiming to be
    something they are not — and the only sign of it was a broken thumbnail. PNG, JPEG, GIF, WebP and
    AVIF, the same five however the image arrived.
  - Three caps say what they cut, through one helper: a tool result, an extension's message and pi's
    stderr reported it three different ways, and one not at all — a result that stopped at 8000
    characters looked like a result that ended there.
  - `--port` is refused out loud when it is not a number from 0 to 65535, and when it has no value at
    all; `--port 41773x` and a bare `--port` both served 4173 instead, so the address in the terminal
    was not the one asked for. `--allow-host` is listed in
    `--help`: a flag that relaxes a security check and is not documented cannot be audited.
- The project this session is open in is trusted for unattended runs, and so is what is inside it —
  never what is outside it. The test was symmetric, and blocked only `/` and `$HOME`, so an *ancestor*
  counted as the same project: `cron_create` takes a model-chosen `cwd` with no confirmation, and
  `cwd: ".."` would have had the parent directory's `.pi/extensions` and `.pi/mcp.toml` loaded in a
  run nobody was watching. Scoping a list is a separate question and still answers symmetrically:
  showing a job is not running one.
- `/session-share`'s header count and the count in the confirmation you approve are the same number —
  the rendered one. They differed exactly when the transcript held a message of a shape the renderer
  skips.
- `/triggers status` counted this process's two local sources as connected on a pi that is on
  standby, in the same breath as the enumeration below it calling them `standby`.

### Changed
- **The scheduler says which of its diagnostics are routine.** `log` takes a level, and only the
  scheduler knows whether taking the timer over is bookkeeping or a job being disabled is a problem.
  The extension was recovering that with a regex over the wording of the lines themselves, so
  rewording one silently changed how loudly it was reported. No level means `warning`: a line that
  does not say it is routine is not.
- `onInject` hands over the run id it minted, rather than leaving the caller to read it back out of
  the `[Trigger …]` prefix it had just formatted.
- Five things that existed twice now exist once: `backoffWaitMs` (`src/schedule.ts`), shared by loop
  runs and trigger checks because docs/triggers.md promises they are the same numbers; `hostFileTag`,
  the hostname as one filename component; `rotateInPlace`, so the headless host's log follows the
  same "halve it at 2 MB" rule as every other log instead of carrying its own copy; `jobTextOf`,
  which knows the two prompt literals the transcript view was matching on its own; and `realpathish`.
- Two decisions moved out of the extension entry file, which nothing can import and nothing can test:
  which loops count as failing and the badge line that says so (`src/job-health.ts`), and what change
  deserves a permanent snapshot entry in the session (`src/snapshot.ts`). Both have tests now.
- `envFlag` reads the current name and nothing else: `1` or `true`, either case, anything else off.

### Documented
- **The sentences that stopped mid-thought are whole.** `docs/mcp.md` opened with one that ended at
  "that is"; `docs/loops.md` had four (the prompt-shape sentence, the sub-agent ownership one, a
  budget paragraph still comparing this project with another, and `/cron gc` explained twice); and
  `docs/triggers.md` two (the cycle-suppression bound and the shape a promotion is inserted in).
- **The values that were wrong.** Check transcripts live in `sessions/triggers-<project>/`, one
  directory per project, 40 kept each. An MCP server is reconnected up to 20 times and then left to
  the next pi (the Chinese README said the retry was unlimited). A trigger check draws on
  `[cron] max_concurrent_runs`, shared with loop runs, not a cap of its own. An archive is
  `pi-session-<first 16 characters of the id>.pisession`. There are two pipelines and a goal
  evaluator sharing one sub-agent pool, not three or four. `daily` means 09:00 local and `@daily`
  means midnight — in `docs/loops.md` and in the skill, which is what writes the job. A job whose
  checkout is gone is marked at once and disabled half an hour later, because a mount can be late at
  boot. The inbox drops its oldest already-triaged entries past 1 MB and never anything still new.
  The prompt quoted in the Chinese README is the one the code composes. `/goal`'s statuses include
  `cleared`. The panel always draws `Hooks` and `Runtime` while its other sections hide when empty.
  And both READMEs list `pi-loops sessions` and `pi-loops inspect`, which they did not mention.
  `/cron run` does not leave a schedule untouched, and no longer claims to: a `once` job is fired and
  removed, an `every` job's interval restarts from now, a `cron` job's next run is unchanged, and a
  disabled plain job is refused. One dynamic check evaluates every rule of a project, so it runs under
  one model — the first rule that recorded one, paired with that rule's thinking level — rather than
  each rule under its own, which `docs/triggers.md` had implied. And the Chinese README's `reconnect`
  sample says which number is the example (10) and which is the default (20).
- **What had drifted into the wrong section moved back.** `docs/loops.md` gains a section for
  stopping, removing and jobs that keep failing, holding the three paragraphs that had settled into
  the budget and timeout sections. `docs/hooks.md`'s host trust requirement is its own bullet rather
  than a tail on the one about draining. `docs/mcp.md`'s repeated-`[[server]]` rule is no longer
  inside the paragraph about which process evaluates a push. `README.zh-CN.md`'s `/goal` lines sit
  with `/goal` instead of in the middle of `/cron`'s. `examples/README.md` drops a note announcing a
  file move that happened releases ago.
- **`docs/web-ui-parity.md` describes the boundary the code actually keeps.** A preview is anchored
  in the session's directory *and* in `$HOME`, for the types one only looks at, which is where an
  agent leaves something it made for a person; and "image bytes never appear in any event" was never
  true — a message's own image blocks travel with it and the page renders them, and what needed
  redacting was the stderr tail. New lines for `--allow-host`, `--port`, `/rpc` keeping every route's
  guards, the read-only routes, the order the pairing check runs in, the bounded dialog list, the
  three caps and the empty state after an undo, each naming the test that holds it.
- `docs/troubleshooting.md`: a second front end on `--port <n>` does not sign the browser out. The
  token is the one file both read, and a cookie is not scoped to a port — `localhost:4173` and
  `localhost:4180` are one site to a browser, which is the fact the `Sec-Fetch-Site` check is built
  around.
- `AGENTS.md` and `README.zh-CN.md` list `src/job-health.ts`, `src/paths.ts` and `src/snapshot.ts`;
  `docs/configuration.md` documents `--loop` and `--inject`, which `/cron add` has always accepted.
- A doc comment sitting above the wrong declaration, in twenty places across `src/` — the lock's
  synchronous sibling, `parseSchedule`, `computeDue`, `withinProject`, `resolveRuleRef`,
  `createLoopJob`, `mcpToolDefinitions`, `renderHostSnapshot`, `isInsideDir`, the trigger card, the
  tool-call row, the rule for a path written as a code span, and the rest — each moved onto the thing
  it describes, or deleted where what it described has since grown a better one of its own. A comment
  attached to the wrong function is worse than none: it is read as true.

## [0.15.0] - 2026-09-12

### Changed
- **The name a server author has to get right is this project's own.** A custom MCP notification
  needs an idempotency key, and that field was documented as `_meta.pie_dedup_key` with
  `pi_dedup_key` mentioned as an alternative — so the one thing a server must spell correctly
  carried a prefix that is not this package's own, and the message a dropped push produced
  (`missing _meta.pie_dedup_key`) taught it to the next person. `pi_dedup_key` and `pi_summary` are the
  documented names now, are read first, and are what that message quotes. `pie_dedup_key`,
  `pie_summary` and the `_pie_`-prefixed top-level forms are still read, with a test pinning it, so
  a server already sending them keeps being understood.
- **An on/off environment variable is read the same way everywhere.** `PI_ALLOW_PROJECT_HOOKS` was
  accepted as `1` or `true` by the hook loader and only as `1` by the `config.toml` reader — the kind
  of difference that costs somebody an evening. `envFlag()` in `src/config.ts` is the single reader
  now (`1` or `true`, either case; `PI_` first, the older `PIE_` prefix after it), and
  `PI_LOOPS_DEBUG` and `PI_LOOPS_HOST` go through it too, so `=true` works for them as well. The
  current name wins when both are set, so `PI_ALLOW_PROJECT_HOOKS=0` can turn off what a shell
  profile switched on years ago under the older name — a switch you cannot reach is worse than one
  you have to spell correctly — and anything that is not `1` or `true` is off, so a typo fails
  closed.
- **The `.piesession` importer is named after the format it identifies.** `PIESESSION_SCHEMA` and
  `importPiesessionArchive`, and errors that say *the archive's* cron sidecar. The file is the thing
  a person handed over; `ARCHIVE_SCHEMA` beside `PIESESSION_SCHEMA` reads as two formats, which is
  what they are.

### Fixed
- **The leader file is `scheduler.<host>.json`, and four places said `scheduler.json`.** Both
  READMEs' storage tables, `src/store.ts`'s layout comment and `src/scheduler.ts`'s header. It
  carries the hostname on purpose — a shared `$HOME` gets one per machine — so the shorter name is
  the one a person greps for and does not find.
- `src/mcp.ts`'s header said tools are not proxied. They have been since tool registration shipped:
  it is the MCP client, notifications **and** tools.
- The doc comment belonging to `loadMcpConfigFiles` sat above `loadProjectMcpConfig`, describing the
  wrong function.
- Comments the previous editing pass over this project's wording left mid-sentence, each now stating
  its own reason: `src/danger.ts`, `src/subagent-guard.ts`,
  `src/share.ts` (which also still called the command `/share`), `src/redact.ts`,
  `src/hooks.ts`'s `run_start` rationale, `src/presence.ts`, `src/sdk-runner.ts`, and three
  sentences of `README.zh-CN.md` — one of which had lost its subject and one of which leaked an
  internal type name. Every comment that cited, by line number, a source file the reader cannot open
  now says what the code is for instead; the citations into pi's own installed build stay, because a
  reader can open those.

### Documented
- **`README.zh-CN.md` is ordered the way somebody reads it.** It opened with three sections of
  architecture before saying how to install anything. The commands and getting-started come first
  now, then usage, then the mechanisms — the English README's path. Its hook fields said
  `cwd = project|pie|home`, missing `loops`, which is the name (`pie` is only its older one); its
  code-structure table was well short of the tree and is now all of it.
- `AGENTS.md`'s layout listed `src/cli.ts` twice, omitted ten modules and pointed at
  `test/register-pi.mjs`, which lives in `src/`. It is the whole of `src/` now, grouped by what each
  part does.
- `docs/configuration.md`'s environment table gains `PI_LOOPS_DEBUG` and `PI_BIN`. `docs/loops.md`
  says `/crontab` and `/loop` are `/cron` under other names, which until now only the Chinese README
  mentioned.
- Hard-coded test counts are gone from `AGENTS.md` and `README.zh-CN.md`. A number that is wrong one
  commit later is worse than no number, and `npm run ci` prints the real one.

## [0.14.4] - 2026-09-11

### Changed
- **Every doc, comment, test name and user-facing string states its own reason.** The reason a rule
  exists is the rule's own reason, and a person reading `/cron`'s help or a comment in the scheduler
  should find it there, in front of them. All of them were rewritten to say it directly, with the
  reasoning kept, and the README ends with a single line of acknowledgement.

### Added
- `cwd = "loops"` in `hooks.toml` names the pi-loops data directory. `cwd = "pie"` resolves to that
  same directory, an older name for it this project still accepts: the option is written in
  people's config files, and a hook that silently starts running somewhere else is worse than an
  odd name.

### Fixed
- A test asserted that "45 minutes from now" is still today, and so failed every night between
  23:15 and midnight. It uses noon today now.

## [0.14.3] - 2026-09-11

### Documented
- **The Chinese README says which clock, in Chinese.** Everything about time went into
  `docs/loops.md` and the skill, both English, while `README.zh-CN.md` — where a Chinese-reading
  user actually learns what `/cron add` does — said `本地时间` in a parenthesis and stopped. It now
  has what the English docs have: the stamp format and why it carries an offset, the two measured
  daylight-saving edges and `every 24h` as the way round them, what `at 2026-09-08` with no time
  does, that `in`/`at` freeze an instant while `every` is an interval, and the cross-machine loop
  note.
- The English README's `/cron add` row points at that section rather than leaving "5-field cron" to
  imply a clock it never names.

## [0.14.2] - 2026-09-11

### Documented
- **Nothing in the package is written in one machine's timezone any more.** The prompt shape in
  `docs/loops.md` showed `current run started 2026-09-09 09:00 +08:00` — the offset of the machine
  the line was written on, sitting where a reader on any other machine would take it for part of the
  template. The prompt is built from the running machine's clock and always was; the doc now says so
  in the same `<…>` placeholder style as the rest of that block, and the `runs.jsonl` example beside
  it names whose offset it is showing.
- **The skill says what the machine's clock means for a job it creates** (`skills/pi-loops`): that
  `0 9 * * *` is nine in the morning where the machine is, that `at 2026-09-08` with no time is
  midnight **UTC** by JavaScript's rule while `at 2026-09-08T18:00` is local, and that a job which
  must run once a day and never twice is safer as `every 24h` — clocks go back one night a year.
  The model creating the job is the one who would otherwise write the date-only form.

## [0.14.1] - 2026-09-11

### Fixed
Both found by following one question: what happens to a loop that runs on a machine in a different
timezone from the one it last ran on? A job with no `host` runs on any machine sharing the `$HOME`,
and `/cron set <ref> --host -` asks for exactly that, so this is a supported arrangement rather than
a hypothetical one.

- **A loop is now told how to write a time.** The notes it is asked for hold watermarks —
  "everything up to here has been seen" — and a watermark is a time the model writes in whatever
  shape it likes. Run N could write "checked up to 20:00" in Shanghai and run N+1 read it in New
  York. The run time in the prompt carries its offset, and the prompt now asks for the same of
  anything written back. It goes in pi-loops' own line, leaving the protocol block verbatim.
  Notes written before this version do not have it: a loop that crosses timezones and keeps a
  watermark is worth one look at `/cron state <id>`.
- **`next-runs.json` is per host**, like the leader record beside it and for the same reason.
  Leadership is per host, and a cron expression is matched against local time, so two machines
  sharing a `$HOME` were both writing that one file with answers computed in different timezones —
  each overwriting the other, the panel showing whichever wrote last. `next-runs.<host>.json` now.

## [0.14.0] - 2026-09-11

### Changed
- **One clock, and it says which one it is.** Cron expressions were always matched against this
  machine's local time — `0 9 * * *` is nine in the morning where the machine is — but the files
  were written in UTC and `/inbox` printed UTC while `/cron` printed local, neither saying so. Eight
  hours apart, in the same session, with nothing on either to tell them apart.

  Every timestamp pi-loops writes is now this machine's time carrying its offset:
  `2026-09-11T20:37:59.405+08:00`. That is the same instant `12:37:59.405Z` names, and anything that
  parsed one parses the other — earlier versions' files — so nothing needs migrating.
  What changes is that opening `runs.jsonl` shows the hour you were at your desk, and it agrees with
  the `next` on the `/cron` line that sent you there. `/cron` and `/inbox` name the offset in their
  header; a timestamp that travels away from the screen explaining it — into a sub-agent's prompt,
  into a tool result a model reads — carries its own.

  Two exceptions, neither a time anybody reads: the name of a session file, which cannot hold the
  `+` and `:` an offset brings, and pi's own session header, whose format is pi's to decide. A lint
  rule (`utc-stamp`) keeps the rest from drifting back, and takes the reason for an exception from
  the comment above it.

### Fixed
- **`/inbox` timestamps were UTC wearing the shape of a local time.** They were the stored ISO
  string with the `Z` sliced off. Local now, like everything else.
- **The sub-agent prompt said a time without saying which clock.** `docs/loops.md` described it as
  UTC; it was local, unmarked, and a model was being asked to reason about how long ago the last run
  was. It carries its offset now, and the doc says what it actually says.
- **The `/triggers` status line found the last run by sorting timestamps as text.** Correct only
  while every one of them ended in `Z`; by instant now.

### Documented
- **Daylight saving, measured rather than assumed** (`docs/loops.md`). A job at `0 2 * * *` does not
  run on the day the clocks go forward — 02:00 does not exist — and a job at `0 1 * * *` runs twice
  on the day they go back. Vixie cron special-cases both and pi-loops does not; `every 24h` is
  immune, because it counts elapsed time and never consults a calendar.
- **What `at` does with the text you give it**: `at 2026-09-08T18:00` is local, `…T18:00Z` is UTC,
  and `at 2026-09-08` — a date with no time — is midnight **UTC**, which is JavaScript's rule rather
  than ours and the one that surprises people.

## [0.13.6] - 2026-09-11

### Added
- **The panel says when a cron-expression job runs next.** It worked this out itself and understood
  only `every <interval>`, so a job on `0 9 * * *` — the first example in the README — showed no
  next run at all. Writing a second cron parser into a page that has no dependencies was the wrong
  fix, and so was the snapshot: that goes into the session file for good, rate-limited and
  deduplicated on purpose, and a next run changes every time a job fires. The process that owns the
  clock has the evaluator, so it writes the answers to `next-runs.json` beside the store — only when
  one of them changes, which for a nightly job is once a day — and the page reads them like every
  other file pi-loops keeps.

  A time that has already passed is shown as no next run rather than as a past one; a job that is
  disabled or belongs to another machine is not promised one, which is the rule `/cron` follows; and
  a next run that is not today says which day it is, because "15:13" for next January is not a
  shorter way of saying it.

### Fixed
- **A job's name is no longer clipped.** It is what `/cron set <name> --host here` takes, so the one
  thing in that card you might need to copy was the one thing abbreviated to an ellipsis — while the
  schedule beside it wrapped onto two lines. The name wraps now and the schedule stays in one piece.

## [0.13.5] - 2026-09-11

### Fixed
- **The panel's "other host" line now gives a command you can run.** It said `/cron set <n> --host
  here`, copied from the terminal, where `n` is a position in a numbered list — which the panel does
  not have. Telling somebody to use one was telling them to go and find a terminal to count in. It
  names the job now: `/cron set <name-or-id> --host here`.

## [0.13.4] - 2026-09-11

### Fixed
Reported as "my cron job disappeared after I rebooted the machine". Three separate reasons a job
can be there and not be seen, and one reason it can stop running by itself.

- **A directory that has not been mounted yet is waited for, not treated as a deleted project.** A
  stateful job whose `cwd` was missing at the moment it came due was disabled on the spot — and a
  network mount, an external disk or an encrypted volume comes up *after* the first pi does at boot,
  so a nightly job died silently for being twenty seconds early and stayed dead once the mount
  appeared. The slot is owed rather than consumed, the job says `waiting: cwd … is not there yet`,
  and it is disabled only once the directory has been missing for half an hour.
- **The browser panel stops hiding jobs.** It dropped every job stamped with another hostname —
  and a hostname changes on its own: a rebuilt container, a machine renamed by DHCP, a restored
  backup. What you got was a job sitting enabled in `jobs.json`, never running, invisible in the one
  place you would look. It is listed and marked now, as `/cron` has always listed it.
- **And stops dropping other projects silently.** The store is machine-wide and the panel's list is
  not; it now says `+ N in other projects — /cron all`, which the terminal has always said. Without
  that line a job made in another directory is indistinguishable from a job that is gone.
- **The panel and `/cron` now agree about what "this project" is.** The panel compared strings while
  the extension resolved symlinks (`withinProject`), so a project reached through a link — a
  worktree, a `~/code` pointing at a mounted disk — was the same project to `/cron` and a different
  one to the page. `$HOME` is too broad to be a project in both places now, rather than only in one.

### Known gap
- The panel still shows no next run for a job on a cron expression (`0 9 * * *`); it understands
  only `every <interval>` and `once`. See `docs/web-ui-parity.md` — the fix is for the snapshot
  pi-loops already writes to carry the next run, not for a second cron parser to live in the page.

## [0.13.3] - 2026-09-11

### Added
- **Starting over, without going back to a terminal.** The context is finished with far more often
  than the window is, and every way of saying so — a new session, an earlier one — meant Ctrl-C in
  the terminal that launched the page and typing `pi-loops` again. On a phone it meant nothing at
  all. `clear` and `resume` are now buttons beside `compact`, and `/clear`, `/new` and `/resume`
  typed in the composer do the same thing: the habit comes from a terminal and the muscle memory
  arrives with it.

  Both are pi's `switch_session`, which replaces the session inside the process that is already
  running — same model, same MCP connections, same extensions, rebuilt against the new session.
  That is the path pi takes for `/new` and `/resume` in the terminal, and the one pi-loops has
  handled since it was written: the scheduler stops and starts with the session rather than being
  handed to the headless host, and a run the swap aborts gives its slot back and re-fires on the
  next tick. Nothing is deleted by either — the session being left is a file on disk that `resume`
  lists, labelled by what was said in it rather than by a filename.

  Refused while a turn is running, by the server rather than only by the page: the swap aborts the
  turn, and losing a reply you are waiting for is not something to find out afterwards. Refused,
  too, for the session already open — pi answers a switch to the file it is writing by starting an
  empty session pointed at that file, which is two sessions with one file between them.

### Changed
- **Compaction says what it did, and can be told what to keep.** The button reported "context
  compacted" and nothing else, for an operation that costs a model call and throws most of the
  conversation away; pi hands back what the context was and what it became, and that is now on the
  screen with what the summary cost. `/compact keep the API shapes` steers it, the way
  `/compact <instructions>` does in the terminal — the browser had no way to say it at all.

### Fixed
- **A slash command with an argument can be typed again.** Every keystroke asks for completions, and
  the answer to `/compact` arrived *after* the space that closed the list — and put it back. Enter
  then accepted the completion instead of sending the line, so `/compact keep the tests`,
  `/cron add …` and `/goal …` were reachable with a mouse and not by typing. Closing the list now
  counts as newer, so an answer in flight is discarded.
- **An automatic compaction that failed no longer reports success.** `compaction_end` was answered
  with "context compacted" whether it had worked, been aborted, or failed — and said it a second
  time over the top of a manual compaction that had just reported the opposite. The line now says
  what happened, and only for the compaction nobody asked for; the one you asked for is reported by
  the call that asked.

Three more, found the same way — by walking the page as a person would, after the feature above was
already written, reviewed and green:

- **A cron job made in a session started from the browser is no longer parked as an orphan.** pi
  names the sessions it starts after their id — `<timestamp>_<id>.jsonl` — and `sessionExists` read
  that name. A session started from the page is created by asking pi to switch to a path that does
  not exist yet, and the id pi mints for it cannot be known in time to put in the name, so ten
  minutes later the scheduler disabled every inject-and-run job belonging to it as "session no
  longer exists" — and `/cron gc` deletes what it parks. The header decides now, which is what
  `listSessions` always did.
- **That scan cannot be stopped by a fifo.** Reading headers means opening files, and `openSync` on
  a fifo with no writer never returns — on the leader's tick, for ever. Regular files only, the
  same rule the session picker applies.
- **A session name cannot reorder the line it is drawn on.** Terminal escapes were already stripped
  from anything shown; the invisible bidi overrides and isolates were not, so a session named
  `delete\u202e evil red` drew as "deleteder live" — a different conversation from the one that would
  open, in the control that decides which one opens. They are stripped everywhere `plain()` is
  used, which is everywhere text from somewhere else is shown. The marks ordinary
  mixed-direction text uses (U+200E, U+200F) are left alone.

## [0.13.2] - 2026-09-10

### Fixed
- **A path in backticks is a path.** Writing one as `` `~/Downloads/report.html` `` is how a model
  says where it put something, and the renderer was deliberately leaving code spans alone — a rule
  that fired on exactly the case it was meant to serve. A span that is *only* a path is now a link
  (still looking like a path), and one that is only a picture is the picture. A span with anything
  else in it, and anything inside a fenced block, is still a literal string.

## [0.13.1] - 2026-09-10

### Changed
- **An extension speaking in the middle of a stretch of work stays inside it.** A line like
  `karpathy | write x.html | 166 lines` is something a tool just did, but it arrived as a message —
  so it took a row of its own *and* ended the stretch, turning one block into three rows: six steps,
  the note, thirty-five steps. It goes in the block now, and the block stays one row. A message that
  arrives between turns is still a message.

### Note
The steps blocks are collapsed by default — verified with a browser whose storage had been cleared:
the preference reads `closed`, the button says `▸ steps`, and a new block comes up shut. If yours
are open, the header button was pressed at some point; it remembers, and pressing it again puts
them back.

## [0.13.0] - 2026-09-10

### Changed
- **A whole stretch of work is one row.** Thinking and tool calls arrive interleaved — think, read,
  think, run, think — and each one took a row of the conversation, so a long agentic turn was thirty
  rows of plumbing around three sentences of answer. They collect into one block now: while it is
  happening the line says what is happening, and when the answer arrives it closes into
  `6 steps · thinking, read, bash`.
- **One button opens or closes every one of them**, in the header, remembered in that browser.
- **A path written in ordinary prose is something you can open.** "I put it in
  `/home/you/Downloads/report.html`" was a sentence with a dead end in it — only Markdown links were
  turned into previews, and that is not how a model says where it put something. Paths beginning
  `/`, `./` or `~/` and naming a file worth showing become links; image paths become the picture
  itself, in the conversation. Paths inside code spans, ordinary words with slashes, and web
  addresses are left alone.
- **A preview can read your home directory, not only the session's own.** An agent asked to make
  something for a person puts it where a person keeps things, and refusing to show you your own
  `~/Downloads/report.html` because the session started in `~/code` is a rule that serves nobody.
- **A `reload` button**, next to the rest.

### Security
The widening above was reviewed before it shipped, and three things came back:
- **A symlink was a way past the "no dot segments" rule.** Membership was decided after symlinks
  were resolved and the dot rule applied before — so `~/Documents/cfg/creds.json`, where `cfg`
  points into `~/.config`, was served. Both are decided on the resolved path now.
- **Outside the session's own directory, only what one looks at**: pictures, PDFs and pages. A home
  directory holds service-account keys named like ordinary JSON and password exports named like
  ordinary CSV, and the dot heuristic says nothing about either.
- **A preview may not fetch anything**, and scripts run only for the session's own files.
  `~/Downloads` is where a browser puts what the web gave you, and running that under an address
  you trust is not previewing. Both are now in the response's own policy.
- `HOME=/` is not treated as a home directory, which it is in some containers.

## [0.12.4] - 2026-09-10

### Added
- **A page left open across an upgrade says so**, in a bar across the top: which version this window
  is running, which one is installed, and click to reload. A stale tab is indistinguishable from a
  current one otherwise — the panel does show a version, but that is the server's, read live, so
  the one thing on screen that looks like an answer to "how old is this page" answers a different
  question. Three rounds of "no reply appears" were spent on a page that could not have received
  one.

### Note
Refreshing `http://127.0.0.1:4173/` is enough after an upgrade — the token in the URL is only for a
browser that has never been here, and the page is served `no-store`, so a normal reload always
fetches the current one. What is *not* a reload is asking the desktop to open a URL the browser
already has open: it brings that tab forward untouched, which 0.12.3 works around by opening a
distinct address each time.

## [0.12.3] - 2026-09-10

### Fixed
- **Starting the session again handed you back the tab you were already looking at, unchanged.**
  When a server is already on the port, the second launch opens that one's window — at the same
  address, which a browser answers by bringing the existing tab forward *without reloading it*. So
  a page from before an upgrade kept being presented as though it were the new one, which is how
  "no reply appears" survived being fixed twice. The handover opens a distinct address each time,
  and the tab is replaced rather than merely focused.

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
- Bare `pi-loops` starts one, choosing the window: the browser front end at a local
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
  rule you wrote about your own turns would have started firing for automation. These are their own
  events because a scheduled run is not a turn: it happens with no conversation at all, or beside
  one.
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
  picks it up afterwards. A second front end cannot replace pi's terminal, so
  this is the same shape through the door pi already provides. Streaming feed, history, queue,
  abort, model/thinking, compact, images, `/` and `@` completion, `@file` expansion, search, undo,
  HTML export, cost, and pi-loops' approval dialogs answered in the browser.
- `pi_loops_snapshot`: a session entry carrying what only this process knows — which MCP servers
  connected and what they exposed, the active tools, hooks, whether this pi owns the clock, the
  last check. The TUI panel had it and nothing else could get at it; a front end that is not a
  terminal now reads it structurally instead of parsing text meant for a person. Written when it
  changes (not per tick — it goes into the session file), and `/cron snapshot` forces one.
- `/share` uploads this session's transcript as a GitHub gist through `gh` —
  but redacted first, and it says what it is about to publish before it does: how many messages and
  tool results, how many secrets the redactor masked, whether the gist is public, and where the
  local copy is so you can read it. Secret by default; `--public` needs its own confirmation.
  Rendering the transcript unredacted and shelling straight out to `gh gist create`, which sits
  badly next to a project that redacts everything else it puts on a screen.
- `/triggers run <id>` checks one rule now, without waiting for its poll slot —
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
  into the log file.
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
  one is due, printed on every start.
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
  than being skipped, so work resumes when the day rolls over or the cap is raised. There is the
  same primitive and never exposes it, because its loops die with the session; a headless host runs
  for days, so nothing else bounds the bill.
- `/cron cost [today|7d|all]` adds up the run log by job and shows today's spend against the budget.
  Every number was already recorded and nothing added them up.
- The `/goal` evaluator is recorded in the run log like any other model call. It used to be spend
  that appeared nowhere at all.
- Trigger checks and actions share `[cron] max_concurrent_runs`. Spawning every accepted trigger
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
  now reads the active branch through `sessionManager.buildContextEntries()`, reading its
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

### Added — three things that were missing
- **`/goal <condition>`** (`src/goal.ts`): the session is held to a stop condition.
  After every settled turn an evaluator with no tools judges the condition against a bounded
  transcript and either stops with the evidence, sends the agent back to work with what is missing,
  or pauses. At most 8 continuations; an evaluator that cannot decide pauses rather than looping;
  the state is appended to the session so `--resume` picks it up. `/goal pause|resume|clear`.
- **A command line** (`pi-loops export|import`, `src/cli.ts`): archives as
  subcommands that need no pi session, for backups from cron or CI and for restoring on a fresh
  machine. `--session` takes an id or a unique prefix, `--activate-triggers=off|ask|on` says what to do with
  the automation inside, and a `.piesession` archive is accepted for its automation sidecars.
- **A window into the headless host** (`pi-loops host status|abort|stop`, `src/host-control-channel.ts`):
  while no pi is open the host publishes what it is running — loop runs, trigger checks, what is
  enabled, the inbox count, each MCP server's state — over a 0600 unix socket, and one run or check
  can be interrupted. `/cron host` shows the same snapshot. Read-mostly on purpose: a host you
  could prompt would be a second chat.

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
- A promoted result carries a default template (`<source> fired <event>.\nResult: …`), and the
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
- `jobs.json` is only written when something changed, and an idle machine no
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
- Loop, checker and trigger sub-agents run under the dangerous-command policy
  (`src/danger.ts`): sudo, `curl … | sh`, `dd` to a block device,
  `mkfs`, `chmod 777 /`, shutdown/reboot, `git push --force` on main/master, pipes into `eval`,
  the fork bomb, and `rm -r -f` aimed at `/`, an absolute path or `$HOME` are refused before they
  run, with the reason handed back to the model. Cloning the parent's tool-call hook into
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
- A sub-agent inherits the parent session's active tools (`pi.getActiveTools()`), which hands
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
  server→client stream optional, and POST stays independent of it).
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

### Changed — sub-agents run in-process
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
  lands in the right chat. The machine leader covers only
  projects with no pi open (results to the inbox). The poll interval is enforced machine-wide.
- A plain cron job created by a sub-agent binds to the session the sub-agent acts for, not to
  the sub-agent's own throwaway session.
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
- Trigger audit rows also become session custom entries (`trigger`, `trigger_result`,
  `trigger_promotion`) with the project's `cwd`; `/triggers audit [N] [--all]` shows this
  project's rows by default.
- Hooks are awaited inline (`[hooks] mode = "async"` for the old queued behavior).
- `PI_LOOPS_HOST=1` lets a `pi -p` run host the timer for as long as it lives.
- `[cron] catch_up = false` switches start-up catch-up off for every job (the global switch wins
  over `--catchup`); `[cron] max_concurrent_runs` bounds the burst.
- Jobs and rules record their `host`; other hosts sharing `$HOME` ignore them, leader election is
  per host (`scheduler.<host>.json`), and orphan detection never disables another host's loop.
- A promotion while the agent is busy goes to the follow-up queue and runs a turn after the
  current one.

### Changed — the small things, fixed
- Ids are `cron-<32 hex>`; `inbox.jsonl` keeps a stable record shape on disk
  (`created_at`, `trace_id`, `session_id`, …) and still reads lines written by earlier versions.
- Cron control-plane audit entries use the custom type `cron_control_plane` and carry an
  `audit_entry_id`, which `cron_create` / `cron_remove` / `set_cron_job_state` return in `details`;
  `cron_create` answers with three lines and `cron_list` details include `next_run` and
  `last_due_at`; `verify = true` implies `stateful` on the tool path as on the slash path.
- `/inbox` lists the full finding with a `created_at[..16]` timestamp; `/cron` shows a
  `last fired:` line; `/cron`, `/triggers` and `/new-trigger` have fixed usage and error wording;
  `/triggers enable|disable` prints condition/action/fire-once; `/triggers sources` lists MCP
  servers, the cron hook and the dynamic checker in registration order and `/triggers status` adds
  a `sources: N total, M connected, K require attention` line.
- Tool confirmations show an approval card (Action / Tool / value-free Reason /
  args hash / redacted Preview) and log `approval required` / `approved` / `denied` feed lines;
  `new_trigger` requires `condition` and `action` and rejects unknown fields.
- Promotions and injected summaries are `[Trigger <trace>] <text>`
  (the `<source> fired <event>. Result:` wrapper is gone); running-trigger previews are 80 chars of
  the action prompt; inject-and-run turns announce `running triggered turn (trace …)`.
- Side panel: a Polling entry (source / event, trace, summary — shown whenever a check ran),
  MCP aggregate (`servers N · tools M · notification hooks N`), and Hooks / Runtime sections.
- Hooks: every payload field is present (`null` when absent), custom messages report their
  `customType` as `message_kind`, failures reach stderr when there is no UI, `<project>/.pie/hooks.toml`
  is read when `.pi/hooks.toml` is absent (same for `mcp.toml`).
- MCP: a repeated server name replaces the earlier entry with a diagnostic; a successful
  push clears `last error`; stdio stderr is reported separately as `stderr:`; dedup audit records
  the first arrival's replacement policy; idempotency keys hash any Unicode control character;
  the SSE frame cap counts bytes; stdio-server validation no longer says `streamable_http`.
- Session archives: a sensitivity warning is printed first and on failure; the imported header
  drops the source machine's parent-session pointer.
- Redaction masks browser-login and loopback-callback URLs; an invalid poll interval
  (config or `--trigger-poll-secs`) is diagnosed instead of silently ignored; the loop prompt's
  `[loop-state]` line is worded once and kept; User-Agent / MCP clientInfo carry the real version.
- `examples/mcp-notify-server.mjs`: a dependency-free MCP push server.

## [0.1.2] - 2026-09-09

### Fixed
- streamable_http MCP sources: the idle timeout was a deadline on the whole GET stream, so a busy
  stream was cut every `sse_idle_timeout_ms` (60 s), failing in-flight calls and re-handshaking.
  It now bounds only the wait for the response headers and for each chunk.
- Sub-agent processes (`pi -p` loop runs and trigger checks) consumed MCP pushes and could spawn
  nested trigger sub-agents with no ceiling. Sub-agents keep the MCP tools but ignore
  pushes, and the trigger runtime audits anything reaching hop ≥ 1 as `cycle_suppressed`.
- `/session-export --exclude-triggers` still bundled cron jobs and loop state; it drops
  every automation sidecar. `/session-import` validates all sidecars before writing the session
  file and rolls back store writes on failure, so a rejected archive leaves nothing behind.
- A failing audit or dedup write inside trigger handling became an unhandled rejection. Audit
  writes are best-effort (`lastPersistenceError`, logged once per distinct
  error), `TriggerRuntime.handle()` never rejects, and scheduler hook failures cannot strand a run.
- Prompt-class control-plane tools (`new_trigger`, `remove_trigger`, re-enabling a trigger or a
  cron job) were auto-approved in sub-agents; they are denied fail-closed there.

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
- Plain (inject) jobs no longer catch up missed ticks by default; `--catchup` opts in. Loops still do.
- Sub-agents keep the cron/trigger tools while `PI_LOOPS_HOP < 2` (hop-bounded cycle suppression) instead of never having them.
- `/cron` marks plain jobs whose session is not open as `[dormant …]`; loops whose `cwd` vanished are auto-disabled and marked `[orphan]`.
- `/cron status` means list; the scheduler view is `/cron scheduler`.

## [0.1.0] - 2026-09-08

First release. A whole automation layer, as a pure pi extension.

### Added
- `/cron add [--stateful] [--verify] "<schedule>" <prompt>` with list/enable/disable/remove
  surface, schedule aliases (`hourly`, `daily`, `每小时`, …), `every 30m`, `in 10m`, `at <ISO>`.
- Stateful loops: fresh `pi -p` sub-agent per run, ≤2000-char notes carried between runs
  (`<loop-state>`), findings routed to the inbox (`<inbox>`), transcripts kept (`/cron trace`).
- Maker/checker (`--verify`): an adversarial second sub-agent keeps or drops each
  finding before it enters the inbox; fail-open on checker failure.
- `/inbox` triage with fixed list formats and `new → claimed/dismissed` lifecycle;
  `/inbox claim` starts a real agent turn.
- Dynamic triggers: `/new-trigger`, `/triggers status|rules|sources|enable|disable|remove|running|audit|abort`,
  `new_trigger` / `list_triggers` / `remove_trigger` / `set_trigger_state` tools, periodic sub-agent
  evaluation, fire-once, `promote_to_chat`, `[Trigger <trace>]` prefix, 5-minute dedup window.
- MCP: notification sources (stdio + streamable HTTP) with an `mcp.toml` schema, dedup keys,
  redacted summaries, `inject_summary` / `inject_and_run`; server tools registered with the agent.
- Lifecycle hooks (`hooks.toml`): events, payload, `PI_*` and `PIE_*` env, command + webhook,
  sequential execution, process-tree kill on timeout, project hooks gated.
- Session archives: `/session-export` / `/session-import` (`.pisession`; a `.piesession`
  layout plus `loops/<id>.md` state files).
- A side panel above the editor (`/cron panel on|off`), `Inbox: N new · running: …`
  status badge, run cards in the transcript.
- Machine-global job store with leader election across pi processes, one-shot catch-up of missed
  ticks (`--no-catchup` to opt out), per-job transcripts, run log, redaction everywhere.

### Deliberate design choices
- Jobs and rules are machine-global with a `cwd`, not session-scoped; `/cron` and `/triggers rules`
  list the current project by default.
- Missed ticks are caught up once by default, collapsed rather than replayed.
- Prompts may be up to 8 KB.
- MCP notifications are consumed by the single process that owns the timer; every process still
  connects for tools.
