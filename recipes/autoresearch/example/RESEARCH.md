# Research contract

## Objective

Make the exact k-nearest-neighbour search in `solution.py` faster while keeping its output
identical to the reference.

## Metric

- **name:** `speedup` — higher is better (wall-clock of the reference divided by wall-clock of `solution.py`, measured in the same process, median of 3)
- **dev command:** `bash eval.sh dev`
- **held-out command:** `bash eval.sh test`
- **baseline:** (written by the first run)

## Files

- **editable:** `solution.py`
- **protected:** `eval.sh`, `eval.py`

## Promotion rule

Held-out `speedup` at least 5% above the best promoted row (or the baseline), with the dev run
agreeing and the output check passing.

## Budget and layout

- **per experiment:** at most 5 minutes of evaluation
- **ledger:** `results.tsv`
- **worktrees:** `../<repo>-research/<NNN>`, branch `research/<NNN>-<slug>`
- **directions worth trying first:** partial selection instead of a full sort; avoid recomputing the query's coordinates in the inner loop; batch the distance computation
- **directions not to try:** approximate search (the output must stay exact); C extensions or third-party packages (standard library only)
