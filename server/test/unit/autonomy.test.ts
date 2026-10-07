import { describe, expect, it } from 'vitest';
import { effectiveRung, evaluateAutonomy, RUNGS, type Rung } from '../../src/orchestration/autonomy.js';
import { Budget, DEFAULT_BUDGET } from '../../src/orchestration/budget.js';
import type { Tier } from '../../src/capability/tools/contract.js';

/** M3 §3 and §7 — the ladder and the budget, in isolation. */

const TIERS: Tier[] = ['observe', 'interact', 'effect'];

describe('the autonomy ladder (§30)', () => {
  /**
   * The table, asserted literally. Every cell, written out, because a
   * ladder expressed as an inequality is one off-by-one away from letting
   * an effect run at L1 and nobody noticing.
   */
  const EXPECTED: Record<Rung, Record<Tier, boolean>> = {
    0: { observe: false, interact: false, effect: false },
    1: { observe: true, interact: false, effect: false },
    2: { observe: true, interact: true, effect: false },
    3: { observe: true, interact: true, effect: true },
    4: { observe: true, interact: true, effect: true },
  };

  it('permits exactly its own tier and everything below it, in all 15 cells', () => {
    for (const rung of RUNGS) {
      for (const tier of TIERS) {
        const verdict = evaluateAutonomy({ rung, tier, irreversible: false, trustInScope: ['USER'] });
        expect({ rung, tier, permitted: verdict.permitted })
          .toEqual({ rung, tier, permitted: EXPECTED[rung][tier] });
      }
    }
  });

  it('keeps an irreversible effect off every rung but the top', () => {
    for (const rung of RUNGS) {
      const verdict = evaluateAutonomy({ rung, tier: 'effect', irreversible: true, trustInScope: ['USER'] });
      expect({ rung, permitted: verdict.permitted }).toEqual({ rung, permitted: rung === 4 });
    }
  });

  it('caps at L1 when untrusted content is anywhere in scope (§20.2)', () => {
    for (const rung of RUNGS) {
      const { rung: effective, capped } = effectiveRung(rung, ['USER', 'FOREIGN']);
      expect(effective).toBe(Math.min(rung, 1));
      expect(capped).toBe(rung > 1);
    }
  });

  it('says *why* a configured L3 is behaving like L1', () => {
    const verdict = evaluateAutonomy({ rung: 3, tier: 'effect', irreversible: false, trustInScope: ['FOREIGN'] });
    expect(verdict.permitted).toBe(false);
    if (verdict.permitted) return;
    expect(verdict.capped).toBe(true);
    expect(verdict.reason).toMatch(/untrusted content is in scope/);
  });

  it('refuses without pretending it is a failure — it reports what it needs', () => {
    const verdict = evaluateAutonomy({ rung: 1, tier: 'effect', irreversible: false, trustInScope: ['USER'] });
    expect(verdict.permitted).toBe(false);
    if (verdict.permitted) return;
    expect(verdict.needs).toBe(3);
    expect(verdict.reason).toMatch(/needs L3/);
  });
});

describe('budgets (§27)', () => {
  it('counts against the injected clock, never the wall clock', () => {
    const budget = new Budget({ wallClock: 10_000 }, 1_000_000);
    expect(budget.check(1_005_000)).toBeNull();
    const breach = budget.check(1_011_000);
    expect(breach?.budget).toBe('wallClock');
    expect(breach?.message).toMatch(/11s against a 10s budget/);
  });

  it('breaches on the step *after* the limit, not on the limit itself', () => {
    const budget = new Budget({ steps: 2 }, 0);
    expect(budget.spend('steps', 0)).toBeNull();
    expect(budget.spend('steps', 0)).toBeNull();
    expect(budget.spend('steps', 0)?.budget).toBe('steps');
  });

  it('reports what is left, so a caller can say "three steps remaining"', () => {
    const budget = new Budget({ steps: 5 }, 0);
    budget.spend('steps', 0);
    budget.spend('steps', 0);
    expect(budget.remaining('steps', 0)).toBe(3);
    expect(budget.remaining('wallClock', 30_000)).toBe(DEFAULT_BUDGET.wallClock - 30_000);
  });

  it('exposes no way to raise a limit from inside a run', () => {
    const budget = new Budget({ steps: 1 }, 0) as unknown as Record<string, unknown>;
    // Not a style point: a run that can widen its own budget has no budget,
    // and looking for a door is the first thing an agent does at a wall.
    for (const key of Object.keys(budget)) expect(key).not.toMatch(/^set/i);
    expect(typeof budget['limits']).not.toBe('function');
  });
});
