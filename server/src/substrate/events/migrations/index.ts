import { EventError, type EventType } from '../types.js';

/**
 * Event upcasters (§15).
 *
 * Stored events are immutable, so a payload shape can never be rewritten in
 * place. When a producer's schema changes, the *reader* adapts: the new
 * `schemaVersion` is bumped and an upcaster translates every older version
 * forward on read.
 *
 * The chain runs version by version — v1→v2→v3 — rather than v1→v3 directly,
 * so adding a fourth version means writing one function, not three.
 *
 * An unknown *future* version is an error rather than a pass-through. A
 * database written by a newer build than the one reading it is a real
 * situation (a downgrade), and guessing at a payload shape there is how
 * silent corruption starts.
 */

export type Upcaster = (payload: Record<string, unknown>) => Record<string, unknown>;

/** `UPCASTERS.get(type)?.get(n)` translates version `n` to version `n + 1`. */
const UPCASTERS = new Map<EventType, Map<number, Upcaster>>();

/** The version each type is currently written at. Absent means 1. */
const CURRENT_VERSIONS = new Map<EventType, number>();

export function currentVersion(type: EventType): number {
  return CURRENT_VERSIONS.get(type) ?? 1;
}

/** Register a translation from `fromVersion` to `fromVersion + 1`. */
export function registerUpcaster(type: EventType, fromVersion: number, upcast: Upcaster): void {
  const forType = UPCASTERS.get(type) ?? new Map<number, Upcaster>();
  forType.set(fromVersion, upcast);
  UPCASTERS.set(type, forType);
  CURRENT_VERSIONS.set(type, Math.max(currentVersion(type), fromVersion + 1));
}

/** Bring a stored payload up to the current version for its type. */
export function upcast(
  type: EventType,
  schemaVersion: number,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const target = currentVersion(type);
  if (schemaVersion > target) {
    throw new EventError(
      'unknown_schema_version',
      `Event ${type} was written at schema version ${schemaVersion}, but this build only understands ${target}. ` +
        'The database is newer than the code; upgrade rather than downgrade.',
      { type, schemaVersion, supported: target },
    );
  }
  let current = payload;
  for (let version = schemaVersion; version < target; version++) {
    const step = UPCASTERS.get(type)?.get(version);
    if (!step) {
      throw new EventError(
        'unknown_schema_version',
        `No upcaster registered for ${type} v${version} → v${version + 1}.`,
        { type, schemaVersion: version },
      );
    }
    current = step(current);
  }
  return current;
}

/** Test seam: the registry is module state, so a test must be able to clear it. */
export function resetUpcasters(): void {
  UPCASTERS.clear();
  CURRENT_VERSIONS.clear();
}
