/**
 * Tests 31–35: the ask budget (§24.2).
 *
 * Every test here asserts a refusal. That is the shape of the section: the
 * failure mode is not asking too little, it is turning into a form.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET, RETRY_AFTER_MS, orderCandidates, questionHash } from '../../src/cognition/calibration/probe.js';
import { DAY, PRINCIPAL, harness, type ConstitutionHarness } from '../fixtures/constitution.js';

let h: ConstitutionHarness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  h.close();
});

const candidate = (question: string, over: Partial<{ factId: string | null; predicted: number; informationValue: number; costOfBeingWrong: number }> = {}) => ({
  factId: over.factId ?? null,
  question,
  predicted: over.predicted ?? 0.5,
  informationValue: over.informationValue ?? 0.5,
  costOfBeingWrong: over.costOfBeingWrong ?? 0.5,
});

describe('the budget', () => {
  it('31. caps hold per session and per day', () => {
    h.probes.enqueue(PRINCIPAL, [
      candidate('Do you still work at Globex?'),
      candidate('Is Sam still your manager?'),
      candidate('Are you still in Berlin?'),
      candidate('Do you still cycle to work?'),
    ]);

    const first = h.probes.next(PRINCIPAL, { sessionId: 's1', atNaturalBreak: true });
    expect(first).toHaveLength(DEFAULT_BUDGET.perSession);
    h.probes.markAsked(PRINCIPAL, first[0]!.id, 's1');

    // Session cap: nothing more in this session, however long it runs.
    expect(h.probes.next(PRINCIPAL, { sessionId: 's1', atNaturalBreak: true })).toHaveLength(0);

    for (let i = 2; i <= DEFAULT_BUDGET.perDay; i += 1) {
      const next = h.probes.next(PRINCIPAL, { sessionId: `s${i}`, atNaturalBreak: true });
      expect(next).toHaveLength(1);
      h.probes.markAsked(PRINCIPAL, next[0]!.id, `s${i}`);
    }
    // Day cap: a new session does not reset it.
    expect(h.probes.next(PRINCIPAL, { sessionId: 's99', atNaturalBreak: true })).toHaveLength(0);

    h.clock.advance(DAY + 1000);
    expect(h.probes.next(PRINCIPAL, { sessionId: 's100', atNaturalBreak: true }).length).toBeGreaterThan(0);
  });

  it('32. a declined question is never asked again, in any wording', () => {
    h.probes.enqueue(PRINCIPAL, [candidate('Do you still work at Globex?', { factId: 'f1' })]);
    const [probe] = h.probes.next(PRINCIPAL, { sessionId: 's1', atNaturalBreak: true });
    h.probes.markAsked(PRINCIPAL, probe!.id, 's1');
    h.probes.answer(PRINCIPAL, probe!.id, 'declined');

    // Re-enqueueing the same fact with new words adds nothing: identity is
    // the fact, not the sentence.
    expect(h.probes.enqueue(PRINCIPAL, [candidate('Are you at Globex these days?', { factId: 'f1' })])).toBe(0);
    h.clock.advance(DAY * 3);
    expect(h.probes.next(PRINCIPAL, { sessionId: 's2', atNaturalBreak: true })).toHaveLength(0);
    expect(h.probes.state(PRINCIPAL).declined).toBe(1);
  });

  it('33. unanswered twice is dropped permanently and the fact marked unresolvable', () => {
    h.probes.enqueue(PRINCIPAL, [candidate('Still cycling to work?', { factId: 'f9' })]);
    const [probe] = h.probes.next(PRINCIPAL, { sessionId: 's1', atNaturalBreak: true });
    h.probes.markAsked(PRINCIPAL, probe!.id, 's1');
    h.probes.answer(PRINCIPAL, probe!.id, 'unknown');

    // A week later — an unanswered question waits (RETRY_AFTER_MS) before
    // it may be asked a second time. Back-to-back is nagging.
    h.clock.advance(DAY + 1);
    expect(h.probes.next(PRINCIPAL, { sessionId: 's1b', atNaturalBreak: true })).toHaveLength(0);
    h.clock.advance(RETRY_AFTER_MS);
    const [again] = h.probes.next(PRINCIPAL, { sessionId: 's2', atNaturalBreak: true });
    expect(again?.id).toBe(probe!.id);
    h.probes.markAsked(PRINCIPAL, again!.id, 's2');
    h.probes.answer(PRINCIPAL, again!.id, 'unknown');

    expect(h.probes.state(PRINCIPAL).unresolvable).toBe(1);
    h.clock.advance(DAY + 1);
    expect(h.probes.next(PRINCIPAL, { sessionId: 's3', atNaturalBreak: true })).toHaveLength(0);
  });

  it('34. priority is information value × cost of being wrong, tie-broken by uncertainty', () => {
    const ordered = orderCandidates([
      candidate('low', { informationValue: 0.2, costOfBeingWrong: 0.2 }),
      candidate('high', { informationValue: 0.9, costOfBeingWrong: 0.9 }),
      candidate('mid', { informationValue: 0.9, costOfBeingWrong: 0.3 }),
    ]);
    expect(ordered.map((c) => c.question)).toEqual(['high', 'mid', 'low']);

    const tied = orderCandidates([
      candidate('confident', { predicted: 0.95, informationValue: 0.5, costOfBeingWrong: 0.5 }),
      candidate('unsure', { predicted: 0.5, informationValue: 0.5, costOfBeingWrong: 0.5 }),
    ]);
    expect(tied[0]!.question).toBe('unsure');
  });

  it('35. nothing is asked mid-task', () => {
    h.probes.enqueue(PRINCIPAL, [candidate('Do you still work at Globex?')]);
    expect(h.probes.next(PRINCIPAL, { sessionId: 's1', atNaturalBreak: false })).toHaveLength(0);
    expect(h.probes.next(PRINCIPAL, { sessionId: 's1', atNaturalBreak: true })).toHaveLength(1);
  });

  it('a probe and its answer are both events (§24.2)', () => {
    h.probes.enqueue(PRINCIPAL, [candidate('Do you still live in Berlin?', { factId: 'f2' })]);
    const [probe] = h.probes.next(PRINCIPAL, { sessionId: 's1', atNaturalBreak: true });
    h.probes.markAsked(PRINCIPAL, probe!.id, 's1');
    h.probes.answer(PRINCIPAL, probe!.id, 'confirmed');

    expect(h.substrate.events.read({ types: ['calibration.probed'] })).toHaveLength(1);
    expect(h.substrate.events.read({ types: ['calibration.answered'] })).toHaveLength(1);
    // A confirmed probe resolves a prediction, which is what the Brier
    // score is computed over.
    expect(h.probes.resolutions(PRINCIPAL)).toHaveLength(1);
  });

  it('question identity collapses rewordings of the same fact', () => {
    expect(questionHash('f1', 'Do you still work at Globex?')).toBe(questionHash('f1', 'Still at Globex?'));
    expect(questionHash(null, 'Do you still work at Globex?')).not.toBe(questionHash(null, 'Still at Globex?'));
  });
});
