import type { Capability } from '../../security/trust.js';
import { applyTrustFloor } from '../../security/trust.js';
import type { TrustLevel } from '../../substrate/events/types.js';
import { checkContract, ToolError, type AnyTool, type Tier } from './contract.js';

/**
 * The tool registry.
 *
 * One door. Nothing outside `orchestration/` calls a tool implementation
 * directly — a structural test reads the source tree and asserts it —
 * because every policy in the platform hangs off the invocation path, and
 * a second path is a second place to forget one of them.
 */

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  register(tool: AnyTool): void {
    if (this.tools.has(tool.name)) {
      throw new ToolError('duplicate', `A tool named '${tool.name}' is already registered.`);
    }
    const problems = checkContract(tool);
    if (problems.length > 0) {
      // At registration, not at call time: a tool that cannot be used
      // safely should fail the process that loads it, loudly, rather than
      // the user's first attempt to use it.
      throw new ToolError('invalid_contract', `Tool contract rejected (§26):\n  ${problems.join('\n  ')}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): AnyTool {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new ToolError('unknown_tool', `No tool named '${name}'. Run 'arish tools' to see what exists.`);
    }
    return tool;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  all(): AnyTool[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  byTier(tier: Tier): AnyTool[] {
    return this.all().filter((t) => t.tier === tier);
  }
}

export type CapabilityVerdict =
  | { allowed: true; autonomyCap: number }
  | { allowed: false; denied: Capability[]; reason: string };

/**
 * May this caller hold what this tool needs?
 *
 * Trust first, then the grant set. Trust first because §20 is a floor, not
 * a preference: a FOREIGN-influenced step may not hold `effect:external`
 * even if the user granted it, and checking the grant first would make the
 * floor look like one opinion among several.
 */
export function checkCapabilities(
  tool: AnyTool,
  trust: TrustLevel,
  granted: readonly Capability[],
  earnedAutonomy: number,
): CapabilityVerdict {
  const floor = applyTrustFloor(trust, tool.capabilities, earnedAutonomy);
  if (!floor.allowed) {
    return {
      allowed: false,
      denied: floor.denied,
      reason: floor.reason ?? `${trust} trust may not hold ${floor.denied.join(', ')} (§20.2).`,
    };
  }
  const missing = tool.capabilities.filter((c) => !granted.includes(c));
  if (missing.length > 0) {
    return {
      allowed: false,
      denied: missing,
      reason: `${tool.name} needs ${missing.join(', ')}, which this run was not granted.`,
    };
  }
  return { allowed: true, autonomyCap: floor.autonomyCap };
}
