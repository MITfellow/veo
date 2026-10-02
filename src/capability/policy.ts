/**
 * The capability set, and the decision made from it (§19).
 *
 * Pure. No I/O, no clock, no storage — a decision is a function of its
 * inputs, which is what makes it testable, loggable, and replayable. The
 * caller does the appending.
 *
 * §19 defines the set as the intersection of four things:
 *
 *   granted = principal grants ∩ agent delegation ∩ ceiling(effectiveTrust)
 *   allowed = tool.capabilities ⊆ granted
 *
 * Four inputs because each answers a different question and collapsing any
 * two loses something real:
 *
 *   principal grants   what may this *person* ever do
 *   agent delegation   what did they lend the *agent*, unattended
 *   trust ceiling      what is safe given where this step's input came from
 *   tool requirements  what does this *action* need
 *
 * The delegation layer is the one that looks redundant and is not. "The user
 * can send email" does not imply "the agent may send email at 3am because a
 * web page suggested it". Delegation is where that distinction is written
 * down.
 *
 * Intersection has a property worth stating out loud: **no input can widen
 * another**. A grant cannot raise the trust ceiling. An approval cannot
 * conjure a capability the principal does not hold. The set only grows when
 * the principal grows it, which is one code path and one event type.
 */
import type { TrustLevel } from '../substrate/events/types.js';
import { type Capability, capabilitiesFor } from '../security/trust.js';

/** Why a capability is not in the set. Ordered: the first cause reported. */
export type Blocker = 'trust' | 'principal' | 'delegation';

export interface Grants {
  /** What the person may ever do. */
  readonly principal: ReadonlySet<Capability>;
  /**
   * What the person lent the agent for unattended work. Narrower than, or
   * equal to, `principal` — see `assertDelegationIsNarrower`.
   */
  readonly delegation: ReadonlySet<Capability>;
}

export interface CapabilitySet {
  readonly granted: ReadonlySet<Capability>;
  readonly trust: TrustLevel;
  /** For each capability the trust ceiling allowed but a grant removed. */
  readonly withheld: ReadonlyMap<Capability, Blocker>;
}

export interface PolicyInput {
  readonly tool: string;
  readonly required: readonly Capability[];
  readonly trust: TrustLevel;
  readonly grants: Grants;
  /**
   * The event that dragged effective trust down, if any — so the explanation
   * can say "a web page fetched at 14:02 is in this chain" instead of the
   * useless "FOREIGN".
   */
  readonly limitedBy?: { type: string; trust: TrustLevel; at?: string } | undefined;
  /** Tools the model could use instead, to end the retry loop. */
  readonly alternatives?: readonly string[] | undefined;
}

export interface PolicyVerdict {
  readonly allowed: boolean;
  readonly tool: string;
  readonly trust: TrustLevel;
  readonly missing: readonly Capability[];
  /** Per missing capability, which of the four inputs removed it. */
  readonly blockedBy: ReadonlyMap<Capability, Blocker>;
  /** True when a human could legitimately lift this by approving. */
  readonly escalatable: boolean;
  /** Plain language, for the model AND the user. They read the same text. */
  readonly explanation: string;
}

/* ───────────────────────────── the set ─────────────────────────────────── */

/**
 * Intersect the three sources into the capabilities actually available.
 *
 * Deny-by-default falls out of intersection: a capability absent from any
 * one of the three is absent from the result, and nothing has to remember to
 * exclude it.
 */
export function capabilitySet(trust: TrustLevel, grants: Grants): CapabilitySet {
  const ceiling = capabilitiesFor(trust);
  const granted = new Set<Capability>();
  const withheld = new Map<Capability, Blocker>();

  for (const capability of ceiling) {
    if (!grants.principal.has(capability)) {
      withheld.set(capability, 'principal');
      continue;
    }
    if (!grants.delegation.has(capability)) {
      withheld.set(capability, 'delegation');
      continue;
    }
    granted.add(capability);
  }

  return { granted, trust, withheld };
}

/** Which input is responsible for a capability being unavailable. */
function blockerFor(capability: Capability, trust: TrustLevel, grants: Grants): Blocker {
  // Trust is reported first when it is implicated, because it is the one the
  // user can neither grant away nor approve around — it describes where the
  // data came from, and that is a fact about the world.
  if (!capabilitiesFor(trust).has(capability)) return 'trust';
  if (!grants.principal.has(capability)) return 'principal';
  return 'delegation';
}

/* ─────────────────────────── the decision ──────────────────────────────── */

