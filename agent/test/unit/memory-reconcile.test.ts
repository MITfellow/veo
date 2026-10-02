/**
 * Tests 16–19: reconciliation (§22.5 step 4).
 *
 * Four cases, and only one of them is an update. Most memory bugs that
 * users actually notice are reconciliation bugs: the agent that forgets you
 * changed jobs, or the one that "learns" the same thing forty times and
 * becomes certain of it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { raiseConfidence } from '../../src/cognition/memory/store.js';
import { DAY, PRINCIPAL, harness, type MemoryHarness } from '../fixtures/memory.js';

let h: MemoryHarness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  h.close();
});

const observe = async (text: string, over: { trust?: 'USER' | 'FOREIGN' } = {}) =>
  h.writer.observe({
    principal: PRINCIPAL,
    sessionId: 's1',
    runId: `r-${h.clock.now()}`,
    episodeId: `ep-${h.clock.now()}`,
    text,
    eventId: `e-${h.clock.now()}`,
    trust: over.trust ?? 'USER',
  });

describe('reconciliation decides between four different things (§22.5)', () => {
  it('16. the same fact again confirms it: observations rise, confidence rises, bounded', async () => {
    const first = await observe('I work at Anthropic');
    expect(first.written).toHaveLength(1);

    for (let i = 0; i < 6; i += 1) {
      h.clock.advance(DAY);
      const again = await observe('I work at Anthropic');
      expect(again.confirmed).toHaveLength(1);
      expect(again.written).toHaveLength(0);
    }

    const fact = h.store.get(first.written[0]!);
    expect(fact?.observationCount).toBeGreaterThan(1);
    expect(fact?.confidence).toBeGreaterThan(0.8);
    // Never 1.0. An agent that reaches certainty cannot be corrected by
    // evidence afterwards, and a person who repeats themselves is not
    // proving anything — they are repeating themselves.
    expect(fact?.confidence).toBeLessThan(1);
    expect(raiseConfidence(0.9, 10_000)).toBeLessThanOrEqual(0.97);
  });

  it('17. a changed value supersedes: new fact from now, old one closed, both retrievable', async () => {
    const first = await observe('I work at Anthropic');
    h.clock.advance(90 * DAY);
    const second = await observe('I work at Globex');

    expect(second.superseded).toEqual([first.written[0]]);
    expect(second.written).toHaveLength(1);

    const old = h.store.get(first.written[0]!);
    expect(old?.validTo).toBe(h.clock.now());
    expect(old?.object).toBe('Anthropic');
    expect(h.store.get(second.written[0]!)?.object).toBe('Globex');

    // And the live view has moved on — a superseded fact is not recallable.
    const live = h.store.recallable(PRINCIPAL).filter((fact) => fact.predicate === 'works_at');
    expect(live.map((fact) => fact.object)).toEqual(['Globex']);
  });

  it('18. an equal-support conflict is disputed, and the probe is queued exactly once', async () => {
    // A *stable* predicate, stated twice, is the case that matters: where
    // someone works changes, and the reconciler treats a new employer as an
    // update. What someone is allergic to does not change on a Tuesday, so
    // a contradiction there is a disagreement to raise, not a value to
    // overwrite.
    const first = await observe('I am allergic to peanuts');
    const incumbent = first.written[0]!;
    h.clock.advance(DAY);
    await observe('I am allergic to peanuts');

    const conflict = await observe('I am allergic to shellfish');
    expect(conflict.disputed).toEqual([incumbent]);
    expect(h.store.get(incumbent)?.status).toBe('disputed');

    // Say it twice more. The dispute must not re-queue: being asked the
    // same clarifying question every turn is how an agent becomes
    // unusable.
    await observe('I am allergic to shellfish');
    await observe('I am allergic to shellfish');
    const disputes = h.substrate.storage.all(
      "SELECT 1 FROM events WHERE type = 'memory.disputed'",
    );
    expect(disputes).toHaveLength(1);
  });

  it('19. replaying the same observation batch changes nothing the second time', async () => {
    const payload = {
      principal: PRINCIPAL,
      sessionId: 's1',
      runId: 'r-fixed',
      episodeId: 'ep-fixed',
      text: 'I work at Anthropic and I live in Berlin',
      eventId: 'e-fixed',
      trust: 'USER' as const,
    };
    await h.writer.observe(payload);
    const after = h.store.recallable(PRINCIPAL).length;

    await h.writer.observe(payload);
    await h.writer.observe(payload);

    // Confirmations, not new rows: the belief count is stable under replay.
    expect(h.store.recallable(PRINCIPAL)).toHaveLength(after);
  });
});
