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
The headless process that keeps the clock while no pi is open.

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
