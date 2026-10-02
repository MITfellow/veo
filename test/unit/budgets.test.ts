import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DAILY_BUDGET,
  DEFAULT_RUN_BUDGET,
  DailyLedger,
  STOP_REASON_FOR,
  ZERO_SPEND,
  checkBudget,
  dayStart,
  wouldBreach,
  type Budget,
  type Spend,
} from '../../src/capability/budgets.js';
import { createTestSubstrate, type Substrate } from '../../src/substrate/index.js';
import { FakeClock } from '../../src/substrate/clock.js';

const spend = (over: Partial<Spend> = {}): Spend => ({ ...ZERO_SPEND(), ...over });

describe('every dimension can stop a run, with its own reason (§19)', () => {
  const budget: Budget = {
    steps: 10,
    tokens: 1000,
    wallMs: 5000,
    costMicros: 100,
    egressBytes: 2048,
    toolCalls: 5,
  };

  const cases: Array<[keyof Budget, Partial<Spend>, string]> = [
    ['steps', { steps: 10 }, 'step-cap'],
    ['tokens', { tokens: 1000 }, 'token-cap'],
    ['wallMs', { wallMs: 5000 }, 'time-cap'],
    ['costMicros', { costMicros: 100 }, 'cost-cap'],
    ['egressBytes', { egressBytes: 2048 }, 'egress-cap'],
    ['toolCalls', { toolCalls: 5 }, 'tool-cap'],
  ];

  for (const [dimension, over, reason] of cases) {
    it(`${dimension} → ${reason}`, () => {
      const breach = checkBudget(budget, spend(over));
      expect(breach?.dimension).toBe(dimension);
      // A single 'budget-cap' would tell the user nothing actionable.
      expect(breach?.reason).toBe(reason);
      expect(STOP_REASON_FOR[dimension]).toBe(reason);
    });
  }

  it('says what was spent, what the limit was, and what to do', () => {
    const breach = checkBudget(budget, spend({ costMicros: 150 }));
    expect(breach?.explanation).toContain('150');
    expect(breach?.explanation).toContain('100');
    expect(breach?.explanation).toMatch(/settings/);
  });

  it('allows a run that is under every limit', () => {
    expect(checkBudget(budget, spend({ steps: 9, tokens: 999 }))).toBeNull();
  });

  it('treats null as no limit on that axis', () => {
    const unlimited: Budget = { ...budget, steps: null };
    expect(checkBudget(unlimited, spend({ steps: 10_000 }))).toBeNull();
  });

  it('is checked in a fixed order, so the verdict is deterministic', () => {
    const everything = spend({ steps: 99, tokens: 99_999, toolCalls: 99 });
    expect(checkBudget(budget, everything)?.dimension).toBe('steps');
    expect(checkBudget(budget, everything)?.dimension).toBe('steps');
  });
});

describe('wouldBreach answers the question BEFORE the money is spent', () => {
  const budget: Budget = { ...DEFAULT_RUN_BUDGET, costMicros: 1000 };

  it('refuses a spend that would cross the line', () => {
    const breach = wouldBreach(budget, spend({ costMicros: 900 }), { costMicros: 200 });
    expect(breach?.dimension).toBe('costMicros');
    expect(breach?.spent).toBe(1100);
  });

  it('permits one that lands exactly on it', () => {
    // At the limit is spent-out, not over: the next check stops the run.
    expect(wouldBreach(budget, spend({ costMicros: 900 }), { costMicros: 100 })).toBeNull();
    expect(checkBudget(budget, spend({ costMicros: 1000 }))).not.toBeNull();
  });

  it('differs from checkBudget, which is the point of having both', () => {
    const current = spend({ costMicros: 999 });
    expect(checkBudget(budget, current)).toBeNull(); // not yet overspent
    expect(wouldBreach(budget, current, { costMicros: 500 })).not.toBeNull(); // but would be
  });
});

