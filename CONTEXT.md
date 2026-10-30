# pi-loops

Automation for pi that runs on a clock or a condition while nobody is watching: recurring
sub-agent runs that keep notes, an inbox that holds what they found, and — as recipes — packaged
ways of running a project on them.

## Language

### Running things

**Job**:
One scheduled entry in `jobs.json`: a schedule, a prompt, a directory, and whether it is stateful.
_Avoid_: task, cron entry, automation

**Loop**:
A stateful job. Each run is a fresh sub-agent whose only memory is the notes the previous run left.
_Avoid_: stateful cron, watcher

**Run**:
One execution of a job: one sub-agent session with a transcript, a cost and a result.

**Asleep** (a plain job):
A plain job that neither a window nor pi-loops can fire: no window holds its session, and pi-loops
never saw the session's file (or the file is gone). It belongs to that session — its result is a
message there — so it runs only once that session is resumed. Not an error, and never promised a
next run anywhere else. When pi-loops is not running, a plain job of a closed conversation is *paused*, not asleep.
_Avoid_: dormant, dead, orphaned (that one is a loop whose directory is gone)

**Lease** (of a session):
Which process does a conversation's automated work (its plain jobs, the rule results queued for it):
a window, or pi-loops while no window has it open. One holder at a time. It moves when the holder
releases it or its process is gone, and a window takes it from pi-loops at once; never on a timer.
_Avoid_: owner (rules and jobs have creators), lock (nothing waits on it)

**Viewer**:
A second window on a conversation another process holds. It fires none of the conversation's plain
jobs, gets none of its rule results, and writes none of pi-loops' views into it. A window whose copy
of the conversation is older than its file stands aside the same way until the conversation is
resumed, and keeps the lease meanwhile so that nothing else writes into it.

**Held turn**:
pi-loops’ turn in a closed conversation: it holds the lease, runs one plain job's prompt there on
the job's model (the conversation's when the job pins none), and gives the lease back. A run, with its own record and cost.

**Session request**:
One row in `requests/<session>.jsonl`, addressed to a conversation: a rule's result today. It stays
there until its `[Trigger <id>]` is in the conversation; the window holding the conversation
delivers it, pi-loops appends it when the conversation is closed. At three failed deliveries, or
when the conversation's file is gone, it is a dead letter: a finding in the inbox.
_Avoid_: mailbox, delivery (that is what pi does with it), inbox (that holds findings)

**Notes**:
The Markdown a loop's run hands to the next run, replacing what was there. A cache of what the world
cannot tell the next run, never the truth about the world.
_Avoid_: state, memory, loop-state (the tag name, not the concept)

**Finding**:
One line a run wants a person to act on. It waits in the inbox until claimed or dismissed.
_Avoid_: alert, notification, result

**Inbox**:
The machine-wide queue of findings, listed per project.

**Checker**:
The second sub-agent a `--verify` loop puts between a run's findings and the inbox, told to assume
each may be wrong.
_Avoid_: verifier, reviewer, evaluator

**Trigger**:
A condition and an action, checked by polling or fired by a push, instead of a clock.

**Host**:
The code name for pi-loops, the always-on process that runs every loop, rule check and MCP push,
and plain jobs of closed conversations for one loops directory. A pi window starts it when there is work.
_Avoid_: the word in user-facing text; say “pi-loops” or “in the background”.

### Recipes

**Recipe**:
A packaged way of running a project on loops: one or more jobs, the playbook each of them reads,
a manifest, and optionally a setup script. Installed into a project with `/recipe add`.
_Avoid_: preset, template, workflow, pattern

**Playbook**:
The Markdown a loop's run reads and follows. Copied into the project at install so a person can
edit it there; not versioned with the project.
_Avoid_: prompt file, step file, script, skill (pi discovers playbooks as skills, but that is a
side effect of where they live)

**Manifest**:
A recipe's machine-readable description (`recipe.toml`): its jobs, playbooks, setup script, the
autonomy levels it supports, and what it needs from the project.

**Setup script**:
A one-off a recipe runs once per project, with confirmation, before its jobs exist — creating
tracker labels, for instance. Not a job.

**Tracker**:
Where a project's work items live and are moved between states: GitHub Issues, or one Markdown
file per item under `.scratch/issues/`. Described once per project in `docs/agents/issue-tracker.md`,
kept out of the repository like the playbooks; a playbook reads that description on every run
rather than assuming one.
_Avoid_: issue system, task management, board

**Autonomy level**:
How far a recipe's runs may go without a person: `report` (read, and file findings), `propose`
(also write to the tracker and open draft pull requests, never a terminal state), `act` (also reach
terminal states: promote, merge, close). A recipe declares which levels it supports; the installed
level is a line at the top of each playbook.
_Avoid_: mode, L1/L2/L3, recommend/act

**Checkpoint**:
A point in a recipe where a person decides. In pi-loops it is a finding whose text asks for the
decision; claiming it is the approval, and any outward action the person approved runs as a real
turn from the claim.
_Avoid_: gate, approval step

**Claim** (of a work item):
The first write a run makes on a work item it is about to work on — a label plus an assignee on the
tracker — so a second run on any machine skips it. A soft lock: the tracker has no compare-and-swap.
_Avoid_: lock, lease
