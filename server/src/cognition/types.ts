import type { z } from 'zod';
import type { TrustLevel } from '../substrate/events/types.js';

/**
 * Cognitive Jobs (§33).
 *
 * The central idea of this build: **there is no model, and the shape of the
 * code does not care.** Every function that would ordinarily be "call the
 * LLM" is a named job with two strategies behind it — a deterministic
 * baseline that ships and works, and a model strategy that is completely
 * written and completely inert.
 *
 * The reason to build the seam before the model rather than after is that
 * "attaching a model is config-only" (§59.17) is a claim about code that
 * does not exist yet. If the first model is attached at a call site, the
 * second one is attached at a call site too, and by the fifth there is no
 * seam left — just scattered conditionals that each decide, slightly
 * differently, whether to use it.
 */

/**
 * The fifteen (§16.1). This list is closed; a sixteenth needs a decision
 * record. It grew from eleven when the specification was replaced — the
 * three attention jobs at the end are that growth.
 */
export const JOB_NAMES = [
  'turn.generate',
  'memory.extract',
  'entity.resolve',
  'text.summarize',
  'history.compact',
  'memory.consolidate',
  'rule.induce',
  'brief.compose',
  'draft.compose',
  'content.classify',
  'quarantine.extract',
  'page.extract',
  'intent.parse',
  'priority.score',
  'thread.summarize',
] as const;

export type JobName = (typeof JOB_NAMES)[number];

export function isJobName(value: string): value is JobName {
  return (JOB_NAMES as readonly string[]).includes(value);
}

/** Which strategy actually served a job. Reported, never guessed. */
export type StrategyKind = 'baseline' | 'model';

/**
 * What a job is given beyond its input.
 *
 * Deliberately tiny. A job that needs the database is not a cognitive job,
 * it is a query with a model bolted on, and it belongs in a projector.
 */
export interface JobContext {
  /** Trust of the *input*. Caps the trust of the output (§20). */
  inputTrust: TrustLevel;
  now: number;
  /** Correlates the job with the run that asked for it. */
  runId?: string | undefined;
}

/**
 * A request to a model, built but not sent.
 *
 * This type exists so that `buildRequest` is a pure function returning a
 * value a test can inspect. The alternative — building the request inside
 * the provider call — makes the prompt untestable until a provider exists,
 * which is precisely the retrofit this design avoids.
 */
export interface ModelRequest {
  /** The job this request serves, for budgeting and auditing. */
  job: JobName;
  /** System framing. Never contains FOREIGN content (§21). */
  system: string;
  /** The user-role content. May contain quarantined references, not bytes. */
  user: string;
  /** Hard ceiling, applied before the request leaves. */
  maxOutputTokens: number;
  temperature: number;
  /**
   * Schema the completion must satisfy. The same schema the baseline is
   * held to, which is what makes the two strategies substitutable.
   */
  responseSchemaName: string;
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * A job's model strategy: written, tested, and unable to run.
 *
 * `buildRequest` and `parseResponse` are pure and have full test coverage.
 * The only missing piece is a provider to carry the bytes between them —
 * which is the one thing configuration will supply.
 */
export interface ModelStrategy<I, O> {
  buildRequest(input: I, ctx: JobContext): ModelRequest;
  parseResponse(raw: string, input: I): ParseResult<O>;
}

/** A deterministic implementation that ships now and always works. */
export type Baseline<I, O> = (input: I, ctx: JobContext) => O;

export interface CognitiveJob<I, O> {
  name: JobName;
  /** One line, shown in the UI and in `arish doctor`. */
  summary: string;
  /**
   * `unknown` as the schema's *input* type, not `I`.
   *
   * A field with `.default()` is optional going in and present coming out,
   * so zod's input and output types genuinely differ. Jobs always parse
   * from untrusted `unknown` anyway — that is the whole point of validating
   * at the boundary — so the input side is `unknown` and `I` is what the
   * baseline receives after parsing.
   */
  input: z.ZodType<I, z.ZodTypeDef, unknown>;
  output: z.ZodType<O, z.ZodTypeDef, unknown>;
  /**
   * Ceiling on the trust of this job's output (§20).
   *
   * Every job is capped at DERIVED at best: a cognitive job's output is
   * inference, never testimony, and inference may not be laundered into
   * USER trust by passing through a confident-sounding function.
   */
  outputTrust: Extract<TrustLevel, 'DERIVED' | 'FOREIGN'>;
  /** What the baseline can and cannot do, shown to the user verbatim. */
  baselineQuality: string;
  baseline: Baseline<I, O>;
  model: ModelStrategy<I, O>;
}

/**
 * Erased form, so one registry can hold all fifteen.
 *
 * `never` in the parameter positions rather than `any`: a function taking a
 * specific input is assignable to one taking `never`, so every concrete job
 * fits, and the `no-explicit-any` ban stays meaningful instead of being
 * switched off the first time it is inconvenient.
 */
export interface AnyJob {
  name: JobName;
  summary: string;
  input: z.ZodTypeAny;
  output: z.ZodTypeAny;
  outputTrust: Extract<TrustLevel, 'DERIVED' | 'FOREIGN'>;
  baselineQuality: string;
  baseline: (input: never, ctx: JobContext) => unknown;
  model: {
    buildRequest(input: never, ctx: JobContext): ModelRequest;
    parseResponse(raw: string, input: never): ParseResult<unknown>;
  };
}

export class JobError extends Error {
  constructor(
    readonly kind: 'invalid_input' | 'invalid_output' | 'model_not_attached' | 'unknown_job',
    message: string,
  ) {
    super(message);
    this.name = 'JobError';
  }
}
