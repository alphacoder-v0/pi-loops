---
name: autoresearch-experiment
description: One run of the autoresearch loop. Reads the research contract and the ledger, runs one experiment in a worktree, measures it, writes the row. Proposes promotion only on held-out evidence; retired experiments stay in the ledger as negative evidence.
---

# Experiment: one run

Autonomy: propose

The line above is the installed level. `propose`: a promotable branch is a finding a person merges.
`act`: you merge it into this checkout's current branch yourself (`git merge --no-ff`), then file
the finding saying so. Nothing else differs between the levels.

You are the autoresearch loop. Nobody is watching. One run is **one experiment**: a hypothesis,
a branch, a measurement, a row in the ledger. The run has a timeout; commit and write the row
before anything slow. Your final reply is read by a program.

## The contract and the ledger are the truth

1. Read `RESEARCH.md` at the project root. Missing → one finding: `autoresearch: no RESEARCH.md —
   copy .agents/skills/autoresearch/RESEARCH.template.md to the project root and fill it in`, notes
   unchanged, stop. Never write the contract yourself.
2. Check the protected files: `sha256sum` each, compare with the hashes in the ledger header. A
   difference → one finding naming the file, stop. (First run: record them.)
3. Read the ledger at the path the contract names. Missing → create it:

   ```text
   # autoresearch ledger — protected: eval.sh=<sha256> eval.py=<sha256> …
   id	started_at	branch	hypothesis	status	dev	heldout	note
   ```

   then measure the **baseline**: run the dev and the held-out commands on the untouched code and
   write row `000` with status `baseline`. That is the whole first run.

4. **Resume.** If your notes name an experiment in progress and its worktree exists, continue it
   from the branch's `git log` and `git status` instead of starting another.

## One experiment

5. **Choose a hypothesis.** Read every ledger row: `retired` rows are negative evidence and are not
   retried in the same form; `kept` rows are the frontier to build on; the contract's "worth
   trying first" and "not to try" lists bound the space. Write one sentence: what you will change
   and why it should move the metric. Append the row now with status `running` — a crash leaves a
   record, not a mystery.

   **First, look back.** Count the `retired` rows since the last `kept` or `promoted` one (or the
   baseline). A streak is the ledger telling you the space is wrong, not that the next idea is:
   - **5 in a row**, and you have not said so since the streak began (your notes' `stalled-at`):
     one finding — `autoresearch: 5 retired in a row (<the idea classes tried>) · waits: a
     change to RESEARCH.md's directions, metric or budget · if not: I keep trying, but only in
     classes not yet tried` — and choose this run's hypothesis outside every class in your notes'
     `tried` line.
   - **10 in a row**: stop choosing. One finding — `autoresearch: 10 retired in a row, stopping
     until RESEARCH.md changes · waits: an edit to the contract · if not: nothing runs; the ledger
     is at <path>` — write the notes with the contract's hash, and end the run. A later run whose
     `RESEARCH.md` hash differs from the notes' starts the count again at zero; one whose hash is
     the same files nothing and stops again.
   A `kept` or `promoted` row resets the streak.
6. **Branch.** `git worktree add <worktrees>/<NNN> -b research/<NNN>-<slug> <current branch>`
   (create the worktrees directory first if it is missing).
   Change only the editable files. Commit in the worktree before measuring.
7. **Measure.** Run the dev command in the worktree, within the contract's time budget. Parse
   `metric=<number>`. Compare with the best `kept`/`promoted` row (or the baseline):
   - **not better** → status `retired`, note why in ten words, `git worktree remove` and delete
     the branch. No finding: a retired experiment is normal, and the row is what the next run needs.
   - **better on dev** → run the held-out command. Write both numbers. If held-out also passes the
     contract's promotion rule → status `kept` and go to 8; otherwise `retired` with note
     `dev-only gain` (the classic overfit; still negative evidence) and remove the worktree.
8. **Promote.** Under `propose`: one finding —
   `promote research/<NNN>-<slug>: dev <x> → <y>, held-out <a> → <b> (<hypothesis>) · waits: your
   merge · if not: branch and worktree stay; later runs build on it as the best kept` — and leave
   the worktree and branch for the person. Under `act`: in the project checkout,
   `git merge --no-ff research/<NNN>-<slug>`, set status `promoted`, remove the worktree, keep the
   branch, and file the finding as `promoted …`.

Never edit a protected file, never push, never merge under `propose`, never run two experiments
in one run. If the eval commands fail for a reason that is not your change (missing interpreter,
data not generated), that is one finding and a stop, not a retry.

## For the checker

A second sub-agent reviews the findings of this run before they reach the inbox. For a `promote`
or `promoted` finding: check out the named branch in its worktree (or the merge in the checkout),
run the contract's **held-out** command yourself, and keep the finding only if the number you get
satisfies the promotion rule against the ledger's best row; drop it with the number otherwise. A
`no RESEARCH.md` or protected-file finding is kept if the file state is as described; a `retired
in a row` finding is kept if the ledger shows the streak it names.

## Notes for the next run

`best=<id> <heldout>` · `next=<NNN>` · `in-progress: <id> worktree=<path>` or `none` ·
`tried: <one line per idea class you have exhausted>` · `stalled-at=<row id the 5-streak finding
was filed at, or none>` · `contract=<sha256 of RESEARCH.md>`. Under 2000 characters; the ledger
holds the rest.

## Inbox

Only: a promotion (proposed or done), a contract problem, an eval that cannot run, a streak of
retired experiments long enough to question the contract. Never a single retired experiment — the
ledger is where those live, and a person reads the ledger when they want to.

## Never

Never write the contract (`RESEARCH.md`) yourself, never edit a protected file. Never push; never
merge under `propose`; never run two experiments in one run. Never retry an eval that failed for
a reason that is not your change — that is one finding and a stop.
