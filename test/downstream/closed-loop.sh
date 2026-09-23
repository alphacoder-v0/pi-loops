#!/bin/sh
# The proof docs/downstream.md is enough: the fixture recipe in fixture-recipe/ goes round once
# using only what that page lists. Installed from its directory with `/recipe add` (in a pi driven
# over rpc — the install that creates the job needs one); its run, played by the stand-in model,
# creates a file in the project and commits it, then files one checkpoint; the fixture's run_end
# hook finds that finding by PI_RUN_ID with `pi-loops inbox list --json` and claims it. This script
# then checks that all of it happened: the file, the commit, the finding claimed. Nothing here reads
# or writes a private file.
. "$(dirname "$0")/lib.sh"
fresh_home
FIXTURE="$HERE/fixture-recipe"
export PI_LOOPS FIXTURE_LOG="$ROOT/claimed.txt"

cat > "$PI_LOOPS_DIR/hooks.toml" <<HOOKS
[[hook]]
event = "run_end"
command = 'cp "\$PI_HOOK_PAYLOAD" "$ROOT/run_end.json"; sh "$FIXTURE/on-run-end.sh"; touch "$ROOT/run_end.done"'
HOOKS

# The run's one action, played by the stand-in as a bash call; then its reply, the checkpoint.
export FAKE_MODEL_TOOL_COMMAND='printf "from a run\n" > downstream.txt && git add downstream.txt && git -c user.name=fixture -c user.email=fixture@example.com commit -q -m "downstream fixture"'
start_model '<inbox>downstream.txt committed · waits: a person marks this handled · if not: nothing</inbox><loop-state>done</loop-state>' || finish
git_project
start_pi

echo "install from the directory"
install_recipe "$FIXTURE" report
[ -f "$PROJECT/.agents/skills/downstream-fixture/commit-and-ask.md" ] && ok "playbook installed" || fail "playbook not installed"

echo "one run: a file, a commit, a checkpoint (the job fires a minute after the install)"
wait_for "$ROOT/run_end.done" 150 || fail "the run never ended (see $ROOT/rpc.out and $ROOT/rpc.err)"
stop_pi
[ -f "$PROJECT/downstream.txt" ] && ok "downstream.txt exists" || fail "downstream.txt is not in the project"
expect_eq "commit" "$(cd "$PROJECT" && git log --format=%s -1)" "downstream fixture"
expect_eq "run_end payload" "$(jq -c '[.event, .run_job, .run_ok, .run_findings]' "$ROOT/run_end.json")" '["run_end","downstream-fixture",true,1]'

echo "the hook claimed the finding"
[ -s "$FIXTURE_LOG" ] && ok "hook claimed $(wc -l < "$FIXTURE_LOG" | tr -d ' ') finding(s)" || fail "the hook claimed nothing"
# This run's finding, not "no finding anywhere". The job is `every 1m`, and an `every` job whose
# run outlasts its interval is due the moment it finishes, so a second run can already be in
# flight — its own run_end hook not yet run — when this line executes. That finding is the second
# run's to claim; what this check proves is that the first run's hook claimed the first run's.
RUN=$(jq -r .run_id "$ROOT/run_end.json")
expect_eq "this run's findings are all claimed" "$(cd "$PROJECT" && $PI_LOOPS inbox list --json | jq --arg run "$RUN" '[.findings[] | select(.run_id == $run)] | length')" 0
