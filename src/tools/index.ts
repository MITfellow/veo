/**
 * The built-in tool set (§20).
 *
 * > **Test: adding plugin #10 must require editing nothing outside
 * > `src/tools/` plus one registration line.**
 *
 * That is the contract this file exists to keep honest. `registerBuiltins`
 * is the one registration site; everything else about a tool lives in its own
 * module. `test/integration/plugin-contract.test.ts` adds a tenth tool and
 * proves it.
 *
 * Deferred with their milestones rather than forgotten:
 *   memory.recall / memory.remember / memory.forget   — M6
 *   history.expand                                    — M5
 *   clock.schedule                                    — M8
 *   ask_user                                          — M4 (it suspends)
 */
import type { ToolRegistry } from '../capability/registry.js';
import type { Vault } from '../security/vault.js';
import { clockNow } from './clock-now.js';
import { notesRead, notesWrite } from './notes.js';
import { makeVaultList } from './vault-list.js';

export interface BuiltinDeps {
  vault?: Vault;
}

export function registerBuiltins(registry: ToolRegistry, deps: BuiltinDeps = {}): ToolRegistry {
  registry.register(clockNow);
  registry.register(notesRead);
  registry.register(notesWrite);
  if (deps.vault !== undefined) registry.register(makeVaultList(deps.vault));
  return registry;
}

export { clockNow, notesRead, notesWrite, makeVaultList };