describe('the daily ledger', () => {
  let substrate: Substrate;
  let clock: FakeClock;

  beforeEach(() => {
    clock = new FakeClock('2026-04-01T09:00:00Z');
    substrate = createTestSubstrate({ clock });
  });

  const burn = (opts: { tokensIn?: number; tokensOut?: number; cents?: number; bytes?: number } = {}) => {
    const runId = `run-${Math.random().toString(36).slice(2)}`;
    substrate.events.append({
      type: 'step.started',
      payload: { index: 0, effectiveTrust: 'USER' },
      principal: 'user:ara', trust: 'SYSTEM', runId, stepId: 's1',
    });
    substrate.events.append({
      type: 'model.requested',
      payload: { provider: 'fake', model: 'm', contextDigest: 'd', inputTokens: opts.tokensIn ?? 0 },
      principal: 'user:ara', trust: 'SYSTEM', runId, stepId: 's1',
    });
    substrate.events.append({
      type: 'model.responded',
      payload: {
        provider: 'fake', model: 'm', outputTokens: opts.tokensOut ?? 0,
        finishReason: 'stop', latencyMs: 1, costCents: opts.cents ?? 0,
      },
      principal: 'user:ara', trust: 'SYSTEM', runId, stepId: 's1',
    });
    if (opts.bytes !== undefined) {
      substrate.events.append({
        type: 'egress.allowed',
        payload: { tool: 't', host: 'api.example.com', method: 'GET', bytes: opts.bytes },
        principal: 'user:ara', trust: 'USER', runId, stepId: 's1',
      });
    }
  };

  it('sums across runs within the day', () => {
    burn({ tokensIn: 100, tokensOut: 50, cents: 1 });
    burn({ tokensIn: 200, tokensOut: 25, cents: 2 });
    const ledger = new DailyLedger(substrate.events, clock);
    const today = ledger.spentToday();

    // Two runs, one day. Per-run budgets would have allowed both.
    expect(today.tokens).toBe(375);
    expect(today.costMicros).toBe(30_000); // 3 cents
    expect(today.steps).toBe(2);
  });

  it('counts egress bytes, which only exist in the log because we log them', () => {
    burn({ bytes: 4096 });
    expect(new DailyLedger(substrate.events, clock).spentToday().egressBytes).toBe(4096);
  });

  it('counts tool calls', () => {
    substrate.events.append({
      type: 'tool.started',
      payload: { tool: 'x', idempotencyKey: 'k1' },
      principal: 'user:ara', trust: 'SYSTEM', runId: 'r', stepId: 's',
    });
    expect(new DailyLedger(substrate.events, clock).spentToday().toolCalls).toBe(1);
  });

  it('resets at the day boundary', () => {
    burn({ tokensIn: 1000 });
    const ledger = new DailyLedger(substrate.events, clock);
    expect(ledger.spentToday().tokens).toBe(1000);

    clock.advance(24 * 60 * 60 * 1000); // tomorrow
    expect(ledger.spentToday().tokens).toBe(0);
    // No Date.now() anywhere — the boundary moved because the injected
    // clock moved, which is the only reason anything should move.
  });

  it('uses UTC midnight, deliberately and visibly', () => {
    expect(dayStart(Date.UTC(2026, 3, 1, 23, 59))).toBe(Date.UTC(2026, 3, 1));
    expect(dayStart(Date.UTC(2026, 3, 2, 0, 1))).toBe(Date.UTC(2026, 3, 2));
  });

  it('refuses a new run at the door when the day is spent', () => {
    burn({ tokensIn: 500, cents: 10 });
    const ledger = new DailyLedger(substrate.events, clock);
    const tight: Budget = { ...DEFAULT_DAILY_BUDGET, tokens: 400 };

    const breach = ledger.admits(tight);
    expect(breach?.scope).toBe('day');
    expect(breach?.dimension).toBe('tokens');
    // Refusing before the run starts costs nothing; refusing halfway has
    // already spent the money.
    expect(breach?.explanation).toContain('resets at midnight');
  });

  it('admits a run when the day has room', () => {
    burn({ tokensIn: 10 });
    expect(new DailyLedger(substrate.events, clock).admits(DEFAULT_DAILY_BUDGET)).toBeNull();
  });

  it('never fires on wall-clock, which is 24h by construction', () => {
    const ledger = new DailyLedger(substrate.events, clock);
    clock.advance(23 * 60 * 60 * 1000);
    expect(ledger.spentToday().wallMs).toBeGreaterThan(0);
    expect(ledger.admits({ ...DEFAULT_DAILY_BUDGET, wallMs: 1 })).toBeNull();
  });

  it('is derived from the log: a rebuild gives the same numbers', () => {
    burn({ tokensIn: 100, tokensOut: 50, cents: 5, bytes: 1024 });
    const before = new DailyLedger(substrate.events, clock).spentToday();

    substrate.events.rebuild();
    const after = new DailyLedger(substrate.events, clock).spentToday();

    // A counter column would have drifted here; a query cannot.
    expect(after).toEqual(before);
  });
});

describe('the defaults', () => {
  it('bound every dimension for a run', () => {
    for (const [dimension, limit] of Object.entries(DEFAULT_RUN_BUDGET)) {
      expect(limit, `${dimension} is unbounded per run`).not.toBeNull();
    }
  });

  it('live in one place, not at call sites', () => {
    // If this ever needs changing per principal, it changes here.
    expect(DEFAULT_RUN_BUDGET.costMicros).toBe(1_000_000);
    expect(DEFAULT_DAILY_BUDGET.costMicros).toBe(20_000_000);
    expect(DEFAULT_DAILY_BUDGET.costMicros! / DEFAULT_RUN_BUDGET.costMicros!).toBe(20);
  });
});
