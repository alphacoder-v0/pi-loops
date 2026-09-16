#!/bin/sh
# docs/downstream.md §3: `pi-loops inbox list|claim|dismiss --json` with no pi open. The findings
# come from a real run (the stand-in model files two), so the shape read here is the shape a run
# produces, and its run_id is the one the run_end hook saw.
. "$(dirname "$0")/lib.sh"
fresh_home

cat > "$PI_LOOPS_DIR/hooks.toml" <<EOF
[[hook]]
event = "run_end"
command = 'cp "\$PI_HOOK_PAYLOAD" "$ROOT/run_end.json"'
EOF
start_model 'done <inbox>a decision · waits: your label</inbox> <inbox>some news</inbox> <loop-state>seen: 1</loop-state>' || finish
seed_loop downstream-probe
start_host
wait_for "$ROOT/run_end.json" 60 || fail "the run never ended (host log: $(tail -5 "$PI_LOOPS_DIR/host.log" 2>/dev/null))"
stop_host
RUN_ID=$(jq -r .run_id "$ROOT/run_end.json")

echo "list: this project's new findings, checkpoints first, in the fixed shape"
$PI_LOOPS inbox list --cwd "$PROJECT" --json >"$ROOT/list.json"
expect_eq "list exit" "$?" 0
expect_eq "count" "$(jq '.findings | length' "$ROOT/list.json")" 2
expect_eq "keys" "$(jq -c '.findings[0] | keys_unsorted' "$ROOT/list.json")" '["id","created_at","status","kind","source","run_id","cwd","text","verified","dismiss_reason"]'
expect_eq "order and kinds" "$(jq -c '[.findings[] | [.kind, .text]]' "$ROOT/list.json")" '[["checkpoint","a decision · waits: your label"],["news","some news"]]'
expect_eq "every finding is new, unverified, undismissed" "$(jq -c '[.findings[] | [.status, .verified, .dismiss_reason]] | unique' "$ROOT/list.json")" '[["new",null,null]]'
expect_eq "source" "$(jq -r '.findings[0].source' "$ROOT/list.json")" "cron:downstream-probe"
expect_eq "cwd" "$(jq -r '.findings[0].cwd' "$ROOT/list.json")" "$PROJECT"
expect_eq "run_id is the hook's PI_RUN_ID" "$(jq -r '[.findings[].run_id] | unique | .[0]' "$ROOT/list.json")" "$RUN_ID"
expect_eq "ids have the documented shape" "$(jq -c '[.findings[].id | test("^inb-[0-9a-f]{32}$")] | unique' "$ROOT/list.json")" '[true]'
expect_eq "created_at parses" "$(jq -c '[.findings[].created_at | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}[+-][0-9]{2}:[0-9]{2}$")] | unique' "$ROOT/list.json")" '[true]'

echo "list is per project unless --all"
expect_eq "another directory sees nothing" "$($PI_LOOPS inbox list --cwd "$ROOT/home" --json | jq '.findings | length')" 0
expect_eq "--all sees everything" "$($PI_LOOPS inbox list --cwd "$ROOT/home" --all --json | jq '.findings | length')" 2

echo "claim: by id prefix, once"
DECISION=$(jq -r '.findings[0].id' "$ROOT/list.json")
NEWS=$(jq -r '.findings[1].id' "$ROOT/list.json")
$PI_LOOPS inbox claim --json "$(printf '%s' "$DECISION" | cut -c1-12)" >"$ROOT/claim.json"
expect_eq "claim exit" "$?" 0
expect_eq "claimed" "$(jq -c '.finding | [.id, .status, .kind]' "$ROOT/claim.json")" "[\"$DECISION\",\"claimed\",\"checkpoint\"]"
$PI_LOOPS inbox claim "$DECISION" --json >"$ROOT/claim2.json"
expect_eq "a second claim exits 1" "$?" 1
expect_eq "and says why" "$(jq -r '.error | type' "$ROOT/claim2.json")" string

echo "dismiss: with a reason the loop will hear"
$PI_LOOPS inbox dismiss "$NEWS" --reason "that file is generated" --json >"$ROOT/dismiss.json"
expect_eq "dismiss exit" "$?" 0
expect_eq "dismissed" "$(jq -c '.finding | [.id, .status, .dismiss_reason]' "$ROOT/dismiss.json")" "[\"$NEWS\",\"dismissed\",\"that file is generated\"]"

echo "a number is not an id"
$PI_LOOPS inbox claim 1 --json >"$ROOT/num.json"
expect_eq "numeric ref exits 1" "$?" 1
expect_eq "with an error" "$(jq -r '.error | type' "$ROOT/num.json")" string

echo "nothing new is left, and an unknown id is an error"
expect_eq "empty list" "$($PI_LOOPS inbox list --cwd "$PROJECT" --json)" '{"findings":[]}'
$PI_LOOPS inbox dismiss inb-nope --json >"$ROOT/nope.json"
expect_eq "unknown id exits 1" "$?" 1
expect_eq "with an error object" "$(jq -c 'keys' "$ROOT/nope.json")" '["error"]'
