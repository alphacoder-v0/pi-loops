#!/bin/sh
# CONTRACT.md §5.5, the size check: section 2 has no more non-empty lines than the count frozen
# in the file's header. A line added there must name, in the CHANGELOG, the mechanism it replaced.
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
DOC="$REPO/CONTRACT.md"

frozen=$(sed -n 's/.*[Ff]rozen[^0-9]*\([0-9][0-9]*\).*/\1/p; s/.*冻结行数[^0-9]*\([0-9][0-9]*\).*/\1/p' "$DOC" | head -1)
now=$(awk '/^## 2\. /{f=1; next} /^## 3\. /{f=0} f && NF' "$DOC" | wc -l | tr -d ' ')
echo "section 2: $now non-empty lines, frozen at ${frozen:-?}"
if [ -z "$frozen" ]; then
	echo "  FAIL: CONTRACT.md has no frozen line count in its header" >&2
	exit 1
fi
if [ "$now" -le "$frozen" ]; then
	echo "  ok"
	exit 0
fi
echo "  FAIL: section 2 grew past the frozen count" >&2
exit 1
