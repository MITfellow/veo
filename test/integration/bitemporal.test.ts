import { describe, expect, it } from 'vitest';
import { createTestSubstrate } from '../../src/substrate/index.js';
import {
  currentFacts,
  factHistory,
  factsAsOfTransactionTime,
  factsAsOfValidTime,
  factsBitemporal,
} from '../../src/substrate/projections/facts.js';

/**
 * The scenario, which is the one §11 asks the system to survive:
 *
 *   January  we learn Maya works at Acme (and it has been true since 2024).
 *   March    we are still telling the user "Acme".
 *   June     Maya tells us she moved to Globex — in April.
 *
 * Afterwards three questions have three different right answers:
 *   "where does she work now?"              → Globex
 *   "where did she work in March?"          → Acme   (valid time)
 *   "what did you believe in March?"        → Acme   (transaction time)
 *   "what did you believe in July about March?" → still Acme, and that is
 *                                              correct, not a bug.
 */
const JAN = Date.parse('2026-01-10T00:00:00Z');
const MAR = Date.parse('2026-03-15T00:00:00Z');
const APR = Date.parse('2026-04-01T00:00:00Z');
const JUN = Date.parse('2026-06-20T00:00:00Z');
const JUL = Date.parse('2026-07-05T00:00:00Z');
const SINCE_2024 = Date.parse('2024-02-01T00:00:00Z');

function setup() {
  const s = createTestSubstrate();
  s.clock.set(JAN);

  const source = s.events.append({
    type: 'message.user',
    payload: { text: 'Maya works at Acme', attachments: [] },
    principal: 'user:ara',
    trust: 'USER',
    sessionId: 'sess-1',
  });

  s.events.append({
    type: 'memory.written',
    payload: {
      factId: 'maya-employer',
      subject: 'Maya',
      predicate: 'works_at',
      object: 'Acme',
      basis: 'asserted_by_user',
      confidence: 0.95,
      sources: [{ eventId: source.id, quote: 'Maya works at Acme' }],
      validFrom: SINCE_2024,
      validTo: null,
      stability: 'slow',
      sensitivity: 'normal',
      status: 'active',
    },
    principal: 'system',
    trust: 'USER',
    sessionId: 'sess-1',
  });

  return { s, source };
}

