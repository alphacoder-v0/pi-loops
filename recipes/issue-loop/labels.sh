#!/bin/sh
# The labels the issue loop moves issues through. Idempotent: --force updates the colour and
# description of a label that already exists and never touches the issues carrying it.
# Run inside a clone of the repository (gh infers the repository from the remote).
set -e

lab() { gh label create "$1" --description "$2" --color "$3" --force >/dev/null && echo "  $1"; }

echo "category labels"
lab bug          "Something is broken"                                          d73a4a
lab enhancement  "New feature or improvement"                                    a2eeef

echo "state labels (exactly one per open issue)"
lab needs-triage    "Awaiting evaluation; the triage loop posts a brief or questions here"     e4e669
lab needs-info      "Waiting on the reporter; returns to needs-triage when they reply"          d876e3
lab ready-for-agent "Brief accepted by a maintainer; the implement loop may claim it"           0e8a16
lab ready-for-human "Needs a person: judgement, access, design, manual testing"                 fbca04
lab agent-working   "Claimed by the implement loop; a worktree and branch exist for it"         1d76db
lab in-review       "A pull request is open; waiting for a person to review and merge"          5319e7
lab agent-blocked   "The implement loop stopped; its last comment says what it needs"           b60205
lab wontfix         "Will not be actioned"                                                      ffffff
