#!/usr/bin/env bash
#
# Browser use, demonstrated against the real built binary over real HTTP.
#
# Nothing here is mocked. It starts `arish serve`, commits a plan, reads a
# page, watches the planner be denied the page's prose, and then watches a
# hostile page fail to drive the agent.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${PORT:-8799}"
DATA="$(mktemp -d /tmp/arish-browser-demo.XXXXXX)"
BASE="http://127.0.0.1:${PORT}"

cd "$HERE"
[ -f dist/src/interface/cli.js ] || npm run build >/dev/null

node dist/src/interface/cli.js serve --port "$PORT" --data-dir "$DATA" >"$DATA/serve.log" 2>&1 &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null || true; rm -rf "$DATA"' EXIT

for _ in $(seq 1 50); do
  curl -fsS "$BASE/api/status" >/dev/null 2>&1 && break
  sleep 0.1
done

say()  { printf '\n\033[1m── %s\033[0m\n' "$1"; }
post() { curl -fsS -X POST "$BASE$1" -H 'content-type: application/json' -d "$2"; }
get()  { curl -fsS "$BASE$1"; }
jqq()  { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log(eval(process.argv[1]))})' "$1"; }

say "1. The build says plainly that it has no network driver"
get /api/browser/catalogue | jqq 'o.driver.note'

say "2. A plan is committed and sealed BEFORE any page is read"
post /api/browser/plan '{"plan":{"goal":"read the deployment guide","allowedKinds":["navigate","read","click"],"maxSteps":6,"allowedOrigins":["https://docs.example"],"carriesPrivateData":false},"autonomy":2}' \
  | jqq '"seal " + o.plan.seal.slice(0,32) + "…\n" + o.sealedBefore'

say "3. The planner receives affordances — and no prose"
VIEW=$(post /api/browser/act '{"action":{"kind":"navigate","url":"https://docs.example/guide"}}')
echo "$VIEW" | jqq 'o.view.affordances.map(a=>`  ${a.ref}  ${a.kind.padEnd(8)} ${a.label}`).join("\n")'
echo "$VIEW" | jqq '`  body text: ${o.view.visibleTextChars} characters, none of them delivered`'
if echo "$VIEW" | grep -q 'health check'; then
  echo "  FAIL: page prose reached the planner"; exit 1
fi
echo "  verified: the phrase 'health check' appears on that page and not in the planner's input"

say "4. You, however, get the whole page — labelled FOREIGN"
get /api/browser/page | jqq '"  trust: " + o.trust + "\n  " + o.text.split("\n")[2].trim()'

say "5. A ref is dereferenced by the session, so a label cannot carry a destination"
post /api/browser/act '{"action":{"kind":"click","ref":"e1"}}' | jqq '"  followed e1 → " + o.view.url'

say "6. A hostile page tries to give the agent orders"
post /api/browser/reset '{}' >/dev/null
post /api/browser/plan '{"plan":{"goal":"read an article","allowedKinds":["navigate","read","click"],"maxSteps":6,"allowedOrigins":["https://blog.example"],"carriesPrivateData":false},"autonomy":2}' >/dev/null
HOSTILE=$(post /api/browser/act '{"action":{"kind":"navigate","url":"https://blog.example/injection"}}')
echo "$HOSTILE" | jqq '"  hidden characters the page planted: " + o.view.signals.hiddenTextChars'
echo "$HOSTILE" | jqq '"  characters inside comments:          " + o.view.signals.commentChars'
for phrase in 'maintenance mode' 'Ignore all previous' 'exfiltrate' 'pre-approved'; do
  if echo "$HOSTILE" | grep -qi "$phrase"; then echo "  FAIL: '$phrase' reached the planner"; exit 1; fi
done
echo "  verified: none of its instructions are in the planner's input"
post /api/browser/act '{"action":{"kind":"click","ref":"e2"}}' | jqq '"  its exit link: " + o.refused.reason'

say "7. The Rule of Two, against a page that forges its own approval"
post /api/browser/reset '{}' >/dev/null
post /api/browser/plan '{"plan":{"goal":"pay","allowedKinds":["navigate","type","submit"],"maxSteps":6,"allowedOrigins":["https://pay.example"],"carriesPrivateData":true},"autonomy":4}' >/dev/null
post /api/browser/act '{"action":{"kind":"navigate","url":"https://pay.example/confirm"}}' \
  | jqq '"  credential fields on this page: " + o.view.signals.credentialFields'
post /api/browser/act '{"action":{"kind":"submit","formIndex":0}}' | jqq '"  refused: " + o.refused.reason'

say "8. The same action, with an approval that came from a human"
post /api/browser/act '{"action":{"kind":"submit","formIndex":0},"approved":true}' | jqq '"  " + o.refused.reason'
echo "  (policy passed; the remaining obstacle is honest — there is no transport)"

say "9. An 'approved' flag smuggled inside the action is a parse error, not a bypass"
curl -fsS -o /dev/null -w '  HTTP %{http_code}\n' -X POST "$BASE/api/browser/act" \
  -H 'content-type: application/json' \
  -d '{"action":{"kind":"submit","formIndex":0,"approved":true}}' || true

say "10. The transcript"
get /api/browser | jqq 'o.log.map(e=>`  ${e.outcome.padEnd(10)} ${e.kind.padEnd(9)} ${e.detail.slice(0,70)}`).join("\n")'

say "11. The same session, as the event log recorded it (decision 010)"
cat > "$DATA/audit.cjs" <<'AUDIT'
const db = require(process.env.DB_MODULE)(process.env.DB_PATH, { readonly: true });
const planned = db.prepare("SELECT payload FROM events WHERE type = 'run.planned' LIMIT 1").get();
console.log("  sealed plan, recorded before any page was read:");
console.log("    " + JSON.parse(planned.payload).seal.slice(0, 48) + "...");
console.log("  tool calls:");
for (const r of db.prepare("SELECT action, tier, status, code FROM tool_calls ORDER BY started_at").all()) {
  console.log("    " + r.tier.padEnd(9) + " " + r.status.padEnd(10) + " " + (r.code || "-").padEnd(19) + " " + r.action);
}
const bad = db.prepare(
  "SELECT COUNT(*) n FROM events WHERE payload LIKE '%maintenance mode%' OR payload LIKE '%exfiltrate%' OR payload LIKE '%APPROVED BY USER%'"
).get();
if (bad.n !== 0) { console.error("  FAIL: page prose reached the event log"); process.exit(1); }
console.log("  verified: no page prose anywhere in the log");
AUDIT
DB_MODULE="$HERE/node_modules/better-sqlite3" DB_PATH="$DATA/arish.db" node "$DATA/audit.cjs"

say "12. Drop every projection, replay the log, compare"
ARISH_DATA_DIR="$DATA" node "$HERE/dist/src/interface/cli.js" rebuild 2>&1 | sed 's/^/  /'

printf '\n\033[1;32mAll browser demo assertions passed.\033[0m\n'