describe('bitemporal facts', () => {
  it('answers "where does she work now" with the current belief', () => {
    const { s } = setup();
    expect(currentFacts(s.storage, 'Maya', 'works_at')[0]?.object).toBe('"Acme"');
    s.close();
  });

  it('keeps both rows when a fact is superseded — nothing is deleted', () => {
    const { s, source } = setup();
    s.clock.set(JUN);

    s.events.append({
      type: 'memory.superseded',
      payload: { factId: 'maya-employer', supersededBy: 'maya-employer-v2', validTo: APR },
      principal: 'user:ara',
      trust: 'USER',
      sessionId: 'sess-1',
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
        sources: [{ eventId: source.id }],
        validFrom: APR,
        validTo: null,
        stability: 'slow',
        sensitivity: 'normal',
        status: 'active',
      },
      principal: 'system',
      trust: 'USER',
      sessionId: 'sess-1',
    });

    const all = s.storage.all<{ object: string }>('SELECT object FROM facts ORDER BY recorded_at');
    expect(all.map((r) => r.object)).toEqual(['"Acme"', '"Globex"']);

    expect(currentFacts(s.storage, 'Maya', 'works_at').map((f) => f.object)).toEqual(['"Globex"']);
    s.close();
  });

  it('separates valid time from transaction time', () => {
    const { s, source } = setup();
    s.clock.set(JUN);
    s.events.append({
      type: 'memory.superseded',
      payload: { factId: 'maya-employer', supersededBy: 'maya-employer-v2', validTo: APR },
      principal: 'user:ara',
      trust: 'USER',
      sessionId: 'sess-1',
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
        sources: [{ eventId: source.id }],
        validFrom: APR,
        validTo: null,
        stability: 'slow',
        sensitivity: 'normal',
        status: 'active',
      },
      principal: 'system',
      trust: 'USER',
      sessionId: 'sess-1',
    });

    // Valid time: what was true of the world in March.
    expect(factsAsOfValidTime(s.storage, 'Maya', MAR, 'works_at').map((f) => f.object)).toEqual([
      '"Acme"',
    ]);

    // Valid time: what is true of the world now.
    expect(factsAsOfValidTime(s.storage, 'Maya', JUL, 'works_at').map((f) => f.object)).toEqual([
      '"Globex"',
    ]);

    // Transaction time: what we believed in March, which was Acme — and we
    // were right about March. The honesty query.
    expect(
      factsAsOfTransactionTime(s.storage, 'Maya', MAR, 'works_at').map((f) => f.object),
    ).toEqual(['"Acme"']);

    // Transaction time: what we believed in May — still Acme, and by then we
    // were *wrong*. That is exactly what the system must be able to admit.
    const MAY = Date.parse('2026-05-10T00:00:00Z');
    expect(
      factsAsOfTransactionTime(s.storage, 'Maya', MAY, 'works_at').map((f) => f.object),
    ).toEqual(['"Acme"']);

    // Both axes: in July, what did we think was true in March?
    expect(factsBitemporal(s.storage, 'Maya', MAR, JUL).map((f) => f.object)).toEqual(['"Acme"']);
    s.close();
  });

  it('orders a backdated fact correctly in both timelines', () => {
    // Learned late (June) about a period that ended early (Feb–Mar).
    const { s, source } = setup();
    s.clock.set(JUN);
    s.events.append({
      type: 'memory.written',
      payload: {
        factId: 'maya-sabbatical',
        subject: 'Maya',
        predicate: 'on_sabbatical',
        object: true,
        basis: 'asserted_by_user',
        confidence: 0.9,
        sources: [{ eventId: source.id }],
        validFrom: Date.parse('2026-02-01T00:00:00Z'),
        validTo: Date.parse('2026-03-01T00:00:00Z'),
        stability: 'volatile',
        sensitivity: 'normal',
        status: 'active',
      },
      principal: 'system',
      trust: 'USER',
      sessionId: 'sess-1',
    });

    const feb = Date.parse('2026-02-14T00:00:00Z');
    expect(factsAsOfValidTime(s.storage, 'Maya', feb).map((f) => f.predicate)).toContain(
      'on_sabbatical',
    );
    // It was not true in March...
    expect(factsAsOfValidTime(s.storage, 'Maya', MAR).map((f) => f.predicate)).not.toContain(
      'on_sabbatical',
    );
    // ...and in March we did not even know about it yet.
    expect(factsAsOfTransactionTime(s.storage, 'Maya', MAR).map((f) => f.predicate)).not.toContain(
      'on_sabbatical',
    );
    s.close();
  });

  it('refuses to store a fact with no sources, at the database level', () => {
    const s = createTestSubstrate();
    // The zod schema stops it first; this proves the DB would stop it too, so
    // invariant 5 does not depend on one layer remembering.
    expect(() =>
      s.storage.run(
        `INSERT INTO facts (id, fact_id, subject, predicate, object, valid_from, recorded_at,
          basis, confidence, sources, trust, event_seq)
         VALUES ('r','f','s','p','"o"',0,0,'observed',0.5,'[]','USER',1)`,
      ),
    ).toThrow(/CHECK constraint/);
    s.close();
  });

  it('crypto-shreds a forgotten fact without deleting the row', () => {
    const { s, source } = setup();
    s.clock.set(JUL);
    s.events.append({
      type: 'memory.forgotten',
      payload: {
        factId: 'maya-employer',
        keyId: 'key-abc',
        reason: 'user asked me to forget where Maya works',
        shredded: true,
      },
      principal: 'user:ara',
      trust: 'USER',
      sessionId: 'sess-1',
    });

    const rows = factHistory(s.storage, 'maya-employer');
    expect(rows).toHaveLength(1); // the row survives: deletion is auditable
    expect(rows[0]?.object).not.toContain('Acme'); // the content does not
    expect(rows[0]?.object).toContain('shredded');
    expect(rows[0]?.status).toBe('retired');
    // And it has left the search index.
    expect(
      s.storage.get<{ n: number }>("SELECT COUNT(*) n FROM facts_fts WHERE text MATCH 'Acme'")?.n,
    ).toBe(0);
    // The event that *caused* the forgetting is still in the log, as is the
    // original memory.written. History is not edited, only the content is gone.
    expect(s.events.read({ types: ['memory.written', 'memory.forgotten'] })).toHaveLength(2);
    expect(source).toBeDefined();
    s.close();
  });

  it('supports lexical recall over facts', () => {
    const { s } = setup();
    const hit = s.storage.get<{ fact_id: string }>(
      "SELECT fact_id FROM facts_fts WHERE facts_fts MATCH 'Acme'",
    );
    expect(hit?.fact_id).toBe('maya-employer');
    s.close();
  });
});
