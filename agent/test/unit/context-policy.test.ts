import { describe, expect, it } from 'vitest';
import {
  ContextPolicySchema,
  MODEL_WINDOWS,
  assertUnevictableFits,
  policyFor,
  resolveBudgets,
} from '../../src/cognition/context/policy.js';
import { ContextTooSmallError, SURVIVAL_ORDER, type BlockName } from '../../src/cognition/context/types.js';

const shares = (value: number): Record<BlockName, number> =>
  Object.fromEntries(SURVIVAL_ORDER.map((name) => [name, value])) as Record<BlockName, number>;

describe('context budgets are declared, not invented (§21)', () => {
  it('rejects shares that sum to more than the window', () => {
    // Over-subscription is the bug worth catching at parse time: every block
    // "fits" until they are all full at once, and then whatever happens to be
    // last that day is what silently overflows.
    const result = ContextPolicySchema.safeParse({
      version: 'x',
      model: 'm',
      window: 1000,
      reserveForOutput: 100,
      shares: shares(0.5),
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('more than the window');
  });

  it('rejects a minTokens entry naming a block that does not exist', () => {
    const result = ContextPolicySchema.safeParse({
      version: 'x',
      model: 'm',
      window: 1000,
      reserveForOutput: 100,
      shares: shares(1 / 14),
      minTokens: { recollections: 50 },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("'recollections' is not a context block");
  });

  it('rejects reserving the whole window for output', () => {
    const result = ContextPolicySchema.safeParse({
      version: 'x',
      model: 'm',
      window: 1000,
      reserveForOutput: 1000,
      shares: shares(1 / 14),
    });
    expect(result.success).toBe(false);
  });

  it('splits the window by share, after the output reserve', () => {
    const policy = policyFor('gpt-4o');
    const budgets = resolveBudgets(policy);
    expect(budgets.total).toBe(policy.window - policy.reserveForOutput);
    expect(budgets.byBlock.conversation.tokens).toBe(
      Math.floor(budgets.total * policy.shares.conversation),
    );
    // Conversation is the largest claim: recency is what coherence is made of.
    for (const name of SURVIVAL_ORDER) {
      if (name === 'conversation') continue;
      expect(budgets.byBlock.conversation.tokens).toBeGreaterThanOrEqual(
        budgets.byBlock[name].tokens,
      );
    }
  });

  it('honours a floor even when the share rounds below it', () => {
    const policy = policyFor('local-small', { minTokens: { situation: 900 } });
    expect(resolveBudgets(policy).byBlock.situation.tokens).toBe(900);
  });

  it('gives different models different splits from the same shares', () => {
    const small = resolveBudgets(policyFor('local-small'));
    const large = resolveBudgets(policyFor('claude-3-5-sonnet'));
    expect(large.byBlock.memories.tokens).toBeGreaterThan(small.byBlock.memories.tokens * 10);
    expect(MODEL_WINDOWS['claude-3-5-sonnet']).toBe(200_000);
  });

  it('falls back to a conservative window for an unknown model', () => {
    // Wrong in the safe direction: assembling for 8k and sending to a 200k
    // model wastes window; the reverse truncates a user's conversation.
    expect(policyFor('some-new-model').window).toBe(8_000);
  });

  it('refuses outright when the unevictable blocks cannot fit', () => {
    const costs = Object.fromEntries(SURVIVAL_ORDER.map((n) => [n, 0])) as Record<BlockName, number>;
    costs.kernel = 600;
    costs.constitution = 500;
    costs.identity = 400;
    costs.constraints = 200;

    expect(() => assertUnevictableFits(costs, 5_000)).not.toThrow();
    expect(() => assertUnevictableFits(costs, 1_000)).toThrow(ContextTooSmallError);
    // The message has to be actionable: someone meets this at 3am.
    try {
      assertUnevictableFits(costs, 1_000);
    } catch (error) {
      expect((error as Error).message).toContain('1700');
      expect((error as Error).message).toContain('Raise the budget');
    }
  });
});
