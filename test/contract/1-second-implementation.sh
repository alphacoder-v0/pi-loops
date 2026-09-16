#!/bin/sh
# CONTRACT.md §5.1, the second-implementation check: a program that imports nothing of this
# package reads, writes and changes through the interface alone. Two halves. The closed loop in
# test/downstream/closed-loop.sh installs a recipe, lets it run, finds its finding by run_id and
# claims it — sh and jq, no private file. Then python3's tomllib, a TOML reader this package has
# never seen, opens every recipe.toml in the repository and checks §2.2's required keys.
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
status=0

echo "the closed loop over the interface (sh + jq)"
sh "$REPO/test/downstream/closed-loop.sh" || status=1

echo "an independent reader of recipe.toml (python3 tomllib) finds §2.2 in every recipe"
python3 - "$REPO" <<'EOF' || status=1
import pathlib, re, sys, tomllib

root = pathlib.Path(sys.argv[1])
levels = {"report", "propose", "act"}
files = sorted(root.glob("recipes/*/recipe.toml")) + [root / "test/downstream/fixture-recipe/recipe.toml"]
bad = 0
for f in files:
    m = tomllib.loads(f.read_text())
    problems = []
    if not re.fullmatch(r"[a-z][a-z0-9-]*", m.get("name", "")):
        problems.append("name")
    if not isinstance(m.get("summary"), str):
        problems.append("summary")
    if not m.get("levels") or not set(m["levels"]) <= levels:
        problems.append("levels")
    jobs = m.get("job") or []
    if not jobs:
        problems.append("job")
    for j in jobs:
        for k in ("name", "schedule", "playbook"):
            if not isinstance(j.get(k), str):
                problems.append(f"job.{k}")
        if isinstance(j.get("playbook"), str) and not (f.parent / j["playbook"]).is_file():
            problems.append("job.playbook missing")
        if isinstance(j.get("schedule"), str) and re.match(r"\s*(in|at)\b", j["schedule"]):
            problems.append("job.schedule is once")
    print(f"  {'FAIL' if problems else 'ok'}: {f.relative_to(root)} {' '.join(problems)}")
    bad += bool(problems)
sys.exit(1 if bad else 0)
EOF

exit $status
