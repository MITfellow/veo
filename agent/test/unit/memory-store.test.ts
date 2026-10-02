/**
 * Tests 1–7: the schema and the bitemporal store (§22.2).
 *
 * These are the tests that stop memory from quietly becoming a key-value
 * cache with extra fields. Every one of them is about *not losing* something
 * — the source, the old value, the point-in-time answer, the tombstone.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FactSchema } from '../../src/cognition/memory/types.js';
import { DAY, PRINCIPAL, harness, put, type MemoryHarness } from '../fixtures/memory.js';

let h: MemoryHarness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  h.close();
});

const base = {
  id: 'f1',
  subject: { id: 'self', kind: 'self' as const, label: 'you' },
  predicate: 'works_at',
  object: 'Anthropic',
  basis: 'asserted_by_user' as const,
  confidence: 0.8,
  sources: [{ eventId: 'e1' }],
  validFrom: 0,
  recordedAt: 0,
  trust: 'USER' as const,
};

describe('the fact schema refuses what §22.2 calls REQUIRED', () => {
  it('1. rejects a fact with no sources at all', () => {
    // Invariant 5: a belief with no provenance is a rumour. The schema is
    // the only place this can be enforced once rather than at six call
    // sites, which is exactly why `.min(1)` lives there.
    const result = FactSchema.safeParse({ ...base, sources: [] });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('sources');
  });

  it('2. rejects confidence outside 0..1, and valid time that runs backwards', () => {
    expect(FactSchema.safeParse({ ...base, confidence: 1.4 }).success).toBe(false);
    expect(FactSchema.safeParse({ ...base, confidence: -0.1 }).success).toBe(false);

    // The schema cannot express validTo >= validFrom, so the database CHECK
    // does. Asserting it here keeps the constraint from being dropped in a
    // future migration without a test noticing.
    expect(() =>
      h.substrate.storage.run(
        `INSERT INTO facts (id, fact_id, subject, predicate, object, basis, confidence, sources,
           valid_from, valid_to, recorded_at, trust, status, event_seq)
         VALUES ('x','x','{}','p','o','asserted_by_user',0.5,'[{"eventId":"e"}]',
                 2000, 1000, 0, 'USER', 'active', 1)`,
      ),
    ).toThrow();
  });
});

describe('writing and superseding (§22.5 step 4)', () => {
  it('3. emits memory.written carrying the fact id and its basis', () => {
    const id = put(h.store);
    const events = h.substrate.storage.all<{ type: string; payload: string }>(
      "SELECT type, payload FROM events WHERE type = 'memory.written'",
    );
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload) as { factId: string; basis: string };
    expect(payload.factId).toBe(id);
    expect(payload.basis).toBe('asserted_by_user');
  });

  it('4. supersession writes a new row and leaves the old one readable', () => {
    const first = put(h.store, { object: 'Anthropic' });
    h.clock.advance(30 * DAY);
    const second = h.store.supersede({
      oldFactId: first,
      principal: PRINCIPAL,
      trust: 'USER',
      validTo: h.clock.now(),
      next: {
        subject: { id: 'self', kind: 'self', label: 'you' },
        predicate: 'works_at',
        object: 'OpenAI',
        basis: 'asserted_by_user',
        confidence: 0.85,
        sources: [{ eventId: 'e2', quote: 'I work at OpenAI now' }],
      },
    });

    const old = h.store.get(first);
    expect(old).toBeDefined();
    expect(old?.validTo).not.toBeNull();
    expect(old?.supersededBy).toBe(second);
    // The old belief is *not* deleted. "You used to work at Anthropic" has
    // to stay answerable, or the agent gaslights anyone who asks about
    // their own past.
    expect(old?.object).toBe('Anthropic');
    expect(h.store.get(second)?.object).toBe('OpenAI');

    expect(h.store.history(first).map((fact) => fact.object)).toContain('Anthropic');
  });

  it('5. answers what it believed on a past date, not what it believes now', () => {
    const first = put(h.store, { object: 'Anthropic' });
    const asked = h.clock.now();
    h.clock.advance(30 * DAY);
    h.store.supersede({
      oldFactId: first,
      principal: PRINCIPAL,
      trust: 'USER',
      validTo: h.clock.now(),
      next: {
        subject: { id: 'self', kind: 'self', label: 'you' },
        predicate: 'works_at',
        object: 'OpenAI',
        basis: 'asserted_by_user',
        confidence: 0.85,
        sources: [{ eventId: 'e2' }],
      },
    });

    const thenRows = h.substrate.storage.all<{ object: string }>(
      `SELECT object FROM facts
        WHERE predicate = 'works_at' AND valid_from <= ?
          AND (valid_to IS NULL OR valid_to > ?)`,
      [asked, asked],
    );
    expect(thenRows.map((row) => JSON.parse(row.object) as unknown)).toEqual(['Anthropic']);
  });

  it('6. active reads never return superseded, retired or quarantined rows', () => {
    const live = put(h.store, { object: 'Anthropic' });
    const dead = put(h.store, { object: 'Dead Co', predicate: 'worked_at' });
    h.store.supersede({
      oldFactId: dead,
      principal: PRINCIPAL,
      trust: 'USER',
      validTo: h.clock.now(),
      next: {
        subject: { id: 'self', kind: 'self', label: 'you' },
        predicate: 'worked_at',
        object: 'Newer Co',
        basis: 'asserted_by_user',
        confidence: 0.8,
        sources: [{ eventId: 'e3' }],
      },
    });
    put(h.store, { object: 'injected', predicate: 'claims', status: 'quarantined', trust: 'FOREIGN' });

    const recallable = h.store.recallable(PRINCIPAL).map((fact) => fact.id);
    expect(recallable).toContain(live);
    expect(recallable).not.toContain(dead);
    expect(h.store.recallable(PRINCIPAL).some((fact) => fact.status === 'quarantined')).toBe(false);
  });
});

describe('forgetting is destruction, not a flag (§13.3, §22.8)', () => {
  it('7. shreds the content, keeps a tombstone, and leaves the log parseable', () => {
    const id = put(h.store, { object: 'my therapist is Dr Mehta', sensitivity: 'secret' });
    expect(JSON.stringify(h.store.get(id))).toContain('Mehta');

    h.store.forget(id, 'the user asked', PRINCIPAL, 'USER');

    // The plaintext is gone from the facts table...
    const raw = h.substrate.storage.all<{ object: string | null }>(
      'SELECT object FROM facts WHERE fact_id = ?',
      [id],
    );
    expect(JSON.stringify(raw)).not.toContain('Mehta');
    // ...and from the search index, which is the half people forget.
    expect(h.store.searchText('Mehta')).toHaveLength(0);

    // The row survives as a tombstone: "there was something here and it was
    // deliberately destroyed" is itself information the user is owed.
    expect(raw).toHaveLength(1);

    // The event chain still verifies — shredding must not corrupt the log.
    const forgotten = h.substrate.storage.all(
      "SELECT 1 FROM events WHERE type = 'memory.forgotten'",
    );
    expect(forgotten).toHaveLength(1);
    expect(h.substrate.events.verifyChain().ok).toBe(true);
  });
});
