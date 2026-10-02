/**
 * Tests 27–29: the entity graph (§22.2).
 *
 * The asymmetry these tests encode: a missed merge costs one clarifying
 * question, a wrong merge fuses two people's lives inside a store designed
 * never to forget. So the threshold is high and the failure direction is
 * "ask", not "guess".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MERGE_THRESHOLD, normalize, similarity } from '../../src/cognition/memory/entities.js';
import { harness, type MemoryHarness } from '../fixtures/memory.js';

let h: MemoryHarness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  h.close();
});

describe('resolution is explicit and reversible', () => {
  it('27. "Priya", "P." and an alias all land on one entity', () => {
    const priya = h.entities.create('Priya', 'person');
    h.entities.addAlias(priya.id, 'my sister');

    // Exact name.
    expect(h.entities.resolve({ label: 'Priya', kind: 'person' }).entity.id).toBe(priya.id);
    // A recorded alias is as good as the name — that is what an alias is.
    expect(h.entities.resolve({ label: 'my sister', kind: 'person' }).entity.id).toBe(priya.id);
    // An initial, where only one candidate matches it. Note what carries
    // this: *not* the string score, which stays deliberately weak...
    expect(similarity(normalize('P.'), { ...priya, aliases: ['my sister'] })).toBeLessThan(
      MERGE_THRESHOLD,
    );
    // ...but uniqueness. One Priya and no other P means "P." can only be
    // her; add a second P and the agent must go back to asking.
    expect(h.entities.resolve({ label: 'P.', kind: 'person' }).entity.id).toBe(priya.id);

    h.entities.create('Pavel', 'person');
    expect(h.entities.resolve({ label: 'P.', kind: 'person' }).created).toBe(true);
  });

  it('28. below the threshold it creates a new entity and reports the near-miss', () => {
    const priya = h.entities.create('Priya Raman', 'person');
    const result = h.entities.resolve({ label: 'Priyanka Shah', kind: 'person' });

    // Two different people until someone says otherwise.
    expect(result.created).toBe(true);
    expect(result.entity.id).not.toBe(priya.id);
    // The ambiguity is handed back so it can be *asked about* later rather
    // than resolved by a coin flip now.
    expect(result.ambiguous.map((entity) => entity.id)).toContain(priya.id);
  });

  it('kinds never merge across each other: a project is not a person', () => {
    const person = h.entities.create('Atlas', 'person');
    const project = h.entities.resolve({ label: 'Atlas', kind: 'project' });
    expect(project.entity.id).not.toBe(person.id);
  });

  it('29. a merge is reversible, and both directions are on the record', () => {
    const a = h.entities.create('Priya', 'person');
    const b = h.entities.create('Priya Raman', 'person');

    h.entities.merge(b.id, a.id, 'the user confirmed they are the same person');
    // The merged entity answers as its target.
    expect(h.entities.resolve({ label: 'Priya Raman', kind: 'person' }).entity.id).toBe(a.id);

    h.entities.unmerge(b.id, 'the user said they are two different Priyas');
    expect(h.entities.get(b.id)?.mergedInto).toBeNull();

    const merges = h.substrate.storage.all<{ payload: string }>(
      "SELECT payload FROM events WHERE type = 'entity.merged' ORDER BY seq",
    );
    expect(merges).toHaveLength(2);
    expect(merges[0]!.payload).toContain('confirmed');
    expect(merges[1]!.payload).toContain('unmerged');
  });

  it('follows a chain of merges without looping forever', () => {
    const a = h.entities.create('A', 'person');
    const b = h.entities.create('B', 'person');
    const c = h.entities.create('C', 'person');
    h.entities.merge(c.id, b.id, 'same');
    h.entities.merge(b.id, a.id, 'same');
    expect(h.entities.resolve({ label: 'C', kind: 'person' }).entity.id).toBe(a.id);

    // A cycle is a data bug, not a reason to hang the agent.
    h.entities.merge(a.id, c.id, 'oops, a cycle');
    expect(() => h.entities.resolve({ label: 'C', kind: 'person' })).not.toThrow();
  });
});
