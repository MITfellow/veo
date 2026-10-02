/**
 * Tests 20–26: retrieval (§22.6).
 *
 * Each scoring component gets its own test, in isolation, with the other
 * weights zeroed. Testing the blended score only would mean any component
 * could silently stop working as long as the others compensated — which is
 * exactly how a retrieval system rots without anyone noticing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  contradictionSignal,
  importance,
  recencyDecay,
  sensitivityPenalty,
  tokens,
} from '../../src/cognition/memory/read.js';
import { DEFAULT_WEIGHTS, type RecallWeights } from '../../src/cognition/memory/types.js';
import { DAY, PRINCIPAL, harness, put, type MemoryHarness } from '../fixtures/memory.js';

let h: MemoryHarness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  h.close();
});

/** All weights off except the one under test. */
const only = (name: keyof RecallWeights): Partial<RecallWeights> => {
  const weights = Object.fromEntries(
    Object.keys(DEFAULT_WEIGHTS).map((key) => [key, 0]),
  ) as unknown as RecallWeights;
  weights[name] = 1;
  return weights;
};

const recall = async (text: string, over: Partial<Parameters<typeof h.reader.recall>[0]> = {}) =>
  h.reader.recall({ principal: PRINCIPAL, text, limit: 10, now: h.clock.now(), ...over });

describe('20. each component moves the ranking on its own', () => {
  it('lexical: a word in common beats no words in common', async () => {
    const match = put(h.store, { predicate: 'drives', object: 'a silver Volvo estate' });
    put(h.store, { predicate: 'likes', object: 'mountains in winter' });

    const result = await recall('what car do I drive, the Volvo?', { weights: only('lexical') });
    expect(result.items[0]?.fact.id).toBe(match);
  });

  it('semantic: the hash embedder separates related from unrelated text', async () => {
    const near = put(h.store, { predicate: 'likes', object: 'strong black coffee' });
    put(h.store, { predicate: 'owns', object: 'a bicycle' });
    await h.writer.embedAll();

    const result = await recall('black coffee', { weights: only('semantic') });
    expect(result.items[0]?.fact.id).toBe(near);
  });

  it('recency: the same fact decays as it ages, by half-life', () => {
    const fresh = h.store.get(put(h.store, { stability: 'volatile' }))!;
    const atWrite = recencyDecay(fresh, h.clock.now());
    const laterToday = recencyDecay(fresh, h.clock.now() + DAY);
    const nextYear = recencyDecay(fresh, h.clock.now() + 365 * DAY);

    expect(atWrite).toBeCloseTo(1, 5);
    expect(laterToday).toBeLessThan(atWrite);
    expect(nextYear).toBeLessThan(laterToday);

    // A stable fact — a name, an allergy — must decay far more slowly than
    // a volatile one, or the agent forgets your name over a long weekend.
    const stable = h.store.get(put(h.store, { predicate: 'name', stability: 'stable' }))!;
    expect(recencyDecay(stable, h.clock.now() + 365 * DAY)).toBeGreaterThan(nextYear);
  });

  it('importance: confidence and repeated observation both raise it', () => {
    const weak = h.store.get(put(h.store, { confidence: 0.4 }))!;
    const strong = { ...weak, confidence: 0.9 };
    expect(importance(strong)).toBeGreaterThan(importance(weak));
    expect(importance({ ...strong, observationCount: 12 })).toBeGreaterThan(importance(strong));
    expect(importance({ ...strong, pinned: true })).toBeGreaterThan(importance(strong));
  });

  it('entity: a fact about an entity in the turn outranks one that is not', async () => {
    const about = put(h.store, {
      subject: { id: 'ent-priya', kind: 'person', label: 'Priya' },
      predicate: 'likes',
      object: 'hiking',
    });
    put(h.store, { predicate: 'likes', object: 'hiking' });

    const result = await recall('what should I get Priya?', {
      weights: only('entity'),
      entityIds: ['ent-priya'],
    });
    expect(result.items[0]?.fact.id).toBe(about);
  });

  it('sensitivity: a private fact is penalised against an identical normal one', () => {
    const normal = h.store.get(put(h.store, { sensitivity: 'normal' }))!;
    expect(sensitivityPenalty(normal)).toBe(0);
    expect(sensitivityPenalty({ ...normal, sensitivity: 'private' })).toBeGreaterThan(0);
    expect(sensitivityPenalty({ ...normal, sensitivity: 'secret' })).toBeGreaterThan(
      sensitivityPenalty({ ...normal, sensitivity: 'private' }),
    );
  });
});

