/**
 * The tool contract (§16, L3).
 *
 * "Freeze early; everything later depends on it." Memory writes, scheduling,
 * approvals and every future plugin are tools, so a mistake in this file is a
 * mistake in all of them. Two parts are easy to under-build and both carry
 * weight:
 *
 *   - **`renderForModel` — truncation is the TOOL's job.** The tool knows
 *     which 2KB of a 40MB log matter. A generic truncator keeps the header
 *     and throws away the answer.
 *   - **`ToolContext` is everything a tool gets, and nothing is ambient.** No
 *     `process.env`, no global `fetch`, no raw database handle. If a tool can
 *     reach something that is not in that object, the sandbox is decorative.
 */
import type { z } from 'zod';
import type { TrustLevel } from '../substrate/events/types.js';
import type { Capability } from '../security/trust.js';
import type { Logger } from '../substrate/ports.js';

export type Risk = 'safe' | 'caution' | 'dangerous';

/**
 * `pure`   — no observable effect; safe to re-run any number of times.
 * `local`  — changes only our own state; re-running is recoverable.
 * `external` — leaves the building. **Must go through the outbox** (§18).
 */
export type Effect = 'pure' | 'local' | 'external';

export interface EgressPolicy {
  /** Hostnames this tool may reach. Exact match or a leading `*.`. */
  hosts: string[];
  methods: string[];
  /** Per-call cap. The per-run budget is enforced separately. */
  maxResponseBytes?: number;
}

export interface Cost {
  micros?: number;
  tokens?: number;
}

export interface ArtifactRef {
  id: string;
  mediaType: string;
  bytes: number;
  /** One line a human can read without opening it. */
  summary: string;
}

export interface Display {
  kind: 'text' | 'table' | 'image' | 'diff';
  title?: string;
}

export interface Metrics {
  durationMs?: number;
  bytesIn?: number;
  bytesOut?: number;
}

export const ERROR_KINDS = [
  'not_found',
  'invalid_input',
  'invalid_output',
  'denied',
  'timeout',
  'rate_limited',
  'unavailable',
  'conflict',
  'internal',
] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

/**
 * A result is a value, never a throw (invariant 13: failure is data).
 *
 * Results carry **their own trust level**, which is what makes "a web page
 * cannot spend your money" hold across a tool boundary as well as a model
 * boundary: an HTTP tool returns FOREIGN however trusted the step was.
 */
export type ToolResult<O> =
  | {
      ok: true;
      value: O;
      trust: TrustLevel;
      artifacts?: ArtifactRef[];
      display?: Display;
      metrics?: Metrics;
    }
  | {
      ok: false;
      error: { kind: ErrorKind; message: string; retryable: boolean; hint?: string };
    };

export interface Rendered {
  /** What the model sees. Already within budget — the tool guarantees it. */
  text: string;
  /** True when the tool had to cut something, so the model can ask for more. */
  truncated: boolean;
  artifacts?: ArtifactRef[];
}

/** A file store scoped to one tool's sandbox. Paths outside it do not exist. */
export interface ScopedFileStore {
  read(path: string): Promise<Uint8Array | undefined>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  list(prefix?: string): Promise<string[]>;
  delete(path: string): Promise<void>;
}

export interface ScopedNetRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
}

export interface ScopedNetResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** A `Net` that enforces this tool's egress policy (§14). */
export interface ScopedNet {
  fetch(req: ScopedNetRequest): Promise<ScopedNetResponse>;
}

/**
 * Everything a tool is given. Deliberately exhaustive — read the field list
 * as the definition of the sandbox, because that is exactly what it is.
 */
export interface ToolContext {
  signal: AbortSignal;
  principal: string;
  runId: string;
  stepId: string;
  effectiveTrust: TrustLevel;
  files: ScopedFileStore;
  net: ScopedNet;
  /**
   * Secrets the tool declared in `secretsRequired`, already resolved.
   *
   * Bytes, not strings (D-012), and the invoker zeroizes them after the call
   * returns. A tool that stashes a reference to one is holding a wiped
   * buffer, which is the intended outcome.
   */
  secrets: ReadonlyMap<string, Uint8Array>;
  /** Progress for the UI. Not a log, not a result — a heartbeat. */
  emit(progress: { message: string; fraction?: number }): void;
  logger: Logger;
  /** The injected clock, so a tool cannot read the real one. */
  now(): number;
  /**
   * This call's idempotency key (§18), or `null` for non-external tools.
   *
   * **§16's field list omits this, and it has to be here.** §18 names
   * "query the remote for the idempotency key" as the *preferred* way to
   * reconcile an interrupted effect — but a tool cannot send a key it was
   * never given, so with §16 taken literally the preferred path is
   * unimplementable and every external effect degrades to asking the user.
   *
   * Adding it is also what lets a tool pass `Idempotency-Key` to remotes that
   * support it (Stripe and friends), which moves deduplication to the only
   * place that can be authoritative: the remote. See decision 018.
   */
  idempotencyKey: string | null;
}

