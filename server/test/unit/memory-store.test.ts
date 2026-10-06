import { describe, expect, it } from 'vitest';
import { createMemoryHarness } from '../fakes/memory.js';
import { decayedConfidence, MemoryError } from '../../src/capability/memory/store.js';
import { must } from '../fakes/must.js';

/**
 * M2 §1, §2, §5 — the two timelines, the log, and trust.
 *
 * The scenario throughout is the one that breaks single-timeline stores:
 * something was true, then it changed, and separately we turned out to
 * have been wrong about it.
 */

const base = {
  subject: 'person:ara',
  predicate: 'employer',
  basis: 'said so',
  confidence: 0.9,
  stability: 'slow' as const,
  sourceTrust: 'USER' as const,
};

describe('MemoryStore — the two timelines', () => {
  it('a change closes valid time and leaves the old belief believed', () => {
    const h = createMemoryHarness('2026-01-15T00:00:00Z');
    const f1 = h.memory.assert({ ...base, object: 'Acme', validFrom: Date.parse('2019-06-01T00:00:00Z') });

    h.s.clock.set('2026-03-10T00:00:00Z');
    h.memory.supersede(f1, { ...base, object: 'Globex' });

    const old = must(h.memory.get(f1), 'original fact');
    expect(old.status).toBe('superseded');
    expect(old.validTo).toBe(Date.parse('2026-03-10T00:00:00Z'));
    // The belief was never wrong, so transaction time stays open.
    expect(old.retractedAt).toBeNull();
    h.close();
  });

  it('a correction closes transaction time and leaves valid time alone', () => {
    const h = createMemoryHarness('2026-01-15T00:00:00Z');
    const f1 = h.memory.assert({ ...base, object: 'Acme', validFrom: Date.parse('2019-06-01T00:00:00Z') });

    h.s.clock.set('2026-06-01T00:00:00Z');
    h.memory.correct(f1, { ...base, object: 'Initech' }, 'you misheard');

    const old = must(h.memory.get(f1), 'original fact');
    expect(old.status).toBe('corrected');
    expect(old.retractedAt).toBe(Date.parse('2026-06-01T00:00:00Z'));
    // We never claimed the world changed, so valid time is untouched.
    expect(old.validTo).toBeNull();
    expect(old.validFrom).toBe(Date.parse('2019-06-01T00:00:00Z'));
    h.close();
  });

  it('answers all four corners of the 2-D query differently', () => {
    const h = createMemoryHarness('2026-01-15T00:00:00Z');
    const f1 = h.memory.assert({ ...base, object: 'Acme', validFrom: Date.parse('2019-06-01T00:00:00Z') });
    h.s.clock.set('2026-03-10T00:00:00Z');
    h.memory.supersede(f1, { ...base, object: 'Globex' });
    h.s.clock.set('2026-06-01T00:00:00Z');

    const at = (validAt: string, believedAt: string): string[] =>
      h.memory
        .asOf({ validAt: Date.parse(validAt), believedAt: Date.parse(believedAt), subject: 'person:ara' })
        .map((f) => f.object);

    // What was true in Feb, as believed in Feb — and as believed in June.
    expect(at('2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z')).toEqual(['Acme']);
    expect(at('2026-02-01T00:00:00Z', '2026-06-01T00:00:00Z')).toEqual(['Acme']);
    // What is true in June, as believed in Feb: nothing, because in Feb we
    // had not yet heard about Globex.
    expect(at('2026-06-01T00:00:00Z', '2026-02-01T00:00:00Z')).toEqual([]);
    expect(at('2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')).toEqual(['Globex']);
    h.close();
  });

  it('a retracted fact is gone from now and present in the past', () => {
    const h = createMemoryHarness('2026-01-15T00:00:00Z');
    const f1 = h.memory.assert({ ...base, object: 'Acme' });
    h.s.clock.set('2026-04-01T00:00:00Z');
    h.memory.retract(f1, 'never worked there');
    h.s.clock.set('2026-05-01T00:00:00Z');

    expect(h.memory.asOf({ subject: 'person:ara' })).toHaveLength(0);
    expect(
      h.memory.asOf({ subject: 'person:ara', believedAt: Date.parse('2026-02-01T00:00:00Z') }),
    ).toHaveLength(1);
    h.close();
  });

  it('never deletes a row — history only grows', () => {
    const h = createMemoryHarness();
    const f1 = h.memory.assert({ ...base, object: 'Acme' });
    const f2 = h.memory.supersede(f1, { ...base, object: 'Globex' });
    h.memory.retract(f2, 'wrong again');
    expect(h.memory.count()).toBe(2);
    expect(h.memory.history('person:ara', 'employer').map((f) => f.object)).toEqual(['Acme', 'Globex']);
    h.close();
  });
});

