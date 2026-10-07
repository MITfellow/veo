import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { checkContract, type AnyTool, type ToolContract } from '../../src/capability/tools/contract.js';
import { ToolRegistry } from '../../src/capability/tools/registry.js';
import { builtinTools } from '../../src/capability/tools/builtin.js';
import { MemoryFileStore } from '../../src/substrate/files.js';
import { MemoryStore } from '../../src/capability/memory/store.js';
import { ItemStore } from '../../src/capability/memory/items.js';
import { createTestSubstrate } from '../fakes/substrate.js';

/** M3 §1 and §2 — the contract, and the registry that enforces it. */

function minimal(overrides: Partial<ToolContract<Record<string, never>, { ok: boolean }>> = {}): AnyTool {
  return {
    name: 'test.tool',
    summary: 'A tool that exists only to be checked against its contract.',
    input: z.object({}).strict(),
    output: z.object({ ok: z.boolean() }).strict(),
    sensitivity: 'none',
    effect: 'pure',
    tier: 'observe',
    capabilities: [],
    idempotent: true,
    run: () => Promise.resolve({ ok: true as const, output: { ok: true }, summary: 'done' }),
    ...overrides,
  } as unknown as AnyTool;
}

describe('the tool contract (§26)', () => {
  it('accepts a well-formed tool', () => {
    expect(checkContract(minimal())).toEqual([]);
  });

  it('refuses a non-strict input schema', () => {
    const loose = minimal({ input: z.object({ a: z.string().optional() }) as never });
    expect(checkContract(loose).join()).toMatch(/strict/);
  });

  it('refuses an undotted name and a useless summary', () => {
    expect(checkContract(minimal({ name: 'tool' })).join()).toMatch(/dotted/);
    expect(checkContract(minimal({ summary: 'does' })).join()).toMatch(/summary/);
  });

  it('forces an external effect to say whether it can be undone', () => {
    const forgot = minimal({
      name: 'mail.send',
      effect: 'external',
      tier: 'effect',
      preview: () => 'would send',
    });
    expect(checkContract(forgot).join()).toMatch(/compensate nor irreversible/);

    const honest = minimal({
      name: 'mail.send', effect: 'external', tier: 'effect', irreversible: true, preview: () => 'would send',
    });
    expect(checkContract(honest)).toEqual([]);
  });

  it('forces an external effect to be previewable, so a dry run is possible', () => {
    const blind = minimal({ name: 'mail.send', effect: 'external', tier: 'effect', irreversible: true });
    expect(checkContract(blind).join()).toMatch(/dry run must be possible/);
  });

  it('refuses a tool whose tier contradicts its effect', () => {
    expect(checkContract(minimal({ tier: 'effect' })).join()).toMatch(/tiered as an effect but declares no effect/);
    expect(
      checkContract(minimal({ effect: 'external', tier: 'observe', irreversible: true, preview: () => 'x' })).join(),
    ).toMatch(/tiered below effect/);
  });

  it('refuses a tool that writes private data without declaring it', () => {
    expect(checkContract(minimal({ sensitivity: 'writes-private' })).join()).toMatch(/memory:write/);
  });
});

describe('the registry', () => {
  it('refuses a non-conforming tool at registration, not at call time', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(minimal({ name: 'bad' }))).toThrow(/contract rejected/);
    expect(registry.has('bad')).toBe(false);
  });

  it('refuses two tools under one name', () => {
    const registry = new ToolRegistry();
    registry.register(minimal());
    expect(() => registry.register(minimal())).toThrow(/already registered/);
  });

  it('refuses an unknown tool loudly rather than returning nothing', () => {
    const registry = new ToolRegistry();
    expect(() => registry.get('nope')).toThrow(/No tool named/);
  });
});

function builtins(): AnyTool[] {
  const s = createTestSubstrate();
  const shared = { storage: s.storage, events: s.events, now: () => s.clock.now(), nextId: () => s.ids.ulid() };
  const tools = builtinTools({
    memory: new MemoryStore(shared),
    items: new ItemStore({ ...shared, vault: {} as never }),
    files: new MemoryFileStore(),
    fileRoots: ['/data'],
  });
  s.close();
  return tools;
}

describe('every built-in passes its own conformance suite', () => {
  it('checks all of them, by iterating rather than by listing', () => {
    const tools = builtins();
    expect(tools.length).toBeGreaterThanOrEqual(6);
    for (const tool of tools) {
      expect({ tool: tool.name, problems: checkContract(tool) }).toEqual({ tool: tool.name, problems: [] });
    }
  });

  it('registers all of them without complaint', () => {
    const registry = new ToolRegistry();
    for (const tool of builtins()) registry.register(tool);
    expect(registry.all().map((t) => t.name)).toEqual([
      'file.read', 'http.fetch', 'memory.assert', 'memory.recall', 'note.write', 'time.now',
    ]);
  });

  it('declares http.fetch as irreversible, because a sent request has no undo', () => {
    const fetchTool = builtins().find((t) => t.name === 'http.fetch');
    expect(fetchTool?.irreversible).toBe(true);
    expect(fetchTool?.compensate).toBeUndefined();
  });
});

describe('a dry run is answered by preview, never by run', () => {
  it('gives every built-in a preview worth reading', () => {
    for (const tool of builtins()) {
      // Only external tools are *required* to preview, but a dry run whose
      // answer is "memory.assert (interact, local)" tells the user nothing
      // they could not have read off the plan.
      expect(tool.preview, `${tool.name} has no preview`).toBeDefined();
    }
  });

  it('refuses rather than faking success if a tool is reached in dry-run mode', async () => {
    const tools = builtins();
    const assertTool = tools.find((t) => t.name === 'memory.assert');
    expect(assertTool).toBeDefined();
    if (assertTool === undefined) return;
    const outcome = await assertTool.run(
      { subject: 'a', predicate: 'b', object: 'c' } as never,
      { now: 0, inputTrust: 'USER', runId: 'r', stepIndex: 0, idempotencyKey: 'k', dryRun: true },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('dry_run_misrouted');
  });
});
