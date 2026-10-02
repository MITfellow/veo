/**
 * Per-model, per-block context budgets (§21, L4).
 *
 * > "Budgets are declared per block as a share of the model window, in
 * > config, per model. No magic numbers in code."
 *
 * So this file is *declaration*, not logic: a zod-validated table of shares
 * per model, and one function that turns a table into token counts. Nothing
 * downstream is allowed to invent a number.
 *
 * Shares are a **claim, not a reservation.** A block that uses less than its
 * share releases the remainder to the blocks below it in survival order.
 * Without that, a cold start with no memories would hold a third of the
 * window empty while evicting conversation turns — the budget would be
 * protecting absent data from present data.
 */
import { z } from 'zod';
import {
  ContextTooSmallError,
  SURVIVAL_ORDER,
  UNEVICTABLE,
  type BlockName,
} from './types.js';

const shareEntries = SURVIVAL_ORDER.map((name) => [name, z.number().min(0).max(1)] as const);

export const ContextPolicySchema = z
  .object({
    /** Bumped whenever a share changes. Logged with every assembly. */
    version: z.string().min(1),
    model: z.string().min(1),
    /** The model's context window, in tokens. */
    window: z.number().int().positive(),
    /** Held back for the model's own output. Never handed to a block. */
    reserveForOutput: z.number().int().nonnegative(),
    shares: z.object(Object.fromEntries(shareEntries) as ShareShape),
    /** Floors, applied after shares. A block below its floor takes from the pool. */
    minTokens: z.record(z.string(), z.number().int().nonnegative()).default({}),
    /** Wrap FOREIGN content in the fence. Production is always true (§33). */
    fence: z.boolean().default(true),
    /** Whether `secret`-sensitivity memories may be rendered at all (§22.6). */
    allowSecrets: z.boolean().default(false),
  })
  .superRefine((policy, ctx) => {
    const total = Object.values(policy.shares).reduce((sum, share) => sum + share, 0);
    // Over-subscription is the bug this catches: shares summing to 1.4 means
    // every block "fits" until they are all full at once, and then the thing
    // that overflows is whatever happened to be last that day.
    if (total > 1.0001) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['shares'],
        message: `block shares sum to ${total.toFixed(3)}, which is more than the window`,
      });
    }
    if (policy.reserveForOutput >= policy.window) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reserveForOutput'],
        message: 'nothing is left for input once output is reserved',
      });
    }
    for (const name of Object.keys(policy.minTokens)) {
      if (!(SURVIVAL_ORDER as readonly string[]).includes(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['minTokens', name],
          message: `'${name}' is not a context block`,
        });
      }
    }
  });

type ShareShape = Record<BlockName, z.ZodNumber>;
export type ContextPolicy = z.infer<typeof ContextPolicySchema>;
export type ContextPolicyInput = z.input<typeof ContextPolicySchema>;

/* ──────────────────────────── declared budgets ──────────────────────────── */

/**
 * The default split, as fractions of the usable window.
 *
 * The reasoning, since the numbers are otherwise unfalsifiable:
 * conversation gets the largest share because recency is what coherence is
 * made of; memories get the second largest because that is the thing this
 * system exists for; tools get a fixed slice because schemas are large and
 * uninteresting; the four unevictable blocks get small shares because they
 * are *floors* — they take what they need and the floor stops them being
 * squeezed, not the share.
 */
const DEFAULT_SHARES: Record<BlockName, number> = {
  kernel: 0.05,
  constitution: 0.05,
  identity: 0.04,
  constraints: 0.03,
  situation: 0.02,
  commitments: 0.04,
  calibration: 0.03,
  pinned: 0.05,
  memories: 0.16,
  working: 0.06,
  conversation: 0.26,
  compacted: 0.08,
  tools: 0.09,
  foreign: 0.04,
};

/**
 * Known models. A model not in this table is not refused — it falls back to
 * the default shares against whatever window the caller declares — but the
 * fallback is logged, because a silent default window is how a 200k model
 * gets used like an 8k one for six months without anyone noticing.
 */
export const MODEL_WINDOWS: Readonly<Record<string, number>> = {
  'fake-model': 8_000,
  'claude-3-5-sonnet': 200_000,
  'gpt-4o': 128_000,
  'local-small': 8_192,
};

export const DEFAULT_RESERVE_RATIO = 0.25;

export function policyFor(
  model: string,
  overrides: Partial<ContextPolicyInput> = {},
): ContextPolicy {
  const window = overrides.window ?? MODEL_WINDOWS[model] ?? 8_000;
  return ContextPolicySchema.parse({
    version: 'ctx-1',
    model,
    window,
    reserveForOutput: Math.floor(window * DEFAULT_RESERVE_RATIO),
    shares: DEFAULT_SHARES,
    ...overrides,
  });
}

/* ───────────────────────────── the allocation ───────────────────────────── */

export interface BlockBudget {
  /** The block's own claim on the window. */
  share: number;
  /** Tokens it may use before the pool is consulted. */
  tokens: number;
}

export interface ResolvedBudgets {
  /** Usable input budget: window minus the output reserve. */
  total: number;
  byBlock: Readonly<Record<BlockName, BlockBudget>>;
}

export function resolveBudgets(policy: ContextPolicy): ResolvedBudgets {
  const total = policy.window - policy.reserveForOutput;
  const byBlock = {} as Record<BlockName, BlockBudget>;

  for (const name of SURVIVAL_ORDER) {
    const share = policy.shares[name];
    const floor = policy.minTokens[name] ?? 0;
    byBlock[name] = { share, tokens: Math.max(floor, Math.floor(total * share)) };
  }

  return { total, byBlock: byBlock };
}

/**
 * Check, before assembling anything, that the blocks which may never be
 * dropped can actually fit. Called by the assembler once it knows their real
 * cost — shares cannot answer this, because a constitution the user wrote is
 * whatever length the user wrote it.
 */
export function assertUnevictableFits(costs: Record<BlockName, number>, total: number): void {
  let needed = 0;
  for (const name of SURVIVAL_ORDER) if (UNEVICTABLE.has(name)) needed += costs[name] ?? 0;
  if (needed > total) throw new ContextTooSmallError(needed, total);
}
