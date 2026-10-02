import type { EventLog } from '../substrate/events/log.js';
import { type TrustLevel, minTrust, trustRank } from '../substrate/events/types.js';

/**
 * Trust made load-bearing (§12).
 *
 * M0 shipped the lattice *values*. This is the part that matters: effective
 * trust computed over a causal closure, and a capability set derived from it.
 *
 * The property being enforced is §12.1 — trust is monotonically non-increasing
 * through a causal chain. If a web page influenced a step, that step is
 * FOREIGN no matter what the model claims about itself, because the minimum
 * over the closure is FOREIGN. There is no code path that raises it.
 */

export type Capability =
  | 'vault:read'
  /**
   * Listing credential *names* is strictly weaker than reading their values,
   * so it is its own capability. Folding it into `vault:read` would mean a
   * tool that only wants to know whether a key exists has to be granted the
   * power to read every secret — the classic over-broad scope that makes
   * capability systems decorative. Added at M3 for secret-name listing.
   */
  | 'vault:list'
  | 'spend'
  | 'send'
  | 'net:read'
  | 'net:write'
  | 'fs:read'
  | 'fs:write'
  | 'fs:write:sandbox'
  | 'memory:write'
  | 'memory:write:quarantined'
  | 'memory:read'
  | 'schedule:create'
  /**
   * S1's calendar. Split read from write for the same reason
   * `vault:list` is not `vault:read`: a tool that needs to know what is
   * on today should not thereby be able to cancel it.
   */
  | 'calendar:read'
  | 'calendar:write'
  /** S2's task list. Split for the same reason the calendar's is. */
  | 'tasks:read'
  | 'tasks:write'
  | 'approval:request';

/**
 * The ceiling per trust level — an **allowlist**, deliberately.
 *
 * A denylist ("FOREIGN cannot do X, Y, Z") fails open: add a capability next
 * year, forget to add it to the denylist, and untrusted web content silently
 * gains it. An allowlist fails closed, which is the right direction for the
 * thing standing between a web page and the user's money.
 */
const CAPABILITY_CEILING: Record<TrustLevel, ReadonlySet<Capability>> = {
  SYSTEM: new Set<Capability>([
    'vault:read',
    'vault:list',
    'spend',
    'send',
    'net:read',
    'net:write',
    'fs:read',
    'fs:write',
    'fs:write:sandbox',
    'memory:write',
    'memory:write:quarantined',
    'memory:read',
    'schedule:create',
    'calendar:read',
    'calendar:write',
    'tasks:read',
    'tasks:write',
    'approval:request',
  ]),
  USER: new Set<Capability>([
    'vault:read',
    'vault:list',
    'spend',
    'send',
    'net:read',
    'net:write',
    'fs:read',
    'fs:write',
    'fs:write:sandbox',
    'memory:write',
    'memory:write:quarantined',
    'memory:read',
    'schedule:create',
    'calendar:read',
    'calendar:write',
    'tasks:read',
    'tasks:write',
    'approval:request',
  ]),
  // Model output derived from SYSTEM/USER content only. Can act, but cannot
  // reach credentials on its own — a hallucinated vault read is still a
  // vault read.
  DERIVED: new Set<Capability>([
    'vault:list',
    'net:read',
    'fs:read',
    'fs:write:sandbox',
    'memory:write',
    // Writing *quarantined* memory is strictly weaker than writing active
    // memory, so every level that can do the latter must also be able to do
    // the former. Omitting it broke the nesting property below, which is what
    // guarantees a drop in trust can never grant a capability.
    'memory:write:quarantined',
    'memory:read',
    // The agent may put something in the calendar — that is most of the
    // point of having one — and `calendar.cancel` is held back by its
    // own `minTrust: 'USER'` rather than by removing the capability,
    // because removing it here would also stop the agent adding.
    'calendar:read',
    'calendar:write',
    // Same split as the calendar: the agent may add a task and tick one
    // off, both visible and reversible. `tasks.drop` is held back by
    // its own minTrust rather than by removing the capability.
    'tasks:read',
    'tasks:write',
    // **No `schedule:create`.** Found by an M8 adversarial test and changed
    // here rather than papered over downstream: a schedule is a standing
    // grant of future authority, and DERIVED is model output, which is
    // downstream of every fenced web page the agent has ever read. The
    // agent may *ask* (`approval:request`) and the user may create one;
    // the agent cannot hand itself a recurring slot. Dropping a capability
    // from DERIVED keeps the nesting property — DERIVED is still a subset
    // of USER — so a drop in trust still cannot grant anything.
    'approval:request',
  ]),
  // A trusted, allowlisted tool's output. Narrower than DERIVED on writes
  // because tool output is where foreign data most often arrives mislabelled.
  TOOL: new Set<Capability>([
    'net:read',
    'fs:read',
    'fs:write:sandbox',
    'memory:write:quarantined',
    'memory:read',
    // Read but not write: tool output is where foreign data most often
    // arrives mislabelled, and a mislabelled calendar write is an entry
    // in someone's week that nobody remembers making.
    'calendar:read',
    'tasks:read',
    'approval:request',
  ]),
  // §12.2 verbatim: no vault reads, no money, no outbound messages, no
  // filesystem writes outside the sandbox, no new egress hosts.
  FOREIGN: new Set<Capability>([
    'fs:write:sandbox',
    'memory:write:quarantined',
    'approval:request',
  ]),
};

