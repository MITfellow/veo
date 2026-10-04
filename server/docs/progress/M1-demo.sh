#!/usr/bin/env bash
#
# M1 — Security. The runnable demo.
#
#   cd server && npm install && npm run build && bash docs/progress/M1-demo.sh
#
# Everything below runs the real built binary against a real SQLite file in
# /tmp. Nothing is mocked. The point of the demo is the second half: after
# forgetting something, we come back with full database access, the correct
# passphrase and an unlocked vault, and still cannot read it.
set -euo pipefail

cd "$(dirname "$0")/../.."
DIR=/tmp/arish-m1-demo
PASS='correct horse battery staple'
rm -rf "$DIR"; mkdir -p "$DIR"
arish() { node dist/src/interface/cli.js "$@" --data-dir "$DIR"; }
h() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

h "1. Before anything exists"
arish vault status

h "2. Initialise. The recovery code is shown once and stored nowhere."
printf '%s\n%s\n' "$PASS" "$PASS" | arish vault init

h "3. Store two credentials. The caller gets a reference, never the value back."
printf '%s\nsk-live-REALSTRIPEKEY-0123456789\n' "$PASS" | arish vault set stripe
printf '%s\nghp_REALGITHUBTOKEN-abcdefghij\n' "$PASS" | arish vault set github

h "4. List. Names and versions only."
printf '%s\n' "$PASS" | arish vault list

h "5. The wrong passphrase learns nothing."
printf 'definitely the wrong one\n' | arish vault list || echo "exit=$?"

h "6. An adversary with the database file"
for needle in 'sk-live-REALSTRIPEKEY' 'ghp_REALGITHUBTOKEN' "$PASS"; do
  printf "   grep %-28s " "'$needle'"
  if grep -q "$needle" "$DIR/arish.db" 2>/dev/null; then echo 'FOUND — LEAK'; else echo 'absent'; fi
done

h "7. The entire event log. Metadata only, by construction (§23)."
python3 - "$DIR" <<'PY'
import sqlite3, sys
db = sqlite3.connect(f'{sys.argv[1]}/arish.db')
for t, p in db.execute('SELECT type, payload FROM events ORDER BY seq'):
    print(f'   {t:28} {p}')
blob = ''.join(str(r) for r in db.execute('SELECT * FROM events'))
leaked = 'sk-live-REAL' in blob or 'ghp_REAL' in blob
print(f'\n   secret values anywhere in the log: {"LEAK" if leaked else "none"}')
PY

h "8. Crypto-shredding: forget one item and then try to get it back."
# Item content is sealed under a per-item key (decision 006). The memory
# store that will own these items is M2's; this drives the vault directly so
# the property can be demonstrated now rather than asserted.
node --input-type=module -e "
import { Vault } from './dist/src/security/vault.js';
import { createSubstrate } from './dist/src/substrate/index.js';

const s = createSubstrate({ dbPath: '$DIR/arish.db' });
const noop = new Proxy({}, { get: () => () => {} });
const vault = new Vault({
  storage: s.storage, clock: s.clock, events: noop,
  argon2: { memMiB: 64, iterations: 3, parallelism: 1 }, idleLockMinutes: 60,
});
await vault.unlock('$PASS');

const diary = await vault.sealItem('note:diary', 'The thing I regret saying.');
const other = await vault.sealItem('note:recipe', 'Three eggs, no sugar.');
console.log('   sealed two notes under separate item keys');
console.log('   read back  note:diary  ->', JSON.stringify(await vault.openItem('note:diary', diary)));

console.log('\n   user asks the agent to forget note:diary');
console.log('   shred ->', vault.shred('note:diary'));

// Same process. Still unlocked. Correct passphrase. Full database access.
try {
  await vault.openItem('note:diary', diary);
  console.log('   READ IT BACK — the whole milestone is a lie');
} catch (e) {
  console.log('   openItem   note:diary  ->', e.kind ?? e.name, '(' + e.message + ')');
}
console.log('   openItem   note:recipe ->', JSON.stringify(await vault.openItem('note:recipe', other)), '(siblings unaffected)');
console.log('   shred again ->', vault.shred('note:diary'), '(idempotent: forgetting twice is not an error)');

const row = s.storage.prepare('SELECT length(wrapped) AS n FROM item_keys WHERE key_id = ?').get('note:diary');
console.log('   item key row for note:diary in the database:', row ?? 'gone');
s.close();
"

h "9. Tamper with the event log and ask the platform about it."
python3 - "$DIR" <<'PY'
import sqlite3, sys
db = sqlite3.connect(f'{sys.argv[1]}/arish.db')
db.execute("UPDATE events SET payload = '{\"reason\":\"idle\"}' WHERE seq = 2")
db.commit()
print('   rewrote the payload of event 2 directly in SQLite')
PY
arish verify-chain || echo "   exit=$?  (non-zero is the correct answer)"

h "Done. The database is at $DIR/arish.db if you want to dig."
