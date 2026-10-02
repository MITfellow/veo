/**
 * `npm run perf` — §32's budgets at the size §32 actually names.
 *
 *   100k events · 50k facts · no query above 100ms
 *
 * Not in the test suite, on purpose. §34.12 requires the whole suite to
 * run offline and deterministically in under sixty seconds, and seeding
 * 100k events takes longer than that on its own. The suite keeps a 10k
 * regression detector (`test/integration/performance.test.ts`); this is
 * the real pass, run before a release and whenever an index changes.
 *
 * A team that makes its test suite slow is a team that stops running its
 * test suite, which costs more than this separation does.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSubstrate } from '../src/substrate/index.js';
import { FakeClock } from '../src/substrate/clock.js';
import { MemoryStore } from '../src/cognition/memory/store.js';
import { computeMetrics } from '../src/observability/metrics.js';
import { snapshotDigest } from '../src/substrate/projections/snapshot.js';

const EVENTS = Number(process.env.PERF_EVENTS ?? 100_000);
const FACTS = Number(process.env.PERF_FACTS ?? 50_000);
const BUDGET_MS = 100;

const line = (s = '') => console.log(s);
const rule = (t: string) => {
  line();
  line(`\x1b[1m${t}\x1b[0m`);
  line('─'.repeat(t.length));
};
let failures = 0;
const check = (label: string, ms: number, budget = BUDGET_MS) => {
  const ok = ms <= budget;
  if (!ok) failures += 1;
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  line(`  ${mark} ${label.padEnd(52)} ${ms.toFixed(1).padStart(8)}ms  (budget ${budget}ms)`);
};
const timed = <T>(fn: () => T): [T, number] => {
  const started = performance.now();
  const value = fn();
  return [value, performance.now() - started];
};

const dir = mkdtempSync(join(tmpdir(), 'arish-perf-'));
const clock = new FakeClock('2026-01-01T09:00:00Z');
const substrate = createSubstrate({ dbPath: join(dir, 'perf.db'), clock });
const { storage, events, ids, hashing } = substrate;

rule(`seeding ${EVENTS.toLocaleString()} events`);
const SESSIONS = 200;
let seeded = 0;
const seedStart = performance.now();
storage.transaction(() => {
  for (let i = 0; i < EVENTS; i += 1) {
    const session = `ses-${i % SESSIONS}`;
    clock.advance(1_000);
    events.append(
      i % 3 === 0
        ? {
            type: 'message.user',
            principal: 'user:ara',
            trust: 'USER',
            sessionId: session,
            payload: { text: `turn ${i} about project ${i % 97}` },
          }
        : i % 3 === 1
          ? {
              type: 'message.agent',
              principal: 'user:ara',
              trust: 'DERIVED',
              sessionId: session,
              payload: { text: `answer ${i}` },
            }
          : {
              type: 'perf.sampled',
              principal: 'system',
              trust: 'SYSTEM',
              payload: { stage: 'context.assembly', ms: 3 + (i % 7) },
            },
    );
    seeded += 1;
  }
});
line(`  ${seeded.toLocaleString()} events in ${((performance.now() - seedStart) / 1000).toFixed(1)}s`);

rule(`seeding ${FACTS.toLocaleString()} facts`);
const store = new MemoryStore({ storage, events, clock, ids });
const factStart = performance.now();
storage.transaction(() => {
  for (let i = 0; i < FACTS; i += 1) {
    clock.advance(10);
    store.write({
      principal: 'user:ara',
      subject:
        i % 2 === 0
          ? { id: 'self', kind: 'self', label: 'you' }
          : { id: `person-${i % 500}`, kind: 'person', label: `Person ${i % 500}` },
      predicate: `knows_about_${i % 120}`,
      object: `topic ${i} — lisbon rain climbing typescript sqlite`,
      basis: i % 4 === 0 ? 'asserted_by_user' : 'observed',
      confidence: 0.4 + (i % 50) / 100,
      stability: 'slow',
      sensitivity: 'normal',
      trust: 'USER',
      sources: [{ eventId: `evt-${i}`, quote: `topic ${i}` }],
    });
  }
});
line(`  ${FACTS.toLocaleString()} facts in ${((performance.now() - factStart) / 1000).toFixed(1)}s`);

rule('§32 — no query above 100ms');
check('recallable(200)', timed(() => store.recallable('user:ara', 200))[1]);
check('searchText("lisbon climbing")', timed(() => store.searchText('lisbon climbing', 50))[1]);
check(
  'bySubject(self) — the hottest query in the system',
  timed(() => store.bySubject('self'))[1],
);
check('pinned()', timed(() => store.pinned('user:ara'))[1]);
check('identityCard()', timed(() => store.identityCard('user:ara'))[1], 250);
check(
  'events.read({ sessionId }) — one session of a 100k log',
  timed(() => events.read({ sessionId: 'ses-7', limit: 200 }))[1],
);
check(
  'events.read({ types }) — a type filter across the whole log',
  timed(() => events.read({ types: ['message.user'], limit: 200 }))[1],
);
check(
  'metrics over 30 days',
  timed(() => computeMetrics({ storage, events, now: clock.now() }, 30))[1],
  1_000,
);

rule('§34.2 — drop every projection, rebuild, byte-identical');
const before = snapshotDigest(storage, hashing);
const [, rebuildMs] = timed(() => {
  events.rebuild();
});
const after = snapshotDigest(storage, hashing);
line(`  rebuild of ${seeded.toLocaleString()} events: ${(rebuildMs / 1000).toFixed(1)}s`);
if (before === after) {
  line('  \x1b[32m✓\x1b[0m digests match');
} else {
  failures += 1;
  line(`  \x1b[31m✗\x1b[0m digests differ: ${before} ≠ ${after}`);
}

rule('§13.5 — the chain still verifies at this size');
const [chain, verifyMs] = timed(() => events.verifyChain());
line(
  `  ${chain.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${chain.checked.toLocaleString()} ` +
    `events verified in ${(verifyMs / 1000).toFixed(1)}s`,
);
if (!chain.ok) failures += 1;

substrate.close();
rmSync(dir, { recursive: true, force: true });

line();
line(failures === 0 ? '\x1b[32mall budgets met\x1b[0m' : `\x1b[31m${failures} budget(s) missed\x1b[0m`);
line();
process.exit(failures === 0 ? 0 : 1);
