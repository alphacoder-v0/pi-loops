# Shared by the checks in this directory. POSIX sh; needs node and jq; imports nothing of this
# package — `pi-loops` is driven as a command, the way a program downstream would drive it.
#
# Every check gets a fresh loops directory, agent directory and HOME, so nothing of the person
# running it is read or written. A loop is run against test/downstream/fake-model.mjs, a loopback
# stand-in for a model, in the headless host — the process that runs loops when no pi is open.

set -u

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
PI_LOOPS=${PI_LOOPS:-"node $REPO/src/cli-entry.mjs"}

for tool in node jq; do
	command -v "$tool" >/dev/null 2>&1 || { echo "$0: needs $tool on PATH" >&2; exit 2; }
done

failures=0
fail() {
	echo "  FAIL: $*" >&2
	failures=$((failures + 1))
}
ok() { echo "  ok: $*"; }

# `expect_eq <what> <got> <want>`
expect_eq() {
	if [ "$2" = "$3" ]; then ok "$1 = $2"; else fail "$1: got '$2', want '$3'"; fi
}

# The three directories a run touches, all under one temporary root.
fresh_home() {
	ROOT=$(mktemp -d "${TMPDIR:-/tmp}/pi-loops-downstream.XXXXXX")
	PROJECT="$ROOT/project"
	mkdir -p "$ROOT/loops" "$ROOT/agent" "$ROOT/home" "$PROJECT"
	export PI_LOOPS_DIR="$ROOT/loops" PI_CODING_AGENT_DIR="$ROOT/agent" HOME="$ROOT/home"
	trap 'finish' EXIT
}

finish() {
	stop_host
	[ -n "${MODEL_PID:-}" ] && kill "$MODEL_PID" 2>/dev/null
	if [ "$failures" -eq 0 ] && [ -z "${PI_LOOPS_KEEP_TMP:-}" ]; then
		rm -rf "$ROOT"
	else
		echo "  kept for inspection: $ROOT" >&2
	fi
	exit "$([ "$failures" -eq 0 ] && echo 0 || echo 1)"
}

# `start_model <reply>`: the stand-in model answers every request with <reply>, and pi's agent
# directory is told about it (models.json is pi's own file, documented by pi).
start_model() {
	FAKE_MODEL_REPLY="$1" node "$HERE/fake-model.mjs" "$ROOT/model.port" &
	MODEL_PID=$!
	wait_for "$ROOT/model.port" 10 || { fail "the stand-in model did not start"; return 1; }
	cat > "$PI_CODING_AGENT_DIR/models.json" <<EOF
{ "providers": { "fake": { "baseUrl": "http://127.0.0.1:$(cat "$ROOT/model.port")/v1", "api": "openai-completions", "apiKey": "fake", "models": [ { "id": "fake-model" } ] } } }
EOF
}

# `seed_loop <name>`: one stateful loop in $PROJECT, due since long ago, so the host runs it once at
# startup. This writes jobs.json — the one place these checks touch a private file, because there is
# no command that creates a job without a pi open. It is a fixture, not a claim about the file: if
# the store changes shape, this function changes with it and nothing else here does.
seed_loop() {
	cat > "$PI_LOOPS_DIR/jobs.json" <<EOF
{ "version": 2, "jobs": [ { "id": "cron-00000000000000000000000000000001", "name": "$1", "schedule": { "kind": "every", "ms": 60000 }, "stateful": true, "prompt": "report", "cwd": "$PROJECT", "enabled": true, "catchUp": true, "createdAt": "2026-01-01T00:00:00.000+00:00", "runCount": 0, "skippedOverlap": 0 } ] }
EOF
}

# The headless host, with the stand-in as its model. Its log is $PI_LOOPS_DIR/host.log.
start_host() {
	PI_LOOPS_HOST_MODEL=fake/fake-model node --import "$REPO/src/register-pi.mjs" "$REPO/src/host-entry.mjs" >"$ROOT/host.out" 2>&1 &
	HOST_PID=$!
}

stop_host() {
	[ -n "${HOST_PID:-}" ] || return 0
	kill "$HOST_PID" 2>/dev/null
	wait "$HOST_PID" 2>/dev/null
	HOST_PID=
}

# `wait_for <file> <seconds>`: 0 once <file> exists, 1 if it never does.
wait_for() {
	i=0
	while [ ! -e "$1" ]; do
		[ "$i" -ge $(($2 * 5)) ] && return 1
		sleep 0.2
		i=$((i + 1))
	done
	return 0
}
