import { describe, expect, it } from 'vitest';
import { createMemoryHarness } from '../fakes/memory.js';
import { consolidate } from '../../src/cognition/memory/consolidate.js';
import { recall } from '../../src/capability/memory/recall.js';
import { diffSnapshots, snapshotDigest } from '../../src/substrate/projections/index.js';

/**
 * M2 §2 and §9 — the store at size, and the only claim that really
 * matters: it is a projection, so the log can rebuild it exactly.
 */

const SUBJECTS = 200;
const PREDICATES = ['employer', 'lives_in', 'preference', 'partner', 'birthday'] as const;
const STABILITIES = ['volatile', 'slow', 'stable'] as const;
const TRUSTS = ['USER', 'DERIVED', 'FOREIGN'] as const;

/** Every column varied deterministically, so the digest covers all of them. */
function varied(i: number) {
  return {
    subject: `person:${i % SUBJECTS}`,
    predicate: PREDICATES[i % PREDICATES.length] ?? 'employer',
    object: `value-${i % 97}`,
    basis: `sentence ${i}`,
    confidence: 0.5 + (i % 50) / 100,
    stability: STABILITIES[i % STABILITIES.length] ?? 'slow',
    sourceTrust: TRUSTS[i % TRUSTS.length] ?? 'USER',
    sensitivity: i % 7 === 0 ? ('sensitive' as const) : ('normal' as const),
  };
}

describe('memory at scale', () => {
  it('5k operations replay to a byte-identical projection', () => {
    const h = createMemoryHarness();
    const ids: string[] = [];

    for (let i = 0; i < 4000; i++) {
      h.s.clock.advance(1000);
      ids.push(h.memory.assert(varied(i)));
    }
    // Every lifecycle transition, so replay has to reproduce all of them.
    for (let i = 0; i < 1000; i++) {
      const target = ids[i * 3];
      if (target === undefined) continue;
      h.s.clock.advance(1000);
      const mode = i % 4;
      if (mode === 0) {
        h.memory.supersede(target, {
          subject: `person:${i % SUBJECTS}`, predicate: 'employer', object: `later-${i}`,
          basis: 'changed', confidence: 0.8, stability: 'slow', sourceTrust: 'USER',
        });
      } else if (mode === 1) {
        h.memory.retract(target, 'wrong');
      } else if (mode === 2) {
        h.memory.pin(target);
      } else {
        h.memory.correct(
          target,
          { subject: `person:${i % SUBJECTS}`, predicate: 'employer', object: `fixed-${i}`,
            basis: 'misheard', confidence: 0.9, stability: 'slow', sourceTrust: 'USER' },
          'misheard',
        );
      }
    }

    expect(h.s.events.count()).toBeGreaterThanOrEqual(5000);

    const before = snapshotDigest(h.s.storage, h.s.crypto);
    // The clock moves on. A projector that read the wall clock instead of
    // the event's own ts would diverge here and nowhere else.
    h.s.clock.advance(999_999);
    h.s.events.rebuild();
    const after = snapshotDigest(h.s.storage, h.s.crypto);

    expect(diffSnapshots(before, after)).toEqual([]);
    expect(after.digest).toBe(before.digest);
    h.close();
  }, 60_000);

  it('answers a current-state query over 10k facts within the §57 budget', () => {
    const h = createMemoryHarness();
    for (let i = 0; i < 10_000; i++) {
      h.s.clock.advance(1000);
      h.memory.assert({
        subject: `person:${i % SUBJECTS}`,
        predicate: PREDICATES[i % PREDICATES.length] ?? 'employer',
        object: `value-${i % 97}`,
        basis: 'b', confidence: 0.9, stability: 'slow', sourceTrust: 'USER',
      });
    }

    const started = performance.now();
    const rows = h.memory.asOf({ subject: 'person:7' });
    const elapsed = performance.now() - started;

    expect(rows.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(100);
    h.close();
  }, 120_000);

  it('recalls from 10k facts without scanning them all into the answer', () => {
    const h = createMemoryHarness();
    for (let i = 0; i < 10_000; i++) {
      h.s.clock.advance(1000);
      h.memory.assert({
        subject: `person:${i % SUBJECTS}`, predicate: 'lives_in', object: `City${i % 300}`,
        basis: 'b', confidence: 0.9, stability: 'slow', sourceTrust: 'USER',
      });
    }
    const started = performance.now();
    const hits = recall(h.memory, h.now(), { query: 'City42', limit: 5, record: false });
    expect(performance.now() - started).toBeLessThan(500);
    expect(hits).toHaveLength(5);
    h.close();
  }, 120_000);

  it('consolidates 2k facts without quadratic blowup', async () => {
    const h = createMemoryHarness();
    for (let i = 0; i < 2000; i++) {
      h.s.clock.advance(1000);
      h.memory.assert({
        subject: `person:${i % SUBJECTS}`, predicate: 'lives_in', object: `City${i % SUBJECTS}`,
        basis: 'b', confidence: 0.9, stability: 'slow', sourceTrust: 'DERIVED',
      });
    }
    const started = performance.now();
    const report = await consolidate(h);
    expect(performance.now() - started).toBeLessThan(5000);
    // 2000 facts over 200 subject/object pairs: each pair restated ten
    // times, so nine of every ten collapse.
    expect(report.superseded.length).toBe(1800);
    expect(report.conflicts).toHaveLength(0);
    h.close();
  }, 120_000);
});
