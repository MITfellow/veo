import type { Tier } from '../capability/tools/contract.js';
import { FOREIGN_AUTONOMY_CAP } from '../security/trust.js';
import type { TrustLevel } from '../substrate/events/types.js';

/**
 * The autonomy ladder (§30).
 *
 * | rung | name | what runs without asking |
 * | --- | --- | --- |
 * | L0 | propose | nothing. A plan is produced and shown. |
 * | L1 | observe | reads: look things up, read a file, read a page. |
 * | L2 | interact | local changes: remember something, save a note. |
 * | L3 | act | reversible external effects — ones with a compensation. |
 * | L4 | autonomous | irreversible effects, under a standing approval. |
 *
 * Two properties make this worth having rather than decorative:
 *
 * **A step above the rung is an approval request, not a failure.** The
 * difference is the entire product. A system that refuses is a system you
 * turn off; a system that asks is one you learn to trust.
 *
 * **FOREIGN content caps the rung at L1, whatever is configured.** §20.2.
 * A page cannot earn autonomy by being read.
 */

export const RUNGS = [0, 1, 2, 3, 4] as const;
export type Rung = (typeof RUNGS)[number];

export const RUNG_NAMES: Readonly<Record<Rung, string>> = {
  0: 'propose',
  1: 'observe',
  2: 'interact',
  3: 'act',
  4: 'autonomous',
};

/** The lowest rung at which each tier runs unattended. */
const TIER_FLOOR: Readonly<Record<Tier, Rung>> = {
  observe: 1,
  interact: 2,
  effect: 3,
};

export interface AutonomyInput {
  rung: Rung;
  tier: Tier;
  /** Declared by the tool. An irreversible effect needs the top rung. */
  irreversible: boolean;
  /** Every trust level in the step's causal closure. */
  trustInScope: readonly TrustLevel[];
}

export type AutonomyVerdict =
  | { permitted: true; rung: Rung; reason: string }
  | { permitted: false; needs: Rung; reason: string; capped: boolean };

/**
 * The effective rung, after the trust floor.
 *
 * Separate from the decision so a caller can show the user *why* their L3
 * configuration is behaving like L1 today. A cap nobody can see reads as a
 * bug.
 */
export function effectiveRung(configured: Rung, trustInScope: readonly TrustLevel[]): { rung: Rung; capped: boolean } {
  if (!trustInScope.includes('FOREIGN')) return { rung: configured, capped: false };
  const capped = Math.min(configured, FOREIGN_AUTONOMY_CAP) as Rung;
  return { rung: capped, capped: capped < configured };
}

export function evaluateAutonomy(input: AutonomyInput): AutonomyVerdict {
  const { rung, capped } = effectiveRung(input.rung, input.trustInScope);
  // An irreversible effect is the one case that does not simply follow the
  // tier table: there is no undo, so it sits at the top of the ladder and
  // nowhere else.
  const needs: Rung = input.irreversible ? 4 : TIER_FLOOR[input.tier];

  if (rung >= needs) {
    return {
      permitted: true,
      rung,
      reason: `L${rung} (${RUNG_NAMES[rung]}) covers ${input.tier}${input.irreversible ? ', irreversible' : ''}`,
    };
  }
  return {
    permitted: false,
    needs,
    capped,
    reason: capped
      ? `This step needs L${needs}, and autonomy is capped at L${rung} because untrusted content is in scope (§20.2).`
      : `This step needs L${needs} (${RUNG_NAMES[needs]}); autonomy is L${rung} (${RUNG_NAMES[rung]}).`,
  };
}
