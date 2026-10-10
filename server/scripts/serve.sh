#!/usr/bin/env bash
# Bring the platform up from nothing.
#
# node_modules and dist are excluded from workspace snapshots, so they are
# routinely absent even though the source is intact. Install and compile
# only when they are missing, then serve.
#
# chmod +x does not survive a snapshot either — run with: bash scripts/serve.sh
set -euo pipefail
cd "$(dirname "$0")/.."

[ -d node_modules ] || npm install --silent
[ -f dist/src/interface/cli.js ] || npx tsc -p tsconfig.json

exec node dist/src/interface/cli.js serve \
  --host 0.0.0.0 --port "${PORT:-8787}" --data-dir "${ARISH_DATA:-/home/user/arish-data}"
