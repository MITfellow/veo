/**
 * §18 — procedural memory, and the discipline of letting go.
 *
 * A rule here is a habit the agent has induced about its person: "she
 * means the northern warehouse", "never schedule him before ten". The
 * interesting half is not learning them. It is **unlearning them when
 * they stop being true**, because a personal agent that keeps acting on
 * a rule the user has corrected five times is not personalised, it is
 * stubborn, and it is the single most irritating failure this product
 * can have.
 *
 * So a rule carries its own contradiction count and demotes itself:
 *
 * ```
 *   active ──3 overrides──▶ probation ──5 overrides──▶ retired
 *      ▲                        │
 *      └──── reinforced ────────┘        (retired is final)
 * ```
 *
 * Thresholds are 3 and 5 from the specification. The reinforcement path
 * back out of probation is this file's own judgement: a rule that was
 * wrong three times and right ten since is a rule that has been fixed,
 * and refusing to let it recover would make probation a slow death
 * sentence rather than a warning.
 *
 * Retirement is one-way. A retired rule is evidence that an inference
 * was wrong about this person, and resurrecting it on a lucky streak is
 * how an agent re-learns something it was explicitly corrected on.
 */

export const PROBATION_AT = 3;
export const RETIRED_AT = 5;
/** Consecutive confirmations that clear a rule from probation. */
export const REHABILITATION = 5;

export type RuleStatus = 'active' | 'probation' | 'retired';

export interface Rule {
  id: string;
  /** The condition, in the user's own words where possible. */
  when: string;
  then: string;
  /** 0–1. Shown to the user; never used as a gate on its own. */
  confidence: number;
  status: RuleStatus;
  /** Lifetime count of times the user did something else. */
  overrides: number;
  /** Confirmations since the last override. Resets to 0 on an override. */
  streak: number;
  /** Lifetime confirmations, for the user-facing history. */
  confirmations: number;
  updatedAt: number;
}

export interface RuleChange {
  rule: Rule;
  /** Did the status move? The caller tells the user only when it did. */
  changed: boolean;
  /** One line a person can read. Empty when nothing changed. */
  note: string;
}

export function newRule(id: string, when: string, then: string, now: number, confidence = 0.5): Rule {
  return { id, when, then, confidence, status: 'active', overrides: 0, streak: 0, confirmations: 0, updatedAt: now };
}

function statusFor(overrides: number, current: RuleStatus): RuleStatus {
  if (current === 'retired') return 'retired';
  if (overrides >= RETIRED_AT) return 'retired';
  if (overrides >= PROBATION_AT) return 'probation';
  return 'active';
}

/**
 * The user did something other than what the rule predicted.
 *
 * Note what is *not* here: no notion of "maybe they made a mistake".
 * The user is the ground truth about their own life, and a rule that
 * argues with them is the bug.
 */
export function override(rule: Rule, now: number): RuleChange {
  if (rule.status === 'retired') {
    return { rule: { ...rule, updatedAt: now }, changed: false, note: '' };
  }
  const overrides = rule.overrides + 1;
  const status = statusFor(overrides, rule.status);
  const next: Rule = {
    ...rule,
    overrides,
    streak: 0,
    // Confidence falls faster than it rises: being wrong is stronger
    // evidence than being right, because being right is also what a
    // coincidence looks like.
    confidence: Math.max(0, Number((rule.confidence - 0.2).toFixed(2))),
    status,
    updatedAt: now,
  };
  if (status === rule.status) return { rule: next, changed: false, note: '' };
  return {
    rule: next,
    changed: true,
    note: status === 'retired'
      ? `Stopped applying "${rule.when} → ${rule.then}" — you have overridden it ${overrides} times.`
      : `Holding back on "${rule.when} → ${rule.then}" until it proves itself again.`,
  };
}

/** The user did what the rule predicted. */
export function confirm(rule: Rule, now: number): RuleChange {
  if (rule.status === 'retired') {
    return { rule: { ...rule, updatedAt: now }, changed: false, note: '' };
  }
  const streak = rule.streak + 1;
  const promoted = rule.status === 'probation' && streak >= REHABILITATION;
  const next: Rule = {
    ...rule,
    streak,
    confirmations: rule.confirmations + 1,
    confidence: Math.min(1, Number((rule.confidence + 0.05).toFixed(2))),
    status: promoted ? 'active' : rule.status,
    updatedAt: now,
  };
  return promoted
    ? { rule: next, changed: true, note: `"${rule.when} → ${rule.then}" has been right ${streak} times running; using it again.` }
    : { rule: next, changed: false, note: '' };
}

/**
 * Which rules may actually be applied right now.
 *
 * A rule on probation is **kept and not used**. Deleting it would lose
 * the history that explains why the agent stopped trusting it, and using
 * it would ignore the three corrections that put it there.
 */
export function applicable(rules: readonly Rule[]): Rule[] {
  return rules.filter((rule) => rule.status === 'active');
}

/** What to show a person who asks why the agent did, or did not, assume something. */
export function explainRule(rule: Rule): string {
  const base = `"${rule.when} → ${rule.then}" (confidence ${rule.confidence.toFixed(2)})`;
  if (rule.status === 'active') return `${base} — in use, right ${rule.confirmations} times.`;
  if (rule.status === 'probation') {
    return `${base} — on hold after ${rule.overrides} corrections; ${REHABILITATION - rule.streak} more confirmations to resume.`;
  }
  return `${base} — retired after ${rule.overrides} corrections. It will not come back on its own.`;
}
