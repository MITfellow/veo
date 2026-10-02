/**
 * M0 demo — run with `npm run demo`.
 *
 * Shows the four things the substrate claims to do, against a real on-disk
 * database rather than a mock:
 *
 *   1. append events and chain them
 *   2. tell you when someone has tampered with history
 *   3. answer the same question on two timelines
 *   4. rebuild the entire derived world from the log alone
 */
import { rmSync } from 'node:fs';
import { FakeClock } from '../src/substrate/clock.js';
import { createSubstrate } from '../src/substrate/index.js';
import { fakeIds } from '../src/substrate/ids.js';
import { testConfig } from '../src/substrate/config.js';
import { NullLogger } from '../src/substrate/log.js';
import { SqliteStorage } from '../src/substrate/storage/sqlite.js';
import {
  currentFacts,
  factsAsOfTransactionTime,
  factsAsOfValidTime,
} from '../src/substrate/projections/facts.js';
import { snapshotProjections } from '../src/substrate/projections/snapshot.js';

const DB = '/tmp/arish-demo.db';
for (const suffix of ['', '-wal', '-shm']) {
  try {
    rmSync(`${DB}${suffix}`);
  } catch {
    /* first run */
  }
}

const bold = (s: string): string => `\u001b[1m${s}\u001b[0m`;
const dim = (s: string): string => `\u001b[2m${s}\u001b[0m`;
const ok = (s: string): string => `\u001b[32m${s}\u001b[0m`;
const bad = (s: string): string => `\u001b[31m${s}\u001b[0m`;
const head = (n: number, s: string): void => console.log(`\n${bold(`${n}. ${s}`)}\n`);

const clock = new FakeClock('2026-01-10T09:00:00Z');
const s = createSubstrate({
  config: testConfig(),
  clock,
  ids: fakeIds(clock, 7),
  storage: new SqliteStorage({ path: DB }),
  logger: new NullLogger(),
});

/* ───────────────────────────── 1. append ──────────────────────────────── */

head(1, 'Append — every write is an event, chained to the one before it');

const session = 'sess-demo';
s.events.append({
  type: 'session.created',
  payload: { title: 'Demo', source: 'cli' },
  principal: 'user:ara',
  trust: 'USER',
  sessionId: session,
});
clock.advance(2000);

const asked = s.events.append({
  type: 'message.user',
  payload: { text: 'Maya works at Acme. Remember that.', attachments: [] },
  principal: 'user:ara',
  trust: 'USER',
  sessionId: session,
});
clock.advance(1500);

s.events.append({
  type: 'memory.written',
  payload: {
    factId: 'maya-employer',
    subject: 'Maya',
    predicate: 'works_at',
    object: 'Acme',
    basis: 'asserted_by_user',
    confidence: 0.95,
    sources: [{ eventId: asked.id, quote: 'Maya works at Acme' }],
    validFrom: Date.parse('2024-02-01T00:00:00Z'),
    validTo: null,
    stability: 'slow',
    sensitivity: 'normal',
    status: 'active',
  },
  principal: 'system',
  trust: 'USER',
  sessionId: session,
  causationId: asked.id,
  correlationId: asked.correlationId,
});
clock.advance(500);

// A secret the agent was handed. It must never reach the log.
const API_KEY = 'sk-demo-9f8a7b6c5d4e3f2a1b0c9d8e';
s.redactor.register(API_KEY, 'weather_api_key');
s.events.append({
  type: 'tool.requested',
  payload: { tool: 'http', version: '1', input: { url: `https://api.example.com?key=${API_KEY}` } },
  principal: 'system',
  trust: 'SYSTEM',
  sessionId: session,
  correlationId: asked.correlationId,
});

for (const e of s.events.read()) {
  console.log(
    `  ${dim(String(e.seq).padStart(3))} ${e.type.padEnd(18)} ${dim(e.trust.padEnd(8))} ` +
      `${e.prevHash.slice(0, 8)}→${e.hash.slice(0, 8)}`,
  );
}

