#!/usr/bin/env bash
# Fake `pi` for tests: echoes a JSON-mode transcript whose final assistant text is
# derived from the prompt (last argument) and the FAKE_PI_REPLY env var. When
# --session-dir is given it also writes a pi-style session file there.
prompt="${@: -1}"
if [ -n "$FAKE_PI_FAIL" ]; then echo "boom" >&2; exit 3; fi
if [ -n "$FAKE_PI_SLEEP" ]; then sleep "$FAKE_PI_SLEEP"; fi
[ -n "$FAKE_PI_PROMPT_FILE" ] && printf '%s' "$prompt" > "$FAKE_PI_PROMPT_FILE"
[ -n "$FAKE_PI_ARGS_FILE" ] && printf '%s\n' "$@" > "$FAKE_PI_ARGS_FILE"
[ -n "$FAKE_PI_ENV_FILE" ] && env | grep '^PI_LOOPS' > "$FAKE_PI_ENV_FILE"
sessdir=""
prev=""
for a in "$@"; do [ "$prev" = "--session-dir" ] && sessdir="$a"; prev="$a"; done
reply="${FAKE_PI_REPLY:-ok <inbox>something new</inbox> <loop-state>seen: 1</loop-state>}"
case "$prompt" in *"You are the checker for a recurring loop"*) reply="${FAKE_PI_CHECKER_REPLY:-$reply}"; [ -n "$FAKE_PI_CHECKER_FAIL" ] && { echo "checker boom" >&2; exit 4; };; esac
python3 - "$reply" "$sessdir" "$prompt" <<'PY'
import json, sys, os, uuid, time
reply, sessdir, prompt = sys.argv[1], sys.argv[2], sys.argv[3]
sid = str(uuid.uuid4())
print(json.dumps({"type": "session", "version": 3, "id": sid, "cwd": os.getcwd()}))
print(json.dumps({"type": "agent_start"}))
asst = {"role": "assistant", "model": "fake/model", "stopReason": "stop", "usage": {"input": 10, "output": 5, "cost": {"total": 0.001}}, "content": [{"type": "text", "text": reply}]}
print(json.dumps({"type": "message_end", "message": {"role": "user", "content": [{"type": "text", "text": prompt}]}}))
print(json.dumps({"type": "message_end", "message": asst}))
print(json.dumps({"type": "agent_end", "messages": []}))
if sessdir:
    os.makedirs(sessdir, exist_ok=True)
    with open(os.path.join(sessdir, f"{time.strftime('%Y-%m-%dT%H-%M-%S')}_{sid}.jsonl"), "w") as f:
        f.write(json.dumps({"type": "session", "version": 3, "id": sid, "cwd": os.getcwd()}) + "\n")
        f.write(json.dumps({"type": "message", "id": "a", "message": {"role": "user", "content": prompt}}) + "\n")
        f.write(json.dumps({"type": "message", "id": "b", "parentId": "a", "message": {"role": "assistant", "content": [{"type": "toolCall", "id": "c1", "name": "bash", "arguments": {"command": "ls src"}}]}}) + "\n")
        f.write(json.dumps({"type": "message", "id": "c", "parentId": "b", "message": {"role": "toolResult", "toolCallId": "c1", "toolName": "bash", "isError": False, "content": [{"type": "text", "text": "a.ts\nb.ts"}]}}) + "\n")
        f.write(json.dumps({"type": "message", "id": "d", "parentId": "c", "message": asst}) + "\n")
PY
