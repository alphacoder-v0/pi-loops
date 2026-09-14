# pr-watch — what changed about the open pull requests

| file | what it is |
|---|---|
| [recipe.toml](recipe.toml) | one job every 15 minutes, `report` or `propose` |
| [watch.md](watch.md) | the playbook: one state per pull request, a finding only when it changes or a stall reaches another day |

Under `propose` the loop may leave one comment on a pull request that has waited on the same
person for more than two days — one per stall, remembered in its notes, never a second.
