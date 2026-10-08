import { z } from 'zod';

/**
 * The outbox (§13). `key` is the idempotency key, and it is the join
 * between an intention and its commitment across a crash.
 */
export const EffectIntended = z.object({
  key: z.string().min(1),
  tool: z.string().min(1),
  version: z.string().min(1),
  stepId: z.string().min(1),
  /** Hash of the canonical input, never the input: arguments carry secrets. */
  inputDigest: z.string().min(1),
  reversible: z.boolean(),
  idempotent: z.boolean(),
  summary: z.string().default(''),
}).strict();

export const EffectCommitted = z.object({
  key: z.string().min(1),
  tool: z.string().min(1),
  /** The remote's own id, when it gave one. The only proof it really happened. */
  remoteRef: z.string().nullable().default(null),
  summary: z.string().default(''),
  /** True when this was discovered by reconciliation, not observed directly. */
  reconciled: z.boolean().default(false),
}).strict();

export const EffectCompensated = z.object({
  key: z.string().min(1),
  tool: z.string().min(1),
  detail: z.string().default(''),
}).strict();

export const EffectReconciled = z.object({
  key: z.string().min(1),
  tool: z.string().min(1),
  outcome: z.enum(['committed', 'absent', 'needs_attention']),
  detail: z.string().default(''),
}).strict();

