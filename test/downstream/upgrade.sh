#!/bin/sh
# A loops directory that 0.24.2 left, started once from the outside: its jobs.json is version 2 with a
# loop three runs in, and no run log (it may have been removed), so the count lives only in the file.
# The start converts it. Not one of docs/downstream.md's three: the files read
# here are private. It is here because it is checked as a person meets it, with `pi-loops` and jq,
# and what it holds is that an upgrade keeps a person's loops: the definition, the file before, and
# the count of runs, so the next run is the fourth.
. "$(dirname "$0")/lib.sh"
fresh_home

cat > "$PI_LOOPS_DIR/jobs.json" <<JSON
{ "version": 2, "jobs": [ { "id": "cron-00000000000000000000000000000002", "name": "upgraded", "schedule": { "kind": "every", "ms": 60000 }, "stateful": true, "prompt": "report", "cwd": "$PROJECT", "enabled": true, "catchUp": true, "createdAt": "2026-01-01T00:00:00.000+00:00", "runCount": 3, "skippedOverlap": 1, "lastDueAt": "2026-01-01T00:03:00.000+00:00", "lastFiredAt": "2026-01-01T00:03:00.000+00:00", "consecutiveFailures": 0 } ] }
JSON
cp "$PI_LOOPS_DIR/jobs.json" "$ROOT/jobs.v2.json"
cat > "$PI_LOOPS_DIR/hooks.toml" <<TOML
[[hook]]
event = "run_end"
command = 'cp "\$PI_HOOK_PAYLOAD" "$ROOT/run_end.json"'
TOML
start_model 'done <loop-state>seen: 4</loop-state>' || finish
start_host
wait_for "$ROOT/run_end.json" 60 || fail "the run never ended (host log: $(tail -5 "$PI_LOOPS_DIR/host.log" 2>/dev/null))"
stop_host

echo "jobs.json is version 3, definitions only"
jq -e '.version == 3' "$PI_LOOPS_DIR/jobs.json" >/dev/null || fail "jobs.json is not version 3: $(jq -c .version "$PI_LOOPS_DIR/jobs.json")"
ok "version 3"
expect_eq "no counter is left on the job" "$(jq -c '[.jobs[0] | keys[] | select(. == "runCount" or . == "skippedOverlap" or . == "lastDueAt" or . == "lastFiredAt" or . == "consecutiveFailures")]' "$PI_LOOPS_DIR/jobs.json")" '[]'
expect_eq "the definition is kept" "$(jq -c '.jobs[0] | [.id, .name, .prompt, .enabled]' "$PI_LOOPS_DIR/jobs.json")" '["cron-00000000000000000000000000000002","upgraded","report",true]'

echo "the version 2 file is kept beside it, byte for byte"
cmp -s "$ROOT/jobs.v2.json" "$PI_LOOPS_DIR/jobs.json.v2.bak" || fail "jobs.json.v2.bak is not the file 0.24.2 left"
ok "jobs.json.v2.bak"

echo "the loop's runs go on from 0.24.2's count, which only the version 2 file held"
expect_eq "the new run is the fourth" "$(tail -n 1 "$PI_LOOPS_DIR/runs.jsonl" | jq -r .ordinal)" 4
expect_eq "and it ran" "$(tail -n 1 "$PI_LOOPS_DIR/runs.jsonl" | jq -r .ok)" true
finish
