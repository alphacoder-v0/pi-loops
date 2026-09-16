#!/bin/sh
# docs/downstream.md §2: a run_start and a run_end rule in hooks.toml fire around a scheduled run,
# with the named PI_RUN_* variables and a JSON payload; a rule that fails does not fail the run.
. "$(dirname "$0")/lib.sh"
fresh_home

cat > "$PI_LOOPS_DIR/hooks.toml" <<EOF
[[hook]]
event = "run_start"
command = 'cp "\$PI_HOOK_PAYLOAD" "$ROOT/run_start.json"; echo "\$PI_HOOK_EVENT \$PI_RUN_JOB \$PI_RUN_ID" >> "$ROOT/events.txt"'

[[hook]]
event = "run_start"
command = 'exit 1'

[[hook]]
event = "run_end"
command = 'cp "\$PI_HOOK_PAYLOAD" "$ROOT/run_end.json"; echo "\$PI_HOOK_EVENT \$PI_RUN_JOB \$PI_RUN_ID ok=\$PI_RUN_OK findings=\$PI_RUN_FINDINGS error=\$PI_RUN_ERROR" >> "$ROOT/events.txt"'
EOF

start_model 'done <inbox>one thing · waits: a person decides</inbox> <inbox>another thing</inbox> <loop-state>seen: 1</loop-state>' || finish
seed_loop downstream-probe
start_host
wait_for "$ROOT/run_end.json" 60 || fail "run_end never fired (host log: $(tail -5 "$PI_LOOPS_DIR/host.log" 2>/dev/null))"
stop_host

echo "the command sees the run in its environment"
expect_eq "run_start line" "$(grep '^run_start' "$ROOT/events.txt" | sed 's/run-[0-9a-f]\{32\}/run-ID/')" "run_start downstream-probe run-ID"
expect_eq "run_end line" "$(grep '^run_end' "$ROOT/events.txt" | sed 's/run-[0-9a-f]\{32\}/run-ID/')" "run_end downstream-probe run-ID ok=true findings=2 error="
START_ID=$(awk '/^run_start/ { print $3 }' "$ROOT/events.txt")
END_ID=$(awk '/^run_end/ { print $3 }' "$ROOT/events.txt")
expect_eq "one run id for both" "$START_ID" "$END_ID"

echo "the payload file says the same"
expect_eq "run_start payload" "$(jq -c '[.event, .run_job, (.run_id | test("^run-[0-9a-f]{32}$")), .run_ok, .run_findings, .run_error, .run_cost_usd]' "$ROOT/run_start.json")" '["run_start","downstream-probe",true,null,null,null,null]'
expect_eq "run_end payload" "$(jq -c '[.event, .run_job, .run_id, .run_ok, .run_findings, .run_error, (.run_cost_usd | type)]' "$ROOT/run_end.json")" "[\"run_end\",\"downstream-probe\",\"$END_ID\",true,2,null,\"number\"]"

echo "a failing rule does not fail the run"
expect_eq "run_ok despite the exit 1 rule" "$(jq -r .run_ok "$ROOT/run_end.json")" true
