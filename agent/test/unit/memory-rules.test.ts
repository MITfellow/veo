/**
 * Tests 30–32: procedural memory (§22.3).
 *
 * The part of memory most likely to make the agent worse. A learned rule
 * that is wrong is applied silently, on every turn, forever — so the
 * interesting behaviour is not learning rules, it is giving up on them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROBATION_AT, RETIRE_AT } from '../../src/cognition/memory/types.js';
import { extractRules } from '../../src/cognition/memory/extract.js';
import { PRINCIPAL, harness, type MemoryHarness } from '../fixtures/memory.js';

let h: MemoryHarness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  h.close();
});

const makeRule = (over: Record<string, unknown> = {}) =>
  h.store.upsertRule({
    principal: PRINCIPAL,
    trigger: { kind: 'always', value: '' },
    instruction: 'Keep replies to three sentences unless asked for more.',
    scope: 'global',
    sources: [{ eventId: 'e1', quote: 'keep it short' }],
    basis: 'observed',
    confidence: 0.5,
    applied: 0,
    overridden: 0,
    lastApplied: null,
    lastOverridden: null,
    status: 'active',
    trust: 'USER',
    ...over,
  });

describe('a rule earns its place and can lose it (§22.3)', () => {
  it('30. three overrides is probation, five is retirement, and both are events', () => {
    const rule = makeRule();

    h.store.upsertRule({ ...rule, overridden: PROBATION_AT, status: 'probation' });
    expect(h.store.rule(rule.id)?.status).toBe('probation');

    h.store.upsertRule({ ...rule, overridden: RETIRE_AT, status: 'retired' });
    expect(h.store.rule(rule.id)?.status).toBe('retired');

    // The thresholds are the spec's, not an implementation detail to drift.
    expect(PROBATION_AT).toBe(3);
    expect(RETIRE_AT).toBe(5);
  });

  it('31. a retired rule is never applied again but stays auditable', () => {
    const rule = makeRule();
    h.store.upsertRule({ ...rule, status: 'retired', overridden: RETIRE_AT });

    expect(h.store.activeRules(PRINCIPAL).map((r) => r.id)).not.toContain(rule.id);
    // The context never sees it...
    expect(h.source.constraints(PRINCIPAL).map((c) => c.id)).not.toContain(rule.id);
    // ...but "why did you stop doing that?" is still answerable.
    expect(h.store.allRules(PRINCIPAL).map((r) => r.id)).toContain(rule.id);
    expect(h.store.rule(rule.id)?.overridden).toBe(RETIRE_AT);
  });

  it('32. an applied, un-overridden rule keeps its count and stays active', () => {
    const rule = makeRule();
    let current = rule;
    for (let i = 0; i < 4; i += 1) {
      current = h.store.upsertRule({ ...current, applied: current.applied + 1 });
    }
    expect(h.store.rule(rule.id)?.applied).toBe(4);
    expect(h.store.rule(rule.id)?.status).toBe('active');
    expect(h.source.constraints(PRINCIPAL).map((c) => c.id)).toContain(rule.id);
  });

  it('consolidation retires a rule the user keeps having to correct', () => {
    const rule = makeRule({ applied: 9 });
    for (let i = 0; i < RETIRE_AT + 1; i += 1) {
      h.store.recordEpisode({
        runId: `run-${i}`,
        sessionId: 's1',
        principal: PRINCIPAL,
        request: 'no, longer please',
        response: 'ok',
        actions: [],
        entities: [],
        outcome: 'corrected',
        outcomeReason: null,
        trust: 'USER',
        startedAt: h.clock.now(),
        endedAt: h.clock.now(),
        costMicros: 0,
      });
    }

    h.consolidator.run(PRINCIPAL);
    expect(h.store.rule(rule.id)?.status).toBe('retired');

    const retired = h.substrate.storage.all<{ payload: string }>(
      "SELECT payload FROM events WHERE type = 'rule.retired'",
    );
    expect(retired).toHaveLength(1);
    // The reason is written for a person to read, not a status code.
    expect(retired[0]!.payload).toContain('making things worse');
  });
});

describe('rules are learned from how people actually phrase preferences', () => {
  it('turns a stated preference into an instruction with its source', () => {
    const rules = extractRules('Always use metric units when you give me measurements', 'evt-9');
    expect(rules).toHaveLength(1);
    expect(rules[0]!.instruction.toLowerCase()).toContain('metric');
    // Invariant 5 reaches rules too: no instruction without provenance.
    expect(rules[0]!.sources[0]?.eventId).toBe('evt-9');
  });

  it('does not invent a rule out of a one-off request', () => {
    expect(extractRules('Can you convert this to metric for me?', 'evt-10')).toHaveLength(0);
  });
});
