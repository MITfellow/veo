/**
 * The model port's wire types (§8, L1).
 *
 * A model provider is an **external, untrusted surface**: it is a network
 * service whose output shape can change without warning and whose content may
 * contain anything. So every chunk is validated with zod at the boundary
 * (§6: one schema library at every boundary), and the validation error names
 * the provider, because "unexpected token" with no attribution at 3am is how
 * you lose an evening.
 *
 * Streaming is the only mode. There is deliberately no `complete()` that
 * returns a whole response: a non-streaming provider is a one-chunk stream,
 * while the reverse costs first-token latency permanently, and §32 budgets
 * first token at under 1.5 seconds.
 */
import { z } from 'zod';
import type { TrustLevel } from '../events/types.js';

/* ───────────────────────────────── requests ──────────────────────────────── */

export const MODEL_ROLES = ['system', 'user', 'assistant', 'tool'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/**
 * A message as the provider sees it.
 *
 * `trust` is carried alongside even though no provider accepts it: the
 * assembler needs it to decide what to fence, and the firewall and trace need
 * it to explain why a step was limited. It is stripped in the adapter.
 */
export interface ModelMessage {
  role: ModelRole;
  content: string;
  /** Trust of this message's *content*, used for fencing. Defaults USER. */
  trust?: TrustLevel;
  /** Set for role:'tool' — which call this is the result of. */
  toolCallId?: string;
  name?: string;
}

export interface ModelToolSpec {
  name: string;
  description: string;
  /** JSON Schema. Produced from zod at M3; opaque here. */
  parameters: unknown;
  /**
   * How much damage a wrong call does, and whether it leaves the box.
   *
   * Optional because a request can be built without them, but they
   * should be supplied: a chooser that cannot tell "look at the
   * calendar" from "delete the appointment" is choosing blind, and the
   * policy engine only sees the call *after* the decision was made.
   */
  risk?: 'safe' | 'caution' | 'dangerous';
  effect?: 'pure' | 'local' | 'external';
}

/**
 * What the constitution's checks need to know about the run this request
 * belongs to (§25, M7).
 *
 * It lives on the request, down here at L1, for one reason: the governance
 * gate wraps the *provider*, so it sees requests and nothing else. Hanging
 * this off a mutable per-run registry instead would break the moment two
 * runs streamed at once, and passing it out-of-band would give the gate a
 * second way to be bypassed. Adapters ignore it — they map named fields onto
 * their wire format — so no provider ever sees it.
 *
 * It is plain data, not a handle: a check may read what happened, never act.
 */
export interface GovernanceHints {
  runId: string;
  stepId: string;
  userMessage: string;
  previousAgentTurn: string;
  toolsCompleted: readonly string[];
  effectsCommitted: readonly string[];
  recalled: readonly { id: string; label: string; confidence: number }[];
  contradicting: readonly { id: string; label: string }[];
  factCount: number;
  hasIdentityCard: boolean;
  constraints: readonly { id: string; text: string }[];
  foreign: readonly string[];
  trust: TrustLevel;
  modelConfigured: boolean;
  /**
   * Which revision attempt this is (decision 042). 0 or absent is the
   * first draft; 1 means the gate already withheld one draft and this
   * is the rewrite. The gate reads it to decide between withholding
   * again and disclosing — it will never withhold twice.
   */
  revisionAttempt?: number;
}

export interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  /** Governance context for the constitution gate (§25). Never sent to a provider. */
  governance?: GovernanceHints;
  /** Absent in M2 — tools are registered at M3. */
  tools?: ModelToolSpec[];
  maxOutputTokens?: number;
  /**
   * Omitted entirely rather than defaulted to 0.7: a default buried in an
   * adapter is a behaviour change nobody can find. Callers choose.
   */
  temperature?: number;
  stop?: string[];
}

/* ───────────────────────────────── chunks ────────────────────────────────── */

export const FINISH_REASONS = [
  'stop',
  'length',
  'tool-calls',
  'content-filter',
  /**
   * The constitution asked for a revision (decision 042).
   *
   * The draft was buffered, judged, found to violate an article whose
   * remedy is `revise`, and **not sent**. The caller is expected to
   * regenerate once with the instruction the gate recorded. A caller
   * that does not handle it sees an explicit reason rather than a
   * silently empty stream.
   */
  'revision-required',
] as const;
export type FinishReason = (typeof FINISH_REASONS)[number];

