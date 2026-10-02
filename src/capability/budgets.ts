/**
 * Budgets, per run and per day (§19, §32).
 *
 *   > An agent that can loop forever burning money is the classic harness
 *   > failure; make it structurally impossible.
 *
 * Six dimensions, because they fail differently and a cap on one does not
 * bound the others: an agent can burn money without taking many steps, or
 * take thousands of cheap steps, or sit in one step for an hour, or quietly
 * upload a gigabyte.
 *
 * Two scopes. Per-run bounds a single mistake. Per-day bounds a *pattern* of
 * mistakes — the run that costs $2 and is retried four hundred times by a
 * scheduler is within its per-run budget every single time.
 *
 * ## Why the daily ledger is a query, not a counter
 *
 * A counter column is a second source of truth. It drifts the first time the
 * process dies between the spend and the increment, and once it has drifted
 * there is no way to tell. Summing the event log is slower and cannot drift,
 * because the log is the only thing that was ever authoritative (invariant 1).
 *
 * It is read once at run start and on each spend, not per token. If that
 * becomes too slow the answer is a cache *derived from* the log and rebuilt
 * with it — not a counter maintained alongside it.
 */
import type { EventLog } from '../substrate/events/log.js';
import type { Clock } from '../substrate/ports.js';

/** The six dimensions. `null` means "no limit on this axis". */
export interface Budget {
  readonly steps: number | null;
  readonly tokens: number | null;
  readonly wallMs: number | null;
  readonly costMicros: number | null;
  readonly egressBytes: number | null;
  readonly toolCalls: number | null;
}

export interface Spend {
  steps: number;
  tokens: number;
  wallMs: number;
  costMicros: number;
  egressBytes: number;
  toolCalls: number;
}

export type BudgetDimension = keyof Budget;

/**
 * Stop reasons, one per dimension.
 *
 * Distinct rather than a single 'budget-cap' because "it stopped" is not an
 * explanation (invariant 15). "You have spent your daily token budget" and
 * "this run made too many tool calls" lead the user to different actions.
 */
export const STOP_REASON_FOR: Record<BudgetDimension, string> = {
  steps: 'step-cap',
  tokens: 'token-cap',
  wallMs: 'time-cap',
  costMicros: 'cost-cap',
  egressBytes: 'egress-cap',
  toolCalls: 'tool-cap',
};

const DIMENSIONS: readonly BudgetDimension[] = [
  'steps',
  'tokens',
  'wallMs',
  'costMicros',
  'egressBytes',
  'toolCalls',
];

/**
 * Defaults, in one place.
 *
 * Deliberately not spread across call sites: a limit written inline at the
 * point of use is a limit nobody can find when it fires at 2am, and it is
 * also a limit that cannot be configured per principal later.
 */
export const DEFAULT_RUN_BUDGET: Budget = {
  steps: 12,
  tokens: 100_000,
  wallMs: 300_000,
  costMicros: 1_000_000,
  egressBytes: 10 * 1024 * 1024,
  toolCalls: 40,
};

export const DEFAULT_DAILY_BUDGET: Budget = {
  steps: null,
  tokens: 2_000_000,
  wallMs: null,
  costMicros: 20_000_000, // $20
  egressBytes: 500 * 1024 * 1024,
  toolCalls: 1_000,
};

export const ZERO_SPEND = (): Spend => ({
  steps: 0,
  tokens: 0,
  wallMs: 0,
  costMicros: 0,
  egressBytes: 0,
  toolCalls: 0,
});

export interface BudgetBreach {
  readonly dimension: BudgetDimension;
  readonly scope: 'run' | 'day';
  readonly limit: number;
  readonly spent: number;
  readonly reason: string;
  /** Shown to the user and the model unchanged. */
  readonly explanation: string;
}

function breach(
  dimension: BudgetDimension,
  scope: 'run' | 'day',
  limit: number,
  spent: number,
): BudgetBreach {
  const unit: Record<BudgetDimension, string> = {
    steps: 'steps',
    tokens: 'tokens',
    wallMs: 'ms of wall-clock time',
    costMicros: 'micro-dollars',
    egressBytes: 'bytes of outbound data',
    toolCalls: 'tool calls',
  };
  return {
    dimension,
    scope,
    limit,
    spent,
    reason: STOP_REASON_FOR[dimension],
    explanation:
      `Stopped: this ${scope === 'run' ? 'run' : 'day'} has used ${spent} ${unit[dimension]}, ` +
      `and the ${scope} budget is ${limit}. ` +
      (scope === 'day'
        ? 'The daily budget resets at midnight; it can be raised in settings.'
        : 'Ask again to start a fresh run, or raise the per-run budget in settings.'),
  };
}

