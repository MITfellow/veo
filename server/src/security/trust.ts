import type { Storage } from '../substrate/ports.js';
import { meetTrust, permitted, type TrustLevel } from '../substrate/events/types.js';

/**
 * The trust lattice in operation (§20).
 *
 * The lattice algebra itself lives in `substrate/events/types.ts` because the
 * event log needs it. What lives here is the part that has teeth:
 *
 *   1. **Effective trust is the minimum over the causal closure**, computed by
 *      walking `causationId` through the log — not read from a field that
 *      something could forget to update. Slower; correct after a crash.
 *   2. **Capability is a function of effective trust**, expressed as an
 *      explicit floor rather than scattered `if (trust === 'FOREIGN')` checks.
 *
 * Rule 1 is why injection cannot launder itself: a FOREIGN ancestor anywhere
 * in the chain poisons every descendant, however many DERIVED steps are
 * stacked on top.
 */

export { meetTrust, permitted };

/** Capabilities a step may hold. The floor below names the ones trust gates. */
export type Capability =
  | 'vault:read'
  | 'memory:read'
  | 'memory:write'
  | 'memory:promote'
  | 'effect:external'
  | 'effect:local'
  | 'egress:new-host'
  | 'file:write'
  | 'autonomy:raise';

/**
 * What FOREIGN trust may never do (§20.2), as data rather than control flow.
 *
 * Stated as a deny-list for FOREIGN specifically because that is how §20
 * states it, and because a deny-list that is read aloud in a review is harder
 * to get wrong than an allow-list assembled from five call sites.
 */
export const FOREIGN_DENIED: readonly Capability[] = [
  'vault:read',
  'effect:external',
  'egress:new-host',
  'file:write',
  'memory:promote',
  'autonomy:raise',
];

/** §20.2 — FOREIGN-influenced steps cap at autonomy L1, whatever was earned. */
export const FOREIGN_AUTONOMY_CAP = 1;

export interface TrustDecision {
  allowed: boolean;
  /** Capabilities refused at this trust level, in request order. */
  denied: Capability[];
  autonomyCap: number;
  reason: string | null;
}

/**
 * Apply the floor.
 *
 * Non-FOREIGN levels are unconstrained *here* — they are constrained by the
 * capability check and the Rule of Two, which run in the same pipeline (§29).
 * This function answers one question only: what does this trust level forbid
 * outright?
 */
export function applyTrustFloor(trust: TrustLevel, requested: readonly Capability[], earnedAutonomy: number): TrustDecision {
  if (trust !== 'FOREIGN') {
    return { allowed: true, denied: [], autonomyCap: earnedAutonomy, reason: null };
  }
  const denied = requested.filter((capability) => FOREIGN_DENIED.includes(capability));
  const autonomyCap = Math.min(earnedAutonomy, FOREIGN_AUTONOMY_CAP);
  return {
    allowed: denied.length === 0,
    denied,
    autonomyCap,
    reason: denied.length === 0 ? null : `FOREIGN trust forbids: ${denied.join(', ')} (§20.2)`,
  };
}

interface CausalRow {
  seq: number;
  trust: string;
  causation_id: string | null;
}

/**
 * Walk the causation chain and take the meet of every trust level in it.
 *
 * **Fails closed.** A causation id that names no event returns FOREIGN rather
 * than being skipped: a dangling pointer means the chain cannot be verified,
 * and an unverifiable chain is untrusted by definition. The alternative —
 * ignoring the gap — would let an attacker who can delete one row promote
 * everything downstream of it.
 *
 * The visited set guards against a cycle, which the log should make
 * impossible but which must not be able to hang the process.
 */
export function effectiveTrust(storage: Storage, eventId: string): TrustLevel {
  const byId = storage.prepare('SELECT seq, trust, causation_id FROM events WHERE id = ?');
  const visited = new Set<string>();
  let current: string | null = eventId;
  let effective: TrustLevel = 'SYSTEM';

  while (current !== null && !visited.has(current)) {
    visited.add(current);
    const row: CausalRow | undefined = byId.get<CausalRow>(current);
    if (!row) return 'FOREIGN';
    effective = meetTrust(effective, row.trust as TrustLevel);
    current = row.causation_id;
  }
  return effective;
}

/** The meet of an explicit set — used when the inputs are in hand, not in the log. */
export function meetAll(levels: readonly TrustLevel[]): TrustLevel {
  return levels.reduce<TrustLevel>((acc, level) => meetTrust(acc, level), 'SYSTEM');
}
