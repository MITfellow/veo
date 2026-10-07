import type { TestSubstrate } from './substrate.js';
import { MemoryStore } from '../../src/capability/memory/store.js';
import { ItemStore } from '../../src/capability/memory/items.js';
import { MemoryFileStore } from '../../src/substrate/files.js';
import { builtinTools } from '../../src/capability/tools/builtin.js';
import { ToolRegistry } from '../../src/capability/tools/registry.js';
import { Executor } from '../../src/orchestration/executor.js';
import type { Approvals } from '../../src/orchestration/approvals.js';
import type { Vault } from '../../src/security/vault.js';
import { vaultHarness } from './vault.js';

/**
 * A whole runnable platform in one line (§14).
 *
 * Deliberately the *real* registry, the *real* executor and the *real*
 * built-ins over an in-memory database: the thing M3 claims is that every
 * policy is applied on one path, and a harness that stubbed the path would
 * be testing a different program.
 */
export interface RunnerHarness {
  s: TestSubstrate;
  registry: ToolRegistry;
  executor: Executor;
  approvals: Approvals;
  memory: MemoryStore;
  items: ItemStore;
  files: MemoryFileStore;
  vault: Vault;
  close(): void;
}

export interface RunnerOptions {
  /**
   * Milliseconds the clock advances on every read.
   *
   * A frozen clock makes a wall-clock budget untestable: nothing inside one
   * run can move time, so the budget is never reached and the test passes
   * because the feature never ran. A tick is still deterministic — the same
   * run spends exactly the same number of milliseconds every time.
   */
  tickMs?: number;
}

export async function createRunner(options: RunnerOptions = {}): Promise<RunnerHarness> {
  const h = await vaultHarness();
  const s = h.substrate;
  const tick = options.tickMs ?? 0;
  const now = (): number => (tick > 0 ? s.clock.advance(tick) : s.clock.now());
  const shared = { storage: s.storage, events: s.events, now, nextId: () => s.ids.ulid() };

  const memory = new MemoryStore(shared);
  const items = new ItemStore({ storage: s.storage, events: s.events, vault: h.vault, nextId: shared.nextId });
  const files = new MemoryFileStore();
  files.set('/data/notes.txt', 'a plain file, read through the one fs door');

  const registry = new ToolRegistry();
  for (const tool of builtinTools({ memory, items, files, fileRoots: ['/data'] })) registry.register(tool);

  const executor = new Executor({
    storage: s.storage, events: s.events, crypto: s.crypto, registry,
    now, nextId: () => s.ids.ulid(),
  });

  return {
    s, registry, executor, approvals: executor.approvalService(),
    memory, items, files, vault: h.vault,
    close: () => s.close(),
  };
}

/** Every capability a test might want granted, so the grant set is not the subject. */
export const ALL_CAPABILITIES = [
  'vault:read', 'memory:read', 'memory:write', 'memory:promote',
  'effect:external', 'effect:local', 'egress:new-host', 'file:write', 'autonomy:raise',
] as const;
