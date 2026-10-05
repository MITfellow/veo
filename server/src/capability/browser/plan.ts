import { z } from 'zod';

/**
 * Plan-then-execute for browsing (§22, decision 009).
 *
 * A `CommittedPlan` is agreed **before any page is read** and fixes what
 * the session may do: which kinds of action, how many steps, which
 * origins. It is sealed with a hash so a later mutation is detectable.
 *
 * This is the mechanism that makes page content unable to escalate. The
 * page can offer a thousand buttons; if the plan did not authorise
 * `submit`, none of them submit anything. The only route to a new
 * authority is a new plan, and a new plan is a human decision.
 */

export const ACTION_KINDS = ['navigate', 'read', 'click', 'type', 'select', 'check', 'submit', 'download'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/**
 * Risk tiers (§30 autonomy ladder).
 *
 * `read` and `navigate` observe. `click`, `type`, `select`, `check` change
 * the page but not the world. `submit` and `download` change the world —
 * they post data somewhere or write a file — and are gated hardest.
 */
export const ACTION_RISK: Readonly<Record<ActionKind, 'observe' | 'interact' | 'effect'>> = {
  navigate: 'observe',
  read: 'observe',
  click: 'interact',
  type: 'interact',
  select: 'interact',
  check: 'interact',
  submit: 'effect',
  download: 'effect',
};

/** Minimum autonomy rung at which each tier may run unattended (§30). */
export const MIN_AUTONOMY: Readonly<Record<'observe' | 'interact' | 'effect', number>> = {
  observe: 1,
  interact: 2,
  effect: 4,
};

export const ActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), url: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('read') }).strict(),
  z.object({ kind: z.literal('click'), ref: z.string().regex(/^e\d+$/) }).strict(),
  z.object({ kind: z.literal('type'), ref: z.string().regex(/^e\d+$/), text: z.string(), secretRef: z.string().optional() }).strict(),
  z.object({ kind: z.literal('select'), ref: z.string().regex(/^e\d+$/), option: z.string() }).strict(),
  z.object({ kind: z.literal('check'), ref: z.string().regex(/^e\d+$/), checked: z.boolean() }).strict(),
  z.object({ kind: z.literal('submit'), formIndex: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal('download'), ref: z.string().regex(/^e\d+$/) }).strict(),
]);

export type Action = z.infer<typeof ActionSchema>;

export interface PlanSpec {
  /** What the user actually asked for, in their words. */
  goal: string;
  allowedKinds: readonly ActionKind[];
  maxSteps: number;
  /** Origins the session may visit. Empty means only the starting origin. */
  allowedOrigins: readonly string[];
  /** True if the session may read private data while browsing (§19). */
  carriesPrivateData: boolean;
}

export interface CommittedPlan extends PlanSpec {
  /** Hash over the spec. A plan that changes is a different plan. */
  seal: string;
  committedAt: number;
}

export type Refusal = { allowed: false; reason: string; code: RefusalCode };
export type Permission = { allowed: true; requiresApproval: boolean; reason: string };
export type Verdict = Refusal | Permission;

export type RefusalCode =
  | 'kind_not_in_plan'
  | 'step_limit'
  | 'origin_not_allowed'
  | 'unknown_ref'
  | 'element_disabled'
  | 'autonomy_too_low'
  | 'rule_of_two'
  | 'seal_broken';

const refuse = (code: RefusalCode, reason: string): Refusal => ({ allowed: false, code, reason });

/**
 * Seal a plan.
 *
 * Takes a digest function rather than importing one: `capability/` may not
 * reach into the substrate's crypto port directly, and passing it keeps
 * the plan machinery pure and testable.
 */
export function commitPlan(spec: PlanSpec, now: number, digest: (input: string) => string): CommittedPlan {
  const canonical = JSON.stringify({
    goal: spec.goal,
    allowedKinds: [...spec.allowedKinds].sort(),
    maxSteps: spec.maxSteps,
    allowedOrigins: [...spec.allowedOrigins].sort(),
    carriesPrivateData: spec.carriesPrivateData,
  });
  return { ...spec, seal: digest(canonical), committedAt: now };
}

