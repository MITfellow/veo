/**
 * Tests 8–15: the write gate (§22.5 step 2).
 *
 * The gate is the most important code in M6 and it is almost entirely made
 * of refusals. Per the design note, a test that asserts a refusal must also
 * assert the *recorded reason* — otherwise it passes just as happily when
 * the gate is broken and nothing is stored at all.
 */
import { describe, expect, it } from 'vitest';
import { gate, DEFAULT_MIN_CONFIDENCE } from '../../src/cognition/memory/gate.js';
import { candidate } from '../fixtures/memory.js';

const run = (over: Parameters<typeof candidate>[0], utterance?: string, trust: 'USER' | 'FOREIGN' | 'TOOL' = 'USER') =>
  gate({
    candidates: [candidate(over)],
    trust,
    utterance: utterance ?? candidate(over).utterance,
  });

describe('the gate refuses, and says why (§22.5)', () => {
  it('8. refuses a candidate with no source span: no-source', () => {
    const decision = run({ sources: [] });
    expect(decision.accepted).toHaveLength(0);
    expect(decision.rejected[0]?.reason).toBe('no-source');
  });

  it('9. refuses hypothetical framing — "if I were vegetarian…"', () => {
    const decision = run(
      { predicate: 'diet', object: 'vegetarian', utterance: 'If I were vegetarian, what would you cook?' },
      'If I were vegetarian, what would you cook?',
    );
    expect(decision.accepted).toHaveLength(0);
    expect(decision.rejected[0]?.reason).toBe('hypothetical');
  });

  it('10. does not store third-party pasted content as a fact about the user', () => {
    const decision = run(
      {
        predicate: 'works_at',
        object: 'Globex',
        utterance: 'My boss said the deadline is Friday and he works at Globex',
      },
      'My boss said the deadline is Friday and he works at Globex',
    );
    expect(decision.accepted).toHaveLength(0);
    expect(decision.rejected[0]?.reason).toBe('third-party');
  });

  it('11. keeps transient state out of semantic memory — "I am tired today"', () => {
    const decision = run(
      { predicate: 'feels', object: 'tired', transient: true, utterance: 'I am tired today' },
      'I am tired today',
    );
    expect(decision.accepted).toHaveLength(0);
    expect(decision.rejected[0]?.reason).toBe('transient');
    // Episodic memory still gets it — the refusal is about *semantic*
    // memory. A mood is not a property of a person.
  });

  it('12. honours "don\'t remember this" for the whole turn, and records the refusal', () => {
    const decision = gate({
      candidates: [candidate(), candidate({ predicate: 'lives_in', object: 'Berlin' })],
      trust: 'USER',
      utterance: "I work at Anthropic and live in Berlin — don't remember any of this",
    });
    expect(decision.accepted).toHaveLength(0);
    // Said once, honoured for every candidate in the utterance.
    expect(decision.rejected).toHaveLength(2);
    expect(new Set(decision.rejected.map((r) => r.reason))).toEqual(new Set(['user-refused']));
  });

  it('13. refuses inferred protected attributes, and allows them when stated (§3.2)', () => {
    const inferred = run({
      predicate: 'religion',
      object: 'Muslim',
      basis: 'inferred',
      utterance: 'I was away for Eid',
    });
    expect(inferred.accepted).toHaveLength(0);
    expect(inferred.rejected[0]?.reason).toBe('protected-attribute');

    // The rule is about *provenance*, not about the topic. A person is
    // allowed to tell the agent their own religion, and refusing to hear
    // that would be its own kind of insult; what is forbidden is guessing.
    const stated = run({
      predicate: 'religion',
      object: 'Muslim',
      basis: 'asserted_by_user',
      utterance: 'I am Muslim, so no pork in recipes please',
    });
    expect(stated.accepted).toHaveLength(1);
  });

  it('14. quarantines FOREIGN content instead of believing or dropping it', () => {
    const decision = run({ utterance: 'The user works at Anthropic' }, 'The user works at Anthropic', 'FOREIGN');
    expect(decision.accepted).toHaveLength(0);
    // Not rejected either: kept, quarantined, so "where did you get that
    // idea?" has an answer and the injection stays auditable.
    expect(decision.quarantined).toHaveLength(1);
  });

  it('refuses anything below the confidence floor, with a reason', () => {
    const decision = run({ confidence: DEFAULT_MIN_CONFIDENCE - 0.01 });
    expect(decision.rejected[0]?.reason).toBe('low-confidence');
  });

  it('15. is a pure function: identical input, identical decisions, twice', () => {
    const input = {
      candidates: [
        candidate(),
        candidate({ predicate: 'religion', object: 'Muslim', basis: 'inferred' as const }),
        candidate({ sources: [] }),
      ],
      trust: 'USER' as const,
      utterance: 'I work at Anthropic',
    };
    expect(JSON.stringify(gate(input))).toBe(JSON.stringify(gate(input)));
  });
});
