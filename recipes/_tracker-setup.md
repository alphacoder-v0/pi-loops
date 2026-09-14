`/recipe add {recipe}` stopped before installing anything: that recipe's playbooks read `docs/agents/issue-tracker.md` on every run to learn where this project's work items live and how to list, read, comment on, label and close them — and `{project}` has no such file yet. Write it with me now. This is a conversation, not a template fill: explore first, propose, and write only after I have agreed.

1. **Explore.** Run `git remote -v` in `{project}`. Look for an existing `.scratch/` directory (a sign the local Markdown tracker is already in use), and for an `## Agent skills` section in `AGENTS.md` or `CLAUDE.md` (a sign Matt Pocock's engineering skills were set up here; if so, their `docs/agents/issue-tracker.md` convention is the one we are writing, and it may already be partly there).

2. **Propose, one question.** Lead with the recommendation so I can accept it in a word:
   - a GitHub remote → recommend **GitHub Issues** (the `gh` CLI; check `gh auth status` works);
   - no remote, or I say so → recommend **local Markdown**: one file per item under `.scratch/issues/`, a `**Status:**` line as the state.
   Anything else (GitLab, Jira, Linear): ask me to describe the workflow in a paragraph and record it as prose.

3. **Write `docs/agents/issue-tracker.md`** from the matching template in `{templates}/` (`issue-tracker-github.md` or `issue-tracker-local.md`), adjusted to what we agreed. Show me the draft before writing. Keep the state vocabulary section as it is: the playbooks name those states. The file stays out of the repository (the wizard lists it in `.git/info/exclude`, like the playbooks), but it is still read by every run: keep it to how the tracker works — no secrets, no tokens.

4. **Stop there.** The wizard is waiting for this file: as soon as this turn ends with it in place, `/recipe add {recipe}` resumes on its own — the level question, the setup script, the confirmation. Do not create cron jobs, labels, worktrees or branches yourself, and do not tell me to run anything; the wizard does the rest after showing me exactly what it will do.
