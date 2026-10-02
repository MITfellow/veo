/**
 * The tool registry (§16, L3).
 *
 * Its job beyond lookup: **refuse to register a tool that breaks the
 * contract.** A dangerous tool with no `dryRun` must fail at startup, not at
 * 2am when somebody is relying on the preview to decide whether to approve.
 *
 * Invariant 9 — no tool name appears outside `src/tools/` — is why there is
 * no switch on names anywhere in this file or in `invoke.ts`. Tools are data.
 */
import type { z } from 'zod';
import { jsonSchemaOf, type JsonSchema } from './schema-json.js';
import { assertToolContract, ToolContractError, type Tool } from './tool.js';

export class ToolRegistry {
  private readonly byKey = new Map<string, Tool<any, any>>();
  /** name → the latest registered version, for unversioned lookup. */
  private readonly latest = new Map<string, string>();

  register(tool: Tool<any, any>): this {
    assertToolContract(tool);
    const key = `${tool.name}@${tool.version}`;
    if (this.byKey.has(key)) {
      throw new ToolContractError(key, 'already registered — tool identity must be unique');
    }
    this.byKey.set(key, tool);
    this.latest.set(tool.name, tool.version);
    return this;
  }

  get(name: string, version?: string): Tool<any, any> | undefined {
    if (name.includes('@')) return this.byKey.get(name);
    const resolved = version ?? this.latest.get(name);
    if (resolved === undefined) return undefined;
    return this.byKey.get(`${name}@${resolved}`);
  }

  has(name: string, version?: string): boolean {
    return this.get(name, version) !== undefined;
  }

  list(): Tool<any, any>[] {
    return [...this.byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get size(): number {
    return this.byKey.size;
  }

  /**
   * The tool specs handed to the model.
   *
   * Only tools the current trust level could actually use are advertised:
   * offering a model a tool it will be refused for is an invitation to waste
   * a step and then apologise.
   */
  specsFor(permitted: (tool: Tool<any, any>) => boolean): Array<{
    name: string;
    description: string;
    parameters: JsonSchema;
  }> {
    return this.list()
      .filter(permitted)
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: jsonSchemaOf(tool.input as z.ZodTypeAny),
      }));
  }
}
