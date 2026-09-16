#!/bin/sh
# CONTRACT.md §5.3, the cross-check: each deterministic rule of §2.6, and the finding of §2.2, run
# through two implementations that share nothing, over samples taken from the repository rather
# than written for this check. Line for line equal is a pass. The repository's side is
# impl-a.mjs; the other side is tomllib, grep, awk and jq.
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../downstream/lib.sh"
CONTRACT="$HERE"
HERE="$REPO/test/downstream" # lib.sh's helpers find fake-model.mjs by $HERE
fresh_home
IMPL_A="node --import $REPO/src/register-pi.mjs $CONTRACT/impl-a.mjs"

# `same <what> <file-a> <file-b>`: ok when the two outputs are identical, else the diff.
same() {
	if cmp -s "$2" "$3"; then ok "$1"; else fail "$1"; diff "$2" "$3" | head -20 | sed 's/^/    /'; fi
}

echo "TOML: src/toml.ts against python3 tomllib, every recipe.toml and examples/mcp.toml"
for f in "$REPO"/recipes/*/recipe.toml "$REPO"/test/downstream/fixture-recipe/recipe.toml "$REPO"/examples/mcp.toml; do
	rel=${f#"$REPO"/}
	$IMPL_A toml "$f" 2>"$ROOT/a.err" | jq -S -c . >"$ROOT/a.json" 2>/dev/null || { fail "toml $rel: src/toml.ts could not parse it: $(head -1 "$ROOT/a.err")"; continue; }
	python3 -c 'import json, sys, tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], "rb"))))' "$f" | jq -S -c . >"$ROOT/b.json"
	same "toml $rel" "$ROOT/a.json" "$ROOT/b.json"
done

echo "kind: src/protocol.ts against grep, every <inbox> text the repository has ever shown"
(cd "$REPO" && git grep -ho '<inbox>[^<]*</inbox>' -- recipes docs test README.md README.zh-CN.md CHANGELOG.md) | sed 's/^<inbox>//; s/<\/inbox>$//; /^$/d' | sort -u >"$ROOT/texts"
[ -s "$ROOT/texts" ] && ok "$(wc -l <"$ROOT/texts" | tr -d ' ') sample texts" || fail "no <inbox> samples in the repository"
$IMPL_A kind <"$ROOT/texts" >"$ROOT/kind.a"
while IFS= read -r line; do
	if printf '%s\n' "$line" | grep -qiE '(^|[[:space:]])·[[:space:]]*waits:'; then echo checkpoint; else echo news; fi
done <"$ROOT/texts" >"$ROOT/kind.b"
same "kind over $(wc -l <"$ROOT/texts" | tr -d ' ') texts" "$ROOT/kind.a" "$ROOT/kind.b"

echo "level line: src/recipe.ts against awk, every playbook packaged or installed in this repository"
: >"$ROOT/level.a"
: >"$ROOT/level.b"
for f in "$REPO"/recipes/*/*.md "$REPO"/recipes/*/.orig/*.md "$REPO"/.agents/skills/*/*.md "$REPO"/.agents/skills/*/.orig/*.md "$REPO"/test/downstream/fixture-recipe/*.md; do
	[ -f "$f" ] || continue
	rel=${f#"$REPO"/}
	printf '%s\t%s\n' "$rel" "$($IMPL_A level "$f")" >>"$ROOT/level.a"
	# §2.6: the first line that is exactly `Autonomy: <one word>`; the level when that word is one of
	# the three, otherwise no level.
	printf '%s\t%s\n' "$rel" "$(awk '
		!done && /^Autonomy:[ \t]*[^ \t]+[ \t]*$/ { done = 1; w = $0; sub(/^Autonomy:[ \t]*/, "", w); sub(/[ \t]*$/, "", w); print (w == "report" || w == "propose" || w == "act") ? w : "-" }
		END { if (!done) print "-" }' "$f")" >>"$ROOT/level.b"
done
same "level line over $(wc -l <"$ROOT/level.a" | tr -d ' ') playbooks" "$ROOT/level.a" "$ROOT/level.b"

echo "finding: pi-loops inbox list --json against jq reading the findings file, after one real run"
cat > "$PI_LOOPS_DIR/hooks.toml" <<EOF
[[hook]]
event = "run_end"
command = 'cp "\$PI_HOOK_PAYLOAD" "$ROOT/run_end.json"'
EOF
start_model 'done <inbox>a decision · waits: your label</inbox> <inbox>some news</inbox> <loop-state>seen: 1</loop-state>' || finish
seed_loop cross-probe
start_host
wait_for "$ROOT/run_end.json" 60 || fail "the run never ended (host log: $(tail -5 "$PI_LOOPS_DIR/host.log" 2>/dev/null))"
stop_host
$PI_LOOPS inbox list --all --json | jq -c '.findings[]' | jq -S -c . | sort >"$ROOT/finding.a"
# §2.2 names the finding's fields and allows more after them; a reader takes the named ones.
jq -c 'select(.status == "new") | {id, created_at, status, kind, source, run_id, cwd, text, verified, dismiss_reason}' "$PI_LOOPS_DIR/inbox.jsonl" | jq -S -c . | sort >"$ROOT/finding.b"
[ -s "$ROOT/finding.a" ] && ok "$(wc -l <"$ROOT/finding.a" | tr -d ' ') findings listed" || fail "the run filed no finding"
same "finding: the command and the file say the same object" "$ROOT/finding.a" "$ROOT/finding.b"
