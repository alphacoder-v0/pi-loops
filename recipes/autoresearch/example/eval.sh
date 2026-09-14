#!/bin/sh
# Protected. `bash eval.sh dev` iterates; `bash eval.sh test` decides promotion.
cd "$(dirname "$0")" && exec python3 eval.py "${1:-dev}"
