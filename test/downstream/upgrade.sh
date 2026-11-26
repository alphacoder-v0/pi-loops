#!/bin/sh
# A loops directory that 0.24.2 left, started once from the outside: its jobs.json is version 2 with a
# loop three runs in, and no run log (it may have been removed), so the count lives only in the file.
# The start converts it, and turns the loop off: a pi of an older pi-loops that is still open would
# run it beside this one (owner decision, 2026-11-26). Not one of docs/downstream.md's three: the
# files read here are private. It is here because it is checked as a person meets it, with
# `pi-loops` and jq, and what it holds is that an upgrade keeps a person's loops off and says so,
# with the definition, the file before, and the count of runs, so the run after a person turns it on
# is the fourth. It also holds two claims 0.24.2 queued in a
# conversation: the one pi had before the upgrade stays claimed, and the one it never had is new again.
. "$(dirname "$0")/lib.sh"
fresh_home

cat > "$PI_LOOPS_DIR/jobs.json" <<JSON
{ "version": 2, "jobs": [ { "id": "cron-00000000000000000000000000000002", "name": "upgraded", "schedule": { "kind": "every", "ms": 60000 }, "stateful": true, "prompt": "report", "cwd": "$PROJECT", "enabled": true, "catchUp": true, "createdAt": "2026-01-01T00:00:00.000+00:00", "runCount": 3, "skippedOverlap": 1, "lastDueAt": "2026-01-01T00:03:00.000+00:00", "lastFiredAt": "2026-01-01T00:03:00.000+00:00", "consecutiveFailures": 0 } ] }
JSON
cp "$PI_LOOPS_DIR/jobs.json" "$ROOT/jobs.v2.json"
HANDED="inb-$(printf 'a%.0s' $(seq 32))"
UNHANDED="inb-$(printf 'b%.0s' $(seq 32))"
SESSION="01a1dce4-8ad1-77c0-89b0-475ccfeaf683"
for id in "$HANDED" "$UNHANDED"; do
	printf '{"id":"%s","created_at":"2026-01-01T00:04:00.000+00:00","status":"claimed","kind":"checkpoint","source":"cron:upgraded","run_id":"run-%s","cwd":"%s","text":"decide this","verified":null,"dismiss_reason":null,"claimed_by":"terminal"}\n' "$id" "${id#inb-}" "$PROJECT"
done >"$PI_LOOPS_DIR/inbox.jsonl"
mkdir -p "$PI_LOOPS_DIR/requests"
for id in "$HANDED" "$UNHANDED"; do
	handed=$([ "$id" = "$HANDED" ] && echo ',"handed_at":"2026-01-01T00:05:01.000+00:00"')
	printf '{"v":2,"session_id":"%s","id":"claim-%s","kind":"input","source":"inbox:%s","mode":"attended","wake":"turn","payload":{"text":"[Trigger claim] look into it","cwd":"%s"},"created_by":{"pid":2000000000,"instance":"w","version":"0.24.2"},"created_at":"2026-01-01T00:05:00.000+00:00","attempts":0%s}\n' "$SESSION" "${id#inb-}" "$id" "$PROJECT" "$handed"
done >"$PI_LOOPS_DIR/requests/$SESSION.jsonl"
cat > "$PI_LOOPS_DIR/hooks.toml" <<TOML
[[hook]]
event = "run_end"
command = 'cp "\$PI_HOOK_PAYLOAD" "$ROOT/run_end.json"'
TOML
start_model 'done <loop-state>seen: 4</loop-state>' || finish
start_host
i=0
while [ "$(jq -c .version "$PI_LOOPS_DIR/jobs.json" 2>/dev/null)" != 3 ]; do [ "$i" -ge 100 ] && break; sleep 0.2; i=$((i + 1)); done
sleep 3

echo "the upgrade turns the loop off, runs nothing, and says so"
expect_eq "the loop is off, for the upgrade" "$(jq -c '.jobs[0] | [.enabled, .disabled.code]' "$PI_LOOPS_DIR/jobs.json")" '[false,"upgrade"]'
[ ! -e "$ROOT/run_end.json" ] || fail "a run ran after the upgrade turned the loop off"
STATUS=$($PI_LOOPS status 2>&1 | head -n 1)
case "$STATUS" in
	"pi-loops turned off 1 loop when it upgraded this loops directory"*"/cron enable <id> (cron-00000000000000000000000000000002)."*) ok "status line" ;;
	*) fail "status does not say what the upgrade turned off: $STATUS" ;;
esac

echo "a person turns it on, and it runs"
jq '.jobs[0].enabled = true | del(.jobs[0].disabled)' "$PI_LOOPS_DIR/jobs.json" >"$ROOT/jobs.on.json" && mv "$ROOT/jobs.on.json" "$PI_LOOPS_DIR/jobs.json"
wait_for "$ROOT/run_end.json" 90 || fail "the run never ended (host log: $(tail -5 "$PI_LOOPS_DIR/host.log" 2>/dev/null))"
stop_host
[ -z "$($PI_LOOPS status 2>&1 | grep -F 'pi-loops turned off')" ] || fail "status still says it is off"

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

echo "a claim 0.24.2 queued and never handed to pi is new again; the one pi had stays claimed"
expect_eq "the new findings of the two claims" "$($PI_LOOPS inbox list --all --json | jq -c --arg a "$HANDED" --arg b "$UNHANDED" '[.findings[] | select(.id == $a or .id == $b) | [.id, .status]]')" "[[\"$UNHANDED\",\"new\"]]"
finish
