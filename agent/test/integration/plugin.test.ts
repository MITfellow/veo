import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ToolRegistry } from '../../src/capability/registry.js';
import { registerBuiltins } from '../../src/tools/index.js';
import type { Tool, ToolContext } from '../../src/capability/tool.js';
import { jsonSchemaOf } from '../../src/capability/schema-json.js';

/** Every `.ts` file under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/**
 * §20's acceptance test, in executable form:
 *
 *   > Adding a tenth tool should require touching exactly one file.
 *
 * And invariant 9: no tool name appears outside `src/tools/`. Those two are
 * the same property seen from opposite ends — if the kernel knew any tool by
 * name, adding one would mean editing the kernel.
 */

const Input = z.object({
  city: z.string().describe('City name, e.g. "Delhi".'),
  units: z.enum(['c', 'f']).default('c'),
});
const Output = z.object({ temp: z.number(), units: z.string() });

const weather: Tool<z.infer<typeof Input>, z.infer<typeof Output>> = {
  name: 'weather.today',
  version: '1',
  description: 'The current weather in a city.',
  input: Input,
  output: Output,
  capabilities: ['net:read'],
  minTrust: 'TOOL',
  risk: 'safe',
  effect: 'external',
  idempotent: true,
  timeoutMs: 5_000,
  async execute(input) {
    return {
      ok: true,
      value: { temp: input.city === 'Delhi' ? 34 : 12, units: input.units },
      trust: 'TOOL',
      metrics: { durationMs: 1 },
    };
  },
  renderForModel(result) {
    return result.ok
      ? { text: `${result.value.temp} deg ${result.value.units}`, truncated: false }
      : { text: `weather lookup failed: ${result.error.message}`, truncated: false };
  },
};

describe('adding a tool (§20)', () => {
  it('takes exactly one registration call and nothing else', async () => {
    const registry = new ToolRegistry();
    registerBuiltins(registry);
    const before = registry.size;

    registry.register(weather); // ← the one line

    expect(registry.size).toBe(before + 1);
    const result = await registry
      .get('weather.today')!
      .execute({ city: 'Delhi', units: 'c' }, null as unknown as ToolContext);
    expect(result.ok && result.value).toEqual({ temp: 34, units: 'c' });
  });

  it('describes it to the model FROM THE SCHEMA, with no second source', () => {
    const registry = new ToolRegistry().register(weather);
    const spec = registry.specsFor(() => true).find((s) => s.name === 'weather.today');

    expect(spec?.description).toBe('The current weather in a city.');
    expect(spec?.parameters.properties?.['city']?.type).toBe('string');
    // The per-field description travelled from the schema into the prompt.
    expect(spec?.parameters.properties?.['city']?.description).toContain('Delhi');
    expect(spec?.parameters.properties?.['units']?.enum).toEqual(['c', 'f']);
    // A field with a default is not demanded of the model.
    expect(spec?.parameters.required).toEqual(['city']);
    expect(spec?.parameters.properties?.['units']?.default).toBe('c');
  });

  it('hides a tool the caller could not use anyway', () => {
    const registry = new ToolRegistry();
    registerBuiltins(registry);
    registry.register(weather);

    const offered = registry
      .specsFor((tool) => tool.capabilities.every((c) => c !== 'net:read'))
      .map((s) => s.name);

    // Offering a tool that will be refused wastes a step and then an apology.
    expect(offered).not.toContain('weather.today');
    expect(offered).toContain('clock.now');
  });

  it('refuses a duplicate name rather than silently replacing a tool', () => {
    const registry = new ToolRegistry().register(weather);
    expect(() => registry.register(weather)).toThrow();
  });
});

describe('the schema is what the model sees', () => {
  it('converts the constructs our tools actually use', () => {
    const schema = z.object({
      text: z.string(),
      count: z.number().int(),
      flag: z.boolean().optional(),
      tags: z.array(z.string()),
      mode: z.enum(['a', 'b']),
      meta: z.record(z.string()),
      maybe: z.string().nullable(),
    });
    const json = jsonSchemaOf(schema);
    expect(json.properties?.['count']?.type).toBe('integer');
    expect(json.properties?.['tags']?.items?.type).toBe('string');
    expect(json.properties?.['meta']?.type).toBe('object');
    expect(json.properties?.['maybe']?.anyOf?.[1]?.type).toBe('null');
    expect(json.required).toEqual(['text', 'count', 'tags', 'mode', 'meta', 'maybe']);
    // A typo'd argument should be visibly wrong, not quietly dropped.
    expect(json.additionalProperties).toBe(false);
  });

  it('degrades to unconstrained rather than throwing on something exotic', () => {
    expect(jsonSchemaOf(z.function() as unknown as z.ZodTypeAny)).toEqual({});
  });

  it('round-trips every built-in without crashing', () => {
    const registry = new ToolRegistry();
    registerBuiltins(registry);
    for (const spec of registry.specsFor(() => true)) {
      expect(spec.parameters.type).toBe('object');
      expect(spec.description.length).toBeGreaterThan(20);
    }
  });
});

describe('invariant 9: no tool name outside src/tools/', () => {
  it('holds across the entire kernel', () => {
    const registry = new ToolRegistry();
    registerBuiltins(registry, { vault: { list: async () => [] } as never });

    // Match the name as a *literal* — quoted or backticked — rather than
    // as any substring. `clock.now` the tool and `clock.now()` the port
    // method share their text and share nothing else; a raw substring search
    // measures spelling, not coupling. What the invariant forbids is kernel
    // code that NAMES a tool, and naming one means writing it as a string.
    const hits: string[] = [];
    for (const file of sourceFiles('src')) {
      if (file.startsWith(join('src', 'tools'))) continue;
      const text = readFileSync(file, 'utf8');
      for (const tool of registry.list()) {
        const literal = new RegExp(`['"\`]${tool.name.replace('.', '\\.')}['"\`]`);
        if (literal.test(text)) hits.push(`${file} names ${tool.name}`);
      }
    }

    // If this fails, a layer below L5 has learned the name of a specific
    // tool and the capability boundary has a hole in it.
    expect(hits.join('\n')).toBe('');
  });

  it('keeps the built-in list itself in one file', () => {
    const registry = new ToolRegistry();
    registerBuiltins(registry);
    expect(registry.list().map((t) => t.name)).toEqual(['clock.now', 'notes.read', 'notes.write']);

    const withVault = new ToolRegistry();
    registerBuiltins(withVault, { vault: { list: async () => [] } as never });
    // The vault tool appears only when a vault is supplied: capability
    // follows dependency rather than being assumed.
    expect(withVault.list().map((t) => t.name)).toContain('vault.list');
  });
});
