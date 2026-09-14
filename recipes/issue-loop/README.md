# issue-loop — an issue-driven iteration loop for a repository

Three files a stateful loop reads, one script that creates the labels they move issues through.
The design, the state machine and how to install it in a project are in
[docs/recipes.md](../../docs/recipes.md#issue-loop).

| file | read by | what one run does |
|---|---|---|
| [triage.md](triage.md) | the `issue-triage` loop | evaluates new and replied-to issues, verifies claims, writes agent briefs, recommends the next state |
| [implement.md](implement.md) | the `issue-implement` loop | resumes cut-off work, addresses review feedback, claims one `ready-for-agent` issue, opens a pull request |
| [labels.sh](labels.sh) | you, once per repository | creates the category and state labels (idempotent) |

Install it with `/recipe add issue-loop` in a pi opened in the repository: the wizard asks for the
autonomy level, copies the playbooks to `.agents/skills/issue-loop/`, runs `labels.sh` after
showing it, and creates the jobs. Each job's prompt is a pointer to its playbook, so the procedure
is read fresh on every run and a person can edit it in place.