/** First dimension exceeded, or null. Checked in a fixed order, so pure. */
export function checkBudget(
  budget: Budget,
  spend: Spend,
  scope: 'run' | 'day' = 'run',
): BudgetBreach | null {
  for (const dimension of DIMENSIONS) {
    const limit = budget[dimension];
    if (limit !== null && spend[dimension] >= limit) {
      return breach(dimension, scope, limit, spend[dimension]);
    }
  }
  return null;
}

/**
 * Would this additional spend breach the budget?
 *
 * Separate from `checkBudget` because the two questions differ at the
 * boundary: "have I already overspent" is asked after the fact, "will this
 * push me over" is asked before committing to something expensive, and only
 * the second can prevent the overspend.
 */
export function wouldBreach(
  budget: Budget,
  spend: Spend,
  additional: Partial<Spend>,
  scope: 'run' | 'day' = 'run',
): BudgetBreach | null {
  const projected: Spend = { ...spend };
  for (const dimension of DIMENSIONS) {
    projected[dimension] += additional[dimension] ?? 0;
  }
  for (const dimension of DIMENSIONS) {
    const limit = budget[dimension];
    if (limit !== null && projected[dimension] > limit) {
      return breach(dimension, scope, limit, projected[dimension]);
    }
  }
  return null;
}

/* ──────────────────────────── the daily ledger ─────────────────────────── */

/** Midnight UTC before `ts`. UTC because a local day boundary needs a zone,
 *  and a zone is a user setting that does not exist until the memory
 *  milestone. Recorded so it can be changed deliberately rather than found. */
export function dayStart(ts: number): number {
  return Math.floor(ts / 86_400_000) * 86_400_000;
}

/**
 * Everything spent today, summed from the event log.
 *
 * Reads `run.finished` (totals) plus the live tallies that precede it, so a
 * run in flight counts toward the day as it goes rather than all at once at
 * the end — otherwise a single very expensive run never registers until it
 * is too late.
 */
export class DailyLedger {
  constructor(
    private readonly events: EventLog,
    private readonly clock: Clock,
  ) {}

  spentToday(now = this.clock.now()): Spend {
    const since = dayStart(now);
    const total = ZERO_SPEND();

    for (const event of this.events.read({})) {
      if (event.ts < since) continue;
      const payload = event.payload as Record<string, unknown>;

      switch (event.type) {
        case 'step.started':
          total.steps += 1;
          break;
        case 'tool.started':
          total.toolCalls += 1;
          break;
        case 'model.requested': {
          // Input tokens live on the request, output on the response — they
          // are counted where they are actually known.
          const input = typeof payload['inputTokens'] === 'number' ? payload['inputTokens'] : 0;
          total.tokens += input;
          break;
        }
        case 'model.responded': {
          const output = typeof payload['outputTokens'] === 'number' ? payload['outputTokens'] : 0;
          const cents = typeof payload['costCents'] === 'number' ? payload['costCents'] : 0;
          total.tokens += output;
          total.costMicros += Math.round(cents * 10_000);
          break;
        }
        case 'egress.allowed': {
          const bytes = typeof payload['bytes'] === 'number' ? payload['bytes'] : 0;
          total.egressBytes += bytes;
          break;
        }
        default:
          break;
      }
    }

    total.wallMs = now - since;
    return total;
  }

  /**
   * May a new run start at all?
   *
   * Asked before the run begins, because refusing at the door costs nothing
   * and refusing halfway through has already spent the money.
   */
  admits(budget: Budget, now = this.clock.now()): BudgetBreach | null {
    const spend = this.spentToday(now);
    // Wall-clock is meaningless as a daily total (a day is 24h by
    // construction), so it is excluded rather than always firing.
    const daily: Budget = { ...budget, wallMs: null };
    return checkBudget(daily, spend, 'day');
  }
}