/**
 * Note the three-parameter `ZodType` below.
 *
 * A schema with `.default()` has a different *input* type from its *output*
 * type (`{timezone?: string}` in, `{timezone: string}` out), and the
 * two-parameter form is invariant, so a perfectly ordinary schema fails to
 * typecheck. Writing it this way lets tools use defaults — the alternative
 * is every tool handling `undefined` by hand, which is how optional fields
 * end up silently inconsistent.
 */
export type ToolSchema<T> = z.ZodType<T, z.ZodTypeDef, any>;

export interface Tool<I = unknown, O = unknown> {
  /** Stable and namespaced: `<domain>.<verb>`. */
  name: string;
  version: string;
  /** Written for the model, not for docs. It is part of the prompt. */
  description: string;
  input: ToolSchema<I>;
  output: ToolSchema<O>;

  capabilities: Capability[];
  /** Refuses to run below this effective trust. */
  minTrust: TrustLevel;
  egress?: EgressPolicy;
  secretsRequired?: string[];

  risk: Risk;
  effect: Effect;
  idempotent: boolean;
  timeoutMs: number;
  costHint?(input: I): Cost;

  execute(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
  /** Truncation is the tool's job — it knows which part matters. */
  renderForModel(result: ToolResult<O>, budget: number): Rendered;
  /** REQUIRED when `risk === 'dangerous'`. */
  dryRun?(input: I, ctx: ToolContext): Promise<string>;
  /** REQUIRED when `effect === 'external' && !idempotent`. */
  compensate?(result: ToolResult<O>, ctx: ToolContext): Promise<void>;
  /**
   * Ask the remote whether an effect with this key already happened.
   *
   * This is what makes §18's reconciliation able to *resolve* an unknown
   * rather than escalate it. A tool that can answer this is a tool that can
   * crash safely; one that cannot forces us to ask the person, which is the
   * correct but expensive fallback.
   */
  queryEffect?(idempotencyKey: string, ctx: ToolContext): Promise<EffectStatus>;
}

export type EffectStatus =
  | { happened: true; remoteRef: string | null }
  | { happened: false }
  | { happened: 'unknown' };

/** Thrown at *registration* time — never at call time. */
export class ToolContractError extends Error {
  override readonly name = 'ToolContractError';
  constructor(tool: string, problem: string) {
    super(`tool '${tool}' does not satisfy the contract: ${problem}`);
  }
}

/**
 * Validate a tool against §16's requirements.
 *
 * These are enforced at registration, not documented. A dangerous tool with
 * no preview must fail to start the process, not fail at 2am when someone is
 * relying on the preview to decide.
 */
export function assertToolContract(tool: Tool<never, never> | Tool<any, any>): void {
  const id = `${tool.name}@${tool.version}`;

  if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/.test(tool.name)) {
    // The example is deliberately not a real tool name: a test asserts that
    // no kernel file mentions one at all (invariant 9), and that test is
    // more useful absolute than with exceptions carved out of it.
    throw new ToolContractError(
      id,
      "name must be lower-case and namespaced, e.g. 'namespace.action'",
    );
  }
  if (tool.description.trim().length < 16) {
    throw new ToolContractError(
      id,
      'description is written for the model and must actually describe what the tool does',
    );
  }
  if (tool.timeoutMs <= 0) {
    throw new ToolContractError(id, 'timeoutMs must be positive — an unbounded tool can hang a run');
  }
  if (tool.risk === 'dangerous' && tool.dryRun === undefined) {
    throw new ToolContractError(
      id,
      "risk 'dangerous' requires dryRun(): a person cannot approve what they cannot preview",
    );
  }
  if (tool.effect === 'external' && !tool.idempotent && tool.compensate === undefined) {
    throw new ToolContractError(
      id,
      'a non-idempotent external effect requires compensate(): there is otherwise no way back',
    );
  }
  if (tool.effect !== 'external' && tool.egress !== undefined) {
    throw new ToolContractError(
      id,
      "declares an egress policy but its effect is not 'external' — one of the two is wrong",
    );
  }
}
