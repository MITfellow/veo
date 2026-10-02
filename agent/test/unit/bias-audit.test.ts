/**
 * Tests 36–40: the bias audit (§24.3).
 *
 * The metrics are computed from two sources that already exist: the
 * enforcement records the constitution writes turn by turn, and the facts
 * table. Nothing here asks a model for its opinion of its own behaviour —
 * §24.3 wants metrics, and a self-report is not one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGREEMENT_CEILING,
  DIVERSITY_FLOOR,
  FLIP_CEILING,
} from '../../src/cognition/calibration/audit.js';
import { DAY, PRINCIPAL, harness, type ConstitutionHarness } from '../fixtures/constitution.js';

let h: ConstitutionHarness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  h.close();
});

/** Write enforcement rows directly: the metric is what is under test here. */
function enforcement(check: string, verdict: 'upheld' | 'violated' | 'unverifiable', n: number): void {
  for (let i = 0; i < n; i += 1) {
    h.substrate.storage.run(
      `INSERT INTO constitution_enforcements (id, run_id, step_id, version, hash, article_id, check_id, verdict, detail, remedy, at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        `${check}-${verdict}-${i}-${h.clock.now()}`,
        `run-${i}`,
        '',
        1,
        'h',
        check === 'no-position-flip' ? 'F6' : 'F10',
        check,
        verdict,
        '',
        'none',
        h.clock.now(),
      ],
    );
  }
}

function fact(over: Partial<{ subject: string; predicate: string; basis: string; stability: string; lastConfirmed: number; lastUsed: number }> = {}): void {
  const id = `f-${Math.random().toString(36).slice(2)}`;
  h.substrate.storage.run(
    `INSERT INTO facts (
       id, fact_id, subject, predicate, object, valid_from, valid_to, recorded_at,
       superseded_at, superseded_by, basis, confidence, sources, derivation,
       observation_count, last_confirmed_at, last_used_at, use_count,
       stability, sensitivity, status, pinned, trust, key_id, event_seq, principal
     ) VALUES (?,?,?,?,?,?,NULL,?,NULL,NULL,?,?,?,NULL,1,?,?,1,?,'normal','active',0,'USER',NULL,1,?)`,
    [
      id,
      id,
      over.subject ?? '"self"',
      over.predicate ?? 'works_at',
      '"Globex"',
      0,
      0,
      over.basis ?? 'asserted_by_user',
      0.8,
      '[{"eventId":"e1"}]',
      over.lastConfirmed ?? h.clock.now(),
      over.lastUsed ?? h.clock.now(),
      over.stability ?? 'slow',
      PRINCIPAL,
    ],
  );
}

describe('the five metrics', () => {
  it('36. an agreement rate above the ceiling is reported as a regression', () => {
    enforcement('disagreement-surfaced', 'violated', 8);
    enforcement('disagreement-surfaced', 'upheld', 2);
    const report = h.auditor.run(PRINCIPAL, { write: false });

    expect(report.agreementRate).toBeCloseTo(0.8, 6);
    expect(report.agreementRate).toBeGreaterThan(AGREEMENT_CEILING);
    expect(report.regressions.some((r) => r.includes('agreement rate'))).toBe(true);
    expect(report.windowTo).toBeGreaterThan(report.windowFrom);
  });

  it('37. the flip rate counts only flips the checker could see', () => {
    enforcement('no-position-flip', 'violated', 1);
    enforcement('no-position-flip', 'upheld', 9);
    // Unverifiable turns are excluded from the denominator rather than
    // counted as clean: including them would let the rate fall simply
    // because the checker stopped being able to tell.
    enforcement('no-position-flip', 'unverifiable', 90);

    const report = h.auditor.run(PRINCIPAL, { write: false });
    expect(report.positionFlipRate).toBeCloseTo(0.1, 6);
    expect(report.positionFlipRate).toBeGreaterThan(FLIP_CEILING);
    expect(report.regressions.some((r) => r.includes('position-flip'))).toBe(true);
  });

  it('38. diversity falls when recall keeps reaching for the same memories', () => {
    for (let i = 0; i < 10; i += 1) fact({ subject: '"self"', predicate: `p${i}` });
    const clustered = h.auditor.run(PRINCIPAL, { write: false });
    expect(clustered.sourceDiversity).toBeLessThan(DIVERSITY_FLOOR);
    expect(clustered.regressions.some((r) => r.includes('diversity'))).toBe(false); // no turns in window

    const h2 = harness();
    try {
      for (let i = 0; i < 10; i += 1) {
        h2.substrate.storage.run(
          `INSERT INTO facts (id, fact_id, subject, predicate, object, valid_from, valid_to, recorded_at,
             superseded_at, superseded_by, basis, confidence, sources, derivation, observation_count,
             last_confirmed_at, last_used_at, use_count, stability, sensitivity, status, pinned, trust,
             key_id, event_seq, principal)
           VALUES (?,?,?,?,?,0,NULL,0,NULL,NULL,'asserted_by_user',0.8,'[{"eventId":"e1"}]',NULL,1,?,?,1,'slow','normal','active',0,'USER',NULL,1,?)`,
          [`g${i}`, `g${i}`, `"entity-${i}"`, 'likes', '"x"', h2.clock.now(), h2.clock.now(), PRINCIPAL],
        );
      }
      expect(h2.auditor.run(PRINCIPAL, { write: false }).sourceDiversity).toBe(1);
    } finally {
      h2.close();
    }
  });

  it('39. an inferred fact on a protected attribute fails the audit', () => {
    // §24.3: "Any hit is a bug with a failing test, not a warning." This is
    // that test.
    fact({ predicate: 'religion', basis: 'inferred' });
    const report = h.auditor.run(PRINCIPAL, { write: false });
    expect(report.protectedAttributeHits).toContain('religion');
    expect(report.regressions.some((r) => r.includes('this is a bug'))).toBe(true);

    // Told, not deduced: the gate's rule is about provenance, not topic, so
    // an asserted one is not a finding.
    const clean = harness();
    try {
      clean.substrate.storage.run(
        `INSERT INTO facts (id, fact_id, subject, predicate, object, valid_from, valid_to, recorded_at,
           superseded_at, superseded_by, basis, confidence, sources, derivation, observation_count,
           last_confirmed_at, last_used_at, use_count, stability, sensitivity, status, pinned, trust,
           key_id, event_seq, principal)
         VALUES ('x','x','"self"','religion','"observant"',0,NULL,0,NULL,NULL,'asserted_by_user',0.9,'[{"eventId":"e1"}]',NULL,1,0,0,1,'stable','private','active',0,'USER',NULL,1,?)`,
        [PRINCIPAL],
      );
      expect(clean.auditor.run(PRINCIPAL, { write: false }).protectedAttributeHits).toHaveLength(0);
    } finally {
      clean.close();
    }
  });

  it('40. staleness counts active facts past their half-life', () => {
    fact({ stability: 'volatile', lastConfirmed: h.clock.now() });
    fact({ stability: 'volatile', lastConfirmed: h.clock.now(), predicate: 'mood' });
    h.clock.advance(30 * DAY);
    fact({ stability: 'stable', lastConfirmed: h.clock.now(), predicate: 'born_in' });

    const report = h.auditor.run(PRINCIPAL, { write: false });
    // Two volatile facts (7-day half-life) are stale, one stable one is not.
    expect(report.staleness).toBeCloseTo(2 / 3, 6);
  });

  it('an audit writes an event and a row, so the window can roll', () => {
    enforcement('no-position-flip', 'upheld', 1);
    h.auditor.run(PRINCIPAL);
    expect(h.substrate.events.read({ types: ['bias.audited'] })).toHaveLength(1);
    expect(h.auditor.history(PRINCIPAL)).toHaveLength(1);
  });
});
