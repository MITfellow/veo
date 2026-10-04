import { describe, expect, it } from 'vitest';
import { createTestSubstrate } from '../fakes/substrate.js';
import { believedAt, validAt } from '../../src/substrate/projections/facts.js';

/**
 * §17 — the two timelines must answer different questions.
 *
 * Scenario, deliberately the one that breaks single-timeline systems:
 *   Jan: we learn Ara works at Acme (and has since 2019).
 *   Mar: Ara moves to Globex. The WORLD changed.
 *   Jun: we learn the Acme record was wrong all along. Our BELIEF changed.
 */
describe('bitemporal facts', () => {
  function scenario() {
    const s = createTestSubstrate({ start: '2026-01-15T00:00:00Z' });
    const assert = (id: string, object: string, validFrom: string) =>
      s.events.append({
        type: 'fact.asserted', actor: 'user:ara', trust: 'USER',
        payload: {
          factId: id, subject: 'person:ara', predicate: 'employer', object,
          validFrom: Date.parse(validFrom), validTo: null, basis: 'asserted_by_user',
          confidence: 0.9, stability: 'slow', sensitivity: 'normal', sourceTrust: 'USER',
        },
      });
    assert('f1', 'Acme', '2019-06-01T00:00:00Z');
    return { s, assert };
  }

  it('answers "where does he work now"', () => {
    const { s } = scenario();
    const rows = validAt(s.storage, Date.parse('2026-02-01T00:00:00Z'));
    expect(rows.map((r) => r.object)).toEqual(['Acme']);
    s.close();
  });

  it('separates a change in the world from a change in belief', () => {
    const { s, assert } = scenario();

    // March: the world changed. Close valid time, open a new row.
    s.clock.set('2026-03-10T00:00:00Z');
    assert('f2', 'Globex', '2026-03-01T00:00:00Z');
    s.events.append({
      type: 'fact.superseded', actor: 'user:ara', trust: 'USER',
      payload: { factId: 'f1', supersededBy: 'f2', validTo: Date.parse('2026-03-01T00:00:00Z') },
    });

    // "Where did he work in February?" — Acme, still true of that moment.
    expect(validAt(s.storage, Date.parse('2026-02-01T00:00:00Z')).map((r) => r.object)).toEqual(['Acme']);
    // "Where does he work now?" — Globex.
    expect(validAt(s.storage, Date.parse('2026-04-01T00:00:00Z')).map((r) => r.object)).toEqual(['Globex']);

    // June: we learn the Acme record was never right. Belief changes only.
    s.clock.set('2026-06-01T00:00:00Z');
    s.events.append({ type: 'fact.retracted', actor: 'user:ara', trust: 'USER', payload: { factId: 'f1', reason: 'never true' } });

    // "What did you believe in April?" — both rows were live beliefs then.
    const inApril = believedAt(s.storage, Date.parse('2026-04-01T00:00:00Z')).map((r) => r.id).sort();
    expect(inApril).toEqual(['f1', 'f2']);

    // "What do you believe now?" — only f2 survives the retraction.
    const nowBelieved = believedAt(s.storage, Date.parse('2026-07-01T00:00:00Z')).map((r) => r.id);
    expect(nowBelieved).toEqual(['f2']);

    s.close();
  });

  it('keeps both rows after superseding — nothing is deleted', () => {
    const { s, assert } = scenario();
    s.clock.set('2026-03-10T00:00:00Z');
    assert('f2', 'Globex', '2026-03-01T00:00:00Z');
    s.events.append({ type: 'fact.superseded', actor: 'user:ara', trust: 'USER', payload: { factId: 'f1', supersededBy: 'f2', validTo: Date.parse('2026-03-01T00:00:00Z') } });

    const all = s.storage.prepare('SELECT id, valid_to, superseded_by, status FROM facts ORDER BY id')
      .all<{ id: string; valid_to: number | null; superseded_by: string | null; status: string }>();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ id: 'f1', superseded_by: 'f2', status: 'superseded' });
    expect(all[0]?.valid_to).toBe(Date.parse('2026-03-01T00:00:00Z'));
    s.close();
  });

  it('a retraction does NOT touch valid time', () => {
    // The distinction the whole design exists for.
    const { s } = scenario();
    s.clock.set('2026-06-01T00:00:00Z');
    s.events.append({ type: 'fact.retracted', actor: 'user:ara', trust: 'USER', payload: { factId: 'f1', reason: 'wrong' } });
    const row = s.storage.prepare('SELECT valid_to, retracted_at FROM facts WHERE id = ?')
      .get<{ valid_to: number | null; retracted_at: number | null }>('f1');
    expect(row?.valid_to).toBeNull();
    expect(row?.retracted_at).toBe(Date.parse('2026-06-01T00:00:00Z'));
    s.close();
  });
});
