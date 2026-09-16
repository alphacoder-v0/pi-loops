#!/bin/sh
# The fixture's run_end hook: the other half of the closed loop. A run just ended; every finding it
# filed is marked handled. Uses only what docs/downstream.md lists: the PI_RUN_* variables and
# `pi-loops inbox … --json`. Runs in the project (hooks.toml `cwd = "project"`, the default), so
# `list` is this project's findings.
#
#   PI_LOOPS      the command (default: pi-loops on PATH)
#   FIXTURE_LOG   where to say what was claimed, one id per line, for a check to read
set -u
PI_LOOPS=${PI_LOOPS:-pi-loops}
[ "${PI_RUN_OK:-}" = true ] || exit 0
for id in $($PI_LOOPS inbox list --json | jq -r --arg run "$PI_RUN_ID" '.findings[] | select(.run_id == $run) | .id'); do
	$PI_LOOPS inbox claim "$id" --json | jq -r '.finding.id' >> "${FIXTURE_LOG:-/dev/null}"
done
