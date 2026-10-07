/**
 * Budgets (§27).
 *
 * A budget is not an optimisation. It is the thing that stops a loop
 * between two tools from running until someone notices, and the thing that
 * makes "the agent is stuck" a reported state rather than a silence.
 *
 * Every limit is checked against the injected clock and an explicit
 * counter — never `Date.now`, never a timer — so a test can advance six
 * hours instantly and get exactly the behaviour a real six hours produces.
 */

export type BudgetKind = 'steps' | 'wallClock' | 'toolCalls' | 'approvals';

export interface BudgetLimits {
  steps: number;
  /** Milliseconds of wall clock, measured on the injected clock. */
  wallClock: number;
  toolCalls: number;
  /** How many times one run may stop and ask. Asking forever is a loop too. */
  approvals: number;
}

export const DEFAULT_BUDGET: BudgetLimits = {
  steps: 20,
  wallClock: 120_000,
  toolCalls: 40,
  approvals: 5,
};

export interface BudgetBreach {
  budget: BudgetKind;
  limit: number;
  reached: number;
  message: string;
}

/**
 * A spent-counter that cannot be raised from inside the run.
 *
 * The limits are captured at construction and the class exposes no setter.
 * A run that could widen its own budget has no budget — and the one thing
 * an agent reliably tries when it hits a wall is to look for a door.
 */
export class Budget {
  private readonly limits: BudgetLimits;
  private readonly startedAt: number;
  private spent: Record<BudgetKind, number> = { steps: 0, wallClock: 0, toolCalls: 0, approvals: 0 };

  constructor(limits: Partial<BudgetLimits>, startedAt: number) {
    this.limits = { ...DEFAULT_BUDGET, ...limits };
    this.startedAt = startedAt;
  }

  /** Count one unit. Returns the breach if this took it over. */
  spend(kind: Exclude<BudgetKind, 'wallClock'>, now: number): BudgetBreach | null {
    this.spent[kind] += 1;
    return this.check(now);
  }

  /** Has anything run out? Checked before each step as well as after. */
  check(now: number): BudgetBreach | null {
    const elapsed = Math.max(0, now - this.startedAt);
    this.spent.wallClock = elapsed;

    for (const kind of ['steps', 'toolCalls', 'approvals', 'wallClock'] as const) {
      const limit = this.limits[kind];
      const reached = this.spent[kind];
      if (reached > limit) {
        return { budget: kind, limit, reached, message: describe(kind, limit, reached) };
      }
    }
    return null;
  }

  remaining(kind: BudgetKind, now: number): number {
    if (kind === 'wallClock') return Math.max(0, this.limits.wallClock - (now - this.startedAt));
    return Math.max(0, this.limits[kind] - this.spent[kind]);
  }

  snapshot(): Readonly<Record<BudgetKind, number>> {
    return { ...this.spent };
  }
}

function describe(kind: BudgetKind, limit: number, reached: number): string {
  if (kind === 'wallClock') {
    return `This run has been going for ${Math.round(reached / 1000)}s against a ${Math.round(limit / 1000)}s budget. Stopping.`;
  }
  return `This run reached ${reached} ${kind} against a budget of ${limit}. Stopping rather than continuing quietly.`;
}
