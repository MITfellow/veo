import { createTestSubstrate, type TestSubstrate } from './substrate.js';
import { MemoryStore } from '../../src/capability/memory/store.js';
import { EntityRegistry } from '../../src/capability/memory/entities.js';
import { ItemStore } from '../../src/capability/memory/items.js';
import type { Vault } from '../../src/security/vault.js';
import { vaultHarness } from './vault.js';
import { configFromEnv } from '../../src/substrate/config.js';
import type { RunOptions } from '../../src/cognition/registry.js';
import { Quarantine } from '../../src/security/quarantine.js';

/**
 * One line to a working memory, because a test that spends twenty lines on
 * construction is a test nobody writes a second one of (§14).
 */
export interface MemoryHarness {
  s: TestSubstrate;
  memory: MemoryStore;
  entities: EntityRegistry;
  quarantine: Quarantine;
  options: RunOptions;
  now: () => number;
  close(): void;
}

export function createMemoryHarness(start = '2026-01-01T00:00:00.000Z'): MemoryHarness {
  const s = createTestSubstrate({ start });
  const deps = { storage: s.storage, events: s.events, now: () => s.clock.now(), nextId: () => s.ids.ulid() };
  return {
    s,
    memory: new MemoryStore(deps),
    entities: new EntityRegistry(deps),
    quarantine: testQuarantine(s),
    // No provider, deliberately. Every job runs its baseline, which is the
    // configuration this build ships in (§2).
    options: { config: configFromEnv({}) },
    now: () => s.clock.now(),
    close: () => s.close(),
  };
}

export interface ItemHarness extends MemoryHarness {
  vault: Vault;
  items: ItemStore;
}

/**
 * A memory harness whose substrate is the vault's, so item keys and item
 * metadata live in one database. Two databases would make `shred` look
 * like it worked while the key sat safely in the other one.
 */
export async function createItemHarness(): Promise<ItemHarness> {
  const h = await vaultHarness();
  const s = h.substrate;
  const deps = { storage: s.storage, events: s.events, now: () => s.clock.now(), nextId: () => s.ids.ulid() };
  const items = new ItemStore({ storage: s.storage, events: s.events, vault: h.vault, nextId: deps.nextId });
  return {
    s,
    memory: new MemoryStore(deps),
    entities: new EntityRegistry(deps),
    quarantine: testQuarantine(s),
    options: { config: configFromEnv({}) },
    now: deps.now,
    vault: h.vault,
    items,
    close: () => s.close(),
  };
}

function testQuarantine(s: TestSubstrate): Quarantine {
  return new Quarantine({
    storage: s.storage,
    clock: s.clock,
    ids: s.ids,
    events: { entered: () => {}, extracted: () => {}, released: () => {} },
  });
}
