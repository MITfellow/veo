import { describe, expect, it } from 'vitest';
import { createTestSubstrate, type TestSubstrate } from '../fakes/substrate.js';
import { diffSnapshots, PROJECTION_TABLES, snapshotDigest } from '../../src/substrate/projections/index.js';

/**
 * §16 — **the M0 milestone gate.**
 *
 * Build ten thousand events of real state, drop every projection, replay the
 * log, compare. Anything that differs is state that was never in the log —
 * state a crash, a restore or a schema change would silently lose.
 *
 * Never weaken this test. If it fails, a projector is holding state it did
 * not derive from an event, and the fix is in the projector.
 */

/**
 * A deterministic workload that exercises every projector and every mutation
 * path, not just inserts. Updates matter more than inserts here: a projector
 * that handles `session.started` but forgets `message.received` still looks
 * right on a fresh build and wrong after a rebuild.
 */
type Append = (event: Parameters<TestSubstrate['events']['append']>[0]) => void;

/** One conversation: turns, a run per turn, and the session lifecycle. */
function seedConversation(append: Append, index: number, budget: () => boolean): void {
  const sid = `session-${index}`;
  const rid = `run-${index}`;
  append({ type: 'session.started', actor: 'user:ara', trust: 'USER', sessionId: sid, payload: { channel: index % 2 === 0 ? 'veo' : 'cli' } });

  const turns = 2 + (index % 4);
  for (let t = 0; t < turns && budget(); t++) {
    append({ type: 'message.received', actor: 'user:ara', trust: 'USER', sessionId: sid, payload: { messageId: `${sid}-u${t}`, role: 'user', content: `question ${t} in ${sid}` } });
    append({ type: 'run.started', actor: 'agent', trust: 'DERIVED', sessionId: sid, runId: `${rid}-${t}`, payload: { goal: `answer ${t}` } });
    append({ type: 'run.finished', actor: 'agent', trust: 'DERIVED', sessionId: sid, runId: `${rid}-${t}`, payload: { stopReason: 'done', steps: 1 + (t % 3) } });
    append({ type: 'message.sent', actor: 'agent', trust: 'DERIVED', sessionId: sid, runId: `${rid}-${t}`, payload: { messageId: `${sid}-a${t}`, role: 'agent', content: `answer ${t}` } });
  }

  if (index % 3 === 0 && budget()) {
    append({ type: 'session.titled', actor: 'user:ara', trust: 'USER', sessionId: sid, payload: { title: `Thread ${index}` } });
  }
  if (index % 2 === 0 && budget()) {
    append({ type: 'capture.received', actor: 'user:ara', trust: 'FOREIGN', sessionId: sid, payload: { captureId: `cap-${index}`, source: 'clipboard', kind: 'text', content: `pasted blob ${index}` } });
  }
  if (budget()) {
    append({ type: 'session.ended', actor: 'user:ara', trust: 'USER', sessionId: sid, payload: { reason: 'idle' } });
  }
}

/**
 * Facts and entities — including the two mutation paths a naive projector
 * misses. Inserts alone look correct on a fresh build and wrong on replay.
 */
function seedKnowledge(append: Append, index: number, now: () => number, budget: () => boolean): void {
  append({ type: 'entity.created', actor: 'agent', trust: 'DERIVED', payload: { entityId: `person-${index}`, kind: 'person', name: `Person ${index}` } });
  if (!budget()) return;

  const factId = `fact-${index}`;
  append({ type: 'fact.asserted', actor: 'user:ara', trust: 'USER', payload: { factId, subject: `person-${index}`, predicate: 'employer', object: `Org ${index}`, validFrom: now(), validTo: null, basis: 'observed', confidence: 0.5 + (index % 5) / 10, stability: 'slow', sensitivity: 'normal', sourceTrust: 'USER' } });

  if (index % 4 === 0 && budget()) {
    const next = `fact-${index}-b`;
    append({ type: 'fact.asserted', actor: 'user:ara', trust: 'USER', payload: { factId: next, subject: `person-${index}`, predicate: 'employer', object: `Org ${index} New`, validFrom: now(), validTo: null, basis: 'observed', confidence: 0.8, stability: 'slow', sensitivity: 'normal', sourceTrust: 'USER' } });
    append({ type: 'fact.superseded', actor: 'user:ara', trust: 'USER', payload: { factId, supersededBy: next, validTo: now() } });
  }
  if (index % 7 === 0 && budget()) {
    append({ type: 'fact.retracted', actor: 'user:ara', trust: 'USER', payload: { factId, reason: 'misheard' } });
  }
}

