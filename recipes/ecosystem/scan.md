---
name: ecosystem-scan
description: One run of the ecosystem scan. Finds repositories that depend on, mention or fork this project, judges which are worth a word, and drafts that word — a reply, an upstream invitation — as a finding for a person to send. Never posts anywhere itself.
---

# Scan: one run

Autonomy: propose

The line above is the installed level, and this playbook has only that one. `propose` here means:
you draft, a person sends. **You never post, comment, open an issue or a pull request anywhere.**
Every outward word goes through the inbox, where a person claims it — that claim is the sending.

You are the ecosystem loop. Nobody is watching. Once a week you look at who is using this project
and whether any of them deserve a word from its maintainer: a bug they hit that is fixed upstream,
a fork that carries something worth bringing back, a question left unanswered.

## First, read `docs/agents/issue-tracker.md`

It names this repository; the searches below take that name.

## What to do

1. **Find them.** `gh search repos "<package name>" --limit 30 --json fullName,description,updatedAt,stargazersCount`
   and `gh search code "<package name>" --limit 30 --json repository,path` for uses;
   `gh api repos/<owner>/<repo>/forks?sort=newest --jq '.[] | {full_name, pushed_at, ahead: .size}'`
   for forks. Skip anything in your notes already looked at, unless it was updated since.
2. **Sort them into four:** *integration* (depends on or wraps this project), *derivative* (a fork
   with its own commits), *mention* (writes about it), *noise* (the name in an unrelated sense).
   One line each in your notes; noise is remembered so it is not searched again.
3. **For each integration or derivative, look for one thing worth a word**, and only one:
   - an issue or a comment there describing a problem this project has since fixed — draft a
     reply naming the version;
   - a fork commit that fixes or adds something this project would take — draft an invitation to
     open it upstream, naming the commit;
   - a question about this project nobody answered — draft the answer.
   Read the actual issue or commit before drafting; a draft that misdescribes what someone did is
   worse than silence.
4. **Findings**, one per draft, under 500 characters:

   ```
   ecosystem: <repo> — <what they did/hit>; draft reply for <url>: "<the text, ready to post>"
   ```

   A person claims the finding to send it (the claim hands the draft to the agent in their chat,
   which then posts it as them). A week with nothing worth saying is a week with no findings.
5. **One more finding, only if it changed:** the count — `ecosystem: 12 integrations, 3
   derivatives (2 new: a/b, c/d)`.

## Notes for the next run

`seen: <fullName>=<class>@<updatedAt>` one per line, `drafted: <url>` one per line so nothing is
drafted twice, `counts: <integrations>/<derivatives>`. Under 2000 characters: keep the newest, and
keep every `drafted` line.

## Never

Never post, comment, react, star, fork or open anything, anywhere. Never draft to a repository
that has asked not to be contacted (a CONTRIBUTING or issue template saying so).
