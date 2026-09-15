# deps-sweeper — the dependencies, reported or bumped

| file | what it is |
|---|---|
| [recipe.toml](recipe.toml) | one job, Mondays at 08:00, 40-minute timeout, `report` or `propose` |
| [audit.md](audit.md) | the playbook: lockfile → package manager → audit and outdated → findings, or worktree, patch and minor bumps, checks, one pull request |

The advisory id and the package at a major version are the memory: each is reported once and
again only when it changes. Under `propose` a major is still never applied — it is a finding and a
person's decision — and the packages listed under **Never bump** in the playbook are not touched
at any level. The lockfile is written by the package manager, never by hand.
