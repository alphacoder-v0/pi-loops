#!/bin/sh
# A loops directory that 0.24.2 left, with a pi-loops 0.22 window still open in it: its presence
# entry, as v0.22.8 writes one every 30 s, names a live process. pi-loops in the background starts,
# and while that process lives it converts nothing and runs nothing (one version at a time,
# src/older.ts), and `pi-loops status` says why. Once the process is gone, it converts the
# directory and runs the loop. Not one of docs/downstream.md's three: the files read here are private.
. "$(dirname "$0")/lib.sh"
fresh_home

cat > "$PI_LOOPS_DIR/jobs.json" <<JSON
{ "version": 2, "jobs": [ { "id": "cron-00000000000000000000000000000003", "name": "waits", "schedule": { "kind": "every", "ms": 60000 }, "stateful": true, "prompt": "report", "cwd": "$PROJECT", "enabled": true, "catchUp": true, "createdAt": "2026-01-01T00:00:00.000+00:00", "runCount": 0, "consecutiveFailures": 0 } ] }
JSON
cat > "$PI_LOOPS_DIR/hooks.toml" <<TOML
[[hook]]
event = "run_end"
command = 'cp "\$PI_HOOK_PAYLOAD" "$ROOT/run_end.json"'
TOML
# The 0.22 window: a process that lives, and the entry it would write.
sleep 300 &
OLD_PID=$!
mkdir -p "$PI_LOOPS_DIR/presence"
printf '{"pid":%s,"host":"%s","instance":"old","sessionId":"s-old","cwd":"%s","kind":"interactive","heartbeatAt":"%s"}\n' "$OLD_PID" "$(hostname)" "$PROJECT" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" >"$PI_LOOPS_DIR/presence/old.json"
# And pi-loops 0.22 in the background, which a 0.22 window starts when it closes: a process that runs
# the background entry, with its presence entry. Nobody sees it, so pi-loops stops it as an upgrade does.
mkdir -p "$ROOT/old-pkg/src"
echo 'setInterval(() => {}, 1000);' >"$ROOT/old-pkg/src/host-entry.mjs"
node "$ROOT/old-pkg/src/host-entry.mjs" &
OLD_BG=$!
printf '{"pid":%s,"host":"%s","instance":"bg","cwd":"","kind":"host","heartbeatAt":"%s"}\n' "$OLD_BG" "$(hostname)" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" >"$PI_LOOPS_DIR/presence/old-bg.json"
# 0.22.8's own record of it, which names the pid and the entry it runs.
printf '{"pid":%s,"host":"%s","startedAt":"%s","node":"node","entry":"%s"}\n' "$OLD_BG" "$(hostname)" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$ROOT/old-pkg/src/host-entry.mjs" >"$PI_LOOPS_DIR/host.json"

start_model 'done <loop-state>seen: 1</loop-state>' || finish
start_host
wait_for "$PI_LOOPS_DIR/host-service.json" 20 || fail "pi-loops in the background did not claim the directory (host out: $(tail -5 "$ROOT/host.out" 2>/dev/null))"
sleep 3

echo "while the 0.22 window is open, nothing is converted and nothing runs"
expect_eq "jobs.json is still version 2" "$(jq -c .version "$PI_LOOPS_DIR/jobs.json")" 2
[ -e "$PI_LOOPS_DIR/presence/old.json" ] || fail "the 0.22 window's presence entry was removed"
[ ! -e "$PI_LOOPS_DIR/runs.jsonl" ] || fail "a run started beside the 0.22 window: $(cat "$PI_LOOPS_DIR/runs.jsonl")"
ok "nothing converted, nothing run"

echo "pi-loops status says why, with the pid and what to do"
STATUS=$($PI_LOOPS status 2>&1 | head -n 1)
case "$STATUS" in
	*"is waiting: a pi window with pi-loops 0.22 (pid $OLD_PID, $PROJECT) is still open. Close it"*) ok "status line" ;;
	*) fail "status does not say it waits: $STATUS" ;;
esac
$PI_LOOPS status 2>&1 | grep -q -F "is not answering" && fail "status calls the process that waits one that is not answering"
grep -q -F "is waiting: a pi window with pi-loops 0.22 (pid $OLD_PID" "$PI_LOOPS_DIR/host.log" || fail "the log does not say it waits"
ok "log line"

echo "while the 0.22 window is open, its background stays, as before"
kill -0 "$OLD_BG" 2>/dev/null || fail "pi-loops 0.22 in the background was stopped while its window is open"
ok "kept"

echo "once the 0.22 window is gone, pi-loops 0.22 in the background is asked to stop"
kill "$OLD_PID" 2>/dev/null
wait "$OLD_PID" 2>/dev/null
i=0
while kill -0 "$OLD_BG" 2>/dev/null; do [ "$i" -ge 225 ] && break; sleep 0.2; i=$((i + 1)); done
kill -0 "$OLD_BG" 2>/dev/null && fail "pi-loops 0.22 in the background (pid $OLD_BG) still runs"
grep -q -F "asked pi-loops 0.22 in the background (pid $OLD_BG) to stop" "$PI_LOOPS_DIR/host.log" || fail "the log does not say it stopped pi-loops 0.22 in the background"
ok "stopped"

echo "then it converts and runs the loop"
wait_for "$ROOT/run_end.json" 90 || fail "the loop never ran after the 0.22 window closed (host log: $(tail -5 "$PI_LOOPS_DIR/host.log" 2>/dev/null))"
stop_host
expect_eq "jobs.json is version 3" "$(jq -c .version "$PI_LOOPS_DIR/jobs.json")" 3
[ ! -e "$PI_LOOPS_DIR/presence" ] || fail "presence/ is still there after the conversion"
expect_eq "the loop ran once" "$(jq -s 'length' "$PI_LOOPS_DIR/runs.jsonl")" 1
finish
