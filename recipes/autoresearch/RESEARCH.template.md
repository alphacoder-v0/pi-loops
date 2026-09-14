# Research contract

Copy this file to the project root as `RESEARCH.md` and fill it in. The autoresearch loop reads it
on every run and never changes it; a run that finds it missing or its protected files altered stops
with a finding. The example in `.agents/skills/autoresearch/example/` is a filled-in one.

## Objective

One sentence a person can check: what better means. *Make the exact k-nearest-neighbour search in
`solution.py` faster while keeping its output identical.*

## Metric

- **name:** `speedup` — **higher is better** (or: `val_loss`, lower is better)
- **dev command:** `bash eval.sh dev` — prints one line `metric=<number>`; used to iterate
- **held-out command:** `bash eval.sh test` — same shape, other data; used only to decide promotion
- **baseline:** measured by the first run on the untouched code and written to the ledger; leave blank

## Files

- **editable:** `solution.py` (one path per line; nothing else may change)
- **protected:** `eval.sh`, `eval.py`, `task.py` — the loop records their `sha256sum` in the ledger's
  header on the first run and refuses to work if any differs since

## Promotion rule

A branch is promotable when its **held-out** metric beats the best promoted (or the baseline) by at
least **5%**, and the dev metric agreed. Under `propose` the loop files a finding and a person
merges; under `act` the loop merges the branch into this checkout's current branch itself.

## Budget and layout

- **per experiment:** at most 10 minutes of evaluation; a run that exceeds it retires the experiment
- **ledger:** `research/results.tsv` (created by the loop, never committed by it)
- **worktrees:** `../<repo>-research/<NNN>`, branch `research/<NNN>-<slug>`; retired branches are deleted, the ledger row stays
- **directions worth trying first (optional):** …
- **directions not to try (optional):** …
