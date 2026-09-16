#!/bin/sh
# CONTRACT.md §5.4, the private-state check: after one run, everything in the loops directory
# that §2.1 does not name as instance data is deleted; the host starts again, runs the loop
# again, and the findings from before are still there, field for field. Private state is
# whatever the tool can rebuild; if deleting it loses a finding or stops the clock, it was
# instance data hiding under a private name.
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../downstream/lib.sh"
HERE="$REPO/test/downstream" # lib.sh's helpers find fake-model.mjs by $HERE
fresh_home

# `wait_for_runs <n> <seconds>`: 0 once <n> run_end events have been appended.
wait_for_runs() {
	i=0
	while [ "$( { [ -f "$ROOT/runs.txt" ] && wc -l <"$ROOT/runs.txt" || echo 0; } | tr -d ' ')" -lt "$1" ]; do
		[ "$i" -ge $(($2 * 5)) ] && return 1
		sleep 0.2
		i=$((i + 1))
	done
	return 0
}

cat > "$PI_LOOPS_DIR/hooks.toml" <<EOF
[[hook]]
event = "run_end"
command = 'echo "\$PI_RUN_ID" >> "$ROOT/runs.txt"'
EOF
start_model 'done <inbox>kept · waits: a person</inbox> <inbox>also kept</inbox> <loop-state>seen: 1</loop-state>' || finish
seed_loop private-probe

echo "one run"
start_host
wait_for_runs 1 60 || fail "the first run never ended (host log: $(tail -5 "$PI_LOOPS_DIR/host.log" 2>/dev/null))"
stop_host
$PI_LOOPS inbox list --all --json | jq -S -c '.findings' >"$ROOT/before.json"
expect_eq "findings before" "$(jq length "$ROOT/before.json")" 2

echo "delete every private file and directory (§2.1: what is not instance data)"
for entry in "$PI_LOOPS_DIR"/* "$PI_LOOPS_DIR"/.[!.]*; do
	[ -e "$entry" ] || continue
	case "$(basename "$entry")" in
	jobs.json | triggers.json | inbox.jsonl | state | runs.jsonl | sessions | triggers-audit.jsonl | hooks.toml | config.toml | mcp.toml) ;;
	*)
		rm -rf "$entry"
		echo "  removed $(basename "$entry")"
		;;
	esac
done

echo "the host starts again and runs the loop again"
start_host
wait_for_runs 2 120 || fail "no second run after the private state was deleted (host log: $(tail -5 "$PI_LOOPS_DIR/host.log" 2>/dev/null))"
stop_host

echo "the findings from before are unchanged"
$PI_LOOPS inbox list --all --json | jq -S -c '.findings' >"$ROOT/after.json"
expect_eq "every earlier finding is still listed as it was" "$(jq -n --argjson a "$(cat "$ROOT/before.json")" --argjson b "$(cat "$ROOT/after.json")" '($a - $b) | length')" 0
expect_eq "the notes survived (the second run saw the first run's state)" "$([ -s "$PI_LOOPS_DIR/state/cron-00000000000000000000000000000001.md" ] && echo yes || echo no)" yes