export function decide(input: PolicyInput): PolicyVerdict {
  const set = capabilitySet(input.trust, input.grants);
  const missing = input.required.filter((capability) => !set.granted.has(capability));

  if (missing.length === 0) {
    return {
      allowed: true,
      tool: input.tool,
      trust: input.trust,
      missing: [],
      blockedBy: new Map(),
      escalatable: false,
      explanation: '',
    };
  }

  const blockedBy = new Map<Capability, Blocker>(
    missing.map((capability) => [capability, blockerFor(capability, input.trust, input.grants)]),
  );

  // Escalatable only when a human genuinely holds every missing capability.
  // Offering to ask for approval that cannot be granted trains the user to
  // approve things reflexively, which is worse than a flat refusal.
  const escalatable =
    missing.every((capability) => input.grants.principal.has(capability)) &&
    missing.every((capability) => capabilitiesFor('USER').has(capability));

  return {
    allowed: false,
    tool: input.tool,
    trust: input.trust,
    missing,
    blockedBy,
    escalatable,
    explanation: explain(input, missing, blockedBy, escalatable),
  };
}

/**
 * The explanation, which is shown to the model and to the user unchanged.
 *
 * Four things, in this order: what was refused, *why* in terms of cause,
 * whether a human can lift it, and what to do instead. The last one is not
 * politeness — a model refused with no alternative retries the same call or
 * invents a way around it. An alternative ends the loop.
 */
function explain(
  input: PolicyInput,
  missing: readonly Capability[],
  blockedBy: ReadonlyMap<Capability, Blocker>,
  escalatable: boolean,
): string {
  const parts: string[] = [];
  const list = missing.join(', ');

  parts.push(`'${input.tool}' was refused: it needs ${list}, which this step does not have.`);

  const causes = new Set(blockedBy.values());

  if (causes.has('trust')) {
    const because =
      input.limitedBy !== undefined
        ? `a '${input.limitedBy.type}' event at ${input.limitedBy.trust} trust is in this step's ` +
          `causal chain${input.limitedBy.at !== undefined ? ` (${input.limitedBy.at})` : ''}`
        : `this step runs at ${input.trust} trust`;
    parts.push(
      `That is a trust limit, not a settings problem: ${because}. ` +
        'Content whose origin cannot be vouched for does not reach credentials, money, ' +
        'or outbound messages, no matter what that content asks for.',
    );
  }
  if (causes.has('principal')) {
    parts.push('The account itself does not hold that permission.');
  }
  if (causes.has('delegation')) {
    parts.push(
      'The user holds that permission but has not delegated it for unattended work.',
    );
  }

  parts.push(
    escalatable
      ? 'A human can approve this explicitly; the approval will show them exactly what is being asked.'
      : 'This cannot be approved — no principal holds that capability, so there is no one to ask.',
  );

  if (input.alternatives !== undefined && input.alternatives.length > 0) {
    parts.push(`You can still use: ${input.alternatives.join(', ')}.`);
  } else {
    parts.push('Do not retry this call. Tell the user what you were trying to do and why it stopped.');
  }

  return parts.join(' ');
}

/* ─────────────────────────── delegation sanity ─────────────────────────── */

export class DelegationError extends Error {
  constructor(readonly excess: readonly Capability[]) {
    super(
      `delegation exceeds the principal's own grants: ${excess.join(', ')}. ` +
        'An agent cannot be lent authority its principal does not have.',
    );
    this.name = 'DelegationError';
  }
}

/**
 * Refuse a delegation wider than the principal's grants.
 *
 * Checked at construction rather than silently intersected away, because a
 * delegation that claims more than the principal holds means the caller
 * believes something false about who can do what. Quietly narrowing it would
 * leave that belief in place, and it will be wrong again somewhere else.
 */
export function assertDelegationIsNarrower(grants: Grants): void {
  const excess = [...grants.delegation].filter((c) => !grants.principal.has(c));
  if (excess.length > 0) throw new DelegationError(excess);
}

/**
 * Everything a single user may do, fully delegated.
 *
 * The default for the single-principal setup this runtime is built for
 * (§15: never hardcode a user id, but one user is the current reality).
 * Named and exported rather than inlined so that every caller choosing it
 * is choosing it visibly, and so the day multi-principal arrives there is
 * one symbol to find.
 */
export const DEFAULT_GRANTS: Grants = {
  principal: capabilitiesFor('USER'),
  delegation: capabilitiesFor('USER'),
};

/** Everything the principal can do — the default for an attended session. */
export function fullDelegation(principal: ReadonlySet<Capability>): Grants {
  return { principal, delegation: new Set(principal) };
}
