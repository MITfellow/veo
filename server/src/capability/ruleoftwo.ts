import type { TrustLevel } from '../substrate/events/types.js';
import type { Capability } from '../security/trust.js';

/**
 * The Rule of Two (§19) — the most valuable security decision in the spec,
 * and the one that must be impossible to bypass.
 *
 * > No single operation may hold more than two of:
 * >   (A) processes untrusted input
 * >   (B) accesses sensitive data or capability
 * >   (C) changes external state
 *
 * The implementation is arithmetic on a **declared** triple, never a guess.
 * It does not inspect payloads, scan strings for suspicious phrases, or
 * heuristically decide whether something "looks sensitive". A tool declares
 * `sensitivity` and `effect` in its contract (§26); a false declaration is a
 * conformance failure caught by the plugin suite, not a runtime judgement
 * call. That is what makes this rule total and decidable — and a rule that is
 * total and decidable is one that cannot be argued around at 2am.
 *
 * It runs **before** the capability check (§29), because the point is to
 * refuse the shape of the operation, not to adjudicate its permissions.
 */

/** Sensitivity, from the tool contract (§26). */
export type Sensitivity = 'none' | 'reads-private' | 'writes-private';

/** Effect, from the tool contract (§26). */
export type Effect = 'pure' | 'local' | 'external';

export interface StepDescriptor {
  /** Every trust level in the step's causal closure. */
  trustInScope: readonly TrustLevel[];
  capabilities: readonly Capability[];
  sensitivity: Sensitivity;
  effect: Effect;
  /**
   * A human has approved this specific step, having been shown all three
   * properties. The only legitimate way an (A∧B∧C) operation proceeds (§19).
   */
  humanApproval?: HumanApproval | undefined;
}

export interface HumanApproval {
  approvalId: string;
  /** The approval must name all three properties, or it does not count. */
  acknowledged: { untrustedInput: boolean; sensitiveAccess: boolean; externalChange: boolean };
}

export interface Triple {
  /** (A) — any FOREIGN content in the causal closure. */
  untrustedInput: boolean;
  /** (B) — reads or writes private data, or holds a sensitive capability. */
  sensitiveAccess: boolean;
  /** (C) — changes state outside this machine. */
  externalChange: boolean;
}

export type RuleOfTwoVerdict =
  | { allowed: true; triple: Triple; supervised: false }
  | { allowed: true; triple: Triple; supervised: true; approvalId: string }
  | { allowed: false; triple: Triple; reason: string };

/** Capabilities that constitute sensitive access on their own. */
export const SENSITIVE_CAPABILITIES: readonly Capability[] = ['vault:read', 'memory:read', 'memory:write', 'memory:promote'];

export function computeTriple(step: StepDescriptor): Triple {
  return {
    untrustedInput: step.trustInScope.includes('FOREIGN'),
    sensitiveAccess:
      step.sensitivity !== 'none' || step.capabilities.some((c) => SENSITIVE_CAPABILITIES.includes(c)),
    externalChange: step.effect === 'external' || step.capabilities.includes('effect:external'),
  };
}

export function holdsAllThree(triple: Triple): boolean {
  return triple.untrustedInput && triple.sensitiveAccess && triple.externalChange;
}

function fullyAcknowledged(approval: HumanApproval): boolean {
  const { untrustedInput, sensitiveAccess, externalChange } = approval.acknowledged;
  return untrustedInput && sensitiveAccess && externalChange;
}

/**
 * The gate.
 *
 * An (A∧B∧C) step is refused unless a human approval exists that names all
 * three properties. A partial acknowledgement is not an approval: the whole
 * value of showing someone the triple is lost if they can consent to two
 * thirds of it.
 */
export function evaluateRuleOfTwo(step: StepDescriptor): RuleOfTwoVerdict {
  const triple = computeTriple(step);

  if (!holdsAllThree(triple)) {
    return { allowed: true, triple, supervised: false };
  }

  const approval = step.humanApproval;
  if (approval !== undefined && fullyAcknowledged(approval)) {
    return { allowed: true, triple, supervised: true, approvalId: approval.approvalId };
  }

  return {
    allowed: false,
    triple,
    reason:
      'Rule of Two (§19): this operation processes untrusted input, accesses sensitive data, ' +
      'and changes external state. It may not run without an explicit human approval naming all three.',
  };
}

/** Rendered for the approval prompt, so the human sees what they are consenting to. */
export function describeTriple(triple: Triple): string[] {
  const lines: string[] = [];
  if (triple.untrustedInput) lines.push('(A) It processes content from an untrusted source.');
  if (triple.sensitiveAccess) lines.push('(B) It can read or change your private data.');
  if (triple.externalChange) lines.push('(C) It changes something outside this machine.');
  return lines;
}
