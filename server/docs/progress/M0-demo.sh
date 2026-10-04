#!/usr/bin/env bash
#
# M0 — Substrate. The runnable demo.
#
#   cd server && npm install && npm run build && bash docs/progress/M0-demo.sh
#
# §58's completion gate is one sentence: ten thousand events, drop every
# projection, rebuild, byte-identical. Everything here runs the real binary
# against a real SQLite file.
set -euo pipefail

cd "$(dirname "$0")/../.."
DIR=/tmp/arish-m0-demo
rm -rf "$DIR"; mkdir -p "$DIR"
arish() { node dist/src/interface/cli.js "$@" --data-dir "$DIR"; }
h() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

h "1. doctor — including the check that there is no model"
arish doctor

h "2. Append 10,000 events"
node --input-type=module -e "
import { createSubstrate } from './dist/src/substrate/index.js';
const s = createSubstrate({ dbPath: '$DIR/arish.db' });
const t0 = performance.now();
for (let i = 0; i < 10_000; i++) {
  s.events.append({
    type: 'fact.asserted', actor: 'user:demo', trust: 'USER',
    payload: {
      factId: 'f' + i, subject: 'e' + (i % 500), predicate: 'likes', object: 'thing ' + i,
      validFrom: 1700000000000 + i, validTo: null, basis: 'demo', confidence: 1,
      stability: 'stable', sensitivity: 'normal', sourceTrust: 'USER',
    },
  });
}
const ms = performance.now() - t0;
console.log(\`   appended \${s.events.count()} events in \${ms.toFixed(0)} ms (\${(ms / 10000).toFixed(3)} ms each, budget 2)\`);
s.close();
"

h "3. status"
arish status

h "4. verify-chain over the whole log"
arish verify-chain

h "5. §58 — drop every projection, replay, compare digests"
arish rebuild

h "6. Rebuild again. Idempotent, or it is not a function of the log."
arish rebuild

h "7. A rogue projector must break the digest"
node --input-type=module -e "
import { createSubstrate } from './dist/src/substrate/index.js';
import { snapshotDigest } from './dist/src/substrate/projections/index.js';
const s = createSubstrate({ dbPath: '$DIR/arish.db' });
const before = snapshotDigest(s.storage, s.crypto).digest;
s.storage.prepare(\"UPDATE facts SET object = 'tampered' WHERE rowid = 1\").run();
const after = snapshotDigest(s.storage, s.crypto).digest;
console.log('   before', before.slice(0, 16) + '…');
console.log('   after ', after.slice(0, 16) + '…');
console.log('   differ:', before !== after, before !== after ? '(correct)' : '(THE DIGEST IS BLIND)');
s.close();
"

h "8. Rebuild detects the disagreement and repairs it"
# `rebuild` reports whether the projections it found already matched the
# log. After a tamper they do not, so it says so and exits non-zero — that
# report IS the detection, not a failure of the rebuild.
arish rebuild || echo "   exit=$?  (correct: the projections on disk disagreed with the log)"

h "8b. Now they agree again, because projections are derived state"
arish rebuild

h "9. VACUUM must NOT change the digest — it is logical, not the file"
node --input-type=module -e "
import { createSubstrate } from './dist/src/substrate/index.js';
import { snapshotDigest } from './dist/src/substrate/projections/index.js';
const s = createSubstrate({ dbPath: '$DIR/arish.db' });
const before = snapshotDigest(s.storage, s.crypto).digest;
s.storage.exec('VACUUM');
const after = snapshotDigest(s.storage, s.crypto).digest;
console.log('   identical across VACUUM:', before === after, before === after ? '(correct)' : '(the digest is reading the file, not the rows)');
s.close();
"

h "10. Tamper with a payload in SQLite and ask verify-chain"
python3 - "$DIR" <<'PY'
import sqlite3, sys
db = sqlite3.connect(f'{sys.argv[1]}/arish.db')
db.execute("UPDATE events SET payload = '{\"factId\":\"forged\"}' WHERE seq = 1337")
db.commit()
print('   rewrote the payload of event 1337')
PY
arish verify-chain || echo "   exit=$?  (non-zero is the correct answer)"

h "Done. $DIR/arish.db is left in place if you want to dig."
