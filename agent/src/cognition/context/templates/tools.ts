/**
 * Block 13 — tool schemas, filtered to the trust level (§21).
 *
 * The filtering is the point. A tool the current step may not call is not
 * merely useless in the context, it is actively harmful: the model sees
 * `payments.charge` in its tool list, plans around it, calls it, gets
 * refused, and either loops or apologises for something it was never going
 * to be allowed to do. Showing a FOREIGN-trust step the full toolset is how
 * you turn a clean refusal into three wasted steps and a confused answer.
 *
 * This is a *rendering* decision, not a security control — the gate in
 * `invoke.ts` refuses the call regardless. Belt and braces again.
 */
import { minTrust } from '../../../substrate/events/types.js';
import type { Template, RenderedItem } from './index.js';

export const TOOLS: Template = {
  name: 'tools',
  version: 'tools-1',
  kind: 'system',
  header:
    'Tools available to you on this step. This list is already filtered to what ' +
    'you are permitted to call right now; if something you expect is missing, it ' +
    'is withheld on purpose and asking again will not produce it:',
  elision: (dropped) =>
    `(${dropped} further tool${dropped === 1 ? '' : 's'} not listed for space. Say so if ` +
    `you need something you cannot see.)`,
  render(snapshot, ctx): RenderedItem[] {
    return snapshot.tools
      .filter((tool) => permitted(tool.minTrust, ctx.trust))
      .map((tool) => ({
        id: tool.name,
        text: `- ${tool.name}: ${tool.description}`,
      }));
  },
};

/**
 * A tool is offered when the step's effective trust is at least the tool's
 * floor. Expressed through `minTrust` from the lattice rather than an
 * ordering invented here, so there is exactly one definition of "lower
 * trust" in the system (§12).
 */
export function permitted(
  toolFloor: import('../../../substrate/events/types.js').TrustLevel,
  stepTrust: import('../../../substrate/events/types.js').TrustLevel,
): boolean {
  return minTrust(toolFloor, stepTrust) === toolFloor;
}