export function verifySeal(plan: CommittedPlan, digest: (input: string) => string): boolean {
  return commitPlan(plan, plan.committedAt, digest).seal === plan.seal;
}

export interface EvaluationContext {
  plan: CommittedPlan;
  stepsTaken: number;
  autonomy: number;
  currentOrigin: string;
  /** Refs the *current* observation offered. Anything else does not exist. */
  knownRefs: ReadonlySet<string>;
  disabledRefs: ReadonlySet<string>;
  targetOrigin?: string | undefined;
  /** Has an approval been granted naming this exact action? */
  approved?: boolean | undefined;
}

function checkRef(action: Action, ctx: EvaluationContext): Refusal | null {
  if (!('ref' in action)) return null;
  // A ref the current page did not offer is either stale or invented. Both
  // mean the agent is acting on a page it is not looking at.
  if (!ctx.knownRefs.has(action.ref)) {
    return refuse('unknown_ref', `No element ${action.ref} in the current observation.`);
  }
  if (ctx.disabledRefs.has(action.ref)) {
    return refuse('element_disabled', `Element ${action.ref} is disabled.`);
  }
  return null;
}

function checkOrigin(action: Action, ctx: EvaluationContext): Refusal | null {
  if (action.kind !== 'navigate') return null;

  // An empty origin list means "stay where you start". Before anything is
  // loaded there is no "where", and the destination is chosen by the
  // planner rather than by a page — so the entry navigation establishes
  // the origin and every later one is confined to it.
  //
  // Found by driving the UI: without this, "only where I start" sealed a
  // plan that could never take its first step.
  if (ctx.plan.allowedOrigins.length === 0 && ctx.currentOrigin === '') return null;

  const allowed = ctx.plan.allowedOrigins.length === 0 ? [ctx.currentOrigin] : ctx.plan.allowedOrigins;
  const target = ctx.targetOrigin ?? '';
  if (!allowed.includes(target)) {
    return refuse(
      'origin_not_allowed',
      `The plan permits ${allowed.join(', ') || '(nothing)'}; this navigates to ${target || '(unknown)'}.`,
    );
  }
  return null;
}

/**
 * The whole gate.
 *
 * Ordered so the cheapest and most absolute checks run first, and so the
 * refusal a developer sees names the most fundamental thing they broke.
 */
export function evaluateAction(action: Action, ctx: EvaluationContext): Verdict {
  if (!ctx.plan.allowedKinds.includes(action.kind)) {
    return refuse('kind_not_in_plan', `The committed plan does not permit '${action.kind}'. Re-commit the plan to change that.`);
  }
  if (ctx.stepsTaken >= ctx.plan.maxSteps) {
    return refuse('step_limit', `The plan allows ${ctx.plan.maxSteps} steps and ${ctx.stepsTaken} have been taken.`);
  }

  const structural = checkRef(action, ctx) ?? checkOrigin(action, ctx);
  if (structural !== null) return structural;

  const tier = ACTION_RISK[action.kind];

  // §19. Browsing is untrusted content by definition. Add private data and
  // an outbound effect and all three properties are held at once.
  if (tier === 'effect' && ctx.plan.carriesPrivateData && ctx.approved !== true) {
    return refuse(
      'rule_of_two',
      'This session holds private data, is reading untrusted content, and is about to change something outside this machine. All three together need your explicit approval (§19).',
    );
  }

  if (ctx.autonomy < MIN_AUTONOMY[tier]) {
    return ctx.approved === true
      ? { allowed: true, requiresApproval: false, reason: `approved: ${action.kind}` }
      : {
          allowed: true,
          requiresApproval: true,
          reason: `'${action.kind}' is a ${tier} action and needs autonomy L${MIN_AUTONOMY[tier]}; the session is at L${ctx.autonomy}.`,
        };
  }

  return { allowed: true, requiresApproval: false, reason: `${tier} action within plan` };
}

/** A sensible default for "just go and read that page". */
export function readOnlyPlan(goal: string, origins: readonly string[]): PlanSpec {
  return { goal, allowedKinds: ['navigate', 'read'], maxSteps: 12, allowedOrigins: origins, carriesPrivateData: false };
}
