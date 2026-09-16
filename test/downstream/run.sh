#!/bin/sh
# The downstream contract, checked from the outside: `npm run check:downstream`. Each check is a
# shell script that drives `pi-loops` as a command and reads its output with jq; none imports this
# package's code. One fails, this fails.
HERE=$(cd "$(dirname "$0")" && pwd)
status=0
for check in recipe hooks inbox; do
	echo "downstream: $check"
	if sh "$HERE/$check.sh"; then
		echo "downstream: $check passed"
	else
		echo "downstream: $check FAILED" >&2
		status=1
	fi
done
exit $status
