#!/bin/sh
# docs/downstream.md §1: a directory with a recipe.toml and its playbooks is a recipe. The
# manifest in the document, as written, installs; its playbooks land in .agents/skills/<name>/ with
# the level written in; a manifest that breaks a rule is refused with nothing copied.
. "$(dirname "$0")/lib.sh"
fresh_home

RECIPE="$ROOT/nightly-audit"
mkdir -p "$RECIPE"
cat > "$RECIPE/recipe.toml" <<'EOF'
name = "nightly-audit"
summary = "one line"
levels = ["report", "propose"]
needs_tracker = false
setup = "setup.sh"
files = ["extra.md"]
tier = "starter"
useful_when = ["one sentence"]
needs = ["gh"]
needs_propose = ["git-remote"]
budget_hint_usd = 5

[[job]]
name = "audit"
schedule = "0 3 * * *"
playbook = "audit.md"
verify = true
EOF
printf -- '---\nname: nightly-audit\ndescription: audit the repository\n---\n\nRead the repository and file one finding per problem.\n' > "$RECIPE/audit.md"
printf 'echo setup\n' > "$RECIPE/setup.sh"
printf 'extra\n' > "$RECIPE/extra.md"

echo "show accepts the directory"
$PI_LOOPS recipe show "$RECIPE" --cwd "$PROJECT" >"$ROOT/show.out" 2>&1
expect_eq "show exit" "$?" 0
grep -q "nightly-audit" "$ROOT/show.out" && ok "show names the recipe" || fail "show did not name the recipe: $(cat "$ROOT/show.out")"

echo "add copies the playbooks into the project"
$PI_LOOPS recipe add "$RECIPE" --cwd "$PROJECT" --level report >"$ROOT/add.out" 2>&1
expect_eq "add exit" "$?" 0
INSTALLED="$PROJECT/.agents/skills/nightly-audit"
[ -f "$INSTALLED/audit.md" ] && ok "audit.md installed" || fail "audit.md not in $INSTALLED"
[ -f "$INSTALLED/extra.md" ] && ok "extra.md installed" || fail "extra.md not in $INSTALLED"
grep -q '^Autonomy: report$' "$INSTALLED/audit.md" && ok "Autonomy line written" || fail "no 'Autonomy: report' line in the installed playbook"
grep -q '^name: nightly-audit$' "$INSTALLED/audit.md" && ok "frontmatter kept" || fail "frontmatter lost"

echo "a manifest that breaks a rule is refused before anything is copied"
BAD="$ROOT/bad"
mkdir -p "$BAD"
printf 'name = "bad"\nsummary = "no jobs"\nlevels = ["report"]\n' > "$BAD/recipe.toml"
$PI_LOOPS recipe add "$BAD" --cwd "$PROJECT" >"$ROOT/bad.out" 2>&1
[ "$?" -ne 0 ] && ok "no [[job]]: refused" || fail "a manifest with no [[job]] was accepted"
[ ! -e "$PROJECT/.agents/skills/bad" ] && ok "nothing copied" || fail "files were copied for a refused manifest"

ONCE="$ROOT/once"
mkdir -p "$ONCE"
printf 'name = "once"\nsummary = "fires once"\nlevels = ["report"]\n\n[[job]]\nname = "x"\nschedule = "in 10m"\nplaybook = "x.md"\n' > "$ONCE/recipe.toml"
printf 'x\n' > "$ONCE/x.md"
$PI_LOOPS recipe add "$ONCE" --cwd "$PROJECT" >"$ROOT/once.out" 2>&1
[ "$?" -ne 0 ] && ok "in/at schedule: refused" || fail "a one-shot schedule was accepted"