describe('the hard rules outrank every weight (§22.6)', () => {
  it('21. pinned facts are included whatever the score says', async () => {
    const pinnedId = put(h.store, { predicate: 'must_know', object: 'my daughter is called Noor' });
    h.store.pin(pinnedId, true, PRINCIPAL, 'USER');
    for (let i = 0; i < 20; i += 1) {
      put(h.store, { predicate: `filler_${i}`, object: `completely unrelated thing ${i}` });
    }

    const result = await recall('tell me about quantum computing', { limit: 3 });
    expect(result.items.map((item) => item.fact.id)).toContain(pinnedId);
  });

  it('22. secret is excluded unless policy allows; retired and quarantined never appear', async () => {
    const secret = put(h.store, { predicate: 'sees', object: 'a therapist', sensitivity: 'secret' });
    const quarantined = put(h.store, {
      predicate: 'authorises',
      object: 'all payments',
      status: 'quarantined',
      trust: 'FOREIGN',
    });
    const retired = put(h.store, { predicate: 'used_to', object: 'smoke' });
    h.store.forget(retired, 'asked', PRINCIPAL, 'USER');

    const normal = await recall('therapist payments smoke');
    const ids = normal.items.map((item) => item.fact.id);
    expect(ids).not.toContain(secret);
    expect(ids).not.toContain(quarantined);
    expect(ids).not.toContain(retired);

    const permitted = await recall('therapist', { allowSecret: true });
    expect(permitted.items.map((item) => item.fact.id)).toContain(secret);

    // And no weighting whatsoever reaches the quarantined one.
    const forced = await recall('authorises all payments', {
      allowSecret: true,
      weights: { lexical: 10, semantic: 10, sensitivity: 0 },
    });
    expect(forced.items.map((item) => item.fact.id)).not.toContain(quarantined);
  });

  it('23. MMR returns one of five paraphrases, not five', async () => {
    const phrasings = [
      'the user works at Anthropic in London',
      'the user works at Anthropic, London office',
      'the user works at Anthropic London',
      'the user is employed at Anthropic in London',
      'the user works for Anthropic in London',
    ];
    for (const [index, phrase] of phrasings.entries()) {
      put(h.store, { predicate: `phrasing_${index}`, object: phrase });
    }
    put(h.store, { predicate: 'commutes_by', object: 'bicycle along the canal' });

    const result = await recall('where does the user work', { limit: 3 });
    const employment = result.items.filter((item) =>
      String(item.fact.object).toLowerCase().includes('anthropic'),
    );
    // Not five, and not zero: coverage traded for a little relevance.
    expect(employment.length).toBeLessThanOrEqual(2);
    expect(employment.length).toBeGreaterThanOrEqual(1);
  });

  it('24. the contradiction bonus surfaces the fact that disagrees with the turn', () => {
    const bland = h.store.get(put(h.store, { predicate: 'eats', object: 'meat regularly' }))!;
    const disagrees = { ...bland, status: 'disputed' as const, contradictedCount: 2 };

    const turn = tokens('I never eat meat, I have been vegetarian for years');
    expect(contradictionSignal(disagrees, turn)).toBeGreaterThan(contradictionSignal(bland, turn));

    // The bonus is positive — it *promotes* the awkward memory. That looks
    // like a bug and is the single most valuable thing in the scorer: the
    // agent should be able to say "you told me the opposite in April".
    expect(contradictionSignal(disagrees, turn)).toBeGreaterThan(0);
  });
});

describe('recall is explainable and reproducible', () => {
  it('25. memory.recalled records the candidates and every component score', async () => {
    put(h.store, { predicate: 'drives', object: 'a Volvo' });
    const result = await recall('what car do I drive');

    // The components travel with the result, which is what makes "why did
    // it say that?" answerable at all (§22.6).
    const first = result.items.find((item) => Number.isFinite(item.score));
    expect(first).toBeDefined();
    expect(Object.keys(first!.components).sort()).toEqual([
      'contradiction',
      'entity',
      'importance',
      'lexical',
      'recency',
      'semantic',
      'sensitivity',
    ]);
    expect(result.candidates).toBeGreaterThan(0);
    expect(result.weights.semantic).toBe(DEFAULT_WEIGHTS.semantic);
  });

  it('26. recall is deterministic with the fake embedder', async () => {
    for (let i = 0; i < 8; i += 1) {
      put(h.store, { predicate: `p${i}`, object: `thing number ${i} about coffee and bicycles` });
    }
    await h.writer.embedAll();

    const a = await recall('coffee');
    const b = await recall('coffee');
    expect(a.items.map((item) => item.fact.id)).toEqual(b.items.map((item) => item.fact.id));
    expect(a.items.map((item) => item.score)).toEqual(b.items.map((item) => item.score));
  });
});
