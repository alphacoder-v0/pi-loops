# ci-sweeper — a red default branch, reported or repaired

| file | what it is |
|---|---|
| [recipe.toml](recipe.toml) | one job every 15 minutes, 40-minute timeout, `report` or `propose` |
| [sweep.md](sweep.md) | the playbook: latest run → failure signature → finding, or worktree, fix, checks, pull request |

The failure signature is the memory: the same red reported once, the same failure attempted at
most twice, and a test never skipped or deleted to get to green.