export const MODEL_ERROR_KINDS = [
  'auth',
  'rate-limit',
  'timeout',
  'overloaded',
  'bad-request',
  /**
   * The request did not fit the model's window. Distinct from 'bad-request'
   * because the response is different in kind: compact and retry once (§23),
   * never retry blind.
   */
  'context-overflow',
  'server',
  'network',
  'unknown',
] as const;
export type ModelErrorKind = (typeof MODEL_ERROR_KINDS)[number];

export const TextDeltaChunk = z.object({
  type: z.literal('text-delta'),
  text: z.string(),
});

export const ToolCallChunk = z.object({
  type: z.literal('tool-call'),
  id: z.string().min(1),
  name: z.string().min(1),
  /** Unvalidated here on purpose: the *tool's* schema validates it at M3. */
  input: z.unknown(),
});

export const UsageChunk = z.object({
  type: z.literal('usage'),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** Micros, integer. Floating-point money is a bug waiting to be filed. */
  costMicros: z.number().int().nonnegative().default(0),
});

export const FinishChunk = z.object({
  type: z.literal('finish'),
  reason: z.enum(FINISH_REASONS),
});

/**
 * Failure arrives as a chunk, not an exception (invariant 13: failure is
 * data). A stream that emitted 400 good tokens and then died must be able to
 * say so without throwing those tokens away.
 */
export const ErrorChunk = z.object({
  type: z.literal('error'),
  kind: z.enum(MODEL_ERROR_KINDS),
  message: z.string(),
  retryable: z.boolean(),
});

export const ModelChunkSchema = z.discriminatedUnion('type', [
  TextDeltaChunk,
  ToolCallChunk,
  UsageChunk,
  FinishChunk,
  ErrorChunk,
]);

export type ModelChunk = z.infer<typeof ModelChunkSchema>;
export type TextDelta = z.infer<typeof TextDeltaChunk>;
export type ToolCall = z.infer<typeof ToolCallChunk>;
export type Usage = z.infer<typeof UsageChunk>;

/** Thrown when a provider emits something that is not a `ModelChunk`. */
export class ModelProtocolError extends Error {
  override readonly name = 'ModelProtocolError';
  constructor(
    readonly provider: string,
    readonly issue: string,
  ) {
    super(`model provider '${provider}' emitted a chunk this harness cannot parse: ${issue}`);
  }
}

/** Validate one chunk at the port boundary. */
export function parseChunk(provider: string, raw: unknown): ModelChunk {
  const result = ModelChunkSchema.safeParse(raw);
  if (!result.success) {
    throw new ModelProtocolError(provider, result.error.issues[0]?.message ?? 'invalid shape');
  }
  return result.data;
}

/* ─────────────────────────── accumulating a stream ───────────────────────── */

export interface StreamTotals {
  text: string;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  finishReason: FinishReason | null;
  error: z.infer<typeof ErrorChunk> | null;
}

export function emptyTotals(): StreamTotals {
  return {
    text: '',
    toolCalls: [],
    inputTokens: 0,
    outputTokens: 0,
    costMicros: 0,
    finishReason: null,
    error: null,
  };
}

/**
 * Fold a chunk into the running totals.
 *
 * Usage **accumulates** rather than overwrites: providers differ on whether
 * they report usage once at the end or incrementally, and a provider that
 * reports twice must not silently halve the bill.
 */
export function accumulate(totals: StreamTotals, chunk: ModelChunk): StreamTotals {
  switch (chunk.type) {
    case 'text-delta':
      totals.text += chunk.text;
      return totals;
    case 'tool-call':
      totals.toolCalls.push(chunk);
      return totals;
    case 'usage':
      totals.inputTokens += chunk.inputTokens;
      totals.outputTokens += chunk.outputTokens;
      totals.costMicros += chunk.costMicros;
      return totals;
    case 'finish':
      totals.finishReason = chunk.reason;
      return totals;
    case 'error':
      totals.error = chunk;
      return totals;
  }
}
