import type { EventType } from '../types.js';
import { currentVersionOf } from '../types.js';

/**
 * Upcasters (§9, §30).
 *
 * Stored events are immutable, so a schema change cannot be a migration that
 * rewrites rows — it has to be a function applied on *read*. An upcaster takes
 * a payload at version N and returns it at N+1. Reading a v1 row five years
 * from now walks the chain v1→v2→…→current.
 *
 * Rules:
 *  - upcasters are pure and must not consult the clock, the DB or the network;
 *  - they must never throw on data that was valid at their input version;
 *  - they are append-only — editing an old upcaster rewrites history by proxy.
 */
export type Upcaster = (payload: unknown) => unknown;

type UpcasterTable = Partial<Record<EventType, Record<number, Upcaster>>>;

/**
 * `UPCASTERS[type][n]` converts version n → n+1.
 *
 * Empty at M0: nothing has changed shape yet. The machinery exists now because
 * the test that proves it works (`v1 fixture log still reads`) has to exist
 * before the first real schema change, not after it.
 */
export const UPCASTERS: UpcasterTable = {};

export function registerUpcaster(type: EventType, fromVersion: number, fn: Upcaster): void {
  const forType = (UPCASTERS[type] ??= {});
  if (forType[fromVersion]) {
    throw new Error(`upcaster already registered for ${type} v${fromVersion}`);
  }
  forType[fromVersion] = fn;
}

/** Test-only: lets a fixture install a chain without leaking into prod state. */
export function withUpcasters<T>(
  temp: Array<[EventType, number, Upcaster]>,
  fn: () => T,
): T {
  const saved = new Map<EventType, Record<number, Upcaster> | undefined>();
  for (const [type] of temp) {
    if (!saved.has(type)) saved.set(type, UPCASTERS[type]);
  }
  try {
    for (const [type, from, up] of temp) {
      const forType = (UPCASTERS[type] ??= { ...(UPCASTERS[type] ?? {}) });
      forType[from] = up;
    }
    return fn();
  } finally {
    for (const [type, prev] of saved) {
      if (prev === undefined) delete UPCASTERS[type];
      else UPCASTERS[type] = prev;
    }
  }
}

export interface UpcastResult {
  payload: unknown;
  from: number;
  to: number;
}

export function upcast(type: EventType, fromVersion: number, payload: unknown): UpcastResult {
  const target = currentVersionOf(type);
  if (fromVersion > target) {
    // A log written by a newer build than the one reading it. Refusing is the
    // safe-when-wrong choice: guessing at a future shape corrupts quietly.
    throw new Error(
      `event ${type} is at schema v${fromVersion} but this build only understands v${target} — upgrade before reading`,
    );
  }

  let current = payload;
  for (let v = fromVersion; v < target; v++) {
    const fn = UPCASTERS[type]?.[v];
    if (!fn) {
      throw new Error(`missing upcaster for ${type} v${v} → v${v + 1}`);
    }
    current = fn(current);
  }
  return { payload: current, from: fromVersion, to: target };
}
