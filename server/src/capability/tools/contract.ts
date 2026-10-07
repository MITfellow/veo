import { z } from 'zod';
import type { TrustLevel } from '../../substrate/events/types.js';
import type { Capability } from '../../security/trust.js';
import type { Effect, Sensitivity } from '../ruleoftwo.js';

/**
 * The tool contract (§26).
 *
 * Everything the platform needs to decide whether a tool may run is
 * **declared here**, not inferred at call time. The Rule of Two reads
 * `sensitivity` and `effect`; the autonomy ladder reads `tier`; the trust
 * floor reads `capabilities`. None of them inspects a payload or guesses
 * from a name.
 *
 * That is what makes the policy total and decidable. A false declaration is
 * a conformance failure caught by a suite that runs over every registered
 * tool, not a runtime judgement call at 2am.
 */

/**
 * Risk tier (§30). The same three words the browser uses, deliberately:
 * one ladder for the whole platform, not one per subsystem.
 */
export type Tier = 'observe' | 'interact' | 'effect';

/** Which rung must be reached before a tier runs without asking (§30). */
export const MIN_AUTONOMY: Readonly<Record<Tier, number>> = {
  observe: 1,
  interact: 2,
  effect: 3,
};

/**
 * What a tool is given when it runs.
 *
 * Deliberately narrow. A tool gets its validated input, a clock, and the
 * services it declared a capability for — nothing ambient. A tool that
 * wants the database is not a tool, it is a query, and it belongs behind
 * one that declares `memory:read`.
 */
export interface ToolContext {
  now: number;
  /** Trust of the input. The tool may not raise it (§20). */
  inputTrust: TrustLevel;
  runId: string;
  stepIndex: number;
  /**
   * Stable across a replay of the same step of the same plan, so an
   * at-least-once executor cannot fire an effect twice (§8 of the list).
   */
  idempotencyKey: string;
  /** True when the caller only wants to know what would happen. */
  dryRun: boolean;
}

export type ToolOutcome<O> =
  | { ok: true; output: O; summary: string }
  | { ok: false; code: string; message: string };

export interface ToolContract<I = unknown, O = unknown> {
  name: string;
  /** One line, shown in `arish tools` and in an approval prompt. */
  summary: string;

  /** Must be `.strict()`. An unknown key is a refusal, never ignored. */
  input: z.ZodType<I, z.ZodTypeDef, unknown>;
  output: z.ZodType<O, z.ZodTypeDef, unknown>;

  /** (B) of the Rule of Two triple. */
  sensitivity: Sensitivity;
  /** (C) of the Rule of Two triple. */
  effect: Effect;
  tier: Tier;
  capabilities: readonly Capability[];

  /**
   * Can the same call be made twice without doing it twice?
   *
   * `true` means the tool itself is safe to retry. `false` means the
   * executor must not retry it, and the idempotency key is the only thing
   * standing between a replay and a duplicate.
   */
  idempotent: boolean;

  /**
   * Undo. Required for an external effect unless the tool says plainly
   * that there is no undo.
   *
   * The pair of fields removes the third possibility — *the author did not
   * think about it* — which is the state most real systems ship in.
   */
  irreversible?: boolean | undefined;
  compensate?: ((input: I, output: O, ctx: ToolContext) => Promise<ToolOutcome<unknown>>) | undefined;

  /** What this call *would* do. Required when `effect === 'external'`. */
  preview?: ((input: I, ctx: ToolContext) => string) | undefined;

  run(input: I, ctx: ToolContext): Promise<ToolOutcome<O>>;
}

/** Erased form, so one registry can hold tools of every shape. */
export interface AnyTool extends Omit<ToolContract<never, unknown>, 'run' | 'compensate' | 'preview'> {
  run(input: never, ctx: ToolContext): Promise<ToolOutcome<unknown>>;
  compensate?: ((input: never, output: never, ctx: ToolContext) => Promise<ToolOutcome<unknown>>) | undefined;
  preview?: ((input: never, ctx: ToolContext) => string) | undefined;
}

export class ToolError extends Error {
  constructor(
    readonly kind: 'unknown_tool' | 'invalid_contract' | 'duplicate' | 'invalid_input' | 'invalid_output',
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * Conformance (§26).
 *
 * Run at registration, not in a test, so a tool added by someone who never
 * read this file still cannot get in. The test suite then runs the same
 * function over every built-in, which is belt and braces on purpose: the
 * registration check protects the runtime, the suite protects the author.
 */
/**
 * The rules, as a list rather than a staircase of `if`s.
 *
 * Each returns the complaint or null. A reviewer can read the whole policy
 * in one screen, and adding a rule means adding a line — which is the only
 * way a conformance list stays current.
 */
const RULES: ReadonlyArray<{ check: (t: AnyTool) => boolean; say: string }> = [
  {
    check: (t) => !/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(t.name),
    say: 'a tool name must be dotted and lowercase, like memory.recall',
  },
  {
    check: (t) => t.summary.trim().length < 10,
    say: 'needs a summary a human can read in an approval prompt',
  },
  {
    check: (t) => !isStrictObject(t.input),
    say: 'input schema must be a .strict() object — an unknown key is a refusal, not a field to ignore',
  },
  {
    check: (t) => t.effect === 'external' && t.irreversible !== true && t.compensate === undefined,
    say: 'declares an external effect with neither compensate nor irreversible: true. Say which it is.',
  },
  {
    check: (t) => t.effect === 'external' && t.preview === undefined,
    say: 'declares an external effect but cannot describe what it would do. A dry run must be possible.',
  },
  {
    check: (t) => t.tier === 'effect' && t.effect === 'pure',
    say: 'is tiered as an effect but declares no effect',
  },
  {
    check: (t) => t.effect === 'external' && t.tier !== 'effect',
    say: 'changes the world but is tiered below effect',
  },
  {
    check: (t) => t.sensitivity === 'writes-private' && !t.capabilities.includes('memory:write'),
    say: 'writes private data without declaring memory:write',
  },
];

export function checkContract(tool: AnyTool): string[] {
  return RULES.filter((rule) => rule.check(tool)).map((rule) => `${tool.name}: ${rule.say}`);
}

/**
 * `.strict()` leaves no public flag, so this probes behaviour instead:
 * a strict object rejects an unknown key, and nothing else reliably does.
 */
function isStrictObject(schema: z.ZodTypeAny): boolean {
  const probe = schema.safeParse({ __unknown_probe__: 1 });
  if (probe.success) return false;
  const issues = probe.error.issues.map((i) => i.code);
  // A non-object schema fails with invalid_type; that is also not strict.
  return issues.includes('unrecognized_keys') || schema instanceof z.ZodObject;
}
