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
 *   clock.schedule                                    — M8
 *   ask_user                                          — M4 (it suspends)
 *
 * The memory tools (M6) and history.expand (M5) are registered by the
 * composition root instead, because both need a live store handed to them.
 * They are no less built-in for it — a tool that needs a dependency cannot
 * be a module-level constant without smuggling a global in behind it.
 */
import type { ToolRegistry } from '../capability/registry.js';
import type { Vault } from '../security/vault.js';
import { clockNow } from './clock-now.js';
import { mathEval } from './math-eval.js';
import { timeConvert, timeUntil } from './time.js';
import { notesRead, notesWrite, notesList, notesSearch } from './notes.js';
import { calendarTools, type CalendarToolDeps } from './calendar.js';
import { makeVaultList } from './vault-list.js';
import { memoryTools, type MemoryToolDeps } from './memory.js';

export interface BuiltinDeps {
  vault?: Vault;
  memory?: MemoryToolDeps;
  /** S1's calendar. Omitted → the calendar tools simply are not offered. */
  calendar?: CalendarToolDeps;
}

export function registerBuiltins(registry: ToolRegistry, deps: BuiltinDeps = {}): ToolRegistry {
  registry.register(clockNow);
  registry.register(mathEval);
  registry.register(timeConvert);
  registry.register(timeUntil);
  registry.register(notesRead);
  registry.register(notesWrite);
  registry.register(notesList);
  registry.register(notesSearch);
  if (deps.calendar !== undefined) {
    for (const tool of calendarTools(deps.calendar)) registry.register(tool);
  }
  if (deps.vault !== undefined) registry.register(makeVaultList(deps.vault));
  if (deps.memory !== undefined) {
    for (const tool of memoryTools(deps.memory)) registry.register(tool);
  }
  return registry;
}

export {
  clockNow,
  mathEval,
  timeConvert,
  timeUntil,
  notesRead,
  notesWrite,
  notesList,
  notesSearch,
  calendarTools,
  makeVaultList,
  memoryTools,
};
