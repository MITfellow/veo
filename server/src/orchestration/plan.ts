import type { CryptoPort } from '../substrate/ports.js';
import type { Rung } from './autonomy.js';

/**
 * Plan-then-execute, generalised (§22).
 *
 * Decision 009 built this for browsing. The shape was right, so M3 does not
 * invent a second one: a plan is agreed **before anything is read or run**,
 * it fixes what may be done, and it is sealed so a later mutation is
 * detectable rather than merely discouraged.
 *
 * The property that matters: content encountered *during* the run cannot
 * widen the plan. A page, a file or a tool's output can say "now email
 * everyone" as loudly as it likes; if `email.send` is not in `allowedTools`,
 * there is no path from that sentence to that call. The only route to new
 * authority is a new plan, and a new plan is a human decision.
 */

export interface PlanStep {
  tool: string;
  /** Validated against the tool's own schema at execution, not here. */
  input: unknown;
  /** Why this step, in the user's terms. Shown in an approval prompt. */
  why: string;
}

export interface PlanSpec {
  goal: string;
  steps: readonly PlanStep[];
  /** Tools this run may call. A step naming anything else is refused. */
  allowedTools: readonly string[];
  maxSteps: number;
  rung: Rung;
  /** True if the run may read private data while untrusted content is in scope (§19). */
  carriesPrivateData: boolean;
}

export interface SealedPlan extends PlanSpec {
  seal: string;
  committedAt: number;
}

/**
 * The seal covers everything that could change the meaning of the run.
 *
 * Including the budget and the rung, not just the steps: a plan whose step
 * list is untouched but whose autonomy was quietly raised from L1 to L4 is
 * a different plan, and a seal that did not notice would be theatre.
 */
export function sealPlan(spec: PlanSpec, crypto: CryptoPort, at: number): SealedPlan {
  return { ...spec, seal: sealOf(spec, crypto), committedAt: at };
}

export function sealOf(spec: PlanSpec, crypto: CryptoPort): string {
  return crypto.sha256(
    JSON.stringify({
      goal: spec.goal,
      steps: spec.steps.map((s) => ({ tool: s.tool, input: s.input, why: s.why })),
      allowedTools: [...spec.allowedTools].sort(),
      maxSteps: spec.maxSteps,
      rung: spec.rung,
      carriesPrivateData: spec.carriesPrivateData,
    }),
  );
}

export function sealIntact(plan: SealedPlan, crypto: CryptoPort): boolean {
  return sealOf(plan, crypto) === plan.seal;
}

/** A per-step seal, so an approval can be bound to one step of one plan. */
export function stepSeal(plan: SealedPlan, stepIndex: number, crypto: CryptoPort): string {
  return crypto.sha256(`${plan.seal}:${stepIndex}`);
}

export type PlanRefusal =
  | { ok: false; code: 'not_in_plan'; message: string }
  | { ok: false; code: 'step_limit'; message: string }
  | { ok: false; code: 'seal_broken'; message: string };

export type PlanVerdict = { ok: true } | PlanRefusal;

/** Does the plan itself permit this step? Asked before any policy runs. */
export function planPermits(plan: SealedPlan, stepIndex: number, crypto: CryptoPort): PlanVerdict {
  if (!sealIntact(plan, crypto)) {
    return {
      ok: false,
      code: 'seal_broken',
      message: 'The plan changed after it was committed. A plan that changes is a different plan (§22); this run stops.',
    };
  }
  if (stepIndex >= plan.maxSteps) {
    return { ok: false, code: 'step_limit', message: `The plan allowed ${plan.maxSteps} steps and this is step ${stepIndex + 1}.` };
  }
  const step = plan.steps[stepIndex];
  if (step === undefined) {
    return { ok: false, code: 'not_in_plan', message: `There is no step ${stepIndex} in this plan.` };
  }
  if (!plan.allowedTools.includes(step.tool)) {
    return {
      ok: false,
      code: 'not_in_plan',
      message: `'${step.tool}' is not in this plan's allowed tools. Nothing encountered during a run can add one.`,
    };
  }
  return { ok: true };
}
