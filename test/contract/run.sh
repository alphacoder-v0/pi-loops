#!/bin/sh
# CONTRACT.md §5: the five refinement checks, in order. Each is its own script and can be run
# alone; this runs all five and prints one line per check at the end, so the lowest-numbered
# failure is the next thing to fix. Needs node, jq, python3 (tomllib, 3.11+) and pi on PATH.
HERE=$(cd "$(dirname "$0")" && pwd)
status=0
summary=""
for check in 1-second-implementation 2-stopped 3-cross-check 4-private-state 5-size; do
	echo "contract: $check"
	if sh "$HERE/$check.sh"; then r=pass; else r=FAIL; status=1; fi
	echo "contract: $check $r"
	summary="$summary
  $check: $r"
done
echo "contract summary:$summary"
exit $status