/**
 * A deterministic workload exercising every projector and every mutation
 * path, not just inserts.
 */
function seed(s: TestSubstrate, targetEvents: number): void {
  let produced = 0;
  const budget = (): boolean => produced < targetEvents;
  const append: Append = (event) => {
    s.events.append(event);
    produced++;
    // Time moves forward constantly; the digest must not depend on the step
    // being uniform, so it varies deterministically.
    s.clock.advance(1000 + (produced % 7) * 250);
  };

  for (let index = 0; budget(); index++) {
    seedConversation(append, index, budget);
    if (budget()) seedKnowledge(append, index, () => s.clock.now(), budget);
  }
}

describe('§16 rebuild-identity — the M0 gate', () => {
  it('10k events → drop every projection → rebuild → byte-identical', () => {
    const s = createTestSubstrate();
    seed(s, 10_000);

    expect(s.events.count()).toBeGreaterThanOrEqual(10_000);

    const before = snapshotDigest(s.storage, s.crypto);
    // Sanity: the workload must actually populate every projection, or the
    // test would pass by comparing emptiness to emptiness.
    for (const table of PROJECTION_TABLES) {
      expect(before.tables[table]?.rows, `${table} should have rows`).toBeGreaterThan(0);
    }

    const result = s.events.rebuild();
    const after = snapshotDigest(s.storage, s.crypto);

    expect(diffSnapshots(before, after)).toEqual([]);
    expect(after.digest).toBe(before.digest);
    expect(result.events).toBe(s.events.count());
    s.close();
  });

  it('the rebuild is idempotent — a second pass changes nothing', () => {
    const s = createTestSubstrate();
    seed(s, 2_000);
    s.events.rebuild();
    const once = snapshotDigest(s.storage, s.crypto);
    s.events.rebuild();
    const twice = snapshotDigest(s.storage, s.crypto);
    expect(twice.digest).toBe(once.digest);
    s.close();
  });

  it('catches a projector that invents state the log does not contain', () => {
    // Proves the gate has teeth. A projector writing a value not derived
    // from the event must make the digest diverge.
    const s = createTestSubstrate();
    let counter = 0;
    s.events.register({
      name: 'rogue',
      tables: ['entities'],
      apply: (event, storage) => {
        if (event.type !== 'session.started') return;
        counter++;
        storage.prepare('INSERT OR REPLACE INTO entities (id, kind, name, canonical_id, created_at, updated_at) VALUES (?,?,?,NULL,?,?)')
          .run(`rogue-${event.seq}`, 'rogue', `invented ${counter}`, event.ts, event.ts);
      },
      reset: () => {},
    });
    s.events.append({ type: 'session.started', actor: 'user:ara', trust: 'USER', sessionId: 'a', payload: { channel: 'veo' } });
    const before = snapshotDigest(s.storage, s.crypto);
    s.events.rebuild();
    const after = snapshotDigest(s.storage, s.crypto);
    expect(after.digest).not.toBe(before.digest);
    s.close();
  });

  it('is unaffected by SQLite row order, not merely by luck', () => {
    // Deleting and reinserting changes physical layout; the logical digest
    // must not move.
    const s = createTestSubstrate();
    seed(s, 500);
    const before = snapshotDigest(s.storage, s.crypto);
    s.storage.prepare('VACUUM').run();
    expect(snapshotDigest(s.storage, s.crypto).digest).toBe(before.digest);
    s.close();
  });
});
