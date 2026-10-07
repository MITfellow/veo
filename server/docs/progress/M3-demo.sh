#!/usr/bin/env bash
#
# M3 — tools and effects, demonstrated rather than described.
#
# Everything below runs offline, with no model and no network. What it is
# meant to show, in order:
#
#   1. the agent can only do what it has declared it can do
#   2. a plan is agreed before anything runs, and content cannot widen it
#   3. the autonomy ladder stops a step and asks instead of failing
#   4. an approval is a human answer, bound to one step of one plan
#   5. a dry run reports and changes nothing
#   6. untrusted input caps the whole run, whatever it was asked for
#   7. every one of the above is in the log, and the log rebuilds identically
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ARISH="node ${HERE}/dist/src/interface/cli.js"
DATA="$(mktemp -d -t arish-m3-XXXXXX)"
trap 'rm -rf "${DATA}"' EXIT

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if [ ! -f "${HERE}/dist/src/interface/cli.js" ]; then
  say "building…"
  (cd "${HERE}" && npm run build >/dev/null)
fi

# ─────────────────────────────────────────────────────── 1. what it can do
say "1. Every tool, with the rung and the capabilities it needs"
${ARISH} tools --data-dir "${DATA}"

cat > "${DATA}/plan.json" <<'JSON'
{
  "goal": "note where I live, then read it back",
  "steps": [
    { "tool": "memory.assert", "input": { "subject": "user", "predicate": "lives_in", "object": "Berlin" }, "why": "remember where you live" },
    { "tool": "memory.recall", "input": { "query": "where do I live" }, "why": "read it back to you" }
  ],
  "allowedTools": ["memory.assert", "memory.recall"],
  "carriesPrivateData": true
}
JSON

# ───────────────────────────────────────────────────────────── 2. propose
say "2. L0 proposes and runs nothing. The plan is the deliverable."
${ARISH} run "${DATA}/plan.json" --autonomy 0 --data-dir "${DATA}"

# ───────────────────────────────────────────────────────── 3. ask, not fail
say "3. At L1 the first step needs L2. It asks — it does not fail."
${ARISH} run "${DATA}/plan.json" --autonomy 1 --data-dir "${DATA}"

say "   The question is in the database, not in the memory of that process:"
${ARISH} approvals --data-dir "${DATA}"

# ──────────────────────────────────────────────────────────── 4. the answer
ID=$(${ARISH} approvals --data-dir "${DATA}" --json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).pending[0].id))')

say "4. A human grants it, and the same plan now runs."
${ARISH} approvals grant "${ID}" --reason "yes, that is right" --data-dir "${DATA}"
${ARISH} run "${DATA}/plan.json" --autonomy 1 --data-dir "${DATA}"

say "   The same approval cannot be used twice:"
${ARISH} approvals deny "${ID}" --data-dir "${DATA}" || echo "   (refused, exit $?)"

# ─────────────────────────────────────────────────────────── 5. the dry run
say "5. A dry run says what would happen and changes nothing."
BEFORE=$(${ARISH} status --data-dir "${DATA}" --json | grep -o '"facts": [0-9]*')
${ARISH} run "${DATA}/plan.json" --autonomy 3 --dry-run --data-dir "${DATA}"
AFTER=$(${ARISH} status --data-dir "${DATA}" --json | grep -o '"facts": [0-9]*')
echo "   facts before: ${BEFORE} / after: ${AFTER}"

# ───────────────────────────────────────────────────────── 6. the trust cap
say "6. Seeded by untrusted content, the same L3 run is capped to L1."
${ARISH} run "${DATA}/plan.json" --autonomy 3 --trust FOREIGN --data-dir "${DATA}"

# ───────────────────────────────────────────────────── 7. the record holds
say "7. Nothing above was special-cased: drop every projection and replay."
${ARISH} rebuild --data-dir "${DATA}"
${ARISH} verify-chain --data-dir "${DATA}"

say "M3 demo complete."