export function capabilitiesFor(trust: TrustLevel): ReadonlySet<Capability> {
  return CAPABILITY_CEILING[trust];
}

/** Deny-by-default: anything not explicitly in the ceiling is refused. */
export function permits(trust: TrustLevel, capability: Capability): boolean {
  return CAPABILITY_CEILING[trust].has(capability);
}

export interface EffectiveTrust {
  level: TrustLevel;
  /** The event that dragged it down, for an explanation the user can read. */
  limitedBy: { eventId: string; type: string; trust: TrustLevel } | null;
  closureSize: number;
}

/**
 * Minimum trust over everything in a step's causal closure (§12.1).
 *
 * `causalClosure` walks `causationId` back to the root. The result carries
 * *which* event set the floor, because "denied: FOREIGN" is useless to a user
 * and "denied: a web page fetched at 14:02 is in this chain" is actionable.
 */
export function effectiveTrust(log: EventLog, eventId: string): EffectiveTrust {
  const chain = log.causalClosure(eventId);
  if (chain.length === 0) {
    // An unknown event cannot be shown to be trustworthy, so it is not.
    return { level: 'FOREIGN', limitedBy: null, closureSize: 0 };
  }

  let lowest = chain[0]!;
  for (const e of chain) {
    if (trustRank(e.trust) < trustRank(lowest.trust)) lowest = e;
  }
  const level = minTrust(...chain.map((e) => e.trust));

  return {
    level,
    limitedBy:
      lowest.trust === level && chain.length > 1
        ? { eventId: lowest.id, type: lowest.type, trust: lowest.trust }
        : null,
    closureSize: chain.length,
  };
}

/** Trust of a step whose inputs come from several chains at once. */
export function combineTrust(...levels: TrustLevel[]): TrustLevel {
  return minTrust(...levels);
}

export interface PolicyDecision {
  allowed: boolean;
  trust: TrustLevel;
  missing: Capability[];
  /** Plain language, intended to be shown to both the model and the user. */
  explanation: string;
  /** True when a human could lift this by approving (§12.3). */
  escalatable: boolean;
}

/**
 * The gate. Returns a decision rather than throwing, because §35.11 says
 * failure is data — a denial the model can read and adapt to beats an
 * exception it cannot see.
 */
export function checkCapabilities(
  trust: TrustLevel,
  required: readonly Capability[],
): PolicyDecision {
  const ceiling = CAPABILITY_CEILING[trust];
  const missing = required.filter((c) => !ceiling.has(c));

  if (missing.length === 0) {
    return { allowed: true, trust, missing: [], explanation: '', escalatable: false };
  }

  // Escalatable only if a *human* could legitimately grant it — i.e. the
  // capability exists at USER level. Nothing escalates to something only
  // SYSTEM may do.
  const escalatable = missing.every((c) => CAPABILITY_CEILING.USER.has(c));

  return {
    allowed: false,
    trust,
    missing,
    explanation:
      `Refused: this step runs at ${trust} trust, which does not permit ` +
      `${missing.join(', ')}. ` +
      (trust === 'FOREIGN'
        ? 'Content from an untrusted source is somewhere in this step\'s causal chain, ' +
          'so it cannot reach credentials, money, or outbound messages. '
        : '') +
      (escalatable
        ? 'A human can approve this explicitly; approval will show them what is asking.'
        : 'This cannot be approved — no principal holds that capability.'),
    escalatable,
  };
}

/**
 * The nesting property, asserted here as well as in the suite: every
 * capability available at a lower trust level must also be available at every
 * higher one.
 *
 * Without it, *dropping* trust could grant something — the exact inversion
 * §12.1 forbids. Checked at module load so a bad edit to the table above
 * fails at import rather than at the first denial in production.
 */
function assertCeilingsAreNested(): void {
  const order: TrustLevel[] = ['FOREIGN', 'TOOL', 'DERIVED', 'USER', 'SYSTEM'];
  for (let i = 0; i < order.length - 1; i++) {
    const lower = CAPABILITY_CEILING[order[i]!];
    const higher = CAPABILITY_CEILING[order[i + 1]!];
    for (const cap of lower) {
      if (!higher.has(cap)) {
        throw new Error(
          `capability ceiling is not nested: ${order[i]} permits "${cap}" but ` +
            `${order[i + 1]} does not — a drop in trust would grant a capability`,
        );
      }
    }
  }
}

assertCeilingsAreNested();
