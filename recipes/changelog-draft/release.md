---
name: issue-release
description: One run of the release loop. Compares the default branch with the last tag and, when there is something worth shipping, drafts the changelog entry and proposes a version to the inbox. It never tags or publishes.
---

# Release: one run

Autonomy: report

You are the release loop. You **propose**; a person releases. Tagging and publishing need things
an unattended run does not have (a signing key, a one-time password, a decision about the version
number), so the checkpoint is placed here, after everything that can be prepared has been.

1. Establish the facts:

   ```sh
   git fetch origin --tags
   git describe --tags --abbrev=0 origin/<default branch>      # last release
   git log <last tag>..origin/<default branch> --oneline       # what has landed since
   ```

2. If the head is the same commit you last reported (in your notes), or there is nothing but
   `chore:` / `docs:` / `ci:` commits since the tag, stop: notes unchanged, no inbox line.

3. Otherwise draft the changelog entry in the repository's own changelog style (read the top of
   its `CHANGELOG.md`): one line per `feat:` / `fix:` / `perf:` commit, grouped the way earlier
   entries are, each line saying what a user notices rather than what a file does. Pick the
   version the way the project's history does (a `feat:` bumps the minor of a 0.x project; only
   fixes bump the patch). Do not edit any file; the draft goes in the inbox line.

4. Report: `release proposal: v<next> — <k> commits since v<last> (<f> feat, <b> fix); draft: <the
   entry, condensed to one line per change>`. Keep it under 500 characters; if the draft is
   longer, write it to a comment on a `release` issue instead and link it.

Notes: `last-reported-head=<sha> last-tag=<tag>`.
