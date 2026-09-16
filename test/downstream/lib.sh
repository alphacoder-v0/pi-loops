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
	stop_pi
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

# ---------------------------------------------------------------- a pi, driven over rpc
# `/recipe add` is the one install that creates the jobs, and it needs a pi: `pi --mode rpc` is pi
# with JSON lines in and out instead of a terminal (pi's own docs/rpc.md), so a check can type the
# slash command and answer the confirmation the way a person would. The pi is started in $PROJECT
# with this checkout as its extension and the stand-in as its model; its loops run in that pi.

# `git_project`: $PROJECT as a repository with one commit, so a run has something to commit onto.
git_project() {
	(cd "$PROJECT" && git init -q && git -c user.name=fixture -c user.email=fixture@example.com commit -q --allow-empty -m init)
}

start_pi() {
	mkfifo "$ROOT/rpc.in"
	(cd "$PROJECT" && pi --mode rpc -e "$REPO" --model fake/fake-model <"$ROOT/rpc.in" >"$ROOT/rpc.out" 2>"$ROOT/rpc.err") &
	PI_PID=$!
	exec 3>"$ROOT/rpc.in"
	wait_for_line "took over the loop scheduler" 30 || fail "pi did not start its scheduler (see $ROOT/rpc.err)"
}

# `rpc_send <json line>`
rpc_send() { printf '%s\n' "$1" >&3; }

# `wait_for_line <text> <seconds>`: 0 once pi has printed a line containing <text>.
wait_for_line() {
	i=0
	while ! grep -q -F "$1" "$ROOT/rpc.out" 2>/dev/null; do
		[ "$i" -ge $(($2 * 5)) ] && return 1
		sleep 0.2
		i=$((i + 1))
	done
	return 0
}

# `install_recipe <dir> <level>`: `/recipe add <dir> --level <level>`, and yes to the confirmation.
install_recipe() {
	rpc_send "{\"id\":\"install\",\"type\":\"prompt\",\"message\":\"/recipe add $1 --level $2\"}"
	wait_for_line '"method":"confirm"' 30 || { fail "no confirmation asked for /recipe add"; return 1; }
	id=$(grep -F '"method":"confirm"' "$ROOT/rpc.out" | head -1 | jq -r .id)
	rpc_send "{\"type\":\"extension_ui_response\",\"id\":\"$id\",\"confirmed\":true}"
	wait_for_line '"id":"install","type":"response"' 30 || { fail "/recipe add did not finish"; return 1; }
}

# SIGKILL on purpose: a pi that quits cleanly hands its loops to a headless host, and a host that
# outlives the check would keep running the fixture every minute.
stop_pi() {
	[ -n "${PI_PID:-}" ] || return 0
	exec 3>&-
	kill -9 "$PI_PID" 2>/dev/null
	pkill -9 -f "$ROOT/rpc.in" 2>/dev/null
	wait "$PI_PID" 2>/dev/null
	PI_PID=
}
