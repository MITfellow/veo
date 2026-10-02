import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../src/capability/registry.js';
import { ToolContractError, type Tool } from '../../src/capability/tool.js';
import { registerBuiltins } from '../../src/tools/index.js';
import { echoTool } from '../fakes/tools.js';

function base(overrides: Partial<Tool<any, any>> = {}): Tool<any, any> {
  return {
    name: 'test.thing',
    version: '1',
    description: 'A tool that does a thing, described well enough for a model to choose it.',
    input: z.object({}),
    output: z.object({}),
    capabilities: [],
    minTrust: 'FOREIGN',
    risk: 'safe',
    effect: 'pure',
    idempotent: true,
    timeoutMs: 1000,
    async execute() {
      return { ok: true, value: {}, trust: 'SYSTEM' };
    },
    renderForModel() {
      return { text: '', truncated: false };
    },
    ...overrides,
  };
}

describe('the registry refuses to register a broken tool', () => {
  it('rejects a dangerous tool with no dryRun', () => {
    // A person cannot approve what they cannot preview, and discovering that
    // at the moment of approval is the worst possible time.
    expect(() => new ToolRegistry().register(base({ risk: 'dangerous' }))).toThrow(
      /requires dryRun/,
    );
  });

  it('accepts a dangerous tool that has one', () => {
    expect(() =>
      new ToolRegistry().register(base({ risk: 'dangerous', dryRun: async () => 'would do X' })),
    ).not.toThrow();
  });

  it('rejects a non-idempotent external effect with no compensate', () => {
    expect(() =>
      new ToolRegistry().register(base({ effect: 'external', idempotent: false })),
    ).toThrow(/compensate/);
  });

  it('allows an idempotent external effect without compensate', () => {
    expect(() =>
      new ToolRegistry().register(base({ effect: 'external', idempotent: true })),
    ).not.toThrow();
  });

  it('rejects a tool with an unbounded timeout', () => {
    expect(() => new ToolRegistry().register(base({ timeoutMs: 0 }))).toThrow(/timeoutMs/);
  });

  it('rejects a name that is not namespaced', () => {
    expect(() => new ToolRegistry().register(base({ name: 'thing' }))).toThrow(/namespaced/);
    expect(() => new ToolRegistry().register(base({ name: 'Thing.Do' }))).toThrow(/namespaced/);
  });

  it('rejects a description too thin for a model to act on', () => {
    expect(() => new ToolRegistry().register(base({ description: 'does stuff' }))).toThrow(
      /description/,
    );
  });

  it('rejects an egress policy on a tool with no external effect', () => {
    // One of the two is a mistake, and guessing which would be worse.
    expect(() =>
      new ToolRegistry().register(base({ egress: { hosts: ['x.com'], methods: ['GET'] } })),
    ).toThrow(/egress/);
  });

  it('rejects a duplicate name@version', () => {
    const registry = new ToolRegistry().register(base());
    expect(() => registry.register(base())).toThrow(ToolContractError);
  });

  it('allows the same name at a different version', () => {
    const registry = new ToolRegistry().register(base());
    expect(() => registry.register(base({ version: '2' }))).not.toThrow();
    expect(registry.size).toBe(2);
  });
});

describe('lookup', () => {
  it('finds a tool by name, by name@version, and by explicit version', () => {
    const registry = new ToolRegistry().register(base()).register(base({ version: '2' }));
    expect(registry.get('test.thing')?.version).toBe('2'); // latest wins
    expect(registry.get('test.thing@1')?.version).toBe('1');
    expect(registry.get('test.thing', '1')?.version).toBe('1');
    expect(registry.get('nope')).toBeUndefined();
  });

  it('only advertises tools the current trust level could actually use', () => {
    const registry = new ToolRegistry()
      .register(base({ name: 'test.safe' }))
      .register(base({ name: 'test.risky', capabilities: ['spend'] }));
    const specs = registry.specsFor((tool) => tool.capabilities.length === 0);
    // Offering a model a tool it will be refused for wastes a step and then
    // makes the agent apologise for something it could have known.
    expect(specs.map((s) => s.name)).toEqual(['test.safe']);
  });
});

describe('invariant 9: no tool name appears outside src/tools/', () => {
  it('the registry and the contract contain no hardcoded tool names', async () => {
    const { readFileSync } = await import('node:fs');
    const names = ['clock.now', 'notes.read', 'notes.write', 'vault.list'];
    for (const file of ['src/capability/registry.ts', 'src/capability/invoke.ts', 'src/capability/tool.ts']) {
      const source = readFileSync(file, 'utf8');
      for (const name of names) {
        // A switch on tool names in the kernel is how a plugin system stops
        // being one.
        expect(source, `${file} mentions ${name}`).not.toContain(`'${name}'`);
      }
    }
  });
});

describe('the built-in set', () => {
  it('registers without deps and stays within §20', () => {
    const registry = registerBuiltins(new ToolRegistry());
    expect(registry.list().map((t) => t.name)).toEqual([
      'clock.now',
      'math.eval',
      'notes.list',
      'notes.read',
      'notes.search',
      'notes.write',
      'time.convert',
      'time.until',
    ]);
  });

  it('renders through the tool, which owns truncation', () => {
    const rendered = echoTool.renderForModel(
      { ok: true, value: { echoed: 'hello' }, trust: 'SYSTEM' },
      100,
    );
    expect(rendered.text).toBe('hello');
  });
});
