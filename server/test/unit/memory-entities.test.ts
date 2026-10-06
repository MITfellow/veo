import { describe, expect, it } from 'vitest';
import { createMemoryHarness } from '../fakes/memory.js';
import { EntityError, normalizeName } from '../../src/capability/memory/entities.js';
import { must } from '../fakes/must.js';

/** M2 §3 — who is who, and what they used to be called. */

describe('normalizeName', () => {
  it('folds case, accents and punctuation but not words', () => {
    expect(normalizeName("O'Brien")).toBe('obrien');
    expect(normalizeName('O’Brien')).toBe('obrien');
    expect(normalizeName('Café  Guido')).toBe('cafe guido');
    expect(normalizeName('  Acme Ltd. ')).toBe('acme ltd');
  });

  it('does not collapse two different names into one', () => {
    expect(normalizeName('Ara Patel')).not.toBe(normalizeName('Ara Patil'));
  });
});

describe('EntityRegistry', () => {
  it('resolves an exact name and an alias', () => {
    const h = createMemoryHarness();
    const id = h.entities.create('org', 'Acme');
    h.entities.rename(id, 'Acme Global');

    expect(h.entities.candidates('Acme Global').map((c) => c.id)).toEqual([id]);
    // The old name still finds it — a note from 2023 says "Acme".
    expect(h.entities.candidates('acme').map((c) => c.id)).toEqual([id]);
    expect(must(h.entities.get(id), 'entity').aliases).toEqual(['Acme']);
    h.close();
  });

  it('follows a merge chain to its end', () => {
    const h = createMemoryHarness();
    const a = h.entities.create('person', 'Ara');
    const b = h.entities.create('person', 'Ara Patel');
    const c = h.entities.create('person', 'A. Patel');
    h.entities.merge(a, b);
    h.entities.merge(b, c);

    expect(h.entities.canonicalOf(a)).toBe(c);
    // The canonical record answers to every name it absorbed.
    expect(must(h.entities.get(c), 'canonical').aliases.sort()).toEqual(['Ara', 'Ara Patel']);
    h.close();
  });

  it('refuses a merge cycle instead of hanging', () => {
    const h = createMemoryHarness();
    const a = h.entities.create('person', 'Ara');
    const b = h.entities.create('person', 'Ara Patel');
    h.entities.merge(a, b);
    try {
      h.entities.merge(b, a);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(EntityError);
      expect((error as EntityError).kind).toBe('cycle');
    }
    expect(() => h.entities.merge(a, a)).toThrow(/cannot absorb itself/);
    h.close();
  });

  it('terminates on a cycle that somehow reached storage', () => {
    const h = createMemoryHarness();
    const a = h.entities.create('person', 'A');
    const b = h.entities.create('person', 'B');
    // Forge the loop directly: a projector bug upstream must not become a
    // hang down here.
    h.s.storage.prepare('UPDATE entities SET canonical_id = ? WHERE id = ?').run(b, a);
    h.s.storage.prepare('UPDATE entities SET canonical_id = ? WHERE id = ?').run(a, b);
    expect([a, b]).toContain(h.entities.canonicalOf(a));
    h.close();
  });

  it('makes facts about a merged entity reachable through the canonical id', () => {
    const h = createMemoryHarness();
    const a = h.entities.create('person', 'Ara');
    const b = h.entities.create('person', 'Ara Patel');
    h.memory.assert({
      subject: a, predicate: 'employer', object: 'Acme',
      basis: 'said so', confidence: 0.9, stability: 'slow', sourceTrust: 'USER',
    });
    h.entities.merge(a, b);

    const canonical = h.entities.canonicalOf(a);
    expect(canonical).toBe(b);
    // The fact still carries the absorbed id; the chain is what joins them.
    expect(h.memory.asOf({ subject: a }).map((f) => f.object)).toEqual(['Acme']);
    h.close();
  });

  it('refuses a nameless entity and an unknown id', () => {
    const h = createMemoryHarness();
    expect(() => h.entities.create('person', '   ')).toThrow(/needs a name/);
    expect(() => h.entities.rename('nope', 'X')).toThrow(/No entity/);
    h.close();
  });

  it('survives a rebuild with its aliases intact', () => {
    const h = createMemoryHarness();
    const a = h.entities.create('org', 'Acme');
    const b = h.entities.create('org', 'Acme Global Ltd');
    h.entities.rename(a, 'Acme Ltd');
    h.entities.merge(a, b);
    const before = h.s.storage.prepare('SELECT * FROM entity_aliases ORDER BY entity_id, normalized').all();

    h.s.events.rebuild();
    expect(h.s.storage.prepare('SELECT * FROM entity_aliases ORDER BY entity_id, normalized').all()).toEqual(before);
    h.close();
  });
});
