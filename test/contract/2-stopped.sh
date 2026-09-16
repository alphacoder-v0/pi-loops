#!/bin/sh
# CONTRACT.md §5.2, the stopped-machine check: with no pi and no host running, every write the
# contract allows a program still goes through — a hooks.toml rule (a file), a recipe install
# (`pi-loops recipe add`, which copies files), and a dismiss (`pi-loops inbox dismiss`). The one
# finding to dismiss comes from a run in the host, which is then stopped before the write.
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../downstream/lib.sh"
HERE="$REPO/test/downstream" # lib.sh's helpers find fake-model.mjs and the fixture by $HERE
fresh_home

# `nothing_running <what>`: the host this check started is gone and no rpc pi was started.
nothing_running() {
	if [ -n "${HOST_PID:-}" ] && kill -0 "$HOST_PID" 2>/dev/null; then fail "$1: the host is still running"; return 1; fi
	if [ -n "${PI_PID:-}" ]; then fail "$1: a pi is running"; return 1; fi
	ok "$1: no pi, no host"
}

echo "write 1: a hooks.toml rule"
nothing_running "before hooks.toml"
cat > "$PI_LOOPS_DIR/hooks.toml" <<EOF
[[hook]]
event = "run_end"
command = 'cp "\$PI_HOOK_PAYLOAD" "$ROOT/run_end.json"'
EOF
[ -s "$PI_LOOPS_DIR/hooks.toml" ] && ok "hooks.toml written" || fail "hooks.toml not written"

echo "write 2: a recipe installed from a directory"
nothing_running "before recipe add"
$PI_LOOPS recipe add "$HERE/fixture-recipe" --cwd "$PROJECT" --level report >"$ROOT/add.out" 2>&1
expect_eq "recipe add exit" "$?" 0
[ -f "$PROJECT/.agents/skills/downstream-fixture/commit-and-ask.md" ] && ok "playbook installed" || fail "playbook not installed: $(cat "$ROOT/add.out")"

echo "a run, so there is a finding (the host is a mechanism; it is stopped before the write)"
start_model 'done <inbox>stopped-check · waits: nobody</inbox> <loop-state>seen</loop-state>' || finish
seed_loop stopped-probe
start_host
wait_for "$ROOT/run_end.json" 60 || fail "the run never ended (host log: $(tail -5 "$PI_LOOPS_DIR/host.log" 2>/dev/null))"
stop_host

echo "write 3: dismiss with nothing running"
nothing_running "before dismiss"
ID=$($PI_LOOPS inbox list --all --json | jq -r '.findings[0].id')
[ -n "$ID" ] && [ "$ID" != null ] && ok "one finding to dismiss" || fail "no finding was filed"
$PI_LOOPS inbox dismiss "$ID" --reason "stopped check" --json >"$ROOT/dismiss.json"
expect_eq "dismiss exit" "$?" 0
expect_eq "dismissed" "$(jq -c '.finding | [.status, .dismiss_reason]' "$ROOT/dismiss.json")" '["dismissed","stopped check"]'
expect_eq "nothing new is left" "$($PI_LOOPS inbox list --all --json | jq '.findings | length')" 0