const storedSecretRow = s.storage.get<{ payload: string }>(
  "SELECT payload FROM events WHERE type = 'tool.requested'",
);
const leaked = storedSecretRow?.payload.includes(API_KEY) ?? false;
console.log(
  `\n  secret in the log? ${leaked ? bad('YES — invariant 7 violated') : ok('no')} ` +
    dim(`→ ${storedSecretRow?.payload.slice(0, 96)}…`),
);

/* ───────────────────────────── 2. tamper ──────────────────────────────── */

head(2, 'Integrity — edit history and the chain says where');

console.log(`  clean log: ${ok(JSON.stringify(s.events.verifyChain()))}`);

const raw = (s.storage as SqliteStorage).raw();
raw.exec('DROP TRIGGER events_no_update');
raw.exec(`UPDATE events SET payload = '{"attachments":[],"text":"Maya works at Globex"}' WHERE seq = 2`);
console.log(`  ${dim('(someone edits event 2 directly on disk)')}`);

const tampered = s.events.verifyChain();
console.log(`  after tampering: ${bad(`ok=${tampered.ok}`)}`);
for (const p of tampered.problems) console.log(`    seq ${p.seq}: ${bad(p.problem)}`);
raw.exec(`UPDATE events SET payload = '{"attachments":[],"text":"Maya works at Acme. Remember that."}' WHERE seq = 2`);
console.log(`  restored: ${ok(`ok=${s.events.verifyChain().ok}`)}`);

/* ──────────────────────────── 3. two timelines ────────────────────────── */

head(3, 'Bitemporality — "where does she work" has three right answers');

const APR = Date.parse('2026-04-01T00:00:00Z');
const MAR = Date.parse('2026-03-15T00:00:00Z');
clock.set(Date.parse('2026-06-20T00:00:00Z'));

s.events.append({
  type: 'memory.superseded',
  payload: { factId: 'maya-employer', supersededBy: 'maya-employer-v2', validTo: APR },
  principal: 'user:ara',
  trust: 'USER',
  sessionId: session,
});
s.events.append({
  type: 'memory.written',
  payload: {
    factId: 'maya-employer-v2',
    subject: 'Maya',
    predicate: 'works_at',
    object: 'Globex',
    basis: 'asserted_by_user',
    confidence: 0.98,
    sources: [{ eventId: asked.id }],
    validFrom: APR,
    validTo: null,
    stability: 'slow',
    sensitivity: 'normal',
    status: 'active',
  },
  principal: 'system',
  trust: 'USER',
  sessionId: session,
});

const show = (label: string, rows: Array<{ object: string }>): void =>
  console.log(`  ${label.padEnd(46)} ${ok(rows.map((r) => r.object).join(', ') || '—')}`);

show('where does Maya work now?', currentFacts(s.storage, 'Maya', 'works_at'));
show('where did she work in March? (valid time)', factsAsOfValidTime(s.storage, 'Maya', MAR, 'works_at'));
show(
  'what did I believe in March? (txn time)',
  factsAsOfTransactionTime(s.storage, 'Maya', MAR, 'works_at'),
);
console.log(
  dim('\n  Both March answers are "Acme" — and in March that belief was correct.\n') +
    dim('  Had I been wrong rather than out of date, those two would differ.'),
);

/* ───────────────────────────── 4. rebuild ─────────────────────────────── */

head(4, 'Rebuild — destroy every projection, replay the log, compare bytes');

const before = snapshotProjections(s.storage);
console.log(`  snapshot before: ${dim(s.hashing.sha256Hex(before))}`);

for (const t of ['sessions', 'messages', 'runs', 'entities', 'artifacts', 'facts', 'facts_fts']) {
  s.storage.exec(`DELETE FROM ${t}`);
}
console.log(`  ${dim('(all derived tables dropped)')}`);
console.log(`  snapshot after drop:  ${dim(s.hashing.sha256Hex(snapshotProjections(s.storage)))}`);

const replayed = s.events.rebuild();
const after = snapshotProjections(s.storage);
console.log(`  replayed ${replayed} events`);
console.log(`  snapshot after:  ${dim(s.hashing.sha256Hex(after))}`);
console.log(
  `\n  byte-identical? ${after === before ? ok('YES') : bad('NO — state lives outside the log')}`,
);

console.log(dim(`\n  database: ${DB}  ·  npm run verify-chain -- ${DB}\n`));
s.close();
