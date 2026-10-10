#!/usr/bin/env bash
# chmod +x does not survive a workspace snapshot; run with: bash scripts/preview.sh
# Bring the preview back up from nothing.
#
# `node_modules` and `dist` are excluded from workspace snapshots, so they
# are routinely absent even though the source is intact. This installs and
# rebuilds only when they are missing, then starts both processes.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -d node_modules ] || npm install --silent
[ -f dist/index.html ] || npm run build

ARISH_TOKEN=${ARISH_TOKEN:-dev-token} npm run agent &
ARISH_TOKEN=${ARISH_TOKEN:-dev-token} npx vite preview