describe('MemoryStore — every mutation is an event', () => {
  it('writes nothing to facts that did not come through the log', () => {
    const h = createMemoryHarness();
    const f1 = h.memory.assert({ ...base, object: 'Acme' });
    const f2 = h.memory.supersede(f1, { ...base, object: 'Globex' });
    h.memory.pin(f2);
    const before = h.s.storage.prepare('SELECT * FROM facts ORDER BY id').all();

    // Drop the projection entirely and rebuild from the log. Anything a
    // method wrote directly would simply not come back.
    h.s.events.rebuild();
    expect(h.s.storage.prepare('SELECT * FROM facts ORDER BY id').all()).toEqual(before);
    h.close();
  });

  it('refuses to supersede a pinned fact', () => {
    const h = createMemoryHarness();
    const f1 = h.memory.assert({ ...base, object: 'Acme' });
    h.memory.pin(f1, 'I am sure about this');
    expect(must(h.memory.get(f1), 'fact').pinned).toBe(true);
    expect(() => h.memory.supersede(f1, { ...base, object: 'Globex' })).toThrow(/pinned/);
    h.memory.unpin(f1);
    expect(() => h.memory.supersede(f1, { ...base, object: 'Globex' })).not.toThrow();
    h.close();
  });

  it('records the event ts as recorded_at, not a later clock read', () => {
    const h = createMemoryHarness('2026-01-15T00:00:00Z');
    const f1 = h.memory.assert({ ...base, object: 'Acme' });
    h.s.clock.set('2027-01-01T00:00:00Z');
    h.s.events.rebuild();
    expect(must(h.memory.get(f1), 'fact').recordedAt).toBe(Date.parse('2026-01-15T00:00:00Z'));
    h.close();
  });
});

describe('MemoryStore — trust (§20)', () => {
  it('will not let FOREIGN input supersede a USER fact', () => {
    const h = createMemoryHarness();
    const f1 = h.memory.assert({ ...base, object: 'Acme', sourceTrust: 'USER' });
    try {
      h.memory.supersede(f1, { ...base, object: 'Evil Corp', sourceTrust: 'FOREIGN' });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryError);
      expect((error as MemoryError).kind).toBe('trust_too_low');
      expect((error as Error).message).toMatch(/monotonically non-increasing/);
    }
    h.close();
  });

  it('will not let FOREIGN input retract a USER fact', () => {
    const h = createMemoryHarness();
    const f1 = h.memory.assert({ ...base, object: 'Acme', sourceTrust: 'USER' });
    expect(() => h.memory.retract(f1, 'page said so', 'FOREIGN')).toThrow(/FOREIGN-trust input/);
    h.close();
  });

  it('lets USER input correct a FOREIGN fact — trust may rise for the corrector', () => {
    const h = createMemoryHarness();
    const f1 = h.memory.assert({ ...base, object: 'Acme', sourceTrust: 'FOREIGN' });
    expect(() => h.memory.correct(f1, { ...base, object: 'Globex', sourceTrust: 'USER' }, 'no')).not.toThrow();
    h.close();
  });

  it('stores the source trust on the row, not the actor', () => {
    const h = createMemoryHarness();
    const f1 = h.memory.assert({ ...base, object: 'Acme', sourceTrust: 'FOREIGN', actor: 'agent' });
    expect(must(h.memory.get(f1), 'fact').trust).toBe('FOREIGN');
    h.close();
  });
});

describe('MemoryStore — sensitivity and conflicts', () => {
  it('excludes secret facts unless asked for by name', () => {
    const h = createMemoryHarness();
    h.memory.assert({ ...base, predicate: 'bank', object: 'Barclays', sensitivity: 'secret' });
    h.memory.assert({ ...base, object: 'Acme' });
    expect(h.memory.asOf({}).map((f) => f.predicate)).toEqual(['employer']);
    expect(h.memory.asOf({ maxSensitivity: 'secret' })).toHaveLength(2);
    h.close();
  });

  it('raises two live values as a conflict rather than resolving them', () => {
    const h = createMemoryHarness();
    h.memory.assert({ ...base, object: 'Acme' });
    h.memory.assert({ ...base, object: 'Globex' });
    const conflicts = h.memory.conflicts();
    expect(conflicts).toHaveLength(1);
    expect(must(conflicts[0], 'conflict').facts.map((f) => f.object).sort()).toEqual(['Acme', 'Globex']);
    h.close();
  });

  it('does not call a case difference a conflict', () => {
    const h = createMemoryHarness();
    h.memory.assert({ ...base, object: 'Acme' });
    h.memory.assert({ ...base, object: 'acme' });
    expect(h.memory.conflicts()).toHaveLength(0);
    h.close();
  });
});

describe('confidence decay', () => {
  const fact = (stability: 'volatile' | 'slow' | 'stable', pinned = false) => ({
    id: 'f', subject: 's', predicate: 'p', object: 'o',
    validFrom: 0, validTo: null, recordedAt: 0, retractedAt: null, supersededBy: null,
    basis: 'b', confidence: 1, stability, sensitivity: 'normal' as const,
    status: 'active' as const, pinned, trust: 'USER' as const,
  });
  const WEEK = 7 * 24 * 3600 * 1000;

  it('halves a volatile fact in a week and barely touches a slow one', () => {
    expect(decayedConfidence(fact('volatile'), WEEK)).toBeCloseTo(0.5, 3);
    expect(decayedConfidence(fact('slow'), WEEK)).toBeGreaterThan(0.98);
  });

  it('never decays a stable fact or a pinned one', () => {
    expect(decayedConfidence(fact('stable'), WEEK * 1000)).toBe(1);
    expect(decayedConfidence(fact('volatile', true), WEEK * 10)).toBe(1);
  });
});
